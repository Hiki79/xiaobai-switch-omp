use crate::domain::{ApplyRecordDto, TouchedKeys};
use crate::error::AppResult;
use rusqlite::{params, Connection};

pub fn insert_record(
    conn: &Connection,
    id: &str,
    site_id: Option<&str>,
    site_name: &str,
    target: &str,
    model_id: &str,
    provider_id: Option<&str>,
    status: &str,
    backup_dir: Option<&str>,
    touched: &TouchedKeys,
    error: Option<&str>,
    applied_at: i64,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO apply_records (id, site_id, site_name_snapshot, target, model_id, provider_id, status, backup_dir, touched_keys_json, config_snapshot_hash, error, applied_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,?10,?11)",
        params![
            id,
            site_id,
            site_name,
            target,
            model_id,
            provider_id,
            status,
            backup_dir,
            serde_json::to_string(touched)?,
            error,
            applied_at
        ],
    )?;
    Ok(())
}

pub fn list_records(conn: &Connection, limit: i64) -> AppResult<Vec<ApplyRecordDto>> {
    let mut stmt = conn.prepare(
        "SELECT id, site_id, site_name_snapshot, target, model_id, provider_id, status, backup_dir, error, applied_at
         FROM apply_records ORDER BY applied_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |row| {
        Ok(ApplyRecordDto {
            id: row.get(0)?,
            site_id: row.get(1)?,
            site_name_snapshot: row.get(2)?,
            target: row.get(3)?,
            model_id: row.get(4)?,
            provider_id: row.get(5)?,
            status: row.get(6)?,
            backup_dir: row.get(7)?,
            error: row.get(8)?,
            applied_at: row.get(9)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn find_record_by_backup_dir(
    conn: &Connection,
    dir: &str,
) -> AppResult<Option<ApplyRecordDto>> {
    let mut stmt = conn.prepare(
        "SELECT id, site_id, site_name_snapshot, target, model_id, provider_id, status, backup_dir, error, applied_at
         FROM apply_records WHERE backup_dir = ?1 ORDER BY applied_at DESC LIMIT 1",
    )?;
    let mut rows = stmt.query(params![dir])?;
    if let Some(row) = rows.next()? {
        return Ok(Some(ApplyRecordDto {
            id: row.get(0)?,
            site_id: row.get(1)?,
            site_name_snapshot: row.get(2)?,
            target: row.get(3)?,
            model_id: row.get(4)?,
            provider_id: row.get(5)?,
            status: row.get(6)?,
            backup_dir: row.get(7)?,
            error: row.get(8)?,
            applied_at: row.get(9)?,
        }));
    }
    Ok(None)
}
