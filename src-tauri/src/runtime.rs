//! Target launch + run-state detection.
//!
//! Reuses [`crate::cli_detect`] probe results to decide what is installed, and
//! enumerates real processes to decide what is running. Matching is always
//! path/command-line based (never fuzzy process-name matching), so unrelated
//! programs cannot be mistaken for a target. Windows launches TUI targets
//! inside a visible terminal (wt.exe → PowerShell → cmd.exe); ZCode is
//! treated as a GUI app and spawned directly, with best-effort window focus.

use crate::domain::{AppSettings, CliToolInfo, TargetKind};
use crate::error::{AppError, AppResult};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command as SpawnCommand;
use std::{env, fs};

/// How a target executes: a TUI runs inside a visible terminal, a GUI spawns
/// its own window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchMode {
    Tui,
    Gui,
}

pub fn launch_mode(kind: TargetKind) -> LaunchMode {
    match kind {
        TargetKind::Zcode => LaunchMode::Gui,
        _ => LaunchMode::Tui,
    }
}

/// One concrete spawn call (program + argv + optional working dir). All
/// launches keep the target visible — nothing here uses a hidden background
/// process or a shell string (`shell=true` style execution is never used).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchCommand {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
}

/// A slice of a running process that matters for target detection.
#[derive(Debug, Clone)]
pub struct ProcessInfo {
    pub pid: u32,
    pub exe: Option<PathBuf>,
    pub cmd: Vec<String>,
}

/// Resolve the executable this target launches with. TUI targets (`claude`,
/// `codex`, `omp`, `dsh`) come from the existing CLI probe; ZCode prefers a
/// probed `zcode` binary and falls back to a search of well-known GUI install
/// locations.
pub fn resolve_target_executable(kind: TargetKind, tools: &[CliToolInfo]) -> Option<PathBuf> {
    let cli_path = tools
        .iter()
        .find(|t| t.kind == kind && t.installed)
        .and_then(|t| t.path.as_ref())
        .map(PathBuf::from);
    match kind {
        TargetKind::Zcode => cli_path.or_else(find_zcode_gui),
        _ => cli_path,
    }
}

/// Directory candidates where the ZCode GUI app installs.
pub fn zcode_gui_candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(windows)]
    {
        if let Ok(base) = env::var("LOCALAPPDATA") {
            let base = PathBuf::from(base);
            dirs.push(base.join("Programs").join("ZCode"));
            dirs.push(base.join("Programs").join("zcode"));
            dirs.push(base.join("ZCode"));
        }
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(base) = env::var(var) {
                let base = PathBuf::from(base);
                dirs.push(base.join("ZCode"));
                dirs.push(base.join("zcode"));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = env::var("HOME") {
            let home = PathBuf::from(home);
            dirs.push(home.join("Applications").join("ZCode.app"));
            dirs.push(home.join("Applications").join("zcode.app"));
            dirs.push(home.join(".zcode").join("ZCode.app"));
        }
        dirs.push(PathBuf::from("/Applications/ZCode.app"));
        dirs.push(PathBuf::from("/Applications/zcode.app"));
    }
    #[cfg(target_os = "linux")]
    {
        dirs.push(PathBuf::from("/opt/ZCode"));
        dirs.push(PathBuf::from("/opt/zcode"));
        dirs.push(PathBuf::from("/usr/lib/zcode"));
    }
    dirs
}

fn zcode_gui_file_names() -> Vec<String> {
    #[cfg(windows)]
    {
        vec!["ZCode.exe".into(), "zcode.exe".into()]
    }
    #[cfg(not(windows))]
    {
        vec!["ZCode".into(), "zcode".into()]
    }
}

