use std::fs;

use serde_json::{json, Value};

use std::slice;

use super::*;
use crate::procedure::HttpResponse;
use crate::types::{AppError, AppResult};

const RESPONSE_PB: &[u8] = include_bytes!("testdata/getmetadata.pb");
const RESPONSE_JSON: &str = include_str!("testdata/getmetadata.json");
const GOLDEN: &str = include_str!("testdata/getmetadata.golden.json");
const SEARCH_JSON: &str = include_str!("testdata/singleimagesearch.json");
/// The e2e Street View mock hand-encodes its own protobuf, so what it builds is pinned
/// here against the decoder the app actually runs. `svMockProto.test.ts` pins the mock to
/// these same two files, which is what keeps the two halves from drifting apart.
const MOCK_REQUEST_PB: &[u8] = include_bytes!("testdata/svmock.request.pb");
const MOCK_RESPONSE_PB: &[u8] = include_bytes!("testdata/svmock.getmetadata.pb");

/// The panos `testdata/` was captured for, in request order.
const CAPTURED: [&str; 4] = [
    "-zrYsLR4Fh-cfJG_EMZ1-A",
    "5upMz1_zTGPdkIXG6_QM3g",
    "CAoSF0NJSE0wb2dLRUlDQWdJQ0VtX2l4cXdF",
    "AAAAAAAAAAAAAAAAAAAAAA",
];

/// JSON numbers carry no type, so a comparison of decoded panos has to agree on one.
fn numbers(value: &Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64().unwrap_or_default()),
        Value::Array(a) => Value::Array(a.iter().map(numbers).collect()),
        Value::Object(o) => {
            Value::Object(o.iter().map(|(k, v)| (k.clone(), numbers(v))).collect())
        }
        other => other.clone(),
    }
}

fn golden() -> Value {
    numbers(&serde_json::from_str::<Value>(GOLDEN).unwrap())
}

#[test]
fn binary_response_matches_the_typescript_decode() {
    let decoded = serde_json::to_value(decode_response(RESPONSE_PB)).unwrap();
    assert_eq!(numbers(&decoded), golden());
}

#[test]
fn array_json_response_matches_the_binary_one() {
    let root: Value = serde_json::from_str(RESPONSE_JSON).unwrap();
    let images: Vec<Option<Pano>> = root[1]
        .as_array()
        .unwrap()
        .iter()
        .map(decode_image_json)
        .collect();
    let decoded = serde_json::to_value(images).unwrap();
    assert_eq!(numbers(&decoded), golden());
}

#[test]
fn a_response_carrying_no_coverage_decodes_to_nothing() {
    let mut body = Vec::new();
    put_msg(&mut body, 1, |b| put_varint_field(b, 1, 5));
    assert!(decode_response(&body).is_empty());
}

#[test]
fn a_failed_image_decodes_to_none() {
    let images = decode_response(RESPONSE_PB);
    assert_eq!(images.len(), CAPTURED.len());
    assert!(images[3].is_none());
    assert!(images[..3].iter().all(Option::is_some));
}

#[test]
fn every_captured_pano_decodes_to_the_id_it_was_asked_for() {
    for (image, asked) in decode_response(RESPONSE_PB).iter().zip(CAPTURED) {
        if let Some(p) = image {
            assert_eq!(p.pano, asked);
        }
    }
}

#[test]
fn the_ungated_array_decode_reads_a_search_answer() {
    let root: Value = serde_json::from_str(SEARCH_JSON).unwrap();
    let pano = decode_image_json_unchecked(&root[1]).expect("search answer decodes");
    assert!(!pano.pano.is_empty());
    assert!(pano.lat != 0.0 && pano.lng != 0.0);
}

