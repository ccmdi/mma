//! Install and supervise plugin sidecar binaries.
//! Binaries and models are downloaded from GitHub Releases into the plugin's app-data directory.
//!
//! Manifest commands listed under `serve` use a resident process; other requests start a child.
//! Both return `sidecar-line` events followed by `sidecar-done`. stderr goes to the app log
//! and, for one-shot requests, `sidecar-log`.
//!
//! Requests carry JSON input. Sidecars can fetch imagery through the app's loopback schemes.

use crate::emit_event;
use crate::net::loopback;
use crate::plugins::user::{validate_plugin_id, validate_sidecar_command, validate_sidecar_name};
use crate::runs;
use crate::store::storage;
use crate::types::{AppError, AppResult};
use crate::util::Lock;
use reqwest::blocking::Client;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::env::consts::ARCH;
use std::env::consts::OS;
use std::fs;
use std::fs::File;
use std::io;
use std::io::BufWriter;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tokio::task;

/// Subcommand a sidecar implements to run resident.
const SERVE_COMMAND: &str = "serve";
/// How long a resident process may sit idle before it exits itself. App policy: the
/// sidecar enforces it so a parent that died without killing it leaves no orphan.
const RESIDENT_IDLE_SECS: u64 = 600;
/// Budget for a resident process to bind a port and report it.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "sidecar-install-progress")]
pub(crate) struct SidecarProgress {
    plugin_id: String,
    downloaded: u64,
    total: u64,
}

#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "sidecar-line")]
pub(crate) struct SidecarLine {
    run_id: u32,
    line: String,
}

/// A log line from a plugin's sidecar.
// Same shape as `SidecarLine`; distinct so the two event channels can't be cross-wired.
#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "sidecar-log")]
pub(crate) struct SidecarLog {
    run_id: u32,
    line: String,
}

#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "sidecar-done")]
pub(crate) struct SidecarDone {
    run_id: u32,
    error: Option<String>,
}

/// GitHub release asset platform tag for the running target.
fn platform_tag() -> AppResult<&'static str> {
    Ok(match (OS, ARCH) {
        ("windows", "x86_64") => "windows-x64",
        ("macos", "aarch64") => "macos-arm64",
        // No macos-x64: ort ships no prebuilt ONNX Runtime for x86_64-apple-darwin.
        ("macos", "x86_64") => {
            return Err(AppError(
                "Sidecar plugins are not available on Intel Macs".into(),
            ));
        }
        ("linux", "x86_64") => "linux-x64",
        (os, arch) => return Err(AppError(format!("Unsupported platform: {os}-{arch}"))),
    })
}

fn plugin_dir(plugin_id: &str) -> AppResult<PathBuf> {
    Ok(storage::app_data_dir()?.join("plugins").join(plugin_id))
}

fn sidecar_dir(plugin_id: &str) -> AppResult<PathBuf> {
    Ok(plugin_dir(plugin_id)?.join("sidecar"))
}