/// Scan explicit directories for the ZCode GUI executable (testable without
/// touching the real install layout).
pub fn find_zcode_gui_in(dirs: &[PathBuf]) -> Option<PathBuf> {
    let names = zcode_gui_file_names();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        for name in &names {
            let path = dir.join(name);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

pub fn find_zcode_gui() -> Option<PathBuf> {
    find_zcode_gui_in(&zcode_gui_candidate_dirs())
}

/// Enumerate running processes (exe path + command line). `refresh` is
/// invoked with a fresh `System` so every call sees the current snapshot.
pub fn collect_processes() -> Vec<ProcessInfo> {
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system
        .processes()
        .iter()
        .map(|(pid, process)| ProcessInfo {
            pid: pid.as_u32(),
            exe: process.exe().map(|p| p.to_path_buf()),
            cmd: process
                .cmd()
                .iter()
                .map(|s| s.to_string_lossy().into_owned())
                .collect(),
        })
        .collect()
}

fn normalize_path_str(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        raw.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        raw
    }
}

/// True when a process is (or was launched as) the resolved target executable:
/// exact (canonical) exe-path match, or the resolved path appearing in the
/// process command line — this is how `.cmd`/`.bat` shims and their wrapping
/// shells are recognized without name-only guessing.
pub fn process_matches_tool(process: &ProcessInfo, tool_path: &Path) -> bool {
    let canon_tool = fs::canonicalize(tool_path).unwrap_or_else(|_| tool_path.to_path_buf());
    let needle = normalize_path_str(&canon_tool);
    if let Some(exe) = &process.exe {
        let canon_exe = fs::canonicalize(exe).unwrap_or_else(|_| exe.clone());
        if normalize_path_str(&canon_exe) == needle {
            return true;
        }
    }
    process.cmd.iter().any(|arg| {
        let arg = arg.trim().trim_matches('"');
        normalize_path_str(Path::new(arg)) == needle || arg.contains(&needle)
    })
}

pub fn detect_running_pid(tool_path: Option<&Path>, processes: &[ProcessInfo]) -> Option<u32> {
    let path = tool_path?;
    processes
        .iter()
        .find(|p| process_matches_tool(p, path))
        .map(|p| p.pid)
}

/// Last saved launch directory for a target, if any.
pub fn last_working_dir(settings: &AppSettings, kind: TargetKind) -> Option<PathBuf> {
    settings
        .launch_working_directories
        .get(kind.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
}

/// Resolve the effective working directory: explicit request → last saved →
/// user home. Empty strings from the UI count as "not provided".
pub fn resolve_working_dir(
    requested: Option<String>,
    settings: &AppSettings,
    kind: TargetKind,
) -> AppResult<PathBuf> {
    let requested = requested.filter(|s| !s.trim().is_empty());
    let dir = match requested {
        Some(raw) => PathBuf::from(raw.trim()),
        None => last_working_dir(settings, kind).unwrap_or(crate::paths::home_dir()?),
    };
    if !dir.is_dir() {
        return Err(AppError::new(
            "working_dir_missing",
            format!("working directory does not exist: {}", dir.display()),
        ));
    }
    Ok(dir)
}

/// PATH for the spawned terminal: the target binary's directory first, then
/// the process PATH and the extra well-known bin dirs — a GUI-launched app has
/// a stripped PATH, so node shims wrapped in `.cmd` still find their runtime.
pub fn launch_env(exe: &Path, probe: &crate::cli_detect::ProbeEnv) -> HashMap<String, String> {
    let mut dirs = Vec::new();
    if let Some(parent) = exe.parent() {
        dirs.push(parent.to_path_buf());
    }
    dirs.extend(probe.path_dirs.iter().cloned());
    dirs.extend(probe.extra_dirs.iter().cloned());
    let mut map = HashMap::new();
    if let Ok(joined) = env::join_paths(dirs.iter().filter(|p| !p.as_os_str().is_empty())) {
        map.insert("PATH".into(), joined.to_string_lossy().into_owned());
    }
    map
}

/// Windows: escape a path for a PowerShell single-quoted string (`'` → `''`).
fn escape_ps_single(s: &str) -> String {
    s.replace('\'', "''")
}

/// Windows: cmd.exe `/k` wants the command wrapped in quotes when it contains
/// spaces; embedded quotes are doubled so the shell keeps parsing the path.
fn cmd_quoted(exe: &Path) -> String {
    format!("\"{}\"", exe.display().to_string().replace('"', "\"\""))
}

/// TUI launch candidates in priority order. Windows: wt.exe → PowerShell →
/// cmd.exe. Other platforms: desktop terminal emulators (best effort).
pub fn build_tui_launch_commands(exe: &Path, workdir: &Path) -> Vec<LaunchCommand> {
    let exe_str = exe.display().to_string();
    let dir_str = workdir.display().to_string();
    #[cfg(windows)]
    {
        vec![
            LaunchCommand {
                program: "wt.exe".into(),
                args: vec![
                    "new-tab".into(),
                    "--startingDirectory".into(),
                    dir_str.clone(),
                    "cmd.exe".into(),
                    "/d".into(),
                    "/k".into(),
                    cmd_quoted(exe),
                ],
                cwd: None,
            },
            // Windows PowerShell 5.1 silently ignores `-WorkingDirectory`, so
            // the directory is passed twice: inherited via the spawned cwd and
            // set explicitly before invoking the target (profiles may cd away).
            LaunchCommand {
                program: "powershell.exe".into(),
                args: vec![
                    "-NoExit".into(),
                    "-Command".into(),
                    format!(
                        "Set-Location -LiteralPath '{}'; & '{}'",
                        escape_ps_single(&dir_str),
                        escape_ps_single(&exe_str)
                    ),
                ],
                cwd: Some(dir_str.clone()),
            },
            LaunchCommand {
                program: "cmd.exe".into(),
                args: vec!["/d".into(), "/k".into(), cmd_quoted(exe)],
                cwd: Some(dir_str),
            },
        ]
    }
    #[cfg(not(windows))]
    {
        vec![
            LaunchCommand {
                program: "x-terminal-emulator".into(),
                args: vec!["-e".into(), exe_str.clone()],
                cwd: Some(dir_str.clone()),
            },
            LaunchCommand {
                program: "xterm".into(),
                args: vec!["-e".into(), exe_str.clone()],
                cwd: Some(dir_str.clone()),
            },
            #[cfg(target_os = "macos")]
            LaunchCommand {
                program: "open".into(),
                args: vec!["-a".into(), "Terminal".into(), exe_str],
                cwd: None,
            },
            #[cfg(not(target_os = "macos"))]
            LaunchCommand {
                program: "x-terminal-emulator".into(),
                args: vec!["--".into(), exe_str],
                cwd: Some(dir_str),
            },
        ]
    }
}

/// GUI targets spawn their executable directly — no terminal wrapper.
pub fn build_gui_launch_command(exe: &Path) -> LaunchCommand {
    LaunchCommand {
        program: exe.display().to_string(),
        args: vec![],
        cwd: None,
    }
}

/// What to do with a GUI target on "launch": an already-running instance is
/// never spawned again (single instance), we only try to focus it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuiLaunchPlan {
    FocusExisting(u32),
    Spawn,
}

pub fn gui_launch_plan(running_pid: Option<u32>) -> GuiLaunchPlan {
    match running_pid {
        Some(pid) => GuiLaunchPlan::FocusExisting(pid),
        None => GuiLaunchPlan::Spawn,
    }
}

fn spawn_one(cmd: &LaunchCommand, extra_env: Option<&HashMap<String, String>>) -> AppResult<()> {
    let mut child = SpawnCommand::new(&cmd.program);
    child.args(&cmd.args);
    if let Some(cwd) = &cmd.cwd {
        child.current_dir(cwd);
    }
    if let Some(extra) = extra_env {
        for (key, value) in extra {
            child.env(key, value);
        }
    }
    match child.spawn() {
        Ok(_) => Ok(()),
        Err(e) => Err(AppError::new(
            "launch_failed",
            redact_launch_error(format!("failed to launch {}: {e}", cmd.program)),
        )),
    }
}

/// Try launch candidates in order until one starts (missing wt.exe falls
/// through to PowerShell, then cmd.exe). A single failed candidate is only an
/// error when every candidate failed.
pub fn try_spawn(
    candidates: &[LaunchCommand],
    extra_env: Option<&HashMap<String, String>>,
) -> AppResult<()> {
    if candidates.is_empty() {
        return Err(AppError::new(
            "launch_failed",
            "no launch candidate available",
        ));
    }
    let mut last_err: Option<AppError> = None;
    for cmd in candidates {
        match spawn_one(cmd, extra_env) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::new("launch_failed", "launch failed")))
}

