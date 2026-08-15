use crate::domain::AppSettings;
use crate::error::AppResult;
use crate::paths::app_paths_dto;
use crate::repo;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppResult<AppSettings> {
    state.db.with_conn(repo::settings::get_settings)
}

#[tauri::command]
pub fn save_settings(
    state: State<'_, AppState>,
    partial: serde_json::Value,
) -> AppResult<AppSettings> {
    let merged = state
        .db
        .with_conn(|c| repo::settings::merge_settings(c, partial))?;
    let _ = crate::backup::prune_all(merged.max_backup_copies);
    Ok(merged)
}

#[tauri::command]
pub fn get_app_paths() -> AppResult<crate::paths::AppPaths> {
    app_paths_dto()
}

#[tauri::command]
pub fn preview_urls(base_url: String) -> AppResult<crate::url_normalize::UrlWritePreview> {
    crate::url_normalize::normalize_base_url(&base_url)
}
