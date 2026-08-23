use crate::adapters::atomic::{atomic_write, backup_file, restore_file};
use crate::crypto::{key_fingerprint, key_prefix};
use crate::domain::{
    provider_id_for_site, ApplyStatus, OmpApplyOptions, SiteProtocol, SiteRow, TargetBinding,
    TargetKind, TouchedKeys,
};
use crate::error::{AppError, AppResult};
use crate::paths::resolve_omp_home;
use chrono::Utc;
use serde_yaml::{Mapping, Value as Yaml};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub struct OmpApplyOutcome {
    pub binding: TargetBinding,
    pub touched: TouchedKeys,
    pub backup_paths: Vec<String>,
    pub live_summary: HashMap<String, Option<String>>,
    pub message: String,
}

const MODELS_STEM: &str = "models";
const CONFIG_STEM: &str = "config";
/// Provider ids owned by this app; also the orphan trace marker in models.yml.
pub const MANAGED_PROVIDER_PREFIX: &str = "xiaobai_";

/// omp reads `models.yml` then falls back to `models.yaml` (same for config).
/// Prefer an existing file so we never shadow a user's `.yaml` with a new `.yml`.
fn resolve_yaml_pair(dir: &Path, stem: &str) -> PathBuf {
    let yml = dir.join(format!("{stem}.yml"));
    if yml.exists() {
        return yml;
    }
    let yaml = dir.join(format!("{stem}.yaml"));
    if yaml.exists() {
        return yaml;
    }
    yml
}

pub fn models_path(omp_home_override: Option<&str>) -> AppResult<PathBuf> {
    Ok(resolve_yaml_pair(
        &resolve_omp_home(omp_home_override)?,
        MODELS_STEM,
    ))
}

pub fn config_path(omp_home_override: Option<&str>) -> AppResult<PathBuf> {
    Ok(resolve_yaml_pair(
        &resolve_omp_home(omp_home_override)?,
        CONFIG_STEM,
    ))
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

fn s(v: &str) -> Yaml {
    Yaml::String(v.to_string())
}

fn get_str<'a>(m: &'a Mapping, key: &str) -> Option<&'a str> {
    m.get(&s(key)).and_then(Yaml::as_str)
}

fn get_mapping<'a>(m: &'a Mapping, key: &str) -> Option<&'a Mapping> {
    m.get(&s(key)).and_then(Yaml::as_mapping)
}

fn get_mapping_mut<'a>(m: &'a mut Mapping, key: &str) -> Option<&'a mut Mapping> {
    m.get_mut(&s(key)).and_then(Yaml::as_mapping_mut)
}

/// Get or create a nested mapping under `key`; error when the slot holds a
/// non-mapping value (we never overwrite foreign data types).
fn ensure_mapping<'a>(parent: &'a mut Mapping, key: &str) -> AppResult<&'a mut Mapping> {
    if !matches!(parent.get(&s(key)), Some(Yaml::Mapping(_))) {
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

fn api_for_protocol(protocol: &SiteProtocol) -> &'static str {
    match protocol {
        SiteProtocol::OpenaiCompatible => "openai-completions",
        SiteProtocol::OpenaiNative => "openai-responses",
        SiteProtocol::Anthropic => "anthropic-messages",
    }
}

fn model_entry(id: &str, name: &str) -> Yaml {
    let mut m = Mapping::new();
    let id = id.trim();
    m.insert(s("id"), s(id));
    let name = name.trim();
    // omp falls back to the id when name is absent; only store real aliases.
    if !name.is_empty() && name != id {
        m.insert(s("name"), s(name));
    }
    Yaml::Mapping(m)
}

/// Effort levels omp understands on the `:level` role suffix
/// (oh-my-pi docs: off|minimal|low|medium|high|xhigh|max).
pub const OMP_EFFORT_LEVELS: [&str; 7] =
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// Levels omp accepts in `modelOverrides.<model>.thinking.levels`. The
/// installed omp schema rejects `off` there — it is a selector suffix only —
/// and a single invalid level makes omp drop the entire models.yml.
const OMP_WIRE_LEVELS: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];

fn sanitize_level(raw: &str) -> Option<String> {
    let value = raw.trim().to_ascii_lowercase();
    OMP_EFFORT_LEVELS
        .contains(&value.as_str())
        .then(|| value.to_string())
}

fn sanitize_levels(raw: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for value in raw {
        let level = value.trim().to_ascii_lowercase();
        if OMP_WIRE_LEVELS.contains(&level.as_str()) && !out.contains(&level) {
            out.push(level);
        }
    }
    out
}

/// before_provider_request shim installed into omp's extension discovery dir.
/// omp's openai-completions wire carries `anyOf` unions that Gemini upstreams
/// (reached through OpenAI-compatible relays) reject with HTTP 400; the shim
/// flattens those schemas right before the request is sent. Non-Gemini models
/// are untouched, so the file is safe to leave installed for every site.
const EXTENSION_FILE: &str = "xiaobai-gemini-schema.ts";
const EXTENSION_SOURCE: &str = include_str!("gemini_schema_extension.ts");

fn install_gemini_shim(home: &Path, touched: &mut TouchedKeys) {
    let path = home.join("extensions").join(EXTENSION_FILE);
    let existing = fs::read_to_string(&path).ok();
    if existing.as_deref() == Some(EXTENSION_SOURCE) {
        touched.paths.push(path.display().to_string());
        return;
    }
    let wrote = fs::create_dir_all(path.parent().expect("extension path has a parent"))
        .and_then(|_| fs::write(&path, EXTENSION_SOURCE));
    if wrote.is_ok() {
        (if existing.is_some() {
            &mut touched.paths
        } else {
            &mut touched.created_paths
        })
        .push(path.display().to_string());
    }
}