/// Locate the `.app` bundle containing a macOS GUI executable.
pub fn macos_bundle_path(exe: &Path) -> Option<PathBuf> {
    let app = exe.parent()?.parent()?.parent()?;
    if app.extension().and_then(|e| e.to_str()) == Some("app") {
        Some(app.to_path_buf())
    } else {
        None
    }
}

/// Best-effort focus for an already-running GUI target. Returns false when
/// the platform can't restore the window reliably; the caller must then
/// report an explicit status instead of spawning a second instance.
pub fn focus_gui_process(exe: &Path, pid: u32) -> bool {
    #[cfg(windows)]
    {
        let _ = exe;
        try_focus_window(pid)
    }
    #[cfg(target_os = "macos")]
    {
        let Some(bundle) = macos_bundle_path(exe) else {
            return false;
        };
        let cmd = LaunchCommand {
            program: "/usr/bin/open".into(),
            args: vec![bundle.display().to_string()],
            cwd: None,
        };
        spawn_one(&cmd, None).is_ok()
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let _ = (exe, pid);
        false
    }
}

/// Focus the top-most visible window owned by `pid` (Windows). See
/// `focus_gui_process` for the cross-platform policy.
#[cfg(windows)]
pub fn try_focus_window(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindowThreadProcessId, IsWindowVisible,
        SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    struct Ctx {
        pid: u32,
        found: Option<HWND>,
    }

    unsafe extern "system" fn find_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam as *mut Ctx);
        let mut proc = 0u32;
        GetWindowThreadProcessId(hwnd, &mut proc);
        if proc == ctx.pid && IsWindowVisible(hwnd) != 0 {
            ctx.found = Some(hwnd);
            0
        } else {
            1
        }
    }

    let mut ctx = Ctx { pid, found: None };
    unsafe {
        EnumWindows(Some(find_window), &mut ctx as *mut Ctx as LPARAM);
    }
    let Some(hwnd) = ctx.found else {
        return false;
    };
    unsafe {
        ShowWindow(hwnd, SW_RESTORE);
        // Foreground restrictions can block SetForegroundWindow; attaching
        // input from the current thread is the usual workaround.
        let foreground = GetForegroundWindow();
        let foreground_thread = GetWindowThreadProcessId(foreground, std::ptr::null_mut());
        let current_thread = GetCurrentThreadId();
        let target_thread = GetWindowThreadProcessId(hwnd, std::ptr::null_mut());
        let mut attached = false;
        if foreground_thread != current_thread && target_thread != foreground_thread {
            attached = AttachThreadInput(current_thread, target_thread, 1) != 0;
        }
        let focused = SetForegroundWindow(hwnd) != 0;
        if attached {
            AttachThreadInput(current_thread, target_thread, 0);
        }
        focused
    }
}

