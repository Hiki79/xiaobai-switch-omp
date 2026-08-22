//! ZCode v2 provider adapter.
//!
//! ZCode keeps custom providers in `~/.zcode/v2/config.json`.  The provider
//! object is deliberately edited in place so the rest of ZCode's model
//! catalog survives an apply.  Reasoning variants are model-defined strings,
//! therefore they are stored alongside the selected model rather than mapped
//! to a fixed application enum.

use crate::adapters::atomic::{atomic_write, backup_file, restore_file};
use crate::capabilities::{capability_on, CODEX_VISION};
use crate::crypto::{key_fingerprint, key_prefix};
use crate::domain::{
    ApplyStatus, CatalogModel, SiteProtocol, SiteRow, TargetBinding, TargetKind, TouchedKeys,
    ZcodeApplyOptions,
};
use crate::error::{AppError, AppResult};
use crate::paths::resolve_zcode_home;
use chrono::Utc;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

const PROVIDER_PREFIX: &str = "xiaobai-";
const CONFIG_FILE: &str = "config.json";

pub struct ZcodeApplyOutcome {
    pub binding: TargetBinding,
    pub touched: TouchedKeys,
    pub backup_paths: Vec<String>,
    pub live_summary: HashMap<String, Option<String>>,
    pub message: String,
}

pub fn config_path(zcode_home_override: Option<&str>) -> AppResult<PathBuf> {
    Ok(resolve_zcode_home(zcode_home_override)?.join(CONFIG_FILE))
}

pub fn is_installed(zcode_home_override: Option<&str>) -> AppResult<bool> {
    let home = resolve_zcode_home(zcode_home_override)?;
    Ok(home.join(CONFIG_FILE).exists() || home.join("setting.json").exists())
}

fn read_config(path: &PathBuf) -> AppResult<Value> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let text = fs::read_to_string(path)?;
    let value: Value = serde_json::from_str(&text)?;
    if !value.is_object() {
        return Err(AppError::new(
            "invalid_config",
            "ZCode config.json is not a JSON object",
        ));
    }
    Ok(value)
}

fn root_object_mut(value: &mut Value) -> AppResult<&mut Map<String, Value>> {
    value
        .as_object_mut()
        .ok_or_else(|| AppError::new("invalid_config", "ZCode config root must be an object"))
}

fn string_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn provider_id_for_site(site: &SiteRow) -> String {
    // Site ids are UUIDs in normal databases. Replacing separators also keeps
    // the key pleasant to read in ZCode's model selector and safe for shells.
    let suffix: String = site
        .id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    format!("{PROVIDER_PREFIX}{suffix}")
}

fn strict_levels_for_model(model_id: &str) -> Option<Vec<String>> {
    crate::reasoning_meta::always_thinking_levels(model_id)
}

fn default_levels_for_model(model_id: &str) -> Vec<String> {
    if let Some(strict) = strict_levels_for_model(model_id) {
        return strict;
    }
    let id = model_id.to_ascii_lowercase();
    if id.contains("glm-5.3") || id.contains("glm5.3") {
        vec!["low", "max", "high"]
            .into_iter()
            .map(String::from)
            .collect()
    } else if id.contains("glm-5.2") || id.contains("glm5.2") {
        vec!["nothink", "high", "max"]
            .into_iter()
            .map(String::from)
            .collect()
    } else if id.contains("gpt") || id.contains("o1") || id.contains("o3") {
        vec!["low", "medium", "high", "xhigh"]
            .into_iter()
            .map(String::from)
            .collect()
    } else if id.contains("claude") || id.contains("opus") || id.contains("sonnet") {
        vec!["low", "medium", "high", "xhigh"]
            .into_iter()
            .map(String::from)
            .collect()
    } else if id.contains("kimi") {
        vec!["low", "high", "max"]
            .into_iter()
            .map(String::from)
            .collect()
    } else if id.contains("deepseek") {
        vec!["off", "high", "max"]
            .into_iter()
            .map(String::from)
            .collect()
    } else if id.contains("gemini") {
        vec!["minimal", "low", "medium", "high"]
            .into_iter()
            .map(String::from)
            .collect()
    } else {
        // GLM-style relays reject "medium" on many models; the safe common
        // ladder for unknown families is low/high/max.
        vec!["low", "high", "max"]
            .into_iter()
            .map(String::from)
            .collect()
    }
}

