//! Sidecar binaries for plugins: distribution and supervision.
//!
//! A plugin whose manifest declares a `sidecar` gets its native binary + models
//! downloaded from GitHub Releases on install (one click, no PATH setup) and extracted
//! under `{appData}/plugins/{plugin_id}/sidecar/`.
//!
//! The app owns the processes, not the plugin. A plugin issues *requests*
//! (`sidecar_request`) and the app decides how to service them: commands the manifest
//! lists under `serve` go to a single resident process per plugin, everything else to a
//! one-shot child. Either way the plugin sees the same thing -- `sidecar-line` events
//! carrying one JSON object per unit of work, then `sidecar-done`. stderr is the
//! diagnostics channel: it goes to the app log, and for one-shot runs also to
//! `sidecar-log` (a resident's stderr has no request to attach to).
//!
//! Every sidecar takes the same argv (see `build_args`), so the app can construct it
//! without the plugin describing it: variable input travels as JSON, never as flags.

use crate::emit_event;
use crate::types::{AppError, AppResult};
use crate::user_plugins::{validate_plugin_id, validate_sidecar_command, validate_sidecar_name};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

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
    req_id: u32,
    line: String,
}

/// Same shape as [`SidecarLine`]; distinct so the two event channels can't be cross-wired.
#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "sidecar-log")]
pub(crate) struct SidecarLog {
    req_id: u32,
    line: String,
}

#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "sidecar-done")]
pub(crate) struct SidecarDone {
    req_id: u32,
    error: Option<String>,
}

/// GitHub release asset platform tag for the running target.
pub(crate) fn platform_tag() -> AppResult<&'static str> {
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
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
    Ok(crate::storage::app_data_dir()?
        .join("plugins")
        .join(plugin_id))
}

fn sidecar_dir(plugin_id: &str) -> AppResult<PathBuf> {
    Ok(plugin_dir(plugin_id)?.join("sidecar"))
}

/// Working data the sidecar owns (caches, indexes). Deliberately a sibling of
/// `sidecar/`, which an update wipes wholesale.
fn data_dir(plugin_id: &str) -> AppResult<PathBuf> {
    let dir = plugin_dir(plugin_id)?.join("data");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

// --- Install ---

/// Fetch the expected SHA-256 for `asset` from the release's `checksums.txt`
/// (lines are `<hash>  <filename>`). None if the file or line is absent.
fn fetch_expected_sha(
    client: &reqwest::blocking::Client,
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

fn install_blocking(plugin_id: String, name: String, version: String) -> AppResult<()> {
    let platform = platform_tag()?;
    let asset = format!("{name}-{platform}.zip");
    let url =
        format!("https://github.com/ccmdi/mma/releases/download/{plugin_id}-v{version}/{asset}");
    log::info!("[sidecar] downloading {url}");

    let final_dir = sidecar_dir(&plugin_id)?;
    let plugin_root = final_dir.parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&plugin_root)?;

    let client = reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(600))
        .build()?;

    // checksums.txt (per-release, computed from the shipped zips) is the sole source
    // of truth for integrity. Absent (older releases) -> no verification.
    let expected_sha256 = fetch_expected_sha(&client, &plugin_id, &version, &asset);
    let mut resp = client.get(&url).send()?.error_for_status()?;
    let total = resp.content_length().unwrap_or(0);

    // Stream the download to a temp file instead of buffering in RAM.
    let zip_path = plugin_root.join(".sidecar-download.zip");
    let mut zip_file = std::io::BufWriter::new(std::fs::File::create(&zip_path)?);
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
                plugin_id: plugin_id.clone(),
                downloaded,
                total,
            });
            last_emit = downloaded;
        }
    }
    zip_file.flush()?;
    drop(zip_file);

    emit_event(SidecarProgress {
        plugin_id: plugin_id.clone(),
        downloaded,
        total: total.max(downloaded),
    });

    let actual_sha = format!("{:x}", hasher.finalize());
    if let Some(ref expected) = expected_sha256 {
        if !expected.eq_ignore_ascii_case(&actual_sha) {
            let _ = std::fs::remove_file(&zip_path);
            return Err(AppError(format!(
                "Sidecar integrity check failed for {name}: expected {expected}, got {actual_sha}"
            )));
        }
        log::info!("[sidecar] SHA-256 verified against checksums.txt: {actual_sha}");
    } else {
        log::warn!("[sidecar] no checksums.txt for this release, skipping integrity check (hash: {actual_sha})");
    }

    let tmp_dir = plugin_root.join(".sidecar-tmp");
    if tmp_dir.exists() {
        std::fs::remove_dir_all(&tmp_dir)?;
    }
    std::fs::create_dir_all(&tmp_dir)?;

    let zip_reader = std::fs::File::open(&zip_path)?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(zip_reader))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let rel = match entry.enclosed_name() {
            Some(p) => p.to_owned(),
            None => continue,
        };
        let out = tmp_dir.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut f = std::fs::File::create(&out)?;
        std::io::copy(&mut entry, &mut f)?;
    }
    drop(archive);
    let _ = std::fs::remove_file(&zip_path);

    std::fs::write(tmp_dir.join("version.txt"), &version)?;

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
    with_plugin_stopped(&plugin_id, || {
        if final_dir.exists() {
            std::fs::remove_dir_all(&final_dir)?;
        }
        std::fs::rename(&tmp_dir, &final_dir)?;
        Ok(())
    })?;
    log::info!("[sidecar] installed {name} v{version} for {plugin_id}");
    Ok(())
}

