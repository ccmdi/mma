//! Application entry point: module tree, the IPC command surface (tauri-specta),
//! Tauri plugin setup, and the event loop. No business logic lives here.

use specta_typescript::semantic::Configuration;
use std::error;
use std::fs;
use std::panic;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::thread;
use std::time::Instant;
use tauri::plugin::TauriPlugin;

mod arrow_bridge;
mod arrow_migrate;
mod borders;
mod export;
mod feedback;
mod field_expr;
mod gdoc;
mod geocoder;
mod geoguessr;
mod github;
mod import;
mod location_store;
mod map_meta;
mod plugins;
mod presence;
mod procedure;
mod proxy;
mod remote_api;
mod remote_mapping;
mod review;
mod saved_selections;
mod seen;
mod selections;
mod sidecar;
mod spatial;
#[cfg(all(debug_assertions, windows))]
mod stall_reporter;
mod storage;
mod sync;
mod sync_diff;
mod sync_engine;
mod sync_geoguessr;
mod sync_keying;
mod sync_map_making;
#[cfg(test)]
mod test_util;
mod types;
mod update;
mod user_plugins;
mod util;
mod vcs;
mod vcs_delta;

#[cfg(feature = "web-serve")]
pub mod serve;

#[cfg(feature = "bench")]
pub use location_store::bench as bench_api;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// App handle, captured once in `setup()`. Private: the only capability exposed is
/// event emission via [`emit_event`], so commands don't carry an `AppHandle`
/// parameter just to emit.
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
static START_INSTANT: OnceLock<Instant> = OnceLock::new();
static STARTUP_MS: OnceLock<u32> = OnceLock::new();

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

