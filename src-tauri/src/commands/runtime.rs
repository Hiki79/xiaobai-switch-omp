use crate::cli_detect::ProbeEnv;
use crate::domain::{
    AppSettings, CliToolInfo, LaunchTargetRequest, TargetKind, TargetRuntimeStatus,
};
use crate::error::{AppError, AppResult};
use crate::repo;
use crate::runtime::{self, LaunchMode, ProcessInfo};
use crate::state::AppState;
use std::time::Duration;
use tauri::{Manager, State};

/// All six launchable targets, in stable order.
pub const ALL_TARGET_KINDS: [TargetKind; 6] = [
    TargetKind::ClaudeCode,
    TargetKind::Codex,
    TargetKind::Omp,
    TargetKind::Zcode,
    TargetKind::Dsh,
    TargetKind::Pi,
];

fn kinds() -> [TargetKind; 6] {
    ALL_TARGET_KINDS
}

fn status_for(
    kind: TargetKind,
    tools: &[CliToolInfo],
    processes: &[ProcessInfo],
) -> TargetRuntimeStatus {
    let exe = runtime::resolve_target_executable(kind, tools);
    let installed = exe.is_some();
    let pid = runtime::detect_running_pid(exe.as_deref(), processes);
    TargetRuntimeStatus {
        target: kind,
        installed,
        running: pid.is_some(),
        pid,
        executable_path: exe.map(|p| p.display().to_string()),
        error: None,
    }
}

fn target_launch_env(
    kind: TargetKind,
    exe: &std::path::Path,
    probe: &ProbeEnv,
    settings: &AppSettings,
) -> AppResult<std::collections::HashMap<String, String>> {
    let mut env = runtime::launch_env(exe, probe);
    if kind == TargetKind::Pi {
        let pi_home = crate::paths::resolve_pi_home(settings.pi_home_override.as_deref())?;
        env.insert("PI_CODING_AGENT_DIR".into(), pi_home.display().to_string());
    }
    Ok(env)
}

async fn detect_tools_cached(force: bool) -> AppResult<Vec<CliToolInfo>> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::commands::targets::detect_cli_tools_cached(force)
    })
    .await
    .map_err(|e| AppError::new("internal", e.to_string()))
}

async fn collect_processes() -> AppResult<Vec<ProcessInfo>> {
    tauri::async_runtime::spawn_blocking(runtime::collect_processes)
        .await
        .map_err(|e| AppError::new("internal", e.to_string()))
}