#[test]
fn the_request_round_trips_through_the_reader() {
    let ids: Vec<String> = CAPTURED.iter().map(|s| (*s).to_string()).collect();
    let body = encode_request(&ids);
    let req = Node::proto(&body);
    assert_eq!(req.at(1).str(1), "apiv3");
    assert_eq!(req.at(1).str(5), "en");
    assert_eq!(req.at(2).str(1), "en");
    assert_eq!(req.at(2).str(2), "US");
    let keys: Vec<String> = req
        .all(3)
        .iter()
        .map(|w| {
            let k = w.at(1);
            from_image_key(k.int(1) as i32, k.str(2))
        })
        .collect();
    assert_eq!(keys, ids);
}

#[test]
fn two_digit_years_are_nineteen_hundreds_and_absent_parts_floor_to_one() {
    let mut body = Vec::new();
    put_varint_field(&mut body, 1, 99);
    assert_eq!(civil_date(&schema::PanoDate(Node::proto(&body))), "1999-01-01");

    let mut body = Vec::new();
    put_varint_field(&mut body, 1, 2011);
    put_varint_field(&mut body, 2, 7);
    assert_eq!(civil_date(&schema::PanoDate(Node::proto(&body))), "2011-07-01");

    assert_eq!(civil_date(&schema::PanoDate(Node::json(&json!([])))), "");
    assert_eq!(civil_date(&schema::PanoDate(Node::json(&json!([0, 4, 2])))), "");
    assert_eq!(civil_date(&schema::PanoDate(Node::json(&json!([2020, 4, 2])))), "2020-04-02");
}

fn base() -> Pano {
    Pano {
        pano: String::new(),
        pano_frontend: 2,
        lat: 0.0,
        lng: 0.0,
        altitude: 0.0,
        pov: None,
        world_size: ImageSize {
            width: 0,
            height: 0,
        },
        tile_size: ImageSize {
            width: 0,
            height: 0,
        },
        copyright: String::new(),
        description: String::new(),
        short_description: String::new(),
        uploader_name: None,
        country_code: None,
        level_id: None,
        links: Vec::new(),
        time: Vec::new(),
        date: None,
        source: None,
        image_date: String::new(),
        coverage_dates: Vec::new(),
        center_heading: 0.0,
        camera_frame: CameraFrame {
            heading: 0.0,
            pitch: 0.0,
        },
        camera_type: None,
    }
}

fn camera(height: i32, month: &str, country: Option<&str>) -> Pano {
    Pano {
        world_size: ImageSize { width: 0, height },
        image_date: month.to_string(),
        country_code: country.map(str::to_string),
        ..base()
    }
}

#[test]
fn tile_height_names_the_camera_generation() {
    assert_eq!(camera_type_from_height(1664), Some(CameraType::Gen1));
    assert_eq!(camera_type_from_height(6656), Some(CameraType::Gen2));
    assert_eq!(camera_type_from_height(8192), Some(CameraType::Gen4));
    assert_eq!(camera_type_from_height(13312), None);
}

#[test]
fn scout_refines_only_plain_gen2_and_gen4() {
    let scout = |height| Pano {
        source: Some("scout".into()),
        ..camera(height, "2015-06", None)
    };
    assert_eq!(detect_camera_type(&scout(8192)), Some(CameraType::Trekker));
    assert_eq!(detect_camera_type(&scout(6656)), Some(CameraType::Trekker));
    assert_eq!(detect_camera_type(&scout(1664)), Some(CameraType::Gen1));
    assert_eq!(detect_camera_type(&scout(13312)), None);
}

#[test]
fn a_level_makes_a_gen2_a_tripod() {
    let mut pano = camera(6656, "2015-06", None);
    pano.level_id = Some(0);
    assert_eq!(detect_camera_type(&pano), Some(CameraType::Tripod));
    pano.source = Some("scout".into());
    assert_eq!(detect_camera_type(&pano), Some(CameraType::Tripod));
}

