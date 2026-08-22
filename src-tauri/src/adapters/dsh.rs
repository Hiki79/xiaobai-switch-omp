//! dsh (DeepSeek Harness) adapter.
//!
//! dsh keeps custom LLM providers in `$DSH_HOME/settings.yaml` under the
//! `llm-pi-ai.providers` namespace and secrets in `$DSH_HOME/.credentials.yaml`
//! (a versioned document whose `refs` section maps credential references —
//! plain env-style names — to values). Settings only carry the reference
//! (`apiKeyEnv`), so an apply writes the key into `.credentials.yaml` and
//! points the provider at it. The default model selection lives in the
//! `agent-default-model` section. Sections are edited in place so the rest of
//! dsh's plugin settings survive an apply.

use crate::adapters::atomic::{atomic_write, backup_file, restore_file};
use crate::crypto::{key_fingerprint, key_prefix};
use crate::domain::{
    env_key_for_site, ApplyStatus, CatalogModel, DshApplyOptions, SiteProtocol, SiteRow,
    TargetBinding, TargetKind, TouchedKeys,
};
use crate::error::{AppError, AppResult};
use crate::paths::resolve_dsh_home;
use chrono::Utc;
use serde_yaml::{Mapping, Value as Yaml};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub struct DshApplyOutcome {
    pub binding: TargetBinding,
    pub touched: TouchedKeys,
    pub backup_paths: Vec<String>,
    pub live_summary: HashMap<String, Option<String>>,
    pub message: String,
}

const PROVIDER_PREFIX: &str = "xiaobai-";
const SETTINGS_FILE: &str = "settings.yaml";
const CREDENTIALS_FILE: &str = ".credentials.yaml";
const PI_AI_NAMESPACE: &str = "llm-pi-ai";
const DEFAULT_MODEL_NAMESPACE: &str = "agent-default-model";

/// Reasoning levels pi-ai accepts as `reasoningEfforts` keys.
pub const DSH_EFFORT_LEVELS: [&str; 7] =
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

pub fn settings_path(dsh_home_override: Option<&str>) -> AppResult<PathBuf> {
    Ok(resolve_dsh_home(dsh_home_override)?.join(SETTINGS_FILE))
}

pub fn credentials_path(dsh_home_override: Option<&str>) -> AppResult<PathBuf> {
    Ok(resolve_dsh_home(dsh_home_override)?.join(CREDENTIALS_FILE))
}

pub fn is_installed(dsh_home_override: Option<&str>) -> AppResult<bool> {
    let home = resolve_dsh_home(dsh_home_override)?;
    Ok(home.join(SETTINGS_FILE).exists()
        || home.join(CREDENTIALS_FILE).exists()
        || home.join("cordis.patch.yml").exists())
}

fn read_yaml(path: &Path) -> AppResult<Mapping> {
    if !path.exists() {
        return Ok(Mapping::new());
    }
    let text = fs::read_to_string(path)?;
    let v: Yaml = serde_yaml::from_str(&text).map_err(|e| {
        AppError::new(
            "invalid_config",
            format!("{} is not valid YAML: {e}", path.display()),
        )
    })?;
    match v {
        Yaml::Null => Ok(Mapping::new()),
        Yaml::Mapping(m) => Ok(m),
        Yaml::Tagged(t) => match t.value {
            Yaml::Mapping(m) => Ok(m),
            _ => Err(AppError::new(
                "invalid_config",
                format!("{} root must be a mapping", path.display()),
            )),
        },
        _ => Err(AppError::new(
            "invalid_config",
            format!("{} root must be a mapping", path.display()),
        )),
    }
}

fn write_yaml(path: &Path, root: &Mapping, secret: bool) -> AppResult<()> {
    let mut text = serde_yaml::to_string(root)?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    atomic_write(path, text.as_bytes(), secret)
}

fn s(v: &str) -> Yaml {
    Yaml::String(v.to_string())
}

fn get_str<'a>(m: &'a Mapping, key: &str) -> Option<&'a str> {
    m.get(&s(key)).and_then(Yaml::as_str)
}

fn get_mapping<'a>(m: &'a Mapping, key: &str) -> Option<&'a Mapping> {
    m.get(&s(key)).and_then(Yaml::as_mapping)
}

/// Get or create a nested mapping under `key`; errors when the slot holds a
/// non-mapping value (we never overwrite foreign data types).
fn ensure_mapping<'a>(parent: &'a mut Mapping, key: &str) -> AppResult<&'a mut Mapping> {
    if parent.contains_key(&s(key)) && !matches!(parent.get(&s(key)), Some(Yaml::Mapping(_))) {
        return Err(AppError::new(
            "invalid_config",
            format!("{key} must be a YAML mapping"),
        ));
    }
    if !parent.contains_key(&s(key)) {
        parent.insert(s(key), Yaml::Mapping(Mapping::new()));
    }
    match parent.get_mut(&s(key)) {
        Some(Yaml::Mapping(m)) => Ok(m),
        _ => Err(AppError::new(
            "invalid_config",
            format!("{key} must be a YAML mapping"),
        )),
    }
}

