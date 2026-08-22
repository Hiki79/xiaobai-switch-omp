use crate::backup::{self, BackupMeta, BackupMetaFile};
use crate::capabilities::{
    capability_on, CODEX_COMPACT, CODEX_IMAGEGEN, CODEX_SEARCH, CODEX_VISION,
};
use crate::domain::{
    ApplyRecordDto, ApplyResult, ApplyStatus, ApplyTargetResult, BackupInfo, BackupPreview,
    CapabilitySource, CatalogModel, ClaudeApplyOptions, ClaudeAuthKeyStyle, ClaudeEffortLevel,
    CodexApplyOptions, CodexReasoningEffort, OmpApplyOptions, SiteRow, TargetBinding, TargetKind,
    TouchedKeys, ZcodeApplyOptions,
};
use crate::error::{AppError, AppResult};
use crate::lock::try_lock_target;
use crate::paths::backups_dir;
use crate::repo;
use crate::state::AppState;
use chrono::Utc;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use tauri::State;
use uuid::Uuid;

fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Shared success path: persist binding + apply record, build the IPC result.
#[allow(clippy::too_many_arguments)]
fn record_success(
    state: &AppState,
    target: TargetKind,
    site: &SiteRow,
    model_id: &str,
    applied_at: i64,
    backup_root: &Path,
    binding: &TargetBinding,
    touched: &TouchedKeys,
    backup_paths: Vec<String>,
    live_summary: HashMap<String, Option<String>>,
    message: String,
    provider_id: Option<&str>,
    touched_display: Vec<String>,
) -> AppResult<ApplyTargetResult> {
    let record_id = binding
        .apply_record_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let mut stored = binding.clone();
    stored.apply_record_id = Some(record_id.clone());
    state
        .db
        .with_conn(|c| repo::binding::upsert_binding(c, &stored))?;
    state.db.with_conn(|c| {
        repo::apply::insert_record(
            c,
            &record_id,
            Some(&site.id),
            &site.name,
            target.as_str(),
            model_id,
            provider_id,
            "success",
            Some(&backup_root.display().to_string()),
            touched,
            None,
            applied_at,
        )
    })?;
    Ok(ApplyTargetResult {
        target,
        ok: true,
        status: ApplyStatus::Applied,
        backup_paths,
        message,
        live_summary: Some(live_summary),
        touched_keys: Some(touched_display),
    })
}

/// Shared failure path: persist a failed apply record, build the IPC result.
#[allow(clippy::too_many_arguments)]
fn record_failure(
    state: &AppState,
    target: TargetKind,
    site: &SiteRow,
    model_id: &str,
    applied_at: i64,
    backup_root: &Path,
    error: &AppError,
) -> ApplyTargetResult {
    let touched = TouchedKeys::default();
    let _ = state.db.with_conn(|c| {
        repo::apply::insert_record(
            c,
            &Uuid::new_v4().to_string(),
            Some(&site.id),
            &site.name,
            target.as_str(),
            model_id,
            None,
            "failed",
            Some(&backup_root.display().to_string()),
            &touched,
            Some(&error.to_string()),
            applied_at,
        )
    });
    ApplyTargetResult {
        target,
        ok: false,
        status: ApplyStatus::Failed,
        backup_paths: vec![],
        message: error.to_string(),
        live_summary: None,
        touched_keys: None,
    }
}