/// Runtime status for every target (installed + running + pid + executable).
#[tauri::command]
pub async fn list_target_runtime_statuses(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> AppResult<Vec<TargetRuntimeStatus>> {
    let _ = &state;
    let force = force.unwrap_or(false);
    let (tools, processes) = {
        let tools = detect_tools_cached(force).await?;
        let processes = collect_processes().await?;
        (tools, processes)
    };
    Ok(kinds()
        .iter()
        .map(|kind| status_for(*kind, &tools, &processes))
        .collect())
}

/// Runtime status for a single target.
#[tauri::command]
pub async fn get_target_runtime_status(
    state: State<'_, AppState>,
    target: TargetKind,
    force: Option<bool>,
) -> AppResult<TargetRuntimeStatus> {
    let _ = &state;
    let force = force.unwrap_or(false);
    let tools = detect_tools_cached(force).await?;
    let processes = collect_processes().await?;
    Ok(status_for(target, &tools, &processes))
}

/// Launch a target in the right mode (visible terminal for TUI, direct spawn
/// for GUI), wait briefly, re-detect, and return the final status.
///
/// The chosen working directory is remembered per target in settings. A GUI
/// target that is already running is never spawned a second time — focus is
/// attempted instead. Errors are redacted before returning.
#[tauri::command]
pub async fn launch_target(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    req: LaunchTargetRequest,
) -> AppResult<TargetRuntimeStatus> {
    let kind = req.target;
    let tools = detect_tools_cached(true).await?;
    let Some(exe) = runtime::resolve_target_executable(kind, &tools) else {
        return Err(AppError::new(
            "not_installed",
            format!("{} executable not found", kind.as_str()),
        ));
    };
    let mode = runtime::launch_mode(kind);

    let settings = state.db.with_conn(repo::settings::get_settings)?;
    let workdir = runtime::resolve_working_dir(req.working_directory, &settings, kind)?;

    // Remember the directory unless the target is GUI-only (ZCode never uses one).
    if mode == LaunchMode::Tui {
        let workdir_str = workdir.display().to_string();
        state.db.with_conn(|conn| {
            let mut settings = repo::settings::get_settings(conn)?;
            settings
                .launch_working_directories
                .insert(kind.as_str().into(), workdir_str);
            repo::settings::save_settings(conn, &settings)
        })?;
    }

    let processes = collect_processes().await?;
    let running_pid = runtime::detect_running_pid(Some(&exe), &processes);

    match mode {
        LaunchMode::Gui => match runtime::gui_launch_plan(running_pid) {
            // Single instance: never spawn again while running; focus only.
            runtime::GuiLaunchPlan::FocusExisting(pid) => {
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    runtime::focus_gui_process(&exe, pid)
                })
                .await
                .map_err(|e| AppError::new("internal", e.to_string()))?;
                let processes = collect_processes().await?;
                crate::tray::request_tray_menu_sync(&app);
                return Ok(status_for(kind, &tools, &processes));
            }
            runtime::GuiLaunchPlan::Spawn => {
                let cmd = runtime::build_gui_launch_command(&exe);
                runtime::try_spawn(&[cmd], None)?;
            }
        },
        LaunchMode::Tui => {
            // A running TUI may still open another terminal session, so the
            // launch always proceeds with a fresh visible terminal.
            let probe = ProbeEnv::from_process();
            let candidates = runtime::build_tui_launch_commands(&exe, &workdir);
            let extra_env = target_launch_env(kind, &exe, &probe, &settings)?;
            runtime::try_spawn(&candidates, Some(&extra_env))?;
        }
    }

    // Give the target a moment to come up, then report the final state.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let processes = collect_processes().await?;
    let status = status_for(kind, &tools, &processes);
    crate::tray::request_tray_menu_sync(&app);
    Ok(status)
}

/// Focus an already-running target's window. ZCode (GUI) gets a best-effort
/// foreground restore; TUI targets have no window to focus and report the
/// current status instead.
#[tauri::command]
pub async fn focus_target(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    target: TargetKind,
) -> AppResult<TargetRuntimeStatus> {
    let _ = &state;
    let tools = detect_tools_cached(false).await?;
    let Some(exe) = runtime::resolve_target_executable(target, &tools) else {
        return Err(AppError::new(
            "not_installed",
            format!("{} executable not found", target.as_str()),
        ));
    };
    let processes = collect_processes().await?;
    let Some(pid) = runtime::detect_running_pid(Some(&exe), &processes) else {
        return Err(AppError::new("not_running", "target is not running"));
    };
    let mut status = status_for(target, &tools, &processes);
    match runtime::launch_mode(target) {
        LaunchMode::Gui => {
            let focused =
                tauri::async_runtime::spawn_blocking(move || runtime::focus_gui_process(&exe, pid))
                    .await
                    .map_err(|e| AppError::new("internal", e.to_string()))?;
            if !focused {
                status.error = Some(runtime::redact_launch_error(
                    "focus unavailable: window could not be restored",
                ));
            }
        }
        LaunchMode::Tui => {
            status.error = Some(runtime::redact_launch_error(
                "focus unavailable: terminal targets have no window to focus",
            ));
        }
    }
    crate::tray::request_tray_menu_sync(&app);
    Ok(status)
}

