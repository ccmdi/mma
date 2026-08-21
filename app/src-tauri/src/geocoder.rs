//! Offline reverse geocoding -- maps (lat, lng) to nearest city/country.
//!
//! Wraps the `reverse_geocoder` crate (GeoNames dataset, ~15 MB in memory) behind
//! a lazy singleton so the dataset is loaded once on first use and reused for all
//! subsequent lookups. Used by the validation plugin and location preview to show
//! human-readable place names without any network requests.

use reverse_geocoder::{ReverseGeocoder, SearchResult};
use serde::Serialize;
use std::sync::OnceLock;

static GEOCODER: OnceLock<ReverseGeocoder> = OnceLock::new();

/// Returns the lazily-initialized global geocoder instance.
/// First call loads the full GeoNames dataset into a k-d tree; subsequent calls
/// are a pointer dereference.
fn get_geocoder() -> &'static ReverseGeocoder {
    GEOCODER.get_or_init(ReverseGeocoder::new)
}

/// Build the dataset ahead of the first lookup.
pub fn warm() {
    get_geocoder();
}

/// Reverse geocode result: nearest populated place to a coordinate.
#[derive(Serialize, specta::Type)]
pub struct GeoResult {
    pub city: String,
    /// First-level administrative division (state, province, region).
    pub admin: String,
    pub country: String,
    /// ISO 3166-1 alpha-2 (e.g. "US", "FR").
    pub country_code: String,
}

impl From<&SearchResult<'_>> for GeoResult {
    fn from(r: &SearchResult<'_>) -> Self {
        Self {
            city: r.record.name.to_string(),
            admin: r.record.admin1.to_string(),
            country: r.record.cc.to_string(),
            country_code: r.record.cc.to_string(),
        }
    }
}

/// Finds the nearest city/country for a coordinate. O(log n) k-d tree lookup.
/// Always returns `Some` -- the GeoNames dataset covers every landmass.
#[tauri::command]
#[specta::specta]
pub fn reverse_geocode(lat: f64, lng: f64) -> Option<GeoResult> {
    let gc = get_geocoder();
    let result = gc.search((lat, lng));
    Some(GeoResult::from(&result))
}
