use crate::domain::{
    clamp_max_backup_copies, clamp_route_probe_ttl, normalize_proxy_mode, normalize_proxy_protocol,
    AppSettings,
};
use crate::error::{AppError, AppResult};
use rusqlite::Connection;

fn normalize(mut s: AppSettings) -> AppSettings {
    s.max_backup_copies = clamp_max_backup_copies(s.max_backup_copies);
    s.route_probe_ttl_minutes = clamp_route_probe_ttl(s.route_probe_ttl_minutes);
    s.proxy_mode = normalize_proxy_mode(&s.proxy_mode);
    s.proxy_protocol = normalize_proxy_protocol(&s.proxy_protocol);
    if let Some(host) = s.proxy_host.as_mut() {
        let trimmed = host.trim().to_string();
        s.proxy_host = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        };
    }
    if !s.close_to_tray {
        s.start_in_tray = false;
    }
    s
}

pub fn get_settings(conn: &Connection) -> AppResult<AppSettings> {
    let mut stmt = conn.prepare("SELECT json FROM settings WHERE id = 1")?;
    let mut rows = stmt.query([])?;
    if let Some(row) = rows.next()? {
        let json: String = row.get(0)?;
        let s: AppSettings = serde_json::from_str(&json)
            .map_err(|e| AppError::new("internal", format!("settings parse: {e}")))?;
        Ok(normalize(s))
    } else {
        let s = AppSettings::default();
        save_settings(conn, &s)?;
        Ok(s)
    }
}

pub fn save_settings(conn: &Connection, settings: &AppSettings) -> AppResult<()> {
    let json = serde_json::to_string(settings)?;
    conn.execute(
        "INSERT INTO settings (id, json) VALUES (1, ?1)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        rusqlite::params![json],
    )?;
    Ok(())
}

pub fn merge_settings(conn: &Connection, partial: serde_json::Value) -> AppResult<AppSettings> {
    let mut current = serde_json::to_value(get_settings(conn)?)?;
    if let (Some(cur), Some(part)) = (current.as_object_mut(), partial.as_object()) {
        for (k, v) in part {
            cur.insert(k.clone(), v.clone());
        }
    }
    let merged: AppSettings = serde_json::from_value(current)
        .map_err(|e| AppError::new("validation_failed", format!("settings merge: {e}")))?;
    let merged = normalize(merged);
    save_settings(conn, &merged)?;
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn old_settings_json_gets_proxy_defaults() {
        let conn = conn();
        conn.execute(
            "INSERT INTO settings (id, json) VALUES (1, ?1)",
            rusqlite::params![r##"{"language":"en-US","themeMode":"dark","primaryColor":"#1677ff","autoStart":false,"alwaysOnTop":false,"claudeHomeOverride":null,"codexHomeOverride":null,"codexEnvInjectMode":"auto","forceExclusiveClaudeAuthKey":false,"autoCheckUpdate":true,"maxBackupCopies":30}"##],
        )
        .unwrap();
        let s = get_settings(&conn).unwrap();
        assert_eq!(s.proxy_mode, "system");
        assert_eq!(s.proxy_protocol, "http");
        assert_eq!(s.route_probe_ttl_minutes, 10);
        assert_eq!(s.language, "en-US");
        assert!(s.close_to_tray);
        assert!(!s.start_in_tray);
    }

    #[test]
    fn start_in_tray_requires_close_to_tray() {
        let conn = conn();
        let merged = merge_settings(
            &conn,
            serde_json::json!({ "closeToTray": false, "startInTray": true }),
        )
        .unwrap();
        assert!(!merged.close_to_tray);
        assert!(!merged.start_in_tray);
    }

    #[test]
    fn ttl_is_clamped() {
        let conn = conn();
        let merged =
            merge_settings(&conn, serde_json::json!({ "routeProbeTtlMinutes": 0 })).unwrap();
        assert_eq!(merged.route_probe_ttl_minutes, 1);
        let merged =
            merge_settings(&conn, serde_json::json!({ "routeProbeTtlMinutes": 99999 })).unwrap();
        assert_eq!(merged.route_probe_ttl_minutes, 1440);
    }
}
