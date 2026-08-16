use crate::crypto::Crypto;
use crate::db::Db;
use crate::error::AppResult;
use std::sync::atomic::AtomicBool;

pub struct AppState {
    pub db: Db,
    pub crypto: Crypto,
    pub close_to_tray: AtomicBool,
    pub start_in_tray: AtomicBool,
    pub is_quitting: AtomicBool,
}

impl AppState {
    pub fn init() -> AppResult<Self> {
        let db = Db::open()?;
        let settings = db.with_conn(crate::repo::settings::get_settings)?;
        let has_sites = db.with_conn(|c| crate::repo::site::has_encrypted_sites(c))?;
        let crypto = Crypto::ensure_can_decrypt_db(has_sites)?;
        Ok(Self {
            db,
            crypto,
            close_to_tray: AtomicBool::new(settings.close_to_tray),
            start_in_tray: AtomicBool::new(settings.start_in_tray),
            is_quitting: AtomicBool::new(false),
        })
    }
}
