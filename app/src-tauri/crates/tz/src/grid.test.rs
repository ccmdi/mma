use super::*;

static GRID: &[u8] = include_bytes!("../../../data/tzgrid.bin");
static FIXTURE: &[u8] = include_bytes!("../testdata/tzgrid-fixture.bin");

fn grid() -> TzGrid<'static> {
    TzGrid::new(GRID).unwrap()
}

/// Every fixture case was answered by @photostructure/tz-lookup itself
/// (scripts/gen-tzgrid.mjs); the port must agree on all of them.
#[test]
fn agrees_with_the_js_oracle_fixture() {
    let g = grid();
    assert_eq!(FIXTURE.len() % 18, 0);
    for case in FIXTURE.chunks_exact(18) {
        let lat = f64::from_le_bytes(case[0..8].try_into().unwrap());
        let lng = f64::from_le_bytes(case[8..16].try_into().unwrap());
        let want = u16::from_le_bytes(case[16..18].try_into().unwrap()) as usize;
        assert_eq!(
            g.zone_at(lat, lng),
            Some(g.zone_name(want)),
            "at ({lat}, {lng})"
        );
    }
}

#[test]
fn out_of_range_is_none() {
    let g = grid();
    assert_eq!(g.zone_at(90.0001, 0.0), None);
    assert_eq!(g.zone_at(0.0, 180.0001), None);
    assert_eq!(g.zone_at(f64::NAN, 0.0), None);
    assert_eq!(g.zone_at(0.0, f64::NAN), None);
    assert_eq!(g.zone_at(90.0, 0.0), Some("Etc/GMT"));
}

#[test]
fn rejects_garbage() {
    assert_eq!(TzGrid::new(b"nope").err(), Some(Error::Truncated));
    assert_eq!(TzGrid::new(&[0u8; 64]).err(), Some(Error::BadMagic));
}
