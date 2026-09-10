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