fn provider_id_for_site(site: &SiteRow) -> String {
    // Site ids are UUIDs in normal databases. Lowercase alphanumerics keep the
    // id valid for dsh's provider routes; replacing separators keeps it short.
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
    DSH_EFFORT_LEVELS
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

/// Family ladders restricted to pi-ai's level set; mirrors the zcode table so
/// every target offers the same levels for the same model family.
fn default_levels_for_model(model_id: &str) -> Vec<String> {
    if let Some(levels) = crate::reasoning_meta::always_thinking_levels(model_id) {
        return levels;
    }
    let id = model_id.to_ascii_lowercase();
    if id.contains("glm-5.3") || id.contains("glm5.3") {
        vec!["low", "max", "high"]
    } else if id.contains("glm-5.2") || id.contains("glm5.2") {
        // pi-ai has no nothink; the relay-safe rungs are high/max.
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
        // Safe common ladder for unknown families, restricted to pi-ai values.
        vec!["low", "medium", "high", "max"]
    }
    .into_iter()
    .map(String::from)
    .collect()
}

/// Reasoning ladder for one model: sanitized request → previous entry's
/// `reasoningEfforts` keys → family table.
fn normalize_levels(
    model_id: &str,
    requested: &[String],
    existing: Option<&Mapping>,
) -> Vec<String> {
    if let Some(levels) = crate::reasoning_meta::always_thinking_levels(model_id) {
        return levels;
    }
    let requested = sanitize_levels(requested);
    if !requested.is_empty() {
        return requested;
    }
    if let Some(levels) = existing
        .and_then(|entry| entry.get(&s("reasoningEfforts")))
        .and_then(Yaml::as_mapping)
    {
        let keys: Vec<String> = levels
            .keys()
            .filter_map(Yaml::as_str)
            .map(str::to_string)
            .collect();
        if !keys.is_empty() {
            return keys;
        }
    }
    default_levels_for_model(model_id)
}

/// Default reasoning level: requested when available, else previous default,
/// else the strongest rung.
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
    if let Some(value) = previous.filter(|v| levels.iter().any(|x| x == v)) {
        return Some(value);
    }
    levels
        .iter()
        .find(|v| v.eq_ignore_ascii_case("max"))
        .cloned()
        .or_else(|| levels.first().cloned())
}

fn model_entry(
    existing: Option<&Mapping>,
    model_id: &str,
    name: &str,
    context: Option<u64>,
    output: Option<u64>,
    vision: bool,
    levels: &[String],
) -> Yaml {
    let mut entry = existing.cloned().unwrap_or_default();
    entry.insert(s("id"), s(model_id));
    let name = name.trim();
    if !name.is_empty() && name != model_id {
        entry.insert(s("name"), s(name));
    }
    if let Some(context) = context.filter(|&v| v > 0) {
        entry.insert(s("contextWindow"), Yaml::Number(context.into()));
    }
    if let Some(output) = output.filter(|&v| v > 0) {
        entry.insert(s("maxTokens"), Yaml::Number(output.into()));
    }
    entry.insert(
        s("input"),
        Yaml::Sequence(if vision {
            vec![s("text"), s("image")]
        } else {
            vec![s("text")]
        }),
    );
    if !levels.is_empty() {
        let mut efforts = Mapping::new();
        for level in levels {
            // `off` is pi-ai's three-state key: an empty value disables
            // thinking explicitly; every other rung maps to itself.
            efforts.insert(s(level), if level == "off" { Yaml::Null } else { s(level) });
        }
        entry.insert(s("reasoningEfforts"), Yaml::Mapping(efforts));
    }
    Yaml::Mapping(entry)
}

fn provider_value<'a>(root: &'a Mapping, provider_id: &str) -> Option<&'a Mapping> {
    get_mapping(root, PI_AI_NAMESPACE)
        .and_then(|ns| get_mapping(ns, "providers"))
        .and_then(|providers| providers.get(&s(provider_id)).and_then(Yaml::as_mapping))
}

