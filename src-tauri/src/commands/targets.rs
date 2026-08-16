use crate::domain::{ApplyStatus, CliToolInfo, TargetKind, TargetLiveStatus};
use crate::error::{AppError, AppResult};
use crate::paths::{resolve_claude_home, resolve_codex_home};
use crate::repo;
use crate::state::AppState;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::process::Command;
use std::time::{Duration, Instant};
use tauri::State;

struct CliProbeCache {
    tools: Vec<CliToolInfo>,
    at: Instant,
}

static CLI_PROBE_CACHE: Lazy<Mutex<Option<CliProbeCache>>> = Lazy::new(|| Mutex::new(None));
const CLI_PROBE_TTL: Duration = Duration::from_secs(60);

#[tauri::command]
pub async fn list_target_status(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> AppResult<Vec<TargetLiveStatus>> {
    let force = force.unwrap_or(false);
    let tools = tauri::async_runtime::spawn_blocking(move || detect_cli_tools_cached(force))
        .await
        .map_err(|e| AppError::new("internal", e.to_string()))?;
    list_target_status_with_tools(&state, &tools)
}

pub(crate) fn list_target_status_with_tools(
    state: &AppState,
    tools: &[CliToolInfo],
) -> AppResult<Vec<TargetLiveStatus>> {
    let settings = state.db.with_conn(repo::settings::get_settings)?;
    let bindings = state.db.with_conn(repo::binding::list_bindings)?;

    let mut out = Vec::new();
    for kind in [TargetKind::ClaudeCode, TargetKind::Codex] {
        let binding = bindings.iter().find(|b| b.target == kind);
        let tool = tools.iter().find(|t| t.kind == kind);
        let (site, api_key) = if let Some(b) = binding {
            if let Some(sid) = &b.site_id {
                state.db.with_conn(|c| {
                    let site = repo::site::get_site(c, sid).ok();
                    let key = site
                        .as_ref()
                        .and_then(|s| state.crypto.decrypt(&s.api_key_encrypted).ok());
                    Ok((site, key))
                })?
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

        let (status, reason) = match kind {
            TargetKind::ClaudeCode => crate::adapters::claude_code::detect_status(
                binding,
                site.as_ref(),
                api_key.as_deref(),
                settings.claude_home_override.as_deref(),
            )?,
            TargetKind::Codex => crate::adapters::codex::detect_status(
                binding,
                site.as_ref(),
                api_key.as_deref(),
                settings.codex_home_override.as_deref(),
            )?,
        };

        let live_summary = match kind {
            TargetKind::ClaudeCode => crate::adapters::claude_code::live_summary(
                settings.claude_home_override.as_deref(),
            )?,
            TargetKind::Codex => {
                crate::adapters::codex::live_summary(settings.codex_home_override.as_deref())?
            }
        };

        let config_path = match kind {
            TargetKind::ClaudeCode => {
                resolve_claude_home(settings.claude_home_override.as_deref())?
                    .join("settings.json")
                    .display()
                    .to_string()
            }
            TargetKind::Codex => resolve_codex_home(settings.codex_home_override.as_deref())?
                .join("config.toml")
                .display()
                .to_string(),
        };

        out.push(TargetLiveStatus {
            kind,
            installed: tool.map(|t| t.installed).unwrap_or(false),
            version: tool.and_then(|t| t.version.clone()),
            config_path,
            status,
            applied_site_id: binding.and_then(|b| b.site_id.clone()),
            applied_site_name: binding.map(|b| b.site_name_snapshot.clone()),
            applied_model_id: binding.map(|b| b.model_id.clone()),
            provider_id: binding.and_then(|b| b.provider_id.clone()),
            orphan: matches!(status, ApplyStatus::Orphan)
                || binding.map(|b| b.orphan).unwrap_or(false),
            live_summary,
            last_applied_at: binding.map(|b| b.applied_at),
            stale_reason: reason,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn detect_cli_tools(force: Option<bool>) -> AppResult<Vec<CliToolInfo>> {
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || detect_cli_tools_cached(force))
        .await
        .map_err(|e| AppError::new("internal", e.to_string()))
}

pub(crate) fn detect_cli_tools_cached(force: bool) -> Vec<CliToolInfo> {
    if !force {
        if let Some(cached) = CLI_PROBE_CACHE.lock().as_ref() {
            if cached.at.elapsed() < CLI_PROBE_TTL {
                return cached.tools.clone();
            }
        }
    }
    let tools = vec![
        probe_tool(TargetKind::ClaudeCode, "claude"),
        probe_tool(TargetKind::Codex, "codex"),
    ];
    *CLI_PROBE_CACHE.lock() = Some(CliProbeCache {
        tools: tools.clone(),
        at: Instant::now(),
    });
    tools
}

fn probe_tool(kind: TargetKind, bin: &str) -> CliToolInfo {
    let output = Command::new(bin).arg("--version").output();
    match output {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            CliToolInfo {
                kind,
                installed: true,
                version: if version.is_empty() {
                    None
                } else {
                    Some(version)
                },
                path: which(bin),
            }
        }
        _ => CliToolInfo {
            kind,
            installed: false,
            version: None,
            path: which(bin),
        },
    }
}

fn which(bin: &str) -> Option<String> {
    let cmd = if cfg!(windows) { "where" } else { "which" };
    let out = Command::new(cmd).arg(bin).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[tauri::command]
pub fn cleanup_orphan_target(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    target: TargetKind,
) -> AppResult<()> {
    let settings = state.db.with_conn(repo::settings::get_settings)?;
    let binding = state
        .db
        .with_conn(|c| repo::binding::get_binding(c, target))?;
    if let Some(b) = binding {
        match target {
            TargetKind::ClaudeCode => {
                crate::adapters::claude_code::surgical_revert(
                    &b,
                    settings.claude_home_override.as_deref(),
                )?;
            }
            TargetKind::Codex => {
                crate::adapters::codex::surgical_revert(
                    &b,
                    settings.codex_home_override.as_deref(),
                )?;
                if let Some(env_key) = b.managed_env_keys.first() {
                    let _ = crate::env_inject::remove_codex_env(&settings, env_key);
                }
            }
        }
        state
            .db
            .with_conn(|c| repo::binding::delete_binding(c, target))?;
        crate::tray::request_tray_menu_sync(&app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_probe_cache_reuses_last_result_until_forced() {
        let first = detect_cli_tools_cached(true);
        assert_eq!(first.len(), 2);
        let cached = detect_cli_tools_cached(false);
        assert_eq!(cached[0].kind, first[0].kind);
        assert_eq!(cached[1].kind, first[1].kind);
        assert_eq!(cached[0].installed, first[0].installed);
        assert_eq!(cached[1].installed, first[1].installed);
    }
}
