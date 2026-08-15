use crate::adapters::atomic::atomic_write;
use crate::error::AppResult;
use crate::paths::set_secret_permissions;
use std::fs;
use std::path::Path;

pub fn read_env_file(path: &Path) -> AppResult<Vec<String>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path)?;
    Ok(text.lines().map(|l| l.to_string()).collect())
}

pub fn write_env_file(path: &Path, lines: &[String]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut content = lines.join("\n");
    if !content.ends_with('\n') {
        content.push('\n');
    }
    atomic_write(path, content.as_bytes(), true)?;
    set_secret_permissions(path);
    Ok(())
}

pub fn upsert_env_key(lines: &mut Vec<String>, key: &str, value: &str) {
    let prefix_export = format!("export {key}=");
    let prefix_plain = format!("{key}=");
    let new_line = format!("export {key}=\"{}\"", escape_shell(value));
    let mut found = false;
    for line in lines.iter_mut() {
        let trimmed = line.trim_start();
        if trimmed.starts_with(&prefix_export) || trimmed.starts_with(&prefix_plain) {
            *line = new_line.clone();
            found = true;
            break;
        }
    }
    if !found {
        if lines.last().map(|l| !l.is_empty()).unwrap_or(false) {
            lines.push(String::new());
        }
        lines.push(new_line);
    }
}

pub fn remove_env_key(lines: &mut Vec<String>, key: &str) {
    let prefix_export = format!("export {key}=");
    let prefix_plain = format!("{key}=");
    lines.retain(|line| {
        let trimmed = line.trim_start();
        !(trimmed.starts_with(&prefix_export) || trimmed.starts_with(&prefix_plain))
    });
}

fn escape_shell(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_and_remove() {
        let mut lines = vec!["# header".into()];
        upsert_env_key(&mut lines, "XIAOBAI_SITE_AAA_API_KEY", "sk-1");
        upsert_env_key(&mut lines, "XIAOBAI_SITE_BBB_API_KEY", "sk-2");
        assert!(lines.iter().any(|l| l.contains("AAA")));
        assert!(lines.iter().any(|l| l.contains("BBB")));
        remove_env_key(&mut lines, "XIAOBAI_SITE_AAA_API_KEY");
        assert!(!lines.iter().any(|l| l.contains("AAA")));
        assert!(lines.iter().any(|l| l.contains("BBB")));
    }
}