#[tauri::command]
pub fn apply_site(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    site_id: String,
    targets: Vec<TargetKind>,
    model_id: String,
    claude_auth_key_style: Option<String>,
    claude_opus_model_id: Option<String>,
    claude_sonnet_model_id: Option<String>,
    claude_haiku_model_id: Option<String>,
    claude_effort_level: Option<String>,
    codex_write_all_models: Option<bool>,
    codex_reasoning_effort: Option<String>,
    codex_reasoning_levels: Option<Vec<String>>,
    codex_remote_compaction: Option<bool>,
    codex_image_understanding: Option<bool>,
    codex_image_generation: Option<bool>,
    codex_web_search: Option<bool>,
    codex_capability_source: Option<String>,
    omp_write_all_models: Option<bool>,
    omp_reasoning_levels: Option<Vec<String>>,
    omp_reasoning_level: Option<String>,
    zcode_write_all_models: Option<bool>,
    zcode_reasoning_levels: Option<Vec<String>>,
    zcode_reasoning_level: Option<String>,
    // Manual context-window override written into ZCode model limits.
    zcode_context_window: Option<u64>,
    // Checked site model ids for write-all targets; None means every model.
    catalog_model_ids: Option<Vec<String>>,
) -> AppResult<ApplyResult> {
    if targets.is_empty() {
        return Err(AppError::new("validation_failed", "no targets selected"));
    }
    if model_id.trim().is_empty() {
        return Err(AppError::new("validation_failed", "model id required"));
    }

    let settings = state.db.with_conn(repo::settings::get_settings)?;
    let (site, api_key) = state.db.with_conn(|c| {
        let site = repo::site::get_site(c, &site_id)?;
        let key = state.crypto.decrypt(&site.api_key_encrypted)?;
        Ok((site, key))
    })?;

    let auth = claude_auth_key_style
        .as_deref()
        .map(ClaudeAuthKeyStyle::parse)
        .unwrap_or(site.claude_auth_key_style.clone());

    let claude_opts = ClaudeApplyOptions {
        opus_model_id: non_empty(claude_opus_model_id),
        sonnet_model_id: non_empty(claude_sonnet_model_id),
        haiku_model_id: non_empty(claude_haiku_model_id),
        effort_level: claude_effort_level
            .as_deref()
            .and_then(ClaudeEffortLevel::parse),
    };

    let capability_source = CapabilitySource::parse(codex_capability_source.as_deref());
    let (remote_compaction, image_understanding, image_generation, web_search) =
        match capability_source {
            CapabilitySource::Site => (
                capability_on(&site.capabilities, CODEX_COMPACT),
                capability_on(&site.capabilities, CODEX_VISION),
                capability_on(&site.capabilities, CODEX_IMAGEGEN),
                capability_on(&site.capabilities, CODEX_SEARCH),
            ),
            CapabilitySource::Custom => (
                codex_remote_compaction.unwrap_or(false),
                codex_image_understanding.unwrap_or(false),
                codex_image_generation.unwrap_or(false),
                codex_web_search.unwrap_or(false),
            ),
        };

    let write_all = codex_write_all_models.unwrap_or(false);
    let omp_write_all = omp_write_all_models.unwrap_or(false);
    let zcode_write_all = zcode_write_all_models.unwrap_or(false);
    let need_catalog = (write_all && targets.contains(&TargetKind::Codex))
        || (omp_write_all && targets.contains(&TargetKind::Omp))
        || (zcode_write_all && targets.contains(&TargetKind::Zcode));
    let catalog_models = if need_catalog {
        let models = state.db.with_conn(|c| repo::site::list_models(c, &site_id))?;
        let selected = match catalog_model_ids {
            // The picker narrowed the catalog: keep DB order, drop unchecked
            // ids (and unknown ones) so the target only gets what the user
            // picked. The default model is re-added by each adapter.
            Some(ids) => {
                let wanted: std::collections::HashSet<String> = ids
                    .into_iter()
                    .map(|id| id.trim().to_string())
                    .filter(|id| !id.is_empty())
                    .collect();
                models
                    .into_iter()
                    .filter(|m| wanted.contains(&m.model_id))
                    .collect::<Vec<_>>()
            }
            None => models,
        };
        // Site-level vision switch applies to every model, like the Codex
        // catalog does; per-model relay metadata wins when it declares image.
        let site_vision = capability_on(&site.capabilities, CODEX_VISION);
        selected
            .into_iter()
            .map(|m| {
                let (context, output) = crate::model_meta::resolve_limits(&m.model_id, m.raw.as_ref())
                    .map(|(c, o)| (Some(c), o))
                    .unwrap_or((None, None));
                CatalogModel {
                    model_id: m.model_id,
                    display_name: m.display_name,
                    context,
                    output,
                    vision: site_vision
                        || m.raw
                            .as_ref()
                            .map(crate::model_meta::vision_from_raw)
                            .unwrap_or(false),
                }
            })
            .collect::<Vec<_>>()
    } else {
        vec![]
    };

    let codex_reasoning_levels = codex_reasoning_levels
        .unwrap_or_default()
        .iter()
        .filter_map(|raw| CodexReasoningEffort::parse(raw))
        .map(|effort| effort.as_str().to_string())
        .collect::<Vec<_>>();

    let omp_opts = OmpApplyOptions {
        write_all_models: omp_write_all,
        catalog_models: catalog_models.clone(),
        reasoning_levels: omp_reasoning_levels.unwrap_or_default(),
        reasoning_level: non_empty(omp_reasoning_level),
    };

    let zcode_opts = ZcodeApplyOptions {
        write_all_models: zcode_write_all,
        catalog_models: catalog_models.clone(),
        context_override: zcode_context_window.filter(|&v| v > 0),
        reasoning_levels: zcode_reasoning_levels.unwrap_or_default(),
        reasoning_level: non_empty(zcode_reasoning_level),
    };

    let codex_opts = CodexApplyOptions {
        write_all_models: write_all,
        reasoning_effort: codex_reasoning_effort
            .as_deref()
            .and_then(CodexReasoningEffort::parse),
        reasoning_levels: codex_reasoning_levels,
        catalog_models,
        remote_compaction,
        image_understanding,
        image_generation,
        web_search,
        capability_source,
    };

    let applied_at = Utc::now().timestamp_millis();
    let mut results = Vec::new();

    for target in targets {
        let _lock = try_lock_target(target.as_str())?;
        let backup_root = backups_dir()?
            .join(target.as_str())
            .join(format!("{}", applied_at));
        fs::create_dir_all(&backup_root)?;

        let binding_before = state
            .db
            .with_conn(|c| repo::binding::get_binding(c, target))?;

        let outcome = match target {
            TargetKind::Codex => {
                match crate::adapters::codex::apply(
                    &site,
                    &api_key,
                    &model_id,
                    &codex_opts,
                    settings.codex_home_override.as_deref(),
                    &backup_root,
                ) {
                    Ok(o) => {
                        let inject_msg = crate::env_inject::inject_codex_env(
                            &settings,
                            &o.env_key,
                            &api_key,
                        )
                        .unwrap_or_else(|e| e.to_string());
                        record_success(
                            &state,
                            target,
                            &site,
                            &model_id,
                            applied_at,
                            &backup_root,
                            &o.binding,
                            &o.touched,
                            o.backup_paths,
                            o.live_summary,
                            format!("{} {}", o.message, inject_msg),
                            Some(&o.provider_id),
                            o.touched.env_keys.clone(),
                        )
                    }
                    Err(e) => Ok(record_failure(
                        &state,
                        target,
                        &site,
                        &model_id,
                        applied_at,
                        &backup_root,
                        &e,
                    )),
                }
            }
            TargetKind::Omp => {
                match crate::adapters::omp::apply(
                    &site,
                    &api_key,
                    &model_id,
                    &omp_opts,
                    settings.omp_home_override.as_deref(),
                    &backup_root,
                ) {
                    Ok(o) => record_success(
                        &state,
                        target,
                        &site,
                        &model_id,
                        applied_at,
                        &backup_root,
                        &o.binding,
                        &o.touched,
                        o.backup_paths,
                        o.live_summary,
                        o.message,
                        o.binding.provider_id.as_deref(),
                        vec![],
                    ),
                    Err(e) => Ok(record_failure(
                        &state,
                        target,
                        &site,
                        &model_id,
                        applied_at,
                        &backup_root,
                        &e,
                    )),
                }
            }
            TargetKind::ClaudeCode => {
                match crate::adapters::claude_code::apply(
                    &site,
                    &api_key,
                    &model_id,
                    auth.clone(),
                    settings.force_exclusive_claude_auth_key,
                    &claude_opts,
                    binding_before.as_ref(),
                    settings.claude_home_override.as_deref(),
                    &backup_root,
                ) {
                    Ok(o) => record_success(
                        &state,
                        target,
                        &site,
                        &model_id,
                        applied_at,
                        &backup_root,
                        &o.binding,
                        &o.touched,
                        o.backup_paths,
                        o.live_summary,
                        o.message,
                        None,
                        o.touched.claude_env_keys.clone(),
                    ),
                    Err(e) => Ok(record_failure(
                        &state,
                        target,
                        &site,
                        &model_id,
                        applied_at,
                        &backup_root,
                        &e,
                    )),
                }
            }
            TargetKind::Zcode => {
                match crate::adapters::zcode::apply(
                    &site,
                    &api_key,
                    &model_id,
                    &zcode_opts,
                    settings.zcode_home_override.as_deref(),
                    &backup_root,
                ) {
                    Ok(o) => record_success(
                        &state,
                        target,
                        &site,
                        &model_id,
                        applied_at,
                        &backup_root,
                        &o.binding,
                        &o.touched,
                        o.backup_paths,
                        o.live_summary,
                        o.message,
                        o.binding.provider_id.as_deref(),
                        vec![],
                    ),
                    Err(e) => Ok(record_failure(
                        &state,
                        target,
                        &site,
                        &model_id,
                        applied_at,
                        &backup_root,
                        &e,
                    )),
                }
            }
        };

        results.push(outcome?);
        finalize_backup_dir(
            &backup_root,
            target,
            &site.name,
            &model_id,
            None,
            applied_at,
            settings.max_backup_copies,
        );
    }

    let result = ApplyResult {
        site_id,
        model_id,
        results,
        applied_at,
    };
    crate::tray::request_tray_menu_sync(&app);
    Ok(result)
}

