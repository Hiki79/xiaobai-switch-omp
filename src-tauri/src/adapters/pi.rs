//! Pi coding agent adapter.
//!
//! Pi manages providers in `~/.pi/agent/models.json`, secrets in
//! `~/.pi/agent/auth.json`, and agent preferences (defaultModel, thinking) in
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

/// Reasoning levels Pi accepts in settings.json `thinking`.
pub const PI_EFFORT_LEVELS: [&str; 7] =
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

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
        vec!["low", "medium", "high", "max"]
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
        .map(str::trim)
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

fn map_catalog_model(cm: &CatalogModel) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), Value::String(cm.model_id.clone()));
    m.insert("name".into(), Value::String(cm.display_name.clone()));
    if let Some(ctx) = cm.context {
        m.insert("contextWindow".into(), json!(ctx));
    }
    if let Some(out) = cm.output {
        m.insert("maxTokens".into(), json!(out));
    }
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
        return vec![map_catalog_model(&single)];
    }

    let mut out: Vec<Value> = catalog.iter().map(map_catalog_model).collect();
    if !catalog.iter().any(|m| m.model_id == model_id) {
        let fallback = CatalogModel {
            model_id: model_id.to_string(),
            display_name: model_id.to_string(),
            context: None,
            output: None,
            vision: site_vision,
        };
        out.insert(0, map_catalog_model(&fallback));
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

    let site_vision = crate::capabilities::capability_on(
        &site.capabilities,
        crate::capabilities::CODEX_VISION,
    );
    let models_array = build_models_array(
        model_id,
        options.write_all_models,
        &options.catalog_models,
        site_vision,
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
            "apiKey": api_key,
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
    let selector = format!("{provider_id}/{model_id}");
    settings_root.insert("defaultModel".into(), Value::String(selector.clone()));

    let sanitized = sanitize_levels(&options.reasoning_levels);
    let reasoning_ladder = if !sanitized.is_empty() {
        sanitized
    } else {
        default_levels_for_model(model_id)
    };
    let prev_thinking = settings_root
        .get("thinking")
        .and_then(Value::as_str)
        .map(String::from);
    let selected_level = choose_level(
        &reasoning_ladder,
        options.reasoning_level.as_deref(),
        prev_thinking,
    );

    if let Some(level) = &selected_level {
        settings_root.insert("thinking".into(), Value::String(level.clone()));
    }

    if let Err(e) = write_json_object(&settings_p, &settings_root, false) {
        rollback_files(&backups, &created);
        return Err(e);
    }

    let mut touched = TouchedKeys::default();
    touched.managed_paths.push(models_p.display().to_string());
    touched.managed_paths.push(auth_p.display().to_string());
    touched.managed_paths.push(settings_p.display().to_string());

    let mut expected = HashMap::new();
    expected.insert("base_url".into(), base_url.clone());
    expected.insert("api".into(), api_protocol.into());
    expected.insert("model".into(), model_id.to_string());
    expected.insert("default_model".into(), selector.clone());
    if !reasoning_ladder.is_empty() {
        expected.insert("reasoning_levels".into(), reasoning_ladder.join(","));
    }
    if let Some(level) = &selected_level {
        expected.insert("thinking".into(), level.clone());
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

    let default_model = settings.get("defaultModel").and_then(Value::as_str);
    if let Some(dm) = default_model {
        out.insert("default_model".into(), Some(dm.to_string()));
        if let Some((prov, mid)) = dm.split_once('/') {
            out.insert("provider".into(), Some(prov.to_string()));
            out.insert("model".into(), Some(mid.to_string()));
        }
    }

    let thinking = settings.get("thinking").and_then(Value::as_str);
    if let Some(th) = thinking {
        out.insert("thinking".into(), Some(th.to_string()));
    }

    let prov_id = target_provider.or_else(|| {
        default_model.and_then(|dm| dm.split_once('/').map(|(p, _)| p))
    });

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
            }
        }

        if let Some(auth_entry) = auth.get(pid).and_then(Value::as_object) {
            if let Some(key) = auth_entry.get("apiKey").and_then(Value::as_str) {
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

    let models = read_json_object(&models_p).unwrap_or_default();
    let auth = read_json_object(&auth_p).unwrap_or_default();
    let settings = read_json_object(&settings_p).unwrap_or_default();

    Ok(summary_from_docs(&models, &auth, &settings, None))
}

fn has_managed_trace(models: &Map<String, Value>) -> bool {
    models
        .get("providers")
        .and_then(Value::as_object)
        .map(|providers| {
            providers
                .keys()
                .any(|id| id.starts_with(PROVIDER_PREFIX))
        })
        .unwrap_or(false)
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

    let models = read_json_object(&models_p).unwrap_or_default();
    let auth = read_json_object(&auth_p).unwrap_or_default();
    let settings = read_json_object(&settings_p).unwrap_or_default();

    let has_trace = has_managed_trace(&models);

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
            return Ok((ApplyStatus::Stale, Some("provider missing in models.json".into())));
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
                "default_model" => {
                    if settings.get("defaultModel").and_then(Value::as_str)
                        != Some(expected.as_str())
                    {
                        return Ok((ApplyStatus::Stale, Some("defaultModel changed".into())));
                    }
                }
                "thinking" => {
                    if settings.get("thinking").and_then(Value::as_str)
                        != Some(expected.as_str())
                    {
                        return Ok((ApplyStatus::Stale, Some("thinking changed".into())));
                    }
                }
                _ => {}
            }
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

pub fn surgical_revert(
    binding: &TargetBinding,
    pi_home_override: Option<&str>,
) -> AppResult<()> {
    let home = resolve_pi_home(pi_home_override)?;
    let models_p = home.join(MODELS_FILE);
    let auth_p = home.join(AUTH_FILE);
    let settings_p = home.join(SETTINGS_FILE);

    let pid = binding.provider_id.clone().unwrap_or_default();

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
        if let Some(dm) = settings.get("defaultModel").and_then(Value::as_str) {
            if dm.starts_with(&pid) {
                settings.remove("defaultModel");
                settings.remove("thinking");
            }
        }
        write_json_object(&settings_p, &settings, false)?;
    }

    Ok(())
}

pub fn restore_official(
    pi_home_override: Option<&str>,
    backup_root: &PathBuf,
) -> AppResult<()> {
    let home = resolve_pi_home(pi_home_override)?;
    let models_p = home.join(MODELS_FILE);
    let auth_p = home.join(AUTH_FILE);
    let settings_p = home.join(SETTINGS_FILE);

    for path in [&models_p, &auth_p, &settings_p] {
        if path.exists() {
            let _ = backup_file(path, backup_root);
        }
    }

    if models_p.exists() {
        let mut models = read_json_object(&models_p)?;
        if let Some(providers) = models.get_mut("providers").and_then(Value::as_object_mut) {
            let managed: Vec<String> = providers
                .keys()
                .filter(|k| k.starts_with(PROVIDER_PREFIX))
                .cloned()
                .collect();
            for k in managed {
                providers.remove(&k);
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
            .filter(|k| k.starts_with(PROVIDER_PREFIX))
            .cloned()
            .collect();
        for k in managed {
            auth.remove(&k);
        }
        write_json_object(&auth_p, &auth, true)?;
    }

    if settings_p.exists() {
        let mut settings = read_json_object(&settings_p)?;
        if let Some(dm) = settings.get("defaultModel").and_then(Value::as_str) {
            if dm.starts_with(PROVIDER_PREFIX) {
                settings.remove("defaultModel");
                settings.remove("thinking");
            }
        }
        write_json_object(&settings_p, &settings, false)?;
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
    if let Some(providers) = models.get_mut("providers").and_then(Value::as_object_mut) {
        if let Some(prov) = providers.get_mut(&provider_id).and_then(Value::as_object_mut) {
            prov.insert("baseUrl".into(), Value::String(base_url.clone()));
        }
    }
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