/// Effort ladder + reasoning flags omp needs to expose thinking control for a
/// custom provider model (mirrors the modelOverrides shape omp itself writes).
fn thinking_override(levels: &[String]) -> Yaml {
    let mut thinking = Mapping::new();
    thinking.insert(s("mode"), s("effort"));
    let list = levels.iter().map(|l| s(l)).collect();
    thinking.insert(s("levels"), Yaml::Sequence(list));
    let mut compat = Mapping::new();
    compat.insert(s("supportsReasoningEffort"), Yaml::Bool(true));
    let mut entry = Mapping::new();
    entry.insert(s("reasoning"), Yaml::Bool(true));
    entry.insert(s("thinking"), Yaml::Mapping(thinking));
    entry.insert(s("compat"), Yaml::Mapping(compat));
    Yaml::Mapping(entry)
}

fn build_provider(
    site: &SiteRow,
    api_key: &str,
    base_url: &str,
    models: Vec<Yaml>,
    options: &OmpApplyOptions,
    model_id: &str,
) -> Yaml {
    let mut prov = Mapping::new();
    prov.insert(s("baseUrl"), s(base_url));
    prov.insert(s("apiKey"), s(api_key));
    prov.insert(s("api"), s(api_for_protocol(&site.protocol)));
    if site.protocol == SiteProtocol::Anthropic {
        // Anthropic-fronted relays expect Bearer auth and typically reject
        // Anthropic strict tool schemas; omp documents both switches.
        prov.insert(s("authHeader"), Yaml::Bool(true));
        prov.insert(s("disableStrictTools"), Yaml::Bool(true));
    }
    let levels = sanitize_levels(&options.reasoning_levels);
    if !levels.is_empty() {
        let mut overrides = Mapping::new();
        overrides.insert(s(model_id.trim()), thinking_override(&levels));
        prov.insert(s("modelOverrides"), Yaml::Mapping(overrides));
    }
    prov.insert(s("models"), Yaml::Sequence(models));
    Yaml::Mapping(prov)
}

/// Selected model first, then the rest of the site catalog when requested.
fn build_model_list(options: &OmpApplyOptions, model_id: &str) -> Vec<Yaml> {
    let mut list = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let catalog = options
        .catalog_models
        .iter()
        .map(|m| (m.model_id.trim(), m.display_name.trim()))
        .filter(|(id, _)| !id.is_empty());
    for (id, name) in catalog {
        if seen.insert(id.to_string()) {
            list.push(model_entry(id, name));
        }
    }
    let model_id = model_id.trim();
    if seen.insert(model_id.to_string()) {
        list.push(model_entry(model_id, ""));
    }
    list
}

fn write_yaml(path: &Path, root: &Mapping, secret: bool) -> AppResult<()> {
    let mut text = serde_yaml::to_string(root)?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    atomic_write(path, text.as_bytes(), secret)
}

/// Parse a backed-up models/config YAML file for backup previews.
pub fn read_models_yaml(path: &Path) -> AppResult<Mapping> {
    read_yaml(path)
}

/// Summary of the managed slice of both config files. Keys mirror the codex
/// adapter's snake_case style so the frontend renders them uniformly.
pub fn summary_from_docs(models: &Mapping, cfg: &Mapping) -> HashMap<String, Option<String>> {
    let mut out = HashMap::new();
    let default_selector =
        get_mapping(cfg, "modelRoles").and_then(|roles| get_str(roles, "default"));
    let providers = get_mapping(models, "providers");

    // Locate the managed provider entry: the one the default role points at,
    // else the first xiaobai_* provider in the file.
    let mut found: Option<(&str, &Mapping)> = None;
    if let (Some(provs), Some(sel)) = (providers, default_selector) {
        if let Some((pid, _)) = sel.split_once('/') {
            if let Some(p) = provs.get(&s(pid)).and_then(Yaml::as_mapping) {
                found = Some((pid, p));
            }
        }
    }
    if found.is_none() {
        if let Some(provs) = providers {
            for (k, v) in provs.iter() {
                if k.as_str()
                    .unwrap_or_default()
                    .starts_with(MANAGED_PROVIDER_PREFIX)
                {
                    if let Some(p) = v.as_mapping() {
                        found = Some((k.as_str().unwrap_or_default(), p));
                    }
                    break;
                }
            }
        }
    }

    if let Some((pid, prov)) = found {
        out.insert("provider".into(), Some(pid.into()));
        if let Some(url) = get_str(prov, "baseUrl") {
            out.insert("base_url".into(), Some(url.into()));
        }
        if let Some(api) = get_str(prov, "api") {
            out.insert("api".into(), Some(api.into()));
        }
        if let Some(key) = get_str(prov, "apiKey") {
            out.insert("api_key".into(), Some(key_prefix(key)));
        }
        let count = prov
            .get(&s("models"))
            .and_then(Yaml::as_sequence)
            .map(|list| list.len().to_string())
            .unwrap_or_else(|| "0".into());
        out.insert("models".into(), Some(count));
        if let Some(list) = prov.get(&s("models")).and_then(Yaml::as_sequence) {
            let ids: Vec<&str> = list
                .iter()
                .filter_map(|entry| entry.as_mapping().and_then(|e| get_str(e, "id")))
                .collect();
            if !ids.is_empty() {
                out.insert("model_ids".into(), Some(ids.join(",")));
            }
        }
        if let Some(sel) = default_selector {
            // `provider/model:level` — surface the bare model id plus the
            // reasoning level separately so the UI never parses selectors.
            if let Some((_, tail)) = sel.split_once('/') {
                let (mid, level) = tail.rsplit_once(':').unwrap_or((tail, ""));
                out.insert("model".into(), Some(mid.into()));
                if !level.is_empty() {
                    out.insert("reasoning_level".into(), Some(level.into()));
                }
                if let Some(levels) = get_mapping(prov, "modelOverrides")
                    .and_then(|o| o.get(&s(mid)))
                    .and_then(Yaml::as_mapping)
                    .and_then(|entry| entry.get(&s("thinking")))
                    .and_then(|t| t.get(&s("levels")))
                    .and_then(Yaml::as_sequence)
                {
                    let list: Vec<&str> = levels.iter().filter_map(Yaml::as_str).collect();
                    if !list.is_empty() {
                        out.insert("reasoning_levels".into(), Some(list.join(",")));
                    }
                }
            }
        }
    }
    if let Some(sel) = default_selector {
        out.insert("default_model".into(), Some(sel.into()));
    }
    out
}

