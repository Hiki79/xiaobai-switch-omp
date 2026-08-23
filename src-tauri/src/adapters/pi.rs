//! Pi coding agent adapter.
//!
//! Pi manages providers in `~/.pi/agent/models.json`, secrets in
//! `~/.pi/agent/auth.json`, and agent preferences (defaultProvider, defaultModel,
//! defaultThinkingLevel) in
//! `~/.pi/agent/settings.json`.

use crate::adapters::atomic::{atomic_write, backup_file, restore_file};
use crate::crypto::{key_fingerprint, key_prefix};
use crate::domain::{
    ApplyStatus, CatalogModel, PiApplyOptions, SiteProtocol, SiteRow, TargetBinding, TargetKind,
    TouchedKeys,
};
use crate::error::{AppError, AppResult};
use crate::paths::resolve_pi_home;
use chrono::Utc;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub struct PiApplyOutcome {
    pub binding: TargetBinding,
    pub touched: TouchedKeys,
    pub backup_paths: Vec<String>,
    pub live_summary: HashMap<String, Option<String>>,
    pub message: String,
}

const PROVIDER_PREFIX: &str = "xiaobai-";
const MODELS_FILE: &str = "models.json";
const AUTH_FILE: &str = "auth.json";
const SETTINGS_FILE: &str = "settings.json";

/// Reasoning levels Pi accepts in settings.json `defaultThinkingLevel`.
pub const PI_EFFORT_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

pub fn models_path(pi_home_override: Option<&str>) -> AppResult<PathBuf> {
    Ok(resolve_pi_home(pi_home_override)?.join(MODELS_FILE))
}

pub fn auth_path(pi_home_override: Option<&str>) -> AppResult<PathBuf> {
    Ok(resolve_pi_home(pi_home_override)?.join(AUTH_FILE))
}

pub fn settings_path(pi_home_override: Option<&str>) -> AppResult<PathBuf> {
    Ok(resolve_pi_home(pi_home_override)?.join(SETTINGS_FILE))
}

pub fn is_installed(pi_home_override: Option<&str>) -> AppResult<bool> {
    let home = resolve_pi_home(pi_home_override)?;
    Ok(home.join(MODELS_FILE).exists()
        || home.join(AUTH_FILE).exists()
        || home.join(SETTINGS_FILE).exists()
        || home.join("skills").exists()
        || home.join("extensions").exists())
}

fn read_json_object(path: &Path) -> AppResult<Map<String, Value>> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let text = fs::read_to_string(path)?;
    let v: Value = serde_json::from_str(&text).map_err(|e| {
        AppError::new(
            "invalid_config",
            format!("{} is not valid JSON: {e}", path.display()),
        )
    })?;
    match v {
        Value::Object(m) => Ok(m),
        _ => Err(AppError::new(
            "invalid_config",
            format!("{} root must be a JSON object", path.display()),
        )),
    }
}

fn write_json_object(path: &Path, root: &Map<String, Value>, secret: bool) -> AppResult<()> {
    let mut text = serde_json::to_string_pretty(root)?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    atomic_write(path, text.as_bytes(), secret)
}

fn provider_id_for_site(site: &SiteRow) -> String {
    let suffix: String = site
        .id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    format!("{PROVIDER_PREFIX}{suffix}")
}

fn api_for_protocol(protocol: &SiteProtocol) -> &'static str {
    match protocol {
        SiteProtocol::OpenaiCompatible => "openai-completions",
        SiteProtocol::OpenaiNative => "openai-responses",
        SiteProtocol::Anthropic => "anthropic-messages",
    }
}

fn base_url_for_protocol(
    protocol: &SiteProtocol,
    preview: crate::url_normalize::UrlWritePreview,
) -> String {
    match protocol {
        SiteProtocol::Anthropic => preview.claude_base_url,
        SiteProtocol::OpenaiCompatible | SiteProtocol::OpenaiNative => preview.codex_base_url,
    }
}

fn sanitize_level(raw: &str) -> Option<String> {
    let value = raw.trim().to_ascii_lowercase();
    PI_EFFORT_LEVELS
        .contains(&value.as_str())
        .then(|| value.to_string())
}

fn sanitize_levels(raw: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for value in raw {
        if let Some(level) = sanitize_level(value) {
            if !out.contains(&level) {
                out.push(level);
            }
        }
    }
    out
}

fn reasoning_levels_for_model(model_id: &str, raw: &[String]) -> Vec<String> {
    let sanitized = sanitize_levels(raw);
    let levels = if let Some(always) = crate::reasoning_meta::always_thinking_levels(model_id) {
        let filtered = sanitized
            .into_iter()
            .filter(|level| always.iter().any(|allowed| allowed == level))
            .collect::<Vec<_>>();
        if filtered.is_empty() {
            always
        } else {
            filtered
        }
    } else if sanitized.is_empty() {
        default_levels_for_model(model_id)
    } else {
        sanitized
    };
    PI_EFFORT_LEVELS
        .iter()
        .filter(|level| levels.iter().any(|value| value == **level))
        .map(|level| (*level).to_string())
        .collect()
}

fn default_levels_for_model(model_id: &str) -> Vec<String> {
    if let Some(levels) = crate::reasoning_meta::always_thinking_levels(model_id) {
        return levels;
    }
    let id = model_id.to_ascii_lowercase();
    if id.contains("glm-5.3") || id.contains("glm5.3") {
        vec!["low", "max", "high"]
    } else if id.contains("glm-5.2") || id.contains("glm5.2") {
        vec!["high", "max"]
    } else if id.contains("gpt") || id.contains("o1") || id.contains("o3") {
        vec!["low", "medium", "high", "xhigh"]
    } else if id.contains("claude") || id.contains("opus") || id.contains("sonnet") {
        vec!["low", "medium", "high", "xhigh"]
    } else if id.contains("kimi") {
        vec!["low", "high", "max"]
    } else if id.contains("deepseek") {
        vec!["off", "high", "max"]
    } else if id.contains("gemini") {
        vec!["minimal", "low", "medium", "high"]
    } else {
        vec!["low", "high", "max"]
    }
    .into_iter()
    .map(String::from)
    .collect()
}

