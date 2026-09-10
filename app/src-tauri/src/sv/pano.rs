//! A decoded Street View panorama: the flattened GetMetadata image plus the facts derived
//! from it at decode time.

use std::collections::HashMap;
use std::f64::consts::PI;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;

use crate::procedure::{HttpRequestSpec, ProcHost};
use crate::store::maps::CameraType;
use crate::sv::pano_id::{from_image_key, to_image_key};
use crate::sv::schema::owned::{ImageSize, PanoDate, Pov};
use crate::sv::schema::{
    self, GetMetadataRequest, GetMetadataResponse, ImageMetadata, PanoType, RankingStrategy,
    SingleImageSearchRequest, SingleImageSearchResponse,
};
use crate::sv::wire::{put_msg, put_str, put_varint_field, Node};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PanoLink {
    pub pano: String,
    pub heading: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PanoTime {
    pub pano: String,
    /// The civil day, `YYYY-MM-DD`.
    pub date: String,
}

/// Where the camera looks: the heading it faces and its pitch off level, in degrees.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CameraFrame {
    pub heading: f64,
    pub pitch: f64,
}

/// A decoded Street View panorama: flat data with no live objects.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Pano {
    /// This image's own pano id, "" when the response carries no key.
    pub pano: String,
    /// Which imagery collection the id belongs to; also what `extra.panoType` stores.
    pub pano_frontend: i32,
    pub lat: f64,
    pub lng: f64,
    pub altitude: f64,
    /// The camera's orientation. The Maps JS API builds its whole tile frame out of this.
    pub pov: Option<Pov>,
    pub world_size: ImageSize,
    pub tile_size: ImageSize,
    pub copyright: String,
    /// `description.description[].text`, joined with ", ".
    pub description: String,
    /// The first of those parts alone, which is what the Maps JS API calls the short description.
    pub short_description: String,
    pub uploader_name: Option<String>,
    pub country_code: Option<String>,
    /// Non-null marks an indoor/tripod pano; a level carrying no id still counts.
    pub level_id: Option<u64>,
    /// Neighbouring panos, resolved to ids.
    pub links: Vec<PanoLink>,
    /// Capture timeline, ascending.
    pub time: Vec<PanoTime>,
    /// This image's own capture date; month and day are 0 when absent.
    pub date: Option<PanoDate>,
    /// "launch" = car, "scout" = the special-collects pipeline.
    pub source: Option<String>,
    /// This image's own capture month as `YYYY-MM`, "" when it carries no date.
    pub image_date: String,
    /// Every capture month in the timeline, ascending.
    pub coverage_dates: Vec<String>,
    /// The heading at the horizontal centre of the image, which is also the driving
    /// direction on car coverage.
    pub center_heading: f64,
    pub camera_frame: CameraFrame,
    pub camera_type: Option<CameraType>,
}

/// 200 is GetMetadata's hard per-request cap.
pub const BATCH_SIZE: usize = 200;

pub const GET_METADATA_URL: &str =
    "https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetMetadata";

pub fn encode_request(pano_ids: &[String]) -> Vec<u8> {
    let mut out = Vec::new();
    put_msg(&mut out, GetMetadataRequest::CONTEXT, |b| {
        put_str(b, schema::RequestContext::CLIENT, "apiv3");
        put_str(b, schema::RequestContext::LANGUAGE, "en");
    });
    put_msg(&mut out, GetMetadataRequest::LOCALE, |b| {
        put_str(b, schema::LocalizationContext::LANGUAGE, "en");
        put_str(b, schema::LocalizationContext::REGION_CODE, "US");
    });
    for id in pano_ids {
        let (frontend, key) = to_image_key(id);
        put_msg(&mut out, GetMetadataRequest::KEY, |b| {
            put_msg(b, schema::KeyWrapper::KEY, |k| {
                if frontend != 0 {
                    put_varint_field(k, schema::ImageKey::FRONTEND, frontend as u64);
                }
                if !key.is_empty() {
                    put_str(k, schema::ImageKey::ID, &key);
                }
            });
        });
    }
    put_msg(&mut out, GetMetadataRequest::SPEC, |b| {
        for component in [1, 2, 3, 4, 8, 6] {
            put_varint_field(b, schema::MetadataResponseSpecification::COMPONENT, component);
        }
    });
    out
}

