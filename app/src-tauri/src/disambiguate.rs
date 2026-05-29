//! Selection disambiguation: given N groups of locations, rank metadata fields by
//! how strongly they *separate* the groups (not by which value is most common).
//!
//! Each field gets a value-divergence score in [0,1] chosen by its comparison type:
//! - **Linear** numeric -> epsilon-squared from the Kruskal-Wallis H statistic
//!   (rank-based, robust to skew/scale).
//! - **Circular** -> one-way circular ANOVA decomposition (handles wrap-around;
//!   350 deg and 10 deg are close).
//! - **Categorical** (incl. tags as booleans) -> bias-corrected Cramer's V.
//!
//! Missing values are excluded from the value math (never treated as zero); a field's
//! *presence* asymmetry across groups is reported separately as a coverage score.

use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;

use serde::Serialize;

use crate::location_store::{SelectionInput, StoreState};
use crate::map_meta::{infer_field_type, known_field_def, resolved_comparison, ComparisonType, ExtraFieldDef, ExtraFieldType};
use crate::selections::resolve_bitmask;
use crate::types::Location;
use crate::util::iso_to_unix;

#[cfg(test)]
#[path = "disambiguate.test.rs"]
mod tests;

/// A group must have at least this many present values for a field before its
/// value score is trusted; below this the field is flagged low-confidence.
const MIN_PRESENT: u32 = 8;
/// How many top categories to surface per group in a categorical summary.
const TOP_N: usize = 3;
/// Fields excluded from analysis: they encode the location/answer itself rather than
/// an in-round visual tell, so flagging them as "divergent" is pointless.
const EXCLUDED_FIELDS: &[&str] = &["countryCode", "timezone"];

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DisambiguateResult {
    /// Fields ranked by divergence (most separating first).
    pub fields: Vec<FieldDivergence>,
    /// Locations dropped because they belonged to more than one group.
    pub excluded_overlap: u32,
    /// Per-group labeled location count (after overlap removal), input order.
    pub group_sizes: Vec<u32>,
}

/// How the numeric per-group summaries should be rendered. Numeric fields are
/// compared as plain numbers internally even when they're dates, so the UI needs
/// this to turn a month-index or unix timestamp back into a readable value.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ValueFormat {
    Number,
    Month,
    DateTime,
}

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldDivergence {
    pub key: String,
    pub label: String,
    pub comparison: ComparisonType,
    pub format: ValueFormat,
    /// How strongly the field's values separate the groups, [0,1]. `None` when
    /// fewer than two groups have any present values.
    pub value_score: Option<f64>,
    /// How strongly field *presence* (vs absence) separates the groups, [0,1].
    pub coverage_score: f64,
    /// True when at least one group has too few present values to trust `value_score`.
    pub low_confidence: bool,
    /// Per-group summaries, in input group order.
    pub groups: Vec<GroupSummary>,
}

/// Per-group summary for one field. Which fields are populated depends on the
/// field's `comparison` type (the UI reads the relevant ones).
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GroupSummary {
    pub n: u32,
    pub present: u32,
    // Linear numeric
    pub median: Option<f64>,
    pub p25: Option<f64>,
    pub p75: Option<f64>,
    // Circular
    pub mean_deg: Option<f64>,
    pub concentration: Option<f64>,
    // Categorical
    pub top: Vec<TopValue>,
}

impl GroupSummary {
    fn empty(n: u32, present: u32) -> Self {
        GroupSummary { n, present, median: None, p25: None, p75: None, mean_deg: None, concentration: None, top: Vec::new() }
    }
}

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TopValue {
    pub label: String,
    pub freq: f64,
}

