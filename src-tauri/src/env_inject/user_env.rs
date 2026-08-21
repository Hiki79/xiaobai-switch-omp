#[cfg(not(windows))]
use crate::error::AppError;
use crate::error::AppResult;

#[cfg(windows)]
pub fn set_user_env(key: &str, value: &str) -> AppResult<()> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (env, _) = hkcu.create_subkey("Environment")?;
    env.set_value(key, &value)?;
    broadcast_environment_change();
    Ok(())
}

#[cfg(windows)]
pub fn remove_user_env(key: &str) -> AppResult<()> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(env) = hkcu.open_subkey_with_flags("Environment", KEY_WRITE) {
        if env.delete_value(key).is_ok() {
            broadcast_environment_change();
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set_user_env(_key: &str, _value: &str) -> AppResult<()> {
    Err(AppError::new(
        "validation_failed",
        "User environment variables are only supported on Windows in MVP. Use shell_rc or file_only.",
    ))
}

#[cfg(not(windows))]
pub fn remove_user_env(_key: &str) -> AppResult<()> {
    Ok(())
}

/// Explorer caches its environment block, and every terminal it launches
/// inherits that stale copy. HKCU\Environment writes stay invisible to new
/// processes until the WM_SETTINGCHANGE broadcast asks Explorer to reload —
/// without it the injected API key only appears after logoff/logon.
#[cfg(windows)]
fn broadcast_environment_change() {
    const HWND_BROADCAST: isize = 0xFFFF;
    const WM_SETTINGCHANGE: u32 = 0x001A;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;

    #[link(name = "user32")]
    extern "system" {
        fn SendMessageTimeoutW(
            hwnd: isize,
            msg: u32,
            wparam: usize,
            lparam: isize,
            fuflags: u32,
            utimeout: u32,
            lpdwresult: *mut usize,
        ) -> usize;
    }

    let mut result: usize = 0;
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            "Environment".as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            3000,
            &mut result,
        );
    }
}