pub(crate) fn finalize_backup_dir(
    backup_root: &Path,
    target: TargetKind,
    site_name: &str,
    model_id: &str,
    apply_record_id: Option<&str>,
    created_at: i64,
    max_copies: u32,
) {
    let files = backup::payload_files(backup_root);
    if files.is_empty() {
        let _ = fs::remove_dir_all(backup_root);
    } else {
        let origins = crate::adapters::atomic::read_origins(backup_root);
        let prev = backup::read_meta(backup_root);
        let prev_map: std::collections::HashMap<String, Option<String>> = prev
            .map(|m| {
                m.files
                    .into_iter()
                    .map(|f| (f.name, f.original_path))
                    .collect()
            })
            .unwrap_or_default();
        let meta = BackupMeta {
            version: 1,
            target: target.as_str().into(),
            created_at,
            site_name: Some(site_name.into()),
            model_id: Some(model_id.into()),
            apply_record_id: apply_record_id.map(|s| s.to_string()),
            files: files
                .into_iter()
                .map(|name| BackupMetaFile {
                    original_path: origins
                        .get(&name)
                        .cloned()
                        .or_else(|| prev_map.get(&name).cloned().flatten()),
                    name,
                })
                .collect(),
        };
        let _ = backup::write_meta(backup_root, &meta);
    }
    let _ = backup::prune_target_backups(target, max_copies);
}

