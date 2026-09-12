use super::*;

const OFFICIAL: &str = "-zrYsLR4Fh-cfJG_EMZ1-A";
const UPLOADED: &str = "CAoSF0NJSE0wb2dLRUlDQWdJQ0VtX2l4cXdF";
const UPLOADED_KEY: &str = "CIHM0ogKEICAgICEm_ixqwE";

#[test]
fn official_ids_are_twenty_two_base64url_characters_ending_in_a_key_bit() {
    assert!(is_official(OFFICIAL));
    assert!(is_official("AAAAAAAAAAAAAAAAAAAAAQ"));
    assert!(!is_official("AAAAAAAAAAAAAAAAAAAAAB"));
    assert!(!is_official("AAAAAAAAAAAAAAAAAAAAA"));
    assert!(!is_official("F:AAAAAAAAAAAAAAAAAAAA"));
    assert!(!is_official("AAAAAAAAAAAAAAAAAAAA+Q"));
    assert!(!is_official(""));
}

#[test]
fn each_collection_round_trips_through_its_key() {
    for id in [OFFICIAL, "F:abc123", UPLOADED] {
        let (frontend, key) = to_image_key(id);
        assert_eq!(from_image_key(frontend, &key), id);
    }
}

#[test]
fn an_uploaded_id_is_a_key_in_its_own_right() {
    assert_eq!(to_image_key(UPLOADED), (10, UPLOADED_KEY.to_string()));
    assert_eq!(from_image_key(10, UPLOADED_KEY), UPLOADED);
}

#[test]
fn a_bare_contributor_key_resolves_over_the_user_uploaded_frontend() {
    // 22-char "CIHM…" keys collide with the official shape; sent as official, GetMetadata
    // answers nothing for them.
    assert_eq!(
        to_image_key("CIHM0ogKEICAgICTzu7WYg"),
        (10, "CIHM0ogKEICAgICTzu7WYg".to_string())
    );
    assert_eq!(to_image_key(UPLOADED_KEY), (10, UPLOADED_KEY.to_string()));
}

#[test]
fn an_id_that_is_not_a_key_stays_itself_as_official_coverage() {
    assert_eq!(to_image_key("not base64 at all"), (2, "not base64 at all".to_string()));
    assert_eq!(to_image_key(""), (2, String::new()));
}

#[test]
fn a_key_with_no_id_has_no_pano() {
    assert_eq!(from_image_key(2, ""), "");
    assert_eq!(from_image_key(10, ""), "");
}

#[test]
fn a_frontend_of_zero_reads_as_official() {
    assert_eq!(from_image_key(0, OFFICIAL), OFFICIAL);
}

// Reference vectors captured from the Maps JS API, which pads the base64 with ".".
#[test]
fn non_official_keys_spell_like_the_maps_js_api_dot_padding_included() {
    assert_eq!(from_image_key(10, "abc"), "CAoSA2FiYw..");
    assert_eq!(
        from_image_key(10, "AF1QipMnotARealPhotoIdButRepresentative_0123456789"),
        "CAoSMkFGMVFpcE1ub3RBUmVhbFBob3RvSWRCdXRSZXByZXNlbnRhdGl2ZV8wMTIzNDU2Nzg5"
    );
    // 200 bytes of id plus the two tags, the frontend and the 2-byte length varint.
    let huge = from_image_key(10, &"x".repeat(200));
    assert_eq!(huge.len(), 206_usize.div_ceil(3) * 4);
    assert!(huge.starts_with("CAoSyAF4eHh4") && huge.ends_with("eHh4eA.."));
}
