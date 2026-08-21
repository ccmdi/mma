//! The anonymous reporting transport, plus the redaction every report passes through.
//!
//! Signed-in reports go straight to GitHub (see [`crate::github`]). Reports from users
//! without an account go through a small Cloudflare Worker (`workers/feedback/`) that holds
//! the GitHub App installation key and files the issue on their behalf.

use crate::github::IssueThread;
use crate::types::AppResult;
use crate::util::{blocking, sha256};

/// Empty disables the anonymous tier rather than failing it.
const WORKER_URL: &str = "https://feedback.ccmdi.com";

/// Leading zero bits demanded of the proof-of-work hash. ~1M hashes to solve (well under a
/// second), one hash to check. Enough to make scripted spam cost something without the user
/// ever noticing, and the worker rejects anything short.
pub(crate) const POW_BITS: u32 = 20;

/// How much of the log the report may carry. Large enough for a session's worth of context,
/// small enough to stay inside GitHub's 65536-character issue body limit alongside everything
/// else.
const MAX_LOG_TAIL: u64 = 16 * 1024;

#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AnonIssueRef {
    pub number: u32,
    pub url: String,
    /// Grants read access to this one issue's relayed comments. Not a credential for anything
    /// else, which is why it is safe to keep in local storage.
    pub token: String,
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/// Replace the home-directory segment of any path in `s` with a placeholder.
///
/// Log lines are full of `C:\Users\<name>\...`, and a report is a public artifact. This runs
/// over everything leaving the app, not just the log tail.
pub(crate) fn scrub(s: &str) -> String {
    const ROOTS: [&str; 2] = ["users", "home"];
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;

    while i < bytes.len() {
        // Byte-wise ASCII comparison: a lowercased copy of the whole string can differ in
        // length (e.g. 'İ'), which would shift every offset after it.
        let root = ROOTS.iter().find(|r| {
            bytes
                .get(i..i + r.len())
                .is_some_and(|w| w.eq_ignore_ascii_case(r.as_bytes()))
                // Must be preceded by a separator (or start of string) so "browsers/x" is not
                // mistaken for a "users/" root.
                && (i == 0 || bytes[i - 1] == b'/' || bytes[i - 1] == b'\\')
                && matches!(bytes.get(i + r.len()), Some(b'/') | Some(b'\\'))
        });
        let Some(root) = root else {
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        };
        let sep = bytes[i + root.len()] as char;
        let name_start = i + root.len() + 1;
        let name_end = bytes[name_start..]
            .iter()
            .position(|b| *b == b'/' || *b == b'\\')
            .map(|p| name_start + p)
            .unwrap_or(bytes.len());
        if name_end == name_start {
            // "users//" -- no name to redact.
            out.push_str(&s[i..name_start]);
            i = name_start;
            continue;
        }
        out.push_str(&s[i..i + root.len()]);
        out.push(sep);
        out.push_str("<user>");
        i = name_end;
    }
    out
}

// ---------------------------------------------------------------------------
// Proof of work
// ---------------------------------------------------------------------------

fn leading_zero_bits(digest: &[u8; 32]) -> u32 {
    let mut n = 0;
    for b in digest {
        n += b.leading_zeros();
        if *b != 0 {
            break;
        }
    }
    n
}

/// The predicate the worker re-checks. `challenge` is the worker-minted challenge joined to
/// the hash of the content being submitted, so a solved nonce is bound to that exact content
/// and expires with the challenge.
pub(crate) fn verify_pow(challenge: &str, nonce: u64, bits: u32) -> bool {
    leading_zero_bits(&sha256(format!("{challenge}:{nonce}").as_bytes())) >= bits
}

pub(crate) fn solve_pow(challenge: &str, bits: u32) -> u64 {
    (0u64..).find(|n| verify_pow(challenge, *n, bits)).unwrap()
}

