use crate::state::AppState;
use std::sync::atomic::Ordering;
#[cfg(not(target_os = "macos"))]
use tauri::image::Image;
use tauri::{Manager, WebviewWindow};

pub const MAIN_WINDOW_LABEL: &str = "main";

pub fn should_close_to_tray_for(close_to_tray: bool, is_quitting: bool) -> bool {
    close_to_tray && !is_quitting
}

pub fn should_close_to_tray(app: &tauri::AppHandle) -> bool {
    let state = app.state::<AppState>();
    should_close_to_tray_for(
        state.close_to_tray.load(Ordering::Relaxed),
        state.is_quitting.load(Ordering::Relaxed),
    )
}

pub fn hide_main_window_to_tray(window: &tauri::Window) -> Result<(), String> {
    set_skip_taskbar(window, true);
    window.hide().map_err(|err| err.to_string())?;
    set_app_dock_visibility(&window.app_handle(), false);
    Ok(())
}

pub fn hide_webview_window_to_tray(window: &WebviewWindow) -> Result<(), String> {
    set_skip_taskbar(window, true);
    window.hide().map_err(|err| err.to_string())?;
    set_app_dock_visibility(&window.app_handle(), false);
    Ok(())
}

pub fn restore_main_window(app: &tauri::AppHandle) {
    reveal_app_in_dock(app);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        set_skip_taskbar(&window, false);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Keep the process a normal macOS app with the bundled product icon.
///
/// Creating a tray (or flipping `ActivationPolicy::Accessory` → `Regular`)
/// can make `tauri dev` reappear in the Dock as a generic `exec` tile.
/// Re-apply Regular + the embedded icon after those transitions.
pub fn reveal_app_in_dock(app: &tauri::AppHandle) {
    set_app_dock_visibility(app, true);
    apply_bundled_app_icon(app);
    // Accessory → Regular rebuilds the Dock tile asynchronously. A second
    // pass after the tile exists keeps the product logo instead of `exec`.
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            apply_bundled_app_icon(&app);
        });
    }
}

const APP_ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

#[cfg(not(target_os = "macos"))]
fn bundled_app_icon(app: &tauri::AppHandle) -> Option<Image<'static>> {
    if let Some(icon) = app.default_window_icon() {
        return Some(icon.clone().to_owned());
    }
    Image::from_bytes(APP_ICON_PNG).ok()
}

fn apply_bundled_app_icon(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    apply_macos_dock_icon(app);

    #[cfg(not(target_os = "macos"))]
    {
        let Some(icon) = bundled_app_icon(app) else {
            return;
        };
        if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
            if let Err(err) = window.set_icon(icon) {
                tracing::warn!(error = %err, "Failed to apply bundled app icon");
            }
        }
    }
}

/// `Window::set_icon` is a no-op on macOS. The Dock tile must be set on NSApp.
#[cfg(target_os = "macos")]
fn apply_macos_dock_icon(app: &tauri::AppHandle) {
    if objc2::MainThreadMarker::new().is_none() {
        let app = app.clone();
        if let Err(err) = app.run_on_main_thread(move || apply_macos_dock_icon_on_main()) {
            tracing::warn!(error = %err, "Failed to dispatch Dock icon update");
        }
        return;
    }
    apply_macos_dock_icon_on_main();
}

#[cfg(target_os = "macos")]
fn apply_macos_dock_icon_on_main() {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let data = NSData::with_bytes(APP_ICON_PNG);
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
        tracing::warn!("Failed to decode app icon for Dock");
        return;
    };
    let ns_app = NSApplication::sharedApplication(mtm);
    unsafe {
        ns_app.setApplicationIconImage(Some(&image));
    }
}

pub fn request_quit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    state.is_quitting.store(true, Ordering::Relaxed);
    app.exit(0);
}

/// Hide or show the app in the macOS Dock when tray-hiding.
///
/// A hidden window still keeps a Dock icon under the default `Regular`
/// activation policy. Switching to `Accessory` removes the Dock icon while
/// the process keeps running via the menu bar extra.
fn set_app_dock_visibility(app: &tauri::AppHandle, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if visible {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        if let Err(err) = app.set_activation_policy(policy) {
            tracing::warn!(
                visible,
                error = %err,
                "Failed to update macOS activation policy for tray lifecycle"
            );
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, visible);
    }
}

fn set_skip_taskbar(window: &impl SetSkipTaskbar, skip: bool) {
    window.apply_skip_taskbar(skip);
}

trait SetSkipTaskbar {
    fn apply_skip_taskbar(&self, skip: bool);
}

impl SetSkipTaskbar for tauri::Window {
    fn apply_skip_taskbar(&self, skip: bool) {
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        if let Err(err) = self.set_skip_taskbar(skip) {
            tracing::warn!(
                skip,
                error = %err,
                "Failed to update taskbar visibility for tray lifecycle"
            );
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        let _ = skip;
    }
}

impl SetSkipTaskbar for WebviewWindow {
    fn apply_skip_taskbar(&self, skip: bool) {
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        if let Err(err) = self.set_skip_taskbar(skip) {
            tracing::warn!(
                skip,
                error = %err,
                "Failed to update taskbar visibility for tray lifecycle"
            );
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        let _ = skip;
    }
}

#[cfg(test)]
mod tests {
    use super::should_close_to_tray_for;

    #[test]
    fn close_to_tray_ignored_when_quitting() {
        assert!(should_close_to_tray_for(true, false));
        assert!(!should_close_to_tray_for(true, true));
        assert!(!should_close_to_tray_for(false, false));
        assert!(!should_close_to_tray_for(false, true));
    }
}