/// Working data the sidecar owns (caches, indexes). Deliberately a sibling of
/// `sidecar/`, which an update wipes wholesale.
fn data_dir(plugin_id: &str) -> AppResult<PathBuf> {
    let dir = plugin_dir(plugin_id)?.join("data");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

// --- Install ---

/// Fetch the expected SHA-256 for `asset` from the release's `checksums.txt`
/// (lines are `<hash>  <filename>`). None if the file or line is absent.
fn fetch_expected_sha(
    client: &Client,
    plugin_id: &str,
    version: &str,
    asset: &str,
) -> Option<String> {
    let url = format!(
        "https://github.com/ccmdi/mma/releases/download/{plugin_id}-v{version}/checksums.txt"
    );
    let text = client
        .get(&url)
        .send()
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .ok()?;
    for line in text.lines() {
        let mut it = line.split_whitespace();
        if let (Some(hash), Some(file)) = (it.next(), it.next()) {
            if file == asset {
                return Some(hash.to_string());
            }
        }
    }
    None
}

/// One install at a time per plugin. The download, extraction and swap all share
/// `{plugin}/.sidecar-tmp` and the final dir, and concurrent installs happen in
/// practice (the startup update pass runs per webview), so without this a sibling's
/// first act -- `remove_dir_all` on the staging dir -- lands mid-extraction.
fn install_gate(plugin_id: &str) -> Arc<Mutex<()>> {
    static G: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    G.get_or_init(|| Mutex::new(HashMap::new()))
        .locked()
        .entry(plugin_id.to_string())
        .or_default()
        .clone()
}

pub(crate) fn install_blocking(plugin_id: &str, name: &str, version: &str) -> AppResult<()> {
    let gate = install_gate(plugin_id);
    let _installing = gate.locked();
    // The sibling that held the gate may have just installed this exact version;
    // re-checking under the lock makes the second pass a no-op, not a re-download.
    if sidecar_installed_version(plugin_id.to_string())?.as_deref() == Some(version) {
        log::info!("[sidecar] {name} v{version} already installed for {plugin_id}");
        return Ok(());
    }

    let platform = platform_tag()?;
    let asset = format!("{name}-{platform}.zip");
    let url =
        format!("https://github.com/ccmdi/mma/releases/download/{plugin_id}-v{version}/{asset}");
    log::info!("[sidecar] downloading {url}");

    let final_dir = sidecar_dir(plugin_id)?;
    let plugin_root = final_dir.parent().unwrap().to_path_buf();
    fs::create_dir_all(&plugin_root)?;

    let client = Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(600))
        .build()?;

    // checksums.txt (per-release, computed from the shipped zips) is the sole source
    // of truth for integrity. Absent (older releases) -> no verification.
    let expected_sha256 = fetch_expected_sha(&client, plugin_id, version, &asset);
    let mut resp = client.get(&url).send()?.error_for_status()?;
    let total = resp.content_length().unwrap_or(0);

    // Stream the download to a temp file instead of buffering in RAM.
    let zip_path = plugin_root.join(".sidecar-download.zip");
    let mut zip_file = BufWriter::new(File::create(&zip_path)?);
    let mut hasher = Sha256::new();
    let mut chunk = [0u8; 65536];
    let mut downloaded = 0u64;
    let mut last_emit = 0u64;
    loop {
        let n = resp.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        zip_file.write_all(&chunk[..n])?;
        hasher.update(&chunk[..n]);
        downloaded += n as u64;
        if downloaded - last_emit >= 262_144 {
            emit_event(SidecarProgress {
                plugin_id: plugin_id.to_owned(),
                downloaded,
                total,
            });
            last_emit = downloaded;
        }
    }
    zip_file.flush()?;
    drop(zip_file);

    emit_event(SidecarProgress {
        plugin_id: plugin_id.to_owned(),
        downloaded,
        total: total.max(downloaded),
    });

    let actual_sha = format!("{:x}", hasher.finalize());
    if let Some(ref expected) = expected_sha256 {
        if !expected.eq_ignore_ascii_case(&actual_sha) {
            let _ = fs::remove_file(&zip_path);
            return Err(AppError(format!(
                "Sidecar integrity check failed for {name}: expected {expected}, got {actual_sha}"
            )));
        }
        log::info!("[sidecar] SHA-256 verified against checksums.txt: {actual_sha}");
    } else {
        log::warn!(
            "[sidecar] no checksums.txt for this release, skipping integrity check (hash: {actual_sha})"
        );
    }

    let tmp_dir = plugin_root.join(".sidecar-tmp");
    if tmp_dir.exists() {
        fs::remove_dir_all(&tmp_dir)?;
    }
    fs::create_dir_all(&tmp_dir)?;

    let zip_reader = File::open(&zip_path)?;
    let mut archive = zip::ZipArchive::new(BufReader::new(zip_reader))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let rel = match entry.enclosed_name() {
            Some(p) => p.to_owned(),
            None => continue,
        };
        let out = tmp_dir.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut f = File::create(&out)?;
        io::copy(&mut entry, &mut f)?;
    }
    drop(archive);
    let _ = fs::remove_file(&zip_path);

    fs::write(tmp_dir.join("version.txt"), version)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin = tmp_dir.join(&name);
        if bin.exists() {
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755))?;
        }
    }

    // Swap under the plugin's process lock: a live process holds its cwd and dlls
    // open (fatal to the delete on Windows), and the lock keeps a concurrent request
    // from starting one mid-replace.
    with_plugin_stopped(plugin_id, || {
        if final_dir.exists() {
            fs::remove_dir_all(&final_dir)?;
        }
        fs::rename(&tmp_dir, &final_dir)?;
        Ok(())
    })?;
    log::info!("[sidecar] installed {name} v{version} for {plugin_id}");
    Ok(())
}

