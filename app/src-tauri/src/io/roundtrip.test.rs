//! Import/export fidelity. Every declared map goes out through every export format and is
//! parsed back; the lossless formats must return the same map, the lossy ones must lose
//! exactly what they are declared to lose. A field or piece of metadata nobody carries
//! across fails here rather than in a user's backup.

use super::parse::{parse_csv, parse_file};
use crate::io::export::{csv_document, export_document, geojson_document, CoordOpts};
use crate::store::engine::ValueRecord;
use crate::test_util::tag_ids;
use crate::types::shape::{MapPart, MapShape};
use crate::types::{Location, LocationFlags, RawExtra};
use mma_algebra::Id;
use serde_json::{json, Value};
use std::collections::HashMap;

struct Fixture {
    name: &'static str,
    map_name: &'static str,
    locations: Vec<Location>,
    tags: Vec<ValueRecord>,
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
    l.tags = tag_ids(tags.iter().copied());
    l
}

fn tag(id: u32, name: &str, color: &str, order: Option<u32>, doclinks: &[&str]) -> ValueRecord {
    let mut extra = serde_json::Map::from_iter([("color".to_string(), color.into())]);
    if !doclinks.is_empty() {
        extra.insert("doclinks".into(), json!(doclinks));
    }
    ValueRecord {
        id: Id::new(id),
        name: Some(name.into()),
        order,
        extra,
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
                tag(
                    2,
                    "Urban",
                    "#ff8800",
                    Some(2),
                    &["https://docs.example/urban#h.1"],
                ),
                tag(3, "Kärnten / Alps", "#00ff00", None, &[]),
            ],
            fields: None,
        },
        Fixture {
            name: "field definitions and no tags",
            map_name: "Fields only",
            locations: vec![with_extra(
                loc(1.0, 1.0),
                &json!({ "score": 7, "countryCode": "AT" }),
            )],
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
            name: "a capture month beside app data",
            map_name: "Dated",
            locations: vec![with_extra(
                unpinned(2.0, 3.0, "DATED"),
                &json!({ "panoDate": "2021-06", "note": "app only" }),
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
fn view(l: &Location, names: &HashMap<Id<ValueRecord>, String>) -> Value {
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
        "extra": l.extra.as_ref().map(RawExtra::to_map).unwrap_or_default(),
    })
}

fn names<'a>(tags: impl IntoIterator<Item = &'a ValueRecord>) -> HashMap<Id<ValueRecord>, String> {
    tags.into_iter()
        .map(|rec| (rec.id, rec.name.clone().unwrap_or_default()))
        .collect()
}

/// The store's records as the export receives them: here only the tags.
fn tag_records(tags: &[ValueRecord]) -> HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>> {
    HashMap::from([(
        "tags".to_string(),
        tags.iter().map(|rec| (rec.id, rec.clone())).collect(),
    )])
}

fn parsed_tags(
    records: &HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>>,
) -> Vec<ValueRecord> {
    records
        .get("tags")
        .map(|tags| tags.values().cloned().collect())
        .unwrap_or_default()
}

/// [`view`] less what `shape` drops. Country and state codes ride at the top level of every shape.
fn shaped_view(l: &Location, names: &HashMap<Id<ValueRecord>, String>, shape: MapShape) -> Value {
    let mut v = view(l, names);
    if !shape.keeps(MapPart::Tags) {
        v["tags"] = json!([]);
    }
    if !shape.keeps(MapPart::UnpinnedPano) && v["pinned"] == json!(false) {
        v["pano"] = Value::Null;
    }
    if !shape.keeps(MapPart::AppData) {
        let kept: serde_json::Map<String, Value> = l
            .extra
            .as_ref()
            .map(RawExtra::to_map)
            .unwrap_or_default()
            .into_iter()
            .filter(|(k, _)| match k.as_str() {
                "countryCode" | "stateCode" => true,
                "panoDate" => shape.keeps(MapPart::PanoDate),
                _ => false,
            })
            .collect();
        v["extra"] = Value::Object(kept);
    }
    v
}

