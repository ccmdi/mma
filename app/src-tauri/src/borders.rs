//! Country border lookup -- loads GeoJSON border datasets and performs
//! point-in-polygon tests to identify which country a coordinate falls in.
//!
//! Three dataset levels: "light" (bundled, sub-country splits), "medium" (~10MB,
//! country-level), "heavy" (~46MB, country-level). The bundled "light" set is parsed
//! from GeoJSON on first use; the larger downloaded sets ship as rkyv archives
//! (`borders-{level}.rkyv` in `app_data_dir/borders/`) that are memory-mapped and read
//! zero-copy -- no JSON parse, no per-coordinate allocation. Generate the archives with
//! the `gen_rkyv_artifacts` ignored test (see `borders.test.rs`).

use crate::types::{AppError, AppResult};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;

use crate::selections::{self, PolygonGeometry};

struct BorderFeature {
    name: String,
    code: String,
    geometry: PolygonGeometry,
}

/// On-disk archive schema. A dedicated type (not `PolygonGeometry`) because borders only
/// need geometry + identity, and rkyv must own a flat, serde-free shape. Native-endian
/// rkyv means `Archived<[f64; 2]>` is `[f64; 2]`, so archived rings deref to `&[[f64; 2]]`
/// and feed the shared point-in-polygon core with zero copies.
#[derive(rkyv::Archive, rkyv::Serialize)]
#[archive(check_bytes)]
struct ArchFeature {
    name: String,
    code: String,
    /// Primary polygon: outer ring then holes.
    rings: Vec<Vec<[f64; 2]>>,
    /// Remaining polygons of a multipolygon (each its own outer + holes).
    extra: Vec<Vec<Vec<[f64; 2]>>>,
}

#[derive(rkyv::Archive, rkyv::Serialize)]
#[archive(check_bytes)]
struct ArchDataset {
    features: Vec<ArchFeature>,
}

/// A loaded dataset: either parsed-and-owned (bundled "light") or a validated mmap of an
/// rkyv archive (downloaded levels), read zero-copy on every lookup.
enum Dataset {
    Owned(Vec<BorderFeature>),
    Mapped(memmap2::Mmap),
}

impl Dataset {
    /// SAFETY: only ever called on a `Mapped` whose bytes were validated by
    /// `check_archived_root` at load time and are immutable while mapped.
    fn archived(mmap: &memmap2::Mmap) -> &ArchivedArchDataset {
        unsafe { rkyv::archived_root::<ArchDataset>(&mmap[..]) }
    }
}

static DATASETS: OnceLock<Mutex<HashMap<String, Dataset>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, Dataset>> {
    DATASETS.get_or_init(|| Mutex::new(HashMap::new()))
}

// --- GeoJSON deserialization (only the fields we need) ---

#[derive(Deserialize)]
struct GeoJsonCollection {
    features: Vec<GeoJsonFeature>,
}

