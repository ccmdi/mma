//! Application entry point: module tree, the IPC command surface (tauri-specta),
//! Tauri plugin setup, and the event loop. No business logic lives here.

use crate::types::{AppError, AppResult, TsConst};
use specta_typescript::semantic::Configuration;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;
use std::{error, fs, panic, thread};
use tauri::plugin::TauriPlugin;
use vali_generate::names;

mod types;

#[cfg(feature = "e2e")]
mod e2e;
mod io;
mod net;
mod plugins;
mod procedure;
mod runs;
mod selections;
#[cfg(all(debug_assertions, windows))]
mod stall_reporter;
mod store;
mod sv;
mod sync;
#[cfg(test)]
mod test_util;
mod util;

#[cfg(feature = "web-serve")]
pub use net::serve;
#[cfg(feature = "bench")]
pub use store::engine::bench as bench_api;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// App handle, captured once in `setup()`. Private: the only capability exposed is
/// event emission via [`emit_event`], so commands don't carry an `AppHandle`
/// parameter just to emit.
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
static START_INSTANT: OnceLock<Instant> = OnceLock::new();
static STARTUP_MS: OnceLock<u32> = OnceLock::new();
static STARTUP_ERROR: OnceLock<AppError> = OnceLock::new();

/// The app handle, available once `setup()` has run.
pub(crate) fn app_handle() -> Option<&'static tauri::AppHandle> {
    APP_HANDLE.get()
}

/// Emit an app-wide event to all windows. No-op before setup completes.
pub(crate) fn emit_event<E: tauri_specta::Event + serde::Serialize + Clone>(payload: E) {
    use tauri::Emitter;
    let event = E::NAME;
    // Browser tabs aren't app webviews, so app.emit can't reach them; bridge the
    // event to the web-serve SSE channel (no-op when no browser is connected).
    #[cfg(feature = "web-serve")]
    if let Ok(value) = serde_json::to_value(&payload) {
        tauri_plugin_webserve::forward_event(event, value);
    }
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit(event, payload);
    }
}

/// How long the app took to start and how long it has been running.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct AppReady {
    /// Milliseconds from app launch until the first window was ready.
    startup_ms: u32,
    /// Seconds since app launch rather than since a window last loaded its page.
    uptime_secs: u32,
}

/// Reports the window ready and returns the app's startup time and uptime.
#[tauri::command]
#[specta::specta]
fn app_ready() -> AppReady {
    let startup_ms = *STARTUP_MS.get_or_init(|| {
        let ms = START_INSTANT
            .get()
            .map(|t| t.elapsed().as_millis() as u32)
            .unwrap_or(0);
        log::info!("[startup] app ready in {ms}ms");
        store::engine::delta_legacy::warn_of_set_aside_deltas();
        ms
    });
    AppReady {
        startup_ms,
        uptime_secs: START_INSTANT
            .get()
            .map_or(0, |t| t.elapsed().as_secs() as u32),
    }
}

/// Fails with the reason the app could not start, and succeeds when it started normally.
#[tauri::command]
#[specta::specta]
fn startup_check() -> AppResult<()> {
    STARTUP_ERROR.get().cloned().map_or(Ok(()), Err)
}

macro_rules! register_commands {
    ([$($extra:tt)*]; $( $doc:literal $name:ident( $( $arg:ident: $ty:ty ),* ) $( at $at:ident )? -> $ret:ty => $( $mode:ident )? |$store:ident $(, $window:ident)?| $body:block; )*) => {
        tauri_specta::collect_commands![ $(crate::store::commands::$name,)* $($extra)* ]
    };
}

