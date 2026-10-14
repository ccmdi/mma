// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(any(target_os = "linux", feature = "web-serve"))]
use std::env;

#[cfg(feature = "web-serve")]
use app_lib::serve;

fn main() {
    // WebKitGTK's DMABUF renderer mismaps compositor buffers on Linux, causing graphical errors on the
    // StreetView canvas. We disable it before webkit inits.
    #[cfg(target_os = "linux")]
    if env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // `--serve` runs the headless web sidecar instead of the desktop app.
    // Gated by the `web-serve` feature so release builds don't compile it in.
    #[cfg(feature = "web-serve")]
    if env::args().any(|a| a == "--serve") {
        serve::run_server();
        return;
    }
    app_lib::run();
}
