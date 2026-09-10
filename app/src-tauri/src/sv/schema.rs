//! GENERATED from `app/src/lib/proto/*.proto` by `sv/schema_codegen.rs` -- do not
//! edit. Regen: `cargo test -p map-making-app --lib sv::schema_codegen::regen_schema -- --ignored`.
//!
//! Each struct reads one wire message through [`Node`] by field number, over binary
//! protobuf and array-JSON alike; the consts carry the numbers for the encode side,
//! and `owned` holds the value form every reader copies out through `to_owned`.
#![allow(dead_code, reason = "the schema is generated whole; readers use what they need")]

use crate::sv::wire::Node;
use crate::types::{wire_enum, wire_names, TsConst};

wire_enum! {
    /// Which imagery collection a pano id belongs to.
    PanoType: u8 {
        OFFICIAL = 2 => "Official",
        UNKNOWN = 3 => "Unknown",
        USER_UPLOADED = 10 => "User uploaded",
    }
}

wire_enum! {
    /// Which pano the search picks. An omitted rankingOptions goes on the wire as closest;
    /// the Maps JS API's encoder has no other default, whatever its docs say. BEST at a small
    /// radius returns a neighbouring pano from the same capture run, so a timeline probe must
    /// use CLOSEST at the pano's own coordinate.
    RankingStrategy: u8 {
        BEST = 1,
        CLOSEST = 2,
    }
}

pub struct RequestContext<'a>(pub Node<'a>);

impl<'a> RequestContext<'a> {
    pub const CLIENT: u32 = 1;
    pub const SOURCE: u32 = 2;
    pub const CLIENT_ID: u32 = 3;
    pub const CACHE_BEHAVIOR: u32 = 4;
    pub const LANGUAGE: u32 = 5;
    pub const GPS_DEBUG_LEVEL: u32 = 6;
    pub const HTTP_RESPONSE_FORMAT: u32 = 7;
    pub const INLINE_EXTRA_DATA_SPEC: u32 = 8;
    pub const QUERY_ORIGIN: u32 = 9;
    pub const SUPERROOT_PARAMS: u32 = 10;
    pub const PRODUCT_SPECIAL_CASE_OPTIONS: u32 = 11;
    pub const EXPERIMENTAL_OPTIONS: u32 = 12;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn client(&self) -> &'a str {
        self.0.str(1)
    }

    pub fn source(&self) -> i64 {
        self.0.int(2)
    }

    pub fn client_id(&self) -> i64 {
        self.0.int(3)
    }

    pub fn cache_behavior(&self) -> i64 {
        self.0.int(4)
    }

    pub fn language(&self) -> &'a str {
        self.0.str(5)
    }

    pub fn gps_debug_level(&self) -> i64 {
        self.0.int(6)
    }

    pub fn http_response_format(&self) -> i64 {
        self.0.int(7)
    }

    pub fn inline_extra_data_spec(&self) -> bool {
        self.0.int(8) != 0
    }

    pub fn query_origin(&self) -> &'a str {
        self.0.str(9)
    }

    pub fn superroot_params(&self) -> SuperrootParams<'a> {
        SuperrootParams(self.0.at(10))
    }

    pub fn product_special_case_options(&self) -> ProductSpecialCaseOptions<'a> {
        ProductSpecialCaseOptions(self.0.at(11))
    }

    pub fn experimental_options(&self) -> ExperimentalOptions<'a> {
        ExperimentalOptions(self.0.at(12))
    }

    pub fn to_owned(&self) -> owned::RequestContext {
        owned::RequestContext {
            client: self.client().to_string(),
            source: self.source() as i32,
            client_id: self.client_id(),
            cache_behavior: self.cache_behavior() as i32,
            language: self.language().to_string(),
            gps_debug_level: self.gps_debug_level() as i32,
            http_response_format: self.http_response_format() as i32,
            inline_extra_data_spec: self.inline_extra_data_spec(),
            query_origin: self.query_origin().to_string(),
            superroot_params: {
                let v = self.superroot_params();
                v.present().then(|| v.to_owned())
            },
            product_special_case_options: {
                let v = self.product_special_case_options();
                v.present().then(|| v.to_owned())
            },
            experimental_options: {
                let v = self.experimental_options();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct SuperrootParams<'a>(pub Node<'a>);

impl<'a> SuperrootParams<'a> {

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn to_owned(&self) -> owned::SuperrootParams {
        owned::SuperrootParams {
        }
    }
}

pub struct ProductSpecialCaseOptions<'a>(pub Node<'a>);

impl<'a> ProductSpecialCaseOptions<'a> {
    pub const STREET_VIEW: u32 = 1;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn street_view(&self) -> StreetViewSpecialCase<'a> {
        StreetViewSpecialCase(self.0.at(1))
    }

    pub fn to_owned(&self) -> owned::ProductSpecialCaseOptions {
        owned::ProductSpecialCaseOptions {
            street_view: {
                let v = self.street_view();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct StreetViewSpecialCase<'a>(pub Node<'a>);

impl<'a> StreetViewSpecialCase<'a> {
    pub const FLAG: u32 = 1;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn flag(&self) -> bool {
        self.0.int(1) != 0
    }

    pub fn to_owned(&self) -> owned::StreetViewSpecialCase {
        owned::StreetViewSpecialCase {
            flag: self.flag(),
        }
    }
}

pub struct ExperimentalOptions<'a>(pub Node<'a>);

impl<'a> ExperimentalOptions<'a> {

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn to_owned(&self) -> owned::ExperimentalOptions {
        owned::ExperimentalOptions {
        }
    }
}

pub struct LocalizationContext<'a>(pub Node<'a>);

impl<'a> LocalizationContext<'a> {
    pub const LANGUAGE: u32 = 1;
    pub const REGION_CODE: u32 = 2;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn language(&self) -> &'a str {
        self.0.str(1)
    }

    pub fn region_code(&self) -> &'a str {
        self.0.str(2)
    }

    pub fn to_owned(&self) -> owned::LocalizationContext {
        owned::LocalizationContext {
            language: self.language().to_string(),
            region_code: self.region_code().to_string(),
        }
    }
}

pub struct ResponseStatus<'a>(pub Node<'a>);

impl<'a> ResponseStatus<'a> {
    pub const CODE: u32 = 1;
    pub const ERROR_CODE: u32 = 2;
    pub const ERROR_MESSAGE: u32 = 3;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn code(&self) -> i64 {
        self.0.int(1)
    }

    pub fn error_code(&self) -> &'a str {
        self.0.str(2)
    }

    pub fn error_message(&self) -> &'a str {
        self.0.str(3)
    }

    pub fn to_owned(&self) -> owned::ResponseStatus {
        owned::ResponseStatus {
            code: self.code() as i32,
            error_code: self.error_code().to_string(),
            error_message: self.error_message().to_string(),
        }
    }
}