fn choose_level(
    levels: &[String],
    requested: Option<&str>,
    previous: Option<String>,
) -> Option<String> {
    if let Some(value) = requested
        .and_then(sanitize_level)
        .filter(|v| levels.iter().any(|x| x == v))
    {
        return Some(value.to_string());
    }
    if let Some(prev) = previous.filter(|v| levels.iter().any(|x| x == v)) {
        return Some(prev);
    }
    const PREFERRED: [&str; 7] = ["max", "xhigh", "high", "medium", "low", "minimal", "off"];
    for candidate in PREFERRED {
        if levels.iter().any(|v| v == candidate) {
            return Some(candidate.to_string());
        }
    }
    levels.first().cloned()
}

fn map_catalog_model(cm: &CatalogModel, reasoning_levels: &[String]) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), Value::String(cm.model_id.clone()));
    m.insert(
        "name".into(),
        Value::String(if cm.display_name.trim().is_empty() {
            cm.model_id.clone()
        } else {
            cm.display_name.clone()
        }),
    );
    m.insert(
        "reasoning".into(),
        Value::Bool(!reasoning_levels.is_empty()),
    );
    let mut level_map = Map::new();
    for level in PI_EFFORT_LEVELS {
        level_map.insert(
            level.to_string(),
            if reasoning_levels.iter().any(|allowed| allowed == level) {
                Value::String(level.to_string())
            } else {
                Value::Null
            },
        );
    }
    m.insert("thinkingLevelMap".into(), Value::Object(level_map));
    m.insert("contextWindow".into(), json!(cm.context.unwrap_or(128_000)));
    m.insert("maxTokens".into(), json!(cm.output.unwrap_or(16_384)));
    m.insert(
        "cost".into(),
        json!({"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}),
    );
    if cm.vision {
        m.insert("input".into(), json!(["text", "image"]));
    } else {
        m.insert("input".into(), json!(["text"]));
    }
    Value::Object(m)
}

fn build_models_array(
    model_id: &str,
    write_all: bool,
    catalog: &[CatalogModel],
    site_vision: bool,
    default_reasoning_levels: &[String],
) -> Vec<Value> {
    if !write_all {
        let single = catalog
            .iter()
            .find(|m| m.model_id == model_id)
            .cloned()
            .unwrap_or_else(|| CatalogModel {
                model_id: model_id.to_string(),
                display_name: model_id.to_string(),
                context: None,
                output: None,
                vision: site_vision,
            });
        let levels = reasoning_levels_for_model(&single.model_id, default_reasoning_levels);
        return vec![map_catalog_model(&single, &levels)];
    }

    let mut out: Vec<Value> = catalog
        .iter()
        .map(|model| {
            let levels = if model.model_id == model_id {
                default_reasoning_levels.to_vec()
            } else {
                default_levels_for_model(&model.model_id)
            };
            map_catalog_model(model, &levels)
        })
        .collect();
    if !catalog.iter().any(|m| m.model_id == model_id) {
        let fallback = CatalogModel {
            model_id: model_id.to_string(),
            display_name: model_id.to_string(),
            context: None,
            output: None,
            vision: site_vision,
        };
        out.insert(
            0,
            map_catalog_model(
                &fallback,
                &reasoning_levels_for_model(model_id, default_reasoning_levels),
            ),
        );
    }
    out
}

fn rollback_files(backups: &[(PathBuf, PathBuf)], created: &[PathBuf]) {
    for (backup, destination) in backups.iter().rev() {
        let _ = restore_file(backup, destination);
    }
    for path in created {
        let _ = fs::remove_file(path);
    }
}

fn restore_document_snapshots(snapshots: &[(PathBuf, Option<Vec<u8>>, bool)]) {
    for (path, content, secret) in snapshots {
        match content {
            Some(bytes) => {
                let _ = atomic_write(path, bytes, *secret);
            }
            None => {
                let _ = fs::remove_file(path);
            }
        }
    }
}

fn document_snapshot(path: &Path) -> AppResult<Option<Vec<u8>>> {
    if path.exists() {
        Ok(Some(fs::read(path)?))
    } else {
        Ok(None)
    }
}

pub fn apply(
    site: &SiteRow,
    api_key: &str,
    model_id: &str,
    options: &PiApplyOptions,
    pi_home_override: Option<&str>,
    backup_root: &PathBuf,
) -> AppResult<PiApplyOutcome> {
    let api_key = api_key.trim();
    let model_id = model_id.trim();
    if api_key.is_empty() {
        return Err(AppError::new("validation_failed", "api key required"));
    }
    if model_id.is_empty() {
        return Err(AppError::new("validation_failed", "model id required"));
    }

    let home = resolve_pi_home(pi_home_override)?;
    fs::create_dir_all(&home)?;

    let models_p = home.join(MODELS_FILE);
    let auth_p = home.join(AUTH_FILE);
    let settings_p = home.join(SETTINGS_FILE);

    let mut backups: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut backup_paths: Vec<String> = Vec::new();
    let mut created: Vec<PathBuf> = Vec::new();

    for path in [&models_p, &auth_p, &settings_p] {
        if path.exists() {
            let bak = backup_file(path, backup_root)?;
            backups.push((bak.clone(), path.clone()));
            backup_paths.push(bak.display().to_string());
        } else {
            created.push(path.clone());
        }
    }

    let provider_id = provider_id_for_site(site);
    let preview = crate::url_normalize::normalize_base_url(&site.base_url)?;
    let base_url = base_url_for_protocol(&site.protocol, preview);
    let api_protocol = api_for_protocol(&site.protocol);

    let site_vision =
        crate::capabilities::capability_on(&site.capabilities, crate::capabilities::CODEX_VISION);
    let models_array = build_models_array(
        model_id,
        options.write_all_models,
        &options.catalog_models,
        site_vision,
        &reasoning_levels_for_model(model_id, &options.reasoning_levels),
    );

    // 1. Update models.json
    let mut models_root = match read_json_object(&models_p) {
        Ok(m) => m,
        Err(e) => {
            rollback_files(&backups, &created);
            return Err(e);
        }
    };
    let providers_val = models_root
        .entry("providers".to_string())
        .or_insert_with(|| json!({}));
    if !providers_val.is_object() {
        *providers_val = json!({});
    }
    if let Some(providers_obj) = providers_val.as_object_mut() {
        let mut prov = Map::new();
        prov.insert("baseUrl".into(), Value::String(base_url.clone()));
        prov.insert("api".into(), Value::String(api_protocol.into()));
        prov.insert("models".into(), Value::Array(models_array));
        providers_obj.insert(provider_id.clone(), Value::Object(prov));
    }

    if let Err(e) = write_json_object(&models_p, &models_root, false) {
        rollback_files(&backups, &created);
        return Err(e);
    }

    // 2. Update auth.json
    let mut auth_root = match read_json_object(&auth_p) {
        Ok(m) => m,
        Err(e) => {
            rollback_files(&backups, &created);
            return Err(e);
        }
    };
    auth_root.insert(
        provider_id.clone(),
        json!({
            "type": "api_key",
            "key": api_key,
        }),
    );

    if let Err(e) = write_json_object(&auth_p, &auth_root, true) {
        rollback_files(&backups, &created);
        return Err(e);
    }

    // 3. Update settings.json
    let mut settings_root = match read_json_object(&settings_p) {
        Ok(m) => m,
        Err(e) => {
            rollback_files(&backups, &created);
            return Err(e);
        }
    };
    let previous_provider = settings_root
        .get("defaultProvider")
        .and_then(Value::as_str)
        .map(str::to_string);
    let previous_model = settings_root
        .get("defaultModel")
        .and_then(Value::as_str)
        .map(String::from);
    let legacy_previous_level = settings_root
        .get("thinking")
        .and_then(Value::as_str)
        .map(String::from);

    let reasoning_ladder = reasoning_levels_for_model(model_id, &options.reasoning_levels);
    settings_root.insert("defaultProvider".into(), Value::String(provider_id.clone()));
    settings_root.insert("defaultModel".into(), Value::String(model_id.to_string()));
    let selected_level = choose_level(
        &reasoning_ladder,
        options.reasoning_level.as_deref(),
        settings_root
            .get("defaultThinkingLevel")
            .and_then(Value::as_str)
            .map(String::from)
            .or(legacy_previous_level),
    );

    if let Some(level) = &selected_level {
        settings_root.insert("defaultThinkingLevel".into(), Value::String(level.clone()));
    }

    // Remove fields written by older XiaoBai versions, but never touch a
    // user's unrelated Pi settings.
    if previous_provider.as_deref() == Some(provider_id.as_str())
        || previous_model
            .as_deref()
            .is_some_and(|value| value.starts_with(&format!("{provider_id}/")))
    {
        settings_root.remove("thinking");
    }

    if let Err(e) = write_json_object(&settings_p, &settings_root, false) {
        rollback_files(&backups, &created);
        return Err(e);
    }

    let mut touched = TouchedKeys::default();
    for path in [&models_p, &auth_p, &settings_p] {
        if created.iter().any(|created_path| created_path == path) {
            touched.created_paths.push(path.display().to_string());
        } else {
            touched.paths.push(path.display().to_string());
        }
    }

    let mut expected = HashMap::new();
    expected.insert("base_url".into(), base_url.clone());
    expected.insert("api".into(), api_protocol.into());
    expected.insert("model".into(), model_id.to_string());
    expected.insert("default_provider".into(), provider_id.clone());
    expected.insert("default_model".into(), model_id.to_string());
    if !reasoning_ladder.is_empty() {
        expected.insert("reasoning_levels".into(), reasoning_ladder.join(","));
    }
    if let Some(level) = &selected_level {
        expected.insert("default_thinking_level".into(), level.clone());
    }

    let binding = TargetBinding {
        target: TargetKind::Pi,
        site_id: Some(site.id.clone()),
        site_name_snapshot: site.name.clone(),
        model_id: model_id.into(),
        provider_id: Some(provider_id.clone()),
        key_fingerprint: key_fingerprint(api_key),
        managed_paths: vec![
            models_p.display().to_string(),
            auth_p.display().to_string(),
            settings_p.display().to_string(),
        ],
        managed_env_keys: vec![],
        expected_fields: expected,
        orphan: false,
        applied_at: Utc::now().timestamp_millis(),
        apply_record_id: Some(Uuid::new_v4().to_string()),
    };

    let summary = summary_from_docs(&models_root, &auth_root, &settings_root, Some(&provider_id));

    let mut message = "Pi models.json, auth.json, and settings.json updated.".to_string();
    if options.write_all_models {
        message.push_str(" Model list written for in-CLI model switching.");
    }

    Ok(PiApplyOutcome {
        binding,
        touched,
        backup_paths,
        live_summary: summary,
        message,
    })
}

fn summary_from_docs(
    models: &Map<String, Value>,
    auth: &Map<String, Value>,
    settings: &Map<String, Value>,
    target_provider: Option<&str>,
) -> HashMap<String, Option<String>> {
    let mut out = HashMap::new();

    let default_provider = settings.get("defaultProvider").and_then(Value::as_str);
    let default_model = settings.get("defaultModel").and_then(Value::as_str);
    if let Some(provider) = default_provider {
        out.insert("default_provider".into(), Some(provider.to_string()));
        out.insert("provider".into(), Some(provider.to_string()));
    }
    if let Some(model) = default_model {
        out.insert("default_model".into(), Some(model.to_string()));
        out.insert("model".into(), Some(model.to_string()));
    }

    // Read the legacy selector too so existing pre-schema-fix installs can
    // still be detected and cleaned up.
    let legacy_selector = default_model.filter(|value| value.contains('/'));
    if let Some(selector) = legacy_selector {
        if let Some((provider, model)) = selector.split_once('/') {
            out.insert("default_provider".into(), Some(provider.to_string()));
            out.insert("provider".into(), Some(provider.to_string()));
            out.insert("model".into(), Some(model.to_string()));
        }
    }

    let thinking = settings
        .get("defaultThinkingLevel")
        .or_else(|| settings.get("thinking"))
        .and_then(Value::as_str);
    if let Some(th) = thinking {
        out.insert("default_thinking_level".into(), Some(th.to_string()));
        out.insert("thinking".into(), Some(th.to_string()));
        out.insert("reasoning_level".into(), Some(th.to_string()));
    }

    let prov_id = target_provider
        .or(default_provider)
        .or_else(|| default_model.and_then(|dm| dm.split_once('/').map(|(p, _)| p)));

    if let Some(pid) = prov_id {
        if let Some(prov) = models
            .get("providers")
            .and_then(Value::as_object)
            .and_then(|p| p.get(pid))
            .and_then(Value::as_object)
        {
            if let Some(url) = prov.get("baseUrl").and_then(Value::as_str) {
                out.insert("base_url".into(), Some(url.to_string()));
            }
            if let Some(api) = prov.get("api").and_then(Value::as_str) {
                out.insert("api".into(), Some(api.to_string()));
            }
            if let Some(list) = prov.get("models").and_then(Value::as_array) {
                out.insert("models".into(), Some(list.len().to_string()));
                let ids: Vec<&str> = list
                    .iter()
                    .filter_map(Value::as_object)
                    .filter_map(|m| m.get("id").and_then(Value::as_str))
                    .collect();
                if !ids.is_empty() {
                    out.insert("model_ids".into(), Some(ids.join(",")));
                }
                let default_id = default_model
                    .and_then(|value| value.split_once('/').map(|(_, model)| model))
                    .or(default_model);
                if let Some(default_id) = default_id {
                    if let Some(model) = list
                        .iter()
                        .find(|item| item.get("id").and_then(Value::as_str) == Some(default_id))
                    {
                        let levels = PI_EFFORT_LEVELS
                            .iter()
                            .filter(|level| {
                                model
                                    .get("thinkingLevelMap")
                                    .and_then(Value::as_object)
                                    .and_then(|map| map.get(**level))
                                    .is_some_and(|value| !value.is_null())
                            })
                            .copied()
                            .collect::<Vec<_>>();
                        if !levels.is_empty() {
                            out.insert("reasoning_levels".into(), Some(levels.join(",")));
                        }
                        if let Some(context) = model.get("contextWindow").and_then(Value::as_u64) {
                            out.insert("model_context".into(), Some(context.to_string()));
                        }
                    }
                }
            }
        }

        if let Some(auth_entry) = auth.get(pid).and_then(Value::as_object) {
            if let Some(key) = auth_entry.get("key").and_then(Value::as_str) {
                out.insert("key_prefix".into(), Some(key_prefix(key)));
            }
        }
    }

    out
}

pub fn live_summary(pi_home_override: Option<&str>) -> AppResult<HashMap<String, Option<String>>> {
    let home = resolve_pi_home(pi_home_override)?;
    let models_p = home.join(MODELS_FILE);
    let auth_p = home.join(AUTH_FILE);
    let settings_p = home.join(SETTINGS_FILE);

    if !models_p.exists() && !settings_p.exists() {
        return Ok(HashMap::new());
    }

    let models = read_json_object(&models_p)?;
    let auth = read_json_object(&auth_p)?;
    let settings = read_json_object(&settings_p)?;

    Ok(summary_from_docs(&models, &auth, &settings, None))
}

fn has_managed_trace(
    models: &Map<String, Value>,
    auth: &Map<String, Value>,
    settings: &Map<String, Value>,
) -> bool {
    let models_trace = models
        .get("providers")
        .and_then(Value::as_object)
        .map(|providers| providers.keys().any(|id| id.starts_with(PROVIDER_PREFIX)))
        .unwrap_or(false);
    let auth_trace = auth.keys().any(|id| id.starts_with(PROVIDER_PREFIX));
    let settings_trace = settings
        .get("defaultProvider")
        .and_then(Value::as_str)
        .is_some_and(|provider| provider.starts_with(PROVIDER_PREFIX))
        || settings
            .get("defaultModel")
            .and_then(Value::as_str)
            .and_then(|model| model.split_once('/').map(|(provider, _)| provider))
            .is_some_and(|provider| provider.starts_with(PROVIDER_PREFIX));
    models_trace || auth_trace || settings_trace
}

pub fn detect_status(
    binding: Option<&TargetBinding>,
    site: Option<&SiteRow>,
    api_key: Option<&str>,
    pi_home_override: Option<&str>,
) -> AppResult<(ApplyStatus, Option<String>)> {
    let home = resolve_pi_home(pi_home_override)?;
    let models_p = home.join(MODELS_FILE);
    let auth_p = home.join(AUTH_FILE);
    let settings_p = home.join(SETTINGS_FILE);

    let models = read_json_object(&models_p)?;
    let auth = read_json_object(&auth_p)?;
    let settings = read_json_object(&settings_p)?;

    let has_trace = has_managed_trace(&models, &auth, &settings);

    if let Some(b) = binding {
        if b.orphan || b.site_id.is_none() {
            return Ok((ApplyStatus::Orphan, Some("site deleted".into())));
        }
        if let Some(key) = api_key {
            if key_fingerprint(key) != b.key_fingerprint {
                return Ok((ApplyStatus::Stale, Some("API key changed".into())));
            }
        }
        if let Some(site) = site {
            let expected_provider = provider_id_for_site(site);
            if b.provider_id.as_deref() != Some(expected_provider.as_str()) {
                return Ok((ApplyStatus::Stale, Some("provider changed".into())));
            }
        }

        let pid = b.provider_id.clone().unwrap_or_default();
        let prov = models
            .get("providers")
            .and_then(Value::as_object)
            .and_then(|p| p.get(&pid))
            .and_then(Value::as_object);

        let Some(prov) = prov else {
            return Ok((
                ApplyStatus::Stale,
                Some("provider missing in models.json".into()),
            ));
        };

        for (k, expected) in &b.expected_fields {
            match k.as_str() {
                "base_url" => {
                    if prov.get("baseUrl").and_then(Value::as_str) != Some(expected.as_str()) {
                        return Ok((ApplyStatus::Stale, Some(format!("{k} mismatch"))));
                    }
                }
                "api" => {
                    if prov.get("api").and_then(Value::as_str) != Some(expected.as_str()) {
                        return Ok((ApplyStatus::Stale, Some(format!("{k} mismatch"))));
                    }
                }
                "model" => {
                    let present = prov
                        .get("models")
                        .and_then(Value::as_array)
                        .map(|list| {
                            list.iter().any(|m| {
                                m.as_object()
                                    .and_then(|mm| mm.get("id"))
                                    .and_then(Value::as_str)
                                    == Some(expected.as_str())
                            })
                        })
                        .unwrap_or(false);
                    if !present {
                        return Ok((ApplyStatus::Stale, Some("model mismatch".into())));
                    }
                }
                "default_provider" => {
                    if settings.get("defaultProvider").and_then(Value::as_str)
                        != Some(expected.as_str())
                    {
                        return Ok((ApplyStatus::Stale, Some("defaultProvider changed".into())));
                    }
                }
                "default_model" => {
                    if settings.get("defaultModel").and_then(Value::as_str)
                        != Some(expected.as_str())
                    {
                        return Ok((ApplyStatus::Stale, Some("defaultModel changed".into())));
                    }
                }
                "default_thinking_level" => {
                    if settings.get("defaultThinkingLevel").and_then(Value::as_str)
                        != Some(expected.as_str())
                    {
                        return Ok((
                            ApplyStatus::Stale,
                            Some("defaultThinkingLevel changed".into()),
                        ));
                    }
                }
                "reasoning_levels" => {
                    let actual = prov
                        .get("models")
                        .and_then(Value::as_array)
                        .and_then(|list| {
                            list.iter().find(|item| {
                                item.get("id").and_then(Value::as_str) == Some(b.model_id.as_str())
                            })
                        })
                        .and_then(|item| item.get("thinkingLevelMap"))
                        .and_then(Value::as_object)
                        .map(|map| {
                            PI_EFFORT_LEVELS
                                .iter()
                                .filter(|level| {
                                    map.get(**level).is_some_and(|value| !value.is_null())
                                })
                                .copied()
                                .collect::<Vec<_>>()
                                .join(",")
                        })
                        .unwrap_or_default();
                    if actual != *expected {
                        return Ok((ApplyStatus::Stale, Some("reasoning levels changed".into())));
                    }
                }
                _ => {}
            }
        }

        let Some(auth_entry) = auth.get(&pid).and_then(Value::as_object) else {
            return Ok((ApplyStatus::Stale, Some("auth credential missing".into())));
        };
        if auth_entry.get("type").and_then(Value::as_str) != Some("api_key") {
            return Ok((ApplyStatus::Stale, Some("auth credential invalid".into())));
        }
        let Some(stored_key) = auth_entry.get("key").and_then(Value::as_str) else {
            return Ok((ApplyStatus::Stale, Some("auth key missing".into())));
        };
        if key_fingerprint(stored_key) != b.key_fingerprint {
            return Ok((ApplyStatus::Stale, Some("auth key changed".into())));
        }

        return Ok((ApplyStatus::Applied, None));
    }

    if has_trace {
        return Ok((
            ApplyStatus::Orphan,
            Some("untracked xiaobai provider".into()),
        ));
    }

    Ok((ApplyStatus::NotApplied, None))
}

pub fn surgical_revert(binding: &TargetBinding, pi_home_override: Option<&str>) -> AppResult<()> {
    let home = resolve_pi_home(pi_home_override)?;
    let models_p = home.join(MODELS_FILE);
    let auth_p = home.join(AUTH_FILE);
    let settings_p = home.join(SETTINGS_FILE);

    let pid = binding.provider_id.clone().unwrap_or_default();
    let snapshots = [
        (models_p.clone(), document_snapshot(&models_p)?, false),
        (auth_p.clone(), document_snapshot(&auth_p)?, true),
        (settings_p.clone(), document_snapshot(&settings_p)?, false),
    ];

    let result = (|| -> AppResult<()> {
        if models_p.exists() {
            let mut models = read_json_object(&models_p)?;
            if let Some(providers) = models.get_mut("providers").and_then(Value::as_object_mut) {
                providers.remove(&pid);
                if providers.is_empty() {
                    models.remove("providers");
                }
            }
            write_json_object(&models_p, &models, false)?;
        }

        if auth_p.exists() {
            let mut auth = read_json_object(&auth_p)?;
            auth.remove(&pid);
            write_json_object(&auth_p, &auth, true)?;
        }

        if settings_p.exists() {
            let mut settings = read_json_object(&settings_p)?;
            let current_provider = settings.get("defaultProvider").and_then(Value::as_str);
            let current_model = settings.get("defaultModel").and_then(Value::as_str);
            let managed_default = current_provider == Some(pid.as_str())
                || current_model
                    .is_some_and(|model| model.strip_prefix(&format!("{pid}/")).is_some());
            if managed_default {
                settings.remove("defaultProvider");
                settings.remove("defaultModel");
                settings.remove("defaultThinkingLevel");
                settings.remove("thinking");
            }
            write_json_object(&settings_p, &settings, false)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        restore_document_snapshots(&snapshots);
        return Err(error);
    }
    Ok(())
}

pub fn restore_official(pi_home_override: Option<&str>, backup_root: &PathBuf) -> AppResult<()> {
    let home = resolve_pi_home(pi_home_override)?;
    let models_p = home.join(MODELS_FILE);
    let auth_p = home.join(AUTH_FILE);
    let settings_p = home.join(SETTINGS_FILE);

    for path in [&models_p, &auth_p, &settings_p] {
        if path.exists() {
            backup_file(path, backup_root)?;
        }
    }

    let snapshots = [
        (models_p.clone(), document_snapshot(&models_p)?, false),
        (auth_p.clone(), document_snapshot(&auth_p)?, true),
        (settings_p.clone(), document_snapshot(&settings_p)?, false),
    ];
    let result = (|| -> AppResult<()> {
        if models_p.exists() {
            let mut models = read_json_object(&models_p)?;
            if let Some(providers) = models.get_mut("providers").and_then(Value::as_object_mut) {
                let managed: Vec<String> = providers
                    .keys()
                    .filter(|k| k.starts_with(PROVIDER_PREFIX))
                    .cloned()
                    .collect();
                for key in managed {
                    providers.remove(&key);
                }
                if providers.is_empty() {
                    models.remove("providers");
                }
            }
            write_json_object(&models_p, &models, false)?;
        }

        if auth_p.exists() {
            let mut auth = read_json_object(&auth_p)?;
            let managed: Vec<String> = auth
                .keys()
                .filter(|key| key.starts_with(PROVIDER_PREFIX))
                .cloned()
                .collect();
            for key in managed {
                auth.remove(&key);
            }
            write_json_object(&auth_p, &auth, true)?;
        }

        if settings_p.exists() {
            let mut settings = read_json_object(&settings_p)?;
            let provider = settings
                .get("defaultProvider")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let model = settings
                .get("defaultModel")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let managed_default = provider.starts_with(PROVIDER_PREFIX)
                || model.split_once('/').is_some_and(|(legacy_provider, _)| {
                    legacy_provider.starts_with(PROVIDER_PREFIX)
                });
            if managed_default {
                settings.remove("defaultProvider");
                settings.remove("defaultModel");
                settings.remove("defaultThinkingLevel");
                settings.remove("thinking");
            }
            write_json_object(&settings_p, &settings, false)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        restore_document_snapshots(&snapshots);
        return Err(error);
    }
    Ok(())
}

pub fn rewrite_base_url(
    site: &SiteRow,
    binding: &TargetBinding,
    pi_home_override: Option<&str>,
    backup_root: &PathBuf,
) -> AppResult<crate::adapters::RewriteOutcome> {
    let home = resolve_pi_home(pi_home_override)?;
    let models_p = home.join(MODELS_FILE);
    let auth_p = home.join(AUTH_FILE);
    let settings_p = home.join(SETTINGS_FILE);

    if !models_p.exists() {
        return Err(AppError::new("invalid_config", "Pi models.json missing"));
    }

    let bak = backup_file(&models_p, backup_root)?;
    let provider_id = binding
        .provider_id
        .clone()
        .unwrap_or_else(|| provider_id_for_site(site));
    let preview = crate::url_normalize::normalize_base_url(&site.base_url)?;
    let base_url = base_url_for_protocol(&site.protocol, preview);

    let mut models = read_json_object(&models_p)?;
    let providers = models
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| AppError::new("invalid_config", "Pi providers missing"))?;
    let provider = providers
        .get_mut(&provider_id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| AppError::new("not_found", "bound Pi provider missing"))?;
    provider.insert("baseUrl".into(), Value::String(base_url.clone()));
    write_json_object(&models_p, &models, false)?;

    let mut expected = binding.expected_fields.clone();
    expected.insert("base_url".into(), base_url);

    let auth = read_json_object(&auth_p).unwrap_or_default();
    let settings = read_json_object(&settings_p).unwrap_or_default();
    let live = summary_from_docs(&models, &auth, &settings, Some(&provider_id));

    Ok(crate::adapters::RewriteOutcome {
        backup_paths: vec![bak.display().to_string()],
        live_summary: live,
        expected_fields: expected,
        message: "Pi baseUrl rewritten.".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ClaudeAuthKeyStyle;

    fn site(protocol: SiteProtocol) -> SiteRow {
        SiteRow {
            id: "site-123".into(),
            name: "Relay".into(),
            base_url: "https://relay.example.com".into(),
            base_urls: vec!["https://relay.example.com".into()],
            api_key_encrypted: String::new(),
            key_prefix: "sk-test".into(),
            protocol,
            claude_auth_key_style: ClaudeAuthKeyStyle::AnthropicAuthToken,
            notes: None,
            enabled: true,
            sort_order: 0,
            selected_model_id: Some("glm-5.3".into()),
            last_model_fetch_at: None,
            last_model_fetch_latency_ms: None,
            last_model_fetch_error: None,
            created_at: 0,
            updated_at: 0,
            capabilities: Default::default(),
        }
    }

    fn read_doc(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn apply_writes_pi_schema_and_preserves_unrelated_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("agent");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join(MODELS_FILE),
            serde_json::to_vec_pretty(&json!({
                "providers": {
                    "other": {
                        "baseUrl": "https://other.example/v1",
                        "api": "openai-completions",
                        "models": [{"id": "other-model"}]
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            home.join(AUTH_FILE),
            serde_json::to_vec_pretty(&json!({
                "other": {"type": "api_key", "key": "other-secret"}
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            home.join(SETTINGS_FILE),
            serde_json::to_vec_pretty(&json!({
                "theme": "light",
                "enabledModels": ["other/*"]
            }))
            .unwrap(),
        )
        .unwrap();

        let options = PiApplyOptions {
            reasoning_levels: vec!["low".into(), "high".into(), "max".into()],
            reasoning_level: Some("high".into()),
            ..Default::default()
        };
        let outcome = apply(
            &site(SiteProtocol::OpenaiCompatible),
            "sk-secret",
            "glm-5.3",
            &options,
            Some(home.to_str().unwrap()),
            &dir.path().join("backups"),
        )
        .unwrap();

        let models = read_doc(&home.join(MODELS_FILE));
        assert!(models["providers"]["other"].is_object());
        let provider = &models["providers"]["xiaobai-site-123"];
        assert_eq!(provider["api"], json!("openai-completions"));
        let model = &provider["models"][0];
        assert_eq!(model["id"], json!("glm-5.3"));
        assert_eq!(model["reasoning"], json!(true));
        assert_eq!(model["thinkingLevelMap"]["off"], Value::Null);
        assert_eq!(model["thinkingLevelMap"]["high"], json!("high"));
        assert_eq!(model["cost"]["cacheWrite"], json!(0));
        assert_eq!(model["contextWindow"], json!(128_000));
        assert_eq!(model["maxTokens"], json!(16_384));

        let auth = read_doc(&home.join(AUTH_FILE));
        assert_eq!(auth["other"]["key"], json!("other-secret"));
        assert_eq!(auth["xiaobai-site-123"]["type"], json!("api_key"));
        assert_eq!(auth["xiaobai-site-123"]["key"], json!("sk-secret"));

        let settings = read_doc(&home.join(SETTINGS_FILE));
        assert_eq!(settings["theme"], json!("light"));
        assert_eq!(settings["enabledModels"], json!(["other/*"]));
        assert_eq!(settings["defaultProvider"], json!("xiaobai-site-123"));
        assert_eq!(settings["defaultModel"], json!("glm-5.3"));
        assert_eq!(settings["defaultThinkingLevel"], json!("high"));

        assert_eq!(
            outcome.live_summary.get("reasoning_levels"),
            Some(&Some("low,high,max".into()))
        );
        let (status, reason) = detect_status(
            Some(&outcome.binding),
            Some(&site(SiteProtocol::OpenaiCompatible)),
            Some("sk-secret"),
            Some(home.to_str().unwrap()),
        )
        .unwrap();
        assert_eq!((status, reason), (ApplyStatus::Applied, None));
    }

    #[test]
    fn write_all_keeps_default_and_filters_off_for_always_thinking_models() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("agent");
        let options = PiApplyOptions {
            write_all_models: true,
            catalog_models: vec![CatalogModel {
                model_id: "gpt-4.1".into(),
                display_name: "GPT 4.1".into(),
                context: Some(1_000_000),
                output: Some(32_768),
                vision: true,
            }],
            reasoning_levels: vec!["off".into(), "high".into()],
            reasoning_level: Some("off".into()),
        };
        apply(
            &site(SiteProtocol::OpenaiNative),
            "sk-secret",
            "ox-alpha-free",
            &options,
            Some(home.to_str().unwrap()),
            &dir.path().join("backups"),
        )
        .unwrap();

        let models = read_doc(&home.join(MODELS_FILE));
        let list = models["providers"]["xiaobai-site-123"]["models"]
            .as_array()
            .unwrap();
        assert_eq!(list.len(), 2);
        let strict = list
            .iter()
            .find(|model| model["id"] == json!("ox-alpha-free"))
            .unwrap();
        assert_eq!(strict["thinkingLevelMap"]["off"], Value::Null);
        assert_eq!(strict["thinkingLevelMap"]["high"], json!("high"));
        let settings = read_doc(&home.join(SETTINGS_FILE));
        assert_ne!(settings["defaultThinkingLevel"], json!("off"));
    }

    #[test]
    fn detects_changed_or_invalid_stored_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("agent");
        let outcome = apply(
            &site(SiteProtocol::Anthropic),
            "sk-secret",
            "claude-sonnet-4",
            &PiApplyOptions::default(),
            Some(home.to_str().unwrap()),
            &dir.path().join("backups"),
        )
        .unwrap();
        let mut auth = read_json_object(&home.join(AUTH_FILE)).unwrap();
        auth.insert(
            "xiaobai-site-123".into(),
            json!({"type": "api_key", "key": "changed"}),
        );
        write_json_object(&home.join(AUTH_FILE), &auth, true).unwrap();
        let (status, reason) = detect_status(
            Some(&outcome.binding),
            Some(&site(SiteProtocol::Anthropic)),
            Some("sk-secret"),
            Some(home.to_str().unwrap()),
        )
        .unwrap();
        assert_eq!(status, ApplyStatus::Stale);
        assert_eq!(reason.as_deref(), Some("auth key changed"));
    }

    #[test]
    fn auth_only_managed_trace_is_reported_as_orphan() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("agent");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join(AUTH_FILE),
            serde_json::to_vec(&json!({
                "xiaobai-old": {"type": "api_key", "key": "old"}
            }))
            .unwrap(),
        )
        .unwrap();
        let (status, reason) =
            detect_status(None, None, None, Some(home.to_str().unwrap())).unwrap();
        assert_eq!(status, ApplyStatus::Orphan);
        assert_eq!(reason.as_deref(), Some("untracked xiaobai provider"));
    }

    #[test]
    fn surgical_revert_removes_only_the_bound_provider_and_its_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("agent");
        let outcome = apply(
            &site(SiteProtocol::OpenaiCompatible),
            "sk-secret",
            "gpt-5.2",
            &PiApplyOptions::default(),
            Some(home.to_str().unwrap()),
            &dir.path().join("backups"),
        )
        .unwrap();
        let mut settings = read_json_object(&home.join(SETTINGS_FILE)).unwrap();
        settings.insert("theme".into(), json!("dark"));
        write_json_object(&home.join(SETTINGS_FILE), &settings, false).unwrap();

        surgical_revert(&outcome.binding, Some(home.to_str().unwrap())).unwrap();
        let models = read_doc(&home.join(MODELS_FILE));
        assert!(models.get("providers").is_none());
        let auth = read_doc(&home.join(AUTH_FILE));
        assert!(auth.get("xiaobai-site-123").is_none());
        let settings = read_doc(&home.join(SETTINGS_FILE));
        assert_eq!(settings["theme"], json!("dark"));
        assert!(settings.get("defaultProvider").is_none());
        assert!(settings.get("defaultModel").is_none());
        assert!(settings.get("defaultThinkingLevel").is_none());
    }

    #[test]
    fn restore_official_removes_all_managed_providers_and_keeps_other_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("agent");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join(MODELS_FILE),
            serde_json::to_vec(&json!({
                "providers": {
                    "xiaobai-a": {"baseUrl":"https://a/v1","api":"openai-completions","models":[{"id":"a"}]},
                    "other": {"baseUrl":"https://b/v1","api":"openai-completions","models":[{"id":"b"}]}
                }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            home.join(AUTH_FILE),
            serde_json::to_vec(&json!({
                "xiaobai-a":{"type":"api_key","key":"managed"},
                "other":{"type":"api_key","key":"other"}
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            home.join(SETTINGS_FILE),
            serde_json::to_vec(&json!({
                "defaultProvider":"other",
                "defaultModel":"xiaobai-looking-model",
                "defaultThinkingLevel":"high",
                "theme":"light"
            }))
            .unwrap(),
        )
        .unwrap();

        restore_official(Some(home.to_str().unwrap()), &dir.path().join("backups")).unwrap();
        let models = read_doc(&home.join(MODELS_FILE));
        assert!(models["providers"].get("xiaobai-a").is_none());
        assert!(models["providers"]["other"].is_object());
        let auth = read_doc(&home.join(AUTH_FILE));
        assert!(auth.get("xiaobai-a").is_none());
        assert_eq!(auth["other"]["key"], json!("other"));
        let settings = read_doc(&home.join(SETTINGS_FILE));
        assert_eq!(settings["defaultProvider"], json!("other"));
        assert_eq!(settings["defaultModel"], json!("xiaobai-looking-model"));
        assert_eq!(settings["defaultThinkingLevel"], json!("high"));
    }

    #[test]
    fn rewrite_base_url_updates_only_the_bound_provider() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("agent");
        let outcome = apply(
            &site(SiteProtocol::OpenaiCompatible),
            "sk-secret",
            "gpt-5.2",
            &PiApplyOptions::default(),
            Some(home.to_str().unwrap()),
            &dir.path().join("backups-apply"),
        )
        .unwrap();
        let mut changed_site = site(SiteProtocol::OpenaiCompatible);
        changed_site.base_url = "https://new-relay.example.com".into();
        let rewrite = rewrite_base_url(
            &changed_site,
            &outcome.binding,
            Some(home.to_str().unwrap()),
            &dir.path().join("backups-rewrite"),
        )
        .unwrap();
        assert!(rewrite
            .live_summary
            .get("base_url")
            .and_then(|value| value.as_deref())
            .is_some_and(|url| url.contains("new-relay.example.com")));
    }

    #[test]
    fn rewrite_base_url_rejects_a_missing_bound_provider() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("agent");
        let outcome = apply(
            &site(SiteProtocol::OpenaiCompatible),
            "sk-secret",
            "gpt-5.2",
            &PiApplyOptions::default(),
            Some(home.to_str().unwrap()),
            &dir.path().join("backups-apply"),
        )
        .unwrap();

        let models_path = home.join(MODELS_FILE);
        let mut models = read_doc(&models_path);
        models["providers"]
            .as_object_mut()
            .unwrap()
            .remove(outcome.binding.provider_id.as_deref().unwrap());
        fs::write(&models_path, serde_json::to_vec_pretty(&models).unwrap()).unwrap();

        let mut changed_site = site(SiteProtocol::OpenaiCompatible);
        changed_site.base_url = "https://new-relay.example.com".into();
        let error = rewrite_base_url(
            &changed_site,
            &outcome.binding,
            Some(home.to_str().unwrap()),
            &dir.path().join("backups-rewrite"),
        )
        .unwrap_err();
        assert!(error.to_string().contains("bound Pi provider missing"));
    }
}