/// Every image in a response, aligned to the request. Empty when the response as a whole
/// reports no coverage (status 3 or 5), which writes off the request the same way.
pub fn decode_response(body: &[u8]) -> Vec<Option<Pano>> {
    let resp = GetMetadataResponse(Node::proto(body));
    match resp.status().code() {
        3 | 5 => Vec::new(),
        _ => resp.metadata().iter().map(decode_image).collect(),
    }
}

/// A `Pano` from array-JSON, gated on the image's own status.
#[allow(
    dead_code,
    reason = "the gate has no caller: a search answer reports its own status codes"
)]
pub fn decode_image_json(value: &Value) -> Option<Pano> {
    decode_image(&ImageMetadata(Node::json(value)))
}

/// As above, for a caller that checked the status itself.
#[allow(dead_code, reason = "the tests decode captured search answers through it")]
pub fn decode_image_json_unchecked(value: &Value) -> Option<Pano> {
    project(&ImageMetadata(Node::json(value)))
}

fn decode_image(m: &ImageMetadata) -> Option<Pano> {
    (m.status().code() == 1).then(|| project(m)).flatten()
}

fn key_to_pano_id(key: &schema::ImageKey) -> String {
    if key.present() {
        from_image_key(key.frontend() as i32, key.id())
    } else {
        String::new()
    }
}

fn project(m: &ImageMetadata) -> Option<Pano> {
    let info = m.information().into_iter().next()?;
    let loc = info.location();
    let key = m.pano();
    let pano = key_to_pano_id(&key);
    let parts: Vec<&str> = m
        .description()
        .description()
        .iter()
        .map(schema::LocalizedText::text)
        .collect();
    let relations: Vec<String> = info
        .relations()
        .pano()
        .iter()
        .map(|p| key_to_pano_id(&p.key()))
        .collect();
    let neighbour = |target: i64| relations.get(target as usize).cloned().unwrap_or_default();

    let tiles = m.tiles();
    let world = tiles.world_size();
    let tile = tiles.tile_size().tile_size();
    let attribution = m.attribution();
    let pov = loc.pov();
    let level = loc.level();
    let taken = m.date().date();

    let mut time: Vec<PanoTime> = info
        .time()
        .iter()
        .map(|t| PanoTime {
            pano: match neighbour(t.target()) {
                id if id.is_empty() => pano.clone(),
                id => id,
            },
            date: civil_date(&t.date()),
        })
        .chain([PanoTime {
            pano: pano.clone(),
            date: civil_date(&taken),
        }])
        .filter(|t| !t.date.is_empty())
        .collect();
    time.sort_by(|a, b| a.date.cmp(&b.date));

    let mut out = Pano {
        pano_frontend: match key.frontend() as i32 {
            0 => i32::from(PanoType::OFFICIAL),
            frontend => frontend,
        },
        pano,
        world_size: world.to_owned(),
        tile_size: tile.to_owned(),
        copyright: attribution
            .item()
            .first()
            .map(|item| item.name().name())
            .unwrap_or_default()
            .to_string(),
        description: parts.join(", "),
        short_description: parts.first().copied().unwrap_or_default().to_string(),
        uploader_name: attribution
            .author()
            .first()
            .and_then(|author| some_text(author.name().text())),
        lat: loc.location().lat(),
        lng: loc.location().lng(),
        altitude: loc.altitude().meters(),
        pov: pov.present().then(|| pov.to_owned()),
        country_code: some_text(loc.country_code()),
        level_id: level.present().then(|| level.id()),
        links: info
            .link()
            .iter()
            .map(|l| PanoLink {
                pano: neighbour(l.target()),
                heading: l.properties().heading(),
            })
            .collect(),
        coverage_dates: time.iter().map(|t| t.date[..7].to_string()).collect(),
        time,
        date: taken.present().then(|| taken.to_owned()),
        source: some_text(m.date().source_info().source()),
        image_date: String::new(),
        center_heading: 0.0,
        camera_frame: CameraFrame {
            heading: 0.0,
            pitch: 0.0,
        },
        camera_type: None,
    };
    out.image_date = image_month(out.date.as_ref());
    out.center_heading = out.pov.as_ref().map_or(0.0, |p| p.heading);
    out.camera_frame = camera_frame(&out);
    out.camera_type = detect_camera_type(&out);
    Some(out)
}

