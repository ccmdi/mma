//! Border archive tests: the archived (mmap'd) geometry path must agree bit-for-bit with
//! the owned GeoJSON path, and the offline artifact generator.

use super::{
    arch_feature_bbox, arch_point_in_feature, arch_to_geometry, classify_points, classify_scan,
    convert_dataset, git_blob_sha1, parse_border_shas, refresh_stale_archive, ArchDataset,
    ArchFeature,
};
use crate::selections::{self, PolygonGeometry};
use crate::test_util::TempDir;
use std::fs;
use std::path::{Path, PathBuf};

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

/// The startup refresh downloads only for an installed archive whose blob id differs from
/// upstream's; a missing file, a missing remote id, or a matching id all leave it alone.
#[test]
fn refresh_stale_archive_downloads_only_on_a_changed_blob() {
    let dir = TempDir::new("borders-refresh");
    let path = dir.join("borders-medium.rkyv");
    let fetched = || Ok(b"new".to_vec());
    let never = || panic!("fetched without a stale archive");
    let same = git_blob_sha1(b"old");
    let other = git_blob_sha1(b"new");

    assert!(!refresh_stale_archive(&path, Some(&other), never).unwrap());

    fs::write(&path, b"old").unwrap();
    assert!(!refresh_stale_archive(&path, None, never).unwrap());
    assert!(!refresh_stale_archive(&path, Some(&same), never).unwrap());
    assert_eq!(fs::read(&path).unwrap(), b"old");

    assert!(refresh_stale_archive(&path, Some(&other), fetched).unwrap());
    assert_eq!(fs::read(&path).unwrap(), b"new");
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

// --- Shipped tiers vs the bundled light taxonomy ---

/// (label, lat, lng). The anchor set the tier comparison harness uses: one point per
/// taxonomy split the light set carries, plus coastal roads that a land-only polygon
/// misses without seaward padding.
const ANCHORS: &[(&str, f64, f64)] = &[
    ("Paris", 48.8566, 2.3522),
    ("Nice promenade", 43.6947, 7.2653),
    ("Ajaccio", 41.9192, 8.7386),
    ("Monaco", 43.7384, 7.4246),
    ("Cayenne", 4.9224, -52.3135),
    ("St-Denis Reunion", -20.8789, 55.4481),
    ("Pointe-a-Pitre", 16.2410, -61.5330),
    ("Papeete", -17.5350, -149.5696),
    ("Noumea", -22.2758, 166.4580),
    ("Nazare", 39.6019, -9.0712),
    ("Venice S.Marco", 45.4340, 12.3388),
    ("Amalfi road", 40.6340, 14.6027),
    ("Dubrovnik", 42.6403, 18.1077),
    ("Bondi", -33.8908, 151.2743),
    ("Copacabana", -22.9711, -43.1822),
    ("Malibu PCH", 34.0370, -118.6770),
    ("Waikiki", 21.2760, -157.8270),
    ("Miami Beach", 25.7907, -80.1300),
    ("Marine Drive", 18.9442, 72.8230),
    ("Reykjavik Harpa", 64.1503, -21.9325),
    ("Sea Point", -33.9130, 18.3830),
    ("Gold Coast", -28.0028, 153.4300),
    ("Roxas Blvd", 14.5610, 120.9830),
    ("HK TST", 22.2932, 114.1722),
    ("Marina Bay", 1.2830, 103.8600),
    ("Odaiba", 35.6300, 139.7750),
    ("Alesund", 62.4722, 6.1549),
    ("Brighton pier", 50.8170, -0.1370),
    ("Santa Monica pier", 34.0086, -118.4977),
    ("Anchorage", 61.2181, -149.9003),
    ("Tenerife", 28.4636, -16.2518),
    ("Madeira", 32.6669, -16.9241),
    ("Svalbard", 78.2232, 15.6267),
    ("Nuuk", 64.1836, -51.7214),
    ("San Juan PR", 18.4655, -66.1057),
    ("Kaliningrad", 54.7104, 20.4522),
    ("Ceuta", 35.8894, -5.3213),
    ("Pristina", 42.6629, 21.1655),
    ("Gibraltar", 36.1408, -5.3536),
    ("Stanley FK", -51.6977, -57.8517),
    ("Guam", 13.4443, 144.7937),
    ("Willemstad", 12.1224, -68.8824),
    ("Taipei", 25.0330, 121.5654),
    ("Simferopol", 44.9521, 34.1024),
    ("Okinawa Naha", 26.2124, 127.6809),
    ("Tasmania Hobart", -42.8821, 147.3272),
    ("Sardinia Cagliari", 39.2238, 9.1217),
];

/// Roughly 5 km in degrees of latitude; the margin inside which a light boundary and a
/// higher-fidelity one are allowed to disagree.
const INLAND_MARGIN: f64 = 0.045;

fn repo_borders() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/borders")
}

