use super::*;
use crate::country_weights as cw;

#[test]
fn tables_parse_and_are_populated() {
    let t = tables();
    assert_eq!(t.countries.len(), t.country_names.len());
    assert!(t.countries.len() > 100);
    assert!(t.subdivision_names.len() > 100);
    assert!(t.subdivision_weights.len() > 100);
    assert_eq!(t.presets.len(), cw::ALL.len());
    for key in cw::ALL {
        assert!(!cw::preset(key).is_empty(), "preset {key} missing");
    }
}

#[test]
fn spot_checks() {
    assert_eq!(crate::names::country_name("JP"), "Japan");
    assert_eq!(crate::names::country_name("ZZ"), "");
    assert_eq!(
        crate::names::subdivision_name("GE", "GE-TB"),
        Some("Tbilisi")
    );
    assert_eq!(crate::names::subdivision_name("GE", "GE-ZZ"), None);
    let ge = crate::weights::subdivision_weights("GE").unwrap();
    assert_eq!(ge.iter().find(|(c, _)| *c == "GE-IM").unwrap().1, 321);
    assert!(crate::weights::subdivision_weights("ZZ").is_none());
    let pro = cw::preset(cw::PRO_WORLD);
    assert_eq!(pro.iter().find(|(c, _)| *c == "US").unwrap().1, 11800);
    assert!(cw::preset("NOT_A_PRESET").is_empty());
}