pub fn live_summary(omp_home_override: Option<&str>) -> AppResult<HashMap<String, Option<String>>> {
    let home = resolve_omp_home(omp_home_override)?;
    let models_p = resolve_yaml_pair(&home, MODELS_STEM);
    if !models_p.exists() {
        return Ok(HashMap::new());
    }
    let models = read_yaml(&models_p)?;
    let cfg_p = resolve_yaml_pair(&home, CONFIG_STEM);
    let cfg = if cfg_p.exists() {
        read_yaml(&cfg_p)?
    } else {
        Mapping::new()
    };
    Ok(summary_from_docs(&models, &cfg))
}

pub fn apply(
    site: &SiteRow,
    api_key: &str,
    model_id: &str,
    options: &OmpApplyOptions,
    omp_home_override: Option<&str>,
    backup_root: &PathBuf,
) -> AppResult<OmpApplyOutcome> {
    if api_key.trim().is_empty() {
        return Err(AppError::new("validation_failed", "api key required"));
    }
    if model_id.trim().is_empty() {
        return Err(AppError::new("validation_failed", "model id required"));
    }
    let home = resolve_omp_home(omp_home_override)?;
    let models_p = resolve_yaml_pair(&home, MODELS_STEM);
    let config_p = resolve_yaml_pair(&home, CONFIG_STEM);
    let preview = crate::url_normalize::normalize_base_url(&site.base_url)?;
    // Both omp wire APIs want the /v1-suffixed form (openai-completions appends
    // /chat/completions; anthropic-messages strips /v1 before /v1/messages).
    let base_url = preview.codex_base_url.clone();

    let mut touched = TouchedKeys::default();
    let mut backup_paths = Vec::new();
    let mut backups: Vec<(PathBuf, PathBuf)> = Vec::new();
    for p in [&models_p, &config_p] {
        if p.exists() {
            let bak = backup_file(p, backup_root)?;
            backup_paths.push(bak.display().to_string());
            touched.paths.push(p.display().to_string());
            backups.push((bak, p.clone()));
        } else {
            touched.created_paths.push(p.display().to_string());
        }
    }
    let rollback = |backups: &[(PathBuf, PathBuf)]| {
        for (bak, dest) in backups {
            let _ = restore_file(bak, dest);
        }
    };

    let provider_id = provider_id_for_site(&site.id);

    // ---- models.yml ----
    let mut root = read_yaml(&models_p)?;
    {
        let providers = ensure_mapping(&mut root, "providers")?;
        let entry = build_provider(
            site,
            api_key,
            &base_url,
            build_model_list(options, model_id),
            options,
            model_id,
        );
        providers.insert(s(&provider_id), entry);
    }
    if let Err(e) = write_yaml(&models_p, &root, false) {
        rollback(&backups);
        return Err(e);
    }

    // ---- config.yml modelRoles.default ----
    // The `:level` suffix sets omp's default thinking level for the model.
    let mut selector = format!("{provider_id}/{}", model_id.trim());
    if let Some(level) = options.reasoning_level.as_deref().and_then(sanitize_level) {
        selector.push(':');
        selector.push_str(&level);
    }
    let mut cfg = read_yaml(&config_p)?;
    {
        let roles = ensure_mapping(&mut cfg, "modelRoles")?;
        roles.insert(s("default"), s(&selector));
    }
    if let Err(e) = write_yaml(&config_p, &cfg, false) {
        rollback(&backups);
        return Err(e);
    }

    // ---- gemini schema shim (best-effort mitigation) ----
    // omp's openai-completions wire does not Google-normalize tool schemas;
    // Gemini upstreams reject the anyOf unions with HTTP 400. The shim flattens
    // them at request time. Failure to install is not fatal: the config above
    // is valid and omp would surface the upstream 400 as before.
    install_gemini_shim(&home, &mut touched);

    // ---- self-check ----
    let verify_models = read_yaml(&models_p)?;
    let verify_cfg = read_yaml(&config_p)?;
    let ok = get_mapping(&verify_models, "providers")
        .and_then(|p| p.get(&s(&provider_id)))
        .and_then(Yaml::as_mapping)
        .map(|prov| {
            get_str(prov, "baseUrl") == Some(base_url.as_str())
                && get_str(prov, "apiKey").is_some_and(|k| !k.is_empty())
        })
        .unwrap_or(false);
    if !ok {
        rollback(&backups);
        return Err(AppError::new(
            "invalid_config",
            "self-check provider failed",
        ));
    }
    if get_mapping(&verify_cfg, "modelRoles").and_then(|r| get_str(r, "default"))
        != Some(selector.as_str())
    {
        rollback(&backups);
        return Err(AppError::new(
            "invalid_config",
            "self-check modelRoles.default failed",
        ));
    }

    let mut expected = HashMap::new();
    expected.insert("base_url".into(), base_url.clone());
    expected.insert("api".into(), api_for_protocol(&site.protocol).into());
    expected.insert("model".into(), model_id.trim().to_string());
    expected.insert("default_model".into(), selector.clone());
    let applied_levels = sanitize_levels(&options.reasoning_levels);
    if !applied_levels.is_empty() {
        expected.insert("reasoning_levels".into(), applied_levels.join(","));
    }
    if let Some(level) = options.reasoning_level.as_deref().and_then(sanitize_level) {
        expected.insert("reasoning_level".into(), level);
    }

    let binding = TargetBinding {
        target: TargetKind::Omp,
        site_id: Some(site.id.clone()),
        site_name_snapshot: site.name.clone(),
        model_id: model_id.trim().into(),
        provider_id: Some(provider_id),
        key_fingerprint: key_fingerprint(api_key),
        managed_paths: vec![
            models_p.display().to_string(),
            config_p.display().to_string(),
        ],
        managed_env_keys: vec![],
        expected_fields: expected,
        orphan: false,
        applied_at: Utc::now().timestamp_millis(),
        apply_record_id: Some(Uuid::new_v4().to_string()),
    };

    let live_summary = summary_from_docs(&verify_models, &verify_cfg);
    Ok(OmpApplyOutcome {
        binding,
        touched,
        backup_paths,
        live_summary,
        message: "omp models.yml updated. Restart omp to pick up changes.".into(),
    })
}