/// A short-lived challenge minted by the worker. The proof of work is solved against
/// `{challenge}:{content hash}`, so a solution is bound to both the content and the worker's
/// expiry window -- it cannot be precomputed or stockpiled.
fn fetch_challenge() -> AppResult<String> {
    #[derive(serde::Deserialize)]
    struct ChallengeResp {
        challenge: String,
    }
    let resp = crate::proxy::proxy_client()
        .get(format!("{WORKER_URL}/challenge"))
        .send()?;
    if !resp.status().is_success() {
        return Err(format!("challenge request failed ({})", resp.status()).into());
    }
    Ok(resp.json::<ChallengeResp>()?.challenge)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The tail of `mma.log`, scrubbed. Empty string when there is no log yet.
#[tauri::command]
#[specta::specta]
pub async fn feedback_log_tail(app: tauri::AppHandle) -> AppResult<String> {
    use std::io::{Read, Seek, SeekFrom};
    use tauri::Manager;

    let path = app.path().app_log_dir()?.join("mma.log");
    blocking(move || {
        let Ok(mut f) = std::fs::File::open(&path) else {
            return Ok(String::new());
        };
        let len = f.metadata()?.len();
        let start = len.saturating_sub(MAX_LOG_TAIL);
        f.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::with_capacity((len - start) as usize);
        f.read_to_end(&mut buf)?;
        let text = String::from_utf8_lossy(&buf);
        // A mid-character seek leaves a partial first line; drop it rather than ship a fragment.
        let text = match (start > 0, text.find('\n')) {
            (true, Some(nl)) => &text[nl + 1..],
            _ => &text,
        };
        Ok(scrub(text))
    })
    .await?
}

/// Whether the anonymous tier is available in this build.
#[tauri::command]
#[specta::specta]
pub async fn feedback_anonymous_available() -> AppResult<bool> {
    Ok(!WORKER_URL.is_empty())
}

/// File an issue through the worker, without any account. The worker applies the labels
/// (a bot has push access, so it can) and returns the reply token.
#[tauri::command]
#[specta::specta]
pub async fn feedback_submit_anonymous(
    title: String,
    body: String,
    install_id: String,
) -> AppResult<AnonIssueRef> {
    if WORKER_URL.is_empty() {
        return Err("anonymous reporting is not configured in this build".into());
    }
    blocking(move || {
        let title = scrub(&title);
        let body = scrub(&body);
        let challenge = fetch_challenge()?;
        let content = crate::util::sha256_hex(format!("{title}\0{body}").as_bytes());
        let nonce = solve_pow(&format!("{challenge}:{content}"), POW_BITS);
        let resp = crate::proxy::proxy_client()
            .post(format!("{WORKER_URL}/reports"))
            .json(&serde_json::json!({
                "title": title,
                "body": body,
                "installId": install_id,
                "challenge": challenge,
                "nonce": nonce,
            }))
            .send()?;
        let status = resp.status();
        if !status.is_success() {
            let detail = resp.text().unwrap_or_default();
            return Err(format!("report rejected ({status}): {detail}").into());
        }
        Ok(resp.json::<AnonIssueRef>()?)
    })
    .await?
}

/// An image the reporter attached, once it is somewhere the issue can point at.
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    pub url: String,
    /// Alt text for the reference. The worker decides it -- a client-supplied name reaches the
    /// rendered issue.
    pub name: String,
}

/// Largest image the worker will take. Checked here too so an oversized file fails instantly
/// instead of after a megabyte of upload.
const MAX_ATTACHMENT: u64 = 5 * 1024 * 1024;

/// Whether `bytes` begins like an image format the worker accepts. Sniffed rather than trusted
/// from the extension, matching what the worker does with the same bytes.
fn is_image(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a])
        || bytes.starts_with(&[0xff, 0xd8, 0xff])
        || bytes.starts_with(b"GIF8")
        || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice()))
}

/// Whether `path` is a file the report dialog staged: a direct child of a valid upload
/// session dir (see [`crate::export::upload_session_dir`]). The upload command is reachable
/// from plugins, so an unconstrained path would read -- and then delete -- anything on disk.
pub(crate) fn is_staged_upload(path: &std::path::Path) -> bool {
    path.parent()
        .and_then(|p| p.to_str())
        .is_some_and(|p| crate::export::upload_session_dir(p).is_ok())
}

