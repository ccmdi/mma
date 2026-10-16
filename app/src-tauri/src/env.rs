//! Settings a developer can point elsewhere without a rebuild, such as which repository
//! reports are filed on.

use std::collections::HashMap;
use std::env;

/// `name` from the process environment, or in a debug build from the checkout's `.env`.
pub(crate) fn var(name: &str) -> Option<String> {
    if let Ok(value) = env::var(name) {
        return Some(value);
    }
    #[cfg(debug_assertions)]
    {
        use std::fs;
        use std::sync::OnceLock;
        static FILE: OnceLock<HashMap<String, String>> = OnceLock::new();
        FILE.get_or_init(|| {
            fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.env"))
                .map(|text| parse(&text))
                .unwrap_or_default()
        })
        .get(name)
        .cloned()
    }
    #[cfg(not(debug_assertions))]
    None
}

/// `KEY=value` lines; blank lines and `#` comments are skipped, and one pair of surrounding
/// quotes is dropped from a value.
#[cfg_attr(
    not(debug_assertions),
    expect(dead_code, reason = "only debug builds read .env")
)]
fn parse(text: &str) -> HashMap<String, String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| {
            let value = value.trim();
            let unquoted = ['"', '\'']
                .iter()
                .find_map(|q| value.strip_prefix(*q)?.strip_suffix(*q))
                .unwrap_or(value);
            (key.trim().to_string(), unquoted.to_string())
        })
        .collect()
}

#[cfg(test)]
#[path = "env.test.rs"]
mod tests;