/// Single source of truth for the IPC command surface. Used by both the desktop
/// app (`run`) and the web sidecar (`serve`), so adding a command here wires it
/// for both transports automatically.
pub fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .dangerously_cast_bigints_to_number()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .semantic_types(Configuration::default().enable_lossless_floats())
        // Exported for TS but not carried by any command signature.
        .typ::<store::maps::CameraType>()
        .typ::<sv::pano::Pano>()
        .typ::<sv::pano::PanoQuery>()
        .typ::<sv::pano::PanoAnswer>()
        .typ::<procedure::engine::ProcedureConfig<serde_json::Value>>()
        .commands(store::commands::command_table!(
            register_commands,
            [
                app_ready,
                startup_check,
                store::storage::write_temp_file,
                store::storage::get_data_location,
                store::storage::set_data_location,
                store::storage::open_data_folder,
                store::storage::open_log_file,
                plugins::user::claim_plugin_update_pass,
                plugins::user::list_user_plugins,
                plugins::user::install_plugin,
                plugins::user::uninstall_plugin,
                plugins::sidecar::sidecar_installed_version,
                plugins::sidecar::sidecar_request,
                plugins::sidecar::sidecar_stop,
                plugins::borders::check_border_file,
                plugins::borders::download_border_file,
                plugins::borders::border_lookup,
                net::geocoder::reverse_geocode,
                util::timezone_at,
                util::reveal_window,
                net::presence::discord_presence_set,
                net::github::github_start_login,
                net::github::github_poll_login,
                net::github::github_me,
                net::github::github_logout,
                net::github::github_has_session,
                net::feedback::feedback_log_tail,
                net::feedback::feedback_submit,
                net::feedback::feedback_upload_attachment,
                net::feedback::feedback_thread,
                net::feedback::feedback_reply,
                net::update::update_check,
                net::update::update_install,
                net::remote_api::remote_api_set,
                net::remote_api::remote_api_respond,
                store::commands::store_open_map,
                store::commands::store_close_map,
                store::commands::store_close_layer,
                store::commands::store_save_dirty,
                store::commands::store_copy_locations_to_map,
                store::commands::store_edit_uploaded,
                store::commands::honeycomb_points,
                store::commands::polygon_points,
                store::commands::polygon_contains_points,
                store::commands::polygon_bounds,
                store::commands::polygon_fill,
                selections::field_expr::field_expr_error,
                store::commands::store_country_distribution,
                store::commands::store_step,
                store::commands::selection_build,
                store::commands::store_subscribe_frames,
                store::maps::store_list_maps,
                store::maps::store_create_map,
                store::maps::store_delete_map,
                store::maps::store_duplicate_map,
                store::maps::store_update_map_meta,
                store::maps::store_move_folder,
                store::maps::store_db_stats,
                store::map_defaults::store_get_map_defaults,
                store::map_defaults::store_set_map_defaults,
                io::import::bulk_import_preview,
                io::import::bulk_import_confirm,
                io::import::bulk_import_cancel,
                io::import::store_import_preview,
                io::import::store_import_file,
                io::import::store_import_cancel,
                io::maps_url::parse_maps_url,
                io::export::store_export,
                io::export::store_save_export_file,
                io::export::store_export_bulk_zip,
                io::export::store_upload_begin,
                io::export::store_upload_finish,
                io::export::store_upload_abort,
                store::vcs::store_commit,
                store::vcs::store_list_commits,
                store::vcs::store_checkout_commit,
                store::vcs::store_get_commit_delta,
                store::seen::store_seen_write,
                store::seen::store_seen_list,
                store::seen::store_seen_countries,
                store::seen::store_seen_maps,
                store::seen::store_seen_clear,
                store::review::store_review_list,
                store::review::store_review_edit,
                selections::saved::store_list_saved_selections,
                selections::saved::store_get_saved_selections,
                selections::saved::store_save_selection,
                selections::saved::store_delete_saved_selection,
                selections::saved::legacy::store_import_legacy_saved_selections,
                sync::remote_mapping::remote_mapping_clear,
                sync::engine::sync_reconcile,
                sync::log::sync_log_append,
                sync::log::sync_log_list,
                sync::map_making::map_making_me,
                sync::map_making::map_making_validate,
                sync::map_making::map_making_maps,
                sync::map_making::map_making_create_map,
                sync::map_making::map_making_set_key,
                sync::map_making::map_making_has_key,
                sync::file::file_source_probe,
                net::geoguessr::geoguessr_login,
                net::geoguessr::geoguessr_me,
                net::geoguessr::geoguessr_logout,
                plugins::vali::vali_generate,
                plugins::vali::vali_download,
                plugins::vali::vali_data_status,
                plugins::vali::vali_download_stale,
                procedure::engine::procedure_run,
                procedure::registry::provider_register,
                procedure::registry::provider_unregister,
                procedure::engine::procedure_query,
                runs::run_reserve,
                runs::run_cancel,
                procedure::engine::procedure_activity,
            ]
        ))
        .events(tauri_specta::collect_events![
            plugins::sidecar::SidecarProgress,
            plugins::sidecar::SidecarLine,
            plugins::sidecar::SidecarLog,
            plugins::sidecar::SidecarDone,
            io::import::ImportProgress,
            io::export::ExportProgress,
            store::engine::StoreWarning,
            plugins::vali::ValiProgress,
            procedure::engine::ProcedureProgress,
            procedure::engine::ProcedureResult,
            net::update::UpdateProgress,
        ])
}