/// Download a plugin's sidecar bundle from GitHub Releases and extract it under
/// `{appData}/plugins/{plugin_id}/sidecar/`. Emits `sidecar-install-progress`.
#[tauri::command]
#[specta::specta]
pub async fn sidecar_install(plugin_id: String, name: String, version: String) -> AppResult<()> {
    validate_plugin_id(&plugin_id)?;
    validate_sidecar_name(&name)?;
    tokio::task::spawn_blocking(move || install_blocking(plugin_id, name, version))
        .await
        .map_err(|e| AppError(format!("sidecar install task failed: {e}")))?
}

/// Installed sidecar version for a plugin (from `sidecar/version.txt`), or `None`.
#[tauri::command]
#[specta::specta]
pub fn sidecar_installed_version(plugin_id: String) -> AppResult<Option<String>> {
    validate_plugin_id(&plugin_id)?;
    let path = sidecar_dir(&plugin_id)?.join("version.txt");
    Ok(std::fs::read_to_string(&path)
        .ok()
        .map(|s| s.trim().to_string()))
}

// --- Spec ---

/// The `sidecar` object of a plugin manifest -- the single parser for every consumer:
/// the manifest listing (name/version/checksum) and request routing here (`serve`).
/// The installed `manifest.json` is the single source of truth, so nothing has to be
/// registered from JS.
#[derive(serde::Deserialize)]
pub(crate) struct SidecarSpec {
    pub(crate) name: String,
    pub(crate) version: Option<String>,
    /// Commands the resident process serves. Anything else runs as a one-shot child.
    #[serde(default)]
    serve: Vec<String>,
    /// Everything else, notably the per-platform `sha256-{platform}` checksums.
    #[serde(flatten)]
    rest: HashMap<String, serde_json::Value>,
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

    /// Expected zip checksum for a platform tag, if the manifest carries one.
    pub(crate) fn sha256(&self, platform: &str) -> Option<&str> {
        self.rest.get(&format!("sha256-{platform}"))?.as_str()
    }
}

fn read_spec(plugin_id: &str) -> AppResult<SidecarSpec> {
    let path = plugin_dir(plugin_id)?.join("manifest.json");
    let text = std::fs::read_to_string(&path)
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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    Ok(cmd)
}

// --- Process registry ---

