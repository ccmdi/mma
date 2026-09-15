use serde::Deserialize;
use std::path::{Path, PathBuf};
#[derive(Deserialize, Default)]
struct AppSettings {
    #[serde(rename = "downloadDirectory")]
    download_directory: Option<String>,
}
fn common_app_data() -> Option<PathBuf> {
    std::env::var_os("ProgramData").map(PathBuf::from)
}
fn settings_download_directory() -> Option<String> {
    let path = common_app_data()?
        .join("Vali")
        .join("application-settings.json");
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<AppSettings>(&text)
        .ok()?
        .download_directory
        .filter(|s| !s.is_empty())
}
pub fn data_root() -> anyhow::Result<PathBuf> {
    if let Some(env) = std::env::var_os("VALI_DOWNLOAD_FOLDER") {
        if !env.is_empty() {
            return Ok(PathBuf::from(env).join("Vali"));
        }
    }
    let dir = settings_download_directory()
        .map(PathBuf::from)
        .or_else(common_app_data)
        .ok_or_else(|| anyhow::anyhow!("cannot resolve download folder"))?;
    Ok(dir.join("Vali"))
}
pub fn subdivision_file(root: &Path, country: &str, subdivision: &str) -> PathBuf {
    root.join(country)
        .join(format!("{country}+{subdivision}.bin"))
}
