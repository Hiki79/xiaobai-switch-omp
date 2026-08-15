mod adapters;
mod backup;
mod commands;
mod crypto;
mod db;
mod deep_link;
mod domain;
mod env_inject;
mod error;
mod http_client;
mod lock;
mod macos_scheme;
mod models_fetch;
mod paths;
mod redact;
mod repo;
mod route_switch;
mod state;
mod url_normalize;

use state::AppState;
use tauri::Manager;

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let state = AppState::init()
                .map_err(|e| {
                    tracing::error!("failed to init app state: {e}");
                    e
                })
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            app.manage(state);
            commands::apply_platform_window_chrome(app);
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    tracing::warn!("failed to register deep link scheme: {e}");
                }
            }
            // macOS cannot register schemes at runtime. `tauri dev` is a raw
            // binary, so Launch Services never sees CFBundleURLTypes unless we
            // drop a helper .app into ~/Applications.
            #[cfg(all(target_os = "macos", debug_assertions))]
            {
                if let Err(e) = macos_scheme::install_dev_url_handler() {
                    tracing::warn!("failed to register macOS xiaobaiswitch:// handler: {e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::get_app_paths,
            commands::preview_urls,
            commands::list_sites,
            commands::get_site,
            commands::create_site,
            commands::import_site_from_deep_link,
            commands::update_site,
            commands::switch_site_route,
            commands::delete_site,
            commands::reorder_sites,
            commands::set_selected_model,
            commands::fetch_site_models,
            commands::list_site_models,
            commands::delete_site_model,
            commands::clear_site_models,
            commands::list_target_status,
            commands::detect_cli_tools,
            commands::cleanup_orphan_target,
            commands::apply_site,
            commands::revert_target,
            commands::list_apply_records,
            commands::list_backups,
            commands::preview_backup,
            commands::delete_backup,
            commands::restore_backup,
            commands::sync_windows_chrome,
            commands::set_always_on_top,
            commands::minimize_window,
            commands::toggle_maximize_window,
            commands::open_path,
            commands::open_url,
            commands::fetch_http_text,
            commands::fetch_http_bytes,
            commands::probe_urls,
            commands::take_pending_deep_link,
        ])
        .run(tauri::generate_context!())
        .expect("error while running XiaoBaiSwitch");
}