/// Tray entry point: launch with the target's last saved working directory
/// (or the user home when nothing was recorded).
pub(crate) async fn launch_target_from_tray(app: &tauri::AppHandle, kind: TargetKind) {
    let result = {
        let state = app.state::<AppState>();
        let settings = match state.db.with_conn(repo::settings::get_settings) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("launch from tray: settings unavailable: {e}");
                return;
            }
        };
        let dir = runtime::last_working_dir(&settings, kind)
            .map(|d| d.display().to_string())
            .unwrap_or_else(|| {
                crate::paths::home_dir()
                    .map(|h| h.display().to_string())
                    .unwrap_or_default()
            });
        crate::commands::runtime::launch_target(
            app.clone(),
            state,
            LaunchTargetRequest {
                target: kind,
                working_directory: Some(dir),
            },
        )
        .await
    };
    if let Err(e) = result {
        tracing::warn!("launch from tray failed for {}: {e}", kind.as_str());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::ProcessInfo;
    use std::path::PathBuf;

    fn tool(kind: TargetKind, path: Option<&str>) -> CliToolInfo {
        CliToolInfo {
            kind,
            installed: path.is_some(),
            version: None,
            path: path.map(ToString::to_string),
        }
    }

    fn process(pid: u32, exe: Option<&str>) -> ProcessInfo {
        ProcessInfo {
            pid,
            exe: exe.map(PathBuf::from),
            cmd: vec![],
        }
    }

    #[test]
    fn all_six_kinds_enter_runtime_status_detection() {
        let zcode_exe = "C:/tools/ZCode.exe";
        let tools = vec![
            tool(TargetKind::ClaudeCode, Some("C:/tools/claude.cmd")),
            tool(TargetKind::Codex, Some("C:/tools/codex.cmd")),
            tool(TargetKind::Omp, Some("C:/tools/omp.cmd")),
            tool(TargetKind::Dsh, Some("C:/tools/dsh.cmd")),
            tool(TargetKind::Pi, Some("C:/tools/pi.cmd")),
            tool(TargetKind::Zcode, Some(zcode_exe)),
        ];
        let processes = vec![
            process(1, Some("C:/tools/claude.cmd")),
            process(2, Some("C:/tools/codex.cmd")),
            process(3, Some(zcode_exe)),
        ];
        let statuses: Vec<TargetRuntimeStatus> = kinds()
            .iter()
            .map(|kind| status_for(*kind, &tools, &processes))
            .collect();

        assert_eq!(statuses.len(), 6);
        let by_kind = |k: TargetKind| statuses.iter().find(|s| s.target == k).unwrap();

        assert!(by_kind(TargetKind::ClaudeCode).installed);
        assert!(by_kind(TargetKind::ClaudeCode).running);
        assert_eq!(by_kind(TargetKind::ClaudeCode).pid, Some(1));
        assert!(by_kind(TargetKind::Codex).running);
        assert!(by_kind(TargetKind::Omp).installed);
        assert!(!by_kind(TargetKind::Omp).running);
        assert!(by_kind(TargetKind::Dsh).installed);
        assert!(!by_kind(TargetKind::Dsh).running);
        assert!(by_kind(TargetKind::Pi).installed);
        assert!(!by_kind(TargetKind::Pi).running);
        // ZCode resolves its GUI executable (here via the probed path) and
        // reports running when that executable owns a process.
        assert!(by_kind(TargetKind::Zcode).installed);
        assert!(by_kind(TargetKind::Zcode).running);
        assert_eq!(by_kind(TargetKind::Zcode).pid, Some(3));
    }

    #[test]
    fn missing_tool_reports_not_installed_not_running() {
        let status = status_for(TargetKind::Codex, &[], &[]);
        assert!(!status.installed);
        assert!(!status.running);
        assert!(status.pid.is_none());
        assert!(status.executable_path.is_none());
        assert!(status.error.is_none());
    }

    #[test]
    fn pi_launch_env_points_to_the_configured_agent_directory() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("pi.cmd");
        std::fs::write(&exe, "@echo off\r\n").unwrap();
        let pi_home = dir.path().join("custom-pi-agent");
        let settings = AppSettings {
            pi_home_override: Some(pi_home.display().to_string()),
            ..AppSettings::default()
        };
        let env = target_launch_env(
            TargetKind::Pi,
            &exe,
            &ProbeEnv {
                path_dirs: vec![],
                extra_dirs: vec![],
            },
            &settings,
        )
        .unwrap();
        assert_eq!(
            env.get("PI_CODING_AGENT_DIR"),
            Some(&pi_home.display().to_string())
        );
    }
}
