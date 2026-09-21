use super::*;
use vali_core::location::{GoogleData, NominatimData, OsmData};

fn fixture() -> Location {
    Location {
        google: GoogleData {
            year: 2019,
            month: 7,
            driving_direction_angle: 123,
            elevation: Some(456),
            resolution_height: 8192,
            ..Default::default()
        },
        osm: OsmData {
            buildings10: 1,
            buildings25: 22,
            buildings100: 333,
            buildings200: 444,
            roads0: 5,
            roads10: 16,
            roads25: 27,
            roads50: 38,
            roads100: 49,
            roads200: 51,
            tunnels10: 62,
            tunnels200: 73,
            closest_coast: Some(1400),
            closest_lake: Some(1500),
            closest_river: None,
            closest_railway: Some(1700),
            road_type: 2 | 8,
            ..Default::default()
        },
        nominatim: NominatimData::default(),
        ..Default::default()
    }
}

const HEADING: i32 = 250;

fn emitted(tag: &str) -> Vec<String> {
    tags(&fixture(), HEADING, &[tag.to_string()], None).unwrap_or_default()
}

#[test]
fn every_tag_form_emits_its_pinned_output() {
    let cases: &[(&str, &[&str])] = &[
        ("DrivingDirectionAngle", &["DrivingDirectionAngle-123"]),
        (
            "DrivingDirectionAngle-10",
            &["DrivingDirectionAngle[ 120- 129]"],
        ),
        (
            "DrivingDirectionAngle-100",
            &["DrivingDirectionAngle[ 100- 199]"],
        ),
        ("Heading", &["Heading-250"]),
        ("Heading-10", &["Heading[ 250- 259]"]),
        ("Heading-100", &["Heading[ 200- 299]"]),
        ("Buildings200", &["Buildings200-444"]),
        ("Buildings200-10", &["Buildings200[ 440- 449]"]),
        ("Buildings200-100", &["Buildings200[ 400- 499]"]),
        ("Buildings100", &["Buildings100-333"]),
        ("Buildings100-10", &["Buildings100[ 330- 339]"]),
        ("Buildings100-100", &["Buildings100[ 300- 399]"]),
        ("Buildings25", &["Buildings25-22"]),
        ("Buildings25-10", &["Buildings25[  20-  29]"]),
        ("Buildings25-100", &["Buildings25[   0-  99]"]),
        ("Buildings10", &["Buildings10-1"]),
        ("Buildings10-10", &["Buildings10[   0-   9]"]),
        ("Buildings10-100", &["Buildings10[   0-  99]"]),
        ("Roads200", &["Roads200-51"]),
        ("Roads200-10", &["Roads200[  50-  59]"]),
        ("Roads200-100", &["Roads200[   0-  99]"]),
        ("Roads100", &["Roads100-49"]),
        ("Roads100-10", &["Roads100[  40-  49]"]),
        ("Roads100-100", &["Roads100[   0-  99]"]),
        ("Roads50", &["Roads50-38"]),
        ("Roads50-10", &["Roads50[  30-  39]"]),
        ("Roads50-100", &["Roads50[   0-  99]"]),
        ("Roads25", &["Roads25-27"]),
        ("Roads25-10", &["Roads25[  20-  29]"]),
        ("Roads25-100", &["Roads25[   0-  99]"]),
        ("Roads10", &["Roads10-16"]),
        ("Roads10-10", &["Roads10[  10-  19]"]),
        ("Roads10-100", &["Roads10[   0-  99]"]),
        ("Roads0", &["Roads0-5"]),
        ("Roads0-10", &["Roads0[   0-   9]"]),
        ("Roads0-100", &["Roads0[   0-  99]"]),
        ("Tunnels200", &["Tunnels200-73"]),
        ("Tunnels200-10", &["Tunnels200[  70-  79]"]),
        ("Tunnels200-100", &["Tunnels200[   0-  99]"]),
        ("Tunnels10", &["Tunnels10-62"]),
        ("Tunnels10-10", &["Tunnels10[  60-  69]"]),
        ("Tunnels10-100", &["Tunnels10[   0-  99]"]),
        ("ClosestCoast", &["ClosestCoast-1400"]),
        ("ClosestCoast-10", &["ClosestCoast[1400-1409]"]),
        ("ClosestCoast-100", &["ClosestCoast[1400-1499]"]),
        ("ClosestLake", &["ClosestLake-1500"]),
        ("ClosestLake-10", &["ClosestLake[1500-1509]"]),
        ("ClosestLake-100", &["ClosestLake[1500-1599]"]),
        ("ClosestRiver", &[]),
        ("ClosestRiver-10", &[]),
        ("ClosestRiver-100", &[]),
        ("ClosestRailway", &["ClosestRailway-1700"]),
        ("ClosestRailway-10", &["ClosestRailway[1700-1709]"]),
        ("ClosestRailway-100", &["ClosestRailway[1700-1799]"]),
        ("HighwayTypeCount", &["HighwayTypeCount-2"]),
        ("HighwayTypeCount-10", &["HighwayTypeCount[   0-   9]"]),
        ("HighwayTypeCount-100", &["HighwayTypeCount[   0-  99]"]),
        ("Year", &["2019"]),
        ("Year-10", &["Year[2010-2019]"]),
        ("Year-100", &["Year[2000-2099]"]),
        ("Month", &["7"]),
        ("Month-10", &["Month[   0-   9]"]),
        ("Month-100", &["Month[   0-  99]"]),
        ("ResolutionHeight", &["ResolutionHeight-8192"]),
        ("ResolutionHeight-10", &["ResolutionHeight[8190-8199]"]),
        ("ResolutionHeight-100", &["ResolutionHeight[8100-8199]"]),
        ("YearMonth", &["2019-07"]),
        ("YearMonth-10", &[]),
        ("YearMonth-100", &[]),
        ("Elevation", &["456"]),
        ("Elevation-10", &["Elevation[ 450- 439]m"]),
        ("Elevation-100", &["Elevation[ 400- 299]m"]),
    ];
    for (tag, expected) in cases {
        assert_eq!(emitted(tag), *expected, "{tag}");
    }
}
