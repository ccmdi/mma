use super::*;

fn have_vali_data() -> bool {
    vali_data::paths::data_root()
        .map(|r| r.join("RU").join("RU+RU-AL.bin").exists())
        .unwrap_or(false)
}

// Runs the full definition -> prepare -> generate -> ValiLocation path against real
// coverage data; skipped on machines without it (CI).
#[test]
fn vali_generate_produces_locations() {
    if !have_vali_data() {
        return;
    }
    let definition = r#"{
        countryCodes: ["RU"],
        subdivisionInclusions: { RU: ["RU-AL"] },
        distributionStrategy: { key: "FixedCountByMaxMinDistance", locationCountGoal: 25, minMinDistance: 100 },
    }"#;
    let def: vali_core::MapDefinition = json5::from_str(definition).unwrap();
    let prepared = prepare(&def).unwrap();
    let root = vali_data::paths::data_root().unwrap();
    let events = std::sync::Mutex::new(Vec::new());
    let on_event = |e: ProgressEvent| events.lock().unwrap().push(e);
    let output = generate_output(&prepared, &root, true, Some(&on_event), None).unwrap();

    let locations: Vec<ValiLocation> = output.records.into_iter().map(ValiLocation::from).collect();
    assert_eq!(locations.len(), 25);
    assert!(locations.iter().all(|l| (-90.0..=90.0).contains(&l.lat)));

    let events = events.into_inner().unwrap();
    assert!(matches!(
        events.first(),
        Some(ProgressEvent::WorkItems { total: 1 })
    ));
    assert!(events.iter().any(|e| matches!(
        e,
        ProgressEvent::WorkItemDone {
            done: 1,
            total: 1,
            ..
        }
    )));
}

#[test]
fn vali_generate_rejects_bad_definition() {
    let err = json5::from_str::<vali_core::MapDefinition>("{ not json").unwrap_err();
    assert!(!err.to_string().is_empty());
    let def: vali_core::MapDefinition = json5::from_str(r#"{ countryCodes: ["XX"] }"#).unwrap();
    assert!(prepare(&def).is_err());
}

#[test]
fn vali_subdivisions_exports_weights() {
    let out = vali_subdivisions("NO".to_string()).unwrap();
    assert!(out.contains("\"NO-03\""));
}
