use super::*;

#[test]
#[ignore = "regenerates committed bindings; run by the bindings gate"]
fn export_bindings_for_gate() {
    export_bindings().expect("bindings export failed");
}