/// A tag as the export carries it: color and order under its name, and every other key on its
/// record when `shape` keeps app data.
fn tag_view(tags: &[ValueRecord], shape: MapShape) -> HashMap<String, Value> {
    if !shape.keeps(MapPart::Tags) {
        return HashMap::new();
    }
    tags.iter()
        .map(|rec| {
            let mut view = if shape.keeps(MapPart::AppData) {
                rec.extra.clone()
            } else {
                serde_json::Map::new()
            };
            view.insert("color".into(), json!(rec.color()));
            view.insert("order".into(), json!(rec.order));
            (rec.name.clone().unwrap_or_default(), Value::Object(view))
        })
        .collect()
}

#[test]
fn every_fixture_keeps_exactly_what_each_shape_keeps() {
    for shape in [MapShape::GeoGuessr, MapShape::MapMaking, MapShape::Local] {
        for fx in catalog() {
            assert_shape_round_trip(&fx, shape);
        }
    }
}

fn assert_shape_round_trip(fx: &Fixture, shape: MapShape) {
    let co = CoordOpts {
        export_zoom: true,
        export_unpanned: false,
        shape,
    };
    let doc = export_document(
        fx.map_name,
        &fx.locations,
        &tag_records(&fx.tags),
        fx.fields.clone(),
        &co,
    );
    let parsed = parse_file(&mut doc.to_string().into_bytes());
    let name = format!("{} as {shape:?}", fx.name);
    let name = name.as_str();

    assert!(parsed.warnings.is_empty(), "{name}: {:?}", parsed.warnings);
    assert_eq!(parsed.name, fx.map_name, "{name}: name");
    assert_eq!(
        parsed.locations.len(),
        fx.locations.len(),
        "{name}: row count"
    );
    let got_tags = parsed_tags(&parsed.records);
    let (want, got) = (names(&fx.tags), names(&got_tags));
    for (i, (a, b)) in fx.locations.iter().zip(&parsed.locations).enumerate() {
        assert_eq!(
            view(b, &got),
            shaped_view(a, &want, shape),
            "{name}: row {i}"
        );
    }
    assert_eq!(
        tag_view(&got_tags, MapShape::Local),
        tag_view(&fx.tags, shape),
        "{name}: tags"
    );
    let fields = fx.fields.clone().filter(|_| shape.keeps(MapPart::AppData));
    assert_eq!(parsed.fields, fields, "{name}: field definitions");
}

#[test]
fn the_csv_keeps_exactly_the_coordinates() {
    for fx in catalog() {
        let parsed = parse_csv(&csv_document(&fx.locations));
        assert_eq!(
            parsed.locations.len(),
            fx.locations.len(),
            "{}: row count",
            fx.name
        );
        for (i, (a, b)) in fx.locations.iter().zip(&parsed.locations).enumerate() {
            assert_eq!((b.lat, b.lng), (a.lat, a.lng), "{}: row {i}", fx.name);
            assert_eq!(b.heading, 0.0, "{}: heading is not carried", fx.name);
            assert_eq!(b.pano_id, None, "{}: pano is not carried", fx.name);
            assert!(
                b.tags.is_empty() && b.extra.is_none(),
                "{}: nothing else is carried",
                fx.name
            );
        }
        assert!(
            parsed_tags(&parsed.records).is_empty() && parsed.fields.is_none(),
            "{}",
            fx.name
        );
    }
}

#[test]
fn the_geojson_carries_points_and_tag_names_and_nothing_else() {
    for fx in catalog() {
        let doc = geojson_document(&fx.locations, &tag_records(&fx.tags));
        let features = doc["features"].as_array().unwrap();
        assert_eq!(features.len(), fx.locations.len(), "{}", fx.name);
        let want = names(&fx.tags);
        for (l, f) in fx.locations.iter().zip(features) {
            assert_eq!(
                f["geometry"]["coordinates"],
                json!([l.lng, l.lat]),
                "{}",
                fx.name
            );
            let tags: Vec<Value> = l.tags.iter().map(|t| json!(want[t])).collect();
            assert_eq!(f["properties"]["tags"], json!(tags), "{}", fx.name);
            assert_eq!(
                f["properties"].as_object().unwrap().len(),
                1,
                "{}: only tags",
                fx.name
            );
        }
    }
}

fn habitat(id: u32, name: &str, extra: &Value, order: Option<u32>) -> ValueRecord {
    ValueRecord {
        id: Id::new(id),
        name: Some(name.into()),
        order,
        extra: extra.as_object().cloned().unwrap_or_default(),
    }
}