pub fn surgical_revert(binding: &TargetBinding, omp_home_override: Option<&str>) -> AppResult<()> {
    let home = resolve_omp_home(omp_home_override)?;
    let models_p = resolve_yaml_pair(&home, MODELS_STEM);
    let pid = binding.provider_id.clone().unwrap_or_default();

    if models_p.exists() {
        let mut root = read_yaml(&models_p)?;
        let mut changed = false;
        if let Some(Yaml::Mapping(provs)) = root.get_mut(&s("providers")) {
            if provs.remove(&s(&pid)).is_some() {
                changed = true;
            }
        }
        if changed {
            write_yaml(&models_p, &root, false)?;
        }
    }

    let config_p = resolve_yaml_pair(&home, CONFIG_STEM);
    if config_p.exists() {
        let mut cfg = read_yaml(&config_p)?;
        let mut changed = false;
        if let Some(Yaml::Mapping(roles)) = cfg.get_mut(&s("modelRoles")) {
            let prefix = format!("{pid}/");
            let stale: Vec<Yaml> = roles
                .iter()
                .filter(|(_, v)| {
                    v.as_str()
                        .map(|sv| sv.starts_with(&prefix))
                        .unwrap_or(false)
                })
                .map(|(k, _)| k.clone())
                .collect();
            for k in stale {
                roles.remove(&k);
                changed = true;
            }
        }
        if changed {
            write_yaml(&config_p, &cfg, false)?;
        }
    }
    Ok(())
}

/// Remove every xiaobai_* provider and any model role pointing at one so omp
/// falls back to its built-in catalog and stored logins.
pub fn restore_official(
    omp_home_override: Option<&str>,
    backup_root: &PathBuf,
) -> AppResult<crate::adapters::RestoreOfficialOutcome> {
    let home = resolve_omp_home(omp_home_override)?;
    let models_p = resolve_yaml_pair(&home, MODELS_STEM);
    let config_p = resolve_yaml_pair(&home, CONFIG_STEM);
    let mut backup_paths = Vec::new();
    let mut models_bak: Option<PathBuf> = None;

    if models_p.exists() {
        let bak = backup_file(&models_p, backup_root)?;
        models_bak = Some(bak.clone());
        backup_paths.push(bak.display().to_string());
        let mut root = read_yaml(&models_p)?;
        let mut removed = 0usize;
        if let Some(Yaml::Mapping(provs)) = root.get_mut(&s("providers")) {
            let managed: Vec<Yaml> = provs
                .iter()
                .filter(|(k, _)| {
                    k.as_str()
                        .unwrap_or_default()
                        .starts_with(MANAGED_PROVIDER_PREFIX)
                })
                .map(|(k, _)| k.clone())
                .collect();
            removed = managed.len();
            for k in managed {
                provs.remove(&k);
            }
        }
        if removed > 0 {
            if let Err(e) = write_yaml(&models_p, &root, false) {
                if let Some(b) = &models_bak {
                    restore_file(b, &models_p).ok();
                }
                return Err(e);
            }
        }
    }

    if config_p.exists() {
        let bak = backup_file(&config_p, backup_root)?;
        let config_bak = bak.clone();
        backup_paths.push(bak.display().to_string());
        let mut cfg = read_yaml(&config_p)?;
        let mut changed = false;
        if let Some(Yaml::Mapping(roles)) = cfg.get_mut(&s("modelRoles")) {
            let stale: Vec<Yaml> = roles
                .iter()
                .filter(|(_, v)| {
                    v.as_str()
                        .unwrap_or_default()
                        .split_once('/')
                        .map(|(pid, _)| pid.starts_with(MANAGED_PROVIDER_PREFIX))
                        .unwrap_or(false)
                })
                .map(|(k, _)| k.clone())
                .collect();
            for k in stale {
                roles.remove(&k);
                changed = true;
            }
        }
        if changed {
            if let Err(e) = write_yaml(&config_p, &cfg, false) {
                restore_file(&config_bak, &config_p).ok();
                return Err(e);
            }
        }
    }

    Ok(crate::adapters::RestoreOfficialOutcome {
        backup_paths,
        env_keys: vec![],
    })
}