#[test]
fn badcam_needs_the_country_and_a_month_past_its_threshold() {
    assert_eq!(
        detect_camera_type(&camera(6656, "2021-05", Some("BD"))),
        Some(CameraType::Badcam)
    );
    assert_eq!(
        detect_camera_type(&camera(6656, "2021-04", Some("BD"))),
        Some(CameraType::Gen2)
    );
    assert_eq!(
        detect_camera_type(&camera(6656, "2024-01", Some("RU"))),
        Some(CameraType::Gen2)
    );
    assert_eq!(
        detect_camera_type(&camera(6656, "2009-01", Some("CY"))),
        Some(CameraType::Badcam)
    );
    assert_eq!(
        detect_camera_type(&camera(6656, "2000-12", Some("CY"))),
        Some(CameraType::Gen2)
    );
    assert_eq!(
        detect_camera_type(&camera(6656, "", Some("CY"))),
        Some(CameraType::Gen2)
    );
    // The countries sharing one threshold read it the same way as the ones named alone.
    assert_eq!(
        detect_camera_type(&camera(6656, "2021-02", Some("FR"))),
        Some(CameraType::Badcam)
    );
    assert_eq!(
        detect_camera_type(&camera(6656, "2021-01", Some("FR"))),
        Some(CameraType::Gen2)
    );
    // A month outside 01..12 is not a month, so the table is never reached.
    assert_eq!(
        detect_camera_type(&camera(6656, "2024-13", Some("FR"))),
        Some(CameraType::Gen2)
    );
}

#[test]
fn badcam_in_the_united_states_is_a_latitude_rule() {
    let above = Pano {
        lat: 61.0,
        ..camera(6656, "2020-06", Some("US"))
    };
    let below = Pano {
        lat: 40.0,
        ..camera(6656, "2020-06", Some("US"))
    };
    assert_eq!(detect_camera_type(&above), Some(CameraType::Badcam));
    assert_eq!(detect_camera_type(&below), Some(CameraType::Gen2));
}

#[test]
fn the_camera_frame_leans_with_roll() {
    let pano = Pano {
        pov: Some(Pov {
            heading: 90.0,
            tilt: 80.0,
            roll: 90.0,
        }),
        center_heading: 90.0,
        ..base()
    };
    let frame = camera_frame(&pano);
    assert_eq!(frame.heading, 90.0);
    assert!((frame.pitch - 10.0).abs() < 1e-9);
    assert_eq!(camera_frame(&base()).pitch, 0.0);
}


#[test]
fn the_mock_request_fixture_is_what_the_encoder_builds() {
    let ids = ["DEAD_PANO", "-zrYsLR4Fh-cfJG_EMZ1-A"].map(str::to_string);
    assert_eq!(encode_request(&ids), MOCK_REQUEST_PB);
}

#[test]
fn the_mock_answers_the_captured_pano_and_writes_off_the_dead_one() {
    let images = decode_response(MOCK_RESPONSE_PB);
    assert_eq!(images.len(), 2);
    assert!(images[0].is_none());
    let p = images[1].as_ref().expect("the fixture pano decodes");
    assert_eq!(p.pano, "-zrYsLR4Fh-cfJG_EMZ1-A");
    assert!((p.lat - 52.109_475_028_061_08).abs() < 1e-9);
    assert!((p.lng - 34.901_314_108_565_84).abs() < 1e-9);
    assert_eq!(p.country_code.as_deref(), Some("RU"));
    assert!((p.altitude - 142.0).abs() < 1e-3);
    assert_eq!(p.image_date, "2021-09");
    assert_eq!(p.world_size, ImageSize { width: 16384, height: 8192 });
    assert_eq!(p.tile_size, ImageSize { width: 512, height: 512 });
}

// --- SingleImageSearch ---

fn search(lat: f64, lng: f64, radius: f64) -> SearchQuery {
    SearchQuery {
        lat,
        lng,
        radius,
        sources: None,
        preference: None,
        date_range: None,
        components: None,
    }
}