/// A map whose plugin field `habitat` interns its values, beside tags.
fn habitat_map() -> (
    Vec<Location>,
    HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>>,
    Value,
) {
    let locations = vec![
        with_tags(
            with_extra(loc(1.0, 2.0), &json!({ "habitat": [1, 2] })),
            &[1],
        ),
        with_extra(loc(3.0, 4.0), &json!({ "habitat": [2], "score": 4 })),
        loc(5.0, 6.0),
    ];
    let records = HashMap::from([
        (
            "tags".to_string(),
            HashMap::from([(Id::new(1), tag(1, "Rural", "#3a7fc2", Some(1), &[]))]),
        ),
        (
            "habitat".to_string(),
            HashMap::from([
                (
                    Id::new(1),
                    habitat(
                        1,
                        "Wetland",
                        &json!({ "color": "#00ff00", "icon": "reed" }),
                        None,
                    ),
                ),
                (Id::new(2), habitat(2, "Forest", &json!({}), Some(1))),
            ]),
        ),
    ]);
    let fields = json!({ "habitat": { "type": "array", "label": "Habitat", "interned": true } });
    (locations, records, fields)
}

fn habitat_names(
    parsed: &HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>>,
    l: &Location,
) -> Vec<String> {
    let names = names(parsed["habitat"].values());
    match l.extra.as_ref().and_then(|e| e.get("habitat")) {
        Some(Value::Array(ids)) => ids
            .iter()
            .map(|id| names[&Id::new(id.as_u64().unwrap() as u32)].clone())
            .collect(),
        _ => Vec::new(),
    }
}

#[test]
fn an_interned_field_travels_by_name_with_its_records() {
    let (locations, records, fields) = habitat_map();
    let co = CoordOpts {
        export_zoom: true,
        export_unpanned: false,
        shape: MapShape::Local,
    };
    let doc = export_document("Habitats", &locations, &records, Some(fields.clone()), &co);

    assert_eq!(
        doc["customCoordinates"][0]["extra"]["habitat"],
        json!(["Wetland", "Forest"]),
        "rows spell the values by name"
    );
    assert_eq!(
        doc["extra"]["habitat"],
        json!({
            "Wetland": { "color": [0, 255, 0], "icon": "reed" },
            "Forest": { "order": 1 }
        }),
        "the records travel under extra.<field>, beside extra.tags"
    );
    assert!(doc["extra"]["tags"]["Rural"].is_object());

    let parsed = parse_file(&mut doc.to_string().into_bytes());
    assert_eq!(parsed.fields, Some(fields));
    let got: Vec<Vec<String>> = parsed
        .locations
        .iter()
        .map(|l| habitat_names(&parsed.records, l))
        .collect();
    assert_eq!(
        got,
        vec![
            vec!["Wetland".to_string(), "Forest".to_string()],
            vec!["Forest".to_string()],
            vec![],
        ]
    );
    let by_name: HashMap<String, &ValueRecord> = parsed.records["habitat"]
        .values()
        .map(|r| (r.name.clone().unwrap(), r))
        .collect();
    assert_eq!(
        by_name["Wetland"].color().map(|c| c.to_string()),
        Some("#00ff00".to_string())
    );
    assert_eq!(by_name["Wetland"].extra["icon"], "reed");
    assert_eq!(by_name["Forest"].order, Some(1));
    assert_eq!(
        parsed.locations[1]
            .extra
            .as_ref()
            .and_then(|e| e.get("score")),
        Some(json!(4)),
        "plain extra values are untouched"
    );
}

#[test]
fn a_shape_without_app_data_carries_no_plugin_interned_field() {
    let (locations, records, fields) = habitat_map();
    let co = CoordOpts {
        export_zoom: true,
        export_unpanned: false,
        shape: MapShape::MapMaking,
    };
    let doc = export_document("Habitats", &locations, &records, Some(fields), &co);
    assert!(doc["extra"].get("habitat").is_none());
    assert!(doc["customCoordinates"][0]["extra"]
        .get("habitat")
        .is_none());
    assert!(doc["extra"]["tags"]["Rural"].is_object());
}