/// Resolve N selections to labeled location groups and rank metadata fields by how
/// strongly they separate the groups. Locations matched by more than one selection
/// are dropped (ambiguous label) and counted in `excluded_overlap`. Errors with
/// fewer than two selections.
#[tauri::command]
#[specta::specta]
pub async fn store_disambiguate(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    groups: Vec<SelectionInput>,
    field_defs: HashMap<String, ExtraFieldDef>,
) -> Result<DisambiguateResult, String> {
    if groups.len() < 2 {
        return Err("disambiguation needs at least 2 selections".into());
    }
    let _t = std::time::Instant::now();

    let mut mgr = state.lock().map_err(|e| e.to_string())?;
    let store = mgr.store_for_window(webview.label())?;
    let tag_names: HashMap<u32, String> = store.tags.all.iter().map(|(id, t)| (*id, t.name.clone())).collect();

    let view = store.loc_view();
    let masks: Vec<Vec<bool>> = groups.iter().map(|g| resolve_bitmask(&view, &g.props)).collect();
    let batch_rows = view.batch_rows();

    let mut labeled: Vec<(usize, Location)> = Vec::new();
    let mut excluded_overlap: u32 = 0;

    for i in 0..batch_rows {
        if !view.is_alive(i) {
            continue;
        }
        match sole_group(&masks, i) {
            Err(()) => excluded_overlap += 1,
            Ok(Some(gi)) => labeled.push((gi, view.location_at_batch(i))),
            Ok(None) => {}
        }
    }
    for (j, loc) in view.adds().iter().enumerate() {
        match sole_group(&masks, batch_rows + j) {
            Err(()) => excluded_overlap += 1,
            Ok(Some(gi)) => labeled.push((gi, loc.clone())),
            Ok(None) => {}
        }
    }
    drop(view);

    let mut result = compute_divergence(&labeled, groups.len(), &field_defs, &tag_names);
    result.excluded_overlap = excluded_overlap;

    log::debug!("[cmd] store_disambiguate total={}ms groups={} labeled={} excluded_overlap={} fields={}",
        _t.elapsed().as_millis(), groups.len(), labeled.len(), excluded_overlap, result.fields.len());

    Ok(result)
}

/// Which single group a row belongs to: `Ok(Some(g))` for exactly one, `Ok(None)`
/// for none, `Err(())` for more than one (ambiguous, excluded from analysis).
fn sole_group(masks: &[Vec<bool>], row: usize) -> Result<Option<usize>, ()> {
    let mut found: Option<usize> = None;
    for (gi, m) in masks.iter().enumerate() {
        if m[row] {
            if found.is_some() {
                return Err(());
            }
            found = Some(gi);
        }
    }
    Ok(found)
}

/// Compute field divergence across labeled groups. `labeled` pairs a group index
/// (0..num_groups) with a fully-materialized location. Pure and store-free so it
/// can be unit-tested directly.
pub fn compute_divergence(
    labeled: &[(usize, Location)],
    num_groups: usize,
    field_defs: &HashMap<String, ExtraFieldDef>,
    tag_names: &HashMap<u32, String>,
) -> DisambiguateResult {
    let mut group_sizes = vec![0u32; num_groups];
    for (g, _) in labeled {
        group_sizes[*g] += 1;
    }

    let mut fields: Vec<FieldDivergence> = Vec::new();

    // Built-in numeric columns worth analyzing (lat/lng/timestamps intentionally excluded).
    for key in ["heading", "pitch", "zoom"] {
        let comparison = resolved_comparison(key, None);
        fields.push(numeric_field(key, labeled, num_groups, &group_sizes, comparison, None));
    }

    // Extra fields: registered defs plus any key discovered on the locations.
    let mut extra_keys: HashSet<String> = field_defs.keys().cloned().collect();
    for (_, loc) in labeled {
        if let Some(extra) = &loc.extra {
            for k in extra.keys() {
                extra_keys.insert(k.clone());
            }
        }
    }
    extra_keys.retain(|k| !EXCLUDED_FIELDS.contains(&k.as_str()));
    let mut extra_keys: Vec<String> = extra_keys.into_iter().collect();
    extra_keys.sort();
    for key in &extra_keys {
        // Effective def: the registered one, or inferred from a sample value so an
        // undeclared numeric field isn't mistaken for categorical.
        let inferred;
        let def: Option<&ExtraFieldDef> = match field_defs.get(key) {
            Some(d) => Some(d),
            None => {
                inferred = sample_def(key, labeled);
                inferred.as_ref()
            }
        };
        let comparison = resolved_comparison(key, def);
        match comparison {
            ComparisonType::Categorical => fields.push(categorical_field(key, labeled, num_groups, &group_sizes, def)),
            _ => fields.push(numeric_field(key, labeled, num_groups, &group_sizes, comparison, def)),
        }
    }

    // Tags as boolean categorical fields (always 100% coverage).
    let mut tag_ids: HashSet<u32> = HashSet::new();
    for (_, loc) in labeled {
        for t in &loc.tags {
            tag_ids.insert(*t);
        }
    }
    let mut tag_ids: Vec<u32> = tag_ids.into_iter().collect();
    tag_ids.sort_unstable();
    for tid in tag_ids {
        fields.push(tag_field(tid, labeled, num_groups, &group_sizes, tag_names));
    }

    // Rank: confident value scores first (desc), then low-confidence/none by coverage.
    fields.sort_by(|a, b| sort_key(b).partial_cmp(&sort_key(a)).unwrap_or(std::cmp::Ordering::Equal));

    DisambiguateResult { fields, excluded_overlap: 0, group_sizes }
}