#[tauri::command]
pub fn revert_target(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    target: TargetKind,
) -> AppResult<()> {
    let _lock = try_lock_target(target.as_str())?;
    let settings = state.db.with_conn(repo::settings::get_settings)?;
    let binding = state
        .db
        .with_conn(|c| repo::binding::get_binding(c, target))?
        .ok_or_else(|| AppError::new("not_found", "no binding to revert"))?;

    match target {
        TargetKind::ClaudeCode => {
            crate::adapters::claude_code::surgical_revert(
                &binding,
                settings.claude_home_override.as_deref(),
            )?;
        }
        TargetKind::Codex => {
            crate::adapters::codex::surgical_revert(
                &binding,
                settings.codex_home_override.as_deref(),
            )?;
            if let Some(env_key) = binding.managed_env_keys.first() {
                let _ = crate::env_inject::remove_codex_env(&settings, env_key);
            }
        }
        TargetKind::Omp => {
            crate::adapters::omp::surgical_revert(
                &binding,
                settings.omp_home_override.as_deref(),
            )?;
        }
        TargetKind::Zcode => {
            crate::adapters::zcode::surgical_revert(
                &binding,
                settings.zcode_home_override.as_deref(),
            )?;
        }
    }
    state
        .db
        .with_conn(|c| repo::binding::delete_binding(c, target))?;
    crate::tray::request_tray_menu_sync(&app);
    Ok(())
}