/// Write `limit` / `modalities` metadata on a model entry. Resolved values
/// (manual override → relay raw → family table) win; without any source the
/// existing limit survives so ZCode's own default (or a user edit) stands.
fn write_model_meta(
    model_obj: &mut Map<String, Value>,
    existing: Option<&Value>,
    resolved_context: Option<u64>,
    resolved_output: Option<u64>,
    vision: bool,
) {
    let existing_limit = existing
        .and_then(|v| v.get("limit"))
        .and_then(Value::as_object);
    let context = resolved_context.or_else(|| {
        existing_limit
            .and_then(|l| l.get("context"))
            .and_then(Value::as_u64)
    });
    let output = resolved_output.or_else(|| {
        existing_limit
            .and_then(|l| l.get("output"))
            .and_then(Value::as_u64)
    });
    if let Some(context) = context {
        let mut limit = Map::new();
        limit.insert("context".into(), json!(context));
        if let Some(output) = output {
            limit.insert("output".into(), json!(output));
        }
        model_obj.insert("limit".into(), Value::Object(limit));
    }
    let mut input = vec!["text"];
    if vision {
        input.push("image");
    }
    model_obj.insert(
        "modalities".into(),
        json!({ "input": input, "output": ["text"] }),
    );
}

/// Metadata for the default model, preferring its catalog row (relay raw
/// already resolved there) and falling back to the family table + site vision.
fn default_model_meta(
    options: &ZcodeApplyOptions,
    site: &SiteRow,
    model_id: &str,
) -> (Option<u64>, Option<u64>, bool) {
    let site_vision = capability_on(&site.capabilities, CODEX_VISION);
    if let Some(entry) = options
        .catalog_models
        .iter()
        .find(|m| m.model_id.trim() == model_id)
    {
        return (
            options.context_override.or(entry.context),
            entry.output,
            site_vision || entry.vision,
        );
    }
    let (context, output) = crate::model_meta::resolve_limits(model_id, None)
        .map(|(c, o)| (Some(c), o))
        .unwrap_or((None, None));
    (options.context_override.or(context), output, site_vision)
}

fn normalize_levels(model_id: &str, requested: &[String], existing: Option<&Value>) -> Vec<String> {
    if let Some(strict) = strict_levels_for_model(model_id) {
        return strict;
    }
    let mut out = Vec::new();
    fn push_level(out: &mut Vec<String>, raw: &str) {
        let value = raw.trim();
        if !value.is_empty() && value.len() <= 64 && !out.iter().any(|v| v == value) {
            out.push(value.to_string());
        }
    }
    for value in requested {
        push_level(&mut out, value);
    }
    if out.is_empty() {
        if let Some(values) = existing
            .and_then(|v| v.get("reasoning"))
            .and_then(|v| v.get("variants"))
            .and_then(Value::as_array)
        {
            for value in values.iter().filter_map(Value::as_str) {
                push_level(&mut out, value);
            }
        }
    }
    if out.is_empty() {
        out = default_levels_for_model(model_id);
    }
    out
}

fn existing_default(existing: Option<&Value>) -> Option<String> {
    existing
        .and_then(|v| v.get("reasoning"))
        .and_then(|v| v.get("defaultVariant"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn choose_level(levels: &[String], requested: Option<&str>, previous: Option<String>) -> String {
    if let Some(value) = requested
        .map(str::trim)
        .filter(|v| levels.iter().any(|x| x == v))
    {
        return value.to_string();
    }
    if let Some(value) = previous.filter(|v| levels.iter().any(|x| x == v)) {
        return value;
    }
    levels
        .iter()
        .find(|v| v.eq_ignore_ascii_case("max"))
        .cloned()
        .unwrap_or_else(|| levels[0].clone())
}

fn base_url(site: &SiteRow) -> AppResult<(String, &'static str, Option<&'static str>)> {
    let preview = crate::url_normalize::normalize_base_url(&site.base_url)?;
    match site.protocol {
        SiteProtocol::Anthropic => Ok((
            preview.claude_base_url,
            "anthropic",
            Some("anthropic-messages"),
        )),
        SiteProtocol::OpenaiNative => Ok((preview.codex_base_url, "openai", None)),
        SiteProtocol::OpenaiCompatible => Ok((
            preview.codex_base_url,
            "openai-compatible",
            Some("openai-chat-completions"),
        )),
    }
}

fn provider_value<'a>(root: &'a Value, provider_id: &str) -> Option<&'a Value> {
    root.get("provider")?.as_object()?.get(provider_id)
}

fn model_value<'a>(provider: &'a Value, model_id: &str) -> Option<&'a Value> {
    provider.get("models")?.as_object()?.get(model_id)
}

fn provider_string<'a>(provider: &'a Value, key: &str) -> Option<&'a str> {
    provider
        .get("options")
        .and_then(|v| v.get(key))
        .and_then(Value::as_str)
}

