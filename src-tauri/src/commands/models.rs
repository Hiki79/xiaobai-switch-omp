use crate::domain::{FetchModelsResult, SiteModelDto};
use crate::error::AppResult;
use crate::repo;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn fetch_site_models(
    state: State<'_, AppState>,
    site_id: String,
) -> AppResult<FetchModelsResult> {
    let (site, api_key, settings) = state.db.with_conn(|c| {
        let site = repo::site::get_site(c, &site_id)?;
        let key = state.crypto.decrypt(&site.api_key_encrypted)?;
        let settings = repo::settings::get_settings(c)?;
        Ok((site, key, settings))
    })?;

    let result = match crate::models_fetch::fetch_models(&site, &api_key, &settings).await {
        Ok(r) => state.db.with_conn(|c| {
            repo::site::replace_models(c, &site_id, &r.models)?;
            repo::site::update_fetch_meta(c, &site_id, r.latency_ms as i64, None)?;
            let models = repo::site::list_models(c, &site_id)?;
            Ok(FetchModelsResult {
                models,
                latency_ms: r.latency_ms,
                endpoint: r.endpoint,
                fetched_at: r.fetched_at,
            })
        })?,
        Err(e) => {
            let msg = e.to_string();
            let _ = state
                .db
                .with_conn(|c| repo::site::update_fetch_meta(c, &site_id, 0, Some(&msg)));
            return Err(e);
        }
    };
    Ok(result)
}

#[tauri::command]
pub fn list_site_models(
    state: State<'_, AppState>,
    site_id: String,
) -> AppResult<Vec<SiteModelDto>> {
    state.db.with_conn(|c| repo::site::list_models(c, &site_id))
}

#[tauri::command]
pub fn clear_site_models(
    state: State<'_, AppState>,
    site_id: String,
) -> AppResult<crate::domain::SiteDto> {
    state.db.with_conn(|c| {
        repo::site::clear_models(c, &site_id)?;
        Ok(repo::site::get_site(c, &site_id)?.to_dto())
    })
}

#[tauri::command]
pub fn delete_site_model(
    state: State<'_, AppState>,
    site_id: String,
    model_id: String,
) -> AppResult<crate::domain::SiteDto> {
    state.db.with_conn(|c| {
        repo::site::delete_model(c, &site_id, &model_id)?;
        Ok(repo::site::get_site(c, &site_id)?.to_dto())
    })
}
