use super::*;
use crate::test_util::tag_ids;
use mma_algebra::{Id, Patch, Patchable};
use std::collections::HashSet;
use std::marker::PhantomData;

type ExtraField = mma_algebra::Field<RawExtra>;

fn extra(json: &str) -> RawExtra {
    RawExtra::from_string_uncanonicalized(json).unwrap()
}

#[test]
fn get_scans_only_top_level_keys() {
    let e = extra(
        r#"{ "a" : 1, "nested": {"a": 99, "deep": [{"a": 5}]}, "arr": [1, 2], "s": "not:{\"a\":7}", "tz": "Asia/Tokyo" }"#,
    );
    assert_eq!(e.get("a"), Some(serde_json::json!(1)));
    assert_eq!(e.get("arr"), Some(serde_json::json!([1, 2])));
    assert_eq!(e.get("tz"), Some(serde_json::json!("Asia/Tokyo")));
    assert_eq!(e.get("s"), Some(serde_json::json!("not:{\"a\":7}")));
    assert_eq!(e.get("deep"), None); // exists only nested
    assert_eq!(e.get("missing"), None);
}

#[test]
fn get_handles_escapes_and_non_objects() {
    let e = extra(r#"{"q\"uote": 1, "b": "ends with \\", "c": true}"#);
    assert_eq!(e.get("b"), Some(serde_json::json!("ends with \\")));
    assert_eq!(e.get("c"), Some(serde_json::json!(true)));
    // Non-object extra (legacy passthrough): no fields to find.
    assert_eq!(extra(r#""just a string""#).get("a"), None);
}

/// The field `café` with its key ASCII-escaped, as an ensure_ascii encoder writes it.
fn escaped_key_extra() -> String {
    let bs = '\\';
    format!("{{\"caf{bs}u00e9\":\"au lait\"}}")
}

// Keys are matched on raw bytes, so an escaped key has to be decoded at every ingest
// point or it silently matches nothing.
#[test]
fn escaped_keys_are_canonicalized_on_ingest() {
    let escaped = escaped_key_extra();

    let from_str = RawExtra::from_string(escaped.clone()).unwrap();
    assert_eq!(from_str.as_str(), "{\"café\":\"au lait\"}");
    assert_eq!(from_str.get("café"), Some(serde_json::json!("au lait")));

    // IPC / on-disk JSON.
    let ipc: RawExtra = serde_json::from_str(&escaped).unwrap();
    assert_eq!(ipc.get("café"), Some(serde_json::json!("au lait")));

    // Field discovery reports the decoded name, so it registers as one field.
    let mut keys: Vec<String> = Vec::new();
    from_str.for_each_field(|k, _| keys.push(k.to_owned()));
    assert_eq!(keys, vec!["café"]);
}

#[test]
fn canonicalization_leaves_everything_else_byte_identical() {
    // No escaped key -> the exact input bytes survive (values keep their escapes, and
    // the common path never pays a reserialize).
    for src in [
        r#"{"café":"noir","n":1.50,"s":"a\"b\\cé"}"#,
        r#"{"a":1,"b":[1,2]}"#,
    ] {
        assert_eq!(RawExtra::from_string(src.to_owned()).unwrap().as_str(), src);
    }
    // A key that JSON *requires* to be escaped keeps the escape (shortest legal form).
    let bs = '\\';
    let quoted = RawExtra::from_string(format!("{{\"a{bs}u0022b\":1}}")).unwrap();
    assert_eq!(quoted.as_str(), r#"{"a\"b":1}"#);
    assert_eq!(quoted.get("a\"b"), None); // still unmatchable by raw-byte compare
}

#[test]
fn decode_json_key_decodes_only_escapes() {
    let bs = '\\';
    assert_eq!(decode_json_key("plain"), "plain");
    assert_eq!(decode_json_key(&format!("caf{bs}u00e9")), "café");
    assert_eq!(decode_json_key(&format!("a{bs}\"b")), "a\"b");
    // Undecodable input is passed through rather than mangled.
    assert_eq!(decode_json_key(&format!("a{bs}zb")), format!("a{bs}zb"));
}

#[test]
fn human_readable_json_round_trips_transparently() {
    let field: ExtraField = mma_algebra::Field::Set(extra(r#"{"k":[1,2,3]}"#));
    let json = serde_json::to_string(&field).unwrap();
    // Emitted inline as an object, not a quoted string.
    assert_eq!(json, r#"{"k":[1,2,3]}"#);
    let mma_algebra::Field::Set(back) = serde_json::from_str::<ExtraField>(&json).unwrap() else {
        panic!("the extra round-trips as a value");
    };
    assert_eq!(back.as_str(), r#"{"k":[1,2,3]}"#);
}

#[test]
fn rows_are_equal_exactly_when_the_patch_between_them_is_empty() {
    let row = Location {
        id: Id::new(1),
        heading: 10.0,
        modified_at: Some(1),
        ..Location::default()
    };
    let stamped = Location {
        modified_at: Some(2),
        ..row.clone()
    };
    let turned = Location {
        heading: 20.0,
        ..row.clone()
    };
    assert_eq!(row, stamped);
    assert_eq!(
        Location::between(&row, &stamped),
        Patch::<Location> {
            id: Id::new(1),
            ..Default::default()
        }
    );
    assert_ne!(row, turned);
    assert_eq!(Location::between(&row, &turned).heading, Some(20.0));
}

// -----------------------------------------------------------------------
// Property-based JSON round trip
// -----------------------------------------------------------------------

use proptest::prelude::*;

fn finite_f64() -> impl Strategy<Value = f64> {
    prop_oneof![
        1 => Just(0.0),
        1 => Just(-0.0),
        1 => Just(f64::MIN),
        1 => Just(f64::MAX),
        1 => Just(1.0 / 3.0),
        5 => -1.0e6f64..1.0e6,
    ]
}

fn arb_lat() -> impl Strategy<Value = f64> {
    prop_oneof![
        1 => Just(0.0),
        1 => Just(-0.0),
        1 => Just(90.0),
        1 => Just(-90.0),
        1 => Just(48.858_222_222_195_44),
        5 => -90.0f64..=90.0,
    ]
}

fn arb_lng() -> impl Strategy<Value = f64> {
    prop_oneof![
        1 => Just(0.0),
        1 => Just(-0.0),
        1 => Just(180.0),
        1 => Just(-180.0),
        1 => Just(2.352_222_222_195_44),
        5 => -180.0f64..=180.0,
    ]
}

fn arb_heading() -> impl Strategy<Value = f64> {
    prop_oneof![
        1 => Just(0.0),
        1 => Just(-0.0),
        1 => Just(360.0),
        1 => Just(123.456_789_012_3),
        5 => 0.0f64..=360.0,
    ]
}

fn arb_string() -> impl Strategy<Value = String> {
    prop_oneof![
        3 => "[a-zA-Z0-9_]{0,16}",
        2 => ".{0,12}",
        1 => Just(String::new()),
        1 => Just("caf\u{00e9}_\u{4e2d}\u{6587}_\u{1f600}".to_string()),
        1 => Just("\u{0000}\u{001f}".to_string()),
    ]
}

fn arb_pano_id() -> impl Strategy<Value = Option<String>> {
    prop_oneof![1 => Just(None), 3 => arb_string().prop_map(Some)]
}

fn arb_tags() -> impl Strategy<Value = Vec<u32>> {
    prop::collection::vec(any::<u32>(), 0..64)
}

fn arb_extra_map() -> impl Strategy<Value = serde_json::Map<String, serde_json::Value>> {
    prop::collection::vec((arb_string(), arb_string()), 1..5).prop_map(|pairs| {
        pairs
            .into_iter()
            .map(|(k, v)| (k, serde_json::Value::String(v)))
            .collect()
    })
}

fn arb_extra() -> impl Strategy<Value = Option<RawExtra>> {
    prop_oneof![
        1 => Just(None),
        3 => arb_extra_map().prop_map(|m| RawExtra::from_map(&m)),
    ]
}

fn arb_modified_at() -> impl Strategy<Value = Option<u32>> {
    prop_oneof![1 => Just(None), 3 => any::<u32>().prop_map(Some)]
}

fn arb_location() -> impl Strategy<Value = Location> {
    (
        any::<u32>(),
        arb_lat(),
        arb_lng(),
        arb_heading(),
        finite_f64(),
        finite_f64(),
        arb_pano_id(),
        any::<u32>().prop_map(LocationFlags::from_bits_retain),
        arb_tags(),
        arb_extra(),
        any::<u32>(),
        arb_modified_at(),
    )
        .prop_map(
            |(
                id,
                lat,
                lng,
                heading,
                pitch,
                zoom,
                pano_id,
                flags,
                tags,
                extra,
                created_at,
                modified_at,
            )| {
                Location {
                    id: Id::new(id),
                    lat,
                    lng,
                    heading,
                    pitch,
                    zoom,
                    pano_id: pano_id.map(Into::into),
                    flags,
                    tags: tag_ids(tags),
                    extra,
                    created_at,
                    modified_at,
                }
            },
        )
}

#[test]
fn unstable_const_carries_the_tag_whatever_its_docs() {
    let bare = TsConst::value(1).unstable().render("A");
    assert!(bare.contains("/** @unstable */\nexport const A"));
    let one = TsConst::value(1).with_doc(&["One."]).unstable().render("A");
    assert!(one.contains("/** One. @unstable */\nexport const A"));
    let many = TsConst::value(1)
        .with_doc(&["One.", "Two."])
        .unstable()
        .render("A");
    assert!(many.contains(" * Two.\n * @unstable\n */\nexport const A"));
    assert!(!TsConst::value(1).render("A").contains("@unstable"));
}

// The wire strings are the contract `src/lib/util/format.ts` maps to messages; whatever follows
// ": " is data the TS side parses.
#[test]
fn err_codes_are_unique_and_detail_separated() {
    let mut seen = HashSet::new();
    for code in ErrCode::ALL {
        assert!(seen.insert(code.wire()), "duplicate code {}", code.wire());
        assert!(
            !code.wire().contains(": "),
            "a code may not contain the detail separator: {}",
            code.wire()
        );
        assert_eq!(code.err().0, code.wire());
        assert_eq!(code.with(7).0, format!("{}: 7", code.wire()));
    }
}

proptest! {
    #[test]
    fn prop_location_json_round_trip(loc in arb_location()) {
        let json = serde_json::to_string(&loc).unwrap();
        let back: Location = serde_json::from_str(&json).unwrap();
        prop_assert_eq!(loc, back);
    }

    #[test]
    fn prop_location_json_timestamps_are_numbers(loc in arb_location()) {
        let value = serde_json::to_value(&loc).unwrap();
        prop_assert!(value["createdAt"].is_number());
        if loc.modified_at.is_some() {
            prop_assert!(value["modifiedAt"].is_number());
        } else {
            prop_assert!(value["modifiedAt"].is_null());
        }
    }
}

#[test]
fn raw_extra_patches_use_normal_equality_and_collapse_empty_objects() {
    let old = Some(extra(r#"{ "n": 1, "keep": true }"#));
    let equivalent = Some(extra(r#"{"keep":true,"n":1.0}"#));
    assert_eq!(old, equivalent);
    assert_eq!(
        Option::<RawExtra>::between(&old, &equivalent),
        mma_algebra::Field::Keep
    );
    assert_eq!(
        Option::<RawExtra>::between(&old, &None),
        mma_algebra::Field::Clear
    );
    assert_eq!(
        old.patched(&mma_algebra::Field::Set(
            serde_json::json!({"n":null,"keep":null}).into()
        )),
        None
    );
}

#[test]
fn derived_whole_value_policies_and_field_overrides() {
    #[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, mma_fields::Patch)]
    #[patch(merge)]
    #[serde(rename_all = "camelCase")]
    struct Document {
        merged_child: serde_json::Value,
        #[patch(replace)]
        replaced_child: serde_json::Value,
        #[patch(replace)]
        #[serde(rename = "renamed")]
        named_child: serde_json::Value,
    }
    let old = Document {
        merged_child: serde_json::json!({"keep":1,"change":2}),
        replaced_child: serde_json::json!({"drop":1}),
        named_child: serde_json::json!({"drop":2}),
    };
    let updated = old.patched(
        &serde_json::json!({
            "mergedChild":{"change":3},
            "replacedChild":{"literal":null},
            "renamed":{"new":4}
        })
        .into(),
    );
    assert_eq!(
        updated.merged_child,
        serde_json::json!({"keep":1,"change":3})
    );
    assert_eq!(updated.replaced_child, serde_json::json!({"literal":null}));
    assert_eq!(updated.named_child, serde_json::json!({"new":4}));
    assert_eq!(old.patched(&Document::between(&old, &updated)), updated);
    assert_eq!(updated.patched(&Document::between(&updated, &old)), old);

    #[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, mma_fields::Patch)]
    #[patch(replace)]
    struct Replacement {
        ordinary: serde_json::Value,
        #[patch(merge)]
        merged: serde_json::Value,
    }
    let old = Replacement {
        ordinary: serde_json::json!({"drop":1}),
        merged: serde_json::json!({"keep":2}),
    };
    let updated = old.patched(&serde_json::json!({"ordinary":{"new":3},"merged":{"new":4}}).into());
    assert_eq!(updated.ordinary, serde_json::json!({"new":3}));
    assert_eq!(updated.merged, serde_json::json!({"keep":2,"new":4}));
    assert_eq!(old.patched(&Replacement::between(&old, &updated)), updated);

    #[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, mma_fields::Patch)]
    #[patch(replace)]
    struct Whole(serde_json::Value);
    let before = Whole(serde_json::json!({"old":1}));
    let after = before.patched(&serde_json::json!({"literal":null}).into());
    assert_eq!(after.0, serde_json::json!({"literal":null}));
    assert_eq!(before.patched(&Whole::between(&before, &after)), after);
}

#[test]
fn a_location_patch_can_be_read_but_not_written() {
    struct Probe<T>(PhantomData<T>);
    trait Unwritable {
        fn writable(&self) -> bool {
            false
        }
    }
    impl<T> Unwritable for Probe<T> {}
    impl<T: serde::Serialize> Probe<T> {
        fn writable(&self) -> bool {
            true
        }
    }
    assert!(Probe::<Location>(PhantomData).writable());
    assert!(!Probe::<Patch<Location>>(PhantomData).writable());
}

#[test]
fn raw_extra_derived_merge_is_recursive_and_replacement_preserves_null() {
    let before = Location {
        extra: Some(extra(r#"{"nested":{"keep":1,"change":2}}"#)),
        ..Location::default()
    };
    let patch: Patch<Location> = serde_json::from_value(serde_json::json!({
        "id":0,"extra":{"nested":{"change":3}}
    }))
    .unwrap();
    let after = before.patched(&patch);
    assert_eq!(
        after.extra.as_ref().unwrap().get("nested"),
        Some(serde_json::json!({"keep":1,"change":3}))
    );
    assert_eq!(before.patched(&Location::between(&before, &after)), after);
    let nullable = Location {
        extra: Some(extra(r#"{"nested":{"literal":null}}"#)),
        ..before.clone()
    };
    assert_eq!(
        before.patched(&Location::between(&before, &nullable)),
        nullable
    );
    assert_eq!(
        nullable.patched(&Location::between(&nullable, &before)),
        before
    );
    let bare = Location::default();
    assert_eq!(bare.patched(&Location::between(&bare, &nullable)), nullable);
    assert_eq!(
        nullable.patched(&Location::between(&nullable, &nullable)),
        nullable
    );
    let old = HashMap::from([(0u32, before)]);
    let new = HashMap::from([(0u32, nullable)]);
    let edits = HashMap::between(&old, &new);
    assert_eq!(old.patched(&edits), new);
}

#[test]
fn merge_policy_supports_generic_wrappers_and_optional_members() {
    #[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, mma_fields::Patch)]
    #[patch(merge)]
    struct Wrapper<T>(T);
    let old = Wrapper(serde_json::json!({"nested":{"keep":1,"drop":2}}));
    assert_eq!(
        old.patched(&serde_json::json!({"nested":{"drop":null}}).into()),
        Wrapper(serde_json::json!({"nested":{"keep":1}}))
    );
    #[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, mma_fields::Patch)]
    #[patch(merge)]
    struct Document {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<serde_json::Value>,
    }
    let old = Document {
        value: Some(serde_json::json!({"nested":1})),
    };
    assert_eq!(
        old.patched(&serde_json::json!({"value":null}).into()),
        Document { value: None }
    );
}

#[test]
fn raw_extra_empty_objects_mean_no_extra() {
    assert_eq!(RawExtra::from_string("{}".into()), None);
    assert_eq!(RawExtra::from_map(&serde_json::Map::new()), None);
    let last = Some(extra(r#"{"last":1}"#));
    assert_eq!(
        last.patched(&mma_algebra::Field::Set(
            serde_json::json!({"last":null}).into()
        )),
        None
    );
    assert_eq!(
        Option::<RawExtra>::None.patched(&mma_algebra::Field::Set(
            serde_json::json!({"gone":null}).into()
        )),
        None
    );
}

#[test]
fn an_extra_that_is_an_empty_object_reads_as_no_extra() {
    let row = |extra: Option<serde_json::Value>| {
        let mut row = serde_json::to_value(Location::default()).unwrap();
        match extra {
            Some(extra) => row["extra"] = extra,
            None => {
                row.as_object_mut().unwrap().remove("extra");
            }
        }
        row
    };
    let readable = |extra| {
        serde_json::from_value::<Location>(row(extra))
            .unwrap()
            .extra
    };
    let text = |extra| {
        serde_json::from_str::<Location>(&row(extra).to_string())
            .unwrap()
            .extra
    };
    let binary = |extra| {
        rmp_serde::from_slice::<Location>(&rmp_serde::to_vec_named(&row(extra)).unwrap())
            .unwrap()
            .extra
    };
    let reads: [&dyn Fn(Option<serde_json::Value>) -> Option<RawExtra>; 3] =
        [&readable, &text, &binary];
    for read in reads {
        assert_eq!(read(None), None);
        assert_eq!(read(Some(serde_json::Value::Null)), None);
        assert_eq!(read(Some(serde_json::json!({}))), None);
        let kept = read(Some(serde_json::json!({ "a": 1 }))).unwrap();
        assert_eq!(kept.get("a"), Some(serde_json::json!(1)));
    }
    for empty in [serde_json::json!("{}"), serde_json::json!(" { } ")] {
        assert_eq!(binary(Some(empty)), None);
    }
    assert!(serde_json::from_value::<Location>(serde_json::json!({ "extra": {} })).is_err());
    assert!(serde_json::from_str::<RawExtra>("{}").is_err());
    assert_eq!(RawExtra::from_string(" { } ".into()), None);
    assert_eq!(RawExtra::from_value(&serde_json::json!({})), None);
    let kept = Some(extra(r#"{"a":1}"#));
    let gone = kept.patched(&mma_algebra::Field::Set(
        serde_json::json!({ "a": null }).into(),
    ));
    assert_eq!(gone, None);
}

#[test]
fn a_new_location_keeps_the_creation_time_it_brings_and_is_stamped_without_one() {
    let at = |created_at| Location {
        created_at,
        modified_at: Some(5),
        ..Location::default()
    };
    assert_eq!(at(1_718_461_800).created(99).created_at, 1_718_461_800);
    assert_eq!(at(0).created(99).created_at, 99);
    assert_eq!(at(1_718_461_800).created(99).modified_at, None);
}