fn some_text(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

/// "" for no date at all. Two-digit years are 19xx; month and day of 0 are the protobuf
/// default meaning absent, and timeline entries routinely omit the day, so both floor to 1.
fn civil_date(d: &schema::PanoDate) -> String {
    let year = d.year();
    if !d.present() || year <= 0 {
        return String::new();
    }
    let year = if year <= 99 { year + 1900 } else { year };
    format!("{year:04}-{:02}-{:02}", d.month().max(1), d.day().max(1))
}

fn image_month(date: Option<&PanoDate>) -> String {
    match date {
        Some(d) if d.year > 0 => format!("{:04}-{:02}", d.year, d.month),
        _ => String::new(),
    }
}

fn camera_frame(p: &Pano) -> CameraFrame {
    let heading = p.center_heading;
    let (tilt, roll) = p.pov.as_ref().map_or((90.0, 0.0), |v| (v.tilt, v.roll));
    CameraFrame {
        heading,
        pitch: (90.0 - tilt) * ((heading - roll) * PI / 180.0).cos(),
    }
}

// --- camera type ---

/// Coverage from this month on carries the low-resolution rig rather than the gen3 one.
fn is_badcam(country: &str, month: &str, lat: f64) -> bool {
    match country {
        "BD" => month > "2021-04",
        "EC" => month > "2022-03",
        "FI" => month > "2020-09",
        "IN" => month > "2021-10",
        "KH" => month > "2022-10",
        "LB" => month > "2021-01",
        "LK" => month > "2021-02",
        "NG" => month > "2021-06",
        "NP" | "VN" => month > "2020-01",
        "US" => lat > 52.0 && month > "2019-01",
        "AT" | "BG" | "CZ" | "DK" | "EE" | "ES" | "FR" | "GB" | "GR" | "HR" | "IT" | "LT"
        | "LV" | "PL" | "PT" | "RO" | "SE" => month > "2021-01",
        "CY" | "ST" => true,
        _ => false,
    }
}

fn is_month(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && matches!((b[5], b[6]), (b'0', b'1'..=b'9') | (b'1', b'0'..=b'2'))
}

/// Map panorama tile worldSize height to camera generation.
pub fn camera_type_from_height(height: i32) -> Option<CameraType> {
    match height {
        1664 => Some(CameraType::Gen1),
        6656 => Some(CameraType::Gen2),
        8192 => Some(CameraType::Gen4),
        _ => None,
    }
}

/// Best-effort: limited by Google's own tagging. Known edge cases:
/// - `source` "scout" = the special-collects pipeline (trekker/snowmobile/museum tripod),
///   not literally "trekker"; ~2012-2014 collects are tagged sloppily both ways
///   (tripods without a level read as trekker, trekkers with one read as tripod).
/// - Modern Google-ops on-foot gen4 collects are tagged "launch" like cars, so they read as gen4.
/// - scout only refines plain gen2/gen4 results; badcam/tripod/gen1 take precedence
///   (indoor tripods are also scout).
pub fn detect_camera_type(m: &Pano) -> Option<CameraType> {
    let scout = m.source.as_deref() == Some("scout");
    let base = camera_type_from_height(m.world_size.height);
    if base != Some(CameraType::Gen2) {
        return match (base, scout) {
            (Some(CameraType::Gen4), true) => Some(CameraType::Trekker),
            _ => base,
        };
    }
    let month = m.image_date.as_str();
    if is_month(month)
        && month > "2000-12"
        && is_badcam(m.country_code.as_deref().unwrap_or_default(), month, m.lat)
    {
        return Some(CameraType::Badcam);
    }
    if m.level_id.is_some() {
        return Some(CameraType::Tripod);
    }
    Some(if scout {
        CameraType::Trekker
    } else {
        CameraType::Gen2
    })
}


// --- SingleImageSearch ---

pub const SINGLE_IMAGE_SEARCH_URL: &str =
    "https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch";

/// Half the Earth's circumference: the radius clamp the Maps JS API applies.
const MAX_RADIUS: f64 = 6378137.0 * PI;

/// The full SingleImageSearch request surface. Every optional field defaults to what the
/// Maps JS API sends for `getPanorama({location, radius})`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub lat: f64,
    pub lng: f64,
    pub radius: f64,
    /// Frontends to search, as `PanoType` values; all of them when absent.
    #[serde(default)]
    pub sources: Option<Vec<u8>>,
    /// A `RankingStrategy` value; closest when absent, matching the wire default.
    #[serde(default)]
    pub preference: Option<u8>,
    /// Only coverage captured in `(start, end]`, Unix seconds.
    #[serde(default)]
    pub date_range: Option<(i64, i64)>,
    /// Component mask; the full set when absent.
    #[serde(default)]
    pub components: Option<Vec<u32>>,
}