pub struct ImageMetadata<'a>(pub Node<'a>);

impl<'a> ImageMetadata<'a> {
    pub const STATUS: u32 = 1;
    pub const PANO: u32 = 2;
    pub const TILES: u32 = 3;
    pub const DESCRIPTION: u32 = 4;
    pub const ATTRIBUTION: u32 = 5;
    pub const INFORMATION: u32 = 6;
    pub const DATE: u32 = 7;
    pub const LEGAL: u32 = 8;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn status(&self) -> ImageStatus<'a> {
        ImageStatus(self.0.at(1))
    }

    pub fn pano(&self) -> ImageKey<'a> {
        ImageKey(self.0.at(2))
    }

    pub fn tiles(&self) -> ImageTiles<'a> {
        ImageTiles(self.0.at(3))
    }

    pub fn description(&self) -> ImageDescription<'a> {
        ImageDescription(self.0.at(4))
    }

    pub fn attribution(&self) -> ImageAttribution<'a> {
        ImageAttribution(self.0.at(5))
    }

    pub fn information(&self) -> Vec<ImageInformation<'a>> {
        self.0.all(6).into_iter().map(ImageInformation).collect()
    }

    pub fn date(&self) -> ImageDate<'a> {
        ImageDate(self.0.at(7))
    }

    pub fn legal(&self) -> LocalizedText<'a> {
        LocalizedText(self.0.at(8))
    }

    pub fn to_owned(&self) -> owned::ImageMetadata {
        owned::ImageMetadata {
            status: {
                let v = self.status();
                v.present().then(|| v.to_owned())
            },
            pano: {
                let v = self.pano();
                v.present().then(|| v.to_owned())
            },
            tiles: {
                let v = self.tiles();
                v.present().then(|| v.to_owned())
            },
            description: {
                let v = self.description();
                v.present().then(|| v.to_owned())
            },
            attribution: {
                let v = self.attribution();
                v.present().then(|| v.to_owned())
            },
            information: self.information().iter().map(ImageInformation::to_owned).collect(),
            date: {
                let v = self.date();
                v.present().then(|| v.to_owned())
            },
            legal: {
                let v = self.legal();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct ImageStatus<'a>(pub Node<'a>);

impl<'a> ImageStatus<'a> {
    pub const CODE: u32 = 1;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn code(&self) -> i64 {
        self.0.int(1)
    }

    pub fn to_owned(&self) -> owned::ImageStatus {
        owned::ImageStatus {
            code: self.code() as i32,
        }
    }
}

pub struct ImageKey<'a>(pub Node<'a>);

impl<'a> ImageKey<'a> {
    pub const FRONTEND: u32 = 1;
    pub const ID: u32 = 2;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn frontend(&self) -> i64 {
        self.0.int(1)
    }

    pub fn id(&self) -> &'a str {
        self.0.str(2)
    }

    pub fn to_owned(&self) -> owned::ImageKey {
        owned::ImageKey {
            frontend: self.frontend() as i32,
            id: self.id().to_string(),
        }
    }
}

pub struct ImageSize<'a>(pub Node<'a>);

impl<'a> ImageSize<'a> {
    pub const HEIGHT: u32 = 1;
    pub const WIDTH: u32 = 2;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn height(&self) -> i64 {
        self.0.int(1)
    }

    pub fn width(&self) -> i64 {
        self.0.int(2)
    }

    pub fn to_owned(&self) -> owned::ImageSize {
        owned::ImageSize {
            height: self.height() as i32,
            width: self.width() as i32,
        }
    }
}

pub struct ImageTiles<'a>(pub Node<'a>);

impl<'a> ImageTiles<'a> {
    pub const WORLD_SIZE: u32 = 3;
    pub const TILE_SIZE: u32 = 4;
    pub const PANO_ID: u32 = 10;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn world_size(&self) -> ImageSize<'a> {
        ImageSize(self.0.at(3))
    }

    pub fn tile_size(&self) -> ImageTileSize<'a> {
        ImageTileSize(self.0.at(4))
    }

    pub fn pano_id(&self) -> &'a str {
        self.0.str(10)
    }

    pub fn to_owned(&self) -> owned::ImageTiles {
        owned::ImageTiles {
            world_size: {
                let v = self.world_size();
                v.present().then(|| v.to_owned())
            },
            tile_size: {
                let v = self.tile_size();
                v.present().then(|| v.to_owned())
            },
            pano_id: self.pano_id().to_string(),
        }
    }
}

pub struct ImageTileSize<'a>(pub Node<'a>);

impl<'a> ImageTileSize<'a> {
    pub const POSSIBLE: u32 = 1;
    pub const TILE_SIZE: u32 = 2;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn possible(&self) -> Vec<PossibleSize<'a>> {
        self.0.all(1).into_iter().map(PossibleSize).collect()
    }

    pub fn tile_size(&self) -> ImageSize<'a> {
        ImageSize(self.0.at(2))
    }

    pub fn to_owned(&self) -> owned::ImageTileSize {
        owned::ImageTileSize {
            possible: self.possible().iter().map(PossibleSize::to_owned).collect(),
            tile_size: {
                let v = self.tile_size();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct PossibleSize<'a>(pub Node<'a>);

impl<'a> PossibleSize<'a> {
    pub const SIZE: u32 = 1;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn size(&self) -> ImageSize<'a> {
        ImageSize(self.0.at(1))
    }

    pub fn to_owned(&self) -> owned::PossibleSize {
        owned::PossibleSize {
            size: {
                let v = self.size();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct LocalizedText<'a>(pub Node<'a>);

impl<'a> LocalizedText<'a> {
    pub const TEXT: u32 = 1;
    pub const LANGUAGE: u32 = 2;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn text(&self) -> &'a str {
        self.0.str(1)
    }

    pub fn language(&self) -> &'a str {
        self.0.str(2)
    }

    pub fn to_owned(&self) -> owned::LocalizedText {
        owned::LocalizedText {
            text: self.text().to_string(),
            language: self.language().to_string(),
        }
    }
}

pub struct ImageDescription<'a>(pub Node<'a>);

impl<'a> ImageDescription<'a> {
    pub const DESCRIPTION: u32 = 3;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn description(&self) -> Vec<LocalizedText<'a>> {
        self.0.all(3).into_iter().map(LocalizedText).collect()
    }

    pub fn to_owned(&self) -> owned::ImageDescription {
        owned::ImageDescription {
            description: self.description().iter().map(LocalizedText::to_owned).collect(),
        }
    }
}

