//! Border archive tests: the archived (mmap'd) geometry path must agree bit-for-bit with
//! the owned GeoJSON path, and the offline artifact generator.

use super::{
    arch_feature_bbox, arch_point_in_feature, arch_to_geometry, classify_points, classify_scan,
    convert_dataset, git_blob_sha1, parse_border_shas, ArchDataset, ArchFeature,
};
use crate::selections::{self, PolygonGeometry};
use std::fs;
use std::path::Path;

fn sample() -> (PolygonGeometry, ArchFeature) {
    // Outer square [0,10]^2 with a hole [3,7]^2, plus a detached extra square [20,30]x[0,10].
    let outer = vec![
        [0.0, 0.0],
        [10.0, 0.0],
        [10.0, 10.0],
        [0.0, 10.0],
        [0.0, 0.0],
    ];
    let hole = vec![[3.0, 3.0], [7.0, 3.0], [7.0, 7.0], [3.0, 7.0], [3.0, 3.0]];
    let extra = vec![
        [20.0, 0.0],
        [30.0, 0.0],
        [30.0, 10.0],
        [20.0, 10.0],
        [20.0, 0.0],
    ];

    let owned = PolygonGeometry {
        coordinates: vec![outer.clone(), hole.clone()],
        extra_polygons: Some(vec![vec![extra.clone()]]),
        properties: None,
    };
    let arch = ArchFeature {
        name: "Test".into(),
        code: "XX".into(),
        rings: vec![outer, hole],
        extra: vec![vec![extra]],
    };
    (owned, arch)
}

#[test]
fn archived_geometry_matches_owned() {
    let (owned, arch) = sample();
    let bytes = rkyv::to_bytes::<_, 1024>(&ArchDataset {
        features: vec![arch],
    })
    .unwrap();
    let archived = rkyv::check_archived_root::<ArchDataset>(&bytes[..]).unwrap();
    let af = &archived.features[0];

    // Containment parity across a grid covering inside / hole / extra / outside.
    for lat in [-2.0, 1.0, 5.0, 9.0, 12.0] {
        for lng in [-2.0, 1.0, 5.0, 9.0, 15.0, 25.0, 35.0] {
            assert_eq!(
                arch_point_in_feature(lng, lat, af),
                selections::point_in_geometry(lng, lat, &owned),
                "mismatch at ({lng}, {lat})"
            );
        }
    }

    assert_eq!(arch_feature_bbox(af), selections::geometry_bbox(&owned));

    let back = arch_to_geometry(af);
    assert_eq!(back.coordinates, owned.coordinates);
    assert_eq!(back.extra_polygons, owned.extra_polygons);
}

#[test]
fn convert_dataset_produces_valid_archive() {
    let gj = r#"{"type":"FeatureCollection","features":[
        {"type":"Feature","properties":{"code":"XX","name":"Test"},
         "geometry":{"type":"Polygon","coordinates":[[[0,0],[10,0],[10,10],[0,10],[0,0]]]}}]}"#;
    let bytes = convert_dataset(gj).unwrap();
    let archived = rkyv::check_archived_root::<ArchDataset>(&bytes[..]).unwrap();
    assert_eq!(archived.features.len(), 1);
    assert_eq!(archived.features[0].code.as_str(), "XX");
    assert_eq!(archived.features[0].rings[0].len(), 5);
}

#[test]
fn classify_scan_names_points_in_order() {
    let (owned, _) = sample();
    let other = PolygonGeometry {
        coordinates: vec![vec![
            [40.0, 0.0],
            [50.0, 0.0],
            [50.0, 10.0],
            [40.0, 10.0],
            [40.0, 0.0],
        ]],
        extra_polygons: None,
        properties: None,
    };
    let features = [("A", owned), ("B", other)];
    let feats: Vec<_> = features
        .iter()
        .map(|f| (selections::geometry_bbox(&f.1).unwrap(), f))
        .collect();

    // (lat, lng): inside A, in A's hole, in A's extra polygon, inside B, outside all.
    let coords = [
        (1.0, 1.0),
        (5.0, 5.0),
        (5.0, 25.0),
        (5.0, 45.0),
        (5.0, 35.0),
    ];
    let names = classify_scan(
        &feats,
        &coords,
        |lng, lat, f| selections::point_in_geometry(lng, lat, &f.1),
        |f| f.0,
    );
    assert_eq!(
        names,
        vec![
            Some("A".into()),
            None,
            Some("A".into()),
            Some("B".into()),
            None
        ]
    );
}