/// Installed sidecar version for a plugin, or `null` if not installed.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub fn sidecar_installed_version(plugin_id: String) -> AppResult<Option<String>> {
    validate_plugin_id(&plugin_id)?;
    let path = sidecar_dir(&plugin_id)?.join("version.txt");
    Ok(fs::read_to_string(&path).ok().map(|s| s.trim().to_string()))
}

// --- Spec ---

/// The `sidecar` object of a plugin manifest -- the name it installs under and
/// request routing here (`serve`). The installed `manifest.json` is the single
/// source of truth, so nothing has to be registered from JS.
#[derive(serde::Deserialize)]
pub(crate) struct SidecarSpec {
    pub(crate) name: String,
    /// Commands the resident process serves. Anything else runs as a one-shot child.
    #[serde(default)]
    serve: Vec<String>,
}

impl SidecarSpec {
    /// Parse and validate the `sidecar` object out of a full manifest value.
    pub(crate) fn from_manifest(manifest: &serde_json::Value) -> AppResult<Self> {
        let obj = manifest
            .get("sidecar")
            .ok_or_else(|| AppError("Plugin declares no sidecar".into()))?;
        let spec: SidecarSpec = serde_json::from_value(obj.clone())?;
        validate_sidecar_name(&spec.name)?;
        for command in &spec.serve {
            validate_sidecar_command(command)?;
        }
        Ok(spec)
    }

    fn is_resident(&self, command: &str) -> bool {
        self.serve.iter().any(|c| c == command)
    }
}

fn read_spec(plugin_id: &str) -> AppResult<SidecarSpec> {
    let path = plugin_dir(plugin_id)?.join("manifest.json");
    let text = fs::read_to_string(&path)
        .map_err(|e| AppError(format!("Cannot read manifest for {plugin_id}: {e}")))?;
    SidecarSpec::from_manifest(&serde_json::from_str(&text)?)
}

/// The argv every sidecar invocation receives. One shape for all commands and all
/// plugins: variable input rides in the `--input` JSON file, never in flags, and
/// `serve` alone carries the idle budget.
fn build_args(command: &str, input: Option<&str>, model_dir: &str, data_dir: &str) -> Vec<String> {
    let mut args = vec![command.to_string()];
    if let Some(path) = input {
        args.push("--input".into());
        args.push(path.into());
    }
    args.push("--model-dir".into());
    args.push(model_dir.into());
    args.push("--data-dir".into());
    args.push(data_dir.into());
    if command == SERVE_COMMAND {
        args.push("--idle-secs".into());
        args.push(RESIDENT_IDLE_SECS.to_string());
    }
    args
}

