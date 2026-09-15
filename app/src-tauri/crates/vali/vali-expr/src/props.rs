use crate::compile::{Ty, Val};
use std::borrow::Cow;
use vali_core::Location;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prop {
    Surface,
    Buildings10,
    Buildings25,
    Buildings100,
    Buildings200,
    Roads0,
    Roads10,
    Roads25,
    Roads50,
    Roads100,
    Roads200,
    Tunnels10,
    Tunnels200,
    IsResidential,
    ClosestCoast,
    ClosestLake,
    ClosestRiver,
    ClosestRailway,
    HighwayType,
    HighwayTypeCount,
    WayId,
    Month,
    Year,
    Lat,
    Lng,
    Heading,
    DrivingDirectionAngle,
    ArrowCount,
    Elevation,
    DescriptionLength,
    IsScout,
    ResolutionHeight,
    CountryCode,
    SubdivisionCode,
    County,
}
pub const ALL: [(&str, Prop); 35] = [
    ("Surface", Prop::Surface),
    ("Buildings10", Prop::Buildings10),
    ("Buildings25", Prop::Buildings25),
    ("Buildings100", Prop::Buildings100),
    ("Buildings200", Prop::Buildings200),
    ("Roads0", Prop::Roads0),
    ("Roads10", Prop::Roads10),
    ("Roads25", Prop::Roads25),
    ("Roads50", Prop::Roads50),
    ("Roads100", Prop::Roads100),
    ("Roads200", Prop::Roads200),
    ("Tunnels10", Prop::Tunnels10),
    ("Tunnels200", Prop::Tunnels200),
    ("IsResidential", Prop::IsResidential),
    ("ClosestCoast", Prop::ClosestCoast),
    ("ClosestLake", Prop::ClosestLake),
    ("ClosestRiver", Prop::ClosestRiver),
    ("ClosestRailway", Prop::ClosestRailway),
    ("HighwayType", Prop::HighwayType),
    ("HighwayTypeCount", Prop::HighwayTypeCount),
    ("WayId", Prop::WayId),
    ("Month", Prop::Month),
    ("Year", Prop::Year),
    ("Lat", Prop::Lat),
    ("Lng", Prop::Lng),
    ("Heading", Prop::Heading),
    ("DrivingDirectionAngle", Prop::DrivingDirectionAngle),
    ("ArrowCount", Prop::ArrowCount),
    ("Elevation", Prop::Elevation),
    ("DescriptionLength", Prop::DescriptionLength),
    ("IsScout", Prop::IsScout),
    ("ResolutionHeight", Prop::ResolutionHeight),
    ("CountryCode", Prop::CountryCode),
    ("SubdivisionCode", Prop::SubdivisionCode),
    ("County", Prop::County),
];
pub fn resolve(name: &str) -> Option<Prop> {
    ALL.iter().find(|(n, _)| *n == name).map(|(_, p)| *p)
}
pub fn closest_match(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let mut best = ALL[0].0;
    let mut best_d = usize::MAX;
    for (n, _) in ALL.iter() {
        let d = levenshtein(&n.to_lowercase(), &lower);
        if d < best_d {
            best_d = d;
            best = n;
        }
    }
    best
}
fn levenshtein(s: &str, t: &str) -> usize {
    let s: Vec<char> = s.chars().collect();
    let t: Vec<char> = t.chars().collect();
    let mut prev: Vec<usize> = (0..=t.len()).collect();
    let mut cur = vec![0usize; t.len() + 1];
    for i in 1..=s.len() {
        cur[0] = i;
        for j in 1..=t.len() {
            let cost = usize::from(s[i - 1] != t[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[t.len()]
}
pub fn ty(prop: Prop) -> Ty {
    use Prop::*;
    match prop {
        Surface | WayId | CountryCode | SubdivisionCode | County => Ty::Str,
        IsResidential | IsScout => Ty::Bool,
        ClosestCoast | ClosestLake | ClosestRiver | ClosestRailway | Elevation
        | DescriptionLength => Ty::NInt,
        Lat | Lng => Ty::Double,
        HighwayType => Ty::Highway,
        _ => Ty::Int,
    }
}
pub fn eval(prop: Prop, loc: &Location) -> Val<'_> {
    use Prop::*;
    match prop {
        Surface => Val::S(loc.osm.surface.as_deref().map(Cow::Borrowed)),
        Buildings10 => Val::I(Some(loc.osm.buildings10)),
        Buildings25 => Val::I(Some(loc.osm.buildings25)),
        Buildings100 => Val::I(Some(loc.osm.buildings100)),
        Buildings200 => Val::I(Some(loc.osm.buildings200)),
        Roads0 => Val::I(Some(loc.osm.roads0)),
        Roads10 => Val::I(Some(loc.osm.roads10)),
        Roads25 => Val::I(Some(loc.osm.roads25)),
        Roads50 => Val::I(Some(loc.osm.roads50)),
        Roads100 => Val::I(Some(loc.osm.roads100)),
        Roads200 => Val::I(Some(loc.osm.roads200)),
        Tunnels10 => Val::I(Some(loc.osm.tunnels10)),
        Tunnels200 => Val::I(Some(loc.osm.tunnels200)),
        IsResidential => Val::B(Some(loc.osm.is_residential)),
        ClosestCoast => Val::I(loc.osm.closest_coast),
        ClosestLake => Val::I(loc.osm.closest_lake),
        ClosestRiver => Val::I(loc.osm.closest_river),
        ClosestRailway => Val::I(loc.osm.closest_railway),
        HighwayType => Val::H(loc.osm.road_type),
        HighwayTypeCount => Val::I(Some(loc.osm.road_type.count_ones() as i32)),
        WayId => {
            let joined = loc
                .osm
                .way_ids
                .iter()
                .map(|w| w.to_string())
                .collect::<Vec<_>>()
                .join("|");
            Val::S(Some(Cow::Owned(joined)))
        }
        Month => Val::I(Some(loc.google.month)),
        Year => Val::I(Some(loc.google.year)),
        Lat => Val::D(Some(loc.google.lat)),
        Lng => Val::D(Some(loc.google.lng)),
        Heading => Val::I(Some(loc.google.default_heading.round_ties_even() as i32)),
        DrivingDirectionAngle => Val::I(Some(loc.google.driving_direction_angle)),
        ArrowCount => Val::I(Some(loc.google.arrow_count)),
        Elevation => Val::I(loc.google.elevation),
        DescriptionLength => Val::I(loc.google.description_length),
        IsScout => Val::B(Some(loc.google.is_scout)),
        ResolutionHeight => Val::I(Some(loc.google.resolution_height)),
        CountryCode => Val::S(Some(Cow::Borrowed(&loc.nominatim.country_code))),
        SubdivisionCode => Val::S(Some(Cow::Borrowed(&loc.nominatim.subdivision_code))),
        County => Val::S(loc.nominatim.county.as_deref().map(Cow::Borrowed)),
    }
}
