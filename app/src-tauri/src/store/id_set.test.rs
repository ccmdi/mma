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
    a.clear();
    assert!(a.is_empty());
}