fn live_for_provider(root: &Value, provider_id: &str) -> HashMap<String, Option<String>> {
    let mut out = HashMap::new();
    let Some(provider) = provider_value(root, provider_id) else {
        return out;
    };
    out.insert("provider".into(), Some(provider_id.into()));
    if let Some(name) = string_at(provider, "name") {
        out.insert("provider_name".into(), Some(name.into()));
    }
    if let Some(kind) = string_at(provider, "kind") {
        out.insert("kind".into(), Some(kind.into()));
    }
    if let Some(url) = provider_string(provider, "baseURL") {
        out.insert("base_url".into(), Some(url.into()));
    }
    if let Some(key) = provider_string(provider, "apiKey") {
        out.insert("api_key".into(), Some(key_prefix(key)));
    }
    if let Some(models) = provider.get("models").and_then(Value::as_object) {
        out.insert("models".into(), Some(models.len().to_string()));
        let ids: Vec<&str> = models.keys().map(String::as_str).collect();
        if !ids.is_empty() {
            out.insert("model_ids".into(), Some(ids.join(",")));
        }
    }
    add_reasoning_models_summary(&mut out, provider);
    if let Some(model_ref) = root.get("model").and_then(Value::as_str) {
        out.insert("model".into(), Some(model_ref.into()));
    }
    if let Some(model_ref) = root.get("model").and_then(Value::as_str) {
        if let Some((pid, mid)) = model_ref.split_once('/') {
            if pid == provider_id {
                if let Some(model) = model_value(provider, mid) {
                    if let Some(context) = model
                        .get("limit")
                        .and_then(|l| l.get("context"))
                        .and_then(Value::as_u64)
                    {
                        out.insert("model_context".into(), Some(context.to_string()));
                    }
                    add_reasoning_summary(&mut out, model);
                }
            }
        }
    }
    out
}

fn reasoning_models_object(provider: &Value) -> Map<String, Value> {
    let Some(models) = provider.get("models").and_then(Value::as_object) else {
        return Map::new();
    };
    let mut summary = Map::new();
    for (model_id, model) in models {
        let Some(reasoning) = model.get("reasoning") else {
            continue;
        };
        let Some(variants) = reasoning.get("variants").and_then(Value::as_array) else {
            continue;
        };
        if variants.is_empty() {
            continue;
        }
        summary.insert(
            model_id.clone(),
            json!({
                "variants": variants,
                "defaultVariant": reasoning.get("defaultVariant").and_then(Value::as_str),
            }),
        );
    }
    summary
}

fn add_reasoning_models_summary(out: &mut HashMap<String, Option<String>>, provider: &Value) {
    let summary = reasoning_models_object(provider);
    if !summary.is_empty() {
        out.insert(
            "reasoning_variants_by_model".into(),
            Some(Value::Object(summary).to_string()),
        );
    }
}

fn add_reasoning_summary(out: &mut HashMap<String, Option<String>>, model: &Value) {
    if let Some(reasoning) = model.get("reasoning") {
        if let Some(variants) = reasoning.get("variants").and_then(Value::as_array) {
            let values: Vec<&str> = variants.iter().filter_map(Value::as_str).collect();
            if !values.is_empty() {
                out.insert("reasoning_variants".into(), Some(values.join(",")));
            }
        }
        if let Some(default) = reasoning.get("defaultVariant").and_then(Value::as_str) {
            out.insert("reasoning_default".into(), Some(default.into()));
        }
    }
}