/// Sort key: confident value score dominates; otherwise rank by coverage score
/// (shifted below any confident value score).
fn sort_key(f: &FieldDivergence) -> f64 {
    match (f.value_score, f.low_confidence) {
        (Some(v), false) => 1.0 + v,
        _ => f.coverage_score,
    }
}

// ---------------------------------------------------------------------------
// Field builders
// ---------------------------------------------------------------------------

fn numeric_field(
    key: &str,
    labeled: &[(usize, Location)],
    num_groups: usize,
    group_sizes: &[u32],
    comparison: ComparisonType,
    def: Option<&ExtraFieldDef>,
) -> FieldDivergence {
    // Per-group present numeric values.
    let mut per_group: Vec<Vec<f64>> = vec![Vec::new(); num_groups];
    for (g, loc) in labeled {
        if let Some(v) = numeric_value(loc, key) {
            per_group[*g].push(v);
        }
    }

    let present: Vec<u32> = per_group.iter().map(|v| v.len() as u32).collect();
    let value_score = match &comparison {
        ComparisonType::Circular { period } => circular_eta2(&per_group, *period),
        _ => kruskal_eps2(&per_group),
    };
    let coverage_score = coverage_v(group_sizes, &present);
    let low_confidence = is_low_confidence(&present);

    let groups: Vec<GroupSummary> = (0..num_groups)
        .map(|g| {
            let n = group_sizes[g];
            let vals = &per_group[g];
            let mut s = GroupSummary::empty(n, vals.len() as u32);
            if !vals.is_empty() {
                match &comparison {
                    ComparisonType::Circular { period } => {
                        let (mean_deg, conc) = circular_summary(vals, *period);
                        s.mean_deg = Some(mean_deg);
                        s.concentration = Some(conc);
                    }
                    _ => {
                        let (p25, median, p75) = quartiles(vals);
                        s.p25 = Some(p25);
                        s.median = Some(median);
                        s.p75 = Some(p75);
                    }
                }
            }
            s
        })
        .collect();

    let format = match def.map(|d| &d.field_type) {
        Some(ExtraFieldType::Month) => ValueFormat::Month,
        Some(ExtraFieldType::Date) => ValueFormat::DateTime,
        _ => ValueFormat::Number,
    };
    FieldDivergence { key: key.to_string(), label: field_label(key, def), comparison, format, value_score, coverage_score, low_confidence, groups }
}

/// Build a synthetic field def for an undeclared key by inferring its type from
/// the first present value across the labeled locations.
fn sample_def(key: &str, labeled: &[(usize, Location)]) -> Option<ExtraFieldDef> {
    for (_, loc) in labeled {
        if let Some(v) = loc.extra.as_ref().and_then(|e| e.get(key)) {
            if !v.is_null() {
                return Some(ExtraFieldDef {
                    field_type: infer_field_type(v),
                    label: None,
                    values: None,
                    labels: None,
                    comparison: None,
                });
            }
        }
    }
    None
}