/// One pano lookup: a pano id resolves over GetMetadata, a search over SingleImageSearch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum PanoQuery {
    Id(IdQuery),
    Search(SearchQuery),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IdQuery {
    pub pano_id: String,
}

/// What one query resolved to. `skipped` is a query the host never answered: an aborted
/// run, or an id query whose id is empty.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum PanoAnswer {
    Found { pano: Box<Pano> },
    NotFound,
    Failed,
    Skipped,
}

/// A number the way `JSON.stringify` prints it: integral values without a fraction.
fn num(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9e15 {
        Value::from(v as i64)
    } else {
        Value::from(v)
    }
}

/// An array-JSON message: field n at index n-1, nulls between, sized to the highest
/// field set - exactly as the Maps JS API prints one.
fn slots(fields: Vec<(u32, Value)>) -> Value {
    let len = fields.iter().map(|(n, _)| *n).max().unwrap_or(0) as usize;
    let mut out = vec![Value::Null; len];
    for (n, v) in fields {
        out[n as usize - 1] = v;
    }
    Value::Array(out)
}

/// The array-JSON request body, byte-identical to what the Maps JS API sends.
pub fn encode_search(q: &SearchQuery) -> String {
    let radius = q.radius.clamp(0.0, MAX_RADIUS);
    let frontends: Vec<Value> = q
        .sources
        .clone()
        .unwrap_or_else(|| PanoType::ALL.to_vec())
        .into_iter()
        .map(|f| {
            slots(vec![
                (schema::RenderStrategy::FRONTEND, json!(f)),
                (schema::RenderStrategy::TILED, json!(true)),
                (schema::RenderStrategy::IMAGE_FORMAT, json!(2)),
            ])
        })
        .collect();
    let preference = q.preference.unwrap_or(RankingStrategy::CLOSEST);
    let components = q.components.clone().unwrap_or_else(|| vec![1, 2, 3, 4, 8, 6]);

    let mut options = vec![
        (
            schema::QueryOptions::RANKING_OPTIONS,
            slots(vec![(schema::RankingOptions::RANKING_STRATEGY, json!(preference))]),
        ),
        (
            schema::QueryOptions::CLIENT_CAPABILITIES,
            slots(vec![(
                schema::ClientCapabilities::SUPPORTED_RENDER_STRATEGY,
                json!(frontends),
            )]),
        ),
    ];
    if let Some((start, end)) = q.date_range {
        options.push((
            schema::QueryOptions::FILTER_OPTIONS,
            slots(vec![(schema::FilterOptions::CAPTURE_TIME_RANGE, json!([start, end]))]),
        ));
    }

    slots(vec![
        (
            SingleImageSearchRequest::CONTEXT,
            slots(vec![(schema::RequestContext::CLIENT, json!("apiv3"))]),
        ),
        (
            SingleImageSearchRequest::LOCATION,
            slots(vec![
                (
                    schema::Circle::CENTER,
                    slots(vec![(schema::LatLng::LAT, num(q.lat)), (schema::LatLng::LNG, num(q.lng))]),
                ),
                (schema::Circle::RADIUS, num(radius)),
            ]),
        ),
        (SingleImageSearchRequest::QUERY_OPTIONS, slots(options)),
        (
            SingleImageSearchRequest::RESPONSE_SPECIFICATION,
            slots(vec![(schema::ResponseSpecification::COMPONENTS, json!(components))]),
        ),
    ])
    .to_string()
}