/// Store an image and return the URL a report body can reference it by.
///
/// The proof of work is bound to the bytes, so it costs the same per image as a report costs
/// per body -- which is what keeps an open upload route from being free hosting.
#[tauri::command]
#[specta::specta]
pub async fn feedback_upload_attachment(path: String, name: String) -> AppResult<AttachmentRef> {
    if WORKER_URL.is_empty() {
        return Err("attachments are not configured in this build".into());
    }
    blocking(move || {
        if !is_staged_upload(std::path::Path::new(&path)) {
            return Err("attachment is not a staged upload".into());
        }
        let meta = std::fs::metadata(&path)?;
        if meta.len() > MAX_ATTACHMENT {
            return Err("image is too large (5 MB maximum)".into());
        }
        let bytes = std::fs::read(&path)?;
        if !is_image(&bytes) {
            return Err("that file is not a PNG, JPEG, GIF or WebP".into());
        }
        let challenge = fetch_challenge()?;
        let digest = crate::util::sha256_hex(&bytes);
        let nonce = solve_pow(&format!("{challenge}:{digest}"), POW_BITS);
        let name = percent_encoding::utf8_percent_encode(
            &name,
            percent_encoding::NON_ALPHANUMERIC,
        )
        .to_string();
        let resp = crate::proxy::proxy_client()
            .post(format!(
                "{WORKER_URL}/uploads?name={name}&challenge={challenge}&nonce={nonce}"
            ))
            .header("Content-Type", "application/octet-stream")
            .body(bytes)
            .send()?;
        let status = resp.status();
        if !status.is_success() {
            let detail = resp.text().unwrap_or_default();
            return Err(format!("upload rejected ({status}): {detail}").into());
        }
        let uploaded = resp.json::<AttachmentRef>()?;
        // The staged copy has served its purpose; leaving it would keep a screenshot in temp.
        let _ = std::fs::remove_file(&path);
        Ok(uploaded)
    })
    .await?
}

/// Ask the worker to label an issue the user filed themselves.
///
/// GitHub drops labels sent by a reporter without push access, so a signed-in outside
/// contributor's report arrives bare. The worker's installation token has push access and
/// re-applies them. Best-effort: a report that is filed but unlabelled is not worth failing.
#[tauri::command]
#[specta::specta]
pub async fn feedback_request_label(number: u32) -> AppResult<()> {
    if WORKER_URL.is_empty() {
        return Ok(());
    }
    blocking(move || {
        let request = || -> AppResult<()> {
            let challenge = fetch_challenge()?;
            let nonce = solve_pow(&format!("{challenge}:label:{number}"), POW_BITS);
            let resp = crate::proxy::proxy_client()
                .post(format!(
                    "{WORKER_URL}/reports/{number}/label?challenge={challenge}&nonce={nonce}"
                ))
                .send()?;
            if !resp.status().is_success() {
                return Err(format!("label request returned {}", resp.status()).into());
            }
            Ok(())
        };
        if let Err(e) = request() {
            log::debug!("[feedback] label request failed: {e}");
        }
        Ok(())
    })
    .await?
}

/// State and replies for an anonymous report, relayed by the worker.
#[tauri::command]
#[specta::specta]
pub async fn feedback_anonymous_thread(number: u32, token: String) -> AppResult<IssueThread> {
    if WORKER_URL.is_empty() {
        return Err("anonymous reporting is unavailable in this build".into());
    }
    blocking(move || {
        // In a header rather than the URL, which lands in request logs along the way.
        let resp = crate::proxy::proxy_client()
            .get(format!("{WORKER_URL}/reports/{number}"))
            .header("Authorization", format!("Bearer {token}"))
            .send()?;
        if !resp.status().is_success() {
            return Err(format!("could not read the report ({})", resp.status()).into());
        }
        Ok(resp.json::<IssueThread>()?)
    })
    .await?
}

#[cfg(test)]
#[path = "feedback.test.rs"]
mod tests;
