use crate::definition::{default_distribution, map_country_codes, resolve_country_distribution};
use crate::goals::subdivision_weights;
use crate::names::{country_name, subdivision_name};
use std::fmt::Write as _;
use vali_core::{DistributionStrategy, MapDefinition};
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
pub fn subdivisions_export(code: &str, as_text: bool) -> Result<String, String> {
    let country_codes = map_country_codes(&[code.to_string()], &DistributionStrategy::default())?;
    if country_codes.is_empty() {
        return Ok(format!(
            "No subdivision distribution yet for {} / {code}.",
            country_name(code)
        ));
    }
    let entries: Vec<(&str, &[(&str, i32)])> = country_codes
        .iter()
        .filter_map(|cc| subdivision_weights(cc).map(|w| (cc.as_str(), w)))
        .collect();
    if as_text {
        let mut out = String::from("Code\tName\tWeight\n");
        for (cc, weights) in &entries {
            for (sub, weight) in *weights {
                let _ = writeln!(
                    out,
                    "{sub}\t{}\t{weight}",
                    subdivision_name(cc, sub).unwrap_or("N/A")
                );
            }
        }
        return Ok(out);
    }
    let mut out = String::from("{\n");
    for (i, (cc, weights)) in entries.iter().enumerate() {
        let _ = writeln!(out, "  \"{cc}\": {{");
        for (j, (sub, weight)) in weights.iter().enumerate() {
            let comma = if j + 1 < weights.len() { "," } else { "" };
            let _ = writeln!(out, "    \"{sub}\": {weight}{comma}");
        }
        let comma = if i + 1 < entries.len() { "," } else { "" };
        let _ = writeln!(out, "  }}{comma}");
    }
    out.push('}');
    Ok(out)
}
pub fn countries_export(
    countries: &str,
    distribution_name: Option<&str>,
    as_text: bool,
) -> Result<String, String> {
    let strategy = DistributionStrategy {
        country_distribution_from_map: distribution_name
            .filter(|d| !d.is_empty())
            .map(str::to_string),
        ..Default::default()
    };
    if default_distribution(&strategy).is_empty() {
        return Err(format!(
            "Unknown distribution {}.",
            distribution_name.unwrap_or("")
        ));
    }
    let definition = MapDefinition {
        country_codes: vec![countries.to_string()],
        distribution_strategy: strategy,
        ..Default::default()
    };
    let expanded = map_country_codes(&definition.country_codes, &DistributionStrategy::default())?;
    let mut distribution = resolve_country_distribution(&definition, &expanded)?;
    distribution.sort_by(|a, b| a.0.cmp(&b.0));
    if as_text {
        let mut out = String::from("Country code\tName\tWeight\n");
        for (cc, weight) in &distribution {
            let _ = writeln!(out, "{cc}\t{}\t{weight}", country_name(cc));
        }
        return Ok(out);
    }
    let mut out = String::from("{\n  \"countryDistribution\": {\n");
    for (i, (cc, weight)) in distribution.iter().enumerate() {
        let comma = if i + 1 < distribution.len() { "," } else { "" };
        let _ = writeln!(out, "    \"{cc}\": {weight}{comma}");
    }
    out.push_str("  }\n}");
    Ok(out)
}
pub fn report(code: &str, property: &str, by_country: bool) -> Result<String, String> {
    let data_root = vali_data::paths::data_root().map_err(|e| e.to_string())?;
    let mut counts: Vec<((String, String, String), i64)> = Vec::new();
    for cc in map_country_codes(&[code.to_string()], &DistributionStrategy::default())? {
        let Some(weights) = subdivision_weights(&cc) else {
            return Err(format!("Unknown country code '{cc}'."));
        };
        let all_files: Vec<std::path::PathBuf> = weights
            .iter()
            .filter(|(_, w)| *w > 0)
            .map(|(sub, _)| vali_data::paths::subdivision_file(&data_root, &cc, sub))
            .collect();
        let announce = |e: crate::progress::Event| {
            if let crate::progress::Event::CountryDownloadStarted { country_code, .. } = e {
                println!("Downloading {} data.", country_name(&country_code));
            }
        };
        crate::download::ensure_files_downloaded(
            &data_root,
            &cc,
            &all_files,
            Some(&announce),
            None,
        )
        .map_err(|e| format!("{e:#}"))?;
        for (sub, weight) in weights {
            if *weight <= 0 {
                continue;
            }
            let file = vali_data::paths::subdivision_file(&data_root, &cc, sub);
            if !file.exists() {
                return Err(format!(
                    "missing data file {} - run 'vali download --country {cc}' first.",
                    file.display()
                ));
            }
            let locations = vali_data::decode_file(&file).map_err(|e| e.to_string())?;
            for l in &locations {
                let value = match property {
                    "SubdivisionCode" => Some(l.nominatim.subdivision_code.to_string()),
                    "County" => l.nominatim.county.as_deref().map(str::to_string),
                    "Year" => Some(l.google.year.to_string()),
                    "Month" => Some(
                        MONTHS[(l.google.month as usize).saturating_sub(1).min(11)].to_string(),
                    ),
                    "YearMonth" => Some(format!("{}-{:0>2}", l.google.year, l.google.month)),
                    "Surface" => l.osm.surface.as_deref().map(str::to_string),
                    _ => Some("Invalid property".to_string()),
                };
                let Some(value) = value else { continue };
                let (key, name) = if by_country {
                    (
                        l.nominatim.country_code.to_string(),
                        country_name(&l.nominatim.country_code).to_string(),
                    )
                } else {
                    (
                        l.nominatim.subdivision_code.to_string(),
                        subdivision_name(&l.nominatim.country_code, &l.nominatim.subdivision_code)
                            .unwrap_or("N/A")
                            .to_string(),
                    )
                };
                let group = (key, name, value);
                match counts.iter_mut().find(|(g, _)| *g == group) {
                    Some((_, c)) => *c += 1,
                    None => counts.push((group, 1)),
                }
            }
        }
    }
    counts.sort_by(|a, b| a.0 .0.cmp(&b.0 .0).then(a.0 .2.cmp(&b.0 .2)));
    let key_heading = if by_country {
        "Country code"
    } else {
        "Subdivision code"
    };
    let mut out = format!(
        "By country {}\n{key_heading}\tName\t{property}\tLocation count\n",
        if by_country { "True" } else { "False" }
    );
    for ((key, name, value), count) in &counts {
        let _ = writeln!(out, "{key}\t{name}\t{value}\t{count}");
    }
    Ok(out)
}
