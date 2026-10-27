use super::*;
use crate::selections::LocView;
use crate::store::arrow::locations_to_batch;
use crate::store::id_set::IdSet;
use mma_algebra::{Change, Delta};

fn location(id: u32, pano: Option<&str>, lat: f64, lng: f64) -> Location {
    Location {
        id: Id::new(id),
        pano_id: pano.map(Into::into),
        lat,
        lng,
        ..Default::default()
    }
}

#[test]
fn borrowed_columns_and_owned_rows_use_the_same_location_identity() {
    let rows = [
        location(1, Some("pano"), 0.0, 2.0),
        location(2, None, 3.0, 4.0),
    ];
    let batch = locations_to_batch(&rows);
    let removed = IdSet::new();
    let updated = HashMap::new();
    let added = [location(3, Some("overlay"), 5.0, 6.0)];
    let view = LocView::new(Some(&batch), &removed, &updated, &added, None);
    let keys = Location::identity();
    let mut held = Index::membership(&keys);
    for row in view.all().rows() {
        held.insert(row.id(), &row);
    }
    for (incoming, expected) in [
        (location(0, Some("pano"), 90.0, 90.0), true),
        (location(0, Some("different"), 0.0, 2.0), false),
        (location(0, None, -0.0, 2.0), true),
        (location(0, Some(""), 3.0, 4.0), true),
        (location(0, Some("overlay"), 0.0, 0.0), true),
        (location(0, None, 5.0, 6.0), true),
        (location(0, None, 7.0, 8.0), false),
    ] {
        assert_eq!(held.matches(&keys.preferred(), &incoming), expected);
    }
}

#[test]
fn schema_derived_projections_support_incremental_changes() {
    let before = location(1, Some("old"), 1.0, 2.0);
    let after = location(1, Some("new"), 3.0, 4.0);
    let keys = Location::identity();
    let mut held = Index::new(&keys);
    held.insert(before.id, &before);
    let change = Change {
        updated: vec![(before.clone(), after.clone())],
        ..Default::default()
    };
    held.apply(&held.project(&change, |row| row.id));
    assert!(!held.matches(&keys.preferred(), &before));
    assert!(held.matches(&keys.preferred(), &after));
    let removed = Change {
        removed: vec![after],
        ..Default::default()
    };
    held.apply(&held.project(&removed, |row| row.id));
    assert!(held.rows.is_empty());
}

#[test]
fn native_list_projection_indexes_members_not_an_owned_location() {
    let row = Location {
        id: Id::new(1),
        tags: vec![Id::new(7), Id::new(7), Id::new(9)],
        ..Default::default()
    };
    let mut tags = Index::new(Location::fields().tags);
    tags.insert(row.id, &RowRef::from_loc(&row));
    assert_eq!(tags.count(&Id::new(7)), 1);
    assert_eq!(tags.count(&Id::new(9)), 1);
    let mut after = row.clone();
    after.tags.reverse();
    let change = Change {
        updated: vec![(row, after)],
        ..Default::default()
    };
    assert!(tags.project(&change, |row| row.id).is_empty());
}