/// Mask secret-looking material from launch errors before they reach the
/// frontend. Errors here come from io failures and normally carry only paths,
/// but defense-in-depth keeps env-style secrets out of the UI.
pub fn redact_launch_error(message: impl Into<String>) -> String {
    let text = message.into();
    let secret_name_markers = ["api_key", "apikey", "auth_token", "secret", "password"];
    text.split_whitespace()
        .map(|token| {
            let lower = token.to_ascii_lowercase();
            let looks_like_name = secret_name_markers
                .iter()
                .any(|marker| lower.contains(marker));
            let looks_like_token = lower.contains("token") && !lower.contains("tokeniz");
            let looks_like_secret_value = lower.starts_with("sk-")
                || lower.starts_with("sk_")
                || lower.starts_with("xai-")
                || lower.starts_with("akias");
            if looks_like_name || looks_like_secret_value || looks_like_token {
                "<redacted>".into()
            } else {
                token.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::TargetKind;
    use std::fs;

    fn tool(kind: TargetKind, path: Option<&Path>) -> CliToolInfo {
        CliToolInfo {
            kind,
            installed: path.is_some(),
            version: None,
            path: path.map(|p| p.display().to_string()),
        }
    }

    #[cfg(windows)]
    fn fake_cli(name: &str) -> PathBuf {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!("{name}.cmd"));
        fs::write(&path, "@echo off\r\necho running\r\n").unwrap();
        path
    }

    #[cfg(not(windows))]
    fn fake_cli(name: &str) -> PathBuf {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        fs::write(&path, "#!/bin/sh\necho running\n").unwrap();
        path
    }

    #[test]
    fn resolve_picks_probed_cli_for_tui_targets() {
        let claude = fake_cli("claude");
        let tools = [tool(TargetKind::ClaudeCode, Some(&claude))];
        assert_eq!(
            resolve_target_executable(TargetKind::ClaudeCode, &tools).as_deref(),
            Some(claude.as_path())
        );
        // TUI targets never fall back to a GUI search.
        assert_eq!(resolve_target_executable(TargetKind::Omp, &tools), None);
    }

    #[test]
    fn resolve_missing_tool_is_not_installed() {
        assert_eq!(resolve_target_executable(TargetKind::Dsh, &[]), None);
    }

    #[test]
    fn find_zcode_gui_scans_candidates() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(find_zcode_gui_in(&[dir.path().to_path_buf()]), None);
        #[cfg(windows)]
        let exe = dir.path().join("ZCode.exe");
        #[cfg(not(windows))]
        let exe = dir.path().join("ZCode");
        fs::write(&exe, "mock").unwrap();
        assert_eq!(
            find_zcode_gui_in(&[dir.path().to_path_buf()]).as_deref(),
            Some(exe.as_path())
        );
    }

    #[test]
    fn all_five_kinds_resolve_through_launch_mode() {
        assert_eq!(launch_mode(TargetKind::Zcode), LaunchMode::Gui);
        for kind in [
            TargetKind::ClaudeCode,
            TargetKind::Codex,
            TargetKind::Omp,
            TargetKind::Dsh,
        ] {
            assert_eq!(launch_mode(kind), LaunchMode::Tui);
        }
    }

    #[test]
    fn working_dir_missing_is_rejected() {
        let settings = AppSettings::default();
        let missing = tempfile::tempdir().unwrap().path().join("nope");
        let err = resolve_working_dir(
            Some(missing.display().to_string()),
            &settings,
            TargetKind::Omp,
        )
        .unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.starts_with("working directory does not exist:"),
            "got: {msg}"
        );
    }

    #[test]
    fn working_dir_falls_back_to_saved_then_home() {
        let mut settings = AppSettings::default();
        let dir = tempfile::tempdir().unwrap();
        settings
            .launch_working_directories
            .insert("omp".into(), dir.path().display().to_string());
        let resolved = resolve_working_dir(None, &settings, TargetKind::Omp).unwrap();
        assert_eq!(resolved, dir.path());
    }

    #[test]
    fn tui_and_gui_build_different_launch_shapes() {
        let fake = fake_cli("claude");
        let dir = tempfile::tempdir().unwrap();
        let tui = build_tui_launch_commands(&fake, dir.path());
        assert!(!tui.is_empty());
        let gui = build_gui_launch_command(&fake);
        // GUI spawns the executable directly with no terminal wrapper.
        assert_eq!(gui.program, fake.display().to_string());
        assert!(gui.args.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn windows_launch_priority_is_wt_then_powershell_then_cmd() {
        let fake = fake_cli("codex");
        let dir = tempfile::tempdir().unwrap();
        let cmds = build_tui_launch_commands(&fake, dir.path());
        assert_eq!(cmds.len(), 3);
        assert_eq!(cmds[0].program, "wt.exe");
        assert_eq!(cmds[1].program, "powershell.exe");
        assert_eq!(cmds[2].program, "cmd.exe");
    }

    #[cfg(windows)]
    #[test]
    fn windows_escaping_handles_spaces_in_every_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("my tools").join("claude code.cmd");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, "@echo off\r\n").unwrap();
        let work = dir.path().join("project with spaces");
        fs::create_dir_all(&work).unwrap();

        let cmds = build_tui_launch_commands(&exe, &work);
        let exe_str = exe.display().to_string();
        let dir_str = work.display().to_string();

        // Windows Terminal calls cmd.exe so npm-installed .cmd/.bat shims are
        // executable, and uses the actual Windows Terminal working-dir flag.
        assert_eq!(cmds[0].args[0], "new-tab");
        assert_eq!(cmds[0].args[1], "--startingDirectory");
        assert_eq!(cmds[0].args[2], dir_str);
        assert_eq!(&cmds[0].args[3..6], ["cmd.exe", "/d", "/k"]);
        assert_eq!(
            cmds[0].args[6],
            format!("\"{}\"", exe_str.replace('"', "\"\""))
        );

        // Windows PowerShell 5.1 ignores -WorkingDirectory, so the PS fallback
        // inherits the spawn cwd AND Set-Location runs before the target.
        let ps_cmd = &cmds[1].args[2];
        assert_eq!(cmds[1].program, "powershell.exe");
        assert_eq!(cmds[1].cwd.as_deref(), Some(dir_str.as_str()));
        assert!(ps_cmd.contains(&format!(
            "Set-Location -LiteralPath '{}'",
            dir_str.replace('\'', "''")
        )));
        assert!(ps_cmd.contains(&format!("& '{}'", exe_str.replace('\'', "''"))));
        assert!(ps_cmd.contains(exe_str.as_str()));

        // cmd.exe wraps the path in quotes so /k survives the space.
        assert_eq!(
            cmds[2].args[2],
            format!("\"{}\"", exe_str.replace('"', "\"\""))
        );
        assert_eq!(cmds[2].cwd.as_deref(), Some(dir_str.as_str()));
    }

    #[cfg(windows)]
    #[test]
    fn powershell_escape_doubles_single_quotes() {
        assert_eq!(escape_ps_single("a'b"), "a''b");
        assert_eq!(escape_ps_single("plain"), "plain");
    }

    #[cfg(windows)]
    #[test]
    fn powershell_and_cmd_candidates_carry_the_working_directory() {
        let fake = fake_cli("omp");
        let dir = tempfile::tempdir().unwrap();
        let cmds = build_tui_launch_commands(&fake, dir.path());
        // The PowerShell fallback must not rely on -WorkingDirectory (ignored
        // by 5.1); both it and cmd.exe inherit the spawned cwd instead.
        assert_eq!(cmds[1].cwd.as_deref(), Some(dir.path().to_str().unwrap()));
        assert_eq!(cmds[2].cwd.as_deref(), Some(dir.path().to_str().unwrap()));
    }

    #[test]
    fn process_matches_by_canonical_exe_or_command_line() {
        let tool_path = fake_cli("claude");
        let exe_match = ProcessInfo {
            pid: 1,
            exe: Some(tool_path.clone()),
            cmd: vec![],
        };
        assert!(process_matches_tool(&exe_match, &tool_path));

        // cmd.exe /k "C:\...\claude.cmd" is recognized via the command line.
        let shell_match = ProcessInfo {
            pid: 2,
            exe: None,
            cmd: vec![
                "cmd.exe".into(),
                format!("\"{}\"", tool_path.display().to_string().replace('\\', "/")),
            ],
        };
        assert!(process_matches_tool(&shell_match, &tool_path));

        let unrelated = ProcessInfo {
            pid: 3,
            exe: None,
            cmd: vec!["claude.exe --some-other-app".into()],
        };
        assert!(!process_matches_tool(&unrelated, &tool_path));
    }

    #[test]
    fn detect_running_finds_pid_among_processes() {
        let tool = fake_cli("omp");
        let processes = vec![
            ProcessInfo {
                pid: 100,
                exe: None,
                cmd: vec![],
            },
            ProcessInfo {
                pid: 200,
                exe: Some(tool.clone()),
                cmd: vec![],
            },
        ];
        assert_eq!(detect_running_pid(Some(&tool), &processes), Some(200));
        assert_eq!(detect_running_pid(None, &processes), None);
    }

    #[test]
    fn gui_running_skip_decision_is_single_instance() {
        // The launch policy for ZCode: when a process is already running we
        // never spawn again — focus_gui_process is the only follow-up. Here we
        // only assert the detection that gates that decision.
        let tool = fake_cli("zcode");
        let processes = [ProcessInfo {
            pid: 42,
            exe: Some(tool.clone()),
            cmd: vec![],
        }];
        assert_eq!(
            gui_launch_plan(detect_running_pid(Some(&tool), &processes)),
            GuiLaunchPlan::FocusExisting(42)
        );
        let empty = vec![];
        assert_eq!(
            gui_launch_plan(detect_running_pid(Some(&tool), &empty)),
            GuiLaunchPlan::Spawn
        );
    }

    #[test]
    fn redact_masks_auth_tokens_and_keeps_paths() {
        let msg = "failed to launch cmd.exe: ANTHROPIC_AUTH_TOKEN=sk-ant-at02-ABCDEF at C:\\Tools\\claude.cmd";
        let redacted = redact_launch_error(msg);
        assert!(!redacted.contains("sk-ant-at02"));
        assert!(redacted.contains("<redacted>"));
        assert!(redacted.contains("C:\\Tools\\claude.cmd"));
    }

    #[test]
    fn default_settings_have_empty_launch_dirs() {
        let settings = AppSettings::default();
        assert!(settings.launch_working_directories.is_empty());
        assert_eq!(last_working_dir(&settings, TargetKind::Codex), None);
    }

    #[test]
    fn macos_bundle_path_finds_app_ancestor() {
        #[cfg(windows)]
        let exe = PathBuf::from(r"C:\Apps\ZCode.app\Contents\MacOS\ZCode");
        #[cfg(not(windows))]
        let exe = PathBuf::from("/Applications/ZCode.app/Contents/MacOS/ZCode");
        let bundle = macos_bundle_path(&exe).expect("bundle ancestor");
        assert!(bundle.to_string_lossy().ends_with("ZCode.app"));
        // Standalone executables have no .app ancestor.
        assert_eq!(macos_bundle_path(Path::new("/usr/bin/zcode")), None);
    }
}