/// Regenerate `../src/bindings.gen.ts` from [`specta_builder`].
#[cfg(debug_assertions)]
#[allow(clippy::print_stderr)]
pub fn export_bindings() -> Result<(), String> {
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/bindings.gen.ts");
    specta_builder()
        .export(specta_typescript::Typescript::default(), &out)
        .map_err(|e| format!("{e:?}"))?;
    // Collapse specta's `Foo_Serialize | Foo_Deserialize` unions into one `Foo`. The
    // union line carries its own copy of the type's doc comment, which would be left
    // orphaned above the real declaration, so it goes with the line.
    let src = fs::read_to_string(&out).expect("read bindings");
    let mut kept: Vec<&str> = Vec::new();
    for line in src.lines() {
        let is_union = line.starts_with("export type ")
            && line.contains("_Serialize | ")
            && line.contains("_Deserialize;");
        if !is_union {
            kept.push(line);
            continue;
        }
        while kept.last().is_some_and(|l| l.trim().is_empty()) {
            kept.pop();
        }
        if kept.last().is_some_and(|l| l.trim_end().ends_with("*/")) {
            while let Some(l) = kept.pop() {
                if l.trim_start().starts_with("/**") {
                    break;
                }
            }
        }
    }
    let promoted: String = kept
        .iter()
        .map(|l| l.replace("_Serialize", "") + "\n")
        .collect();
    let names = wire_string_enums().map(|(name, _)| name);
    fs::write(&out, owned_by_consts(&promoted, &names)).expect("write bindings");
    eprintln!("[specta] bindings exported to {}", out.display());
    export_consts()
}

