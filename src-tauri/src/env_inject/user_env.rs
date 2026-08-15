use crate::error::{AppError, AppResult};

#[cfg(windows)]
pub fn set_user_env(key: &str, value: &str) -> AppResult<()> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (env, _) = hkcu.create_subkey("Environment")?;
    env.set_value(key, &value)?;
    Ok(())
}

#[cfg(windows)]
pub fn remove_user_env(key: &str) -> AppResult<()> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(env) = hkcu.open_subkey_with_flags("Environment", KEY_WRITE) {
        let _ = env.delete_value(key);
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