#[test]
fn bbox_prefilter_does_not_change_lookup() {
    // border_lookup now rejects features by their load-time bbox before the crossing
    // test; the first matching feature must be the same one the unfiltered scan finds.
    let features = super::parse_geojson(include_str!("../../data/borders.json")).unwrap();
    let bboxes: Vec<_> = features
        .iter()
        .map(|f| selections::geometry_bbox(&f.geometry))
        .collect();
    let mut lat = -80.0;
    while lat <= 80.0 {
        let mut lng = -180.0;
        while lng < 180.0 {
            let plain = features
                .iter()
                .position(|f| selections::point_in_geometry(lng, lat, &f.geometry));
            let filtered = features.iter().zip(&bboxes).position(|(f, bb)| {
                matches!(bb, Some(bb) if selections::in_bbox(lng, lat, bb))
                    && selections::point_in_geometry(lng, lat, &f.geometry)
            });
            assert_eq!(plain, filtered, "divergence at ({lng}, {lat})");
            lng += 10.0;
        }
        lat += 10.0;
    }
}

/// Regenerate the shipped border archives from their GeoJSON sources. Not part of the
/// normal suite -- run on purpose when a source dataset changes:
///   cargo test -p map-making-app gen_rkyv_artifacts -- --ignored --nocapture
/// then commit the updated `data/borders/borders-{level}.rkyv` files.
#[test]
#[ignore]
fn gen_rkyv_artifacts() {
    let repo_borders = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/borders");
    for level in ["medium", "heavy", "adm1"] {
        let json = fs::read_to_string(repo_borders.join(format!("borders-{level}.json")))
            .unwrap_or_else(|e| panic!("read borders-{level}.json: {e}"));
        let bytes = convert_dataset(&json).unwrap();
        let out = repo_borders.join(format!("borders-{level}.rkyv"));
        fs::write(&out, &bytes).unwrap();
        println!(
            "borders-{level}: {:.1}MB JSON -> {:.1}MB rkyv",
            json.len() as f64 / 1e6,
            bytes.len() as f64 / 1e6
        );
    }
}

/// Known-answer check against `git hash-object`: empty blob and "hello world\n".
/// raw.githubusercontent's ETag is the blob id, so this formula must match git's.
#[test]
fn git_blob_sha1_matches_git() {
    assert_eq!(
        git_blob_sha1(b""),
        "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
    );
    assert_eq!(
        git_blob_sha1(b"hello world\n"),
        "3b18e512dba79e4c8300dd08aeb37f8e728b8dad"
    );
}

/// The contents API's `sha` for a file is the git blob id git_blob_sha1 computes.
/// Entries without name/sha (or a non-array error payload) are skipped, not a panic.
#[test]
fn parse_border_shas_reads_contents_listing() {
    let listing = serde_json::json!([
        { "name": "borders-medium.rkyv", "sha": "527857ecf3dabcba8705aab16e6a548c090b46a2", "size": 1 },
        { "name": "ATTRIBUTION.md", "sha": "7001bc2c67c227a42d72941ced4b6e1e0abe593a" },
        { "bogus": true }
    ]);
    let shas = parse_border_shas(&listing);
    assert_eq!(shas.len(), 2);
    assert_eq!(
        shas.get("borders-medium.rkyv").map(String::as_str),
        Some("527857ecf3dabcba8705aab16e6a548c090b46a2")
    );
    assert!(parse_border_shas(&serde_json::json!({ "message": "rate limited" })).is_empty());
}

/// `classify_points` is the in-process entry the `mma.classify` host import reaches.
/// Driven against the bundled "light" set so it needs no downloaded archive.
#[test]
fn classify_points_resolves_against_the_bundled_dataset() {
    let out = classify_points("light", &[(48.8566, 2.3522), (0.0, -140.0)]).expect("classifies");
    assert_eq!(out.len(), 2);
    assert!(out[0].is_some(), "Paris should land inside a feature");
    assert_eq!(out[1], None, "mid-Pacific is outside every feature");
}

/// The subdivision provider's real dataset is a download, so this only runs with
/// `--ignored` on a machine that already has borders-adm1.rkyv.
#[test]
#[ignore]
fn classify_points_names_a_subdivision_on_adm1() {
    let out = classify_points("adm1", &[(47.3769, 8.5417)]).expect("classifies");
    assert!(
        out[0].is_some(),
        "Zurich should land inside an adm1 feature"
    );
}
