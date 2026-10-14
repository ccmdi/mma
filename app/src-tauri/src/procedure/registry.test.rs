use super::*;
use crate::selections::Selector;
use std::string::ToString;

fn def(id: &str, fields: &[&str], provides: &[&str], requires: &[&str]) -> ProviderDef {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "label": id,
        "entry": format!("res://procedures/{id}.js"),
        "config": "{\"radius\":50}",
        "fields": fields,
        "provides": provides,
        "requires": requires,
        "batch": { "mode": "chunk", "size": 10 },
    }))
    .unwrap()
}

fn outputs(dependents: &Dependents<String>, input: &str) -> Vec<String> {
    let mut outputs: Vec<String> = dependents
        .outputs_of([&input.to_string()])
        .into_iter()
        .collect();
    outputs.sort();
    outputs
}

fn run(id: &str, fields: Option<&[&str]>) -> RunItem {
    RunItem::Provider {
        id: id.into(),
        fields: fields.map(|f| f.iter().map(ToString::to_string).collect()),
        select: Selector::Everything,
        config: None,
        force: None,
    }
}

#[test]
fn dependents_map_each_input_to_what_its_providers_write() {
    let mut providers = Providers::default();
    providers.register(def("panoResolve", &[], &["panoId"], &["lat", "lng"]));
    providers.register(def(
        "svMeta",
        &["imageDate", "countryCode"],
        &[],
        &["panoId"],
    ));
    let dependents = providers.dependents();
    assert_eq!(outputs(&dependents, "lat"), ["panoId"]);
    assert_eq!(outputs(&dependents, "panoId"), ["countryCode", "imageDate"]);

    providers.unregister("svMeta");
    assert!(outputs(&providers.dependents(), "panoId").is_empty());
}

#[test]
fn registering_an_id_again_replaces_the_provider() {
    let mut providers = Providers::default();
    providers.register(def("sun", &["sunAltitude"], &[], &["lat"]));
    providers.register(def("sun", &["sunAzimuth"], &[], &["lng"]));
    let dependents = providers.dependents();
    assert!(outputs(&dependents, "lat").is_empty());
    assert_eq!(outputs(&dependents, "lng"), ["sunAzimuth"]);
}

#[test]
fn a_provider_run_takes_its_declaration_from_the_registry() {
    let mut providers = Providers::default();
    providers.register(def("panoResolve", &[], &["panoId"], &["lat"]));
    providers.register(def(
        "svMeta",
        &["imageDate", "countryCode"],
        &[],
        &["panoId"],
    ));
    let decls = providers
        .resolve(vec![
            run("panoResolve", None),
            run("svMeta", Some(&["imageDate"])),
        ])
        .unwrap();
    assert_eq!(decls.len(), 2);
    assert_eq!(decls[0].fields, vec!["panoId".to_string()]);
    assert_eq!(decls[1].fields, vec!["imageDate".to_string()]);
    assert_eq!(decls[1].requires, vec!["panoId".to_string()]);
    assert_eq!(
        decls[1].procedure.config.as_deref(),
        Some("{\"radius\":50}")
    );
    assert_eq!(decls[1].sink, Sink::Patch);
}

#[test]
fn a_run_config_replaces_the_registered_one() {
    let mut providers = Providers::default();
    providers.register(def("panoResolve", &[], &["panoId"], &[]));
    let decls = providers
        .resolve(vec![RunItem::Provider {
            id: "panoResolve".into(),
            fields: None,
            select: Selector::Everything,
            config: Some("{\"sources\":[1]}".into()),
            force: Some(true),
        }])
        .unwrap();
    assert_eq!(
        decls[0].procedure.config.as_deref(),
        Some("{\"sources\":[1]}")
    );
    assert_eq!(decls[0].force, Some(true));
}

#[test]
fn an_unregistered_provider_fails_the_run() {
    let providers = Providers::default();
    assert!(providers.resolve(vec![run("missing", None)]).is_err());
}

#[test]
fn a_procedure_item_passes_through_as_declared() {
    let providers = Providers::default();
    let decl: ProviderDecl = serde_json::from_value(serde_json::json!({
        "id": "validate",
        "entry": "res://procedures/validate.js",
        "select": { "type": "Everything" },
        "batch": { "mode": "chunk", "size": 200 },
        "sink": "collect",
    }))
    .unwrap();
    let decls = providers.resolve(vec![RunItem::Procedure(decl)]).unwrap();
    assert_eq!(decls[0].id, "validate");
    assert_eq!(decls[0].sink, Sink::Collect);
}

#[test]
fn run_items_read_from_the_wire_by_kind() {
    let items: Vec<RunItem> = serde_json::from_value(serde_json::json!([
        { "kind": "provider", "id": "svMeta", "select": { "type": "Everything" }, "fields": ["imageDate"] },
        {
            "kind": "procedure",
            "id": "validate",
            "entry": "res://procedures/validate.js",
            "select": { "type": "Everything" },
            "batch": { "mode": "chunk", "size": 200 },
        },
    ]))
    .unwrap();
    assert!(matches!(&items[0], RunItem::Provider { id, .. } if id == "svMeta"));
    assert!(matches!(&items[1], RunItem::Procedure(decl) if decl.id == "validate"));
}