fn categorical_field(
    key: &str,
    labeled: &[(usize, Location)],
    num_groups: usize,
    group_sizes: &[u32],
    def: Option<&ExtraFieldDef>,
) -> FieldDivergence {
    let mut per_group: Vec<HashMap<String, u32>> = vec![HashMap::new(); num_groups];
    for (g, loc) in labeled {
        if let Some(v) = category_value(loc, key) {
            *per_group[*g].entry(v).or_insert(0) += 1;
        }
    }
    finish_categorical(key, field_label(key, def), per_group, num_groups, group_sizes, def)
}

fn tag_field(
    tid: u32,
    labeled: &[(usize, Location)],
    num_groups: usize,
    group_sizes: &[u32],
    tag_names: &HashMap<u32, String>,
) -> FieldDivergence {
    let mut per_group: Vec<HashMap<String, u32>> = vec![HashMap::new(); num_groups];
    for (g, loc) in labeled {
        let has = loc.tags.contains(&tid);
        *per_group[*g].entry(if has { "yes".into() } else { "no".into() }).or_insert(0) += 1;
    }
    let label = tag_names.get(&tid).cloned().unwrap_or_else(|| format!("Tag {tid}"));
    finish_categorical(&format!("tag:{tid}"), label, per_group, num_groups, group_sizes, None)
}

fn finish_categorical(
    key: &str,
    label: String,
    per_group: Vec<HashMap<String, u32>>,
    num_groups: usize,
    group_sizes: &[u32],
    def: Option<&ExtraFieldDef>,
) -> FieldDivergence {
    let present: Vec<u32> = per_group.iter().map(|m| m.values().sum()).collect();
    let value_score = cramers_v(&per_group);
    let coverage_score = coverage_v(group_sizes, &present);
    let low_confidence = is_low_confidence(&present);

    let labels = def.and_then(|d| d.labels.as_ref());
    let groups: Vec<GroupSummary> = (0..num_groups)
        .map(|g| {
            let counts = &per_group[g];
            let total: u32 = counts.values().sum();
            let mut s = GroupSummary::empty(group_sizes[g], total);
            if total > 0 {
                let mut pairs: Vec<(&String, &u32)> = counts.iter().collect();
                pairs.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
                s.top = pairs.into_iter().take(TOP_N).map(|(val, c)| TopValue {
                    label: labels.and_then(|l| l.get(val)).cloned().unwrap_or_else(|| val.clone()),
                    freq: *c as f64 / total as f64,
                }).collect();
            }
            s
        })
        .collect();

    FieldDivergence { key: key.to_string(), label, comparison: ComparisonType::Categorical, format: ValueFormat::Number, value_score, coverage_score, low_confidence, groups }
}

// ---------------------------------------------------------------------------
// Value extraction
// ---------------------------------------------------------------------------

fn numeric_value(loc: &Location, key: &str) -> Option<f64> {
    match key {
        "heading" => Some(loc.heading),
        "pitch" => Some(loc.pitch),
        "zoom" => Some(loc.zoom),
        _ => {
            let v = loc.extra.as_ref()?.get(key)?;
            if let Some(n) = v.as_f64() {
                return Some(n);
            }
            // String dates: ISO datetime -> unix seconds; "YYYY-MM" -> month index.
            let s = v.as_str()?;
            if let Some(ts) = iso_to_unix(s) {
                return Some(ts);
            }
            parse_year_month(s)
        }
    }
}

fn parse_year_month(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    if b.len() == 7 && b[4] == b'-'
        && b[..4].iter().all(|c| c.is_ascii_digit())
        && b[5..].iter().all(|c| c.is_ascii_digit())
    {
        let year: f64 = s[..4].parse().ok()?;
        let month: f64 = s[5..].parse().ok()?;
        return Some(year * 12.0 + (month - 1.0));
    }
    None
}

fn category_value(loc: &Location, key: &str) -> Option<String> {
    let v = loc.extra.as_ref()?.get(key)?;
    json_to_category(v)
}

