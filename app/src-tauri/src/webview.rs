use tauri::plugin::{Builder, TauriPlugin};
#[cfg(windows)]
use tauri::webview::PlatformWebview;
use tauri::Runtime;
#[cfg(windows)]
use windows::core::Result;

/// Turns off the browser behavior the webview brings with it on every window it creates; the
/// frontend's `ownWebviewInput` is the cross-platform half of the same rule.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::new("webview-shell");
    #[cfg(windows)]
    let builder = builder.on_webview_ready(|webview| {
        let applied = webview.with_webview(|wv| {
            if let Err(e) = disable_browser_features(&wv) {
                log::warn!("[webview] browser features left on: {e}");
            }
        });
        if let Err(e) = applied {
            log::warn!("[webview] could not reach the webview: {e}");
        }
    });
    builder.build()
}

/// WebView2's accelerator keys, context menu, zoom, autofill, pinch and swipe navigation. Debug
/// builds keep the accelerator keys so F12 still opens devtools.
#[cfg(windows)]
fn disable_browser_features(wv: &PlatformWebview) -> Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Settings3, ICoreWebView2Settings4, ICoreWebView2Settings5,
        ICoreWebView2Settings6,
    };
    use windows::core::Interface;

    unsafe {
        let settings = wv.controller().CoreWebView2()?.Settings()?;
        settings.SetAreDefaultContextMenusEnabled(false)?;
        settings.SetIsZoomControlEnabled(false)?;
        settings
            .cast::<ICoreWebView2Settings3>()?
            .SetAreBrowserAcceleratorKeysEnabled(cfg!(debug_assertions))?;
        let autofill = settings.cast::<ICoreWebView2Settings4>()?;
        autofill.SetIsGeneralAutofillEnabled(false)?;
        autofill.SetIsPasswordAutosaveEnabled(false)?;
        settings
            .cast::<ICoreWebView2Settings5>()?
            .SetIsPinchZoomEnabled(false)?;
        settings
            .cast::<ICoreWebView2Settings6>()?
            .SetIsSwipeNavigationEnabled(false)?;
    }
    Ok(())
}