fn search_request(q: &SearchQuery) -> HttpRequestSpec {
    HttpRequestSpec {
        method: "POST".into(),
        url: SINGLE_IMAGE_SEARCH_URL.into(),
        headers: vec![("content-type".into(), "application/json+protobuf".into())],
        body: Some(encode_search(q).into_bytes()),
    }
}

/// The pano a location search found, or None for no coverage and for anything the Maps JS
/// API would not have reported as OK.
pub fn decode_search(body: &[u8]) -> Option<Pano> {
    let root: Value = serde_json::from_slice(body).ok()?;
    let resp = SingleImageSearchResponse(Node::json(&root));
    // status.code: 0 is OK, 3 and 5 (and a missing result) mean no coverage.
    if resp.status().code() != 0 {
        return None;
    }
    let result = resp.result();
    // result.status.code: 1 and 3 are OK, 2 is ZERO_RESULTS.
    if !matches!(result.status().code(), 1 | 3) {
        return None;
    }
    project(&result).filter(|p| !p.pano.is_empty())
}

// --- batching ---

/// Metadata for a run of panos, aligned to the request. `done` marks a pano the fetch
/// reached a verdict on; `failed` marks one whose request never came back.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FetchedMetadata {
    pub metas: Vec<Option<Pano>>,
    pub done: Vec<bool>,
    pub failed: Vec<bool>,
}

impl FetchedMetadata {
    fn blank(len: usize) -> Self {
        FetchedMetadata {
            metas: vec![None; len],
            done: vec![false; len],
            failed: vec![false; len],
        }
    }
}

#[derive(Clone, Copy)]
struct Span {
    start: usize,
    len: usize,
}

impl Span {
    /// The two halves a span splits into when its answer blames no pano in particular.
    fn split(self) -> [Span; 2] {
        let mid = self.len.div_ceil(2);
        [
            Span {
                start: self.start,
                len: mid,
            },
            Span {
                start: self.start + mid,
                len: self.len - mid,
            },
        ]
    }
}

fn metadata_request(pano_ids: &[String]) -> HttpRequestSpec {
    HttpRequestSpec {
        method: "POST".into(),
        url: GET_METADATA_URL.into(),
        headers: vec![
            ("content-type".into(), "application/x-protobuf".into()),
            ("x-user-agent".into(), "grpc-web-javascript/0.1".into()),
        ],
        body: Some(encode_request(pano_ids)),
    }
}

/// Issues every span of a round together and folds the answers into `out`. A multi-pano
/// request that fails or decodes all-null is usually one poisoned pano, so those spans come
/// back to be split and retried in the next round rather than being written off.
fn fetch_round(
    host: &mut dyn ProcHost,
    panos: &[String],
    spans: &[Span],
    out: &mut FetchedMetadata,
) -> Vec<Span> {
    let reqs: Vec<HttpRequestSpec> = spans
        .iter()
        .map(|s| metadata_request(&panos[s.start..s.start + s.len]))
        .collect();
    let answers = host.fetch_many(&reqs);
    let mut retry = Vec::new();
    for (span, answer) in spans.iter().zip(answers) {
        let ok = answer.ok().filter(|r| (200..300).contains(&r.status));
        let Some(resp) = ok else {
            // A cancelling run has its requests declined rather than answered; leaving those
            // rows unfinished keeps a cancel from counting them as failures.
            if host.aborted() {
                continue;
            }
            // A failed request says nothing about which pano is at fault, so split it the
            // same way an all-null decode splits. Only a pano that fails alone is failed.
            if span.len > 1 {
                retry.extend(span.split());
            } else {
                out.done[span.start] = true;
                out.failed[span.start] = true;
            }
            continue;
        };
        let metas = decode_response(&resp.body);
        if span.len > 1 && !metas.iter().any(Option::is_some) {
            retry.extend(span.split());
            continue;
        }
        for j in 0..span.len {
            out.metas[span.start + j] = metas.get(j).cloned().flatten();
            out.done[span.start + j] = true;
        }
    }
    retry
}