/// Milliseconds from `run()` to the frontend's first call; logged once.
#[tauri::command]
#[specta::specta]
fn app_ready() -> u32 {
    *STARTUP_MS.get_or_init(|| {
        let ms = START_INSTANT
            .get()
            .map(|t| t.elapsed().as_millis() as u32)
            .unwrap_or(0);
        log::info!("[startup] app ready in {ms}ms");
        ms
    })
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
        .typ::<map_meta::CameraType>()
        .constant("KNOWN_FIELDS", map_meta::KNOWN_FIELDS)
        .constant("SCRATCH_MAP_ID", map_meta::SCRATCH_MAP_ID)
        .constant("BUILTIN_FIELDS", selections::BUILTIN_FIELDS)
        .constant("PROJECTIONS", selections::PROJECTIONS)
        .commands(tauri_specta::collect_commands![
            app_ready,
            storage::write_temp_file,
            storage::read_file,
            storage::get_app_data_dir,
            storage::get_data_location,
            storage::set_data_location,
            storage::open_data_folder,
            storage::open_log_file,
            user_plugins::list_user_plugins,
            user_plugins::install_plugin,
            user_plugins::uninstall_plugin,
            sidecar::sidecar_install,
            sidecar::sidecar_installed_version,
            sidecar::sidecar_request,
            sidecar::sidecar_stop,
            sidecar::sidecar_stop_all,
            sidecar::sidecar_cancel,
            borders::check_border_file,
            borders::download_border_file,
            borders::border_lookup,
            borders::border_classify,
            geocoder::reverse_geocode,
            presence::discord_presence_set,
            presence::discord_presence_clear,
            github::github_start_login,
            github::github_poll_login,
            github::github_me,
            github::github_logout,
            github::github_has_session,
            github::github_create_issue,
            github::github_issue_thread,
            feedback::feedback_log_tail,
            feedback::feedback_anonymous_available,
            feedback::feedback_submit_anonymous,
            feedback::feedback_upload_attachment,
            feedback::feedback_request_label,
            feedback::feedback_anonymous_thread,
            update::update_check,
            update::update_install,
            remote_api::remote_api_start,
            remote_api::remote_api_stop,
            remote_api::remote_api_respond,
            location_store::store_open_map,
            location_store::store_close_map,
            location_store::store_save_dirty,
            location_store::store_copy_locations_to_map,
            location_store::store_get_summary,
            location_store::store_add_locations,
            location_store::store_add_locations_uploaded,
            location_store::store_remove_locations,
            location_store::store_update_locations,
            location_store::store_set_active,
            location_store::store_set_marker_color,
            location_store::store_resolve,
            location_store::store_count,
            location_store::store_sample,
            location_store::store_spaced,
            location_store::store_group_by,
            location_store::store_count_by,
            location_store::store_values,
            location_store::store_coverage,
            location_store::store_columns,
            location_store::store_bounds,
            location_store::store_collect,
            location_store::store_apply_field_op,
            field_expr::field_expr_error,
            location_store::store_country_distribution,
            location_store::store_find_nearby,
            location_store::store_near_any,
            location_store::store_create_tags,
            location_store::store_update_tags,
            location_store::store_delete_tags,
            location_store::store_reorder_tags,
            location_store::store_undo,
            location_store::store_redo,
            location_store::store_reset_undo,
            location_store::store_commit_diff,
            location_store::store_sync_selections,
            location_store::store_duplicate_groups,
            location_store::store_merge_duplicates,
            location_store::store_prune_duplicates,
            location_store::store_fill_render_file,
            location_store::store_resolve_pick,
            map_meta::store_list_maps,
            map_meta::store_get_map,
            map_meta::store_create_map,
            map_meta::store_scratch_map,
            map_meta::store_delete_map,
            map_meta::store_update_map_meta,
            map_meta::store_touch_map_opened,
            map_meta::store_rename_folder,
            map_meta::store_delete_folder,
            map_meta::store_db_stats,
            import::bulk_import_preview,
            import::bulk_import_confirm,
            import::bulk_import_cancel,
            import::store_import_preview,
            import::store_import_paste_preview,
            import::store_import_staged_location,
            import::store_import_file,
            export::store_export_json,
            export::store_export_csv,
            export::store_export_geojson,
            export::store_save_export_file,
            export::store_export_bulk_zip,
            export::store_upload_begin,
            export::store_upload_finish,
            export::store_upload_abort,
            vcs::store_commit,
            vcs::store_list_commits,
            vcs::store_checkout_commit,
            vcs::store_get_commit_delta,
            seen::store_seen_write,
            seen::store_seen_list,
            seen::store_seen_count,
            seen::store_seen_countries,
            seen::store_seen_maps,
            seen::store_seen_clear,
            review::store_review_create,
            review::store_review_get,
            review::store_review_list,
            review::store_review_update,
            review::store_review_delete,
            saved_selections::store_list_saved_selections,
            saved_selections::store_get_saved_selections,
            saved_selections::store_save_selection,
            saved_selections::store_delete_saved_selection,
            saved_selections::legacy::store_import_legacy_saved_selections,
            remote_mapping::remote_mapping_get,
            remote_mapping::remote_mapping_upsert,
            remote_mapping::remote_mapping_delete,
            remote_mapping::remote_mapping_clear,
            sync_engine::sync_reconcile,
            geoguessr::geoguessr_login,
            geoguessr::geoguessr_me,
            geoguessr::geoguessr_logout,
            geoguessr::geoguessr_has_session,
            plugins::vali_generate,
            plugins::vali_download,
            plugins::vali_cancel,
            plugins::vali_subdivisions,
            plugins::vali_countries,
            plugins::vali_data_status,
            plugins::vali_download_stale,
            procedure::engine::procedure_run,
            procedure::engine::procedure_cancel,
            procedure::engine::procedure_query,
            procedure::engine::procedure_query_cancel,
        ])
        .events(tauri_specta::collect_events![
            sidecar::SidecarProgress,
            sidecar::SidecarLine,
            sidecar::SidecarLog,
            sidecar::SidecarDone,
            import::ImportProgress,
            export::ExportProgress,
            location_store::ExternalMutation,
            location_store::StoreWarning,
            plugins::ValiProgress,
            procedure::engine::ProcedureProgress,
            procedure::engine::ProcedureResult,
            update::UpdateProgress,
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
    // Collapse specta's `Foo_Serialize | Foo_Deserialize` unions into one `Foo`.
    let src = fs::read_to_string(&out).expect("read bindings");
    let promoted: String = src
        .lines()
        .filter(|l| {
            !(l.starts_with("export type ")
                && l.contains("_Serialize | ")
                && l.contains("_Deserialize;"))
        })
        .map(|l| l.replace("_Serialize", "") + "\n")
        .collect();
    fs::write(&out, promoted).expect("write bindings");
    eprintln!("[specta] bindings exported to {}", out.display());
    export_consts()
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
    let mut put = |name: &str, value: String| {
        ts.push_str(&format!(
            "
export const {name} = {value} as const;
"
        ));
    };
    put(
        "LocationFlag",
        serde_json::to_string(&types::LocationFlags::wire_names()).map_err(|e| e.to_string())?,
    );
    put(
        "PanoType",
        serde_json::to_string(&types::PanoType::wire_names()).map_err(|e| e.to_string())?,
    );
    put(
        "VIRTUAL_FLAGS",
        types::LocationFlags::VIRTUAL.bits().to_string(),
    );
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
    let _ = APP_HANDLE.set(app.handle().clone());
    storage::init_paths(app.handle())?;
    storage::run_migrations()?;
    let swept = storage::sweep_orphaned_tmp();
    if swept > 0 {
        log::info!("[startup] swept {swept} orphaned .tmp files");
    }
    match map_meta::purge_scratch_map() {
        Ok(true) => log::info!("[startup] dropped last session's scratch map"),
        Ok(false) => {}
        Err(e) => log::warn!("[startup] scratch map purge failed: {e}"),
    }
    log::info!("[startup] migrations: {}ms", t.elapsed().as_millis());

    thread::spawn(|| {
        borders::update_border_files();
        borders::warm();
    });
    thread::spawn(geocoder::warm);

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = START_INSTANT.set(Instant::now());
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        log::error!("[PANIC] {info}");
        default_hook(info);
    }));

    #[cfg(debug_assertions)]
    if let Err(e) = export_bindings() {
        log::error!("[specta] export FAILED: {e}");
    }

    let builder = proxy::register_schemes(tauri::Builder::default());

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
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .manage(location_store::StoreState::new(
            location_store::StoreManager::new(),
        ))
        .manage(plugins::ValiState::new())
        .invoke_handler(specta_builder().invoke_handler())
        .setup(setup);

    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            #[cfg(all(debug_assertions, windows))]
            stall_reporter::beat();
            if let tauri::RunEvent::Exit = event {
                sidecar::kill_all_sidecars();
                presence::shutdown();
            }
        });
}