/// Ignore mutex poisoning: these locks guard plain process bookkeeping, and a panic
/// in one request must not leave a plugin permanently unkillable.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

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
    /// One-shot children, keyed by request id.
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
    lock(registry())
        .entry(plugin_id.to_string())
        .or_default()
        .clone()
}

static REQ_COUNTER: AtomicU32 = AtomicU32::new(1);

fn kill_child(child: &Arc<Mutex<Child>>) {
    let mut c = lock(child);
    let _ = c.kill();
    let _ = c.wait();
}

fn kill_procs(plugin_id: &str, procs: &mut PluginProcs) {
    if let Some(r) = procs.resident.take() {
        log::info!("[sidecar] stopping resident for {plugin_id}");
        kill_child(&r.child);
    }
    for (req_id, child) in procs.children.drain() {
        log::info!("[sidecar] killing {plugin_id} run {req_id}");
        kill_child(&child);
    }
}

/// Kill everything `plugin_id` is running, then run `f` while the plugin lock is
/// still held. Directory deletes/swaps go in `f`, where no new process can appear.
pub fn with_plugin_stopped<R>(plugin_id: &str, f: impl FnOnce() -> AppResult<R>) -> AppResult<R> {
    let slot = plugin_slot(plugin_id);
    let mut procs = lock(&slot);
    kill_procs(plugin_id, &mut procs);
    f()
}

/// Stop everything a plugin is running. Called on uninstall, on deactivate, and
/// before the install directory swap.
pub fn kill_plugin(plugin_id: &str) {
    let _ = with_plugin_stopped(plugin_id, || Ok(()));
}

/// Kill every tracked sidecar process. Called on map close and app exit.
pub fn kill_all_sidecars() {
    // Snapshot, then lock slots one at a time: a plugin mid-spawn holds its slot for
    // up to the handshake budget, and that must not stall the other plugins' kills.
    let slots: Vec<(String, PluginSlot)> = lock(registry())
        .iter()
        .map(|(id, slot)| (id.clone(), slot.clone()))
        .collect();
    for (plugin_id, slot) in slots {
        kill_procs(&plugin_id, &mut lock(&slot));
    }
}

// --- Resident transport ---

