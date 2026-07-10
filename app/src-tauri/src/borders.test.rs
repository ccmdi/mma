//! Border archive tests: the archived (mmap'd) geometry path must agree bit-for-bit with
//! the owned GeoJSON path, and the offline artifact generator.

use super::{
    arch_feature_bbox, arch_point_in_feature, arch_to_geometry, convert_dataset, ArchDataset,
    ArchFeature,
};
use crate::selections::{self, PolygonGeometry};

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

/// Regenerate the shipped border archives from their GeoJSON sources. Not part of the
/// normal suite -- run on purpose when a source dataset changes:
///   cargo test -p map-making-app gen_rkyv_artifacts -- --ignored --nocapture
/// then commit the updated `data/borders/borders-{level}.rkyv` files.
#[test]
#[ignore]
fn gen_rkyv_artifacts() {
    let repo_borders = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/borders");
    for level in ["medium", "heavy", "adm1"] {
        let json = std::fs::read_to_string(repo_borders.join(format!("borders-{level}.json")))
            .unwrap_or_else(|e| panic!("read borders-{level}.json: {e}"));
        let bytes = convert_dataset(&json).unwrap();
        let out = repo_borders.join(format!("borders-{level}.rkyv"));
        std::fs::write(&out, &bytes).unwrap();
        println!(
            "borders-{level}: {:.1}MB JSON -> {:.1}MB rkyv",
            json.len() as f64 / 1e6,
            bytes.len() as f64 / 1e6
        );
    }
}