fn model_ids_from_sequence(seq: Option<&Yaml>) -> Vec<String> {
    seq.and_then(Yaml::as_sequence)
        .map(|list| {
            list.iter()
                .filter_map(|entry| {
                    entry
                        .as_mapping()
                        .and_then(|m| m.get(&s("id")))
                        .and_then(Yaml::as_str)
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn default_model_section<'a>(
    root: &'a Mapping,
) -> (Option<&'a str>, Option<&'a str>, Option<String>) {
    let Some(section) = get_mapping(root, DEFAULT_MODEL_NAMESPACE) else {
        return (None, None, None);
    };
    (
        get_str(section, "provider"),
        get_str(section, "model"),
        get_str(section, "reasoningEffort").map(str::to_string),
    )
}

fn credential_value(root: &Mapping, ref_name: &str) -> Option<String> {
    get_mapping(root, "refs")
        .and_then(|refs| refs.get(&s(ref_name)))
        .and_then(Yaml::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn summary_from_docs(settings: &Mapping, credentials: &Mapping) -> HashMap<String, Option<String>> {
    let mut out = HashMap::new();
    let (provider_id, model_id, reasoning_effort) = default_model_section(settings);
    let Some(provider_id) = provider_id else {
        return out;
    };
    out.insert("provider".into(), Some(provider_id.into()));
    let Some(provider) = provider_value(settings, provider_id) else {
        return out;
    };
    if let Some(name) = get_str(provider, "displayName") {
        out.insert("provider_name".into(), Some(name.into()));
    }
    if let Some(api) = get_str(provider, "api") {
        out.insert("api".into(), Some(api.into()));
    }
    if let Some(url) = get_str(provider, "baseURL") {
        out.insert("base_url".into(), Some(url.into()));
    }
    if let Some(ref_name) = get_str(provider, "apiKeyEnv") {
        out.insert("api_key_env".into(), Some(ref_name.into()));
        if let Some(value) = credential_value(credentials, ref_name) {
            out.insert("api_key".into(), Some(key_prefix(&value)));
        }
    }
    let ids = model_ids_from_sequence(provider.get(&s("models")));
    out.insert("models".into(), Some(ids.len().to_string()));
    if !ids.is_empty() {
        out.insert("model_ids".into(), Some(ids.join(",")));
    }
    if let Some(model_id) = model_id {
        out.insert("model".into(), Some(model_id.into()));
        if let Some(entry) = provider
            .get(&s("models"))
            .and_then(Yaml::as_sequence)
            .and_then(|list| {
                list.iter().find(|m| {
                    m.as_mapping()
                        .and_then(|mm| mm.get(&s("id")))
                        .and_then(Yaml::as_str)
                        == Some(model_id)
                })
            })
            .and_then(Yaml::as_mapping)
        {
            if let Some(efforts) = entry.get(&s("reasoningEfforts")).and_then(Yaml::as_mapping) {
                let levels: Vec<&str> = efforts.keys().filter_map(Yaml::as_str).collect();
                if !levels.is_empty() {
                    out.insert("reasoning_efforts".into(), Some(levels.join(",")));
                }
            }
            if let Some(context) = entry.get(&s("contextWindow")).and_then(Yaml::as_i64) {
                out.insert("model_context".into(), Some(context.to_string()));
            }
        }
    }
    if let Some(level) = reasoning_effort {
        out.insert("reasoning_effort".into(), Some(level));
    }
    out
}

pub fn live_summary(dsh_home_override: Option<&str>) -> AppResult<HashMap<String, Option<String>>> {
    let home = resolve_dsh_home(dsh_home_override)?;
    let settings_p = home.join(SETTINGS_FILE);
    if !settings_p.exists() {
        return Ok(HashMap::new());
    }
    let settings = read_yaml(&settings_p)?;
    let credentials = read_yaml(&home.join(CREDENTIALS_FILE))?;
    Ok(summary_from_docs(&settings, &credentials))
}

fn has_managed_trace(root: &Mapping) -> bool {
    get_mapping(root, PI_AI_NAMESPACE)
        .and_then(|ns| get_mapping(ns, "providers"))
        .map(|providers| {
            providers
                .keys()
                .filter_map(Yaml::as_str)
                .any(|id| id.starts_with(PROVIDER_PREFIX))
        })
        .unwrap_or(false)
}

fn remove_managed_provider_trace(root: &mut Mapping) -> Vec<String> {
    let mut removed = Vec::new();
    if let Some(ns) = root
        .get_mut(&s(PI_AI_NAMESPACE))
        .and_then(Yaml::as_mapping_mut)
    {
        if let Some(providers) = ns.get_mut(&s("providers")).and_then(Yaml::as_mapping_mut) {
            let managed: Vec<Yaml> = providers
                .keys()
                .filter(|k| k.as_str().unwrap_or_default().starts_with(PROVIDER_PREFIX))
                .cloned()
                .collect();
            for k in managed {
                providers.remove(&k);
                removed.push(k.as_str().unwrap_or_default().to_string());
            }
        }
        if ns
            .get(&s("providers"))
            .and_then(Yaml::as_mapping)
            .map(|p| p.is_empty())
            .unwrap_or(false)
        {
            ns.remove(&s("providers"));
        }
    }
    if root
        .get(&s(DEFAULT_MODEL_NAMESPACE))
        .and_then(Yaml::as_mapping)
        .and_then(|section| section.get(&s("provider")))
        .and_then(Yaml::as_str)
        .is_some_and(|p| p.starts_with(PROVIDER_PREFIX))
    {
        root.remove(&s(DEFAULT_MODEL_NAMESPACE));
    }
    removed
}

fn normalize_credentials(root: &mut Mapping) -> AppResult<&mut Mapping> {
    let legacy_flat = !root.contains_key(&s("version"))
        && !root.contains_key(&s("refs"))
        && !root.is_empty()
        && root.values().all(|value| value.as_str().is_some());
    if legacy_flat {
        let old = std::mem::take(root);
        root.insert(s("version"), Yaml::Number(1.into()));
        root.insert(s("refs"), Yaml::Mapping(old));
    } else {
        root.entry(s("version"))
            .or_insert_with(|| Yaml::Number(1.into()));
    }
    ensure_mapping(root, "refs")
}

fn model_mapping<'a>(provider: &'a Mapping, model_id: &str) -> Option<&'a Mapping> {
    provider
        .get(&s("models"))
        .and_then(Yaml::as_sequence)
        .and_then(|models| {
            models.iter().find_map(|model| {
                let mapping = model.as_mapping()?;
                (get_str(mapping, "id") == Some(model_id)).then_some(mapping)
            })
        })
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
    options: &DshApplyOptions,
    dsh_home_override: Option<&str>,
    backup_root: &PathBuf,
) -> AppResult<DshApplyOutcome> {
    let api_key = api_key.trim();
    let model_id = model_id.trim();
    if api_key.is_empty() {
        return Err(AppError::new("validation_failed", "api key required"));
    }
    if model_id.is_empty() {
        return Err(AppError::new("validation_failed", "model id required"));
    }

    let home = resolve_dsh_home(dsh_home_override)?;
    fs::create_dir_all(&home)?;
    let settings_p = home.join(SETTINGS_FILE);
    let credentials_p = home.join(CREDENTIALS_FILE);
    let preview = crate::url_normalize::normalize_base_url(&site.base_url)?;
    let base_url = base_url_for_protocol(&site.protocol, preview);
    let provider_id = provider_id_for_site(site);
    let credential_ref = env_key_for_site(&site.id);
    let api = api_for_protocol(&site.protocol);

    let mut touched = TouchedKeys::default();
    let mut backup_paths = Vec::new();
    let mut backups = Vec::new();
    let mut created = Vec::new();
    for path in [&settings_p, &credentials_p] {
        if path.exists() {
            let backup = backup_file(path, backup_root)?;
            backup_paths.push(backup.display().to_string());
            backups.push((backup, path.clone()));
            touched.paths.push(path.display().to_string());
        } else {
            created.push(path.clone());
            touched.created_paths.push(path.display().to_string());
        }
    }
    touched.env_keys.push(credential_ref.clone());

    let mut settings = read_yaml(&settings_p)?;
    let previous_provider = provider_value(&settings, &provider_id).cloned();
    let previous_default = default_model_section(&settings).2;
    let previous_model = previous_provider
        .as_ref()
        .and_then(|provider| model_mapping(provider, model_id));
    let levels = normalize_levels(model_id, &options.reasoning_levels, previous_model);
    let level = choose_level(
        &levels,
        options.reasoning_level.as_deref(),
        previous_default,
    );

    let mut requested_models = Vec::new();
    requested_models.push(
        options
            .catalog_models
            .iter()
            .find(|model| model.model_id.trim() == model_id)
            .cloned()
            .unwrap_or_else(|| CatalogModel {
                model_id: model_id.to_string(),
                display_name: model_id.to_string(),
                context: None,
                output: None,
                vision: false,
            }),
    );
    if options.write_all_models {
        for model in &options.catalog_models {
            if model.model_id.trim().is_empty()
                || requested_models
                    .iter()
                    .any(|item| item.model_id == model.model_id)
            {
                continue;
            }
            requested_models.push(model.clone());
        }
    }

    let mut models = Vec::new();
    for model in &requested_models {
        let existing = previous_provider
            .as_ref()
            .and_then(|provider| model_mapping(provider, &model.model_id));
        let model_levels = if model.model_id == model_id {
            levels.clone()
        } else {
            normalize_levels(&model.model_id, &[], existing)
        };
        models.push(model_entry(
            existing,
            &model.model_id,
            &model.display_name,
            model.context,
            model.output,
            model.vision,
            &model_levels,
        ));
    }

    {
        let namespace = ensure_mapping(&mut settings, PI_AI_NAMESPACE)?;
        let providers = ensure_mapping(namespace, "providers")?;
        let provider = providers
            .entry(s(&provider_id))
            .or_insert_with(|| Yaml::Mapping(Mapping::new()))
            .as_mapping_mut()
            .ok_or_else(|| AppError::new("invalid_config", "dsh provider must be a mapping"))?;
        provider
            .entry(s("displayName"))
            .or_insert_with(|| s(&site.name));
        provider.insert(s("apiKeyEnv"), s(&credential_ref));
        provider.insert(s("api"), s(api));
        provider.insert(s("baseURL"), s(&base_url));
        provider.insert(s("models"), Yaml::Sequence(models));

        let default = ensure_mapping(&mut settings, DEFAULT_MODEL_NAMESPACE)?;
        default.insert(s("provider"), s(&provider_id));
        default.insert(s("model"), s(model_id));
        if let Some(level) = &level {
            default.insert(s("reasoningEffort"), s(level));
        } else {
            default.remove(&s("reasoningEffort"));
        }
    }

    let mut credentials = read_yaml(&credentials_p)?;
    normalize_credentials(&mut credentials)?.insert(s(&credential_ref), s(api_key));

    if let Err(error) = write_yaml(&settings_p, &settings, false)
        .and_then(|_| write_yaml(&credentials_p, &credentials, true))
    {
        rollback_files(&backups, &created);
        return Err(error);
    }

    let (verify_settings, verify_credentials) =
        match (read_yaml(&settings_p), read_yaml(&credentials_p)) {
            (Ok(settings), Ok(credentials)) => (settings, credentials),
            (Err(error), _) | (_, Err(error)) => {
                rollback_files(&backups, &created);
                return Err(error);
            }
        };
    let summary = summary_from_docs(&verify_settings, &verify_credentials);
    let expected_level = level.clone().unwrap_or_default();
    let valid = provider_value(&verify_settings, &provider_id).is_some_and(|provider| {
        get_str(provider, "apiKeyEnv") == Some(credential_ref.as_str())
            && get_str(provider, "api") == Some(api)
            && get_str(provider, "baseURL") == Some(base_url.as_str())
            && model_mapping(provider, model_id).is_some()
    }) && credential_value(&verify_credentials, &credential_ref).as_deref()
        == Some(api_key)
        && default_model_section(&verify_settings)
            == (Some(provider_id.as_str()), Some(model_id), level.clone());
    if !valid {
        rollback_files(&backups, &created);
        return Err(AppError::new("invalid_config", "dsh self-check failed"));
    }

    let mut expected_fields = HashMap::new();
    expected_fields.insert("provider_id".into(), provider_id.clone());
    expected_fields.insert("base_url".into(), base_url);
    expected_fields.insert("api".into(), api.into());
    expected_fields.insert("api_key_env".into(), credential_ref.clone());
    expected_fields.insert("model".into(), model_id.into());
    expected_fields.insert("default_provider".into(), provider_id.clone());
    expected_fields.insert("reasoning_effort".into(), expected_level);
    expected_fields.insert("reasoning_efforts".into(), levels.join(","));

    let binding = TargetBinding {
        target: TargetKind::Dsh,
        site_id: Some(site.id.clone()),
        site_name_snapshot: site.name.clone(),
        model_id: model_id.into(),
        provider_id: Some(provider_id),
        key_fingerprint: key_fingerprint(api_key),
        managed_paths: vec![
            settings_p.display().to_string(),
            credentials_p.display().to_string(),
        ],
        managed_env_keys: vec![credential_ref],
        expected_fields,
        orphan: false,
        applied_at: Utc::now().timestamp_millis(),
        apply_record_id: Some(Uuid::new_v4().to_string()),
    };

    Ok(DshApplyOutcome {
        binding,
        touched,
        backup_paths,
        live_summary: summary,
        message: "dsh settings updated; changes apply on the next request.".into(),
    })
}

pub fn surgical_revert(binding: &TargetBinding, dsh_home_override: Option<&str>) -> AppResult<()> {
    let home = resolve_dsh_home(dsh_home_override)?;
    let settings_p = home.join(SETTINGS_FILE);
    let credentials_p = home.join(CREDENTIALS_FILE);
    let provider_id = binding.provider_id.as_deref().unwrap_or_default();

    if settings_p.exists() {
        let mut settings = read_yaml(&settings_p)?;
        if let Some(providers) = settings
            .get_mut(&s(PI_AI_NAMESPACE))
            .and_then(Yaml::as_mapping_mut)
            .and_then(|namespace| namespace.get_mut(&s("providers")))
            .and_then(Yaml::as_mapping_mut)
        {
            providers.remove(&s(provider_id));
        }
        if default_model_section(&settings).0 == Some(provider_id) {
            settings.remove(&s(DEFAULT_MODEL_NAMESPACE));
        }
        write_yaml(&settings_p, &settings, false)?;
    }
    if credentials_p.exists() {
        let mut credentials = read_yaml(&credentials_p)?;
        if let Some(refs) = credentials
            .get_mut(&s("refs"))
            .and_then(Yaml::as_mapping_mut)
        {
            for name in &binding.managed_env_keys {
                refs.remove(&s(name));
            }
        }
        write_yaml(&credentials_p, &credentials, true)?;
    }
    Ok(())
}

pub fn restore_official(
    dsh_home_override: Option<&str>,
    backup_root: &PathBuf,
) -> AppResult<crate::adapters::RestoreOfficialOutcome> {
    let home = resolve_dsh_home(dsh_home_override)?;
    let settings_p = home.join(SETTINGS_FILE);
    let credentials_p = home.join(CREDENTIALS_FILE);
    let mut backup_paths = Vec::new();
    let mut backups = Vec::new();

    if settings_p.exists() {
        let backup = backup_file(&settings_p, backup_root)?;
        backup_paths.push(backup.display().to_string());
        backups.push((backup, settings_p.clone()));
    }
    if credentials_p.exists() {
        let backup = backup_file(&credentials_p, backup_root)?;
        backup_paths.push(backup.display().to_string());
        backups.push((backup, credentials_p.clone()));
    }

    let result = (|| -> AppResult<Vec<String>> {
        if settings_p.exists() {
            let mut settings = read_yaml(&settings_p)?;
            remove_managed_provider_trace(&mut settings);
            write_yaml(&settings_p, &settings, false)?;
        }
        let mut removed_refs = Vec::new();
        if credentials_p.exists() {
            let mut credentials = read_yaml(&credentials_p)?;
            if let Some(refs) = credentials
                .get_mut(&s("refs"))
                .and_then(Yaml::as_mapping_mut)
            {
                let keys: Vec<Yaml> = refs
                    .keys()
                    .filter(|key| {
                        key.as_str()
                            .is_some_and(|name| name.starts_with("XIAOBAI_"))
                    })
                    .cloned()
                    .collect();
                for key in keys {
                    if let Some(name) = key.as_str() {
                        removed_refs.push(name.to_string());
                    }
                    refs.remove(&key);
                }
            }
            write_yaml(&credentials_p, &credentials, true)?;
        }
        Ok(removed_refs)
    })();

    match result {
        Ok(env_keys) => Ok(crate::adapters::RestoreOfficialOutcome {
            backup_paths,
            env_keys,
        }),
        Err(error) => {
            rollback_files(&backups, &[]);
            Err(error)
        }
    }
}

pub fn detect_status(
    binding: Option<&TargetBinding>,
    _site: Option<&SiteRow>,
    api_key: Option<&str>,
    dsh_home_override: Option<&str>,
) -> AppResult<(ApplyStatus, Option<String>)> {
    let home = resolve_dsh_home(dsh_home_override)?;
    let settings_p = home.join(SETTINGS_FILE);
    let credentials_p = home.join(CREDENTIALS_FILE);
    let settings = settings_p
        .exists()
        .then(|| read_yaml(&settings_p))
        .transpose()?;
    let credentials = credentials_p
        .exists()
        .then(|| read_yaml(&credentials_p))
        .transpose()?;

    let Some(binding) = binding else {
        return if settings.as_ref().is_some_and(has_managed_trace) {
            Ok((
                ApplyStatus::Orphan,
                Some("untracked managed providers".into()),
            ))
        } else {
            Ok((ApplyStatus::NotApplied, None))
        };
    };
    if binding.orphan || binding.site_id.is_none() {
        return Ok((ApplyStatus::Orphan, Some("site deleted".into())));
    }
    let Some(settings) = settings.as_ref() else {
        return Ok((ApplyStatus::Stale, Some("settings missing".into())));
    };
    let Some(credentials) = credentials.as_ref() else {
        return Ok((ApplyStatus::Stale, Some("credentials missing".into())));
    };
    let provider_id = binding.provider_id.as_deref().unwrap_or_default();
    let Some(provider) = provider_value(settings, provider_id) else {
        return Ok((ApplyStatus::Stale, Some("provider missing".into())));
    };
    for (field, yaml_key) in [
        ("base_url", "baseURL"),
        ("api", "api"),
        ("api_key_env", "apiKeyEnv"),
    ] {
        if let Some(expected) = binding.expected_fields.get(field) {
            if get_str(provider, yaml_key) != Some(expected.as_str()) {
                return Ok((ApplyStatus::Stale, Some(format!("{field} mismatch"))));
            }
        }
    }
    if model_mapping(provider, &binding.model_id).is_none() {
        return Ok((ApplyStatus::Stale, Some("model missing".into())));
    }
    if let Some(expected) = binding.expected_fields.get("reasoning_efforts") {
        let actual = model_mapping(provider, &binding.model_id)
            .and_then(|model| model.get(&s("reasoningEfforts")))
            .and_then(Yaml::as_mapping)
            .map(|efforts| {
                efforts
                    .keys()
                    .filter_map(Yaml::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        if actual != *expected {
            return Ok((ApplyStatus::Stale, Some("reasoning levels changed".into())));
        }
    }
    let (default_provider, default_model, default_effort) = default_model_section(settings);
    if default_provider != Some(provider_id) || default_model != Some(binding.model_id.as_str()) {
        return Ok((ApplyStatus::Stale, Some("default model changed".into())));
    }
    let expected_effort = binding
        .expected_fields
        .get("reasoning_effort")
        .filter(|value| !value.is_empty())
        .map(String::as_str);
    if default_effort.as_deref() != expected_effort {
        return Ok((ApplyStatus::Stale, Some("reasoning effort changed".into())));
    }
    let credential_ref = binding
        .expected_fields
        .get("api_key_env")
        .map(String::as_str)
        .unwrap_or_default();
    let Some(stored_key) = credential_value(credentials, credential_ref) else {
        return Ok((ApplyStatus::Stale, Some("credential missing".into())));
    };
    if key_fingerprint(&stored_key) != binding.key_fingerprint
        || api_key.is_some_and(|key| key_fingerprint(key) != binding.key_fingerprint)
    {
        return Ok((ApplyStatus::Stale, Some("API key changed".into())));
    }
    Ok((ApplyStatus::Applied, None))
}

pub fn rewrite_base_url(
    site: &SiteRow,
    binding: &TargetBinding,
    dsh_home_override: Option<&str>,
    backup_root: &PathBuf,
) -> AppResult<crate::adapters::RewriteOutcome> {
    let settings_p = settings_path(dsh_home_override)?;
    if !settings_p.exists() {
        return Err(AppError::new("invalid_config", "dsh settings.yaml missing"));
    }
    let preview = crate::url_normalize::normalize_base_url(&site.base_url)?;
    let base_url = base_url_for_protocol(&site.protocol, preview);
    let provider_id = binding.provider_id.as_deref().unwrap_or_default();
    let backup = backup_file(&settings_p, backup_root)?;
    let mut settings = read_yaml(&settings_p)?;
    let provider = settings
        .get_mut(&s(PI_AI_NAMESPACE))
        .and_then(Yaml::as_mapping_mut)
        .and_then(|namespace| namespace.get_mut(&s("providers")))
        .and_then(Yaml::as_mapping_mut)
        .and_then(|providers| providers.get_mut(&s(provider_id)))
        .and_then(Yaml::as_mapping_mut)
        .ok_or_else(|| AppError::new("not_found", "bound dsh provider missing"))?;
    provider.insert(s("baseURL"), s(&base_url));
    if let Err(error) = write_yaml(&settings_p, &settings, false) {
        let _ = restore_file(&backup, &settings_p);
        return Err(error);
    }
    if provider_value(&read_yaml(&settings_p)?, provider_id)
        .and_then(|provider| get_str(provider, "baseURL"))
        != Some(base_url.as_str())
    {
        let _ = restore_file(&backup, &settings_p);
        return Err(AppError::new(
            "invalid_config",
            "dsh baseURL self-check failed",
        ));
    }
    let mut expected_fields = binding.expected_fields.clone();
    expected_fields.insert("base_url".into(), base_url.clone());
    let mut live_summary = HashMap::new();
    live_summary.insert("base_url".into(), Some(base_url));
    Ok(crate::adapters::RewriteOutcome {
        backup_paths: vec![backup.display().to_string()],
        live_summary,
        expected_fields,
        message: "Updated dsh provider baseURL".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ClaudeAuthKeyStyle;

    fn site() -> SiteRow {
        SiteRow {
            id: "1dca7f75-35f3-422c-b1fc-531dd5bb7e65".into(),
            name: "Relay".into(),
            base_url: "https://relay.example.com".into(),
            base_urls: vec!["https://relay.example.com".into()],
            api_key_encrypted: String::new(),
            key_prefix: "sk-test".into(),
            protocol: SiteProtocol::OpenaiCompatible,
            claude_auth_key_style: ClaudeAuthKeyStyle::AnthropicAuthToken,
            notes: None,
            enabled: true,
            sort_order: 0,
            selected_model_id: Some("ox-alpha-free".into()),
            last_model_fetch_at: None,
            last_model_fetch_latency_ms: None,
            last_model_fetch_error: None,
            created_at: 0,
            updated_at: 0,
            capabilities: Default::default(),
        }
    }

    #[test]
    fn apply_writes_split_settings_and_credentials_and_rejects_ox_off() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("dsh");
        let options = DshApplyOptions {
            reasoning_levels: vec!["off".into(), "high".into(), "max".into()],
            reasoning_level: Some("off".into()),
            ..Default::default()
        };
        let outcome = apply(
            &site(),
            "sk-secret",
            "ox-alpha-free",
            &options,
            Some(home.to_str().unwrap()),
            &dir.path().join("backups"),
        )
        .unwrap();
        let settings = read_yaml(&home.join(SETTINGS_FILE)).unwrap();
        let credentials = read_yaml(&home.join(CREDENTIALS_FILE)).unwrap();
        let provider_id = outcome.binding.provider_id.as_deref().unwrap();
        let provider = provider_value(&settings, provider_id).unwrap();
        assert_eq!(
            get_str(provider, "apiKeyEnv"),
            Some("XIAOBAI_SITE_1DCA7F7535F3_API_KEY")
        );
        assert!(serde_yaml::to_string(&settings)
            .unwrap()
            .find("sk-secret")
            .is_none());
        assert_eq!(
            credential_value(&credentials, "XIAOBAI_SITE_1DCA7F7535F3_API_KEY").as_deref(),
            Some("sk-secret")
        );
        assert_eq!(default_model_section(&settings).2.as_deref(), Some("max"));
        let model = model_mapping(provider, "ox-alpha-free").unwrap();
        let efforts = model
            .get(&s("reasoningEfforts"))
            .unwrap()
            .as_mapping()
            .unwrap();
        assert_eq!(
            efforts.keys().filter_map(Yaml::as_str).collect::<Vec<_>>(),
            vec!["low", "high", "max"]
        );
        assert_eq!(efforts.get(&s("high")), Some(&s("high")));
        assert_eq!(
            detect_status(
                Some(&outcome.binding),
                Some(&site()),
                Some("sk-secret"),
                Some(home.to_str().unwrap())
            )
            .unwrap()
            .0,
            ApplyStatus::Applied
        );

        let mut drifted = settings;
        let model = drifted
            .get_mut(&s(PI_AI_NAMESPACE))
            .and_then(Yaml::as_mapping_mut)
            .and_then(|namespace| namespace.get_mut(&s("providers")))
            .and_then(Yaml::as_mapping_mut)
            .and_then(|providers| providers.get_mut(&s(provider_id)))
            .and_then(Yaml::as_mapping_mut)
            .and_then(|provider| provider.get_mut(&s("models")))
            .and_then(Yaml::as_sequence_mut)
            .and_then(|models| models.first_mut())
            .and_then(Yaml::as_mapping_mut)
            .unwrap();
        model.insert(
            s("reasoningEfforts"),
            Yaml::Mapping(Mapping::from_iter([(s("off"), Yaml::Null)])),
        );
        write_yaml(&home.join(SETTINGS_FILE), &drifted, false).unwrap();
        assert_eq!(
            detect_status(
                Some(&outcome.binding),
                Some(&site()),
                Some("sk-secret"),
                Some(home.to_str().unwrap())
            )
            .unwrap()
            .0,
            ApplyStatus::Stale
        );
    }

    #[test]
    fn restore_official_preserves_foreign_sections_and_records() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("dsh");
        let outcome = apply(
            &site(),
            "sk-secret",
            "ox-alpha-free",
            &DshApplyOptions::default(),
            Some(home.to_str().unwrap()),
            &dir.path().join("backups-apply"),
        )
        .unwrap();
        let mut credentials = read_yaml(&home.join(CREDENTIALS_FILE)).unwrap();
        credentials.insert(
            s("records"),
            Yaml::Mapping(Mapping::from_iter([(s("oauth"), s("keep"))])),
        );
        write_yaml(&home.join(CREDENTIALS_FILE), &credentials, true).unwrap();
        restore_official(Some(home.to_str().unwrap()), &dir.path().join("backups")).unwrap();
        let settings = read_yaml(&home.join(SETTINGS_FILE)).unwrap();
        let credentials = read_yaml(&home.join(CREDENTIALS_FILE)).unwrap();
        assert!(
            provider_value(&settings, outcome.binding.provider_id.as_deref().unwrap()).is_none()
        );
        assert_eq!(
            get_mapping(&credentials, "records").and_then(|m| get_str(m, "oauth")),
            Some("keep")
        );
    }
}