/// Distinct pano ids of `panos`, plus each input's slot in that list (`None` for no id).
fn index_panos(panos: &[String]) -> (Vec<String>, Vec<Option<usize>>) {
    let mut unique: Vec<String> = Vec::new();
    let mut seen: HashMap<&str, usize> = HashMap::new();
    let slot = panos
        .iter()
        .map(|p| {
            if p.is_empty() {
                return None;
            }
            Some(*seen.entry(p).or_insert_with(|| {
                unique.push(p.clone());
                unique.len() - 1
            }))
        })
        .collect();
    (unique, slot)
}

/// Metadata for every pano, aligned to `pano_ids`. Duplicates are fetched once and empty
/// ids are never asked for; each request carries at most [`BATCH_SIZE`] panos, and every
/// request a round needs goes out in one `fetch_many`, so the host decides how much of it
/// runs at once.
pub fn fetch_metadata(host: &mut dyn ProcHost, pano_ids: &[String]) -> FetchedMetadata {
    let (unique, slot) = index_panos(pano_ids);
    let mut fetched = FetchedMetadata::blank(unique.len());
    let mut round: Vec<Span> = (0..unique.len())
        .step_by(BATCH_SIZE)
        .map(|start| Span {
            start,
            len: BATCH_SIZE.min(unique.len() - start),
        })
        .collect();
    while !round.is_empty() && !host.aborted() {
        round = fetch_round(host, &unique, &round, &mut fetched);
    }

    let mut out = FetchedMetadata::blank(pano_ids.len());
    for (i, at) in slot.into_iter().enumerate() {
        let Some(k) = at else { continue };
        out.metas[i] = fetched.metas[k].clone();
        out.done[i] = fetched.done[k];
        out.failed[i] = fetched.failed[k];
    }
    out
}

/// Every query resolved to its pano, aligned to `queries`. Searches go out in one
/// `fetch_many`; ids run through [`fetch_metadata`]'s dedupe, chunking and bisection.
/// Both pay the host's inflight budget, rate limiter and retry policy.
pub fn resolve_panos(host: &mut dyn ProcHost, queries: &[PanoQuery]) -> Vec<PanoAnswer> {
    let mut answers = vec![PanoAnswer::Skipped; queries.len()];

    let searches: Vec<(usize, &SearchQuery)> = queries
        .iter()
        .enumerate()
        .filter_map(|(i, q)| match q {
            PanoQuery::Search(s) => Some((i, s)),
            PanoQuery::Id(_) => None,
        })
        .collect();
    if !searches.is_empty() {
        let reqs: Vec<HttpRequestSpec> = searches.iter().map(|(_, s)| search_request(s)).collect();
        let results = host.fetch_many(&reqs);
        for ((i, _), result) in searches.iter().zip(results) {
            let ok = result.ok().filter(|r| (200..300).contains(&r.status));
            answers[*i] = match ok {
                Some(resp) => match decode_search(&resp.body) {
                    Some(pano) => PanoAnswer::Found { pano: Box::new(pano) },
                    None => PanoAnswer::NotFound,
                },
                None if host.aborted() => PanoAnswer::Skipped,
                None => PanoAnswer::Failed,
            };
        }
    }

    let id_slots: Vec<usize> = queries
        .iter()
        .enumerate()
        .filter_map(|(i, q)| matches!(q, PanoQuery::Id(_)).then_some(i))
        .collect();
    if !id_slots.is_empty() {
        let ids: Vec<String> = id_slots
            .iter()
            .map(|&i| match &queries[i] {
                PanoQuery::Id(q) => q.pano_id.clone(),
                PanoQuery::Search(_) => unreachable!(),
            })
            .collect();
        let mut fetched = fetch_metadata(host, &ids);
        for (k, &i) in id_slots.iter().enumerate() {
            answers[i] = if fetched.failed[k] {
                PanoAnswer::Failed
            } else if !fetched.done[k] {
                PanoAnswer::Skipped
            } else {
                match fetched.metas[k].take() {
                    Some(pano) => PanoAnswer::Found { pano: Box::new(pano) },
                    None => PanoAnswer::NotFound,
                }
            };
        }
    }
    answers
}

#[cfg(test)]
#[path = "pano.test.rs"]
mod tests;
