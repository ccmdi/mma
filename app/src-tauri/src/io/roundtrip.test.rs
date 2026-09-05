//! Import/export fidelity. Every declared map goes out through every export format and is
//! parsed back; the lossless formats must return the same map, the lossy ones must lose
//! exactly what they are declared to lose. A field or piece of metadata nobody carries
//! across fails here rather than in a user's backup.

use super::parse::{parse_csv, parse_single_json};
use crate::io::export::{csv_document, export_document, geojson_document, CoordOpts};
use crate::types::{Location, LocationFlags, RawExtra, Tag};
use serde_json::{json, Value};
use std::collections::HashMap;

struct Fixture {
    name: &'static str,
    map_name: &'static str,
    locations: Vec<Location>,
    tags: Vec<Tag>,
    fields: Option<Value>,
}

fn loc(lat: f64, lng: f64) -> Location {
    Location {
        lat,
        lng,
        heading: 45.0,
        pitch: -5.0,
        zoom: 2.0,
        created_at: 1_700_000_000,
        modified_at: Some(1_700_000_100),
        ..Default::default()
    }
}

fn pinned(lat: f64, lng: f64, pano: &str) -> Location {
    Location {
        pano_id: Some(pano.into()),
        flags: LocationFlags::LOAD_AS_PANO_ID,
        ..loc(lat, lng)
    }
}

fn unpinned(lat: f64, lng: f64, pano: &str) -> Location {
    Location {
        pano_id: Some(pano.into()),
        ..loc(lat, lng)
    }
}

fn with_extra(mut l: Location, extra: &Value) -> Location {
    l.extra = extra.as_object().and_then(RawExtra::from_map);
    l
}

fn with_tags(mut l: Location, tags: &[u32]) -> Location {
    l.tags = tags.to_vec();
    l
}

fn tag(id: u32, name: &str, color: &str, order: Option<u32>, doclinks: &[&str]) -> Tag {
    Tag {
        id,
        name: name.into(),
        color: color.into(),
        visible: true,
        order,
        doclinks: doclinks.iter().map(|s| (*s).to_string()).collect(),
    }
}

fn catalog() -> Vec<Fixture> {
    let fields = json!({
        "countryCode": { "type": "string", "label": "Country" },
        "score": { "type": "number", "label": "Score", "circularPeriod": null }
    });
    vec![
        Fixture {
            name: "empty map",
            map_name: "Nothing here",
            locations: vec![],
            tags: vec![],
            fields: None,
        },
        Fixture {
            name: "pinned, unpinned and pano-less rows",
            map_name: "Panos",
            locations: vec![
                pinned(10.0, 20.0, "PINNED_ONE"),
                unpinned(11.0, 21.0, "FLOATING_TWO"),
                loc(12.0, 22.0),
            ],
            tags: vec![],
            fields: None,
        },
        Fixture {
            name: "tags with color, order and doclinks",
            map_name: "Tagged",
            locations: vec![
                with_tags(loc(1.0, 2.0), &[1, 2]),
                with_tags(loc(3.0, 4.0), &[2]),
                with_tags(loc(5.0, 6.0), &[3]),
            ],
            tags: vec![
                tag(1, "Rural", "#3a7fc2", Some(1), &[]),
                tag(2, "Urban", "#ff8800", Some(2), &["https://docs.example/urban#h.1"]),
                tag(3, "Kärnten / Alps", "#00ff00", None, &[]),
            ],
            fields: None,
        },
        Fixture {
            name: "field definitions and no tags",
            map_name: "Fields only",
            locations: vec![with_extra(loc(1.0, 1.0), &json!({ "score": 7, "countryCode": "AT" }))],
            tags: vec![],
            fields: Some(fields.clone()),
        },
        Fixture {
            name: "field definitions with tags",
            map_name: "Fields and tags",
            locations: vec![with_tags(
                with_extra(loc(1.0, 1.0), &json!({ "score": 7 })),
                &[1],
            )],
            tags: vec![tag(1, "Only", "#123456", Some(1), &[])],
            fields: Some(fields),
        },
        Fixture {
            name: "extra values of every JSON kind, awkward keys, hoisted codes",
            map_name: "Extras",
            locations: vec![with_extra(
                loc(48.2, 16.4),
                &json!({
                    "countryCode": "AT",
                    "stateCode": "9",
                    "n": 1,
                    "f": 2.5,
                    "s": "text with \"quotes\" and \\ slashes",
                    "b": true,
                    "arr": [1, "two", null],
                    "obj": { "nested": { "deep": [true] } },
                    "he said \"hi\"": "quoted key",
                    "back\\slash": "escaped key",
                    "ünïcödé": "名前"
                }),
            )],
            tags: vec![],
            fields: None,
        },
        Fixture {
            name: "heading zero stays zero without the unpanned tweak",
            map_name: "North",
            locations: vec![Location {
                heading: 0.0,
                ..loc(0.0, 0.0)
            }],
            tags: vec![],
            fields: None,
        },
        Fixture {
            name: "enough rows for the parallel boundary scan",
            map_name: "Many",
            locations: (0..3000)
                .map(|i| {
                    let l = loc(f64::from(i) * 0.01, f64::from(i) * -0.01);
                    with_extra(l, &json!({ "i": i }))
                })
                .collect(),
            tags: vec![],
            fields: None,
        },
    ]
}

