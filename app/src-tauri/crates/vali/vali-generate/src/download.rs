use crate::progress::{emit, CancelToken, Event, Progress};
use anyhow::{bail, Context};
use reqwest::blocking::Client;
use serde::Deserialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
const BASE_URL: &str = "https://vali-download.slashp.workers.dev";
const COUNTRIES_BUCKET: &str = "countries-v2";
const COUNTRY_UPDATES_BUCKET: &str = "country-updates-v2";
const FILE_EXTENSION: &str = ".bin";
#[derive(Debug, Clone, Deserialize)]
struct R2Object {
    key: String,
    uploaded: NetDateTime,
    size: Option<i64>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadMetadata {
    #[serde(default, alias = "Files")]
    files: Vec<MetadataFile>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataFile {
    #[serde(alias = "Name")]
    name: String,
    #[serde(alias = "LastWriteTimeUtc")]
    last_write_time_utc: NetDateTime,
}
fn agent() -> Client {
    agent_with(Duration::from_secs(600))
}
/// No TLS provider selected here; the app installs one process-wide at startup.
fn agent_with(timeout: Duration) -> Client {
    Client::builder()
        .timeout(timeout)
        .build()
        .expect("blocking HTTP client")
}
/// Remote objects that are missing locally or whose upload is newer than the local copy --
/// the one rule for "out of date", shared by the download passes and the staleness check.
fn outdated<'a>(remote: &'a [R2Object], local: &[MetadataFile]) -> Vec<&'a R2Object> {
    remote
        .iter()
        .filter(|r2| {
            local
                .iter()
                .find(|f| file_stem(&f.name) == key_stem(&r2.key))
                .is_none_or(|f| f.last_write_time_utc < r2.uploaded)
        })
        .collect()
}
pub fn download_files(
    root: &Path,
    country: Option<&str>,
    full: bool,
    updates: bool,
    progress: Option<Progress<'_>>,
    cancel: Option<&CancelToken>,
) -> anyhow::Result<()> {
    let all_codes: Vec<&str> =
        crate::names::country_names().iter().map(|(c, _)| *c).collect();
    let country_codes: Vec<String> = match country.filter(|c| !c.is_empty()) {
        None => all_codes.iter().map(|c| c.to_string()).collect(),
        Some(code) => {
            if matches!(code, "lefthandtraffic" | "righthandtraffic") {
                bail!("the '{code}' alias is not supported by this port.");
            }
            let expanded = crate::definition::expand_country_code(
                code,
                &vali_core::DistributionStrategy::default(),
            );
            all_codes
                .iter()
                .filter(|c| expanded.iter().any(|e| e == **c))
                .map(|c| c.to_string())
                .collect()
        }
    };
    download_codes(root, &country_codes, full, updates, progress, cancel)
}
/// The download itself, once the targets are named. `download_files` resolves a CLI-style
/// `--country` argument to this; callers that already hold country codes use it directly.
pub fn download_codes(
    root: &Path,
    country_codes: &[String],
    full: bool,
    updates: bool,
    progress: Option<Progress<'_>>,
    cancel: Option<&CancelToken>,
) -> anyhow::Result<()> {
    ensure_download_folder_writable(root)?;
    for cc in country_codes {
        ensure_download_metadata_file_exists(root, cc)?;
    }
    let agent = agent();
    for op in [
        Operation::Data { force: full },
        Operation::Updates {
            force: updates,
        },
    ] {
        for cc in country_codes {
            if let Some(c) = cancel {
                c.check()?;
            }
            run_operation(&agent, root, cc, &op, progress, cancel)?;
        }
    }
    Ok(())
}
enum Operation {
    Data { force: bool },
    Updates { force: bool },
}
fn run_operation(
    agent: &Client,
    root: &Path,
    cc: &str,
    op: &Operation,
    progress: Option<Progress<'_>>,
    cancel: Option<&CancelToken>,
) -> anyhow::Result<()> {
    let country_folder = root.join(cc);
    let (bucket, force) = match op {
        Operation::Data { force } => (COUNTRIES_BUCKET, *force),
        Operation::Updates { force } => {
            let updates_folder = country_folder.join("updates");
            if updates_folder.exists() {
                std::fs::remove_dir_all(&updates_folder)?;
            }
            (COUNTRY_UPDATES_BUCKET, *force)
        }
    };
    let files_from_r2 = list_files(agent, cc, bucket)?;
    let local_files = existing_files_in_metadata(&country_folder);
    let files_to_download: Vec<&R2Object> = if force {
        files_from_r2.iter().collect()
    } else {
        outdated(&files_from_r2, &local_files)
    };
    let files_to_delete: Vec<&MetadataFile> = local_files
        .iter()
        .filter(|f| {
            !files_from_r2.iter().any(|r2| key_stem(&r2.key) == file_stem(&f.name))
        })
        .collect();
    if matches!(op, Operation::Data { .. }) {
        for file in files_to_delete {
            delete_data_file(&country_folder, &file.name);
        }
    }
    if files_to_download.is_empty() {
        return Ok(());
    }
    let total_bytes: i64 = files_to_download.iter().filter_map(|f| f.size).sum();
    emit(
        progress,
        Event::CountryDownloadStarted {
            country_code: cc.to_string(),
            files: files_to_download.len(),
            bytes: total_bytes,
            updates: matches!(op, Operation::Updates { .. }),
        },
    );
    match op {
        Operation::Data { .. } => {
            download_data_files(
                agent,
                cc,
                &country_folder,
                &files_to_download,
                progress,
                cancel,
            )?;
            save_data_files_downloaded(&country_folder, &files_to_download)?;
        }
        Operation::Updates { .. } => {
            // Fetch concurrently, then append in listing order: several deltas can target the
            // same data file, so the appends stay serial and ordered. Keeping the appends out
            // of the cancellable phase also keeps a cancel from leaving deltas applied but
            // unrecorded, which would re-append them on the next run.
            let updates_folder = country_folder.join("updates");
            run_limited(
                &files_to_download,
                10,
                cancel,
                |r2| {
                    download_file(agent, COUNTRY_UPDATES_BUCKET, r2, &updates_folder)?;
                    emit(
                        progress,
                        Event::FileDownloaded {
                            country_code: cc.to_string(),
                            name: key_stem(&r2.key).to_string(),
                            bytes: r2.size.unwrap_or(0),
                        },
                    );
                    Ok(())
                },
            )?;
            apply_update_files(&country_folder, &files_to_download)?;
            if updates_folder.exists() {
                std::fs::remove_dir_all(&updates_folder)?;
            }
        }
    }
    Ok(())
}
pub fn ensure_files_downloaded(
    root: &Path,
    cc: &str,
    subdivision_files: &[PathBuf],
    progress: Option<Progress<'_>>,
    cancel: Option<&CancelToken>,
) -> anyhow::Result<()> {
    if subdivision_files.iter().all(|f| f.exists()) {
        return Ok(());
    }
    ensure_download_folder_writable(root)?;
    let country_folder = root.join(cc);
    let agent = agent();
    let files_from_r2 = list_files(&agent, cc, COUNTRIES_BUCKET)?;
    let local_files = existing_files_in_metadata(&country_folder);
    let files_to_download = outdated(&files_from_r2, &local_files);
    if !files_to_download.is_empty() {
        emit(
            progress,
            Event::CountryDownloadStarted {
                country_code: cc.to_string(),
                files: files_to_download.len(),
                bytes: files_to_download.iter().filter_map(|f| f.size).sum(),
                updates: false,
            },
        );
        download_data_files(
                &agent,
                cc,
                &country_folder,
                &files_to_download,
                progress,
                cancel,
            )
            .map_err(|e| {
                if cancel.is_some_and(|c| c.is_cancelled()) {
                    return e;
                }
                e.context(
                    format!(
                        "Failed to download {} data. Check your internet connection and try again, or run 'vali download --country {cc}' manually.",
                        crate ::names::country_name(cc)
                    ),
                )
            })?;
    }
    Ok(())
}
/// How far behind one country's on-disk data is.
#[derive(Debug, Clone, PartialEq)]
pub struct CountryStatus {
    pub country_code: String,
    pub files: usize,
    pub bytes: i64,
}
/// Countries with data on disk whose remote copy has moved on. Both buckets count: a stretch
/// where upstream ships only incremental deltas must still read as stale, since the download
/// pass syncs full files and updates alike. Lists object metadata only -- no file bodies are
/// fetched, so this is cheap enough to run unprompted. Countries that were never downloaded
/// are not reported: nothing is stale about data you don't have.
pub fn stale_countries(
    root: &Path,
    timeout: Duration,
    cancel: Option<&CancelToken>,
) -> anyhow::Result<Vec<CountryStatus>> {
    let codes = downloaded_country_codes(root);
    if codes.is_empty() {
        return Ok(Vec::new());
    }
    let agent = agent_with(timeout);
    let found = std::sync::Mutex::new(Vec::new());
    run_limited(
        &codes,
        10,
        cancel,
        |cc| {
            let remote_data = list_files(&agent, cc, COUNTRIES_BUCKET)?;
            let remote_updates = list_files(&agent, cc, COUNTRY_UPDATES_BUCKET)?;
            let local = existing_files_in_metadata(&root.join(cc));
            let stale: Vec<&R2Object> = outdated(&remote_data, &local)
                .into_iter()
                .chain(outdated(&remote_updates, &local))
                .collect();
            if !stale.is_empty() {
                found
                    .lock()
                    .unwrap()
                    .push(CountryStatus {
                        country_code: cc.clone(),
                        files: stale.len(),
                        bytes: stale.iter().filter_map(|f| f.size).sum(),
                    });
            }
            Ok(())
        },
    )?;
    let mut out = found.into_inner().unwrap();
    out.sort_by(|a, b| a.country_code.cmp(&b.country_code));
    Ok(out)
}
/// Country folders holding at least one data file, keyed by Vali's own country list so a
/// stray directory can't turn into a bogus listing request.
fn downloaded_country_codes(root: &Path) -> Vec<String> {
    crate::names::country_names()
        .iter()
        .map(|(c, _)| c.to_string())
        .filter(|cc| {
            std::fs::read_dir(root.join(cc))
                .map(|mut e| e.any(|f| {
                    f.is_ok_and(|f| f.path().extension().is_some_and(|x| x == "bin"))
                }))
                .unwrap_or(false)
        })
        .collect()
}
fn download_data_files(
    agent: &Client,
    cc: &str,
    folder: &Path,
    files: &[&R2Object],
    progress: Option<Progress<'_>>,
    cancel: Option<&CancelToken>,
) -> anyhow::Result<()> {
    run_limited(
        files,
        10,
        cancel,
        |r2| {
            download_file(agent, COUNTRIES_BUCKET, r2, folder)?;
            emit(
                progress,
                Event::FileDownloaded {
                    country_code: cc.to_string(),
                    name: key_stem(&r2.key).to_string(),
                    bytes: r2.size.unwrap_or(0),
                },
            );
            Ok(())
        },
    )
}
/// Append fetched deltas in listing order, recording each one the moment its bytes land.
/// An I/O error (or kill) between deltas then loses only the unapplied tail -- an applied
/// delta whose record never made it to `downloads.json` would be appended a second time on
/// the next run, duplicating its bytes inside the data file.
fn apply_update_files(country_folder: &Path, files: &[&R2Object]) -> anyhow::Result<()> {
    for r2 in files {
        append_update_file(country_folder, r2)?;
        save_update_files_downloaded(country_folder, &[*r2])?;
    }
    Ok(())
}
/// Appends an already-fetched delta onto the data file it belongs to.
fn append_update_file(country_folder: &Path, r2: &R2Object) -> anyhow::Result<()> {
    let file_name = downloaded_file_name(r2);
    let update_path = country_folder.join("updates").join(&file_name);
    let data_path = country_folder.join(remove_date_prefix(&file_name));
    let bytes = std::fs::read(&update_path)?;
    let mut data = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&data_path)?;
    std::io::Write::write_all(&mut data, &bytes)?;
    Ok(())
}
fn download_file(
    agent: &Client,
    bucket: &str,
    r2: &R2Object,
    folder: &Path,
) -> anyhow::Result<PathBuf> {
    std::fs::create_dir_all(folder)?;
    let file_name = downloaded_file_name(r2);
    let dest = folder.join(&file_name);
    let url = format!("{BASE_URL}/{bucket}/{}", encode_key(&r2.key));
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 1..=3u32 {
        match try_download(agent, &url) {
            Ok(bytes) => {
                let tmp = folder.join(format!("{file_name}.tmp"));
                std::fs::write(&tmp, bytes)
                    .with_context(|| format!("write {}", tmp.display()))?;
                let _ = std::fs::remove_file(&dest);
                std::fs::rename(&tmp, &dest)
                    .with_context(|| format!("rename to {}", dest.display()))?;
                return Ok(dest);
            }
            Err(e) => {
                last_err = Some(e);
                if attempt < 3 {
                    std::thread::sleep(Duration::from_secs(2u64.pow(attempt)));
                }
            }
        }
    }
    Err(last_err.unwrap().context(format!("download {url}")))
}
fn try_download(agent: &Client, url: &str) -> anyhow::Result<Vec<u8>> {
    let compressed = agent
        .get(url)
        .send()?
        .error_for_status()?
        .bytes()?
        .to_vec();
    let mut decoder = bzip2::read::BzDecoder::new(compressed.as_slice());
    let mut out = Vec::with_capacity(compressed.len() * 4);
    decoder.read_to_end(&mut out)?;
    Ok(out)
}
fn list_files(
    agent: &Client,
    cc: &str,
    bucket: &str,
) -> anyhow::Result<Vec<R2Object>> {
    let listing = if bucket.contains("updates") {
        "list-country-updates"
    } else {
        "list-countries"
    };
    let url = format!("{BASE_URL}/{listing}/{cc}");
    let objects: Vec<R2Object> = agent
        .get(&url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .with_context(|| format!("GET {url}"))?
        .json()?;
    Ok(objects)
}
fn run_limited<T: Sync>(
    items: &[T],
    limit: usize,
    cancel: Option<&CancelToken>,
    f: impl Fn(&T) -> anyhow::Result<()> + Sync,
) -> anyhow::Result<()> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let threads = limit.min(items.len()).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                scope
                    .spawn(|| -> anyhow::Result<()> {
                        loop {
                            if let Some(c) = cancel {
                                c.check()?;
                            }
                            let i = next
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            let Some(item) = items.get(i) else { return Ok(()) };
                            f(item)?;
                        }
                    })
            })
            .collect();
        for h in handles {
            h.join().expect("download worker panicked")?;
        }
        Ok(())
    })
}
fn download_metadata_path(country_folder: &Path) -> PathBuf {
    country_folder.join("downloads.json")
}
fn existing_files_in_metadata(country_folder: &Path) -> Vec<MetadataFile> {
    let path = download_metadata_path(country_folder);
    std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<DownloadMetadata>(&bytes).ok())
        .map(|m| m.files)
        .unwrap_or_default()
}
fn ensure_download_metadata_file_exists(root: &Path, cc: &str) -> anyhow::Result<()> {
    let country_folder = root.join(cc);
    if !country_folder.is_dir() {
        return Ok(());
    }
    let path = download_metadata_path(&country_folder);
    if path.exists() {
        return Ok(());
    }
    let mut files: Vec<MetadataFile> = Vec::new();
    for entry in std::fs::read_dir(&country_folder)? {
        let p = entry?.path();
        if p.extension().is_some_and(|e| e == "bin") {
            let mtime = p.metadata()?.modified()?;
            files
                .push(MetadataFile {
                    name: p.file_stem().unwrap().to_string_lossy().to_string(),
                    last_write_time_utc: NetDateTime::from_system_time_truncated(mtime),
                });
        }
    }
    write_metadata(&path, &files)
}
fn delete_data_file(country_folder: &Path, name: &str) {
    if let Ok(entries) = std::fs::read_dir(country_folder) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.file_stem().is_some_and(|s| s.to_string_lossy() == name) {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}
fn save_data_files_downloaded(
    country_folder: &Path,
    downloaded: &[&R2Object],
) -> anyhow::Result<()> {
    let path = download_metadata_path(country_folder);
    let old = existing_files_in_metadata(country_folder);
    let mut files: Vec<MetadataFile> = downloaded
        .iter()
        .map(|r2| MetadataFile {
            name: key_stem(&r2.key).to_string(),
            last_write_time_utc: r2.uploaded.clone(),
        })
        .collect();
    files
        .extend(
            old
                .into_iter()
                .filter(|f| {
                    downloaded
                        .iter()
                        .all(|r2| {
                            key_stem(&r2.key) != file_stem(remove_date_prefix(&f.name))
                        })
                }),
        );
    dedup_by_name(&mut files);
    write_metadata(&path, &files)
}
fn save_update_files_downloaded(
    country_folder: &Path,
    downloaded: &[&R2Object],
) -> anyhow::Result<()> {
    let path = download_metadata_path(country_folder);
    let old = existing_files_in_metadata(country_folder);
    let mut files: Vec<MetadataFile> = downloaded
        .iter()
        .map(|r2| MetadataFile {
            name: key_stem(&r2.key).to_string(),
            last_write_time_utc: r2.uploaded.clone(),
        })
        .collect();
    files.extend(old);
    dedup_by_name(&mut files);
    write_metadata(&path, &files)
}
fn dedup_by_name(files: &mut Vec<MetadataFile>) {
    let mut seen = std::collections::HashSet::new();
    files.retain(|f| seen.insert(f.name.clone()));
}
fn write_metadata(path: &Path, files: &[MetadataFile]) -> anyhow::Result<()> {
    const NL: &str = if cfg!(windows) { "\r\n" } else { "\n" };
    let mut out = String::new();
    out.push('{');
    out.push_str(NL);
    out.push_str("  \"files\": [");
    for (i, f) in files.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(NL);
        out.push_str("    {");
        out.push_str(NL);
        out.push_str("      \"name\": \"");
        out.push_str(&escape_dotnet(&f.name));
        out.push_str("\",");
        out.push_str(NL);
        out.push_str("      \"lastWriteTimeUtc\": \"");
        out.push_str(&f.last_write_time_utc.to_dotnet_string());
        out.push('"');
        out.push_str(NL);
        out.push_str("    }");
    }
    if files.is_empty() {
        out.push(']');
    } else {
        out.push_str(NL);
        out.push_str("  ]");
    }
    out.push_str(NL);
    out.push('}');
    std::fs::write(path, out).with_context(|| format!("write {}", path.display()))
}
fn escape_dotnet(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '+' => out.push_str("\\u002B"),
            '<' => out.push_str("\\u003C"),
            '>' => out.push_str("\\u003E"),
            '&' => out.push_str("\\u0026"),
            '\'' => out.push_str("\\u0027"),
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 || (c as u32) > 0x7e => {
                out.push_str(&format!("\\u{:04X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}
/// Object keys carry subdivision names verbatim ("AU/AU+Jervis Bay Territory.zip"), so they hold
/// spaces and non-ASCII. Encode to RFC 3986 `pchar`, keeping `/` as separator and `+` literal:
/// the bucket 404s form-style `+`, so there it is a real path character, not an encoded space.
fn encode_key(key: &str) -> String {
    const PATH: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'.')
        .remove(b'_')
        .remove(b'~')
        .remove(b'!')
        .remove(b'$')
        .remove(b'&')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')')
        .remove(b'*')
        .remove(b'+')
        .remove(b',')
        .remove(b';')
        .remove(b'=')
        .remove(b':')
        .remove(b'@')
        .remove(b'/');
    percent_encoding::utf8_percent_encode(key, PATH).to_string()
}
/// What `download_file` names a fetched object on disk.
fn downloaded_file_name(r2: &R2Object) -> String {
    format!("{}{FILE_EXTENSION}", key_stem(&r2.key))
}
fn key_stem(key: &str) -> &str {
    let name = key.rsplit(['/', '\\']).next().unwrap_or(key);
    match name.rfind('.') {
        Some(i) => &name[..i],
        None => name,
    }
}
fn file_stem(name: &str) -> &str {
    key_stem(name)
}
fn remove_date_prefix(name: &str) -> &str {
    name.trim_start_matches(|c: char| c.is_ascii_digit() || c == '-')
}
#[cfg(test)]
#[path = "download.test.rs"]
mod tests;
fn ensure_download_folder_writable(root: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(root).ok();
    let probe = root.join(".vali-write-probe");
    if std::fs::write(&probe, b"x").is_err() {
        bail!(
            "Vali does not have access to write files to '{}'. Set VALI_DOWNLOAD_FOLDER or downloadDirectory in application-settings.json to a writable folder.",
            root.display()
        );
    }
    let _ = std::fs::remove_file(&probe);
    Ok(())
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct NetDateTime {
    year: i32,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
    ticks: u32,
}
impl<'de> Deserialize<'de> for NetDateTime {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        NetDateTime::parse(&s)
            .ok_or_else(|| serde::de::Error::custom(format!("bad timestamp '{s}'")))
    }
}
impl NetDateTime {
    fn parse(s: &str) -> Option<NetDateTime> {
        let s = s.trim().strip_suffix('Z').unwrap_or(s.trim());
        let bytes = s.as_bytes();
        if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T'
            || bytes[13] != b':' || bytes[16] != b':'
        {
            return None;
        }
        let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<u32>().ok();
        let mut ticks = 0u32;
        if bytes.len() > 19 {
            if bytes[19] != b'.' {
                return None;
            }
            let frac = s.get(20..)?;
            if frac.is_empty() || frac.len() > 7
                || !frac.bytes().all(|b| b.is_ascii_digit())
            {
                return None;
            }
            ticks = frac.parse::<u32>().ok()? * 10u32.pow(7 - frac.len() as u32);
        }
        Some(NetDateTime {
            year: num(0..4)? as i32,
            month: num(5..7)? as u8,
            day: num(8..10)? as u8,
            hour: num(11..13)? as u8,
            minute: num(14..16)? as u8,
            second: num(17..19)? as u8,
            ticks,
        })
    }
    fn from_system_time_truncated(t: std::time::SystemTime) -> NetDateTime {
        let secs = t
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let days = secs.div_euclid(86_400);
        let rem = secs.rem_euclid(86_400);
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        NetDateTime {
            year: (if m <= 2 { y + 1 } else { y }) as i32,
            month: m as u8,
            day: d as u8,
            hour: (rem / 3600) as u8,
            minute: (rem % 3600 / 60) as u8,
            second: (rem % 60) as u8,
            ticks: 0,
        }
    }
    fn to_dotnet_string(&self) -> String {
        let mut s = format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", self.year, self.month, self.day, self
            .hour, self.minute, self.second
        );
        if self.ticks > 0 {
            let mut frac = format!("{:07}", self.ticks);
            while frac.ends_with('0') {
                frac.pop();
            }
            s.push('.');
            s.push_str(&frac);
        }
        s.push('Z');
        s
    }
}
