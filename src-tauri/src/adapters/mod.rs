pub mod atomic;
pub mod claude_code;
pub mod codex;

use std::collections::HashMap;

pub struct RewriteOutcome {
    pub backup_paths: Vec<String>,
    pub live_summary: HashMap<String, Option<String>>,
    pub expected_fields: HashMap<String, String>,
    pub message: String,
}