fn build_command(
    plugin_id: &str,
    spec: &SidecarSpec,
    command: &str,
    input: Option<&Path>,
) -> AppResult<Command> {
    let dir = sidecar_dir(plugin_id)?;
    let bin_name = if cfg!(windows) {
        format!("{}.exe", spec.name)
    } else {
        spec.name.clone()
    };
    let bin = dir.join(&bin_name);
    if !bin.exists() {
        return Err(AppError(format!(
            "{} is not installed for {plugin_id}",
            spec.name
        )));
    }

    let args = build_args(
        command,
        input.map(|p| p.to_string_lossy()).as_deref(),
        &dir.join("models").to_string_lossy(),
        &data_dir(plugin_id)?.to_string_lossy(),
    );

    // cwd is the sidecar dir so co-located dlls (e.g. DirectML.dll) resolve.
    let mut cmd = Command::new(&bin);
    cmd.args(&args)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match loopback::base() {
        Ok(base) => {
            cmd.env(loopback::BASE_ENV, base);
        }
        Err(e) => log::error!("[sidecar] {plugin_id} starts without the app's schemes: {e}"),
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    Ok(cmd)
}

// --- Process registry ---

struct Resident {
    child: Arc<Mutex<Child>>,
    port: u16,
    /// Identifies this process among those that have occupied the slot, so a failed
    /// request can tell "my resident is stale" from "someone already replaced it".
    epoch: u64,
}

#[derive(Default)]
struct PluginProcs {
    resident: Option<Resident>,
    epoch: u64,
    /// One-shot children, keyed by run id.
    children: HashMap<u32, Arc<Mutex<Child>>>,
}

type PluginSlot = Arc<Mutex<PluginProcs>>;

/// Everything each plugin is running, one entry per plugin. The per-plugin lock is
/// held across spawn, kill, and the install swap, so those serialize: a request can
/// never start a process while its plugin is being stopped or its directory swapped.
fn registry() -> &'static Mutex<HashMap<String, PluginSlot>> {
    static R: OnceLock<Mutex<HashMap<String, PluginSlot>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn plugin_slot(plugin_id: &str) -> PluginSlot {
    registry()
        .locked()
        .entry(plugin_id.to_string())
        .or_default()
        .clone()
}

fn kill_child(child: &Arc<Mutex<Child>>) {
    let mut c = child.locked();
    let _ = c.kill();
    let _ = c.wait();
}

fn kill_procs(plugin_id: &str, procs: &mut PluginProcs) {
    if let Some(r) = procs.resident.take() {
        log::info!("[sidecar] stopping resident for {plugin_id}");
        kill_child(&r.child);
    }
    for (run_id, child) in procs.children.drain() {
        log::info!("[sidecar] killing {plugin_id} run {run_id}");
        kill_child(&child);
    }
}

/// Kill the one-shot child working `run_id`, whichever plugin it belongs to.
fn kill_run(run_id: u32) {
    let slots: Vec<PluginSlot> = registry().locked().values().cloned().collect();
    for slot in slots {
        let child = slot.locked().children.get(&run_id).cloned();
        if let Some(child) = child {
            kill_child(&child);
            return;
        }
    }
}

/// Kill everything `plugin_id` is running, then run `f` while the plugin lock is
/// still held. Directory deletes/swaps go in `f`, where no new process can appear.
pub fn with_plugin_stopped<R>(plugin_id: &str, f: impl FnOnce() -> AppResult<R>) -> AppResult<R> {
    let slot = plugin_slot(plugin_id);
    let mut procs = slot.locked();
    kill_procs(plugin_id, &mut procs);
    f()
}

/// Kill every tracked sidecar process. Called on map close and app exit.
pub fn kill_all_sidecars() {
    // Snapshot, then lock slots one at a time: a plugin mid-spawn holds its slot for
    // up to the handshake budget, and that must not stall the other plugins' kills.
    let slots: Vec<(String, PluginSlot)> = registry()
        .locked()
        .iter()
        .map(|(id, slot)| (id.clone(), slot.clone()))
        .collect();
    for (plugin_id, slot) in slots {
        kill_procs(&plugin_id, &mut slot.locked());
    }
}

// --- Resident transport ---

fn http() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| {
        Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(300))
            .build()
            .expect("failed to build sidecar http client")
    })
}

