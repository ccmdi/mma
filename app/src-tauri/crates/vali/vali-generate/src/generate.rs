use crate::definition::Prepared;
use crate::distribution::{
    by_max_min_distance, densify_country, distribute_evenly,
    locations_by_coverage_density, max_count_goal_search, PreferenceSpec,
    ResolvedProbability,
};
use crate::filter::filter;
use crate::goals::{
    country_location_count_goal, goal_for_subdivision,
    subdivision_goal_from_custom_weights, subdivision_weights,
};
use crate::progress::{emit, CancelToken, Event, Progress};
use crate::store::{build_output, Group, MapOutput, StoreSummary};
use anyhow::{bail, Context};
use rayon::prelude::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use vali_core::{Location, LocationPreferenceFilterDef};
type WorkResult = Vec<Group>;
enum WorkKind {
    Subdivision { subdivision_code: String, file: PathBuf },
    Country { files: Vec<PathBuf> },
}
struct WorkItem {
    country_code: String,
    goal: i32,
    subdivisions: Vec<String>,
    kind: WorkKind,
}
pub fn generate(
    prepared: &Prepared,
    definition_path: &Path,
    deterministic: bool,
) -> anyhow::Result<StoreSummary> {
    generate_with_progress(prepared, definition_path, deterministic, None, None)
}
pub fn generate_with_progress(
    prepared: &Prepared,
    definition_path: &Path,
    deterministic: bool,
    progress: Option<Progress<'_>>,
    cancel: Option<&CancelToken>,
) -> anyhow::Result<StoreSummary> {
    let data_root = vali_data::paths::data_root()?;
    generate_output(prepared, &data_root, deterministic, progress, cancel)?
        .write(definition_path)
}
pub fn generate_output(
    prepared: &Prepared,
    data_root: &Path,
    deterministic: bool,
    progress: Option<Progress<'_>>,
    cancel: Option<&CancelToken>,
) -> anyhow::Result<MapOutput> {
    timing::reset();
    let mut work_items: Vec<WorkItem> = Vec::new();
    for cc in &prepared.country_codes {
        let weights = subdivision_weights(cc).expect("validated earlier");
        let available: Vec<&str> = weights
            .iter()
            .filter(|(_, w)| *w > 0)
            .map(|(code, _)| *code)
            .collect();
        let selected: Vec<String> = match (
            prepared.subdivision_inclusions.get(cc),
            prepared.subdivision_exclusions.get(cc),
        ) {
            (Some(inclusions), _) => {
                for sub in inclusions {
                    if !available.iter().any(|a| a == sub) {
                        bail!(
                            "subdivision inclusion '{sub}' for {cc} has no data (weight 0)."
                        );
                    }
                }
                inclusions.clone()
            }
            (None, Some(exclusions)) => {
                available
                    .iter()
                    .filter(|s| !exclusions.iter().any(|e| e == *s))
                    .map(|s| s.to_string())
                    .collect()
            }
            (None, None) => available.iter().map(|s| s.to_string()).collect(),
        };
        let files: Vec<PathBuf> = selected
            .iter()
            .map(|sub| vali_data::paths::subdivision_file(data_root, cc, sub))
            .collect();
        if let Some(c) = cancel {
            c.check()?;
        }
        crate::download::ensure_files_downloaded(
            data_root,
            cc,
            &files,
            progress,
            cancel,
        )?;
        for file in &files {
            if !file.exists() {
                bail!(
                    "missing data file {} - run 'vali download --country {}' first.",
                    file.display(), cc
                );
            }
        }
        let goal = country_location_count_goal(
            &prepared.country_distribution,
            prepared.location_count_goal,
            cc,
        );
        let treat_as_single = prepared
            .treat_countries_as_single_subdivision
            .iter()
            .any(|c| c == cc);
        let per_subdivision = matches!(
            prepared.strategy_key.as_str(), "FixedCountByMaxMinDistance" |
            "FixedCountByCoverageDensity"
        ) && !treat_as_single;
        if per_subdivision {
            for (sub, file) in selected.iter().zip(&files) {
                work_items
                    .push(WorkItem {
                        country_code: cc.clone(),
                        goal,
                        subdivisions: selected.clone(),
                        kind: WorkKind::Subdivision {
                            subdivision_code: sub.clone(),
                            file: file.clone(),
                        },
                    });
            }
        } else {
            work_items
                .push(WorkItem {
                    country_code: cc.clone(),
                    goal,
                    subdivisions: selected.clone(),
                    kind: WorkKind::Country { files },
                });
        }
    }
    emit(
        progress,
        Event::WorkItems {
            total: work_items.len(),
        },
    );
    let done = AtomicUsize::new(0);
    let results: Vec<WorkResult> = work_items
        .par_iter()
        .map(|item| {
            if let Some(c) = cancel {
                c.check()?;
            }
            let r = run_work_item(prepared, item, deterministic);
            emit(
                progress,
                Event::WorkItemDone {
                    country_code: item.country_code.clone(),
                    subdivision_code: match &item.kind {
                        WorkKind::Subdivision { subdivision_code, .. } => {
                            Some(subdivision_code.clone())
                        }
                        WorkKind::Country { .. } => None,
                    },
                    done: done.fetch_add(1, Ordering::Relaxed) + 1,
                    total: work_items.len(),
                },
            );
            r
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let groups: Vec<Group> = results
        .into_iter()
        .flatten()
        .collect();
    let t = std::time::Instant::now();
    let output = build_output(prepared, &groups, deterministic);
    timing::add("store", t.elapsed());
    timing::report();
    Ok(output)
}
pub mod timing {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;
    static DECODE: AtomicU64 = AtomicU64::new(0);
    static FILTER: AtomicU64 = AtomicU64::new(0);
    static DISTRIBUTE: AtomicU64 = AtomicU64::new(0);
    static STORE: AtomicU64 = AtomicU64::new(0);
    fn slot(name: &str) -> &'static AtomicU64 {
        match name {
            "decode" => &DECODE,
            "filter" => &FILTER,
            "distribute" => &DISTRIBUTE,
            "store" => &STORE,
            _ => unreachable!(),
        }
    }
    pub fn reset() {
        for s in [&DECODE, &FILTER, &DISTRIBUTE, &STORE] {
            s.store(0, Ordering::Relaxed);
        }
    }
    pub fn add(name: &str, d: Duration) {
        slot(name).fetch_add(d.as_nanos() as u64, Ordering::Relaxed);
    }
    pub fn report() {
        if std::env::var_os("VALI_TIMING").is_none() {
            return;
        }
        for (name, s) in [
            ("decode", &DECODE),
            ("filter", &FILTER),
            ("distribute", &DISTRIBUTE),
            ("store", &STORE),
        ] {
            eprintln!(
                "[timing] {name:<10} {:>8.2?} (cpu, summed across threads)",
                Duration::from_nanos(s.load(Ordering::Relaxed))
            );
        }
    }
}
fn build_proximity(
    def: &vali_core::ProximityFilterDef,
) -> anyhow::Result<Option<crate::proximity::ProximityIndex>> {
    let path = std::path::Path::new(&def.locations_path);
    if def.radius > 0 && path.exists() {
        let points = crate::proximity::read_locations_lat_lng(path)
            .with_context(|| format!("read proximity locations {}", path.display()))?;
        Ok(Some(crate::proximity::ProximityIndex::build(points, def.radius)))
    } else {
        Ok(None)
    }
}
struct WorkContext<'a> {
    merged: Option<String>,
    proximity: Option<crate::proximity::ProximityIndex>,
    geometry: Option<crate::geometry::GeometryContext>,
    preference_defs: &'a [LocationPreferenceFilterDef],
    pref_proximities: Vec<Option<crate::proximity::ProximityIndex>>,
    pref_geometries: Vec<Option<crate::geometry::GeometryContext>>,
    map_neighbor_specs: Vec<crate::neighbor::NeighborFilterSpec>,
    probability: ResolvedProbability,
}
impl WorkContext<'_> {
    fn preference_specs(&self) -> Vec<PreferenceSpec<'_>> {
        self.preference_defs
            .iter()
            .zip(&self.pref_proximities)
            .zip(&self.pref_geometries)
            .map(|((p, prox), geom)| PreferenceSpec {
                expression: &p.expression,
                percentage: p.percentage,
                fill: p.fill,
                location_tag: p.location_tag.as_deref(),
                min_min_distance: p.min_min_distance,
                proximity: prox.as_ref(),
                geometry: geom.as_ref(),
                neighbor_specs: p
                    .neighbor_filters
                    .iter()
                    .map(crate::neighbor::NeighborFilterSpec::from_def)
                    .collect(),
            })
            .collect()
    }
}
fn resolve_context<'a>(
    prepared: &'a Prepared,
    country_code: &str,
    subdivision: &str,
) -> anyhow::Result<WorkContext<'a>> {
    let merged = crate::distribution::merge_location_filters(
        &[
            Some(prepared.global_location_filter.as_str()),
            prepared.country_location_filters.get(country_code).map(String::as_str),
            prepared
                .subdivision_location_filters
                .get(country_code)
                .and_then(|subs| subs.get(subdivision))
                .map(String::as_str),
        ],
    );
    let proximity_def = prepared
        .subdivision_proximity_filters
        .get(country_code)
        .and_then(|m| m.get(subdivision))
        .or_else(|| prepared.country_proximity_filters.get(country_code))
        .unwrap_or(&prepared.proximity_filter);
    let proximity = build_proximity(proximity_def)?;
    let geometry_filters = prepared
        .subdivision_geometry_filters
        .get(country_code)
        .and_then(|m| m.get(subdivision))
        .or_else(|| prepared.country_geometry_filters.get(country_code))
        .unwrap_or(&prepared.geometry_filters);
    let geometry = crate::geometry::build_context(geometry_filters)
        .map_err(|e| anyhow::anyhow!(e))?;
    let preference_defs = prepared
        .subdivision_location_preference_filters
        .get(country_code)
        .and_then(|m| m.get(subdivision))
        .or_else(|| prepared.country_location_preference_filters.get(country_code))
        .unwrap_or(&prepared.global_location_preference_filters);
    let pref_proximities: Vec<Option<crate::proximity::ProximityIndex>> = preference_defs
        .iter()
        .map(|p| build_proximity(&p.proximity_filter))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let pref_geometries: Vec<Option<crate::geometry::GeometryContext>> = preference_defs
        .iter()
        .map(|p| {
            crate::geometry::build_context(
                    &crate::geometry::prepare_list(&p.geometry_filters),
                )
                .map_err(|e| anyhow::anyhow!(e))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let map_neighbor_specs: Vec<crate::neighbor::NeighborFilterSpec> = prepared
        .neighbor_filters
        .iter()
        .map(crate::neighbor::NeighborFilterSpec::from_def)
        .collect();
    let probability_def = prepared
        .subdivision_location_probabilities
        .get(country_code)
        .and_then(|m| m.get(subdivision))
        .or_else(|| prepared.country_location_probabilities.get(country_code))
        .unwrap_or(&prepared.global_location_probability);
    let probability = ResolvedProbability::from_def(probability_def);
    Ok(WorkContext {
        merged,
        proximity,
        geometry,
        preference_defs,
        pref_proximities,
        pref_geometries,
        map_neighbor_specs,
        probability,
    })
}
fn run_work_item(
    prepared: &Prepared,
    item: &WorkItem,
    deterministic: bool,
) -> anyhow::Result<WorkResult> {
    match &item.kind {
        WorkKind::Subdivision { subdivision_code, file } => {
            run_subdivision_item(prepared, item, subdivision_code, file, deterministic)
        }
        WorkKind::Country { files } => {
            match prepared.strategy_key.as_str() {
                "FixedCountByMaxMinDistance" | "FixedCountByCoverageDensity" => {
                    run_country_single(prepared, item, files, deterministic)
                }
                "MaxCountByFixedMinDistance" => {
                    run_max_count(prepared, item, files, deterministic)
                }
                "EvenlyByDistanceWithinCountry" => {
                    run_evenly(prepared, item, files, deterministic)
                }
                other => bail!("unhandled strategy {other}"),
            }
        }
    }
}
fn run_subdivision_item(
    prepared: &Prepared,
    item: &WorkItem,
    subdivision_code: &str,
    file: &Path,
    deterministic: bool,
) -> anyhow::Result<WorkResult> {
    let _ = subdivision_code;
    let locations = decode(file)?;
    let subdivision = locations
        .first()
        .map(|l| l.nominatim.subdivision_code.as_str())
        .unwrap_or("");
    if !item.subdivisions.iter().any(|s| s == subdivision) {
        return Ok(vec![(Vec::new(), 0, 0)]);
    }
    let ctx = resolve_context(prepared, &item.country_code, subdivision)?;
    let neighbor_context = prepared
        .neighbor_bucket_precision
        .map(|precision| crate::neighbor::NeighborContext::build(&locations, precision));
    let filtered = filter_with_context(
        &locations,
        &ctx,
        neighbor_context.as_ref(),
        prepared,
        deterministic,
        file,
    )?;
    let available: Vec<&str> = item.subdivisions.iter().map(String::as_str).collect();
    let region_goal_count = match prepared
        .subdivision_distribution
        .get(&item.country_code)
    {
        Some(weights) => {
            subdivision_goal_from_custom_weights(weights, subdivision, item.goal)
        }
        None => {
            goal_for_subdivision(
                &item.country_code,
                subdivision,
                item.goal,
                Some(&available),
            )
        }
    };
    if region_goal_count == 0 {
        return Ok(vec![(Vec::new(), 0, 0)]);
    }
    if filtered.is_empty() {
        return Ok(vec![(Vec::new(), region_goal_count, 0)]);
    }
    let prefs = ctx.preference_specs();
    let t = std::time::Instant::now();
    let (indices, tags, min_distance) = match prepared.strategy_key.as_str() {
        "FixedCountByCoverageDensity" => {
            locations_by_coverage_density(
                &locations,
                &filtered,
                region_goal_count,
                prepared.coverage_density_tuning_factor,
                neighbor_context.as_ref(),
                &ctx.map_neighbor_specs,
                &prefs,
                &ctx.probability,
                prepared.enable_default_location_filters,
                prepared.min_min_distance,
                deterministic,
            )
        }
        _ => {
            by_max_min_distance(
                &locations,
                filtered,
                region_goal_count,
                neighbor_context.as_ref(),
                &ctx.map_neighbor_specs,
                &prefs,
                &ctx.probability,
                prepared.enable_default_location_filters,
                prepared.min_min_distance,
                deterministic,
            )
        }
    }
        .map_err(|e| anyhow::anyhow!("{}: {e}", file.display()))?;
    timing::add("distribute", t.elapsed());
    Ok(vec![(collect(& locations, & indices, & tags), region_goal_count, min_distance)])
}
fn run_country_single(
    prepared: &Prepared,
    item: &WorkItem,
    files: &[PathBuf],
    deterministic: bool,
) -> anyhow::Result<WorkResult> {
    let mut locations: Vec<Location> = Vec::new();
    for file in files {
        locations.extend(decode(file)?);
    }
    if locations.is_empty() || item.goal == 0 {
        return Ok(vec![(Vec::new(), 0, 0)]);
    }
    let ctx = resolve_context(prepared, &item.country_code, "")?;
    let neighbor_context = prepared
        .neighbor_bucket_precision
        .map(|precision| crate::neighbor::NeighborContext::build(&locations, precision));
    let filtered = filter_with_context(
        &locations,
        &ctx,
        neighbor_context.as_ref(),
        prepared,
        deterministic,
        Path::new(&item.country_code),
    )?;
    if filtered.is_empty() {
        return Ok(vec![(Vec::new(), item.goal, 0)]);
    }
    let densified = densify_country(
        &locations,
        &filtered,
        files.len(),
        prepared.min_min_distance,
        &ctx.probability,
        deterministic,
    );
    let prefs = ctx.preference_specs();
    let (indices, tags, min_distance) = match prepared.strategy_key.as_str() {
        "FixedCountByCoverageDensity" => {
            locations_by_coverage_density(
                &locations,
                &densified,
                item.goal,
                prepared.coverage_density_tuning_factor,
                neighbor_context.as_ref(),
                &ctx.map_neighbor_specs,
                &prefs,
                &ctx.probability,
                prepared.enable_default_location_filters,
                prepared.min_min_distance,
                deterministic,
            )
        }
        _ => {
            by_max_min_distance(
                &locations,
                densified,
                item.goal,
                neighbor_context.as_ref(),
                &ctx.map_neighbor_specs,
                &prefs,
                &ctx.probability,
                prepared.enable_default_location_filters,
                prepared.min_min_distance,
                deterministic,
            )
        }
    }
        .map_err(|e| anyhow::anyhow!("{}: {e}", item.country_code))?;
    Ok(vec![(collect(& locations, & indices, & tags), item.goal, min_distance)])
}
fn run_max_count(
    prepared: &Prepared,
    item: &WorkItem,
    files: &[PathBuf],
    deterministic: bool,
) -> anyhow::Result<WorkResult> {
    struct SubData<'a> {
        subdivision: String,
        locations: Vec<Location>,
        filtered: Vec<u32>,
        ctx: WorkContext<'a>,
        neighbors: Option<crate::neighbor::NeighborContext>,
    }
    let mut subs: Vec<SubData> = Vec::new();
    for file in files {
        let locations = decode(file)?;
        let subdivision = locations
            .first()
            .map(|l| l.nominatim.subdivision_code.to_string())
            .unwrap_or_default();
        if subdivision.is_empty() {
            continue;
        }
        let ctx = resolve_context(prepared, &item.country_code, &subdivision)?;
        let neighbors = prepared
            .neighbor_bucket_precision
            .map(|precision| crate::neighbor::NeighborContext::build(
                &locations,
                precision,
            ));
        let filtered = if item.subdivisions.iter().any(|s| s == &subdivision) {
            filter_with_context(
                &locations,
                &ctx,
                neighbors.as_ref(),
                prepared,
                deterministic,
                file,
            )?
        } else {
            Vec::new()
        };
        subs.push(SubData {
            subdivision,
            locations,
            filtered,
            ctx,
            neighbors,
        });
    }
    let available: Vec<&str> = item.subdivisions.iter().map(String::as_str).collect();
    let custom = prepared.subdivision_distribution.get(&item.country_code);
    let country_probability = resolve_probability(prepared, &item.country_code, "");
    let search_input: Vec<(&str, &[Location], Vec<u32>)> = subs
        .iter()
        .map(|s| (s.subdivision.as_str(), s.locations.as_slice(), s.filtered.clone()))
        .collect();
    let goals = max_count_goal_search(
        &search_input,
        &item.country_code,
        custom.map(Vec::as_slice),
        &available,
        prepared.fixed_min_distance,
        &country_probability,
        deterministic,
    );
    let mut results: WorkResult = Vec::new();
    for (s, goal) in subs.iter().zip(&goals) {
        let prefs = s.ctx.preference_specs();
        let (indices, tags, _) = by_max_min_distance(
                &s.locations,
                s.filtered.clone(),
                *goal,
                s.neighbors.as_ref(),
                &s.ctx.map_neighbor_specs,
                &prefs,
                &s.ctx.probability,
                prepared.enable_default_location_filters,
                *goal,
                deterministic,
            )
            .map_err(|e| anyhow::anyhow!("{}: {e}", s.subdivision))?;
        results
            .push((
                collect(&s.locations, &indices, &tags),
                *goal,
                prepared.fixed_min_distance,
            ));
    }
    Ok(results)
}
fn run_evenly(
    prepared: &Prepared,
    item: &WorkItem,
    files: &[PathBuf],
    deterministic: bool,
) -> anyhow::Result<WorkResult> {
    let mut combined: Vec<Location> = Vec::new();
    for file in files {
        let locations = decode(file)?;
        let subdivision = locations
            .first()
            .map(|l| l.nominatim.subdivision_code.to_string())
            .unwrap_or_default();
        if subdivision.is_empty() {
            continue;
        }
        if !item.subdivisions.iter().any(|s| s == &subdivision) {
            continue;
        }
        let ctx = resolve_context(prepared, &item.country_code, &subdivision)?;
        let neighbors = prepared
            .neighbor_bucket_precision
            .map(|precision| crate::neighbor::NeighborContext::build(
                &locations,
                precision,
            ));
        let filtered = filter_with_context(
            &locations,
            &ctx,
            neighbors.as_ref(),
            prepared,
            deterministic,
            file,
        )?;
        combined.extend(filtered.iter().map(|&i| locations[i as usize].clone()));
    }
    let all: Vec<u32> = (0..combined.len() as u32).collect();
    let country_probability = resolve_probability(prepared, &item.country_code, "");
    let selected = distribute_evenly(
        &combined,
        &all,
        prepared.fixed_min_distance,
        &country_probability,
        deterministic,
    );
    let tags = vec![None; selected.len()];
    Ok(vec![(collect(& combined, & selected, & tags), - 1, prepared.fixed_min_distance)])
}
fn resolve_probability(
    prepared: &Prepared,
    country_code: &str,
    subdivision: &str,
) -> ResolvedProbability {
    let def = prepared
        .subdivision_location_probabilities
        .get(country_code)
        .and_then(|m| m.get(subdivision))
        .or_else(|| prepared.country_location_probabilities.get(country_code))
        .unwrap_or(&prepared.global_location_probability);
    ResolvedProbability::from_def(def)
}
fn decode(file: &Path) -> anyhow::Result<Vec<Location>> {
    let t = std::time::Instant::now();
    let r = vali_data::decode_file(file)
        .with_context(|| format!("decode {}", file.display()));
    timing::add("decode", t.elapsed());
    r
}
fn filter_with_context(
    locations: &[Location],
    ctx: &WorkContext<'_>,
    neighbors: Option<&crate::neighbor::NeighborContext>,
    prepared: &Prepared,
    deterministic: bool,
    label: &Path,
) -> anyhow::Result<Vec<u32>> {
    let spec_refs: Vec<&crate::neighbor::NeighborFilterSpec> = ctx
        .map_neighbor_specs
        .iter()
        .collect();
    let t = std::time::Instant::now();
    let r = filter(
            locations,
            ctx.merged.as_deref(),
            ctx.proximity.as_ref(),
            ctx.geometry.as_ref(),
            neighbors.map(|n| (n, spec_refs.as_slice())),
            prepared.enable_default_location_filters,
            deterministic,
        )
        .map_err(|e| anyhow::anyhow!("{}: {e}", label.display()));
    timing::add("filter", t.elapsed());
    r
}
fn collect(
    locations: &[Location],
    indices: &[u32],
    tags: &[Option<String>],
) -> Vec<(Location, Option<String>)> {
    indices
        .iter()
        .zip(tags)
        .map(|(&i, tag)| (locations[i as usize].clone(), tag.clone()))
        .collect()
}
