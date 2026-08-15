use crate::error::{AppError, AppResult};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UrlWritePreview {
    pub models_url: String,
    pub claude_base_url: String,
    pub codex_base_url: String,
}

fn strip_trailing_slash(s: &str) -> &str {
    s.trim_end_matches('/')
}

pub fn normalize_base_url(input: &str) -> AppResult<UrlWritePreview> {
    let mut raw = input.trim().to_string();
    if raw.is_empty() {
        return Err(AppError::new("validation_failed", "empty base URL"));
    }
    if raw.chars().any(|c| c.is_whitespace()) {
        return Err(AppError::new(
            "validation_failed",
            "base URL must not contain whitespace",
        ));
    }
    if let Some(i) = raw.find('#') {
        raw.truncate(i);
    }
    if let Some(i) = raw.find('?') {
        raw.truncate(i);
    }

    let mut base = strip_trailing_slash(&raw).to_string();

    if base.to_lowercase().ends_with("/v1/messages") {
        base = base[..base.len() - "/v1/messages".len()].to_string() + "/v1";
    } else if base.to_lowercase().ends_with("/messages") {
        base = base[..base.len() - "/messages".len()].to_string();
    }
    base = strip_trailing_slash(&base).to_string();

    let ends_with_v1 = base.to_lowercase().ends_with("/v1");
    let models_url = if ends_with_v1 {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    };
    let claude_base_url = base.clone();
    let codex_base_url = if ends_with_v1 {
        base
    } else {
        format!("{base}/v1")
    };

    Ok(UrlWritePreview {
        models_url,
        claude_base_url,
        codex_base_url,
    })
}

/// Trim, drop empties, require http(s), dedupe preserving order.
pub fn normalize_base_urls(urls: &[String]) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    for raw in urls {
        let t = raw.trim();
        if t.is_empty() {
            continue;
        }
        if t.chars().any(|c| c.is_whitespace()) {
            return Err(AppError::new(
                "validation_failed",
                "base URL must not contain whitespace",
            ));
        }
        let lower = t.to_ascii_lowercase();
        if !lower.starts_with("http://") && !lower.starts_with("https://") {
            return Err(AppError::new(
                "validation_failed",
                "base URL must be http(s)",
            ));
        }
        if !out.iter().any(|u| u == t) {
            out.push(t.to_string());
        }
    }
    if out.is_empty() {
        return Err(AppError::new(
            "validation_failed",
            "at least one base URL is required",
        ));
    }
    Ok(out)
}

pub fn parse_base_urls_json(json: Option<&str>, fallback: &str) -> Vec<String> {
    if let Some(raw) = json {
        if let Ok(v) = serde_json::from_str::<Vec<String>>(raw) {
            if let Ok(norm) = normalize_base_urls(&v) {
                return norm;
            }
        }
    }
    normalize_base_urls(&[fallback.to_string()]).unwrap_or_else(|_| vec![fallback.to_string()])
}

pub fn move_url_to_front(urls: &[String], selected: &str) -> AppResult<Vec<String>> {
    let selected = selected.trim();
    if !urls.iter().any(|u| u == selected) {
        return Err(AppError::new(
            "validation_failed",
            "base URL is not a configured route",
        ));
    }
    let mut out = vec![selected.to_string()];
    for u in urls {
        if u != selected {
            out.push(u.clone());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_host() {
        let r = normalize_base_url("https://api.example.com").unwrap();
        assert_eq!(r.models_url, "https://api.example.com/v1/models");
        assert_eq!(r.claude_base_url, "https://api.example.com");
        assert_eq!(r.codex_base_url, "https://api.example.com/v1");
    }

    #[test]
    fn with_v1() {
        let r = normalize_base_url("https://api.example.com/v1").unwrap();
        assert_eq!(r.models_url, "https://api.example.com/v1/models");
        assert_eq!(r.codex_base_url, "https://api.example.com/v1");
    }

    #[test]
    fn strip_messages() {
        let r = normalize_base_url("https://relay.example.com/v1/messages").unwrap();
        assert_eq!(r.claude_base_url, "https://relay.example.com/v1");
        assert_eq!(r.models_url, "https://relay.example.com/v1/models");
    }

    #[test]
    fn anthropic_path() {
        let r = normalize_base_url("https://relay.example.com/anthropic").unwrap();
        assert_eq!(r.claude_base_url, "https://relay.example.com/anthropic");
        assert_eq!(r.codex_base_url, "https://relay.example.com/anthropic/v1");
    }

    #[test]
    fn normalize_base_urls_trims_dedupes_and_requires_http() {
        let urls = vec![
            "  https://a.example.com  ".into(),
            "https://a.example.com".into(),
            "https://b.example.com".into(),
            "".into(),
        ];
        assert_eq!(
            normalize_base_urls(&urls).unwrap(),
            vec!["https://a.example.com", "https://b.example.com"]
        );
        assert!(normalize_base_urls(&[String::new()]).is_err());
        assert!(normalize_base_urls(&["ftp://x".into()]).is_err());
    }

    #[test]
    fn move_url_to_front_reorders() {
        let urls = vec!["https://a".into(), "https://b".into(), "https://c".into()];
        assert_eq!(
            move_url_to_front(&urls, "https://b").unwrap(),
            vec!["https://b", "https://a", "https://c"]
        );
        assert!(move_url_to_front(&urls, "https://z").is_err());
    }

    #[test]
    fn parse_base_urls_json_falls_back() {
        assert_eq!(
            parse_base_urls_json(Some(r#"["https://a","https://b"]"#), "https://x"),
            vec!["https://a", "https://b"]
        );
        assert_eq!(parse_base_urls_json(None, "https://x"), vec!["https://x"]);
    }
}