fn spawn_resident(plugin_id: &str, spec: &SidecarSpec, epoch: u64) -> AppResult<Resident> {
    let mut child = build_command(plugin_id, spec, SERVE_COMMAND, None)?
        .spawn()
        .map_err(|e| AppError(format!("Failed to start {} serve: {e}", spec.name)))?;

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(AppError("sidecar stdout unavailable".into()));
    };
    let stderr = child.stderr.take();

    // First stdout line is the port handshake; the rest is drained so a chatty
    // sidecar can never block on a full pipe.
    let (tx, rx) = mpsc::channel::<String>();
    let log_id = plugin_id.to_string();
    thread::spawn(move || {
        let mut lines = BufReader::new(stdout).lines().map_while(Result::ok);
        if let Some(first) = lines.next() {
            let _ = tx.send(first);
        }
        for line in lines {
            log::debug!("[sidecar:{log_id}] {line}");
        }
    });
    if let Some(stderr) = stderr {
        let log_id = plugin_id.to_string();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::info!("[sidecar:{log_id}] {line}");
            }
        });
    }

    let child = Arc::new(Mutex::new(child));
    let port = match rx.recv_timeout(HANDSHAKE_TIMEOUT) {
        Ok(line) => serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .and_then(|v| v.get("port").and_then(serde_json::Value::as_u64))
            .and_then(|p| u16::try_from(p).ok()),
        Err(_) => None,
    };
    let Some(port) = port else {
        kill_child(&child);
        return Err(AppError(format!(
            "{} serve did not report a port",
            spec.name
        )));
    };

    log::info!(
        "[sidecar] resident {} for {plugin_id} on port {port}",
        spec.name
    );
    Ok(Resident { child, port, epoch })
}

struct ResidentAddr {
    port: u16,
    epoch: u64,
}

/// Port of the plugin's resident process, starting one if needed. `stale` is the
/// epoch of a resident that just failed a request: it is killed and replaced only if
/// it still occupies the slot, so concurrent failures cannot kill each other's
/// fresh process.
fn resident_port(
    plugin_id: &str,
    spec: &SidecarSpec,
    stale: Option<u64>,
) -> AppResult<ResidentAddr> {
    let slot = plugin_slot(plugin_id);
    let mut procs = slot.locked();
    if let Some(r) = procs.resident.take() {
        // try_wait also reaps a process that exited on its own (idle timeout).
        let alive = matches!(r.child.locked().try_wait(), Ok(None));
        if alive && stale != Some(r.epoch) {
            let addr = ResidentAddr {
                port: r.port,
                epoch: r.epoch,
            };
            procs.resident = Some(r);
            return Ok(addr);
        }
        if alive {
            kill_child(&r.child);
        }
    }
    procs.epoch += 1;
    let resident = spawn_resident(plugin_id, spec, procs.epoch)?;
    let addr = ResidentAddr {
        port: resident.port,
        epoch: resident.epoch,
    };
    procs.resident = Some(resident);
    Ok(addr)
}

enum PostError {
    /// The process is unreachable (idled out or crashed): worth a restart.
    Transport(reqwest::Error),
    /// The resident answered with an error status: a restart cannot help.
    Http(String),
}

impl PostError {
    fn into_app(self, command: &str) -> AppError {
        match self {
            PostError::Transport(e) => AppError(format!("sidecar {command} unreachable: {e}")),
            PostError::Http(msg) => AppError(msg),
        }
    }
}

fn post(
    port: u16,
    command: &str,
    body: &str,
    on_line: &mut dyn FnMut(String),
) -> Result<(), PostError> {
    let resp = http()
        .post(format!("http://127.0.0.1:{port}/{command}"))
        .body(body.to_string())
        .send()
        .map_err(PostError::Transport)?;
    if !resp.status().is_success() {
        let text = resp.text().map_err(PostError::Transport)?;
        return Err(PostError::Http(format!("sidecar {command} failed: {text}")));
    }
    // A break mid-reply is the resident's error: a restart would deliver lines twice.
    for line in BufReader::new(resp).lines() {
        let line =
            line.map_err(|e| PostError::Http(format!("sidecar {command} reply broke off: {e}")))?;
        if !line.is_empty() {
            on_line(line);
        }
    }
    Ok(())
}