fn light_features() -> Vec<(super::BorderFeature, Option<[f64; 4]>)> {
    super::parse_geojson(include_str!("../../data/borders.json"))
        .unwrap()
        .into_iter()
        .map(|f| {
            let bb = selections::geometry_bbox(&f.geometry);
            (f, bb)
        })
        .collect()
}

fn light_names(
    feats: &[(super::BorderFeature, Option<[f64; 4]>)],
    lat: f64,
    lng: f64,
) -> Vec<&str> {
    feats
        .iter()
        .filter(|(f, bb)| {
            matches!(bb, Some(bb) if selections::in_bbox(lng, lat, bb))
                && selections::point_in_geometry(lng, lat, &f.geometry)
        })
        .map(|(f, _)| f.name.as_str())
        .collect()
}

fn distinct<'a>(names: &[&'a str]) -> Vec<&'a str> {
    let mut out: Vec<&str> = names.to_vec();
    out.sort_unstable();
    out.dedup();
    out
}

/// Squared distance from a point to a ring's segments, in degrees.
fn ring_dist_sq(lng: f64, lat: f64, ring: &[[f64; 2]]) -> f64 {
    let mut best = f64::MAX;
    for w in ring.windows(2) {
        let (a, b) = (w[0], w[1]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len_sq = dx * dx + dy * dy;
        let t = if len_sq > 0.0 {
            (((lng - a[0]) * dx + (lat - a[1]) * dy) / len_sq).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let (px, py) = (a[0] + t * dx, a[1] + t * dy);
        best = best.min((lng - px).powi(2) + (lat - py).powi(2));
    }
    best
}

fn far_inside(geom: &PolygonGeometry, lng: f64, lat: f64, margin: f64) -> bool {
    let rings = geom
        .coordinates
        .iter()
        .chain(geom.extra_polygons.iter().flatten().flatten());
    let m2 = margin * margin;
    rings.map(|r| ring_dist_sq(lng, lat, r)).all(|d| d > m2)
}

struct Tier {
    level: &'static str,
    bytes: Vec<u8>,
}

fn tiers() -> Vec<Tier> {
    ["medium", "heavy"]
        .into_iter()
        .filter_map(|level| {
            fs::read(repo_borders().join(format!("borders-{level}.rkyv")))
                .ok()
                .map(|bytes| Tier { level, bytes })
        })
        .collect()
}

/// Both downloadable tiers carry the same taxonomy as the bundled light set: the same
/// features, the same answer at every anchor, one answer per point, and agreement with
/// light everywhere further than 5 km from a light boundary.
#[test]
fn border_tiers_agree_with_light() {
    let light = light_features();
    let tiers = tiers();
    assert!(!tiers.is_empty(), "no border archives in data/borders");

    for tier in &tiers {
        let level = tier.level;
        let archived = rkyv::check_archived_root::<ArchDataset>(&tier.bytes[..])
            .unwrap_or_else(|e| panic!("borders-{level}.rkyv is corrupt: {e:?}"));
        let feats: Vec<_> = archived
            .features
            .iter()
            .map(|f| (arch_feature_bbox(f), f))
            .collect();
        let names = |lat: f64, lng: f64| -> Vec<&str> {
            feats
                .iter()
                .filter(|(bb, f)| {
                    matches!(bb, Some(bb) if selections::in_bbox(lng, lat, bb))
                        && arch_point_in_feature(lng, lat, f)
                })
                .map(|(_, f)| f.name.as_str())
                .collect()
        };

        for (props, _) in &light {
            let hit = archived
                .features
                .iter()
                .find(|f| f.name == props.name && f.code == props.code);
            let hit = hit.unwrap_or_else(|| {
                panic!(
                    "{level}: light feature {} ({}) is missing",
                    props.name, props.code
                )
            });
            assert!(
                !hit.rings.is_empty() || !hit.extra.is_empty(),
                "{level}: {} has empty geometry",
                props.name
            );
        }

        for &(label, lat, lng) in ANCHORS {
            let want = distinct(&light_names(&light, lat, lng));
            let got = distinct(&names(lat, lng));
            assert_eq!(got.len(), 1, "{level}: {label} resolves to {got:?}");
            assert_eq!(got, want, "{level}: {label}");
        }

        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let mut rng = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut checked = 0;
        for _ in 0..40_000 {
            let lat = rng() * 140.0 - 60.0;
            let lng = rng() * 360.0 - 180.0;
            let hits = light_names(&light, lat, lng);
            let [want] = distinct(&hits)[..] else {
                continue;
            };
            let inside = light
                .iter()
                .find(|(f, _)| f.name == want)
                .is_some_and(|(f, _)| far_inside(&f.geometry, lng, lat, INLAND_MARGIN));
            if !inside {
                continue;
            }
            let got = distinct(&names(lat, lng));
            if got.is_empty() {
                continue; // light's coastlines reach far out to sea; the tiers stop at the coast
            }
            assert_eq!(got, vec![want], "{level}: ({lat:.4}, {lng:.4})");
            checked += 1;
            if checked == 400 {
                break;
            }
        }
        assert!(checked > 200, "{level}: only {checked} deep-inland samples");
    }
}