fn http() -> &'static reqwest::blocking::Client {
    static C: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::blocking::Client::builder()
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
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let log_id = plugin_id.to_string();
    std::thread::spawn(move || {
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
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::info!("[sidecar:{log_id}] {line}");
            }
        });
    }

    let child = Arc::new(Mutex::new(child));
    let port = match rx.recv_timeout(HANDSHAKE_TIMEOUT) {
        Ok(line) => serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .and_then(|v| v.get("port").and_then(|p| p.as_u64()))
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
    let mut procs = lock(&slot);
    if let Some(r) = procs.resident.take() {
        // try_wait also reaps a process that exited on its own (idle timeout).
        let alive = matches!(lock(&r.child).try_wait(), Ok(None));
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

fn post(port: u16, command: &str, body: &str) -> Result<String, PostError> {
    let resp = http()
        .post(format!("http://127.0.0.1:{port}/{command}"))
        .body(body.to_string())
        .send()
        .map_err(PostError::Transport)?;
    let status = resp.status();
    let text = resp.text().map_err(PostError::Transport)?;
    if !status.is_success() {
        return Err(PostError::Http(format!("sidecar {command} failed: {text}")));
    }
    Ok(text)
}

/// Post one command to the plugin's resident process and return its single reply.
fn post_resident(
    plugin_id: &str,
    spec: &SidecarSpec,
    command: &str,
    payload: Option<&str>,
) -> AppResult<String> {
    let body = payload.unwrap_or("{}");
    let addr = resident_port(plugin_id, spec, None)?;
    match post(addr.port, command, body) {
        Ok(text) => Ok(text),
        // An HTTP error status is the resident answering; only a transport failure
        // (idled out or crashed between the liveness check and the send) warrants
        // one restart and retry.
        Err(e @ PostError::Http(_)) => Err(e.into_app(command)),
        Err(PostError::Transport(e)) => {
            log::warn!("[sidecar] resident {command} unreachable ({e}), restarting");
            let addr = resident_port(plugin_id, spec, Some(addr.epoch))?;
            post(addr.port, command, body).map_err(|e| e.into_app(command))
        }
    }
}

fn run_resident(
    plugin_id: &str,
    spec: &SidecarSpec,
    command: &str,
    payload: Option<&str>,
    req_id: u32,
) -> AppResult<()> {
    let text = post_resident(plugin_id, spec, command, payload)?;
    emit_event(SidecarLine { req_id, line: text });
    Ok(())
}

// --- One-shot transport ---

fn write_input(req_id: u32, payload: &str) -> AppResult<PathBuf> {
    let path = std::env::temp_dir().join(format!("mma_sidecar_{req_id}.json"));
    std::fs::write(&path, payload)?;
    Ok(path)
}

fn run_oneshot(
    plugin_id: &str,
    spec: &SidecarSpec,
    command: &str,
    payload: Option<&str>,
    req_id: u32,
    on_line: &mut dyn FnMut(String),
) -> AppResult<()> {
    let input = payload.map(|p| write_input(req_id, p)).transpose()?;
    let result = run_oneshot_inner(plugin_id, spec, command, input.as_deref(), req_id, on_line);
    if let Some(path) = input {
        let _ = std::fs::remove_file(path);
    }
    result
}

/// Run a one-shot command to completion and return its stdout lines instead of
/// streaming them as events. For in-process callers such as the procedure engine.
pub(crate) fn run_oneshot_collect(
    plugin_id: &str,
    spec: &SidecarSpec,
    command: &str,
    payload: Option<&str>,
) -> AppResult<Vec<String>> {
    let req_id = REQ_COUNTER.fetch_add(1, Ordering::SeqCst);
    let mut lines = Vec::new();
    run_oneshot(plugin_id, spec, command, payload, req_id, &mut |l| {
        lines.push(l)
    })?;
    Ok(lines)
}

fn run_oneshot_inner(
    plugin_id: &str,
    spec: &SidecarSpec,
    command: &str,
    input: Option<&Path>,
    req_id: u32,
    on_line: &mut dyn FnMut(String),
) -> AppResult<()> {
    let slot = plugin_slot(plugin_id);
    // Spawn and register under the plugin lock: a concurrent stop or install either
    // runs first (and this spawns from whatever it left installed) or sees this child.
    let mut guard = lock(&slot);
    let mut child = build_command(plugin_id, spec, command, input)?
        .spawn()
        .map_err(|e| AppError(format!("Failed to spawn {} {command}: {e}", spec.name)))?;
    log::info!(
        "[sidecar] {} {command} for {plugin_id} (req_id={req_id})",
        spec.name
    );

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(AppError("sidecar stdout unavailable".into()));
    };
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    guard.children.insert(req_id, child.clone());
    drop(guard);

    let errors = stderr.map(|stderr| {
        let log_id = plugin_id.to_string();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::info!("[sidecar:{log_id}] {line}");
                emit_event(SidecarLog { req_id, line });
            }
        })
    });

    // No lock held while streaming, so sidecar_cancel can reach the child mid-run.
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        on_line(line);
    }
    if let Some(handle) = errors {
        let _ = handle.join();
    }
    // stdout is closed, so exit is imminent. The child guard is dropped before each
    // sleep, so cancel/kill can still reach the process between polls.
    let status = loop {
        let polled = lock(&child).try_wait();
        match polled {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(e) => {
                lock(&slot).children.remove(&req_id);
                return Err(e.into());
            }
        }
    };
    lock(&slot).children.remove(&req_id);

    if !status.success() {
        let code = status
            .code()
            .map_or("signal".to_string(), |c| c.to_string());
        return Err(AppError(format!("{} {command} exited ({code})", spec.name)));
    }
    Ok(())
}

// --- Commands ---