pub fn apply(
    site: &SiteRow,
    api_key: &str,
    model_id: &str,
    options: &ZcodeApplyOptions,
    zcode_home_override: Option<&str>,
    backup_root: &PathBuf,
) -> AppResult<ZcodeApplyOutcome> {
    let path = config_path(zcode_home_override)?;
    let existed = path.exists();
    let mut touched = TouchedKeys::default();
    let mut backup_paths = Vec::new();
    if existed {
        let bak = backup_file(&path, backup_root)?;
        touched.paths.push(path.display().to_string());
        backup_paths.push(bak.display().to_string());
    } else {
        touched.created_paths.push(path.display().to_string());
    }

    let mut root = read_config(&path)?;
    let provider_id = provider_id_for_site(site);
    let previous_model = provider_value(&root, &provider_id)
        .and_then(|provider| model_value(provider, model_id))
        .cloned();
    let levels = normalize_levels(model_id, &options.reasoning_levels, previous_model.as_ref());
    let level = choose_level(
        &levels,
        options.reasoning_level.as_deref(),
        existing_default(previous_model.as_ref()),
    );
    let (base_url, kind, api_format) = base_url(site)?;

    let root_obj = root_object_mut(&mut root)?;
    let providers = root_obj
        .entry("provider")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| AppError::new("invalid_config", "ZCode provider must be an object"))?;
    let provider = providers
        .entry(provider_id.clone())
        .or_insert_with(|| json!({}));
    let provider_obj = provider
        .as_object_mut()
        .ok_or_else(|| AppError::new("invalid_config", "ZCode provider entry must be an object"))?;
    provider_obj.insert("name".into(), Value::String(site.name.clone()));
    provider_obj.insert("source".into(), Value::String("custom".into()));
    provider_obj.insert("kind".into(), Value::String(kind.into()));
    provider_obj.insert("defaultKind".into(), Value::String(kind.into()));
    if let Some(api_format) = api_format {
        provider_obj.insert("apiFormat".into(), Value::String(api_format.into()));
    }
    provider_obj.insert("enabled".into(), Value::Bool(true));
    let options_obj = provider_obj
        .entry("options")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| {
            AppError::new("invalid_config", "ZCode provider options must be an object")
        })?;
    options_obj.insert("baseURL".into(), Value::String(base_url.clone()));
    options_obj.insert("apiKey".into(), Value::String(api_key.into()));
    options_obj.insert("apiKeyRequired".into(), Value::Bool(true));

    let models = provider_obj
        .entry("models")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| {
            AppError::new("invalid_config", "ZCode provider models must be an object")
        })?;
    // Mirror omp semantics: the managed provider only keeps what this apply
    // asked for, so pruning follows both the toggle and the checked catalog.
    let catalog_ids: Vec<&str> = options
        .catalog_models
        .iter()
        .map(|m| m.model_id.trim())
        .filter(|id| !id.is_empty())
        .collect();
    models.retain(|id, _| {
        id == model_id || (options.write_all_models && catalog_ids.contains(&id.as_str()))
    });
    let model = models
        .entry(model_id.to_string())
        .or_insert_with(|| json!({}));
    let model_obj = model
        .as_object_mut()
        .ok_or_else(|| AppError::new("invalid_config", "ZCode model entry must be an object"))?;
    model_obj
        .entry("name")
        .or_insert_with(|| Value::String(model_id.into()));
    model_obj.insert(
        "reasoning".into(),
        json!({
            "enabled": true,
            "variants": levels,
            "defaultVariant": level,
        }),
    );
    let (meta_context, meta_output, meta_vision) = default_model_meta(options, site, model_id);
    write_model_meta(
        model_obj,
        previous_model.as_ref(),
        meta_context,
        meta_output,
        meta_vision,
    );
    let zcode = model_obj
        .entry("zcode")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| AppError::new("invalid_config", "ZCode model metadata must be an object"))?;
    zcode.insert("modified".into(), Value::Bool(true));

    // Extra catalog models: variants follow each model's family (or whatever
    // ZCode already has configured for it); the form's ladder only governs the
    // default model above.
    for entry in &options.catalog_models {
        let CatalogModel {
            model_id: extra_id,
            display_name: extra_name,
            context: extra_context,
            output: extra_output,
            vision: extra_vision,
        } = entry;
        let extra_id = extra_id.trim();
        if extra_id.is_empty() || extra_id == model_id {
            continue;
        }
        let previous = models.get(extra_id).cloned();
        let extra_levels = normalize_levels(extra_id, &[], previous.as_ref());
        let extra_level = choose_level(&extra_levels, None, existing_default(previous.as_ref()));
        let entry = models
            .entry(extra_id.to_string())
            .or_insert_with(|| json!({}));
        let entry_obj = entry.as_object_mut().ok_or_else(|| {
            AppError::new("invalid_config", "ZCode model entry must be an object")
        })?;
        let fallback_name = if extra_name.trim().is_empty() || extra_name.trim() == extra_id {
            extra_id
        } else {
            extra_name.trim()
        };
        entry_obj
            .entry("name")
            .or_insert_with(|| Value::String(fallback_name.into()));
        entry_obj.insert(
            "reasoning".into(),
            json!({
                "enabled": true,
                "variants": extra_levels,
                "defaultVariant": extra_level,
            }),
        );
        write_model_meta(
            entry_obj,
            previous.as_ref(),
            options.context_override.or(*extra_context),
            *extra_output,
            *extra_vision,
        );
        let entry_zcode = entry_obj
            .entry("zcode")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| {
                AppError::new("invalid_config", "ZCode model metadata must be an object")
            })?;
        entry_zcode.insert("modified".into(), Value::Bool(true));
    }

    let model_ref = format!("{provider_id}/{model_id}");
    root_obj.insert("model".into(), Value::String(model_ref.clone()));

    let pretty = serde_json::to_string_pretty(&root)? + "\n";
    if let Err(e) = atomic_write(&path, pretty.as_bytes(), true) {
        if existed {
            if let Some(bak) = backup_paths.first() {
                let _ = restore_file(&PathBuf::from(bak), &path);
            }
        } else {
            let _ = fs::remove_file(&path);
        }
        return Err(e);
    }

    let verify = read_config(&path)?;
    let verify_provider = provider_value(&verify, &provider_id)
        .ok_or_else(|| AppError::new("invalid_config", "ZCode provider self-check failed"))?;
    if provider_string(verify_provider, "apiKey") != Some(api_key)
        || provider_string(verify_provider, "baseURL") != Some(base_url.as_str())
        || verify.get("model").and_then(Value::as_str) != Some(model_ref.as_str())
    {
        return Err(AppError::new(
            "invalid_config",
            "ZCode config self-check failed",
        ));
    }

    let mut expected_fields = HashMap::new();
    expected_fields.insert("provider_id".into(), provider_id.clone());
    expected_fields.insert("model_ref".into(), model_ref);
    expected_fields.insert("base_url".into(), base_url);
    expected_fields.insert("reasoning_default".into(), level.clone());
    expected_fields.insert("reasoning_variants".into(), levels.join(","));

    let mut live_summary = live_for_provider(&verify, &provider_id);
    live_summary.insert("reasoning_default".into(), Some(level));
    live_summary.insert(
        "reasoning_variants".into(),
        expected_fields.get("reasoning_variants").cloned(),
    );

    let binding = TargetBinding {
        target: TargetKind::Zcode,
        site_id: Some(site.id.clone()),
        site_name_snapshot: site.name.clone(),
        model_id: model_id.into(),
        provider_id: Some(provider_id),
        key_fingerprint: key_fingerprint(api_key),
        managed_paths: vec![path.display().to_string()],
        managed_env_keys: vec![],
        expected_fields,
        orphan: false,
        applied_at: Utc::now().timestamp_millis(),
        apply_record_id: Some(Uuid::new_v4().to_string()),
    };

    Ok(ZcodeApplyOutcome {
        binding,
        touched,
        backup_paths,
        live_summary,
        message:
            "ZCode config.json updated. Restart ZCode for the provider/model change to take effect."
                .into(),
    })
}

