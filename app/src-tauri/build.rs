use std::env;

fn main() {
    // The bench exe instantiates the mock runtime, which on windows-msvc needs the
    // Common-Controls v6 activation context or it dies at load with
    // STATUS_ENTRYPOINT_NOT_FOUND (same workaround tauri applies to its own tests).
    if env::var("CARGO_FEATURE_BENCH").is_ok()
        && env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = env::current_dir()
            .unwrap()
            .join("benches/windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-benches=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-benches=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
    tauri_build::build()
}
