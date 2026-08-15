use crate::error::AppResult;
use tauri::Manager;

/// Windows keeps a native caption/border unless decorations are off.
/// `titleBarStyle: Overlay` is macOS-only, so the custom title bar would
/// otherwise sit *inside* the system chrome. Shadow stays on for Win11
/// rounded corners; DWM border color is cleared so that 1px system frame
/// does not fight the in-app chrome.
pub fn apply_platform_window_chrome(app: &tauri::App) {
    #[cfg(windows)]
    {
        let Some(win) = app.get_webview_window("main") else {
            return;
        };
        if let Err(e) = win.set_decorations(false) {
            tracing::warn!("failed to disable native window decorations: {e}");
        }
        if let Err(e) = win.set_shadow(true) {
            tracing::warn!("failed to enable window shadow: {e}");
        }
        strip_windows_native_border(&win);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

#[cfg(windows)]
fn strip_windows_native_border(win: &tauri::WebviewWindow) {
    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    // tauri::HWND is windows::Win32::Foundation::HWND (*mut c_void, transparent).
    let raw: *mut std::ffi::c_void = unsafe { std::mem::transmute_copy(&hwnd) };

    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_COLOR_NONE: u32 = 0xFFFFFFFE;

    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut std::ffi::c_void,
            dwattribute: u32,
            pvattribute: *const std::ffi::c_void,
            cbattribute: u32,
        ) -> i32;
    }

    unsafe {
        let color = DWMWA_COLOR_NONE;
        let _ = DwmSetWindowAttribute(
            raw,
            DWMWA_BORDER_COLOR,
            (&color as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );
    }
}

#[tauri::command]
pub fn set_always_on_top(app: tauri::AppHandle, enabled: bool) -> AppResult<()> {
    if let Some(win) = app.get_webview_window("main") {
        win.set_always_on_top(enabled)
            .map_err(|e| crate::error::AppError::new("internal", e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn minimize_window(app: tauri::AppHandle) -> AppResult<()> {
    if let Some(win) = app.get_webview_window("main") {
        win.minimize()
            .map_err(|e| crate::error::AppError::new("internal", e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn toggle_maximize_window(app: tauri::AppHandle) -> AppResult<()> {
    if let Some(win) = app.get_webview_window("main") {
        if win
            .is_maximized()
            .map_err(|e| crate::error::AppError::new("internal", e.to_string()))?
        {
            win.unmaximize()
                .map_err(|e| crate::error::AppError::new("internal", e.to_string()))?;
        } else {
            win.maximize()
                .map_err(|e| crate::error::AppError::new("internal", e.to_string()))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn open_path(path: String) -> AppResult<()> {
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|e| crate::error::AppError::new("internal", e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn take_pending_deep_link() -> AppResult<Option<String>> {
    crate::macos_scheme::take_pending_deep_link()
}

#[tauri::command]
pub fn open_url(url: String) -> AppResult<()> {
    tauri_plugin_opener::open_url(&url, None::<&str>)
        .map_err(|e| crate::error::AppError::new("internal", e.to_string()))?;
    Ok(())
}
