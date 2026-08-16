use crate::domain::AppSettings;
use crate::error::{AppError, AppResult};
use tauri::Manager;

/// OS login-item controller. Production uses the autostart plugin; tests use a fake.
pub trait AutoStartCtl {
    fn is_enabled(&self) -> Result<bool, String>;
    fn enable(&self) -> Result<(), String>;
    fn disable(&self) -> Result<(), String>;
}

/// When the settings toggle changes, return the desired OS state. `None` means leave the OS alone.
pub fn pending_auto_start(before: &AppSettings, after: &AppSettings) -> Option<bool> {
    if before.auto_start == after.auto_start {
        None
    } else {
        Some(after.auto_start)
    }
}

/// Align the OS login item with `desired`.
///
/// Enabling always calls `enable()` so the registered path is refreshed after
/// an app move or update. Disabling is a no-op when already off.
pub fn sync_auto_start(ctl: &impl AutoStartCtl, desired: bool) -> Result<(), String> {
    if desired {
        ctl.enable()
    } else if ctl.is_enabled()? {
        ctl.disable()
    } else {
        Ok(())
    }
}

pub fn apply_pending_auto_start(
    ctl: &impl AutoStartCtl,
    before: &AppSettings,
    after: &AppSettings,
) -> AppResult<()> {
    if let Some(desired) = pending_auto_start(before, after) {
        sync_auto_start(ctl, desired).map_err(|e| AppError::new("autostart_failed", e))?;
    }
    Ok(())
}

struct PluginAutoStart<'a>(&'a tauri_plugin_autostart::AutoLaunchManager);

impl AutoStartCtl for PluginAutoStart<'_> {
    fn is_enabled(&self) -> Result<bool, String> {
        self.0.is_enabled().map_err(|e| e.to_string())
    }

    fn enable(&self) -> Result<(), String> {
        self.0.enable().map_err(|e| e.to_string())
    }

    fn disable(&self) -> Result<(), String> {
        self.0.disable().map_err(|e| e.to_string())
    }
}

/// Write or remove the OS login item. Used at launch (reconcile) and when the setting changes.
pub fn apply_os_auto_start(app: &tauri::AppHandle, enabled: bool) -> AppResult<()> {
    use tauri_plugin_autostart::ManagerExt;
    sync_auto_start(&PluginAutoStart(&*app.autolaunch()), enabled)
        .map_err(|e| AppError::new("autostart_failed", e))
}

pub fn apply_pending_from_app(
    app: &tauri::AppHandle,
    before: &AppSettings,
    after: &AppSettings,
) -> AppResult<()> {
    use tauri_plugin_autostart::ManagerExt;
    apply_pending_auto_start(&PluginAutoStart(&*app.autolaunch()), before, after)
}

/// Best-effort reconcile on startup so an already-saved `autoStart` actually registers.
pub fn sync_from_settings(app: &tauri::AppHandle) {
    let desired = app
        .state::<crate::state::AppState>()
        .db
        .with_conn(crate::repo::settings::get_settings)
        .map(|s| s.auto_start)
        .unwrap_or(false);
    if let Err(e) = apply_os_auto_start(app, desired) {
        tracing::warn!("failed to sync autostart: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeAutoStart {
        enabled: RefCell<bool>,
        enable_calls: RefCell<u32>,
        disable_calls: RefCell<u32>,
        fail_enable: bool,
        fail_disable: bool,
        fail_is_enabled: bool,
    }

    impl AutoStartCtl for FakeAutoStart {
        fn is_enabled(&self) -> Result<bool, String> {
            if self.fail_is_enabled {
                return Err("status unavailable".into());
            }
            Ok(*self.enabled.borrow())
        }

        fn enable(&self) -> Result<(), String> {
            *self.enable_calls.borrow_mut() += 1;
            if self.fail_enable {
                return Err("denied".into());
            }
            *self.enabled.borrow_mut() = true;
            Ok(())
        }

        fn disable(&self) -> Result<(), String> {
            *self.disable_calls.borrow_mut() += 1;
            if self.fail_disable {
                return Err("denied".into());
            }
            *self.enabled.borrow_mut() = false;
            Ok(())
        }
    }

    fn settings(auto_start: bool) -> AppSettings {
        AppSettings {
            auto_start,
            ..AppSettings::default()
        }
    }

    #[test]
    fn pending_only_when_toggle_changes() {
        let off = settings(false);
        let on = settings(true);
        assert_eq!(pending_auto_start(&off, &on), Some(true));
        assert_eq!(pending_auto_start(&on, &off), Some(false));
        assert_eq!(pending_auto_start(&off, &off), None);
        assert_eq!(pending_auto_start(&on, &on), None);
    }

    #[test]
    fn enable_is_called_when_turning_on() {
        let ctl = FakeAutoStart::default();
        apply_pending_auto_start(&ctl, &settings(false), &settings(true)).unwrap();
        assert_eq!(*ctl.enable_calls.borrow(), 1);
        assert!(*ctl.enabled.borrow());
    }

    #[test]
    fn enable_refreshes_even_if_os_already_registered() {
        let ctl = FakeAutoStart {
            enabled: RefCell::new(true),
            ..FakeAutoStart::default()
        };
        sync_auto_start(&ctl, true).unwrap();
        assert_eq!(*ctl.enable_calls.borrow(), 1);
    }

    #[test]
    fn disable_is_called_when_turning_off() {
        let ctl = FakeAutoStart {
            enabled: RefCell::new(true),
            ..FakeAutoStart::default()
        };
        apply_pending_auto_start(&ctl, &settings(true), &settings(false)).unwrap();
        assert_eq!(*ctl.disable_calls.borrow(), 1);
        assert!(!*ctl.enabled.borrow());
    }

    #[test]
    fn disable_skips_when_already_off() {
        let ctl = FakeAutoStart::default();
        sync_auto_start(&ctl, false).unwrap();
        assert_eq!(*ctl.disable_calls.borrow(), 0);
    }

    #[test]
    fn unchanged_setting_does_not_touch_os() {
        let ctl = FakeAutoStart::default();
        apply_pending_auto_start(&ctl, &settings(false), &settings(false)).unwrap();
        apply_pending_auto_start(&ctl, &settings(true), &settings(true)).unwrap();
        assert_eq!(*ctl.enable_calls.borrow(), 0);
        assert_eq!(*ctl.disable_calls.borrow(), 0);
    }

    #[test]
    fn enable_failure_is_autostart_failed() {
        let ctl = FakeAutoStart {
            fail_enable: true,
            ..FakeAutoStart::default()
        };
        let err = apply_pending_auto_start(&ctl, &settings(false), &settings(true)).unwrap_err();
        match err {
            AppError::Coded { code, message, .. } => {
                assert_eq!(code, "autostart_failed");
                assert!(message.contains("denied"));
            }
        }
        assert!(!*ctl.enabled.borrow());
    }
}
