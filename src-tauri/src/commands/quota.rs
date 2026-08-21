use crate::domain::SiteQuota;
use crate::error::AppResult;
use crate::repo;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn probe_site_quota(
    state: State<'_, AppState>,
    site_id: String,
) -> AppResult<SiteQuota> {
    let (site, api_key, settings) = state.db.with_conn(|c| {
        let site = repo::site::get_site(c, &site_id)?;
        let key = state.crypto.decrypt(&site.api_key_encrypted)?;
        let settings = repo::settings::get_settings(c)?;
        Ok((site, key, settings))
    })?;
    if api_key.trim().is_empty() {
        return Ok(crate::quota_probe::empty_key_result());
    }
    crate::quota_probe::probe_quota(&site, &api_key, &settings).await
}