pub fn detect_status(
    binding: Option<&TargetBinding>,
    site: Option<&SiteRow>,
    api_key: Option<&str>,
    omp_home_override: Option<&str>,
) -> AppResult<(ApplyStatus, Option<String>)> {
    let home = resolve_omp_home(omp_home_override)?;
    let models_p = resolve_yaml_pair(&home, MODELS_STEM);
    let live = if models_p.exists() {
        read_yaml(&models_p).ok()
    } else {
        None
    };
    let has_managed_trace = live
        .as_ref()
        .and_then(|root| get_mapping(root, "providers"))
        .map(|provs| {
            provs.keys().any(|k| {
                k.as_str()
                    .unwrap_or_default()
                    .starts_with(MANAGED_PROVIDER_PREFIX)
            })
        })
        .unwrap_or(false);

    if let Some(b) = binding {
        if b.orphan || b.site_id.is_none() {
            return Ok((ApplyStatus::Orphan, Some("site deleted".into())));
        }
        if let (Some(_site), Some(key)) = (site, api_key) {
            if key_fingerprint(key) != b.key_fingerprint {
                return Ok((ApplyStatus::Stale, Some("API key changed".into())));
            }
            let Some(root) = live else {
                return Ok((ApplyStatus::Stale, Some("config missing".into())));
            };
            let pid = b.provider_id.clone().unwrap_or_default();
            let Some(provs) = get_mapping(&root, "providers") else {
                return Ok((ApplyStatus::Stale, Some("providers missing".into())));
            };
            let Some(prov) = provs.get(&s(&pid)).and_then(Yaml::as_mapping) else {
                return Ok((ApplyStatus::Stale, Some("provider removed".into())));
            };
            for (k, expected) in &b.expected_fields {
                match k.as_str() {
                    "base_url" => {
                        if get_str(prov, "baseUrl") != Some(expected.as_str()) {
                            return Ok((ApplyStatus::Stale, Some(format!("{k} mismatch"))));
                        }
                    }
                    "api" => {
                        if get_str(prov, "api") != Some(expected.as_str()) {
                            return Ok((ApplyStatus::Stale, Some(format!("{k} mismatch"))));
                        }
                    }
                    "model" => {
                        let present = prov
                            .get(&s("models"))
                            .and_then(Yaml::as_sequence)
                            .map(|list| {
                                list.iter().any(|m| {
                                    m.as_mapping()
                                        .and_then(|mm| mm.get(&s("id")))
                                        .and_then(Yaml::as_str)
                                        == Some(expected.as_str())
                                })
                            })
                            .unwrap_or(false);
                        if !present {
                            return Ok((ApplyStatus::Stale, Some("model mismatch".into())));
                        }
                    }
                    "reasoning_levels" => {
                        let live_levels = get_mapping(prov, "modelOverrides")
                            .and_then(|o| o.get(&s(&b.model_id)))
                            .and_then(Yaml::as_mapping)
                            .and_then(|entry| entry.get(&s("thinking")))
                            .and_then(|t| t.get(&s("levels")))
                            .and_then(Yaml::as_sequence)
                            .map(|list| {
                                list.iter()
                                    .filter_map(Yaml::as_str)
                                    .collect::<Vec<_>>()
                                    .join(",")
                            });
                        if live_levels.as_deref() != Some(expected.as_str()) {
                            return Ok((
                                ApplyStatus::Stale,
                                Some("reasoning_levels mismatch".into()),
                            ));
                        }
                    }
                    _ => {}
                }
            }
            let config_p = resolve_yaml_pair(&home, CONFIG_STEM);
            if !config_p.exists() {
                return Ok((ApplyStatus::Stale, Some("config missing".into())));
            }
            let cfg = match read_yaml(&config_p) {
                Ok(c) => c,
                Err(_) => {
                    return Ok((ApplyStatus::Stale, Some("config unreadable".into())));
                }
            };
            let def = get_mapping(&cfg, "modelRoles")
                .and_then(|r| get_str(r, "default"))
                .unwrap_or_default();
            if def
                != b.expected_fields
                    .get("default_model")
                    .map(String::as_str)
                    .unwrap_or("")
            {
                return Ok((ApplyStatus::Stale, Some("default model changed".into())));
            }
            return Ok((ApplyStatus::Applied, None));
        }
        return Ok((ApplyStatus::Orphan, None));
    }

    if has_managed_trace {
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
    omp_home_override: Option<&str>,
    backup_root: &PathBuf,
) -> AppResult<crate::adapters::RewriteOutcome> {
    let home = resolve_omp_home(omp_home_override)?;
    let models_p = resolve_yaml_pair(&home, MODELS_STEM);
    if !models_p.exists() {
        return Err(AppError::new("invalid_config", "omp models.yml missing"));
    }
    let preview = crate::url_normalize::normalize_base_url(&site.base_url)?;
    let base_url = preview.codex_base_url.clone();
    let pid = binding.provider_id.clone().unwrap_or_default();

    let bak = backup_file(&models_p, backup_root)?;
    let mut root = read_yaml(&models_p)?;
    let edited = {
        let Some(provs) = get_mapping_mut(&mut root, "providers") else {
            return Err(AppError::new("invalid_config", "providers missing"));
        };
        match provs.get_mut(&s(&pid)).and_then(Yaml::as_mapping_mut) {
            Some(prov) => {
                prov.insert(s("baseUrl"), s(&base_url));
                true
            }
            None => false,
        }
    };
    if !edited {
        return Err(AppError::new("not_found", "bound provider missing"));
    }
    if let Err(e) = write_yaml(&models_p, &root, false) {
        let _ = restore_file(&bak, &models_p);
        return Err(e);
    }
    let verify = read_yaml(&models_p)?;
    let live_ok = get_mapping(&verify, "providers")
        .and_then(|p| p.get(&s(&pid)))
        .and_then(Yaml::as_mapping)
        .and_then(|prov| get_str(prov, "baseUrl"))
        == Some(base_url.as_str());
    if !live_ok {
        let _ = restore_file(&bak, &models_p);
        return Err(AppError::new("invalid_config", "self-check baseUrl failed"));
    }
    let mut expected = binding.expected_fields.clone();
    expected.insert("base_url".into(), base_url.clone());
    let mut live_summary = HashMap::new();
    live_summary.insert("base_url".into(), Some(base_url.clone()));
    Ok(crate::adapters::RewriteOutcome {
        backup_paths: vec![bak.display().to_string()],
        live_summary,
        expected_fields: expected,
        message: "Updated omp provider baseUrl".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{CatalogModel, ClaudeAuthKeyStyle};

    fn sample_site(protocol: SiteProtocol) -> SiteRow {
        SiteRow {
            id: "abcd-1234-ef56-7890".into(),
            name: "Relay A".into(),
            base_url: "https://relay.example.com/v1".into(),
            base_urls: vec!["https://relay.example.com/v1".into()],
            api_key_encrypted: String::new(),
            key_prefix: "sk-test".into(),
            protocol,
            claude_auth_key_style: ClaudeAuthKeyStyle::AnthropicAuthToken,
            notes: None,
            enabled: true,
            sort_order: 0,
            selected_model_id: Some("claude-sonnet-x".into()),
            last_model_fetch_at: None,
            last_model_fetch_latency_ms: None,
            last_model_fetch_error: None,
            created_at: 0,
            updated_at: 0,
            capabilities: Default::default(),
        }
    }

    fn temp_home(tag: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join(tag);
        fs::create_dir_all(&home).unwrap();
        (dir, home)
    }

    fn override_of(home: &Path) -> Option<&str> {
        Some(home.to_str().unwrap())
    }

    #[test]
    fn apply_writes_provider_and_default_role() {
        let (_d, home) = temp_home("h1");
        let site = sample_site(SiteProtocol::OpenaiCompatible);
        let opts = OmpApplyOptions {
            write_all_models: false,
            catalog_models: vec![],
            reasoning_levels: vec![],
            reasoning_level: None,
        };
        let out = apply(
            &site,
            "sk-live-key-123",
            "claude-sonnet-x",
            &opts,
            override_of(&home),
            &home.join("bk"),
        )
        .unwrap();

        let models = read_yaml(&models_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        let provs = get_mapping(&models, "providers").unwrap();
        assert_eq!(provs.len(), 1);
        let prov = provs
            .get(&s(out.binding.provider_id.as_deref().unwrap()))
            .and_then(Yaml::as_mapping)
            .unwrap();
        assert_eq!(
            get_str(prov, "baseUrl"),
            Some("https://relay.example.com/v1")
        );
        assert_eq!(get_str(prov, "apiKey"), Some("sk-live-key-123"));
        assert_eq!(get_str(prov, "api"), Some("openai-completions"));
        assert!(prov.get(&s("authHeader")).is_none());

        let cfg = read_yaml(&config_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        let sel = format!(
            "{}/claude-sonnet-x",
            out.binding.provider_id.clone().unwrap()
        );
        assert_eq!(
            get_str(get_mapping(&cfg, "modelRoles").unwrap(), "default"),
            Some(sel.as_str())
        );
        assert_eq!(out.live_summary.get("models"), Some(&Some("1".into())));

        let (status, reason) = detect_status(
            Some(&out.binding),
            Some(&site),
            Some("sk-live-key-123"),
            override_of(&home),
        )
        .unwrap();
        assert_eq!(status, ApplyStatus::Applied, "{reason:?}");
    }

    #[test]
    fn openai_native_protocol_uses_responses_api() {
        let (_d, home) = temp_home("h-native");
        let site = sample_site(SiteProtocol::OpenaiNative);
        apply(
            &site,
            "sk-a",
            "m1",
            &OmpApplyOptions::default(),
            override_of(&home),
            &home.join("bk"),
        )
        .unwrap();
        let models = read_yaml(&models_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        let prov = get_mapping(&models, "providers")
            .unwrap()
            .values()
            .next()
            .unwrap()
            .as_mapping()
            .unwrap();
        assert_eq!(get_str(prov, "api"), Some("openai-responses"));
    }

    #[test]
    fn apply_writes_thinking_levels_and_default_suffix() {
        let (_d, home) = temp_home("h-reasoning");
        let site = sample_site(SiteProtocol::OpenaiCompatible);
        let opts = OmpApplyOptions {
            write_all_models: false,
            catalog_models: vec![],
            reasoning_levels: vec!["off".into(), "HIGH".into(), "max".into(), "bogus".into()],
            reasoning_level: Some("max".into()),
        };
        let out = apply(
            &site,
            "sk",
            "glm-5.3",
            &opts,
            override_of(&home),
            &home.join("bk"),
        )
        .unwrap();
        let pid = out.binding.provider_id.clone().unwrap();

        let models = read_yaml(&models_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        let prov = get_mapping(&models, "providers")
            .unwrap()
            .get(&s(&pid))
            .and_then(Yaml::as_mapping)
            .unwrap();
        let entry = get_mapping(prov, "modelOverrides")
            .unwrap()
            .get(&s("glm-5.3"))
            .and_then(Yaml::as_mapping)
            .unwrap();
        assert_eq!(entry.get(&s("reasoning")), Some(&Yaml::Bool(true)));
        let compat = get_mapping(entry, "compat").unwrap();
        assert_eq!(
            compat.get(&s("supportsReasoningEffort")),
            Some(&Yaml::Bool(true))
        );

        // "off" is a selector suffix, not a wire level: omp's schema rejects
        // it inside thinking.levels and would drop the entire models.yml.
        let levels = get_mapping(entry, "thinking")
            .unwrap()
            .get(&s("levels"))
            .and_then(Yaml::as_sequence)
            .unwrap()
            .iter()
            .filter_map(Yaml::as_str)
            .collect::<Vec<_>>();
        assert_eq!(levels, vec!["high", "max"]);

        // The wire shim lands in omp's extension discovery dir so Gemini
        // upstreams stop rejecting the anyOf tool schemas.
        let shim = home.join("extensions").join(EXTENSION_FILE);
        assert!(shim.exists(), "gemini shim must be installed");
        assert_eq!(
            fs::read_to_string(&shim).unwrap(),
            EXTENSION_SOURCE,
            "shim content must match the bundled asset"
        );

        let cfg = read_yaml(&config_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        let sel = format!("{pid}/glm-5.3:max");
        assert_eq!(
            get_str(get_mapping(&cfg, "modelRoles").unwrap(), "default"),
            Some(sel.as_str())
        );

        // Summary surfaces the bare model plus the reasoning level.
        let summary = out.live_summary;
        assert_eq!(
            summary.get("model").and_then(|v| v.as_deref()),
            Some("glm-5.3")
        );
        assert_eq!(
            summary.get("reasoning_level").and_then(|v| v.as_deref()),
            Some("max")
        );
        assert_eq!(
            summary.get("reasoning_levels").and_then(|v| v.as_deref()),
            Some("high,max")
        );

        let (status, reason) = detect_status(
            Some(&out.binding),
            Some(&site),
            Some("sk"),
            override_of(&home),
        )
        .unwrap();
        assert_eq!(status, ApplyStatus::Applied, "{reason:?}");
    }

    #[test]
    fn anthropic_protocol_adds_relay_flags() {
        let (_d, home) = temp_home("h2");
        let site = sample_site(SiteProtocol::Anthropic);
        let opts = OmpApplyOptions::default();
        apply(
            &site,
            "sk-a",
            "m1",
            &opts,
            override_of(&home),
            &home.join("bk"),
        )
        .unwrap();
        let models = read_yaml(&models_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        let provs = get_mapping(&models, "providers").unwrap();
        let prov = provs.values().next().unwrap().as_mapping().unwrap();
        assert_eq!(get_str(prov, "api"), Some("anthropic-messages"));
        assert_eq!(prov.get(&s("authHeader")), Some(&Yaml::Bool(true)));
        assert_eq!(prov.get(&s("disableStrictTools")), Some(&Yaml::Bool(true)));
    }

    #[test]
    fn write_all_models_lists_catalog_plus_selection() {
        let (_d, home) = temp_home("h3");
        let site = sample_site(SiteProtocol::OpenaiCompatible);
        let opts = OmpApplyOptions {
            write_all_models: true,
            reasoning_levels: vec![],
            reasoning_level: None,
            catalog_models: vec![
                CatalogModel {
                    model_id: "m1".into(),
                    display_name: "Model One".into(),
                    ..Default::default()
                },
                CatalogModel {
                    model_id: "m2".into(),
                    display_name: String::new(),
                    ..Default::default()
                },
                CatalogModel {
                    model_id: "claude-sonnet-x".into(),
                    display_name: "Selected".into(),
                    ..Default::default()
                },
            ],
        };
        apply(
            &site,
            "sk",
            "claude-sonnet-x",
            &opts,
            override_of(&home),
            &home.join("bk"),
        )
        .unwrap();
        let models = read_yaml(&models_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        let provs = get_mapping(&models, "providers").unwrap();
        let prov = provs.values().next().unwrap().as_mapping().unwrap();
        let list = prov.get(&s("models")).and_then(Yaml::as_sequence).unwrap();
        assert_eq!(list.len(), 3);
        let named = list
            .iter()
            .find(|v| {
                v.as_mapping()
                    .and_then(|mm| mm.get(&s("id")))
                    .and_then(Yaml::as_str)
                    == Some("m1")
            })
            .unwrap()
            .as_mapping()
            .unwrap();
        assert_eq!(
            named.get(&s("name")).and_then(Yaml::as_str),
            Some("Model One")
        );
    }

    #[test]
    fn existing_user_keys_survive_rewrite() {
        let (_d, home) = temp_home("h4");
        fs::write(
            models_path(Some(home.to_str().unwrap())).unwrap(),
            "# my notes\nproviders:\n  mine:\n    baseUrl: https://x.example\n",
        )
        .unwrap();
        let site = sample_site(SiteProtocol::OpenaiCompatible);
        apply(
            &site,
            "sk",
            "m",
            &OmpApplyOptions::default(),
            override_of(&home),
            &home.join("bk"),
        )
        .unwrap();
        let text = fs::read_to_string(models_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        assert!(text.contains("mine"), "user provider dropped:\n{text}");
        let models = read_yaml(&models_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        assert!(get_mapping(&models, "providers").unwrap().len() >= 2);
    }

    #[test]
    fn stale_on_key_change_and_drift() {
        let (_d, home) = temp_home("h5");
        let site = sample_site(SiteProtocol::OpenaiCompatible);
        let out = apply(
            &site,
            "sk-key",
            "m",
            &OmpApplyOptions::default(),
            override_of(&home),
            &home.join("bk"),
        )
        .unwrap();

        let (st, _) = detect_status(
            Some(&out.binding),
            Some(&site),
            Some("sk-other"),
            override_of(&home),
        )
        .unwrap();
        assert_eq!(st, ApplyStatus::Stale);

        // Drift baseUrl behind the app's back.
        let mp = models_path(Some(home.to_str().unwrap())).unwrap();
        let mut root = read_yaml(&mp).unwrap();
        if let Some(Yaml::Mapping(provs)) = root.get_mut(&s("providers")) {
            for (_, v) in provs.iter_mut() {
                if let Yaml::Mapping(p) = v {
                    p.insert(s("baseUrl"), s("https://drifted.example/v1"));
                }
            }
        }
        write_yaml(&mp, &root, false).unwrap();
        let (st, reason) = detect_status(
            Some(&out.binding),
            Some(&site),
            Some("sk-key"),
            override_of(&home),
        )
        .unwrap();
        assert_eq!(st, ApplyStatus::Stale);
        assert_eq!(reason.as_deref(), Some("base_url mismatch"));

        // Restore baseUrl, then removing the default role also goes stale.
        if let Some(Yaml::Mapping(provs)) = root.get_mut(&s("providers")) {
            for (_, v) in provs.iter_mut() {
                if let Yaml::Mapping(p) = v {
                    p.insert(s("baseUrl"), s("https://relay.example.com/v1"));
                }
            }
        }
        write_yaml(&mp, &root, false).unwrap();
        let cp = config_path(Some(home.to_str().unwrap())).unwrap();
        let mut cfg = read_yaml(&cp).unwrap();
        if let Some(Yaml::Mapping(roles)) = cfg.get_mut(&s("modelRoles")) {
            roles.remove(&s("default"));
        }
        write_yaml(&cp, &cfg, false).unwrap();
        let (st, reason) = detect_status(
            Some(&out.binding),
            Some(&site),
            Some("sk-key"),
            override_of(&home),
        )
        .unwrap();
        assert_eq!(st, ApplyStatus::Stale);
        assert_eq!(reason.as_deref(), Some("default model changed"));
    }

    #[test]
    fn untracked_xiaobai_provider_is_orphan() {
        let (_d, home) = temp_home("h6");
        fs::write(
            models_path(Some(home.to_str().unwrap())).unwrap(),
            "providers:\n  xiaobai_deadbeefdead:\n    baseUrl: https://x\n    apiKey: k\n    api: openai-completions\n",
        )
        .unwrap();
        let (st, reason) = detect_status(None, None, None, override_of(&home)).unwrap();
        assert_eq!(st, ApplyStatus::Orphan);
        assert_eq!(reason.as_deref(), Some("untracked managed providers"));
    }

    #[test]
    fn surgical_revert_removes_provider_and_role_only() {
        let (_d, home) = temp_home("h7");
        let site = sample_site(SiteProtocol::OpenaiCompatible);
        let out = apply(
            &site,
            "sk",
            "m",
            &OmpApplyOptions::default(),
            override_of(&home),
            &home.join("bk"),
        )
        .unwrap();
        surgical_revert(&out.binding, override_of(&home)).unwrap();

        let models = read_yaml(&models_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        assert!(get_mapping(&models, "providers").unwrap().is_empty());
        let cfg = read_yaml(&config_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        assert!(get_mapping(&cfg, "modelRoles").unwrap().is_empty());

        let (st, _) = detect_status(
            Some(&out.binding),
            Some(&site),
            Some("sk"),
            override_of(&home),
        )
        .unwrap();
        assert_eq!(st, ApplyStatus::Stale);
    }

    #[test]
    fn rewrite_updates_base_url_and_status_stays_applied() {
        let (_d, home) = temp_home("h8");
        let mut site = sample_site(SiteProtocol::OpenaiCompatible);
        site.base_url = "https://moved.example.com".into();
        let out = apply(
            &sample_site(SiteProtocol::OpenaiCompatible),
            "sk",
            "m",
            &OmpApplyOptions::default(),
            override_of(&home),
            &home.join("bk"),
        )
        .unwrap();
        rewrite_base_url(&site, &out.binding, override_of(&home), &home.join("bk2")).unwrap();
        let (st, reason) = detect_status(
            Some(&{
                let mut b = out.binding.clone();
                b.expected_fields
                    .insert("base_url".into(), "https://moved.example.com/v1".into());
                b
            }),
            Some(&site),
            Some("sk"),
            override_of(&home),
        )
        .unwrap();
        assert_eq!(st, ApplyStatus::Applied, "{reason:?}");
    }

    #[test]
    fn restore_official_clears_untracked_providers() {
        let (_d, home) = temp_home("h9");
        let site = sample_site(SiteProtocol::OpenaiCompatible);
        apply(
            &site,
            "sk",
            "m",
            &OmpApplyOptions::default(),
            override_of(&home),
            &home.join("bk"),
        )
        .unwrap();
        restore_official(override_of(&home), &home.join("bk2")).unwrap();
        let models = read_yaml(&models_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        let empty = get_mapping(&models, "providers")
            .map(|p| p.is_empty())
            .unwrap_or(true);
        assert!(empty);
        let (st, _) = detect_status(None, None, None, override_of(&home)).unwrap();
        assert_eq!(st, ApplyStatus::NotApplied);
    }

    #[test]
    fn malformed_yaml_is_an_error_not_a_clobber() {
        let (_d, home) = temp_home("h10");
        let original = "providers: [broken\n";
        fs::write(models_path(Some(home.to_str().unwrap())).unwrap(), original).unwrap();
        let site = sample_site(SiteProtocol::OpenaiCompatible);
        let result = apply(
            &site,
            "sk",
            "m",
            &OmpApplyOptions::default(),
            override_of(&home),
            &home.join("bk"),
        );
        assert!(result.is_err());
        let text = fs::read_to_string(models_path(Some(home.to_str().unwrap())).unwrap()).unwrap();
        assert_eq!(text, original);
    }
}

#[cfg(test)]
mod live_e2e_tests {
    use super::*;
    use crate::capabilities::SiteCapabilities;
    use crate::domain::ClaudeAuthKeyStyle;

    /// Real-environment E2E against the live ~/.omp/agent files. Backs up and
    /// restores the originals, so it is safe to run on a machine that uses omp.
    /// Skipped (via env) when the live agent dir is absent.
    fn live_home() -> Option<PathBuf> {
        let h = dirs::home_dir()?.join(".omp").join("agent");
        h.join("models.yml").exists().then_some(h)
    }

    fn backup_restore(home: &Path) -> (PathBuf, PathBuf) {
        let models = home.join("models.yml");
        let cfg = home.join("config.yml");
        let mb = home.join("models.yml.e2e-bak");
        let cb = home.join("config.yml.e2e-bak");
        fs::copy(&models, &mb).unwrap();
        if cfg.exists() {
            fs::copy(&cfg, &cb).unwrap();
        }
        (mb, cb)
    }

    #[test]
    fn live_apply_detect_rewrite_revert_roundtrip() {
        let Some(home) = live_home() else {
            eprintln!("skipping: no live ~/.omp/agent/models.yml");
            return;
        };
        let (mb, cb) = backup_restore(&home);
        let models = home.join("models.yml");
        let cfg = home.join("config.yml");

        let site = SiteRow {
            id: "e2e-verify-0001".into(),
            name: "E2E Verify".into(),
            base_url: "https://relay.example.com/v1".into(),
            base_urls: vec!["https://relay.example.com/v1".into()],
            api_key_encrypted: String::new(),
            key_prefix: "sk-e2e".into(),
            protocol: SiteProtocol::OpenaiCompatible,
            claude_auth_key_style: ClaudeAuthKeyStyle::AnthropicAuthToken,
            notes: None,
            enabled: true,
            sort_order: 0,
            selected_model_id: Some("claude-sonnet-x".into()),
            last_model_fetch_at: None,
            last_model_fetch_latency_ms: None,
            last_model_fetch_error: None,
            created_at: 0,
            updated_at: 0,
            capabilities: SiteCapabilities::default(),
        };
        let opts = OmpApplyOptions {
            write_all_models: false,
            catalog_models: vec![],
            reasoning_levels: vec![],
            reasoning_level: None,
        };
        let bk = home.join("bk-e2e");

        // apply
        let out = apply(&site, "sk-e2e-secret", "claude-sonnet-x", &opts, None, &bk)
            .expect("apply should succeed on live files");
        let pid = out.binding.provider_id.clone().unwrap();

        // detect applied
        let (st, reason) =
            detect_status(Some(&out.binding), Some(&site), Some("sk-e2e-secret"), None).unwrap();
        assert_eq!(st, ApplyStatus::Applied, "{reason:?}");

        // live summary reflects the write
        let sum = live_summary(None).unwrap();
        assert_eq!(
            sum.get("provider").and_then(|v| v.as_deref()),
            Some(pid.as_str())
        );

        // rewrite base url
        let mut moved = site.clone();
        moved.base_url = "https://relay2.example.com/v1".into();
        rewrite_base_url(&moved, &out.binding, None, &bk).expect("rewrite should succeed");

        // revert removes our provider
        surgical_revert(&out.binding, None).unwrap();
        let models_after = read_yaml(&models).unwrap();
        assert!(get_mapping(&models_after, "providers")
            .map(|p| !p.contains_key(&s(&pid)))
            .unwrap_or(true));

        // restore originals
        fs::copy(&mb, &models).unwrap();
        fs::copy(&cb, &cfg).unwrap();
        fs::remove_file(&mb).ok();
        fs::remove_file(&cb).ok();
        let _ = bk.exists();
    }
}
