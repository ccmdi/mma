use crate::definition::Prepared;
use crate::goals::country_location_count_goal;
use crate::tags::tags;
use rustc_hash::{FxHashMap, FxHashSet};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use vali_core::{GoogleData, Location, NominatimData, OsmData};
use vali_expr::CompiledInt;

/// One generated group: its locations paired with their tags, the region goal, and
/// the min distance achieved.
pub type Group = (Vec<(Location, Option<String>)>, i32, i32);
#[derive(Serialize, Clone)]
pub struct GeoMapLocation {
    pub lat: f64,
    pub lng: f64,
    pub heading: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<GeoMapLocationExtra>,
    #[serde(rename = "panoId", skip_serializing_if = "Option::is_none")]
    pub pano_id: Option<String>,
}
#[derive(Serialize, Clone)]
pub struct GeoMapLocationExtra {
    pub tags: Vec<String>,
}
pub struct StoreSummary {
    pub locations_path: PathBuf,
    pub location_count: usize,
}
pub struct MapOutput {
    pub records: Vec<GeoMapLocation>,
    country_distribution: Option<String>,
    subdivision_distribution: String,
}
pub fn store_map(
    prepared: &Prepared,
    groups: &[Group],
    definition_path: &Path,
    deterministic: bool,
) -> anyhow::Result<StoreSummary> {
    build_output(prepared, groups, deterministic).write(definition_path)
}
pub fn build_output(
    prepared: &Prepared,
    groups: &[Group],
    deterministic: bool,
) -> MapOutput {
    let mut seen: FxHashSet<i64> = FxHashSet::default();
    let mut locations: Vec<(&Location, Option<&str>)> = Vec::new();
    for (group, _, _) in groups {
        for (loc, tag) in group {
            if seen.insert(loc.node_id) {
                locations.push((loc, tag.as_deref()));
            }
        }
    }
    if deterministic {
        locations.sort_by_key(|(l, _)| l.node_id);
    } else {
        fastrand::shuffle(&mut locations);
    }
    let global_heading: Option<CompiledInt> = prepared
        .global_heading_expression
        .as_deref()
        .filter(|e| !e.is_empty())
        .map(|e| vali_expr::compile_int(e).expect("validated earlier"));
    let country_heading: FxHashMap<&str, CompiledInt> = prepared
        .country_heading_expressions
        .iter()
        .map(|(cc, e)| (
            cc.as_str(),
            vali_expr::compile_int(e).expect("validated earlier"),
        ))
        .collect();
    let records: Vec<GeoMapLocation> = locations
        .iter()
        .map(|&(l, tag)| {
            let heading_int = l.google.default_heading.round_ties_even() as i32;
            let heading_value = match country_heading
                .get(l.nominatim.country_code.as_str())
            {
                Some(compiled) => eval_heading(compiled, l, heading_int),
                None => {
                    match &global_heading {
                        Some(compiled) => eval_heading(compiled, l, heading_int),
                        None => heading_int,
                    }
                }
            };
            let pano = prepared
                .pano_id_country_codes
                .iter()
                .any(|c| c == l.nominatim.country_code)
                || prepared.pano_id_country_codes.iter().any(|c| c == "*");
            GeoMapLocation {
                lat: l.google.lat,
                lng: l.google.lng,
                heading: (heading_value as f64) % 360.0,
                zoom: prepared.global_zoom,
                pitch: prepared.global_pitch,
                extra: tags(l, heading_int, &prepared.location_tags, tag)
                    .map(|t| GeoMapLocationExtra { tags: t }),
                pano_id: pano.then(|| l.google.pano_id.to_string()),
            }
        })
        .collect();
    let mut country_counts: BTreeMap<&str, usize> = BTreeMap::new();
    for (l, _) in &locations {
        *country_counts.entry(l.nominatim.country_code.as_str()).or_default() += 1;
    }
    let country_distribution = (country_counts.len() > 1)
        .then(|| {
            let lines: Vec<String> = country_counts
                .iter()
                .map(|(cc, count)| {
                    let goal = country_location_count_goal(
                        &prepared.country_distribution,
                        prepared.location_count_goal,
                        cc,
                    );
                    format!("{cc}\t{count}\t{goal}")
                })
                .collect();
            lines.join("\n") + "\n"
        });
    let mut regional: FxHashMap<&str, (i32, i32)> = FxHashMap::default();
    for (group, goal, min_distance) in groups {
        if let Some((first, _)) = group.first() {
            regional
                .insert(
                    first.nominatim.subdivision_code.as_str(),
                    (*goal, *min_distance),
                );
        }
    }
    let mut subdivision_counts: BTreeMap<&str, usize> = BTreeMap::new();
    for (l, _) in &locations {
        let sub = l.nominatim.subdivision_code.as_str();
        if !sub.is_empty() {
            *subdivision_counts.entry(sub).or_default() += 1;
        }
    }
    let lines: Vec<String> = subdivision_counts
        .iter()
        .map(|(sub, count)| {
            let (goal, min_distance) = regional.get(sub).copied().unwrap_or((0, 0));
            format!("{sub}\t{count}\t{goal}\t{min_distance}m.")
        })
        .collect();
    MapOutput {
        records,
        country_distribution,
        subdivision_distribution: lines.join("\n") + "\n",
    }
}
impl MapOutput {
    pub fn write(&self, definition_path: &Path) -> anyhow::Result<StoreSummary> {
        let out_folder = definition_path.parent().unwrap_or_else(|| Path::new("."));
        let stem = definition_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "map".to_string());
        let locations_path = out_folder.join(format!("{stem}-locations.json"));
        std::fs::write(&locations_path, serde_json::to_string(&self.records)?)?;
        if let Some(country) = &self.country_distribution {
            std::fs::write(
                out_folder.join(format!("{stem}-country-distribution.txt")),
                country,
            )?;
        }
        std::fs::write(
            out_folder.join(format!("{stem}-subdivision-distribution.txt")),
            &self.subdivision_distribution,
        )?;
        Ok(StoreSummary {
            locations_path,
            location_count: self.records.len(),
        })
    }
}
fn eval_heading(compiled: &CompiledInt, l: &Location, heading_int: i32) -> i32 {
    let synthetic = Location {
        node_id: 0,
        lat: 0.0,
        lng: 0.0,
        google: GoogleData {
            country_code: l.nominatim.country_code.clone(),
            default_heading: heading_int as f64,
            driving_direction_angle: l.google.driving_direction_angle,
            ..Default::default()
        },
        osm: OsmData::default(),
        nominatim: NominatimData {
            country_code: l.nominatim.country_code.clone(),
            subdivision_code: l.nominatim.subdivision_code.clone(),
            county: None,
        },
    };
    compiled.eval(&synthetic)
}