pub struct ImageTitle<'a>(pub Node<'a>);

impl<'a> ImageTitle<'a> {
    pub const NAME: u32 = 1;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn name(&self) -> &'a str {
        self.0.str(1)
    }

    pub fn to_owned(&self) -> owned::ImageTitle {
        owned::ImageTitle {
            name: self.name().to_string(),
        }
    }
}

pub struct AttributionItem<'a>(pub Node<'a>);

impl<'a> AttributionItem<'a> {
    pub const NAME: u32 = 1;
    pub const URL: u32 = 2;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn name(&self) -> ImageTitle<'a> {
        ImageTitle(self.0.at(1))
    }

    pub fn url(&self) -> &'a str {
        self.0.str(2)
    }

    pub fn to_owned(&self) -> owned::AttributionItem {
        owned::AttributionItem {
            name: {
                let v = self.name();
                v.present().then(|| v.to_owned())
            },
            url: self.url().to_string(),
        }
    }
}

pub struct ImageAuthor<'a>(pub Node<'a>);

impl<'a> ImageAuthor<'a> {
    pub const NAME: u32 = 1;
    pub const PROFILE_URL: u32 = 2;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn name(&self) -> LocalizedText<'a> {
        LocalizedText(self.0.at(1))
    }

    pub fn profile_url(&self) -> &'a str {
        self.0.str(2)
    }

    pub fn to_owned(&self) -> owned::ImageAuthor {
        owned::ImageAuthor {
            name: {
                let v = self.name();
                v.present().then(|| v.to_owned())
            },
            profile_url: self.profile_url().to_string(),
        }
    }
}

pub struct ImageAttribution<'a>(pub Node<'a>);

impl<'a> ImageAttribution<'a> {
    pub const ITEM: u32 = 1;
    pub const AUTHOR: u32 = 2;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn item(&self) -> Vec<AttributionItem<'a>> {
        self.0.all(1).into_iter().map(AttributionItem).collect()
    }

    pub fn author(&self) -> Vec<ImageAuthor<'a>> {
        self.0.all(2).into_iter().map(ImageAuthor).collect()
    }

    pub fn to_owned(&self) -> owned::ImageAttribution {
        owned::ImageAttribution {
            item: self.item().iter().map(AttributionItem::to_owned).collect(),
            author: self.author().iter().map(ImageAuthor::to_owned).collect(),
        }
    }
}

pub struct LatLng<'a>(pub Node<'a>);

impl<'a> LatLng<'a> {
    pub const LAT: u32 = 3;
    pub const LNG: u32 = 4;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn lat(&self) -> f64 {
        self.0.double(3)
    }

    pub fn lng(&self) -> f64 {
        self.0.double(4)
    }

    pub fn to_owned(&self) -> owned::LatLng {
        owned::LatLng {
            lat: self.lat(),
            lng: self.lng(),
        }
    }
}

pub struct Altitude<'a>(pub Node<'a>);

impl<'a> Altitude<'a> {
    pub const METERS: u32 = 1;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn meters(&self) -> f64 {
        self.0.float(1)
    }

    pub fn to_owned(&self) -> owned::Altitude {
        owned::Altitude {
            meters: self.meters(),
        }
    }
}

pub struct Pov<'a>(pub Node<'a>);

impl<'a> Pov<'a> {
    pub const HEADING: u32 = 1;
    pub const TILT: u32 = 2;
    pub const ROLL: u32 = 3;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn heading(&self) -> f64 {
        self.0.float(1)
    }

    pub fn tilt(&self) -> f64 {
        self.0.float(2)
    }

    pub fn roll(&self) -> f64 {
        self.0.float(3)
    }

    pub fn to_owned(&self) -> owned::Pov {
        owned::Pov {
            heading: self.heading(),
            tilt: self.tilt(),
            roll: self.roll(),
        }
    }
}

pub struct Level<'a>(pub Node<'a>);

impl<'a> Level<'a> {
    pub const ID: u32 = 1;
    pub const ORDINAL: u32 = 2;
    pub const NAME: u32 = 3;
    pub const ABBREVIATION: u32 = 4;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn id(&self) -> u64 {
        self.0.int(1) as u64
    }

    pub fn ordinal(&self) -> i64 {
        self.0.int(2)
    }

    pub fn name(&self) -> LocalizedText<'a> {
        LocalizedText(self.0.at(3))
    }

    pub fn abbreviation(&self) -> LocalizedText<'a> {
        LocalizedText(self.0.at(4))
    }

    pub fn to_owned(&self) -> owned::Level {
        owned::Level {
            id: self.id(),
            ordinal: self.ordinal() as i32,
            name: {
                let v = self.name();
                v.present().then(|| v.to_owned())
            },
            abbreviation: {
                let v = self.abbreviation();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct PanoLocation<'a>(pub Node<'a>);

impl<'a> PanoLocation<'a> {
    pub const LOCATION: u32 = 1;
    pub const ALTITUDE: u32 = 2;
    pub const POV: u32 = 3;
    pub const LEVEL: u32 = 4;
    pub const COUNTRY_CODE: u32 = 5;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn location(&self) -> LatLng<'a> {
        LatLng(self.0.at(1))
    }

    pub fn altitude(&self) -> Altitude<'a> {
        Altitude(self.0.at(2))
    }

    pub fn pov(&self) -> Pov<'a> {
        Pov(self.0.at(3))
    }

    pub fn level(&self) -> Level<'a> {
        Level(self.0.at(4))
    }

    pub fn country_code(&self) -> &'a str {
        self.0.str(5)
    }

    pub fn to_owned(&self) -> owned::PanoLocation {
        owned::PanoLocation {
            location: {
                let v = self.location();
                v.present().then(|| v.to_owned())
            },
            altitude: {
                let v = self.altitude();
                v.present().then(|| v.to_owned())
            },
            pov: {
                let v = self.pov();
                v.present().then(|| v.to_owned())
            },
            level: {
                let v = self.level();
                v.present().then(|| v.to_owned())
            },
            country_code: self.country_code().to_string(),
        }
    }
}

pub struct Pano<'a>(pub Node<'a>);

