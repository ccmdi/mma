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

mod io;
mod net;
mod plugins;
mod procedure;
mod selections;
#[cfg(all(debug_assertions, windows))]
mod stall_reporter;
mod store;
mod sync;
#[cfg(test)]
mod test_util;
mod types;
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
        .typ::<store::maps::CameraType>()
        .constant("KNOWN_FIELDS", store::maps::KNOWN_FIELDS)
        .constant("SCRATCH_MAP_ID", store::maps::SCRATCH_MAP_ID)
        .constant("BUILTIN_FIELDS", selections::BUILTIN_FIELDS)
        .constant("PROJECTIONS", selections::PROJECTIONS)
        .commands(tauri_specta::collect_commands![
            app_ready,
            store::storage::write_temp_file,
            store::storage::read_file,
            store::storage::get_app_data_dir,
            store::storage::get_data_location,
            store::storage::set_data_location,
            store::storage::open_data_folder,
            store::storage::open_log_file,
            plugins::user::list_user_plugins,
            plugins::user::install_plugin,
            plugins::user::uninstall_plugin,
            plugins::sidecar::sidecar_install,
            plugins::sidecar::sidecar_installed_version,
            plugins::sidecar::sidecar_request,
            plugins::sidecar::sidecar_stop,
            plugins::sidecar::sidecar_stop_all,
            plugins::sidecar::sidecar_cancel,
            plugins::borders::check_border_file,
            plugins::borders::download_border_file,
            plugins::borders::border_lookup,
            plugins::borders::border_classify,
            net::geocoder::reverse_geocode,
            net::presence::discord_presence_set,
            net::presence::discord_presence_clear,
            net::github::github_start_login,
            net::github::github_poll_login,
            net::github::github_me,
            net::github::github_logout,
            net::github::github_has_session,
            net::github::github_create_issue,
            net::github::github_issue_thread,
            net::feedback::feedback_log_tail,
            net::feedback::feedback_anonymous_available,
            net::feedback::feedback_submit_anonymous,
            net::feedback::feedback_upload_attachment,
            net::feedback::feedback_request_label,
            net::feedback::feedback_anonymous_thread,
            net::update::update_check,
            net::update::update_install,
            net::remote_api::remote_api_start,
            net::remote_api::remote_api_stop,
            net::remote_api::remote_api_respond,
            store::commands::store_open_map,
            store::commands::store_close_map,
            store::commands::store_save_dirty,
            store::commands::store_copy_locations_to_map,
            store::commands::store_get_summary,
            store::commands::store_add_locations,
            store::commands::store_add_locations_uploaded,
            store::commands::store_remove_locations,
            store::commands::store_update_locations,
            store::commands::store_set_active,
            store::commands::store_set_marker_color,
            store::commands::store_resolve,
            store::commands::store_count,
            store::commands::store_sample,
            store::commands::store_spaced,
            store::commands::store_group_by,
            store::commands::store_count_by,
            store::commands::store_values,
            store::commands::store_coverage,
            store::commands::store_columns,
            store::commands::store_bounds,
            store::commands::store_collect,
            store::commands::store_apply_field_op,
            selections::field_expr::field_expr_error,
            store::commands::store_country_distribution,
            store::commands::store_find_nearby,
            store::commands::store_near_any,
            store::commands::store_create_tags,
            store::commands::store_update_tags,
            store::commands::store_delete_tags,
            store::commands::store_reorder_tags,
            store::commands::store_undo,
            store::commands::store_redo,
            store::commands::store_reset_undo,
            store::commands::store_commit_diff,
            store::commands::store_sync_selections,
            store::commands::store_duplicate_groups,
            store::commands::store_merge_duplicates,
            store::commands::store_prune_duplicates,
            store::commands::store_fill_render_file,
            store::commands::store_resolve_pick,
            store::maps::store_list_maps,
            store::maps::store_get_map,
            store::maps::store_create_map,
            store::maps::store_scratch_map,
            store::maps::store_delete_map,
            store::maps::store_update_map_meta,
            store::maps::store_touch_map_opened,
            store::maps::store_rename_folder,
            store::maps::store_delete_folder,
            store::maps::store_db_stats,
            io::import::bulk_import_preview,
            io::import::bulk_import_confirm,
            io::import::bulk_import_cancel,
            io::import::store_import_preview,
            io::import::store_import_paste_preview,
            io::import::store_import_staged_location,
            io::import::store_import_file,
            io::export::store_export_json,
            io::export::store_export_csv,
            io::export::store_export_geojson,
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
            store::seen::store_seen_count,
            store::seen::store_seen_countries,
            store::seen::store_seen_maps,
            store::seen::store_seen_clear,
            store::review::store_review_create,
            store::review::store_review_get,
            store::review::store_review_list,
            store::review::store_review_update,
            store::review::store_review_delete,
            selections::saved::store_list_saved_selections,
            selections::saved::store_get_saved_selections,
            selections::saved::store_save_selection,
            selections::saved::store_delete_saved_selection,
            selections::saved::legacy::store_import_legacy_saved_selections,
            sync::remote_mapping::remote_mapping_get,
            sync::remote_mapping::remote_mapping_upsert,
            sync::remote_mapping::remote_mapping_delete,
            sync::remote_mapping::remote_mapping_clear,
            sync::engine::sync_reconcile,
            net::geoguessr::geoguessr_login,
            net::geoguessr::geoguessr_me,
            net::geoguessr::geoguessr_logout,
            net::geoguessr::geoguessr_has_session,
            plugins::vali::vali_generate,
            plugins::vali::vali_download,
            plugins::vali::vali_cancel,
            plugins::vali::vali_subdivisions,
            plugins::vali::vali_countries,
            plugins::vali::vali_data_status,
            plugins::vali::vali_download_stale,
            procedure::engine::procedure_run,
            procedure::engine::procedure_cancel,
            procedure::engine::procedure_query,
            procedure::engine::procedure_query_cancel,
        ])
        .events(tauri_specta::collect_events![
            plugins::sidecar::SidecarProgress,
            plugins::sidecar::SidecarLine,
            plugins::sidecar::SidecarLog,
            plugins::sidecar::SidecarDone,
            io::import::ImportProgress,
            io::export::ExportProgress,
            store::engine::ExternalMutation,
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
    // A name -> value map also carries its value union, so one import spells both.
    let mut put = |name: &str, doc: &[&str], value: String, union: bool| {
        ts.push('\n');
        match doc {
            [] => {}
            [one] => ts.push_str(&format!("/** {} */\n", one.trim())),
            many => {
                ts.push_str("/**\n");
                for line in many {
                    ts.push_str(&format!(" * {}\n", line.trim()));
                }
                ts.push_str(" */\n");
            }
        }
        ts.push_str(&format!("export const {name} = {value} as const;\n"));
        if union {
            ts.push_str(&format!(
                "export type {name} = (typeof {name})[keyof typeof {name}];\n"
            ));
        }
    };
    put(
        "LocationFlag",
        types::LocationFlags::DOC,
        types::wire_object(types::LocationFlags::wire_names()),
        true,
    );
    put(
        "PanoType",
        types::PanoType::DOC,
        types::wire_object(types::PanoType::wire_names()),
        true,
    );
    put(
        "ValidationState",
        types::ValidationState::DOC,
        types::wire_object(types::ValidationState::wire_names()),
        true,
    );
    for (name, value, doc) in types::LocationFlags::WIRE_CONSTS {
        put(name, doc, value.to_string(), false);
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
    let _ = APP_HANDLE.set(app.handle().clone());
    store::storage::init_paths(app.handle())?;
    store::storage::run_migrations()?;
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
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .manage(store::engine::StoreState::new(
            store::engine::StoreManager::new(),
        ))
        .manage(plugins::vali::ValiState::new())
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
                plugins::sidecar::kill_all_sidecars();
                net::presence::shutdown();
            }
        });
}