#[tauri::command]
pub fn restore_official_target(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    target: TargetKind,
) -> AppResult<()> {
    let _lock = try_lock_target(target.as_str())?;
    let settings = state.db.with_conn(repo::settings::get_settings)?;
    let binding = state
        .db
        .with_conn(|c| repo::binding::get_binding(c, target))?;

    let applied_at = Utc::now().timestamp_millis();
    let backup_root = backups_dir()?
        .join(target.as_str())
        .join(format!("{}", applied_at));
    fs::create_dir_all(&backup_root)?;

    let (site_name, model_id) = match &binding {
        Some(b) => (b.site_name_snapshot.as_str(), b.model_id.as_str()),
        None => ("official", "official"),
    };

    let result = match target {
        TargetKind::ClaudeCode => crate::adapters::claude_code::restore_official(
            settings.claude_home_override.as_deref(),
            &backup_root,
        )
        .map(|_| ()),
        TargetKind::Codex => crate::adapters::codex::restore_official(
            binding.as_ref(),
            settings.codex_home_override.as_deref(),
            &backup_root,
        )
        .map(|outcome| {
            for key in &outcome.env_keys {
                let _ = crate::env_inject::remove_codex_env(&settings, key);
            }
        }),
        TargetKind::Omp => crate::adapters::omp::restore_official(
            settings.omp_home_override.as_deref(),
            &backup_root,
        )
        .map(|_| ()),
        TargetKind::Zcode => crate::adapters::zcode::restore_official(
            settings.zcode_home_override.as_deref(),
            &backup_root,
        )
        .map(|_| ()),
    };

    match result {
        Ok(()) => {
            if binding.is_some() {
                state
                    .db
                    .with_conn(|c| repo::binding::delete_binding(c, target))?;
            }
            finalize_backup_dir(
                &backup_root,
                target,
                site_name,
                model_id,
                None,
                applied_at,
                settings.max_backup_copies,
            );
            crate::tray::request_tray_menu_sync(&app);
            Ok(())
        }
        Err(e) => {
            finalize_backup_dir(
                &backup_root,
                target,
                site_name,
                model_id,
                None,
                applied_at,
                settings.max_backup_copies,
            );
            Err(e)
        }
    }
}

#[tauri::command]
pub fn list_apply_records(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> AppResult<Vec<ApplyRecordDto>> {
    state
        .db
        .with_conn(|c| repo::apply::list_records(c, limit.unwrap_or(50)))
}

#[tauri::command]
pub fn list_backups(
    state: State<'_, AppState>,
    target: Option<String>,
) -> AppResult<Vec<BackupInfo>> {
    let root = backups_dir()?;
    if !root.exists() {
        return Ok(vec![]);
    }
    let targets: Vec<TargetKind> = if let Some(t) = target.as_deref().and_then(TargetKind::parse) {
        vec![t]
    } else {
        vec![TargetKind::ClaudeCode, TargetKind::Codex, TargetKind::Omp, TargetKind::Zcode]
    };
    backup::list_backups_in(&root, &targets, |dir| {
        state
            .db
            .with_conn(|c| repo::apply::find_record_by_backup_dir(c, dir))
            .ok()
            .flatten()
            .map(|r| (Some(r.id), Some(r.site_name_snapshot), Some(r.model_id)))
            .unwrap_or((None, None, None))
    })
}

#[tauri::command]
pub fn preview_backup(id: String) -> AppResult<BackupPreview> {
    backup::preview_backup_in(&backups_dir()?, &id)
}

#[tauri::command]
pub fn delete_backup(id: String) -> AppResult<()> {
    backup::delete_backup_in(&backups_dir()?, &id)
}

#[tauri::command]
pub fn restore_backup(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let (target, _) = backup::parse_backup_id(&id)?;
    let _lock = try_lock_target(target.as_str())?;
    let settings = state.db.with_conn(repo::settings::get_settings)?;
    backup::restore_backup_in(&backups_dir()?, &id, &settings, None)?;
    crate::tray::request_tray_menu_sync(&app);
    Ok(())
}