/// Run one unit of work on a plugin's sidecar. Commands the manifest lists under
/// `serve` go to the plugin's resident process; the rest get a one-shot child.
/// Streams `sidecar-line` (one JSON object per unit) and `sidecar-log` (stderr),
/// then exactly one `sidecar-done`, all keyed by the returned request id.
#[tauri::command]
#[specta::specta]
pub fn sidecar_request(
    plugin_id: String,
    command: String,
    payload: Option<String>,
) -> AppResult<u32> {
    validate_plugin_id(&plugin_id)?;
    validate_sidecar_command(&command)?;
    // The app starts residents itself; a requested `serve` would sit as a
    // never-finishing one-shot.
    if command == SERVE_COMMAND {
        return Err(AppError(
            "serve is app-managed and cannot be requested".into(),
        ));
    }
    let spec = read_spec(&plugin_id)?;
    let req_id = REQ_COUNTER.fetch_add(1, Ordering::SeqCst);

    std::thread::spawn(move || {
        let result = if spec.is_resident(&command) {
            run_resident(&plugin_id, &spec, &command, payload.as_deref(), req_id)
        } else {
            run_oneshot(
                &plugin_id,
                &spec,
                &command,
                payload.as_deref(),
                req_id,
                &mut |line| emit_event(SidecarLine { req_id, line }),
            )
        };
        let error = result.err().map(|e| e.0);
        if let Some(ref message) = error {
            log::error!("[sidecar] req_id={req_id} failed: {message}");
        }
        emit_event(SidecarDone { req_id, error });
    });

    Ok(req_id)
}

/// Run one sidecar command synchronously and return every line it produced. Same
/// resident-vs-one-shot dispatch as [`sidecar_request`], but nothing is emitted:
/// the caller owns the lines. A resident answers with exactly one.
pub(crate) fn sidecar_call_collect(
    plugin_id: &str,
    command: &str,
    payload: &str,
) -> AppResult<Vec<String>> {
    validate_plugin_id(plugin_id)?;
    validate_sidecar_command(command)?;
    if command == SERVE_COMMAND {
        return Err(AppError(
            "serve is app-managed and cannot be requested".into(),
        ));
    }
    let spec = read_spec(plugin_id)?;
    if spec.is_resident(command) {
        Ok(vec![post_resident(
            plugin_id,
            &spec,
            command,
            Some(payload),
        )?])
    } else {
        run_oneshot_collect(plugin_id, &spec, command, Some(payload))
    }
}

/// Stop everything a plugin has running. Called when the plugin is disabled or
/// uninstalled, so a resident process never outlives the plugin that wanted it.
#[tauri::command]
#[specta::specta]
pub async fn sidecar_stop(plugin_id: String) -> AppResult<()> {
    validate_plugin_id(&plugin_id)?;
    tokio::task::spawn_blocking(move || kill_plugin(&plugin_id)).await?;
    Ok(())
}

/// Stop every plugin's sidecar processes. Used when the editor tears all plugins
/// down at once (map close), where nothing should still be running afterwards.
#[tauri::command]
#[specta::specta]
pub async fn sidecar_stop_all() -> AppResult<()> {
    tokio::task::spawn_blocking(kill_all_sidecars).await?;
    Ok(())
}

/// Kill the process behind a one-shot request (no-op if it already finished).
/// Resident-served requests have no process of their own, so this does not
/// interrupt them -- the caller simply stops listening.
#[tauri::command]
#[specta::specta]
pub async fn sidecar_cancel(req_id: u32) -> AppResult<()> {
    tokio::task::spawn_blocking(move || {
        let slots: Vec<PluginSlot> = lock(registry()).values().cloned().collect();
        for slot in slots {
            if let Some(child) = lock(&slot).children.get(&req_id) {
                let _ = lock(child).kill();
                return;
            }
        }
    })
    .await?;
    Ok(())
}

#[cfg(test)]
#[path = "sidecar.test.rs"]
mod tests;