pub fn surgical_revert(
    binding: &TargetBinding,
    zcode_home_override: Option<&str>,
) -> AppResult<()> {
    let path = config_path(zcode_home_override)?;
    if !path.exists() {
        return Ok(());
    }
    let mut root = read_config(&path)?;
    let provider_id = binding.provider_id.as_deref().unwrap_or_default();
    if let Some(providers) = root.get_mut("provider").and_then(Value::as_object_mut) {
        providers.remove(provider_id);
        if providers.is_empty() {
            root.as_object_mut().map(|obj| obj.remove("provider"));
        }
    }
    if root.get("model").and_then(Value::as_str)
        == binding.expected_fields.get("model_ref").map(String::as_str)
    {
        root.as_object_mut().map(|obj| obj.remove("model"));
    }
    let pretty = serde_json::to_string_pretty(&root)? + "\n";
    atomic_write(&path, pretty.as_bytes(), true)?;
    Ok(())
}

pub fn restore_official(
    zcode_home_override: Option<&str>,
    backup_root: &PathBuf,
) -> AppResult<crate::adapters::RestoreOfficialOutcome> {
    let path = config_path(zcode_home_override)?;
    if !path.exists() {
        return Ok(crate::adapters::RestoreOfficialOutcome {
            backup_paths: vec![],
            env_keys: vec![],
        });
    }
    let bak = backup_file(&path, backup_root)?;
    let mut root = read_config(&path)?;
    if let Some(providers) = root.get_mut("provider").and_then(Value::as_object_mut) {
        providers.retain(|id, _| !id.starts_with(PROVIDER_PREFIX));
        if providers.is_empty() {
            root.as_object_mut().map(|obj| obj.remove("provider"));
        }
    }
    if root
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|m| m.starts_with(PROVIDER_PREFIX))
    {
        root.as_object_mut().map(|obj| obj.remove("model"));
    }
    let pretty = serde_json::to_string_pretty(&root)? + "\n";
    if let Err(e) = atomic_write(&path, pretty.as_bytes(), true) {
        let _ = restore_file(&bak, &path);
        return Err(e);
    }
    Ok(crate::adapters::RestoreOfficialOutcome {
        backup_paths: vec![bak.display().to_string()],
        env_keys: vec![],
    })
}

