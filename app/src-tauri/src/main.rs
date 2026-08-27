// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;

fn main() {
    // WebKitGTK's DMABUF renderer mismaps compositor buffers on Linux, causing graphical errors on the
    // StreetView canvas. We disable it before webkit inits.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // `--serve` runs the headless web sidecar instead of the desktop app.
    // Gated by the `web-serve` feature so release builds don't compile it in.
    #[cfg(feature = "web-serve")]
    if std::env::args().any(|a| a == "--serve") {
        app_lib::serve::run_server();
        return;
    }
    // `--export-bindings` regenerates ../src/bindings.gen.ts and exits, without
    // launching the app. Breaks the deadlock when broken bindings block the frontend build.
    #[cfg(debug_assertions)]
    if env::args().any(|a| a == "--export-bindings") {
        app_lib::export_bindings().expect("bindings export failed");
        return;
    }
    app_lib::run();
}