#[derive(Deserialize)]
struct GeoJsonFeature {
    properties: serde_json::Value,
    geometry: Option<GeoJsonGeometry>,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum GeoJsonGeometry {
    Polygon {
        coordinates: Vec<Vec<[f64; 2]>>,
    },
    MultiPolygon {
        coordinates: Vec<Vec<Vec<[f64; 2]>>>,
    },
}

// --- A3 -> (A2, name) lookup ---

static ISO_MAP: &[(&str, &str, &str)] = &[
    ("ABW", "AW", "Aruba"),
    ("AFG", "AF", "Afghanistan"),
    ("AGO", "AO", "Angola"),
    ("AIA", "AI", "Anguilla"),
    ("ALA", "AX", "Aland Islands"),
    ("ALB", "AL", "Albania"),
    ("AND", "AD", "Andorra"),
    ("ARE", "AE", "United Arab Emirates"),
    ("ARG", "AR", "Argentina"),
    ("ARM", "AM", "Armenia"),
    ("ASM", "AS", "American Samoa"),
    ("ATA", "AQ", "Antarctica"),
    ("ATF", "TF", "French Southern Territories"),
    ("ATG", "AG", "Antigua and Barbuda"),
    ("AUS", "AU", "Australia"),
    ("AUT", "AT", "Austria"),
    ("AZE", "AZ", "Azerbaijan"),
    ("BDI", "BI", "Burundi"),
    ("BEL", "BE", "Belgium"),
    ("BEN", "BJ", "Benin"),
    ("BES", "BQ", "Bonaire, Sint Eustatius and Saba"),
    ("BFA", "BF", "Burkina Faso"),
    ("BGD", "BD", "Bangladesh"),
    ("BGR", "BG", "Bulgaria"),
    ("BHR", "BH", "Bahrain"),
    ("BHS", "BS", "Bahamas"),
    ("BIH", "BA", "Bosnia and Herzegovina"),
    ("BLM", "BL", "Saint Barthelemy"),
    ("BLR", "BY", "Belarus"),
    ("BLZ", "BZ", "Belize"),
    ("BMU", "BM", "Bermuda"),
    ("BOL", "BO", "Bolivia"),
    ("BRA", "BR", "Brazil"),
    ("BRB", "BB", "Barbados"),
    ("BRN", "BN", "Brunei"),
    ("BTN", "BT", "Bhutan"),
    ("BVT", "BV", "Bouvet Island"),
    ("BWA", "BW", "Botswana"),
    ("CAF", "CF", "Central African Republic"),
    ("CAN", "CA", "Canada"),
    ("CCK", "CC", "Cocos Islands"),
    ("CHE", "CH", "Switzerland"),
    ("CHL", "CL", "Chile"),
    ("CHN", "CN", "China"),
    ("CIV", "CI", "Ivory Coast"),
    ("CMR", "CM", "Cameroon"),
    ("COD", "CD", "DR Congo"),
    ("COG", "CG", "Republic of the Congo"),
    ("COK", "CK", "Cook Islands"),
    ("COL", "CO", "Colombia"),
    ("COM", "KM", "Comoros"),
    ("CPV", "CV", "Cape Verde"),
    ("CRI", "CR", "Costa Rica"),
    ("CUB", "CU", "Cuba"),
    ("CUW", "CW", "Curacao"),
    ("CXR", "CX", "Christmas Island"),
    ("CYM", "KY", "Cayman Islands"),
    ("CYP", "CY", "Cyprus"),
    ("CZE", "CZ", "Czechia"),
    ("DEU", "DE", "Germany"),
    ("DJI", "DJ", "Djibouti"),
    ("DMA", "DM", "Dominica"),
    ("DNK", "DK", "Denmark"),
    ("DOM", "DO", "Dominican Republic"),
    ("DZA", "DZ", "Algeria"),
    ("ECU", "EC", "Ecuador"),
    ("EGY", "EG", "Egypt"),
    ("ERI", "ER", "Eritrea"),
    ("ESH", "EH", "Western Sahara"),
    ("ESP", "ES", "Spain"),
    ("EST", "EE", "Estonia"),
    ("ETH", "ET", "Ethiopia"),
    ("FIN", "FI", "Finland"),
    ("FJI", "FJ", "Fiji"),
    ("FLK", "FK", "Falkland Islands"),
    ("FRA", "FR", "France"),
    ("FRO", "FO", "Faroe Islands"),
    ("FSM", "FM", "Micronesia"),
    ("GAB", "GA", "Gabon"),
    ("GBR", "GB", "United Kingdom"),
    ("GEO", "GE", "Georgia"),
    ("GGY", "GG", "Guernsey"),
    ("GHA", "GH", "Ghana"),
    ("GIB", "GI", "Gibraltar"),
    ("GIN", "GN", "Guinea"),
    ("GLP", "GP", "Guadeloupe"),
    ("GMB", "GM", "Gambia"),
    ("GNB", "GW", "Guinea-Bissau"),
    ("GNQ", "GQ", "Equatorial Guinea"),
    ("GRC", "GR", "Greece"),
    ("GRD", "GD", "Grenada"),
    ("GRL", "GL", "Greenland"),
    ("GTM", "GT", "Guatemala"),
    ("GUF", "GF", "French Guiana"),
    ("GUM", "GU", "Guam"),
    ("GUY", "GY", "Guyana"),
    ("HKG", "HK", "Hong Kong"),
    ("HMD", "HM", "Heard Island and McDonald Islands"),
    ("HND", "HN", "Honduras"),
    ("HRV", "HR", "Croatia"),
    ("HTI", "HT", "Haiti"),
    ("HUN", "HU", "Hungary"),
    ("IDN", "ID", "Indonesia"),
    ("IMN", "IM", "Isle of Man"),
    ("IND", "IN", "India"),
    ("IOT", "IO", "British Indian Ocean Territory"),
    ("IRL", "IE", "Ireland"),
    ("IRN", "IR", "Iran"),
    ("IRQ", "IQ", "Iraq"),
    ("ISL", "IS", "Iceland"),
    ("ISR", "IL", "Israel"),
    ("ITA", "IT", "Italy"),
    ("JAM", "JM", "Jamaica"),
    ("JEY", "JE", "Jersey"),
    ("JOR", "JO", "Jordan"),
    ("JPN", "JP", "Japan"),
    ("KAZ", "KZ", "Kazakhstan"),
    ("KEN", "KE", "Kenya"),
    ("KGZ", "KG", "Kyrgyzstan"),
    ("KHM", "KH", "Cambodia"),
    ("KIR", "KI", "Kiribati"),
    ("KNA", "KN", "Saint Kitts and Nevis"),
    ("KOR", "KR", "South Korea"),
    ("KWT", "KW", "Kuwait"),
    ("LAO", "LA", "Laos"),
    ("LBN", "LB", "Lebanon"),
    ("LBR", "LR", "Liberia"),
    ("LBY", "LY", "Libya"),
    ("LCA", "LC", "Saint Lucia"),
    ("LIE", "LI", "Liechtenstein"),
    ("LKA", "LK", "Sri Lanka"),
    ("LSO", "LS", "Lesotho"),
    ("LTU", "LT", "Lithuania"),
    ("LUX", "LU", "Luxembourg"),
    ("LVA", "LV", "Latvia"),
    ("MAC", "MO", "Macau"),
    ("MAF", "MF", "Saint Martin"),
    ("MAR", "MA", "Morocco"),
    ("MCO", "MC", "Monaco"),
    ("MDA", "MD", "Moldova"),
    ("MDG", "MG", "Madagascar"),
    ("MDV", "MV", "Maldives"),
    ("MEX", "MX", "Mexico"),
    ("MHL", "MH", "Marshall Islands"),
    ("MKD", "MK", "North Macedonia"),
    ("MLI", "ML", "Mali"),
    ("MLT", "MT", "Malta"),
    ("MMR", "MM", "Myanmar"),
    ("MNE", "ME", "Montenegro"),
    ("MNG", "MN", "Mongolia"),
    ("MNP", "MP", "Northern Mariana Islands"),
    ("MOZ", "MZ", "Mozambique"),
    ("MRT", "MR", "Mauritania"),
    ("MSR", "MS", "Montserrat"),
    ("MTQ", "MQ", "Martinique"),
    ("MUS", "MU", "Mauritius"),
    ("MWI", "MW", "Malawi"),
    ("MYS", "MY", "Malaysia"),
    ("MYT", "YT", "Mayotte"),
    ("NAM", "NA", "Namibia"),
    ("NCL", "NC", "New Caledonia"),
    ("NER", "NE", "Niger"),
    ("NFK", "NF", "Norfolk Island"),
    ("NGA", "NG", "Nigeria"),
    ("NIC", "NI", "Nicaragua"),
    ("NIU", "NU", "Niue"),
    ("NLD", "NL", "Netherlands"),
    ("NOR", "NO", "Norway"),
    ("NPL", "NP", "Nepal"),
    ("NRU", "NR", "Nauru"),
    ("NZL", "NZ", "New Zealand"),
    ("OMN", "OM", "Oman"),
    ("PAK", "PK", "Pakistan"),
    ("PAN", "PA", "Panama"),
    ("PCN", "PN", "Pitcairn Islands"),
    ("PER", "PE", "Peru"),
    ("PHL", "PH", "Philippines"),
    ("PLW", "PW", "Palau"),
    ("PNG", "PG", "Papua New Guinea"),
    ("POL", "PL", "Poland"),
    ("PRI", "PR", "Puerto Rico"),
    ("PRK", "KP", "North Korea"),
    ("PRT", "PT", "Portugal"),
    ("PRY", "PY", "Paraguay"),
    ("PSE", "PS", "Palestine"),
    ("PYF", "PF", "French Polynesia"),
    ("QAT", "QA", "Qatar"),
    ("REU", "RE", "Reunion"),
    ("ROU", "RO", "Romania"),
    ("RUS", "RU", "Russia"),
    ("RWA", "RW", "Rwanda"),
    ("SAU", "SA", "Saudi Arabia"),
    ("SDN", "SD", "Sudan"),
    ("SEN", "SN", "Senegal"),
    ("SGP", "SG", "Singapore"),
    ("SGS", "GS", "South Georgia"),
    ("SHN", "SH", "Saint Helena"),
    ("SJM", "SJ", "Svalbard and Jan Mayen"),
    ("SLB", "SB", "Solomon Islands"),
    ("SLE", "SL", "Sierra Leone"),
    ("SLV", "SV", "El Salvador"),
    ("SMR", "SM", "San Marino"),
    ("SOM", "SO", "Somalia"),
    ("SPM", "PM", "Saint Pierre and Miquelon"),
    ("SRB", "RS", "Serbia"),
    ("SSD", "SS", "South Sudan"),
    ("STP", "ST", "Sao Tome and Principe"),
    ("SUR", "SR", "Suriname"),
    ("SVK", "SK", "Slovakia"),
    ("SVN", "SI", "Slovenia"),
    ("SWE", "SE", "Sweden"),
    ("SWZ", "SZ", "Eswatini"),
    ("SXM", "SX", "Sint Maarten"),
    ("SYC", "SC", "Seychelles"),
    ("SYR", "SY", "Syria"),
    ("TCA", "TC", "Turks and Caicos Islands"),
    ("TCD", "TD", "Chad"),
    ("TGO", "TG", "Togo"),
    ("THA", "TH", "Thailand"),
    ("TJK", "TJ", "Tajikistan"),
    ("TKL", "TK", "Tokelau"),
    ("TKM", "TM", "Turkmenistan"),
    ("TLS", "TL", "Timor-Leste"),
    ("TON", "TO", "Tonga"),
    ("TTO", "TT", "Trinidad and Tobago"),
    ("TUN", "TN", "Tunisia"),
    ("TUR", "TR", "Turkey"),
    ("TUV", "TV", "Tuvalu"),
    ("TWN", "TW", "Taiwan"),
    ("TZA", "TZ", "Tanzania"),
    ("UGA", "UG", "Uganda"),
    ("UKR", "UA", "Ukraine"),
    ("UMI", "UM", "US Minor Outlying Islands"),
    ("URY", "UY", "Uruguay"),
    ("USA", "US", "United States"),
    ("UZB", "UZ", "Uzbekistan"),
    ("VAT", "VA", "Vatican City"),
    ("VCT", "VC", "Saint Vincent and the Grenadines"),
    ("VEN", "VE", "Venezuela"),
    ("VGB", "VG", "British Virgin Islands"),
    ("VIR", "VI", "US Virgin Islands"),
    ("VNM", "VN", "Vietnam"),
    ("VUT", "VU", "Vanuatu"),
    ("WLF", "WF", "Wallis and Futuna"),
    ("WSM", "WS", "Samoa"),
    ("XKX", "XK", "Kosovo"),
    ("YEM", "YE", "Yemen"),
    ("ZAF", "ZA", "South Africa"),
    ("ZMB", "ZM", "Zambia"),
    ("ZWE", "ZW", "Zimbabwe"),
];

fn lookup_a3(a3: &str) -> (&'static str, &'static str) {
    for &(code3, code2, name) in ISO_MAP {
        if code3 == a3 {
            return (code2, name);
        }
    }
    ("??", "Unknown")
}

// --- Parsing ---

fn convert_feature(gj: GeoJsonFeature) -> Option<BorderFeature> {
    let props = &gj.properties;

    // geoBoundaries: { "shapeGroup": "FRA", "shapeName": "France" }
    // geo-maps:      { "A3": "FRA" }
    // light/bundled:  { "code": "FR", "name": "France" }
    let (code, name) = if let Some(a3) = props
        .get("shapeGroup")
        .or_else(|| props.get("A3"))
        .and_then(|v| v.as_str())
    {
        let (c2, n) = lookup_a3(a3);
        let display = props.get("shapeName").and_then(|v| v.as_str()).unwrap_or(n);
        (c2.to_string(), display.to_string())
    } else {
        let code = props
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or("??")
            .to_string();
        let name = props
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown")
            .to_string();
        (code, name)
    };

    let geometry = match gj.geometry? {
        GeoJsonGeometry::Polygon { coordinates } => PolygonGeometry {
            coordinates,
            extra_polygons: None,
            properties: None,
        },
        GeoJsonGeometry::MultiPolygon { coordinates } => {
            let mut iter = coordinates.into_iter();
            let first = iter.next()?;
            let rest: Vec<_> = iter.collect();
            PolygonGeometry {
                coordinates: first,
                extra_polygons: if rest.is_empty() { None } else { Some(rest) },
                properties: None,
            }
        }
    };

    Some(BorderFeature {
        name,
        code,
        geometry,
    })
}

fn parse_geojson(data: &str) -> AppResult<Vec<BorderFeature>> {
    let collection: GeoJsonCollection =
        serde_json::from_str(data).map_err(|e| format!("Failed to parse border GeoJSON: {e}"))?;
    Ok(collection
        .features
        .into_iter()
        .filter_map(convert_feature)
        .collect())
}

/// Serialize a GeoJSON border dataset into the rkyv archive bytes shipped to clients.
/// Reproducible offline step -- see the `gen_rkyv_artifacts` test. Test-only: the app
/// reads the prebuilt archives, it never converts at runtime.
#[cfg(test)]
fn convert_dataset(json: &str) -> AppResult<Vec<u8>> {
    let features = parse_geojson(json)?
        .into_iter()
        .map(|f| ArchFeature {
            name: f.name,
            code: f.code,
            rings: f.geometry.coordinates,
            extra: f.geometry.extra_polygons.unwrap_or_default(),
        })
        .collect();
    let dataset = ArchDataset { features };
    let bytes = rkyv::to_bytes::<_, 1024>(&dataset)
        .map_err(|e| format!("Failed to serialize border archive: {e:?}"))?;
    Ok(bytes.into_vec())
}

fn load_dataset(level: &str) -> AppResult<()> {
    let dataset = if level == "light" {
        let features = parse_geojson(include_str!("../data/borders.json"))?;
        log::info!(
            "Loaded {} border features for level 'light'",
            features.len()
        );
        Dataset::Owned(features)
    } else {
        let path = crate::storage::app_data_dir()?
            .join("borders")
            .join(format!("borders-{level}.rkyv"));
        let file = std::fs::File::open(&path)
            .map_err(|e| format!("Failed to open borders-{level}.rkyv: {e}"))?;
        // SAFETY: we own the file; it is not modified while mapped.
        let mmap = unsafe { memmap2::Mmap::map(&file) }
            .map_err(|e| format!("Failed to mmap borders-{level}.rkyv: {e}"))?;
        rkyv::check_archived_root::<ArchDataset>(&mmap[..])
            .map_err(|e| format!("Corrupt border archive borders-{level}.rkyv: {e:?}"))?;
        log::info!(
            "Mapped {} border features for level '{level}'",
            Dataset::archived(&mmap).features.len()
        );
        Dataset::Mapped(mmap)
    };

    cache().lock().unwrap().insert(level.to_string(), dataset);
    Ok(())
}

// --- Archived geometry access (zero-copy over the mmap) ---

type ArchPoly = rkyv::vec::ArchivedVec<rkyv::vec::ArchivedVec<[f64; 2]>>;

/// Rings of an archived polygon as `&[[f64; 2]]` slices.
fn arch_rings(poly: &ArchPoly) -> impl Iterator<Item = &[[f64; 2]]> {
    poly.iter().map(|r| r.as_slice())
}

fn arch_point_in_feature(lng: f64, lat: f64, f: &ArchivedArchFeature) -> bool {
    if selections::polygon_contains(lng, lat, arch_rings(&f.rings)) {
        return true;
    }
    f.extra
        .iter()
        .any(|poly| selections::polygon_contains(lng, lat, arch_rings(poly)))
}

fn arch_feature_bbox(f: &ArchivedArchFeature) -> Option<[f64; 4]> {
    let all_rings = || f.rings.iter().chain(f.extra.iter().flat_map(|p| p.iter()));
    let crosses = all_rings().any(|r| selections::ring_crosses_antimeridian(r.as_slice()));
    let mut bb = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    let mut any = false;
    for r in all_rings() {
        selections::extend_bbox_with_ring(&mut bb, &mut any, crosses, r.as_slice());
    }
    if any {
        Some(bb)
    } else {
        None
    }
}

/// Copy a matched archived feature back into an owned `PolygonGeometry` for the IPC reply.
/// Only the single matched feature is cloned, so the per-coordinate copy is off the hot path.
fn arch_to_geometry(f: &ArchivedArchFeature) -> PolygonGeometry {
    let copy_poly = |p: &ArchPoly| p.iter().map(|r| r.as_slice().to_vec()).collect::<Vec<_>>();
    let extra: Vec<_> = f.extra.iter().map(|p| copy_poly(p)).collect();
    PolygonGeometry {
        coordinates: copy_poly(&f.rings),
        extra_polygons: if extra.is_empty() { None } else { Some(extra) },
        properties: Some(serde_json::json!({ "name": f.name.as_str(), "code": f.code.as_str() })),
    }
}

// --- IPC commands ---

fn validate_border_level(level: &str) -> AppResult<()> {
    if !matches!(level, "light" | "medium" | "heavy" | "adm1") {
        return Err(AppError(format!("Invalid border level: {level}")));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn check_border_file(level: String) -> AppResult<bool> {
    if level == "light" {
        return Ok(true);
    }
    validate_border_level(&level)?;
    let path = crate::storage::app_data_dir()?
        .join("borders")
        .join(format!("borders-{level}.rkyv"));
    Ok(path.exists())
}

#[tauri::command]
#[specta::specta]
pub fn download_border_file(level: String) -> AppResult<()> {
    validate_border_level(&level)?;
    if level == "light" {
        return Ok(());
    }
    let dir = crate::storage::app_data_dir()?.join("borders");
    std::fs::create_dir_all(&dir)?;
    let url = format!(
        "https://raw.githubusercontent.com/ccmdi/mma/master/data/borders/borders-{level}.rkyv"
    );
    let client = reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(120))
        .build()?;
    let bytes = client
        .get(&url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Failed to download borders-{level}.rkyv: {e}"))?
        .bytes()?;
    std::fs::write(dir.join(format!("borders-{level}.rkyv")), &bytes)?;
    // Invalidate cache so next lookup reloads
    cache().lock().unwrap().remove(&level);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn border_lookup(lat: f64, lng: f64, level: String) -> AppResult<Option<PolygonGeometry>> {
    validate_border_level(&level)?;

    {
        let datasets = cache().lock().unwrap();
        if !datasets.contains_key(&level) {
            drop(datasets);
            load_dataset(&level)?;
        }
    }

    let datasets = cache().lock().unwrap();
    let ds = datasets.get(&level).unwrap();

    match ds {
        Dataset::Owned(features) => {
            for feature in features {
                if selections::point_in_geometry(lng, lat, &feature.geometry) {
                    let mut geom = feature.geometry.clone();
                    geom.properties = Some(serde_json::json!({
                        "name": feature.name,
                        "code": feature.code,
                    }));
                    return Ok(Some(geom));
                }
            }
        }
        Dataset::Mapped(mmap) => {
            for f in Dataset::archived(mmap).features.iter() {
                if arch_point_in_feature(lng, lat, f) {
                    return Ok(Some(arch_to_geometry(f)));
                }
            }
        }
    }

    Ok(None)
}

/// Ensure a dataset level is loaded into the in-memory cache.
fn ensure_loaded(level: &str) -> AppResult<()> {
    if cache().lock().unwrap().contains_key(level) {
        return Ok(());
    }
    load_dataset(level)
}

/// Classify each coordinate to its containing country (ISO-A2) via point-in-polygon
/// and tally into `(code, count)` pairs. Used by the distribution plugin -- true border
/// containment, unlike the nearest-city reverse geocoder. Falls back to the bundled
/// "light" dataset when the requested level isn't downloaded. Points outside every
/// border (oceans, gaps) are dropped. Each feature's bbox is a cheap broad-phase reject
/// before the full crossing test; the scan is parallelized over points with rayon.
pub fn tally_countries(level: &str, coords: &[(f64, f64)]) -> AppResult<Vec<(String, u32)>> {
    let level = if validate_border_level(level).is_ok() && ensure_loaded(level).is_ok() {
        level.to_string()
    } else {
        ensure_loaded("light")?;
        "light".to_string()
    };

    let datasets = cache().lock().unwrap();
    let ds = datasets.get(&level).unwrap();

    Ok(match ds {
        Dataset::Owned(features) => {
            let feats = features
                .iter()
                .filter_map(|f| selections::geometry_bbox(&f.geometry).map(|bb| (bb, f)))
                .collect();
            tally_scan(
                feats,
                coords,
                |lng, lat, f| selections::point_in_geometry(lng, lat, &f.geometry),
                |f| f.code.as_str(),
            )
        }
        Dataset::Mapped(mmap) => {
            let feats = Dataset::archived(mmap)
                .features
                .iter()
                .filter_map(|f| arch_feature_bbox(f).map(|bb| (bb, f)))
                .collect();
            tally_scan(
                feats,
                coords,
                |lng, lat, f| arch_point_in_feature(lng, lat, f),
                |f| f.code.as_str(),
            )
        }
    })
}

/// Bbox-prefiltered parallel point-in-polygon tally, generic over the feature backend
/// (owned `BorderFeature` or archived `ArchivedArchFeature`).
fn tally_scan<T: Sync>(
    feats: Vec<([f64; 4], &T)>,
    coords: &[(f64, f64)],
    contains: impl Fn(f64, f64, &T) -> bool + Sync,
    code: impl Fn(&T) -> &str + Sync,
) -> Vec<(String, u32)> {
    use rayon::prelude::*;
    coords
        .par_iter()
        .filter_map(|&(lat, lng)| {
            for (bb, f) in &feats {
                if !selections::in_bbox(lng, lat, bb) {
                    continue;
                }
                if contains(lng, lat, f) {
                    return Some(code(f).to_string());
                }
            }
            None
        })
        .fold(HashMap::new, |mut m: HashMap<String, u32>, c| {
            *m.entry(c).or_insert(0) += 1;
            m
        })
        .reduce(HashMap::new, |mut a, b| {
            for (k, v) in b {
                *a.entry(k).or_insert(0) += v;
            }
            a
        })
        .into_iter()
        .collect()
}

#[cfg(test)]
#[path = "borders.test.rs"]
mod tests;