/* The bodies are array-JSON: element position is the protobuf field number, so a shifted
 * or dropped `null` is a silently different request. Pinned literally. */

#[test]
fn the_default_search_body_is_what_the_maps_js_api_sends() {
    assert_eq!(
        encode_search(&search(47.3769, 8.5417, 50.0)),
        r#"[["apiv3"],[[null,null,47.3769,8.5417],50],[null,null,null,null,null,null,null,null,[2],null,[[[2,true,2],[3,true,2],[10,true,2]]]],[[1,2,3,4,8,6]]]"#
    );
}

#[test]
fn a_date_range_becomes_the_capture_time_coverage_probe() {
    let q = SearchQuery {
        sources: Some(vec![2]),
        preference: Some(1),
        date_range: Some((1719835200, 1722513600)),
        components: Some(vec![2, 6]),
        ..search(47.3769, 8.5417, 50.0)
    };
    assert_eq!(
        encode_search(&q),
        r#"[["apiv3"],[[null,null,47.3769,8.5417],50],[[null,null,null,null,null,null,null,null,null,null,[1719835200,1722513600]],null,null,null,null,null,null,null,[1],null,[[[2,true,2]]]],[[2,6]]]"#
    );
}

#[test]
fn sources_narrow_which_collections_are_searched() {
    let q = SearchQuery {
        sources: Some(vec![3, 10]),
        ..search(47.3769, 8.5417, 50.0)
    };
    assert_eq!(
        encode_search(&q),
        r#"[["apiv3"],[[null,null,47.3769,8.5417],50],[null,null,null,null,null,null,null,null,[2],null,[[[3,true,2],[10,true,2]]]],[[1,2,3,4,8,6]]]"#
    );
}

#[test]
fn the_radius_clamps_to_half_the_earths_circumference() {
    assert!(encode_search(&search(0.0, 0.0, -1.0)).contains("[[null,null,0,0],0]"));
    assert!(encode_search(&search(0.0, 0.0, 1e9)).contains("[[null,null,0,0],20037508.342789244]"));
}

#[test]
fn a_search_answer_decodes_to_the_pano_it_found() {
    let pano = decode_search(SEARCH_JSON.as_bytes()).expect("search answer decodes");
    assert_eq!(pano.pano, "CAoSF0NJSE0wb2dLRUlDQWdJQ0VtX2l4cXdF");
    assert!(pano.lat != 0.0 && pano.lng != 0.0);
}

/// A location-search response carrying one image: `[status, ImageMetadata]`.
fn reply(status: i64, key: &Value) -> String {
    json!([[0], [[status], key, null, null, null, [[[1], [[null, null, 1, 2]]]]]]).to_string()
}

#[test]
fn an_ok_search_answer_reads_out_the_whole_pano() {
    let p = decode_search(reply(1, &json!([2, "20C-1_sANr4OMdhTDM2N-g"])).as_bytes()).unwrap();
    assert_eq!(p.pano, "20C-1_sANr4OMdhTDM2N-g");
    assert_eq!((p.lat, p.lng), (1.0, 2.0));
    assert_eq!(
        decode_search(reply(3, &json!([3, "abc"])).as_bytes()).unwrap().pano,
        "F:abc"
    );
    // A missing frontend reads as official, matching the Maps JS API's own default.
    assert_eq!(
        decode_search(reply(1, &json!([null, "20C-1_sANr4OMdhTDM2N-g"])).as_bytes())
            .unwrap()
            .pano,
        "20C-1_sANr4OMdhTDM2N-g"
    );
}

