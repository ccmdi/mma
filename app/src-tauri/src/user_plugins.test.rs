use super::*;

fn manifest(json: &str) -> PluginManifest {
    serde_json::from_str(json).expect("manifest should parse")
}

#[test]
fn a_plugin_without_a_procedure_installs_only_main() {
    let m = manifest(r#"{"id":"heatmap","main":"index.js"}"#);
    assert_eq!(install_files(&m).unwrap(), vec!["index.js"]);
}

#[test]
fn a_declared_procedure_is_installed_alongside_main() {
    let m = manifest(r#"{"id":"weather","main":"index.js","procedure":"procedure.js"}"#);
    assert_eq!(install_files(&m).unwrap(), vec!["index.js", "procedure.js"]);
}

#[test]
fn a_file_field_that_could_escape_the_plugin_directory_is_rejected() {
    for file in ["../evil.js", "sub/evil.js", r"sub\evil.js", ""] {
        let m = manifest(&format!(
            r#"{{"id":"x","main":"index.js","procedure":{}}}"#,
            serde_json::Value::from(file)
        ));
        assert!(
            install_files(&m).is_err(),
            "procedure {file:?} should be rejected"
        );
        let m = manifest(&format!(
            r#"{{"id":"x","main":{}}}"#,
            serde_json::Value::from(file)
        ));
        assert!(install_files(&m).is_err(), "main {file:?} should be rejected");
    }
}