pub fn live_summary(
    zcode_home_override: Option<&str>,
) -> AppResult<HashMap<String, Option<String>>> {
    let path = config_path(zcode_home_override)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let root = read_config(&path)?;
    let provider_id = root
        .get("model")
        .and_then(Value::as_str)
        .and_then(|m| m.split_once('/').map(|(p, _)| p.to_string()))
        .or_else(|| {
            root.get("provider")
                .and_then(Value::as_object)
                .and_then(|p| {
                    p.keys()
                        .find(|id| id.starts_with(PROVIDER_PREFIX))
                        .cloned()
                        .or_else(|| p.keys().next().cloned())
                })
        });
    let mut summary = provider_id
        .as_deref()
        .map(|id| live_for_provider(&root, id))
        .unwrap_or_default();
    if let Some(providers) = root.get("provider").and_then(Value::as_object) {
        let mut models = Map::new();
        for provider in providers.values() {
            for (model_id, value) in reasoning_models_object(provider) {
                models.entry(model_id).or_insert(value);
            }
        }
        if !models.is_empty() {
            summary.insert(
                "reasoning_variants_by_model".into(),
                Some(Value::Object(models).to_string()),
            );
        }
    }
    Ok(summary)
}

fn has_managed_trace(root: &Value) -> bool {
    root.get("provider")
        .and_then(Value::as_object)
        .map(|providers| providers.keys().any(|id| id.starts_with(PROVIDER_PREFIX)))
        .unwrap_or(false)
}

pub fn detect_status(
    binding: Option<&TargetBinding>,
    site: Option<&SiteRow>,
    api_key: Option<&str>,
    zcode_home_override: Option<&str>,
) -> AppResult<(ApplyStatus, Option<String>)> {
    let path = config_path(zcode_home_override)?;
    let live = if path.exists() {
        read_config(&path).ok()
    } else {
        None
    };
    if let Some(binding) = binding {
        if binding.orphan || binding.site_id.is_none() {
            return Ok((ApplyStatus::Orphan, Some("site deleted".into())));
        }
        let Some(root) = live.as_ref() else {
            return Ok((ApplyStatus::Stale, Some("config missing".into())));
        };
        if let Some(key) = api_key {
            if key_fingerprint(key) != binding.key_fingerprint {
                return Ok((ApplyStatus::Stale, Some("API key changed".into())));
            }
        }
        let provider_id = binding.provider_id.as_deref().unwrap_or_default();
        let Some(provider) = provider_value(root, provider_id) else {
            return Ok((ApplyStatus::Stale, Some("provider missing".into())));
        };
        if let Some(expected) = binding.expected_fields.get("base_url") {
            if provider_string(provider, "baseURL") != Some(expected.as_str()) {
                return Ok((ApplyStatus::Stale, Some("base_url mismatch".into())));
            }
        }
        for key in ["model_ref"] {
            if let Some(expected) = binding.expected_fields.get(key) {
                if root.get("model").and_then(Value::as_str) != Some(expected.as_str()) {
                    return Ok((ApplyStatus::Stale, Some(format!("{key} mismatch"))));
                }
            }
        }
        let Some(model) = model_value(provider, &binding.model_id) else {
            return Ok((ApplyStatus::Stale, Some("model missing".into())));
        };
        let mut summary = HashMap::new();
        add_reasoning_summary(&mut summary, model);
        for key in ["reasoning_default", "reasoning_variants"] {
            if let Some(expected) = binding.expected_fields.get(key) {
                let actual = summary.get(key).and_then(|v| v.as_deref());
                if actual != Some(expected.as_str()) {
                    return Ok((ApplyStatus::Stale, Some(format!("{key} mismatch"))));
                }
            }
        }
        return Ok((ApplyStatus::Applied, None));
    }
    if live.as_ref().is_some_and(has_managed_trace) {
        return Ok((
            ApplyStatus::Orphan,
            Some("untracked managed providers".into()),
        ));
    }
    Ok((ApplyStatus::NotApplied, None))
}