impl<'a> Pano<'a> {
    pub const KEY: u32 = 1;
    pub const LOCATION: u32 = 3;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn key(&self) -> ImageKey<'a> {
        ImageKey(self.0.at(1))
    }

    pub fn location(&self) -> PanoLocation<'a> {
        PanoLocation(self.0.at(3))
    }

    pub fn to_owned(&self) -> owned::Pano {
        owned::Pano {
            key: {
                let v = self.key();
                v.present().then(|| v.to_owned())
            },
            location: {
                let v = self.location();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct PanoRelations<'a>(pub Node<'a>);

impl<'a> PanoRelations<'a> {
    pub const PANO: u32 = 1;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn pano(&self) -> Vec<Pano<'a>> {
        self.0.all(1).into_iter().map(Pano).collect()
    }

    pub fn to_owned(&self) -> owned::PanoRelations {
        owned::PanoRelations {
            pano: self.pano().iter().map(Pano::to_owned).collect(),
        }
    }
}

pub struct PanoLinkProperties<'a>(pub Node<'a>);

impl<'a> PanoLinkProperties<'a> {
    pub const HEADING: u32 = 4;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn heading(&self) -> f64 {
        self.0.float(4)
    }

    pub fn to_owned(&self) -> owned::PanoLinkProperties {
        owned::PanoLinkProperties {
            heading: self.heading(),
        }
    }
}

pub struct PanoLink<'a>(pub Node<'a>);

impl<'a> PanoLink<'a> {
    pub const TARGET: u32 = 1;
    pub const PROPERTIES: u32 = 2;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn target(&self) -> i64 {
        self.0.int(1)
    }

    pub fn properties(&self) -> PanoLinkProperties<'a> {
        PanoLinkProperties(self.0.at(2))
    }

    pub fn to_owned(&self) -> owned::PanoLink {
        owned::PanoLink {
            target: self.target() as i32,
            properties: {
                let v = self.properties();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct PanoDate<'a>(pub Node<'a>);

impl<'a> PanoDate<'a> {
    pub const YEAR: u32 = 1;
    pub const MONTH: u32 = 2;
    pub const DAY: u32 = 3;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn year(&self) -> i64 {
        self.0.int(1)
    }

    pub fn month(&self) -> i64 {
        self.0.int(2)
    }

    pub fn day(&self) -> i64 {
        self.0.int(3)
    }

    pub fn to_owned(&self) -> owned::PanoDate {
        owned::PanoDate {
            year: self.year() as i32,
            month: self.month() as i32,
            day: self.day() as i32,
        }
    }
}

pub struct PanoTime<'a>(pub Node<'a>);

impl<'a> PanoTime<'a> {
    pub const TARGET: u32 = 1;
    pub const DATE: u32 = 2;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn target(&self) -> i64 {
        self.0.int(1)
    }

    pub fn date(&self) -> PanoDate<'a> {
        PanoDate(self.0.at(2))
    }

    pub fn to_owned(&self) -> owned::PanoTime {
        owned::PanoTime {
            target: self.target() as i32,
            date: {
                let v = self.date();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct ImageInformation<'a>(pub Node<'a>);

impl<'a> ImageInformation<'a> {
    pub const STATUS: u32 = 1;
    pub const LOCATION: u32 = 2;
    pub const RELATIONS: u32 = 4;
    pub const LINK: u32 = 7;
    pub const TIME: u32 = 9;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn status(&self) -> ImageStatus<'a> {
        ImageStatus(self.0.at(1))
    }

    pub fn location(&self) -> PanoLocation<'a> {
        PanoLocation(self.0.at(2))
    }

    pub fn relations(&self) -> PanoRelations<'a> {
        PanoRelations(self.0.at(4))
    }

    pub fn link(&self) -> Vec<PanoLink<'a>> {
        self.0.all(7).into_iter().map(PanoLink).collect()
    }

    pub fn time(&self) -> Vec<PanoTime<'a>> {
        self.0.all(9).into_iter().map(PanoTime).collect()
    }

    pub fn to_owned(&self) -> owned::ImageInformation {
        owned::ImageInformation {
            status: {
                let v = self.status();
                v.present().then(|| v.to_owned())
            },
            location: {
                let v = self.location();
                v.present().then(|| v.to_owned())
            },
            relations: {
                let v = self.relations();
                v.present().then(|| v.to_owned())
            },
            link: self.link().iter().map(PanoLink::to_owned).collect(),
            time: self.time().iter().map(PanoTime::to_owned).collect(),
        }
    }
}

pub struct DateSourceInfo<'a>(pub Node<'a>);

impl<'a> DateSourceInfo<'a> {
    pub const SOURCE: u32 = 3;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn source(&self) -> &'a str {
        self.0.str(3)
    }

    pub fn to_owned(&self) -> owned::DateSourceInfo {
        owned::DateSourceInfo {
            source: self.source().to_string(),
        }
    }
}

pub struct ImageDate<'a>(pub Node<'a>);

impl<'a> ImageDate<'a> {
    pub const SOURCE_INFO: u32 = 6;
    pub const DATE: u32 = 8;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn source_info(&self) -> DateSourceInfo<'a> {
        DateSourceInfo(self.0.at(6))
    }

    pub fn date(&self) -> PanoDate<'a> {
        PanoDate(self.0.at(8))
    }

    pub fn to_owned(&self) -> owned::ImageDate {
        owned::ImageDate {
            source_info: {
                let v = self.source_info();
                v.present().then(|| v.to_owned())
            },
            date: {
                let v = self.date();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct GetMetadataRequest<'a>(pub Node<'a>);

impl<'a> GetMetadataRequest<'a> {
    pub const CONTEXT: u32 = 1;
    pub const LOCALE: u32 = 2;
    pub const KEY: u32 = 3;
    pub const SPEC: u32 = 4;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn context(&self) -> RequestContext<'a> {
        RequestContext(self.0.at(1))
    }

    pub fn locale(&self) -> LocalizationContext<'a> {
        LocalizationContext(self.0.at(2))
    }

    pub fn key(&self) -> Vec<KeyWrapper<'a>> {
        self.0.all(3).into_iter().map(KeyWrapper).collect()
    }

    pub fn spec(&self) -> MetadataResponseSpecification<'a> {
        MetadataResponseSpecification(self.0.at(4))
    }

    pub fn to_owned(&self) -> owned::GetMetadataRequest {
        owned::GetMetadataRequest {
            context: {
                let v = self.context();
                v.present().then(|| v.to_owned())
            },
            locale: {
                let v = self.locale();
                v.present().then(|| v.to_owned())
            },
            key: self.key().iter().map(KeyWrapper::to_owned).collect(),
            spec: {
                let v = self.spec();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct KeyWrapper<'a>(pub Node<'a>);

impl<'a> KeyWrapper<'a> {
    pub const KEY: u32 = 1;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn key(&self) -> ImageKey<'a> {
        ImageKey(self.0.at(1))
    }

    pub fn to_owned(&self) -> owned::KeyWrapper {
        owned::KeyWrapper {
            key: {
                let v = self.key();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct MetadataResponseSpecification<'a>(pub Node<'a>);

impl<'a> MetadataResponseSpecification<'a> {
    pub const COMPONENT: u32 = 1;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn to_owned(&self) -> owned::MetadataResponseSpecification {
        owned::MetadataResponseSpecification {
        }
    }
}

pub struct GetMetadataResponse<'a>(pub Node<'a>);

impl<'a> GetMetadataResponse<'a> {
    pub const STATUS: u32 = 1;
    pub const METADATA: u32 = 2;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn status(&self) -> ResponseStatus<'a> {
        ResponseStatus(self.0.at(1))
    }

    pub fn metadata(&self) -> Vec<ImageMetadata<'a>> {
        self.0.all(2).into_iter().map(ImageMetadata).collect()
    }

    pub fn to_owned(&self) -> owned::GetMetadataResponse {
        owned::GetMetadataResponse {
            status: {
                let v = self.status();
                v.present().then(|| v.to_owned())
            },
            metadata: self.metadata().iter().map(ImageMetadata::to_owned).collect(),
        }
    }
}

pub struct SingleImageSearchRequest<'a>(pub Node<'a>);

