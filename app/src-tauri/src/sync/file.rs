//! File sync provider: a map file on disk or at an http(s) URL, followed pull-only. The file is
//! read with the import parser and normalized exactly as local locations are, so both sides of
//! the diff come from the same code.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;

use serde::Serialize;

use crate::io::import::parse::{parse_file, ParsedMap};
use crate::net::proxy;
use crate::sync::{
    local_to_normalized, IdentityModel, NormalizedSyncLocation, ProviderSpec, PushBatch, PushedId,
    RemoteSnapshot, RemoteTag, SyncDirection, SyncProvider,
};
use crate::types::shape::MapShape;
use crate::types::{AppError, AppResult};
use crate::util::blocking;

pub(crate) struct FileProvider;

impl FileProvider {
    pub(crate) const SPEC: ProviderSpec = ProviderSpec {
        id: "file",
        identity: IdentityModel::Positional,
        direction: SyncDirection::PullOnly,
        shape: MapShape::Local,
    };
}

fn is_url(address: &str) -> bool {
    address.starts_with("https://") || address.starts_with("http://")
}

/// A GitHub file page address means the raw file it shows.
fn resolved(address: &str) -> Cow<'_, str> {
    let Some(rest) = address.strip_prefix("https://github.com/") else {
        return Cow::Borrowed(address);
    };
    let mut parts = rest.splitn(4, '/');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(owner), Some(repo), Some("blob"), Some(path)) => Cow::Owned(format!(
            "https://raw.githubusercontent.com/{owner}/{repo}/{path}"
        )),
        _ => Cow::Borrowed(address),
    }
}

/// The map at `address`, parsed. A file that yields no locations and only complaints is an error.
fn read_source(address: &str) -> AppResult<ParsedMap> {
    let address = resolved(address);
    let mut bytes = if is_url(&address) {
        let resp = proxy::sync_client().get(address.as_ref()).send()?;
        let status = resp.status();
        if !status.is_success() {
            return Err(AppError(format!("{address}: HTTP {}", status.as_u16())));
        }
        resp.bytes()?.to_vec()
    } else {
        fs::read(address.as_ref())?
    };
    if bytes.iter().copied().find(|b| !b.is_ascii_whitespace()) == Some(b'<') {
        return Err(AppError(format!(
            "{address} answers with a web page, not a map file"
        )));
    }
    let map = parse_file(&mut bytes);
    if map.locations.is_empty() && !map.warnings.is_empty() {
        return Err(AppError(map.warnings.join("; ")));
    }
    Ok(map)
}

fn remote_tags(map: &ParsedMap) -> Vec<RemoteTag> {
    map.tags
        .iter()
        .filter_map(|rec| {
            Some(RemoteTag {
                name: rec.name.clone()?,
                color: rec.color().map(|c| c.to_string()),
                order: rec.order,
            })
        })
        .collect()
}

fn normalized(map: ParsedMap) -> Vec<NormalizedSyncLocation> {
    let names: HashMap<u32, String> = map
        .tags
        .iter()
        .filter_map(|rec| Some((rec.id, rec.name.clone()?)))
        .collect();
    let tag_name = |id: u32| names.get(&id).cloned();
    map.locations
        .into_iter()
        .map(|loc| local_to_normalized(&loc, &tag_name))
        .collect()
}

impl SyncProvider for FileProvider {
    type Raw = NormalizedSyncLocation;

    fn spec(&self) -> &'static ProviderSpec {
        &Self::SPEC
    }

    fn remote_id_of(&self, _item: &NormalizedSyncLocation, index: usize) -> i64 {
        index as i64
    }

    fn normalize(&self, item: &NormalizedSyncLocation) -> NormalizedSyncLocation {
        item.clone()
    }

    fn materialize(&self, n: &NormalizedSyncLocation) -> NormalizedSyncLocation {
        n.clone()
    }

    fn pull(&self, address: &str) -> AppResult<RemoteSnapshot<NormalizedSyncLocation>> {
        let map = read_source(address)?;
        Ok(RemoteSnapshot {
            tags: remote_tags(&map),
            locations: normalized(map),
            token: None,
        })
    }

    fn push(
        &self,
        _address: &str,
        _batch: &PushBatch<NormalizedSyncLocation>,
        _token: Option<i64>,
        _commit: &mut dyn FnMut(&[PushedId]) -> AppResult<()>,
    ) -> AppResult<Vec<PushedId>> {
        Err(AppError("a file source is never written to".into()))
    }
}

/// A map file as the link picker shows it.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileSource {
    /// The name the file gives its map; empty when it names none.
    pub name: String,
    pub location_count: u32,
}

/// Read the map file at a path or http(s) URL, to link a map to it.
#[tauri::command]
#[specta::specta]
pub async fn file_source_probe(address: String) -> AppResult<FileSource> {
    blocking(move || {
        let map = read_source(&address)?;
        Ok(FileSource {
            name: map.name,
            location_count: map.locations.len() as u32,
        })
    })
    .await?
}

#[cfg(test)]
#[path = "file.test.rs"]
mod tests;
