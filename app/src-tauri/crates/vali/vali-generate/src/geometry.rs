use mma_geo::{anchor_bbox, extend_bbox_with_ring, in_bbox, polygon_contains};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use vali_core::GeometryFilterDef;

/// One polygon in GeoJSON ring order: outer ring first, then holes; vertices are [lng, lat].
pub type PolygonRings = Vec<Vec<[f64; 2]>>;

pub const EUROPEAN_TURKEY: &str = include_str!("../resources/regions/european-turkey.geojson");
pub const EUROPEAN_RUSSIA: &str = include_str!("../resources/regions/european-russia.geojson");
pub const EUROPEAN_KAZAKHSTAN: &str =
    include_str!("../resources/regions/european-kazakhstan.geojson");
pub const AFRICAN_SPAIN: &str = include_str!("../resources/regions/african-spain.geojson");
pub const HAWAII: &str = include_str!("../resources/regions/hawaii.geojson");
#[derive(Debug, Clone)]
pub enum GeometrySource {
    File(String),
    Preloaded(&'static str),
}
#[derive(Debug, Clone)]
pub struct PreparedGeometryFilter {
    pub locations_inside: bool,
    pub combination_mode: String,
    pub source: GeometrySource,
}
impl PreparedGeometryFilter {
    pub fn from_def(def: &GeometryFilterDef, combination_mode: &str) -> PreparedGeometryFilter {
        PreparedGeometryFilter {
            locations_inside: def.locations_inside(),
            combination_mode: combination_mode.to_string(),
            source: GeometrySource::File(def.file_path.clone()),
        }
    }
}
pub fn normalized_combination_mode(defs: &[GeometryFilterDef]) -> String {
    match defs.first() {
        Some(f) if !f.combination_mode.is_empty() => f.combination_mode.clone(),
        _ => "intersection".to_string(),
    }
}
pub fn prepare_list(defs: &[GeometryFilterDef]) -> Vec<PreparedGeometryFilter> {
    let mode = normalized_combination_mode(defs);
    defs.iter()
        .map(|d| PreparedGeometryFilter::from_def(d, &mode))
        .collect()
}
pub fn geometries_from_file(path: &str) -> Vec<PolygonRings> {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<PolygonRings>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Mutex::default);
    if let Some(cached) = cache.lock().unwrap().get(path) {
        return cached.clone();
    }
    let parsed = std::fs::read_to_string(path)
        .map_err(|e| e.to_string())
        .and_then(|text| parse_geojson(text.trim_start_matches('\u{feff}')))
        .unwrap_or_else(|_| {
            eprintln!(
                "Invalid GeoJSON in file {path}, ignoring file. Try checking using https://geojsonlint.com/."
            );
            Vec::new()
        });
    cache
        .lock()
        .unwrap()
        .insert(path.to_string(), parsed.clone());
    parsed
}
pub fn applicable(
    filters: &[PreparedGeometryFilter],
) -> Vec<(&PreparedGeometryFilter, Vec<PolygonRings>)> {
    filters
        .iter()
        .map(|f| {
            let geometries = match &f.source {
                GeometrySource::Preloaded(text) => {
                    parse_geojson(text).expect("embedded regions are valid")
                }
                GeometrySource::File(path) if Path::new(path).exists() => {
                    geometries_from_file(path)
                }
                GeometrySource::File(_) => Vec::new(),
            };
            (f, geometries)
        })
        .filter(|(_, g)| !g.is_empty())
        .collect()
}
pub fn build_context(
    filters: &[PreparedGeometryFilter],
) -> Result<Option<GeometryContext>, String> {
    let applicable = applicable(filters);
    let Some((first, _)) = applicable.first() else {
        return Ok(None);
    };
    let mode = first.combination_mode.clone();
    let evaluated = applicable
        .into_iter()
        .map(|(f, g)| (f.locations_inside, g))
        .collect();
    GeometryContext::build(&mode, evaluated).map(Some)
}
pub fn parse_geojson(text: &str) -> Result<Vec<PolygonRings>, String> {
    let parsed: geojson::GeoJson = text.parse().map_err(|e| format!("invalid GeoJSON: {e}"))?;
    match parsed {
        geojson::GeoJson::Geometry(g) => geometry_polygons(g),
        geojson::GeoJson::Feature(f) => {
            let g = f.geometry.ok_or("GeoJSON feature has no geometry")?;
            geometry_polygons(g)
        }
        geojson::GeoJson::FeatureCollection(fc) => {
            let mut out = Vec::new();
            for f in fc.features {
                let g = f.geometry.ok_or("GeoJSON feature has no geometry")?;
                out.extend(geometry_polygons(g)?);
            }
            Ok(out)
        }
    }
}
fn geometry_polygons(g: geojson::Geometry) -> Result<Vec<PolygonRings>, String> {
    let rings = |poly: Vec<Vec<Vec<f64>>>| -> PolygonRings {
        poly.into_iter()
            .map(|ring| ring.into_iter().map(|pos| [pos[0], pos[1]]).collect())
            .collect()
    };
    match g.value {
        geojson::Value::Polygon(p) => Ok(vec![rings(p)]),
        geojson::Value::MultiPolygon(mp) => Ok(mp.into_iter().map(rings).collect()),
        geojson::Value::GeometryCollection(gs) => {
            let mut out = Vec::new();
            for g in gs {
                out.extend(geometry_polygons(g)?);
            }
            Ok(out)
        }
        other => Err(format!(
            "unsupported GeoJSON geometry: {}",
            other.type_name()
        )),
    }
}
struct EvaluatedFilter {
    locations_inside: bool,
    geometries: Vec<PolygonRings>,
}
pub struct GeometryContext {
    union: bool,
    filters: Vec<EvaluatedFilter>,
    envelope: Option<[f64; 4]>,
}
impl GeometryContext {
    pub fn build(
        combination_mode: &str,
        filters: Vec<(bool, Vec<PolygonRings>)>,
    ) -> Result<GeometryContext, String> {
        let union = match combination_mode {
            "union" => true,
            "intersection" => false,
            other => {
                return Err(format!(
                    "Only union/intersection acceptable values, got '{other}'."
                ));
            }
        };
        let mut bb = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        let mut any = false;
        for (_, geometries) in &filters {
            for poly in geometries {
                for ring in poly {
                    extend_bbox_with_ring(&mut bb, &mut any, ring);
                }
            }
        }
        let envelope = any.then(|| {
            anchor_bbox(&mut bb);
            bb
        });
        Ok(GeometryContext {
            union,
            filters: filters
                .into_iter()
                .map(|(locations_inside, geometries)| EvaluatedFilter {
                    locations_inside,
                    geometries,
                })
                .collect(),
            envelope,
        })
    }
    pub fn matches(&self, lat: f64, lng: f64) -> bool {
        let in_envelope = self.envelope.is_some_and(|e| in_bbox(lng, lat, &e));
        if !in_envelope {
            return if self.union {
                self.filters.iter().any(|f| !f.locations_inside)
            } else {
                self.filters.iter().all(|f| !f.locations_inside)
            };
        }
        let covered = |f: &EvaluatedFilter| {
            f.geometries
                .iter()
                .any(|poly| polygon_contains(lng, lat, poly.iter().map(|r| r.as_slice())))
                == f.locations_inside
        };
        if self.union {
            self.filters.iter().any(covered)
        } else {
            self.filters.iter().all(covered)
        }
    }
}