impl<'a> SingleImageSearchRequest<'a> {
    pub const CONTEXT: u32 = 1;
    pub const LOCATION: u32 = 2;
    pub const QUERY_OPTIONS: u32 = 3;
    pub const RESPONSE_SPECIFICATION: u32 = 4;
    pub const IMAGE_KEY: u32 = 5;
    pub const FEATURE: u32 = 8;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn context(&self) -> RequestContext<'a> {
        RequestContext(self.0.at(1))
    }

    pub fn location(&self) -> Circle<'a> {
        Circle(self.0.at(2))
    }

    pub fn query_options(&self) -> QueryOptions<'a> {
        QueryOptions(self.0.at(3))
    }

    pub fn response_specification(&self) -> ResponseSpecification<'a> {
        ResponseSpecification(self.0.at(4))
    }

    pub fn image_key(&self) -> ImageKey<'a> {
        ImageKey(self.0.at(5))
    }

    pub fn feature(&self) -> SearchFeature<'a> {
        SearchFeature(self.0.at(8))
    }

    pub fn to_owned(&self) -> owned::SingleImageSearchRequest {
        owned::SingleImageSearchRequest {
            context: {
                let v = self.context();
                v.present().then(|| v.to_owned())
            },
            location: {
                let v = self.location();
                v.present().then(|| v.to_owned())
            },
            query_options: {
                let v = self.query_options();
                v.present().then(|| v.to_owned())
            },
            response_specification: {
                let v = self.response_specification();
                v.present().then(|| v.to_owned())
            },
            image_key: {
                let v = self.image_key();
                v.present().then(|| v.to_owned())
            },
            feature: {
                let v = self.feature();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct Circle<'a>(pub Node<'a>);

impl<'a> Circle<'a> {
    pub const CENTER: u32 = 1;
    pub const RADIUS: u32 = 2;
    pub const LEVEL: u32 = 3;
    pub const LOOK_AT_POINT: u32 = 5;
    pub const TAG: u32 = 6;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn center(&self) -> LatLng<'a> {
        LatLng(self.0.at(1))
    }

    pub fn radius(&self) -> f64 {
        self.0.double(2)
    }

    pub fn level(&self) -> Level<'a> {
        Level(self.0.at(3))
    }

    pub fn look_at_point(&self) -> LatLng<'a> {
        LatLng(self.0.at(5))
    }

    pub fn tag(&self) -> &'a str {
        self.0.str(6)
    }

    pub fn to_owned(&self) -> owned::Circle {
        owned::Circle {
            center: {
                let v = self.center();
                v.present().then(|| v.to_owned())
            },
            radius: self.radius(),
            level: {
                let v = self.level();
                v.present().then(|| v.to_owned())
            },
            look_at_point: {
                let v = self.look_at_point();
                v.present().then(|| v.to_owned())
            },
            tag: self.tag().to_string(),
        }
    }
}

pub struct QueryOptions<'a>(pub Node<'a>);

impl<'a> QueryOptions<'a> {
    pub const FILTER_OPTIONS: u32 = 1;
    pub const LOCALIZATION_CONTEXT: u32 = 2;
    pub const RANKING_OPTIONS: u32 = 9;
    pub const CLIENT_CAPABILITIES: u32 = 11;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn filter_options(&self) -> FilterOptions<'a> {
        FilterOptions(self.0.at(1))
    }

    pub fn localization_context(&self) -> LocalizationContext<'a> {
        LocalizationContext(self.0.at(2))
    }

    pub fn ranking_options(&self) -> RankingOptions<'a> {
        RankingOptions(self.0.at(9))
    }

    pub fn client_capabilities(&self) -> ClientCapabilities<'a> {
        ClientCapabilities(self.0.at(11))
    }

    pub fn to_owned(&self) -> owned::QueryOptions {
        owned::QueryOptions {
            filter_options: {
                let v = self.filter_options();
                v.present().then(|| v.to_owned())
            },
            localization_context: {
                let v = self.localization_context();
                v.present().then(|| v.to_owned())
            },
            ranking_options: {
                let v = self.ranking_options();
                v.present().then(|| v.to_owned())
            },
            client_capabilities: {
                let v = self.client_capabilities();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct FilterOptions<'a>(pub Node<'a>);

impl<'a> FilterOptions<'a> {
    pub const FORMAT_RESTRICTIONS: u32 = 1;
    pub const RESTRICT_TO_ADS_ELIGIBLE: u32 = 2;
    pub const RESTRICT_TO_DIRECTIONS_APPROPRIATE: u32 = 3;
    pub const RESTRICT_TO_UNKNOWN4: u32 = 4;
    pub const RESTRICT_TO_PHOTOS_WITH_FOCUS_ATTRIBUTION: u32 = 5;
    pub const RESTRICT_TO_SYNDICATION_ELIGIBLE: u32 = 6;
    pub const SEMANTIC_RESTRICTIONS: u32 = 7;
    pub const RESTRICT_TO_OWNER_ATTRIBUTED_PHOTOS: u32 = 8;
    pub const CAPTURE_TIME_RANGE: u32 = 11;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn format_restrictions(&self) -> FormatRestrictions<'a> {
        FormatRestrictions(self.0.at(1))
    }

    pub fn restrict_to_ads_eligible(&self) -> bool {
        self.0.int(2) != 0
    }

    pub fn restrict_to_directions_appropriate(&self) -> bool {
        self.0.int(3) != 0
    }

    pub fn restrict_to_unknown4(&self) -> bool {
        self.0.int(4) != 0
    }

    pub fn restrict_to_photos_with_focus_attribution(&self) -> bool {
        self.0.int(5) != 0
    }

    pub fn restrict_to_syndication_eligible(&self) -> bool {
        self.0.int(6) != 0
    }

    pub fn semantic_restrictions(&self) -> SemanticRestrictions<'a> {
        SemanticRestrictions(self.0.at(7))
    }

    pub fn restrict_to_owner_attributed_photos(&self) -> bool {
        self.0.int(8) != 0
    }

    pub fn capture_time_range(&self) -> CaptureTimeRange<'a> {
        CaptureTimeRange(self.0.at(11))
    }

    pub fn to_owned(&self) -> owned::FilterOptions {
        owned::FilterOptions {
            format_restrictions: {
                let v = self.format_restrictions();
                v.present().then(|| v.to_owned())
            },
            restrict_to_ads_eligible: self.restrict_to_ads_eligible(),
            restrict_to_directions_appropriate: self.restrict_to_directions_appropriate(),
            restrict_to_unknown4: self.restrict_to_unknown4(),
            restrict_to_photos_with_focus_attribution: self.restrict_to_photos_with_focus_attribution(),
            restrict_to_syndication_eligible: self.restrict_to_syndication_eligible(),
            semantic_restrictions: {
                let v = self.semantic_restrictions();
                v.present().then(|| v.to_owned())
            },
            restrict_to_owner_attributed_photos: self.restrict_to_owner_attributed_photos(),
            capture_time_range: {
                let v = self.capture_time_range();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct CaptureTimeRange<'a>(pub Node<'a>);

impl<'a> CaptureTimeRange<'a> {
    pub const START: u32 = 1;
    pub const END: u32 = 2;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn start(&self) -> i64 {
        self.0.int(1)
    }

    pub fn end(&self) -> i64 {
        self.0.int(2)
    }

    pub fn to_owned(&self) -> owned::CaptureTimeRange {
        owned::CaptureTimeRange {
            start: self.start(),
            end: self.end(),
        }
    }
}

pub struct FormatRestrictions<'a>(pub Node<'a>);

impl<'a> FormatRestrictions<'a> {
    pub const IMAGE_FORMAT: u32 = 3;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn image_format(&self) -> i64 {
        self.0.int(3)
    }

    pub fn to_owned(&self) -> owned::FormatRestrictions {
        owned::FormatRestrictions {
            image_format: self.image_format() as i32,
        }
    }
}

pub struct SemanticRestrictions<'a>(pub Node<'a>);