/// Canonical string for a categorical JSON value (null/missing -> None).
fn json_to_category(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => Some(v.to_string()),
    }
}

fn field_label(key: &str, def: Option<&ExtraFieldDef>) -> String {
    if let Some(l) = def.and_then(|d| d.label.clone()) {
        return l;
    }
    match key {
        "heading" => "Heading".into(),
        "pitch" => "Pitch".into(),
        "zoom" => "Zoom".into(),
        _ => known_field_def(key).and_then(|d| d.label).unwrap_or_else(|| key.to_string()),
    }
}

fn is_low_confidence(present: &[u32]) -> bool {
    present.iter().any(|&p| p < MIN_PRESENT)
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/// Epsilon-squared effect size from the (tie-corrected) Kruskal-Wallis H statistic.
/// Returns `None` if fewer than two groups have data. Range [0,1].
fn kruskal_eps2(per_group: &[Vec<f64>]) -> Option<f64> {
    let nonempty = per_group.iter().filter(|g| !g.is_empty()).count();
    if nonempty < 2 {
        return None;
    }
    // Flatten with group labels, then assign average ranks.
    let mut all: Vec<(f64, usize)> = Vec::new();
    for (g, vals) in per_group.iter().enumerate() {
        for &v in vals {
            all.push((v, g));
        }
    }
    let n = all.len();
    if n < 3 {
        return Some(0.0);
    }
    all.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut rank_sums = vec![0.0f64; per_group.len()];
    let mut tie_correction = 0.0f64; // sum of (t^3 - t)
    let mut i = 0;
    while i < n {
        let mut j = i + 1;
        while j < n && all[j].0 == all[i].0 {
            j += 1;
        }
        let t = (j - i) as f64;
        // Average rank for tied block (1-based ranks).
        let avg_rank = (i + 1 + j) as f64 / 2.0;
        for k in i..j {
            rank_sums[all[k].1] += avg_rank;
        }
        tie_correction += t * t * t - t;
        i = j;
    }

    let nf = n as f64;
    let mut h = 0.0;
    for (g, vals) in per_group.iter().enumerate() {
        if vals.is_empty() {
            continue;
        }
        h += rank_sums[g] * rank_sums[g] / vals.len() as f64;
    }
    h = 12.0 / (nf * (nf + 1.0)) * h - 3.0 * (nf + 1.0);

    let denom = 1.0 - tie_correction / (nf * nf * nf - nf);
    if denom > 0.0 {
        h /= denom;
    }
    if h <= 0.0 {
        return Some(0.0);
    }

    // epsilon-squared = H * (n + 1) / (n^2 - 1) = H / (n - 1)
    let eps2 = h / (nf - 1.0);
    Some(eps2.clamp(0.0, 1.0))
}

/// One-way circular ANOVA effect size. Each group's values are unit vectors at
/// angle (value / period * 2pi). Returns the between-group share of concentration,
/// clamped to [0,1]. `None` if fewer than two groups have data.
fn circular_eta2(per_group: &[Vec<f64>], period: f64) -> Option<f64> {
    let nonempty = per_group.iter().filter(|g| !g.is_empty()).count();
    if nonempty < 2 || period == 0.0 {
        return None;
    }
    let mut sum_r = 0.0; // sum of group resultant lengths
    let mut total_c = 0.0;
    let mut total_s = 0.0;
    let mut n = 0.0;
    for vals in per_group {
        if vals.is_empty() {
            continue;
        }
        let (c, s) = sincos_sums(vals, period);
        sum_r += (c * c + s * s).sqrt();
        total_c += c;
        total_s += s;
        n += vals.len() as f64;
    }
    let r = (total_c * total_c + total_s * total_s).sqrt();
    let denom = n - r;
    if denom <= 1e-9 {
        return Some(0.0);
    }
    Some(((sum_r - r) / denom).clamp(0.0, 1.0))
}

fn sincos_sums(vals: &[f64], period: f64) -> (f64, f64) {
    let mut c = 0.0;
    let mut s = 0.0;
    for &v in vals {
        let theta = v / period * 2.0 * PI;
        c += theta.cos();
        s += theta.sin();
    }
    (c, s)
}

/// Mean angle (in original units, [0, period)) and concentration (resultant length
/// / n, in [0,1]) for one group.
fn circular_summary(vals: &[f64], period: f64) -> (f64, f64) {
    let (c, s) = sincos_sums(vals, period);
    let n = vals.len() as f64;
    let mut theta = s.atan2(c); // [-pi, pi]
    if theta < 0.0 {
        theta += 2.0 * PI;
    }
    let mean = theta / (2.0 * PI) * period;
    let conc = (c * c + s * s).sqrt() / n;
    (mean, conc)
}

/// Bias-corrected Cramer's V over a groups-by-category contingency table.
/// Returns `None` if fewer than two groups (or categories) have data. Range [0,1].
fn cramers_v(per_group: &[HashMap<String, u32>]) -> Option<f64> {
    let mut categories: HashSet<&String> = HashSet::new();
    for m in per_group {
        for k in m.keys() {
            categories.insert(k);
        }
    }
    let cats: Vec<&String> = categories.into_iter().collect();
    let row_totals: Vec<f64> = per_group.iter().map(|m| m.values().sum::<u32>() as f64).collect();
    let n: f64 = row_totals.iter().sum();
    let nonempty_rows = row_totals.iter().filter(|&&r| r > 0.0).count();
    if nonempty_rows < 2 || cats.len() < 2 || n < 1.0 {
        return Some(0.0);
    }
    let col_totals: Vec<f64> = cats.iter().map(|c| {
        per_group.iter().map(|m| *m.get(*c).unwrap_or(&0) as f64).sum()
    }).collect();

    let mut chi2 = 0.0;
    for (gi, m) in per_group.iter().enumerate() {
        if row_totals[gi] == 0.0 {
            continue;
        }
        for (ci, cat) in cats.iter().enumerate() {
            let observed = *m.get(*cat).unwrap_or(&0) as f64;
            let expected = row_totals[gi] * col_totals[ci] / n;
            if expected > 0.0 {
                let d = observed - expected;
                chi2 += d * d / expected;
            }
        }
    }

    let phi2 = chi2 / n;
    let k = cats.len() as f64;
    let r = nonempty_rows as f64;
    // Bergsma bias correction.
    let phi2_corr = (phi2 - (k - 1.0) * (r - 1.0) / (n - 1.0)).max(0.0);
    let k_corr = k - (k - 1.0) * (k - 1.0) / (n - 1.0);
    let r_corr = r - (r - 1.0) * (r - 1.0) / (n - 1.0);
    let denom = (k_corr - 1.0).min(r_corr - 1.0);
    if denom <= 0.0 {
        return Some(0.0);
    }
    Some((phi2_corr / denom).sqrt().clamp(0.0, 1.0))
}

/// Coverage divergence: Cramer's V on a present/absent x group contingency table.
fn coverage_v(group_sizes: &[u32], present: &[u32]) -> f64 {
    let per_group: Vec<HashMap<String, u32>> = group_sizes.iter().zip(present).map(|(&n, &p)| {
        let mut m = HashMap::new();
        m.insert("present".to_string(), p);
        m.insert("absent".to_string(), n.saturating_sub(p));
        m
    }).collect();
    cramers_v(&per_group).unwrap_or(0.0)
}

// ---------------------------------------------------------------------------
// Quartiles
// ---------------------------------------------------------------------------

fn quartiles(vals: &[f64]) -> (f64, f64, f64) {
    let mut v = vals.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    (percentile(&v, 0.25), percentile(&v, 0.5), percentile(&v, 0.75))
}

/// Linear-interpolated percentile over an already-sorted slice.
fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    if sorted.len() == 1 {
        return sorted[0];
    }
    let pos = q * (sorted.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    let frac = pos - lo as f64;
    sorted[lo] + (sorted[hi] - sorted[lo]) * frac
}