pub fn rewrite_base_url(
    site: &SiteRow,
    binding: &TargetBinding,
    zcode_home_override: Option<&str>,
    backup_root: &PathBuf,
) -> AppResult<crate::adapters::RewriteOutcome> {
    let path = config_path(zcode_home_override)?;
    if !path.exists() {
        return Err(AppError::new("invalid_config", "ZCode config.json missing"));
    }
    let (base_url, _, _) = base_url(site)?;
    let bak = backup_file(&path, backup_root)?;
    let mut root = read_config(&path)?;
    let provider_id = binding.provider_id.as_deref().unwrap_or_default();
    let provider = root
        .get_mut("provider")
        .and_then(Value::as_object_mut)
        .and_then(|providers| providers.get_mut(provider_id))
        .ok_or_else(|| AppError::new("not_found", "bound ZCode provider missing"))?;
    let options = provider
        .get_mut("options")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| AppError::new("invalid_config", "ZCode provider options missing"))?;
    options.insert("baseURL".into(), Value::String(base_url.clone()));
    let pretty = serde_json::to_string_pretty(&root)? + "\n";
    if let Err(e) = atomic_write(&path, pretty.as_bytes(), true) {
        let _ = restore_file(&bak, &path);
        return Err(e);
    }
    let verify = read_config(&path)?;
    let live = provider_value(&verify, provider_id).and_then(|v| provider_string(v, "baseURL"));
    if live != Some(base_url.as_str()) {
        let _ = restore_file(&bak, &path);
        return Err(AppError::new("invalid_config", "self-check baseURL failed"));
    }
    let mut expected = binding.expected_fields.clone();
    expected.insert("base_url".into(), base_url.clone());
    let mut live_summary = HashMap::new();
    live_summary.insert("base_url".into(), Some(base_url));
    Ok(crate::adapters::RewriteOutcome {
        backup_paths: vec![bak.display().to_string()],
        live_summary,
        expected_fields: expected,
        message: "Updated ZCode provider baseURL".into(),
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

    #[test]
    fn apply_writes_provider_model_and_reasoning() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("v2");
        let opts = ZcodeApplyOptions {
            reasoning_levels: vec!["low".into(), "high".into(), "max".into()],
            reasoning_level: Some("high".into()),
            ..Default::default()
        };
        let out = apply(
            &site(SiteProtocol::OpenaiCompatible),
            "sk-secret",
            "glm-5.3",
            &opts,
            Some(home.to_str().unwrap()),
            &dir.path().join("backups"),
        )
        .unwrap();
        let root = read_config(&config_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        assert_eq!(
            root.get("model").and_then(Value::as_str),
            Some("xiaobai-site-123/glm-5.3")
        );
        let provider = provider_value(&root, "xiaobai-site-123").unwrap();
        assert_eq!(provider_string(provider, "apiKey"), Some("sk-secret"));
        assert_eq!(
            live_for_provider(&root, "xiaobai-site-123").get("reasoning_default"),
            Some(&Some("high".into()))
        );
        let (status, _) = detect_status(
            Some(&out.binding),
            Some(&site(SiteProtocol::OpenaiCompatible)),
            Some("sk-secret"),
            Some(home.to_str().unwrap()),
        )
        .unwrap();
        assert_eq!(status, ApplyStatus::Applied);
    }

    #[test]
    fn apply_openai_native_writes_openai_kind_without_api_format() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("v2");
        apply(
            &site(SiteProtocol::OpenaiNative),
            "sk-secret",
            "gpt-5.2",
            &ZcodeApplyOptions::default(),
            Some(home.to_str().unwrap()),
            &dir.path().join("backups"),
        )
        .unwrap();
        let root = read_config(&config_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        let provider = provider_value(&root, "xiaobai-site-123").unwrap();
        assert_eq!(string_at(provider, "kind"), Some("openai"));
        assert!(provider.get("apiFormat").is_none());
        assert!(provider
            .get("options")
            .and_then(|o| o.get("baseURL"))
            .and_then(Value::as_str)
            .is_some_and(|u| u.ends_with("/v1")));
    }

    #[test]
    fn apply_write_all_writes_catalog_models_and_prunes_on_reapply() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("v2");
        let opts = ZcodeApplyOptions {
            write_all_models: true,
            catalog_models: vec![
                CatalogModel {
                    model_id: "deepseek-chat".into(),
                    display_name: "DeepSeek Chat".into(),
                    context: Some(131_072),
                    output: Some(8_192),
                    vision: false,
                },
                CatalogModel {
                    model_id: "gpt-4.1".into(),
                    display_name: String::new(),
                    // As apply_site would resolve it via the family table.
                    context: Some(1_000_000),
                    output: Some(32_768),
                    vision: true,
                },
            ],
            context_override: None,
            reasoning_levels: vec!["low".into(), "high".into()],
            reasoning_level: Some("high".into()),
        };
        apply(
            &site(SiteProtocol::OpenaiCompatible),
            "sk-secret",
            "glm-5.3",
            &opts,
            Some(home.to_str().unwrap()),
            &dir.path().join("backups"),
        )
        .unwrap();
        let root = read_config(&config_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        let provider = provider_value(&root, "xiaobai-site-123").unwrap();
        let models = provider.get("models").unwrap().as_object().unwrap();
        assert_eq!(models.len(), 3);
        // Family-derived ladder for the extra models; form ladder only for the default.
        let deepseek = models.get("deepseek-chat").unwrap();
        let variants: Vec<&str> = deepseek
            .get("reasoning")
            .unwrap()
            .get("variants")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(variants, vec!["off", "high", "max"]);
        assert_eq!(
            deepseek.get("name").and_then(Value::as_str),
            Some("DeepSeek Chat")
        );
        // Relay-resolved metadata lands as limit/modalities.
        assert_eq!(deepseek.get("limit").unwrap()["context"], json!(131_072));
        assert_eq!(deepseek.get("limit").unwrap()["output"], json!(8_192));
        assert_eq!(
            deepseek.get("modalities").unwrap()["input"],
            json!(["text"])
        );
        // Vision flag adds the image modality on top of the resolved limits.
        let gpt = models.get("gpt-4.1").unwrap();
        assert_eq!(gpt.get("limit").unwrap()["context"], json!(1_000_000));
        assert_eq!(
            gpt.get("modalities").unwrap()["input"],
            json!(["text", "image"])
        );
        let summary = live_for_provider(&root, "xiaobai-site-123");
        assert_eq!(summary.get("models"), Some(&Some("3".into())));
        assert_eq!(
            summary.get("model_ids"),
            Some(&Some("deepseek-chat,glm-5.3,gpt-4.1".into()))
        );

        // Re-apply with the toggle off: extras are pruned, only the default stays.
        apply(
            &site(SiteProtocol::OpenaiCompatible),
            "sk-secret",
            "glm-5.3",
            &ZcodeApplyOptions::default(),
            Some(home.to_str().unwrap()),
            &dir.path().join("backups"),
        )
        .unwrap();
        let root = read_config(&config_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        let models = provider_value(&root, "xiaobai-site-123")
            .unwrap()
            .get("models")
            .unwrap()
            .as_object()
            .unwrap();
        assert_eq!(models.len(), 1);
        assert!(models.contains_key("glm-5.3"));
    }

    #[test]
    fn apply_writes_model_meta_with_override_and_family_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("v2");
        let opts = ZcodeApplyOptions {
            context_override: Some(500_000),
            ..Default::default()
        };
        apply(
            &site(SiteProtocol::OpenaiCompatible),
            "sk-secret",
            "glm-5.3",
            &opts,
            Some(home.to_str().unwrap()),
            &dir.path().join("backups"),
        )
        .unwrap();
        let root = read_config(&config_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        let model = provider_value(&root, "xiaobai-site-123")
            .unwrap()
            .get("models")
            .unwrap()
            .get("glm-5.3")
            .unwrap();
        // Manual override beats the family table (glm would be 1M/128K).
        assert_eq!(model["limit"]["context"], json!(500_000));
        assert_eq!(model["limit"]["output"], json!(128_000));
        assert_eq!(model["modalities"]["input"], json!(["text"]));
        let summary = live_for_provider(&root, "xiaobai-site-123");
        assert_eq!(summary.get("model_context"), Some(&Some("500000".into())));
    }

    #[test]
    fn unknown_models_fall_back_to_low_high_max_ladder() {
        assert_eq!(
            default_levels_for_model("ox-alpha-free"),
            vec!["low", "high", "max"]
        );
    }

    #[test]
    fn ox_alpha_replaces_stale_or_requested_off_with_safe_levels() {
        let existing = json!({
            "reasoning": {
                "enabled": true,
                "variants": ["off", "high", "max"],
                "defaultVariant": "off"
            }
        });
        let levels = normalize_levels(
            "ox-alpha-free",
            &["off".into(), "high".into(), "max".into()],
            Some(&existing),
        );

        assert_eq!(levels, vec!["low", "high", "max"]);
        assert_eq!(
            choose_level(&levels, Some("off"), existing_default(Some(&existing)),),
            "max"
        );
    }

    #[test]
    fn revert_removes_only_managed_provider() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("v2");
        let out = apply(
            &site(SiteProtocol::Anthropic),
            "sk-secret",
            "glm-5.3",
            &ZcodeApplyOptions::default(),
            Some(home.to_str().unwrap()),
            &dir.path().join("backups"),
        )
        .unwrap();
        surgical_revert(&out.binding, Some(home.to_str().unwrap())).unwrap();
        let root = read_config(&config_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        assert!(provider_value(&root, "xiaobai-site-123").is_none());
        assert!(root.get("model").is_none());
    }
}