/// Post one command to the plugin's resident process, handing each reply line to
/// `on_line` as it arrives.
fn post_resident(
    plugin_id: &str,
    spec: &SidecarSpec,
    command: &str,
    payload: Option<&str>,
    on_line: &mut dyn FnMut(String),
) -> AppResult<()> {
    let body = payload.unwrap_or("{}");
    let addr = resident_port(plugin_id, spec, None)?;
    match post(addr.port, command, body, on_line) {
        Ok(()) => Ok(()),
        // An HTTP error status is the resident answering; only a transport failure
        // (idled out or crashed between the liveness check and the send) warrants
        // one restart and retry.
        Err(e @ PostError::Http(_)) => Err(e.into_app(command)),
        Err(PostError::Transport(e)) => {
            log::warn!("[sidecar] resident {command} unreachable ({e}), restarting");
            let addr = resident_port(plugin_id, spec, Some(addr.epoch))?;
            post(addr.port, command, body, on_line).map_err(|e| e.into_app(command))
        }
    }
}

/// Run `command` on the plugin's resident process when the manifest serves it, else as a
/// one-shot child, handing each output line to `on_line` as it arrives.
fn run_command(
    plugin_id: &str,
    spec: &SidecarSpec,
    command: &str,
    payload: Option<&str>,
    run_id: u32,
    on_line: &mut dyn FnMut(String),
) -> AppResult<()> {
    if spec.is_resident(command) {
        post_resident(plugin_id, spec, command, payload, on_line)
    } else {
        run_oneshot(plugin_id, spec, command, payload, run_id, on_line)
    }
}

// --- One-shot transport ---

fn write_input(run_id: u32, payload: &str) -> AppResult<PathBuf> {
    let path = env::temp_dir().join(format!("mma_sidecar_{run_id}.json"));
    fs::write(&path, payload)?;
    Ok(path)
}

fn run_oneshot(
    plugin_id: &str,
    spec: &SidecarSpec,
    command: &str,
    payload: Option<&str>,
    run_id: u32,
    on_line: &mut dyn FnMut(String),
) -> AppResult<()> {
    let input = payload.map(|p| write_input(run_id, p)).transpose()?;
    let result = run_oneshot_inner(plugin_id, spec, command, input.as_deref(), run_id, on_line);
    if let Some(path) = input {
        let _ = fs::remove_file(path);
    }
    result
}

fn run_oneshot_inner(
    plugin_id: &str,
    spec: &SidecarSpec,
    command: &str,
    input: Option<&Path>,
    run_id: u32,
    on_line: &mut dyn FnMut(String),
) -> AppResult<()> {
    let slot = plugin_slot(plugin_id);
    // Spawn and register under the plugin lock: a concurrent stop or install either
    // runs first (and this spawns from whatever it left installed) or sees this child.
    let mut guard = slot.locked();
    let mut child = build_command(plugin_id, spec, command, input)?
        .spawn()
        .map_err(|e| AppError(format!("Failed to spawn {} {command}: {e}", spec.name)))?;
    log::info!(
        "[sidecar] {} {command} for {plugin_id} (run {run_id})",
        spec.name
    );

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(AppError("sidecar stdout unavailable".into()));
    };
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    guard.children.insert(run_id, child.clone());
    drop(guard);

    let errors = stderr.map(|stderr| {
        let log_id = plugin_id.to_string();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::info!("[sidecar:{log_id}] {line}");
                emit_event(SidecarLog { run_id, line });
            }
        })
    });

    // No lock held while streaming, so a cancel can reach the child mid-run.
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        on_line(line);
    }
    if let Some(handle) = errors {
        let _ = handle.join();
    }
    // stdout is closed, so exit is imminent. The child guard is dropped before each
    // sleep, so cancel/kill can still reach the process between polls.
    let status = loop {
        let polled = child.locked().try_wait();
        match polled {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(e) => {
                slot.locked().children.remove(&run_id);
                return Err(e.into());
            }
        }
    };
    slot.locked().children.remove(&run_id);

    if !status.success() {
        let code = status
            .code()
            .map_or("signal".to_string(), |c| c.to_string());
        return Err(AppError(format!("{} {command} exited ({code})", spec.name)));
    }
    Ok(())
}

