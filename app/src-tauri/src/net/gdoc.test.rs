use super::*;

#[test]
fn gdoc_id_validation() {
    assert!(valid_gdoc_id(
        "1wsa06GGiq1LEGwhkiPP0FKIZJqdAiue-VeBonWAzAyk"
    ));
    assert!(valid_gdoc_id("abc_DEF-123"));
    // Anything that could redirect the proxy elsewhere is rejected.
    assert!(!valid_gdoc_id(""));
    assert!(!valid_gdoc_id("../other/path"));
    assert!(!valid_gdoc_id("id/extra"));
    assert!(!valid_gdoc_id("id?format=html"));
    assert!(!valid_gdoc_id("id#frag"));
    assert!(!valid_gdoc_id("id with space"));
}
