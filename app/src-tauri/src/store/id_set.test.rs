use super::*;
use crate::test_util::loc_ids;
use crate::types::Location;

#[test]
fn membership_and_set_operations_preserve_raw_ids() {
    let mut a: IdSet<Location> = loc_ids([0, 7, 7, u32::MAX]).into_iter().collect();
    let b: IdSet<Location> = loc_ids([7, 9]).into_iter().collect();
    assert_eq!(a.len(), 3);
    assert_eq!(a.iter().collect::<Vec<_>>(), loc_ids([0, 7, u32::MAX]));
    assert_eq!(
        (&a | &b).iter().collect::<Vec<_>>(),
        loc_ids([0, 7, 9, u32::MAX])
    );
    assert_eq!((&a & &b).iter().collect::<Vec<_>>(), loc_ids([7]));
    assert_eq!((&a - &b).iter().collect::<Vec<_>>(), loc_ids([0, u32::MAX]));
    assert!(!a.insert(Id::new(7)));
    assert!(a.remove(Id::new(7)));
    assert!(!a.contains(Id::new(7)));
    assert!(!a.remove(Id::new(7)));
}

#[test]
fn every_form_of_each_set_operation_agrees() {
    let a: IdSet<Location> = loc_ids([1, 2, 3, 70_000]).into_iter().collect();
    let b: IdSet<Location> = loc_ids([2, 3, 4, 140_000]).into_iter().collect();
    let ids = |set: &IdSet<Location>| set.iter().collect::<Vec<_>>();

    let union = loc_ids([1, 2, 3, 4, 70_000, 140_000]);
    let (mut owned, mut borrowed) = (a.clone(), a.clone());
    owned |= b.clone();
    borrowed |= &b;
    for set in [
        &a | &b,
        a.clone() | b.clone(),
        a.clone() | &b,
        owned,
        borrowed,
    ] {
        assert_eq!(ids(&set), union);
    }

    let both = loc_ids([2, 3]);
    let (mut owned, mut borrowed) = (a.clone(), a.clone());
    owned &= b.clone();
    borrowed &= &b;
    for set in [
        &a & &b,
        a.clone() & b.clone(),
        a.clone() & &b,
        owned,
        borrowed,
    ] {
        assert_eq!(ids(&set), both);
    }

    let only_a = loc_ids([1, 70_000]);
    let (mut owned, mut borrowed) = (a.clone(), a.clone());
    owned -= b.clone();
    borrowed -= &b;
    for set in [
        &a - &b,
        a.clone() - b.clone(),
        a.clone() - &b,
        owned,
        borrowed,
    ] {
        assert_eq!(ids(&set), only_a);
    }
    assert_eq!(ids(&a), loc_ids([1, 2, 3, 70_000]));
    assert_eq!(ids(&b), loc_ids([2, 3, 4, 140_000]));
}