fn wire_string_enums() -> [(&'static str, TsConst); 17] {
    [
        ("CameraType", store::maps::CameraType::ts_const()),
        ("CapturePick", store::maps::CapturePick::ts_const()),
        ("DatePart", selections::DatePart::ts_const()),
        ("FieldType", store::maps::FieldType::ts_const()),
        ("Group", selections::tree::Group::ts_const()),
        ("FirstSyncMode", sync::FirstSyncMode::ts_const().unstable()),
        ("IssueState", net::github::IssueState::ts_const().unstable()),
        ("MapShape", types::shape::MapShape::ts_const()),
        ("MergeWinner", store::engine::MergeWinner::ts_const()),
        ("Place", selections::tree::Place::ts_const()),
        ("RateCost", net::fetch::RateCost::ts_const()),
        ("ReviewMode", selections::ReviewMode::ts_const()),
        (
            "ResolutionSide",
            sync::engine::ResolutionSide::ts_const().unstable(),
        ),
        ("Sink", procedure::engine::Sink::ts_const()),
        ("Stack", store::engine::Stack::ts_const()),
        ("Timeline", store::engine::Timeline::ts_const()),
        ("SyncTrigger", sync::log::SyncTrigger::ts_const().unstable()),
    ]
}

fn owned_by_consts(src: &str, names: &[&str]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut lines = src.lines();
    while let Some(line) = lines.next() {
        if !names
            .iter()
            .any(|n| line.starts_with(&format!("export type {n} = ")))
        {
            out.push(line.to_string());
            continue;
        }
        let mut end = line;
        while !end.trim_end().ends_with(';') {
            match lines.next() {
                Some(next) => end = next,
                None => break,
            }
        }
        while out.last().is_some_and(|l| l.trim().is_empty()) {
            out.pop();
        }
        if out.last().is_some_and(|l| l.trim_end().ends_with("*/")) {
            while let Some(l) = out.pop() {
                if l.trim_start().starts_with("/**") {
                    break;
                }
            }
        }
    }
    let at = out
        .iter()
        .position(|l| l.starts_with("import * as __TAURI_EVENT"))
        .map_or(0, |i| i + 1);
    out.insert(
        at,
        format!(
            "import type {{ {} }} from \"./bindings.consts\";",
            names.join(", ")
        ),
    );
    out.join("\n") + "\n"
}

/// Values Rust owns that TypeScript mirrors, in their own file because it must stay
/// import-free: the procedure sandbox bundles it and may not reach Tauri.
#[allow(clippy::print_stderr)]
fn export_consts() -> Result<(), String> {
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/bindings.consts.ts");
    let mut ts = String::from(
        "// Generated by `npm run gen:bindings`. Do not edit.
// No imports, ever: procedures bundle this file and must not reach Tauri.
",
    );
    for (name, konst) in wire_string_enums().into_iter().chain([
        ("LocationFlag", types::LocationFlags::ts_const()),
        ("PanoType", sv::schema::PanoType::ts_const()),
        ("RankingStrategy", sv::schema::RankingStrategy::ts_const()),
        ("ValidationFlag", types::ValidationFlag::ts_const()),
        ("SyncDirection", sync::SyncDirection::ts_const().unstable()),
        (
            "BUILTIN_FIELDS",
            TsConst::value(selections::FieldRegistry::builtins()),
        ),
        ("FrameKind", store::engine::FrameKind::ts_const().unstable()),
        (
            "NO_SEL",
            TsConst::value(store::engine::PaletteIdx::NONE.0).unstable(),
        ),
        (
            "OFFICIAL_ID_PATTERN",
            TsConst::value(sv::pano_id::OFFICIAL_ID_PATTERN),
        ),
        (
            "EFFECT_CALLS",
            TsConst::value(procedure::quickjs::EFFECT_CALLS).unstable(),
        ),
        (
            "PLAIN_CALLS",
            TsConst::value(procedure::quickjs::PLAIN_CALLS).unstable(),
        ),
        (
            "DEFAULT_DUPLICATE_SCORE",
            TsConst::value(selections::DEFAULT_DUPLICATE_SCORE).unstable(),
        ),
        ("KNOWN_FIELDS", TsConst::value(store::maps::KNOWN_FIELDS)),
        (
            "DEFAULT_MARKER_COLOR",
            TsConst::value(store::engine::DEFAULT_MARKER_COLOR),
        ),
        (
            "PROJECTIONS",
            TsConst::value(selections::PROJECTIONS).unstable(),
        ),
        (
            "SYNC_PROVIDERS",
            TsConst::value(
                sync::engine::PROVIDERS
                    .iter()
                    .map(|s| (s.id, s))
                    .collect::<BTreeMap<_, _>>(),
            )
            .with_doc(&[
                "Every sync provider: which way it carries changes, and what it keeps of a map.",
            ])
            .unstable(),
        ),
        (
            "SCRATCH_MAP_ID",
            TsConst::value(store::maps::SCRATCH_MAP_ID).unstable(),
        ),
        (
            "ERROR_CODES",
            TsConst::value(
                types::ErrCode::ALL
                    .iter()
                    .map(|c| c.wire())
                    .collect::<Vec<_>>(),
            )
            .unstable(),
        ),
        (
            "VALI_COUNTRIES",
            TsConst::value(
                names::country_names()
                    .iter()
                    .map(|(code, _)| *code)
                    .collect::<Vec<_>>(),
            )
            .with_doc(&["Country codes Vali has coverage data for."])
            .unstable(),
        ),
    ]) {
        ts.push_str(&konst.render(name));
    }
    fs::write(&out, ts).map_err(|e| e.to_string())?;
    eprintln!("[specta] constants exported to {}", out.display());
    Ok(())
}

fn log_plugin() -> TauriPlugin<tauri::Wry> {
    tauri_plugin_log::Builder::default()
        .level(if cfg!(debug_assertions) {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        })
        // updater dumps full release manifests at debug
        .level_for("tauri_plugin_updater", log::LevelFilter::Info)
        .max_file_size(2_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
        // default targets include LogDir{None} ("Map Making App.log"); .target()
        // appends, so without clearing, every line is written to two files
        .clear_targets()
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Stdout,
        ))
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("mma".to_string()),
            },
        ))
        .build()
}

