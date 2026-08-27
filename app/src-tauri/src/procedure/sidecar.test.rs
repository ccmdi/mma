use super::*;

fn parse(json: &str) -> AppResult<SidecarSpec> {
    let val: serde_json::Value = serde_json::from_str(json)?;
    SidecarSpec::from_manifest(&val)
}

fn spec(json: &str) -> SidecarSpec {
    parse(json).expect("spec should parse")
}

#[test]
fn parses_name_version_serve_and_checksums() {
    let s = spec(
        r#"{"sidecar":{"name":"mma-vision","version":"1.0.0","serve":["search-text"],"sha256-windows-x64":"abc"}}"#,
    );
    assert_eq!(s.name, "mma-vision");
    assert_eq!(s.version.as_deref(), Some("1.0.0"));
    assert_eq!(s.serve, vec!["search-text"]);
    assert_eq!(s.sha256("windows-x64"), Some("abc"));
    assert_eq!(s.sha256("linux-x64"), None);
}

#[test]
fn missing_serve_means_every_command_is_one_shot() {
    let s = spec(r#"{"sidecar":{"name":"mma-copyright","version":"1.0.0"}}"#);
    assert!(s.serve.is_empty());
    assert!(!s.is_resident("detect"));
    assert!(!s.is_resident("serve"));
}

#[test]
fn routes_only_declared_commands_to_the_resident() {
    let s = spec(r#"{"sidecar":{"name":"a","serve":["search-text","list-cached"]}}"#);
    assert!(s.is_resident("search-text"));
    assert!(s.is_resident("list-cached"));
    assert!(!s.is_resident("embed"));
    // Substrings must not match: routing is exact.
    assert!(!s.is_resident("search"));
    assert!(!s.is_resident("search-text-extra"));
}

#[test]
fn rejects_manifests_without_a_usable_sidecar() {
    assert!(parse(r#"{"id":"plain"}"#).is_err());
    assert!(parse(r#"{"sidecar":{"version":"1.0.0"}}"#).is_err());
    assert!(parse("not json").is_err());
}

// Names and commands reach argv and a URL path, so anything outside the ident
// charset must be refused at parse time rather than at spawn time.
#[test]
fn rejects_unsafe_names_and_commands() {
    assert!(parse(r#"{"sidecar":{"name":"../evil"}}"#).is_err());
    assert!(parse(r#"{"sidecar":{"name":"ok","serve":["../../x"]}}"#).is_err());
    assert!(parse(r#"{"sidecar":{"name":"ok","serve":["a b"]}}"#).is_err());
}

#[test]
fn every_invocation_carries_model_and_data_dirs() {
    let args = build_args("detect", Some("/tmp/in.json"), "/m", "/d");
    assert_eq!(
        args,
        vec![
            "detect",
            "--input",
            "/tmp/in.json",
            "--model-dir",
            "/m",
            "--data-dir",
            "/d",
        ]
    );
}

#[test]
fn omits_input_when_there_is_no_payload() {
    let args = build_args("list-cached", None, "/m", "/d");
    assert_eq!(
        args,
        vec!["list-cached", "--model-dir", "/m", "--data-dir", "/d"]
    );
}

// The idle budget is what lets an orphaned resident exit itself, so `serve` must
// carry it and nothing else may.
#[test]
fn only_serve_carries_the_idle_budget() {
    let args = build_args(SERVE_COMMAND, None, "/m", "/d");
    assert_eq!(
        args,
        vec![
            "serve",
            "--model-dir",
            "/m",
            "--data-dir",
            "/d",
            "--idle-secs",
            "600",
        ]
    );
    assert!(!build_args("embed", None, "/m", "/d").contains(&"--idle-secs".to_string()));
}

// `serve` is app-managed; requested directly it would sit as a never-finishing
// one-shot holding a port.
#[test]
fn serve_cannot_be_requested() {
    assert!(sidecar_request("vision".into(), "serve".into(), None).is_err());
}

// --- Registry ---

fn sleeper() -> Child {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("ping");
        c.args(["-n", "30", "127.0.0.1"]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sleep");
        c.arg("30");
        c
    };
    cmd.stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn sleeper")
}

fn track(plugin_id: &str, req_id: u32) -> Arc<Mutex<Child>> {
    let child = Arc::new(Mutex::new(sleeper()));
    lock(&plugin_slot(plugin_id))
        .children
        .insert(req_id, child.clone());
    child
}

fn exited(child: &Arc<Mutex<Child>>) -> bool {
    !matches!(lock(child).try_wait(), Ok(None))
}

#[test]
fn kill_plugin_scopes_to_the_named_plugin() {
    let a = track("test-scope-a", 9001);
    let b = track("test-scope-b", 9002);
    kill_plugin("test-scope-a");
    assert!(exited(&a));
    assert!(!exited(&b));
    assert!(lock(&plugin_slot("test-scope-a")).children.is_empty());
    kill_plugin("test-scope-b");
    assert!(exited(&b));
}

#[test]
fn restart_skips_a_resident_someone_else_already_replaced() {
    let id = "test-epoch";
    let child = Arc::new(Mutex::new(sleeper()));
    lock(&plugin_slot(id)).resident = Some(Resident {
        child: child.clone(),
        port: 4321,
        epoch: 8,
    });
    let s = spec(r#"{"sidecar":{"name":"x","serve":["q"]}}"#);

    // The failed request saw epoch 7; the slot has since been replaced. Reuse the
    // current resident instead of killing it mid-flight.
    let addr = resident_port(id, &s, Some(7)).expect("reuse current resident");
    assert_eq!((addr.port, addr.epoch), (4321, 8));
    assert!(!exited(&child));

    // The failed process still occupies the slot: kill it and respawn. The respawn
    // fails here (nothing installed), leaving the slot empty rather than stale.
    assert!(resident_port(id, &s, Some(8)).is_err());
    assert!(exited(&child));
    assert!(lock(&plugin_slot(id)).resident.is_none());
    kill_plugin(id);
}