impl<'a> SemanticRestrictions<'a> {

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn to_owned(&self) -> owned::SemanticRestrictions {
        owned::SemanticRestrictions {
        }
    }
}

pub struct RankingOptions<'a>(pub Node<'a>);

impl<'a> RankingOptions<'a> {
    pub const RANKING_STRATEGY: u32 = 1;
    pub const LOGISTIC_CURVATURE: u32 = 2;
    pub const LOGISTIC_OFFSET: u32 = 3;
    pub const DISTANCE_RATIO: u32 = 4;
    pub const TIMESTAMP_OPTIONS: u32 = 5;
    pub const QBICA: u32 = 6;
    pub const DESCRIPTOR: u32 = 7;
    pub const SIMILARITY_OPTIONS: u32 = 8;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn ranking_strategy(&self) -> i64 {
        self.0.int(1)
    }

    pub fn logistic_curvature(&self) -> f64 {
        self.0.double(2)
    }

    pub fn logistic_offset(&self) -> f64 {
        self.0.double(3)
    }

    pub fn distance_ratio(&self) -> f64 {
        self.0.double(4)
    }

    pub fn timestamp_options(&self) -> TimestampOptions<'a> {
        TimestampOptions(self.0.at(5))
    }

    pub fn qbica(&self) -> RankingUnknown6<'a> {
        RankingUnknown6(self.0.at(6))
    }

    pub fn descriptor(&self) -> &'a str {
        self.0.str(7)
    }

    pub fn similarity_options(&self) -> SimilarityOptions<'a> {
        SimilarityOptions(self.0.at(8))
    }

    pub fn to_owned(&self) -> owned::RankingOptions {
        owned::RankingOptions {
            ranking_strategy: self.ranking_strategy() as i32,
            logistic_curvature: self.logistic_curvature(),
            logistic_offset: self.logistic_offset(),
            distance_ratio: self.distance_ratio(),
            timestamp_options: {
                let v = self.timestamp_options();
                v.present().then(|| v.to_owned())
            },
            qbica: {
                let v = self.qbica();
                v.present().then(|| v.to_owned())
            },
            descriptor: self.descriptor().to_string(),
            similarity_options: {
                let v = self.similarity_options();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct TimestampOptions<'a>(pub Node<'a>);

impl<'a> TimestampOptions<'a> {

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn to_owned(&self) -> owned::TimestampOptions {
        owned::TimestampOptions {
        }
    }
}

pub struct RankingUnknown6<'a>(pub Node<'a>);

impl<'a> RankingUnknown6<'a> {

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn to_owned(&self) -> owned::RankingUnknown6 {
        owned::RankingUnknown6 {
        }
    }
}

pub struct SimilarityOptions<'a>(pub Node<'a>);

impl<'a> SimilarityOptions<'a> {

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn to_owned(&self) -> owned::SimilarityOptions {
        owned::SimilarityOptions {
        }
    }
}

pub struct ClientCapabilities<'a>(pub Node<'a>);