/// Raise whatever window the running instance already has, so a second launch reads as
/// "the app is over here" rather than as nothing happening.
#[cfg(not(feature = "e2e"))]
fn focus_existing(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(window) = app
        .webview_windows()
        .into_values()
        .next()
        .map(|w| w.as_ref().window())
    else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn error::Error>> {
    let t = Instant::now();
    if let Err(e) = init_backend(app.handle()) {
        log::error!("[startup] backend failed to start: {e}");
        let _ = STARTUP_ERROR.set(e);
    } else {
        let swept = store::storage::sweep_orphaned_tmp();
        if swept > 0 {
            log::info!("[startup] swept {swept} orphaned .tmp files");
        }
        match store::maps::purge_scratch_map() {
            Ok(true) => log::info!("[startup] dropped last session's scratch map"),
            Ok(false) => {}
            Err(e) => log::warn!("[startup] scratch map purge failed: {e}"),
        }
        log::info!("[startup] migrations: {}ms", t.elapsed().as_millis());
    }

    thread::spawn(|| {
        plugins::borders::update_border_files();
        plugins::borders::warm();
    });
    thread::spawn(net::geocoder::warm);

    #[cfg(all(debug_assertions, windows))]
    stall_reporter::start();

    #[cfg(desktop)]
    {
        app.handle()
            .plugin(tauri_plugin_updater::Builder::new().build())?;
        app.handle().plugin(tauri_plugin_process::init())?;
    }

    if let Some(t0) = START_INSTANT.get() {
        log::info!(
            "[startup] setup done: {}ms since run()",
            t0.elapsed().as_millis()
        );
    }
    Ok(())
}

/// reqwest is built with rustls-no-provider; every entry point installs the process-wide
/// provider up front instead of leaving it to whichever client initializes first.
pub(crate) fn install_crypto_provider() {
    use rustls::crypto::ring;
    let _ = ring::default_provider().install_default();
}

/// The state every command handler reads, shared by every entry point that serves them.
pub(crate) fn manage_command_state(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.manage(store::engine::StoreState::new(
        store::engine::StoreManager::new(),
    ))
}

/// Startup shared by every entry point that serves commands.
pub(crate) fn init_backend(app: &tauri::AppHandle) -> AppResult<()> {
    // GTK adopts the user's LC_NUMERIC, and QuickJS parses numbers with strtod.
    #[cfg(target_os = "linux")]
    unsafe {
        libc::setlocale(libc::LC_NUMERIC, c"C".as_ptr());
    }
    let _ = APP_HANDLE.set(app.clone());
    store::storage::init_paths(app)?;
    store::storage::run_migrations()?;
    store::engine::delta_legacy::convert_msgpack_deltas();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = START_INSTANT.set(Instant::now());
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        log::error!("[PANIC] {info}");
        default_hook(info);
    }));

    install_crypto_provider();

    #[cfg(debug_assertions)]
    if let Err(e) = export_bindings() {
        log::error!("[specta] export FAILED: {e}");
    }

    let builder = net::proxy::register_schemes(tauri::Builder::default());

    // Registered first, before any plugin that opens a file: a second process would hold its
    // own overlay over the same delta files, and whichever autosaved last would silently
    // discard the other's uncommitted edits. Exempt under `e2e`, where running a second
    // process beside a live app is the point.
    #[cfg(not(feature = "e2e"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        focus_existing(app);
    }));

    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(log_plugin())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    // MAXIMIZED excluded: tao's SW_MAXIMIZE reveals a hidden window, so the
                    // creation-time restore would defeat the first-frame show gate. The
                    // frontend re-applies it right before showing (window.ts).
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE
                        - tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .invoke_handler(specta_builder().invoke_handler())
        .setup(setup);
    let builder = manage_command_state(builder);

    #[cfg(feature = "e2e")]
    let builder = e2e::install(builder);

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            #[cfg(all(debug_assertions, windows))]
            stall_reporter::beat();
            if let tauri::RunEvent::Exit = event {
                plugins::sidecar::kill_all_sidecars();
                net::presence::shutdown();
            }
        });
}

#[cfg(all(test, debug_assertions))]
#[path = "lib.test.rs"]
mod tests;
