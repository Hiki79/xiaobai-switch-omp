pub mod codex_env_file;
pub mod shell_rc;
pub mod user_env;

use crate::domain::AppSettings;
use crate::error::AppResult;
use crate::paths::codex_env_path;

/// Platform matrix for delivering Codex env_key into process environment.
pub fn inject_codex_env(settings: &AppSettings, env_key: &str, api_key: &str) -> AppResult<String> {
    let mode = settings.codex_env_inject_mode.as_str();
    let effective = match mode {
        "file_only" => "file_only",
        "shell_rc" => "shell_rc",
        "user_env" => "user_env",
        _ => {
            // auto
            if cfg!(target_os = "windows") {
                "user_env"
            } else {
                "shell_rc"
            }
        }
    };

    let env_path = codex_env_path()?;
    // codex.env is always maintained by adapter; here we only do extra inject
    match effective {
        "user_env" => {
            user_env::set_user_env(env_key, api_key)?;
            Ok(format!(
                "User env set for {env_key}. Restart terminal/IDE. Backup file: {}",
                env_path.display()
            ))
        }
        "shell_rc" => {
            let rc = shell_rc::ensure_source_block(&env_path)?;
            Ok(format!(
                "Shell rc updated ({rc}). Open a new terminal. Note: Dock/GUI apps may not load rc."
            ))
        }
        _ => Ok(format!(
            "codex.env only: {}. Source it manually or configure shell.",
            env_path.display()
        )),
    }
}

pub fn remove_codex_env(settings: &AppSettings, env_key: &str) -> AppResult<()> {
    let mode = settings.codex_env_inject_mode.as_str();
    let effective = match mode {
        "user_env" => "user_env",
        "auto" if cfg!(target_os = "windows") => "user_env",
        _ => "shell_rc",
    };
    if effective == "user_env" {
        let _ = user_env::remove_user_env(env_key);
    }
    Ok(())
}