// --- Commands ---

/// Start `command` under `run_id` on its own thread, handing each output line to `on_line`
/// as it arrives and the outcome to `on_done` once the run is over.
fn start(
    plugin_id: &str,
    command: &str,
    payload: Option<String>,
    run_id: u32,
    mut on_line: impl FnMut(String) + Send + 'static,
    on_done: impl FnOnce(AppResult<()>) + Send + 'static,
) -> AppResult<()> {
    validate_plugin_id(plugin_id)?;
    validate_sidecar_command(command)?;
    // The app starts residents itself; a requested `serve` would sit as a
    // never-finishing one-shot.
    if command == SERVE_COMMAND {
        return Err(AppError(
            "serve is app-managed and cannot be requested".into(),
        ));
    }
    let spec = read_spec(plugin_id)?;
    let (plugin_id, command) = (plugin_id.to_string(), command.to_string());
    thread::spawn(move || {
        let result = run_command(
            &plugin_id,
            &spec,
            &command,
            payload.as_deref(),
            run_id,
            &mut on_line,
        );
        on_done(result);
    });
    Ok(())
}

/// Run one unit of work on a plugin's sidecar under a `runId` from `runReserve`. Commands the
/// manifest lists under `serve` go to the plugin's resident process; the rest get a one-shot
/// child, which `runCancel` kills. Streams `sidecar-line` (one JSON object per unit) and
/// `sidecar-log` (stderr), then exactly one `sidecar-done`, all keyed by the run id.
#[tauri::command]
#[specta::specta]
pub fn sidecar_request(
    plugin_id: String,
    command: String,
    payload: Option<String>,
    run_id: u32,
) -> AppResult<()> {
    runs::register_stoppable(run_id, move || kill_run(run_id))?;
    let started = start(
        &plugin_id,
        &command,
        payload,
        run_id,
        move |line| emit_event(SidecarLine { run_id, line }),
        move |result| {
            drop(runs::unregister_run(run_id));
            let error = result.err().map(|e| e.0);
            if let Some(ref message) = error {
                log::error!("[sidecar] run {run_id} failed: {message}");
            }
            emit_event(SidecarDone { run_id, error });
        },
    );
    if started.is_err() {
        drop(runs::unregister_run(run_id));
    }
    started
}

/// A sidecar command's output, one line at a time, blocking until the next arrives.
/// The stream ends after the last line, or with the error that stopped the run.
pub(crate) type SidecarStream = Box<dyn Iterator<Item = AppResult<String>> + Send>;

/// Run one command on its own thread and hand its lines over as they arrive, so an
/// in-process caller such as the procedure engine can report progress mid-run.
pub(crate) fn sidecar_call_stream(
    plugin_id: &str,
    command: &str,
    payload: &str,
) -> AppResult<SidecarStream> {
    let (tx, rx) = mpsc::channel::<AppResult<String>>();
    let failed = tx.clone();
    start(
        plugin_id,
        command,
        Some(payload.to_string()),
        runs::run_reserve(),
        move |line| {
            let _ = tx.send(Ok(line));
        },
        move |result| {
            if let Err(e) = result {
                let _ = failed.send(Err(e));
            }
        },
    )?;
    Ok(Box::new(rx.into_iter()))
}

/// Stop all sidecar processes for a plugin, or for every plugin when the id is null.
#[tauri::command]
#[specta::specta]
pub async fn sidecar_stop(plugin_id: Option<String>) -> AppResult<()> {
    let Some(plugin_id) = plugin_id else {
        task::spawn_blocking(kill_all_sidecars).await?;
        return Ok(());
    };
    validate_plugin_id(&plugin_id)?;
    task::spawn_blocking(move || with_plugin_stopped(&plugin_id, || Ok(()))).await?
}

#[cfg(test)]
#[path = "sidecar.test.rs"]
mod tests;