#[test]
fn a_search_answer_that_is_not_coverage_decodes_to_none() {
    assert!(decode_search(b"[[5],[[2]]]").is_none());
    assert!(decode_search(reply(2, &json!([2, "x"])).as_bytes()).is_none());
    assert!(decode_search(reply(1, &Value::Null).as_bytes()).is_none());
    assert!(decode_search(br#"[[0],[[1],[2,"x"]]]"#).is_none());
    assert!(decode_search(b"[[0]]").is_none());
    assert!(decode_search(b"not json").is_none());
    assert!(decode_search(br#"{"a":1}"#).is_none());
}

// --- batching ---

/// Records every request it is handed and answers each from `reply`, which sees the pano
/// ids that request carries.
struct StubHost<F> {
    reply: F,
    rounds: Vec<Vec<Vec<String>>>,
    abort_after: usize,
}

impl<F: Fn(&[String]) -> AppResult<HttpResponse>> StubHost<F> {
    fn new(reply: F) -> Self {
        StubHost {
            reply,
            rounds: Vec::new(),
            abort_after: usize::MAX,
        }
    }

    fn requests(&self) -> Vec<Vec<String>> {
        self.rounds.iter().flatten().cloned().collect()
    }
}

fn asked_for(req: &HttpRequestSpec) -> Vec<String> {
    Node::proto(req.body.as_deref().unwrap_or_default())
        .all(3)
        .iter()
        .map(|w| {
            let k = w.at(1);
            from_image_key(k.int(1) as i32, k.str(2))
        })
        .collect()
}

impl<F: Fn(&[String]) -> AppResult<HttpResponse>> ProcHost for StubHost<F> {
    fn fetch(&mut self, req: &HttpRequestSpec) -> AppResult<HttpResponse> {
        self.fetch_many(slice::from_ref(req))
            .pop()
            .expect("one request answers once")
    }

    fn fetch_many(&mut self, reqs: &[HttpRequestSpec]) -> Vec<AppResult<HttpResponse>> {
        let asked: Vec<Vec<String>> = reqs.iter().map(asked_for).collect();
        let out = asked.iter().map(|ids| (self.reply)(ids)).collect();
        self.rounds.push(asked);
        out
    }

    fn progress(&mut self, _units: u32) {}
    fn fail(&mut self, _id: u32) {}
    fn aborted(&self) -> bool {
        self.rounds.len() >= self.abort_after
    }
}

fn ok(body: Vec<u8>) -> AppResult<HttpResponse> {
    Ok(HttpResponse { status: 200, body })
}

/// A response naming one image per pano, OK where `found` says so.
fn response_for(ids: &[String], found: impl Fn(&str) -> bool) -> Vec<u8> {
    let mut out = Vec::new();
    for id in ids {
        put_msg(&mut out, 2, |m| {
            put_msg(m, 1, |s| put_varint_field(s, 1, u64::from(found(id))));
            if found(id) {
                let (frontend, key) = to_image_key(id);
                put_msg(m, 2, |k| {
                    put_varint_field(k, 1, frontend as u64);
                    put_str(k, 2, &key);
                });
                put_msg(m, 6, |_| {});
            }
        });
    }
    out
}

fn ids(n: usize) -> Vec<String> {
    (0..n).map(|i| format!("pano-{i}")).collect()
}

#[test]
fn a_batch_is_split_at_the_per_request_cap() {
    let panos = ids(BATCH_SIZE + 5);
    let mut host = StubHost::new(|asked: &[String]| ok(response_for(asked, |_| true)));
    let out = fetch_metadata(&mut host, &panos);
    assert_eq!(
        host.requests().iter().map(Vec::len).collect::<Vec<_>>(),
        vec![BATCH_SIZE, 5]
    );
    assert_eq!(host.rounds.len(), 1);
    assert!(out.done.iter().all(|d| *d));
    assert!(out.metas.iter().all(Option::is_some));
}

#[test]
fn a_pano_asked_for_twice_is_fetched_once_and_answered_twice() {
    let panos = ["a", "b", "a", "", "b"].map(str::to_string).to_vec();
    let mut host = StubHost::new(|asked: &[String]| ok(response_for(asked, |_| true)));
    let out = fetch_metadata(&mut host, &panos);
    assert_eq!(host.requests(), vec![vec!["a".to_string(), "b".to_string()]]);
    assert_eq!(out.done, vec![true, true, true, false, true]);
    assert_eq!(out.metas[0], out.metas[2]);
    // An empty id is never asked for, so it never reaches a verdict.
    assert!(out.metas[3].is_none());
}

#[test]
fn an_all_null_batch_is_bisected_until_the_poisoned_pano_stands_alone() {
    let panos = ids(4);
    let mut host = StubHost::new(|asked: &[String]| {
        ok(response_for(asked, |id| {
            id != "pano-2" && !asked.contains(&"pano-2".to_string())
        }))
    });
    let out = fetch_metadata(&mut host, &panos);
    assert_eq!(host.requests().last().unwrap().len(), 1);
    assert_eq!(out.done, vec![true; 4]);
    assert_eq!(out.failed, vec![false; 4]);
    assert!(out.metas[2].is_none());
    assert!(out.metas[0].is_some() && out.metas[1].is_some() && out.metas[3].is_some());
}

#[test]
fn only_a_pano_that_fails_alone_is_marked_failed() {
    let panos = ids(2);
    let mut host = StubHost::new(|asked: &[String]| {
        if asked.contains(&"pano-1".to_string()) {
            return Err(AppError("boom".into()));
        }
        ok(response_for(asked, |_| true))
    });
    let out = fetch_metadata(&mut host, &panos);
    assert_eq!(out.done, vec![true, true]);
    assert_eq!(out.failed, vec![false, true]);
    assert!(out.metas[0].is_some());
}

#[test]
fn a_non_2xx_answer_is_a_failure_like_any_other() {
    let mut host = StubHost::new(|_: &[String]| {
        Ok(HttpResponse {
            status: 500,
            body: Vec::new(),
        })
    });
    let out = fetch_metadata(&mut host, &ids(1));
    assert_eq!(out.failed, vec![true]);
}

#[test]
fn a_cancelling_run_leaves_its_rows_unfinished() {
    let mut host = StubHost::new(|_: &[String]| Err(AppError("boom".into())));
    host.abort_after = 1;
    let out = fetch_metadata(&mut host, &ids(1));
    assert_eq!(out.done, vec![false]);
    assert_eq!(out.failed, vec![false]);
}

// --- resolve: one call answers both query kinds ---

fn id_query(id: &str) -> PanoQuery {
    PanoQuery::Id(IdQuery { pano_id: id.into() })
}

/// Routes by URL: searches answer a fixed found pano (or fail), metadata answers every
/// asked-for id.
struct SplitStub {
    search_bodies: Vec<String>,
    meta_rounds: usize,
    fail_searches: bool,
    no_coverage: bool,
    abort: bool,
}

impl SplitStub {
    fn new() -> Self {
        SplitStub {
            search_bodies: Vec::new(),
            meta_rounds: 0,
            fail_searches: false,
            no_coverage: false,
            abort: false,
        }
    }
}

impl ProcHost for SplitStub {
    fn fetch(&mut self, req: &HttpRequestSpec) -> AppResult<HttpResponse> {
        self.fetch_many(slice::from_ref(req))
            .pop()
            .expect("one request answers once")
    }

    fn fetch_many(&mut self, reqs: &[HttpRequestSpec]) -> Vec<AppResult<HttpResponse>> {
        reqs.iter()
            .map(|req| {
                if req.url == SINGLE_IMAGE_SEARCH_URL {
                    self.search_bodies
                        .push(String::from_utf8_lossy(req.body.as_deref().unwrap_or_default()).into_owned());
                    if self.fail_searches {
                        return Err(AppError("boom".into()));
                    }
                    let status = if self.no_coverage { 2 } else { 1 };
                    ok(reply(status, &json!([2, "20C-1_sANr4OMdhTDM2N-g"])).into_bytes())
                } else {
                    self.meta_rounds += 1;
                    ok(response_for(&asked_for(req), |_| true))
                }
            })
            .collect()
    }

    fn progress(&mut self, _units: u32) {}
    fn fail(&mut self, _id: u32) {}
    fn aborted(&self) -> bool {
        self.abort
    }
}

#[test]
fn queries_of_both_kinds_answer_aligned_to_the_input() {
    let queries = vec![
        id_query("pano-0"),
        PanoQuery::Search(search(1.0, 2.0, 50.0)),
        id_query(""),
        id_query("pano-1"),
    ];
    let mut host = SplitStub::new();
    let answers = resolve_panos(&mut host, &queries);
    assert!(matches!(&answers[0], PanoAnswer::Found { pano } if pano.pano == "pano-0"));
    assert!(
        matches!(&answers[1], PanoAnswer::Found { pano } if pano.pano == "20C-1_sANr4OMdhTDM2N-g")
    );
    assert_eq!(answers[2], PanoAnswer::Skipped);
    assert!(matches!(&answers[3], PanoAnswer::Found { pano } if pano.pano == "pano-1"));
    assert_eq!(host.search_bodies, vec![encode_search(&search(1.0, 2.0, 50.0))]);
    assert_eq!(host.meta_rounds, 1);
}

#[test]
fn a_search_without_coverage_is_not_found_and_a_failed_one_is_failed() {
    let queries = vec![PanoQuery::Search(search(1.0, 2.0, 50.0))];
    let mut host = SplitStub::new();
    host.no_coverage = true;
    assert_eq!(resolve_panos(&mut host, &queries), vec![PanoAnswer::NotFound]);
    let mut host = SplitStub::new();
    host.fail_searches = true;
    assert_eq!(resolve_panos(&mut host, &queries), vec![PanoAnswer::Failed]);
}

#[test]
fn a_search_declined_by_a_cancelling_run_is_skipped() {
    let queries = vec![PanoQuery::Search(search(1.0, 2.0, 50.0))];
    let mut host = SplitStub::new();
    host.fail_searches = true;
    host.abort = true;
    assert_eq!(resolve_panos(&mut host, &queries), vec![PanoAnswer::Skipped]);
}

/// The guest sends plain objects; which variant one lands on is the wire contract.
#[test]
fn a_guest_query_object_lands_on_the_right_variant() {
    let q: Vec<PanoQuery> = serde_json::from_str(
        r#"[{"panoId":"x"},{"lat":1,"lng":2,"radius":50},{"lat":1,"lng":2,"radius":50,"dateRange":[3,4],"sources":[2],"preference":1,"components":[2,6]}]"#,
    )
    .unwrap();
    assert!(matches!(&q[0], PanoQuery::Id(i) if i.pano_id == "x"));
    assert!(matches!(&q[1], PanoQuery::Search(s) if s.date_range.is_none()));
    assert!(matches!(&q[2], PanoQuery::Search(s)
        if s.date_range == Some((3, 4))
            && s.sources.as_deref() == Some(&[2][..])
            && s.preference == Some(1)
            && s.components.as_deref() == Some(&[2, 6][..])));
}

/// exactDate's verdict is `decode_search` over a `[2,6]`-component probe answer, so both
/// verdicts are pinned against live captures.
#[test]
fn a_timestamp_probe_answer_reads_as_coverage_or_not() {
    let hit = decode_search(include_str!("testdata/timestampsearch.hit.json").as_bytes());
    assert!(hit.is_some_and(|p| !p.pano.is_empty()));
    assert!(decode_search(include_str!("testdata/timestampsearch.miss.json").as_bytes()).is_none());
}

const TESTDATA: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/sv/testdata");
const JSON_RPC: &str = "application/json+protobuf";
const RPC: &str = "https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService";

/// Refreshes `testdata/` from the live RPC and checks the encoder against it:
/// `cargo test -p map-making-app -- --ignored capture`.
#[test]
#[ignore = "hits Google's live RPC"]
fn capture() {
    use crate::net::proxy::proxy_client;
    use rustls::crypto::ring::default_provider;

    let _ = default_provider().install_default();
    let client = proxy_client();
    let ids: Vec<String> = CAPTURED.iter().map(|s| (*s).to_string()).collect();

    let binary = client
        .post(format!("{RPC}/GetMetadata"))
        .header("content-type", "application/x-protobuf")
        .header("x-user-agent", "grpc-web-javascript/0.1")
        .body(encode_request(&ids))
        .send()
        .unwrap()
        .bytes()
        .unwrap();
    fs::write(format!("{TESTDATA}/getmetadata.pb"), &binary).unwrap();

    let keys: Vec<Value> = ids
        .iter()
        .map(|id| {
            let (frontend, key) = to_image_key(id);
            json!([[frontend, key]])
        })
        .collect();
    let request = json!([["apiv3", null, null, null, "en"], ["en", "US"], keys, [[1, 2, 3, 4, 8, 6]]]);
    let array = client
        .post(format!("{RPC}/GetMetadata"))
        .header("content-type", JSON_RPC)
        .header("x-user-agent", "grpc-web-javascript/0.1")
        .body(request.to_string())
        .send()
        .unwrap()
        .text()
        .unwrap();
    fs::write(format!("{TESTDATA}/getmetadata.json"), &array).unwrap();

    let search = client
        .post(format!("{RPC}/SingleImageSearch"))
        .header("content-type", JSON_RPC)
        .header("x-user-agent", "grpc-web-javascript/0.1")
        .body(
            json!([
                ["apiv3"],
                [[null, null, 48.858_37, 2.294_481], 50],
                [null, null, null, null, null, null, null, null, [2], null, [[[10, true, 2]]]],
                [[1, 2, 3, 4, 8, 6]]
            ])
            .to_string(),
        )
        .send()
        .unwrap()
        .text()
        .unwrap();
    fs::write(format!("{TESTDATA}/singleimagesearch.json"), &search).unwrap();

    let from_binary = numbers(&serde_json::to_value(decode_response(&binary)).unwrap());
    let root: Value = serde_json::from_str(&array).unwrap();
    let from_array: Vec<Option<Pano>> = root[1]
        .as_array()
        .unwrap()
        .iter()
        .map(decode_image_json)
        .collect();
    assert_eq!(
        from_binary,
        numbers(&serde_json::to_value(from_array).unwrap())
    );
}

/// Refreshes the timestamp-probe fixtures: one window with coverage at the point, one
/// without: `cargo test -p map-making-app -- --ignored capture_timestamp`.
#[test]
#[ignore = "hits Google's live RPC"]
fn capture_timestamp() {
    use crate::net::proxy::proxy_client;
    use rustls::crypto::ring::default_provider;

    let _ = default_provider().install_default();
    let client = proxy_client();
    let probe = |window: (i64, i64)| {
        let q = SearchQuery {
            sources: Some(vec![2]),
            preference: Some(1),
            date_range: Some(window),
            components: Some(vec![2, 6]),
            ..search(47.37677, 8.54078, 50.0)
        };
        client
            .post(format!("{RPC}/SingleImageSearch"))
            .header("content-type", JSON_RPC)
            .header("x-user-agent", "grpc-web-javascript/0.1")
            .body(encode_search(&q))
            .send()
            .unwrap()
            .text()
            .unwrap()
    };
    let hit = probe((946684800, 1893456000));
    let miss = probe((315532800, 473385600));
    assert!(hit != miss, "the two windows must answer differently");
    fs::write(format!("{TESTDATA}/timestampsearch.hit.json"), hit).unwrap();
    fs::write(format!("{TESTDATA}/timestampsearch.miss.json"), miss).unwrap();
}