/// What a map-making JSON export carries per location: everything but the id and the
/// timestamps, with tags by name and pinned as the flag it is.
fn view(l: &Location, names: &HashMap<u32, String>) -> Value {
    let mut tags: Vec<&str> = l.tags.iter().map(|t| names[t].as_str()).collect();
    tags.sort_unstable();
    json!({
        "lat": l.lat,
        "lng": l.lng,
        "heading": l.heading,
        "pitch": l.pitch,
        "zoom": l.zoom,
        "pano": l.pano_id.as_deref(),
        "pinned": l.flags.contains(LocationFlags::LOAD_AS_PANO_ID),
        "tags": tags,
        "extra": l.extra.as_ref().map(RawExtra::to_map),
    })
}

fn names(tags: &[Tag]) -> HashMap<u32, String> {
    tags.iter().map(|t| (t.id, t.name.clone())).collect()
}

/// `{id: Tag}`, the store's tag table as the export commands receive it.
fn tags_json(tags: &[Tag]) -> String {
    let m: serde_json::Map<String, Value> = tags
        .iter()
        .map(|t| (t.id.to_string(), serde_json::to_value(t).unwrap()))
        .collect();
    Value::Object(m).to_string()
}

/// A tag as the export carries it: color, order and doclinks under its name. `visible` is
/// not carried, by design.
fn tag_view(tags: &[Tag]) -> HashMap<String, Value> {
    tags.iter()
        .map(|t| {
            (
                t.name.clone(),
                json!({ "color": t.color, "order": t.order, "doclinks": t.doclinks }),
            )
        })
        .collect()
}

const LOSSLESS: CoordOpts = CoordOpts {
    export_zoom: true,
    export_unpanned: false,
    export_extras: true,
};

#[test]
fn every_fixture_survives_the_map_making_json() {
    for fx in catalog() {
        let doc = export_document(
            fx.map_name,
            &fx.locations,
            &tags_json(&fx.tags),
            fx.fields.clone(),
            &LOSSLESS,
        );
        let parsed = parse_single_json(&doc.to_string());

        assert!(parsed.warnings.is_empty(), "{}: {:?}", fx.name, parsed.warnings);
        assert_eq!(parsed.name, fx.map_name, "{}: name", fx.name);
        assert_eq!(parsed.locations.len(), fx.locations.len(), "{}: row count", fx.name);
        let (want, got) = (names(&fx.tags), names(&parsed.tags));
        for (i, (a, b)) in fx.locations.iter().zip(&parsed.locations).enumerate() {
            assert_eq!(view(b, &got), view(a, &want), "{}: row {i}", fx.name);
        }
        assert_eq!(tag_view(&parsed.tags), tag_view(&fx.tags), "{}: tags", fx.name);
        assert_eq!(parsed.fields, fx.fields, "{}: field definitions", fx.name);
    }
}

#[test]
fn the_csv_keeps_exactly_the_coordinates() {
    for fx in catalog() {
        let parsed = parse_csv(&csv_document(&fx.locations));
        assert_eq!(parsed.locations.len(), fx.locations.len(), "{}: row count", fx.name);
        for (i, (a, b)) in fx.locations.iter().zip(&parsed.locations).enumerate() {
            assert_eq!((b.lat, b.lng), (a.lat, a.lng), "{}: row {i}", fx.name);
            assert_eq!(b.heading, 0.0, "{}: heading is not carried", fx.name);
            assert_eq!(b.pano_id, None, "{}: pano is not carried", fx.name);
            assert!(b.tags.is_empty() && b.extra.is_none(), "{}: nothing else is carried", fx.name);
        }
        assert!(parsed.tags.is_empty() && parsed.fields.is_none(), "{}", fx.name);
    }
}

#[test]
fn the_geojson_carries_points_and_tag_names_and_nothing_else() {
    for fx in catalog() {
        let doc = geojson_document(&fx.locations, &tags_json(&fx.tags));
        let features = doc["features"].as_array().unwrap();
        assert_eq!(features.len(), fx.locations.len(), "{}", fx.name);
        let want = names(&fx.tags);
        for (l, f) in fx.locations.iter().zip(features) {
            assert_eq!(f["geometry"]["coordinates"], json!([l.lng, l.lat]), "{}", fx.name);
            let tags: Vec<Value> = l.tags.iter().map(|t| json!(want[t])).collect();
            assert_eq!(f["properties"]["tags"], json!(tags), "{}", fx.name);
            assert_eq!(f["properties"].as_object().unwrap().len(), 1, "{}: only tags", fx.name);
        }
    }
}