impl<'a> ClientCapabilities<'a> {
    pub const SUPPORTED_RENDER_STRATEGY: u32 = 1;
    pub const MAX_DIMENSION: u32 = 2;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn supported_render_strategy(&self) -> Vec<RenderStrategy<'a>> {
        self.0.all(1).into_iter().map(RenderStrategy).collect()
    }

    pub fn max_dimension(&self) -> ImageSize<'a> {
        ImageSize(self.0.at(2))
    }

    pub fn to_owned(&self) -> owned::ClientCapabilities {
        owned::ClientCapabilities {
            supported_render_strategy: self.supported_render_strategy().iter().map(RenderStrategy::to_owned).collect(),
            max_dimension: {
                let v = self.max_dimension();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct RenderStrategy<'a>(pub Node<'a>);

impl<'a> RenderStrategy<'a> {
    pub const FRONTEND: u32 = 1;
    pub const TILED: u32 = 2;
    pub const IMAGE_FORMAT: u32 = 3;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn frontend(&self) -> i64 {
        self.0.int(1)
    }

    pub fn tiled(&self) -> bool {
        self.0.int(2) != 0
    }

    pub fn image_format(&self) -> i64 {
        self.0.int(3)
    }

    pub fn to_owned(&self) -> owned::RenderStrategy {
        owned::RenderStrategy {
            frontend: self.frontend() as i32,
            tiled: self.tiled(),
            image_format: self.image_format() as i32,
        }
    }
}

pub struct ResponseSpecification<'a>(pub Node<'a>);

impl<'a> ResponseSpecification<'a> {
    pub const COMPONENTS: u32 = 1;
    pub const NAVIGATION_CHANNELS: u32 = 2;
    pub const HTTP_RESPONSE_FORMAT: u32 = 3;
    pub const ATTRIBUTION: u32 = 4;
    pub const CURSOR_FORMATS: u32 = 5;
    pub const TARGET_OVERLAY_FORMATS: u32 = 6;
    pub const UNKNOWN7: u32 = 7;
    pub const CLIENT_CAPABILITIES: u32 = 9;
    pub const THUMBNAIL: u32 = 11;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn navigation_channels(&self) -> Vec<NavigationChannel<'a>> {
        self.0.all(2).into_iter().map(NavigationChannel).collect()
    }

    pub fn http_response_format(&self) -> i64 {
        self.0.int(3)
    }

    pub fn attribution(&self) -> AttributionSpec<'a> {
        AttributionSpec(self.0.at(4))
    }

    pub fn cursor_formats(&self) -> Vec<CursorFormat<'a>> {
        self.0.all(5).into_iter().map(CursorFormat).collect()
    }

    pub fn target_overlay_formats(&self) -> Vec<TargetOverlayFormat<'a>> {
        self.0.all(6).into_iter().map(TargetOverlayFormat).collect()
    }

    pub fn unknown7(&self) -> bool {
        self.0.int(7) != 0
    }

    pub fn client_capabilities(&self) -> ClientCapabilities<'a> {
        ClientCapabilities(self.0.at(9))
    }

    pub fn thumbnail(&self) -> ThumbnailSpec<'a> {
        ThumbnailSpec(self.0.at(11))
    }

    pub fn to_owned(&self) -> owned::ResponseSpecification {
        owned::ResponseSpecification {
            navigation_channels: self.navigation_channels().iter().map(NavigationChannel::to_owned).collect(),
            http_response_format: self.http_response_format() as i32,
            attribution: {
                let v = self.attribution();
                v.present().then(|| v.to_owned())
            },
            cursor_formats: self.cursor_formats().iter().map(CursorFormat::to_owned).collect(),
            target_overlay_formats: self.target_overlay_formats().iter().map(TargetOverlayFormat::to_owned).collect(),
            unknown7: self.unknown7(),
            client_capabilities: {
                let v = self.client_capabilities();
                v.present().then(|| v.to_owned())
            },
            thumbnail: {
                let v = self.thumbnail();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct NavigationChannel<'a>(pub Node<'a>);

impl<'a> NavigationChannel<'a> {

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn to_owned(&self) -> owned::NavigationChannel {
        owned::NavigationChannel {
        }
    }
}

pub struct AttributionSpec<'a>(pub Node<'a>);

impl<'a> AttributionSpec<'a> {
    pub const THUMBNAIL_SIZE: u32 = 1;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn thumbnail_size(&self) -> i64 {
        self.0.int(1)
    }

    pub fn to_owned(&self) -> owned::AttributionSpec {
        owned::AttributionSpec {
            thumbnail_size: self.thumbnail_size() as i32,
        }
    }
}

pub struct CursorFormat<'a>(pub Node<'a>);

impl<'a> CursorFormat<'a> {
    pub const ENCODING: u32 = 1;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn encoding(&self) -> i64 {
        self.0.int(1)
    }

    pub fn to_owned(&self) -> owned::CursorFormat {
        owned::CursorFormat {
            encoding: self.encoding() as i32,
        }
    }
}

pub struct TargetOverlayFormat<'a>(pub Node<'a>);

impl<'a> TargetOverlayFormat<'a> {

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn to_owned(&self) -> owned::TargetOverlayFormat {
        owned::TargetOverlayFormat {
        }
    }
}

pub struct ThumbnailSpec<'a>(pub Node<'a>);

impl<'a> ThumbnailSpec<'a> {
    pub const ENTRY: u32 = 3;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn entry(&self) -> Vec<ThumbnailEntry<'a>> {
        self.0.all(3).into_iter().map(ThumbnailEntry).collect()
    }

    pub fn to_owned(&self) -> owned::ThumbnailSpec {
        owned::ThumbnailSpec {
            entry: self.entry().iter().map(ThumbnailEntry::to_owned).collect(),
        }
    }
}

pub struct ThumbnailEntry<'a>(pub Node<'a>);

impl<'a> ThumbnailEntry<'a> {
    pub const SIZE: u32 = 1;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn size(&self) -> ImageSize<'a> {
        ImageSize(self.0.at(1))
    }

    pub fn to_owned(&self) -> owned::ThumbnailEntry {
        owned::ThumbnailEntry {
            size: {
                let v = self.size();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub struct SearchFeature<'a>(pub Node<'a>);

impl<'a> SearchFeature<'a> {

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn to_owned(&self) -> owned::SearchFeature {
        owned::SearchFeature {
        }
    }
}

pub struct SingleImageSearchResponse<'a>(pub Node<'a>);

impl<'a> SingleImageSearchResponse<'a> {
    pub const STATUS: u32 = 1;
    pub const RESULT: u32 = 2;

    pub fn present(&self) -> bool {
        self.0.present()
    }

    pub fn status(&self) -> ResponseStatus<'a> {
        ResponseStatus(self.0.at(1))
    }

    pub fn result(&self) -> ImageMetadata<'a> {
        ImageMetadata(self.0.at(2))
    }

    pub fn to_owned(&self) -> owned::SingleImageSearchResponse {
        owned::SingleImageSearchResponse {
            status: {
                let v = self.status();
                v.present().then(|| v.to_owned())
            },
            result: {
                let v = self.result();
                v.present().then(|| v.to_owned())
            },
        }
    }
}

