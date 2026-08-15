use crate::crypto::Crypto;
use crate::db::Db;
use crate::error::AppResult;

pub struct AppState {
    pub db: Db,
    pub crypto: Crypto,
}

impl AppState {
    pub fn init() -> AppResult<Self> {
        let db = Db::open()?;
        let has_sites = db.with_conn(|c| crate::repo::site::has_encrypted_sites(c))?;
        let crypto = Crypto::ensure_can_decrypt_db(has_sites)?;
        Ok(Self { db, crypto })
    }
}
