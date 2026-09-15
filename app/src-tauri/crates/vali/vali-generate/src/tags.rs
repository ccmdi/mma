use vali_core::Location;
const ROAD_TYPE_NAMES: [(&str, u32); 16] = [
    ("Motorway", 1),
    ("Trunk", 2),
    ("Primary", 4),
    ("Secondary", 8),
    ("Tertiary", 16),
    ("Motorway_link", 32),
    ("Trunk_link", 64),
    ("Primary_link", 128),
    ("Secondary_link", 256),
    ("Tertiary_link", 512),
    ("Unclassified", 1024),
    ("Residential", 2048),
    ("Living_street", 4096),
    ("Service", 8192),
    ("Track", 16384),
    ("Road", 32768),
];
pub fn tags(
    loc: &Location,
    heading: i32,
    location_tags: &[String],
    location_tag: Option<&str>,
) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for e in location_tags {
        emit(loc, heading, e, &mut out);
    }
    out.push(location_tag.unwrap_or_default().to_string());
    out.retain(|t| !t.is_empty());
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}
fn emit(l: &Location, heading: i32, e: &str, out: &mut Vec<String>) {
    let g = &l.google;
    let o = &l.osm;
    match e {
        "CountryCode" => out.push(l.nominatim.country_code.to_string()),
        "SubdivisionCode" => out.push(l.nominatim.subdivision_code.to_string()),
        "Subdivision" => out.push(String::new()),
        "County" => out.push(
            l.nominatim
                .county
                .as_deref()
                .unwrap_or_default()
                .to_string(),
        ),
        "Surface" => out.push(o.surface.as_deref().unwrap_or_default().to_string()),
        "Year" => out.push(g.year.to_string()),
        "Month" => out.push(g.month.to_string()),
        "YearMonth" => out.push(format!("{}-{:0>2}", g.year, g.month.to_string())),
        "Elevation" => out.push(g.elevation.map(|v| v.to_string()).unwrap_or_default()),
        _ if e.starts_with("Elevation") => out.push(match g.elevation {
            Some(v) => range("Elevation", v, &e.replace("Elevation", ""), "m").unwrap_or_default(),
            None => String::new(),
        }),
        "ArrowCount" => out.push(format!("ArrowCount-{}", g.arrow_count)),
        _ if e.starts_with("DrivingDirectionAngle") => {
            int_tag("DrivingDirectionAngle", g.driving_direction_angle, e, out)
        }
        _ if e.starts_with("Heading") => int_tag("Heading", heading, e, out),
        "DescriptionLength" => out.push(format!(
            "DescriptionLength-{}",
            g.description_length
                .map(|v| v.to_string())
                .unwrap_or_else(|| "null".to_string())
        )),
        "IsScout" => out.push(format!("IsScout-{}", if g.is_scout { "Yes" } else { "No" })),
        "ResolutionHeight" => out.push(format!("ResolutionHeight-{}", g.resolution_height)),
        "PanoramaCount" => out.push("PanoramaCount-0".to_string()),
        "Season" => out.push(season(&l.nominatim.country_code, g.month).to_string()),
        "HighwayType" => {
            for (name, flag) in ROAD_TYPE_NAMES {
                if (o.road_type as i32) & (flag as i32) == flag as i32 {
                    out.push(name.to_string());
                }
            }
        }
        "HighwayTypeCount" => out.push(format!("HighwayTypeCount-{}", o.road_type.count_ones())),
        "WayId" => out.push(format!(
            "WayId-{}",
            o.way_ids
                .iter()
                .map(|w| w.to_string())
                .collect::<Vec<_>>()
                .join("|")
        )),
        _ if e.starts_with("Buildings200") => int_tag("Buildings200", o.buildings200, e, out),
        _ if e.starts_with("Buildings100") => int_tag("Buildings100", o.buildings100, e, out),
        _ if e.starts_with("Buildings25") => int_tag("Buildings25", o.buildings25, e, out),
        _ if e.starts_with("Buildings10") => int_tag("Buildings10", o.buildings10, e, out),
        _ if e.starts_with("Roads200") => int_tag("Roads200", o.roads200, e, out),
        _ if e.starts_with("Roads100") => int_tag("Roads100", o.roads100, e, out),
        _ if e.starts_with("Roads50") => int_tag("Roads50", o.roads50, e, out),
        _ if e.starts_with("Roads25") => int_tag("Roads25", o.roads25, e, out),
        _ if e.starts_with("Roads10") => int_tag("Roads10", o.roads10, e, out),
        _ if e.starts_with("Roads0") => int_tag("Roads0", o.roads0, e, out),
        _ if e.starts_with("Tunnels200") => int_tag("Tunnels200", o.tunnels200, e, out),
        _ if e.starts_with("Tunnels10") => int_tag("Tunnels10", o.tunnels10, e, out),
        _ if e.starts_with("ClosestCoast") => {
            if let Some(v) = o.closest_coast {
                int_tag("ClosestCoast", v, e, out);
            }
        }
        _ if e.starts_with("ClosestLake") => {
            if let Some(v) = o.closest_lake {
                int_tag("ClosestLake", v, e, out);
            }
        }
        _ if e.starts_with("ClosestRiver") => {
            if let Some(v) = o.closest_river {
                int_tag("ClosestRiver", v, e, out);
            }
        }
        _ if e.starts_with("ClosestRailway") => {
            if let Some(v) = o.closest_railway {
                int_tag("ClosestRailway", v, e, out);
            }
        }
        _ if e.starts_with("HighwayTypeCount") => {
            int_tag("HighwayTypeCount", o.road_type.count_ones() as i32, e, out)
        }
        _ if e.starts_with("Year") => int_tag("Year", g.year, e, out),
        _ if e.starts_with("Month") => int_tag("Month", g.month, e, out),
        _ if e.starts_with("ResolutionHeight") => {
            int_tag("ResolutionHeight", g.resolution_height, e, out)
        }
        "IsResidential" => out.push(format!(
            "IsResidential-{}",
            if o.is_residential { "Yes" } else { "No" }
        )),
        _ => {}
    }
}
fn int_tag(name: &str, value: i32, e: &str, out: &mut Vec<String>) {
    if e.contains('-') {
        out.push(range(name, value, &e.replace(&format!("{name}-"), ""), "").unwrap_or_default());
    } else {
        out.push(format!("{name}-{value}"));
    }
}
fn range(prefix: &str, number: i32, bucket_string: &str, suffix: &str) -> Option<String> {
    let bucket: i32 = bucket_string.parse().ok()?;
    let lower = (number / bucket) * bucket;
    let upper = ((number / bucket) + 1) * bucket - 1;
    Some(format!("{prefix}[{lower:>4}-{upper:>4}]{suffix}"))
}
const SOUTHERN: [&str; 48] = [
    "EC", "BR", "PE", "CL", "AR", "UY", "PY", "BO", "UG", "ZA", "SZ", "LS", "BW", "NA", "ZW", "MZ",
    "ZM", "AO", "TZ", "MG", "CG", "CD", "GA", "ID", "AU", "NZ", "CC", "CX", "PG", "TL", "AS", "TV",
    "FJ", "PF", "TO", "CK", "VU", "NC", "BI", "MW", "MU", "SC", "KM", "GQ", "KI", "NR", "RW", "SB",
];
fn season(country_code: &str, month: i32) -> &'static str {
    let southern = SOUTHERN.contains(&country_code);
    match (southern, month) {
        (false, 12 | 1 | 2) => "Winter",
        (false, 3..=5) => "Spring",
        (false, 6..=8) => "Summer",
        (false, 9..=11) => "Autumn",
        (true, 12 | 1 | 2) => "Summer",
        (true, 3..=5) => "Autumn",
        (true, 6..=8) => "Winter",
        (true, 9..=11) => "Spring",
        _ => panic!("month {month} out of range for Season tag"),
    }
}