pub mod owned {
    //! Owned value forms of every message: real fields, copied off the wire by the
    //! matching reader's `to_owned`. Repeated scalars are write-only and not carried.
    use serde::{Deserialize, Serialize};
    use specta::Type;

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct RequestContext {
        pub client: String,
        pub source: i32,
        pub client_id: i64,
        pub cache_behavior: i32,
        pub language: String,
        pub gps_debug_level: i32,
        pub http_response_format: i32,
        pub inline_extra_data_spec: bool,
        pub query_origin: String,
        pub superroot_params: Option<SuperrootParams>,
        pub product_special_case_options: Option<ProductSpecialCaseOptions>,
        pub experimental_options: Option<ExperimentalOptions>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct SuperrootParams {
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ProductSpecialCaseOptions {
        pub street_view: Option<StreetViewSpecialCase>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct StreetViewSpecialCase {
        pub flag: bool,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ExperimentalOptions {
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct LocalizationContext {
        pub language: String,
        pub region_code: String,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ResponseStatus {
        pub code: i32,
        pub error_code: String,
        pub error_message: String,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ImageMetadata {
        pub status: Option<ImageStatus>,
        pub pano: Option<ImageKey>,
        pub tiles: Option<ImageTiles>,
        pub description: Option<ImageDescription>,
        pub attribution: Option<ImageAttribution>,
        pub information: Vec<ImageInformation>,
        pub date: Option<ImageDate>,
        pub legal: Option<LocalizedText>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ImageStatus {
        pub code: i32,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ImageKey {
        pub frontend: i32,
        pub id: String,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ImageSize {
        pub height: i32,
        pub width: i32,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ImageTiles {
        pub world_size: Option<ImageSize>,
        pub tile_size: Option<ImageTileSize>,
        pub pano_id: String,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ImageTileSize {
        pub possible: Vec<PossibleSize>,
        pub tile_size: Option<ImageSize>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct PossibleSize {
        pub size: Option<ImageSize>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct LocalizedText {
        pub text: String,
        pub language: String,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ImageDescription {
        pub description: Vec<LocalizedText>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ImageTitle {
        pub name: String,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct AttributionItem {
        pub name: Option<ImageTitle>,
        pub url: String,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ImageAuthor {
        pub name: Option<LocalizedText>,
        pub profile_url: String,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ImageAttribution {
        pub item: Vec<AttributionItem>,
        pub author: Vec<ImageAuthor>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct LatLng {
        pub lat: f64,
        pub lng: f64,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct Altitude {
        pub meters: f64,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct Pov {
        pub heading: f64,
        pub tilt: f64,
        pub roll: f64,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct Level {
        pub id: u64,
        pub ordinal: i32,
        pub name: Option<LocalizedText>,
        pub abbreviation: Option<LocalizedText>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct PanoLocation {
        pub location: Option<LatLng>,
        pub altitude: Option<Altitude>,
        pub pov: Option<Pov>,
        pub level: Option<Level>,
        pub country_code: String,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct Pano {
        pub key: Option<ImageKey>,
        pub location: Option<PanoLocation>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct PanoRelations {
        pub pano: Vec<Pano>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct PanoLinkProperties {
        pub heading: f64,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct PanoLink {
        pub target: i32,
        pub properties: Option<PanoLinkProperties>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct PanoDate {
        pub year: i32,
        pub month: i32,
        pub day: i32,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct PanoTime {
        pub target: i32,
        pub date: Option<PanoDate>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ImageInformation {
        pub status: Option<ImageStatus>,
        pub location: Option<PanoLocation>,
        pub relations: Option<PanoRelations>,
        pub link: Vec<PanoLink>,
        pub time: Vec<PanoTime>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct DateSourceInfo {
        pub source: String,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ImageDate {
        pub source_info: Option<DateSourceInfo>,
        pub date: Option<PanoDate>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct GetMetadataRequest {
        pub context: Option<RequestContext>,
        pub locale: Option<LocalizationContext>,
        pub key: Vec<KeyWrapper>,
        pub spec: Option<MetadataResponseSpecification>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct KeyWrapper {
        pub key: Option<ImageKey>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct MetadataResponseSpecification {
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct GetMetadataResponse {
        pub status: Option<ResponseStatus>,
        pub metadata: Vec<ImageMetadata>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct SingleImageSearchRequest {
        pub context: Option<RequestContext>,
        pub location: Option<Circle>,
        pub query_options: Option<QueryOptions>,
        pub response_specification: Option<ResponseSpecification>,
        pub image_key: Option<ImageKey>,
        pub feature: Option<SearchFeature>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct Circle {
        pub center: Option<LatLng>,
        pub radius: f64,
        pub level: Option<Level>,
        pub look_at_point: Option<LatLng>,
        pub tag: String,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct QueryOptions {
        pub filter_options: Option<FilterOptions>,
        pub localization_context: Option<LocalizationContext>,
        pub ranking_options: Option<RankingOptions>,
        pub client_capabilities: Option<ClientCapabilities>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct FilterOptions {
        pub format_restrictions: Option<FormatRestrictions>,
        pub restrict_to_ads_eligible: bool,
        pub restrict_to_directions_appropriate: bool,
        pub restrict_to_unknown4: bool,
        pub restrict_to_photos_with_focus_attribution: bool,
        pub restrict_to_syndication_eligible: bool,
        pub semantic_restrictions: Option<SemanticRestrictions>,
        pub restrict_to_owner_attributed_photos: bool,
        pub capture_time_range: Option<CaptureTimeRange>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct CaptureTimeRange {
        pub start: i64,
        pub end: i64,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct FormatRestrictions {
        pub image_format: i32,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct SemanticRestrictions {
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct RankingOptions {
        pub ranking_strategy: i32,
        pub logistic_curvature: f64,
        pub logistic_offset: f64,
        pub distance_ratio: f64,
        pub timestamp_options: Option<TimestampOptions>,
        pub qbica: Option<RankingUnknown6>,
        pub descriptor: String,
        pub similarity_options: Option<SimilarityOptions>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct TimestampOptions {
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct RankingUnknown6 {
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct SimilarityOptions {
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ClientCapabilities {
        pub supported_render_strategy: Vec<RenderStrategy>,
        pub max_dimension: Option<ImageSize>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct RenderStrategy {
        pub frontend: i32,
        pub tiled: bool,
        pub image_format: i32,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ResponseSpecification {
        pub navigation_channels: Vec<NavigationChannel>,
        pub http_response_format: i32,
        pub attribution: Option<AttributionSpec>,
        pub cursor_formats: Vec<CursorFormat>,
        pub target_overlay_formats: Vec<TargetOverlayFormat>,
        pub unknown7: bool,
        pub client_capabilities: Option<ClientCapabilities>,
        pub thumbnail: Option<ThumbnailSpec>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct NavigationChannel {
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct AttributionSpec {
        pub thumbnail_size: i32,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct CursorFormat {
        pub encoding: i32,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct TargetOverlayFormat {
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ThumbnailSpec {
        pub entry: Vec<ThumbnailEntry>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct ThumbnailEntry {
        pub size: Option<ImageSize>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct SearchFeature {
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct SingleImageSearchResponse {
        pub status: Option<ResponseStatus>,
        pub result: Option<ImageMetadata>,
    }
}
