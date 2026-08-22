use crate::domain::{AppSettings, QuotaProbeStatus, QuotaSource, SiteQuota, SiteRow};
use crate::error::AppResult;
use crate::model_probe::sanitize_error;
use crate::url_normalize::normalize_base_url;
use chrono::{Datelike, NaiveDate, Utc};
use serde_json::Value;
use std::time::{Duration, Instant};

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_BODY_BYTES: usize = 64 * 1024;
const UNLIMITED_USD: f64 = 100_000.0;

#[derive(Debug, Clone, PartialEq)]
pub struct BillingUrls {
    pub credit_grants: String,
    pub subscription: String,
    pub usage: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Grants {
    pub remaining: Option<f64>,
    pub used: Option<f64>,
    pub total: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Subscription {
    pub limit_usd: Option<f64>,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Usage {
    pub total_usage: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TokenUsage {
    pub remaining: Option<f64>,
    pub used: Option<f64>,
    pub total: Option<f64>,
    pub unit: String,
    pub unlimited: bool,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Hit {
    Grants(Grants),
    Subscription(Subscription),
    Usage(Usage),
    Token(TokenUsage),
    NotFound,
    Unauthorized,
    Unsupported,
    Error(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum RoundOutcome {
    Available(SiteQuota),
    Fallback,
    Quiet(SiteQuota),
}

pub fn empty_key_result() -> SiteQuota {
    quiet(QuotaProbeStatus::Unsupported, None, 0, None)
}

pub fn strip_trailing_slash(s: &str) -> &str {
    s.trim_end_matches('/')
}

pub fn origin_without_v1(codex_base_url: &str) -> Option<String> {
    let trimmed = strip_trailing_slash(codex_base_url);
    let lower = trimmed.to_ascii_lowercase();
    let stripped = lower.strip_suffix("/v1")?;
    let origin = strip_trailing_slash(&trimmed[..stripped.len()]);
    let ol = origin.to_ascii_lowercase();
    if ol == "http://" || ol == "https://" || origin.len() < 8 {
        return None;
    }
    if ol.starts_with("http://") || ol.starts_with("https://") {
        Some(origin.to_string())
    } else {
        None
    }
}

pub fn usage_date_range(today: NaiveDate) -> (String, String) {
    let start = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);
    let end = today.succ_opt().unwrap_or(today);
    (
        start.format("%Y-%m-%d").to_string(),
        end.format("%Y-%m-%d").to_string(),
    )
}

pub fn billing_urls(api_root: &str, today: NaiveDate) -> BillingUrls {
    let root = strip_trailing_slash(api_root);
    let (start, end) = usage_date_range(today);
    BillingUrls {
        credit_grants: format!("{root}/dashboard/billing/credit_grants"),
        subscription: format!("{root}/dashboard/billing/subscription"),
        usage: format!("{root}/dashboard/billing/usage?start_date={start}&end_date={end}"),
    }
}

pub fn token_usage_url(origin: &str) -> String {
    format!("{}/api/usage/token", strip_trailing_slash(origin))
}

pub fn normalize_quota_unit(raw: &str) -> String {
    match raw.trim().to_ascii_uppercase().as_str() {
        "RMB" | "CNY" | "¥" | "元" => "CNY".into(),
        "USD" | "$" => "USD".into(),
        other if other.is_empty() => "USD".into(),
        other => other.to_string(),
    }
}

pub fn usage_to_usd(total_usage: f64, limit: Option<f64>) -> f64 {
    let scaled = total_usage / 100.0;
    if let Some(limit) = limit {
        if limit > 0.0 && scaled > limit * 1.5 && (0.0..=limit * 1.5).contains(&total_usage) {
            return total_usage;
        }
    }
    scaled
}

fn json_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|x| x.is_finite()),
        Value::String(s) => s.trim().parse::<f64>().ok().filter(|x| x.is_finite()),
        _ => None,
    }
}

fn json_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().filter(|x| x.is_finite()).map(|f| f as i64)),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn field_f64(obj: &Value, key: &str) -> Option<f64> {
    obj.get(key).and_then(json_f64)
}

pub fn parse_credit_grants(value: &Value) -> Option<Grants> {
    if !value.is_object() {
        return None;
    }
    let remaining = field_f64(value, "total_available");
    let used = field_f64(value, "total_used");
    let total = field_f64(value, "total_granted");
    if remaining.is_none() && used.is_none() && total.is_none() {
        return None;
    }
    let mut grants = Grants {
        remaining,
        used,
        total,
    };
    if grants.remaining.is_none() {
        if let (Some(t), Some(u)) = (grants.total, grants.used) {
            grants.remaining = Some(t - u);
        }
    }
    if grants.used.is_none() {
        if let (Some(t), Some(r)) = (grants.total, grants.remaining) {
            grants.used = Some(t - r);
        }
    }
    Some(grants)
}

pub fn parse_subscription(value: &Value) -> Option<Subscription> {
    if !value.is_object() {
        return None;
    }
    let limit_usd = field_f64(value, "hard_limit_usd")
        .or_else(|| field_f64(value, "system_hard_limit_usd"))
        .or_else(|| field_f64(value, "soft_limit_usd"));
    let expires_at = value
        .get("access_until")
        .and_then(json_i64)
        .filter(|v| *v > 0);
    if limit_usd.is_none() && expires_at.is_none() {
        return None;
    }
    Some(Subscription {
        limit_usd,
        expires_at,
    })
}

pub fn parse_usage(value: &Value) -> Option<Usage> {
    if !value.is_object() {
        return None;
    }
    field_f64(value, "total_usage").map(|total_usage| Usage { total_usage })
}

pub fn parse_token_usage(value: &Value) -> Option<TokenUsage> {
    if !value.is_object() {
        return None;
    }
    if value.get("code").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    if value.get("success").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let data = value.get("data").filter(|d| d.is_object())?;
    let display = data.get("display").filter(|d| d.is_object());
    let remaining = display
        .and_then(|d| field_f64(d, "remaining"))
        .or_else(|| field_f64(data, "total_available"));
    let used = display
        .and_then(|d| field_f64(d, "used"))
        .or_else(|| field_f64(data, "total_used"));
    let total = display
        .and_then(|d| field_f64(d, "total"))
        .or_else(|| field_f64(data, "total_granted"));
    if remaining.is_none() && used.is_none() && total.is_none() {
        return None;
    }
    let unit = display
        .and_then(|d| d.get("unit").and_then(Value::as_str))
        .map(normalize_quota_unit)
        .unwrap_or_else(|| {
            if display.is_some() {
                "USD".into()
            } else {
                "quota".into()
            }
        });
    let flag = data
        .get("unlimited_quota")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let unlimited = flag && !total.is_some_and(|t| t > 0.0 && t < UNLIMITED_USD);
    let expires_at = data.get("expires_at").and_then(json_i64).filter(|v| *v > 0);
    Some(TokenUsage {
        remaining,
        used,
        total,
        unit,
        unlimited,
        expires_at,
    })
}

fn looks_like_html(body: &str) -> bool {
    let trimmed = body.trim_start().to_ascii_lowercase();
    trimmed.starts_with("<!doctype") || trimmed.starts_with("<html")
}

pub fn classify_status(status: u16, body: &str, expected: Expected) -> Hit {
    if status == 401 {
        return Hit::Unauthorized;
    }
    if status == 403 {
        if looks_like_html(body) {
            return Hit::Unsupported;
        }
        return Hit::Unauthorized;
    }
    if status == 404 || status == 405 || status == 501 {
        return Hit::NotFound;
    }
    if (200..300).contains(&status) {
        if looks_like_html(body) {
            return Hit::Unsupported;
        }
        let Ok(value) = serde_json::from_str::<Value>(body) else {
            return Hit::Unsupported;
        };
        return match expected {
            Expected::Grants => parse_credit_grants(&value)
                .map(Hit::Grants)
                .unwrap_or(Hit::Unsupported),
            Expected::Subscription => parse_subscription(&value)
                .map(Hit::Subscription)
                .unwrap_or(Hit::Unsupported),
            Expected::Usage => parse_usage(&value)
                .map(Hit::Usage)
                .unwrap_or(Hit::Unsupported),
            Expected::Token => parse_token_usage(&value)
                .map(Hit::Token)
                .unwrap_or(Hit::Unsupported),
        };
    }
    if (500..600).contains(&status) {
        return Hit::Error(format!("HTTP {status}"));
    }
    Hit::Unsupported
}

#[derive(Debug, Clone, Copy)]
pub enum Expected {
    Grants,
    Subscription,
    Usage,
    Token,
}

fn is_unlimited(limit: Option<f64>) -> bool {
    limit.is_some_and(|v| v >= UNLIMITED_USD)
}

fn clamp_remaining(value: Option<f64>) -> Option<f64> {
    value.map(|v| if v.is_finite() { v.max(0.0) } else { 0.0 })
}

fn quiet(
    status: QuotaProbeStatus,
    error: Option<String>,
    latency_ms: u64,
    endpoint: Option<String>,
) -> SiteQuota {
    SiteQuota {
        status,
        remaining_usd: None,
        used_usd: None,
        total_usd: None,
        unlimited: false,
        unit: None,
        expires_at: None,
        source: None,
        endpoint,
        fetched_at: Utc::now().timestamp_millis(),
        latency_ms,
        error,
    }
}

fn available(
    source: QuotaSource,
    remaining: Option<f64>,
    used: Option<f64>,
    total: Option<f64>,
    unlimited: bool,
    unit: Option<&str>,
    expires_at: Option<i64>,
    endpoint: Option<String>,
    fetched_at: i64,
    latency_ms: u64,
) -> SiteQuota {
    SiteQuota {
        status: QuotaProbeStatus::Available,
        remaining_usd: if unlimited {
            None
        } else {
            clamp_remaining(remaining)
        },
        used_usd: used,
        total_usd: if unlimited { None } else { total },
        unlimited,
        unit: unit.map(|s| s.to_string()),
        expires_at,
        source: Some(source),
        endpoint,
        fetched_at,
        latency_ms,
        error: None,
    }
}

pub fn interpret_round(
    grants: &Hit,
    subscription: &Hit,
    usage: &Hit,
    token: &Hit,
    grants_url: &str,
    subscription_url: &str,
    usage_url: &str,
    token_url: &str,
    fetched_at: i64,
    latency_ms: u64,
    allow_fallback: bool,
) -> RoundOutcome {
    let expires = match subscription {
        Hit::Subscription(s) => s.expires_at,
        _ => None,
    };

    if let Hit::Token(t) = token {
        return RoundOutcome::Available(available(
            QuotaSource::TokenUsage,
            t.remaining,
            t.used,
            t.total,
            t.unlimited,
            Some(&t.unit),
            t.expires_at.or(expires),
            Some(token_url.to_string()),
            fetched_at,
            latency_ms,
        ));
    }

    if let Hit::Grants(g) = grants {
        let unlimited = is_unlimited(g.total);
        return RoundOutcome::Available(available(
            QuotaSource::CreditGrants,
            g.remaining,
            g.used,
            g.total,
            unlimited,
            Some("USD"),
            expires,
            Some(grants_url.to_string()),
            fetched_at,
            latency_ms,
        ));
    }

    let sub = match subscription {
        Hit::Subscription(s) => Some(s),
        _ => None,
    };
    let usg = match usage {
        Hit::Usage(u) => Some(u),
        _ => None,
    };

    if let (Some(s), Some(u)) = (sub, usg) {
        let unlimited = is_unlimited(s.limit_usd);
        let used = usage_to_usd(u.total_usage, s.limit_usd);
        let remaining = if unlimited {
            None
        } else {
            s.limit_usd.map(|limit| limit - used)
        };
        return RoundOutcome::Available(available(
            QuotaSource::SubscriptionUsage,
            remaining,
            Some(used),
            s.limit_usd,
            unlimited,
            Some("USD"),
            s.expires_at,
            Some(subscription_url.to_string()),
            fetched_at,
            latency_ms,
        ));
    }

    if let Some(s) = sub {
        let unlimited = is_unlimited(s.limit_usd);
        return RoundOutcome::Available(available(
            QuotaSource::SubscriptionOnly,
            None,
            None,
            s.limit_usd,
            unlimited,
            Some("USD"),
            s.expires_at,
            Some(subscription_url.to_string()),
            fetched_at,
            latency_ms,
        ));
    }

    if let Some(u) = usg {
        let used = usage_to_usd(u.total_usage, None);
        return RoundOutcome::Available(available(
            QuotaSource::UsageOnly,
            None,
            Some(used),
            None,
            false,
            Some("USD"),
            expires,
            Some(usage_url.to_string()),
            fetched_at,
            latency_ms,
        ));
    }

    if allow_fallback {
        return RoundOutcome::Fallback;
    }

    let hits = [grants, subscription, usage, token];
    if hits.iter().any(|h| matches!(h, Hit::Unauthorized)) {
        return RoundOutcome::Quiet(quiet(
            QuotaProbeStatus::Unauthorized,
            None,
            latency_ms,
            None,
        ));
    }
    if let Some(Hit::Error(msg)) = hits.iter().find(|h| matches!(h, Hit::Error(_))) {
        return RoundOutcome::Quiet(quiet(
            QuotaProbeStatus::Error,
            Some(msg.clone()),
            latency_ms,
            None,
        ));
    }
    RoundOutcome::Quiet(quiet(QuotaProbeStatus::Unsupported, None, latency_ms, None))
}

async fn fetch_hit(client: &reqwest::Client, url: &str, api_key: &str, expected: Expected) -> Hit {
    match client
        .get(url)
        .bearer_auth(api_key)
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let bytes = resp.bytes().await.unwrap_or_default();
            let slice = if bytes.len() > MAX_BODY_BYTES {
                &bytes[..MAX_BODY_BYTES]
            } else {
                &bytes
            };
            let text = String::from_utf8_lossy(slice).into_owned();
            classify_status(status, &text, expected)
        }
        Err(err) => {
            let msg = if err.is_timeout() {
                "request timed out".to_string()
            } else {
                err.to_string()
            };
            Hit::Error(sanitize_error(&msg, api_key))
        }
    }
}

struct ProbeRound {
    urls: BillingUrls,
    token_url: String,
    grants: Hit,
    subscription: Hit,
    usage: Hit,
    token: Hit,
}

async fn fetch_round(client: &reqwest::Client, api_root: &str, api_key: &str) -> ProbeRound {
    let urls = billing_urls(api_root, Utc::now().date_naive());
    let token_url = origin_without_v1(api_root)
        .map(|origin| token_usage_url(&origin))
        .unwrap_or_default();
    let token_fut = async {
        if token_url.is_empty() {
            Hit::Unsupported
        } else {
            fetch_hit(client, &token_url, api_key, Expected::Token).await
        }
    };
    let (grants, subscription, usage, token) = tokio::join!(
        fetch_hit(client, &urls.credit_grants, api_key, Expected::Grants),
        fetch_hit(client, &urls.subscription, api_key, Expected::Subscription),
        fetch_hit(client, &urls.usage, api_key, Expected::Usage),
        token_fut,
    );
    ProbeRound {
        urls,
        token_url,
        grants,
        subscription,
        usage,
        token,
    }
}

fn finish_round(
    round: &ProbeRound,
    start: Instant,
    fetched_at: i64,
    api_key: &str,
    allow_fallback: bool,
) -> RoundOutcome {
    let latency_ms = start.elapsed().as_millis() as u64;
    let outcome = interpret_round(
        &round.grants,
        &round.subscription,
        &round.usage,
        &round.token,
        &round.urls.credit_grants,
        &round.urls.subscription,
        &round.urls.usage,
        &round.token_url,
        fetched_at,
        latency_ms,
        allow_fallback,
    );
    match outcome {
        RoundOutcome::Quiet(mut q) if q.status == QuotaProbeStatus::Error => {
            if let Some(err) = q.error.as_mut() {
                *err = sanitize_error(err, api_key);
            }
            RoundOutcome::Quiet(q)
        }
        other => other,
    }
}

pub async fn probe_quota(
    site: &SiteRow,
    api_key: &str,
    settings: &AppSettings,
) -> AppResult<SiteQuota> {
    let start = Instant::now();
    let fetched_at = Utc::now().timestamp_millis();
    if api_key.trim().is_empty() {
        return Ok(empty_key_result());
    }

    let preview = normalize_base_url(&site.base_url)?;
    let client = crate::http_client::build_client(settings, PROBE_TIMEOUT)?;
    let round = fetch_round(&client, &preview.codex_base_url, api_key).await;

    match finish_round(&round, start, fetched_at, api_key, true) {
        RoundOutcome::Available(q) | RoundOutcome::Quiet(q) => Ok(q),
        RoundOutcome::Fallback => {
            let Some(origin) = origin_without_v1(&preview.codex_base_url) else {
                return Ok(quiet(
                    QuotaProbeStatus::Unsupported,
                    None,
                    start.elapsed().as_millis() as u64,
                    None,
                ));
            };
            if origin == preview.codex_base_url {
                return Ok(quiet(
                    QuotaProbeStatus::Unsupported,
                    None,
                    start.elapsed().as_millis() as u64,
                    None,
                ));
            }
            let round = fetch_round(&client, &origin, api_key).await;
            Ok(
                match finish_round(&round, start, fetched_at, api_key, false) {
                    RoundOutcome::Available(q) | RoundOutcome::Quiet(q) => q,
                    RoundOutcome::Fallback => quiet(
                        QuotaProbeStatus::Unsupported,
                        None,
                        start.elapsed().as_millis() as u64,
                        None,
                    ),
                },
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::url_normalize::normalize_base_url;
    use serde_json::json;

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 8, 21).unwrap()
    }

    fn interpret(grants: Hit, sub: Hit, usage: Hit, token: Hit, fallback: bool) -> RoundOutcome {
        interpret_round(
            &grants, &sub, &usage, &token, "g", "s", "u", "t", 1, 10, fallback,
        )
    }

    #[test]
    fn billing_urls_from_bare_and_v1() {
        let bare = normalize_base_url("https://api.example.com").unwrap();
        let urls = billing_urls(&bare.codex_base_url, today());
        assert_eq!(
            urls.credit_grants,
            "https://api.example.com/v1/dashboard/billing/credit_grants"
        );
        assert_eq!(
            urls.subscription,
            "https://api.example.com/v1/dashboard/billing/subscription"
        );
        assert_eq!(
            urls.usage,
            "https://api.example.com/v1/dashboard/billing/usage?start_date=2026-08-01&end_date=2026-08-22"
        );

        let with_v1 = normalize_base_url("https://api.example.com/v1").unwrap();
        let urls = billing_urls(&with_v1.codex_base_url, today());
        assert_eq!(
            urls.credit_grants,
            "https://api.example.com/v1/dashboard/billing/credit_grants"
        );
        assert_eq!(
            token_usage_url("https://api.example.com"),
            "https://api.example.com/api/usage/token"
        );
    }

    #[test]
    fn origin_strips_trailing_v1() {
        assert_eq!(
            origin_without_v1("https://api.example.com/v1").as_deref(),
            Some("https://api.example.com")
        );
        assert_eq!(
            origin_without_v1("https://relay.example.com/openai/v1").as_deref(),
            Some("https://relay.example.com/openai")
        );
        assert_eq!(origin_without_v1("https://api.example.com"), None);
        assert_eq!(origin_without_v1("https://v1"), None);
    }

    #[test]
    fn usage_range_is_month_start_to_tomorrow() {
        let (start, end) = usage_date_range(today());
        assert_eq!(start, "2026-08-01");
        assert_eq!(end, "2026-08-22");
        let (start, end) = usage_date_range(NaiveDate::from_ymd_opt(2026, 1, 31).unwrap());
        assert_eq!(start, "2026-01-01");
        assert_eq!(end, "2026-02-01");
    }

    #[test]
    fn parse_credit_grants_fields() {
        let g = parse_credit_grants(&json!({
            "total_granted": 100.0,
            "total_used": 12.5,
            "total_available": 87.5
        }))
        .unwrap();
        assert_eq!(g.total, Some(100.0));
        assert_eq!(g.used, Some(12.5));
        assert_eq!(g.remaining, Some(87.5));
    }

    #[test]
    fn parse_credit_grants_fills_remaining() {
        let g = parse_credit_grants(&json!({
            "total_granted": "100",
            "total_used": "40"
        }))
        .unwrap();
        assert_eq!(g.remaining, Some(60.0));
    }

    #[test]
    fn parse_credit_grants_rejects_empty_object() {
        assert!(parse_credit_grants(&json!({"object": "credit_summary"})).is_none());
        assert!(parse_credit_grants(&json!([])).is_none());
    }

    #[test]
    fn parse_subscription_prefers_hard_limit() {
        let s = parse_subscription(&json!({
            "hard_limit_usd": 100.0,
            "soft_limit_usd": 80.0,
            "access_until": 1767225600
        }))
        .unwrap();
        assert_eq!(s.limit_usd, Some(100.0));
        assert_eq!(s.expires_at, Some(1767225600));
    }

    #[test]
    fn parse_usage_reads_total_usage() {
        let u = parse_usage(&json!({"object": "list", "total_usage": 2500.0})).unwrap();
        assert_eq!(u.total_usage, 2500.0);
    }

    #[test]
    fn usage_to_usd_divides_by_100() {
        assert_eq!(usage_to_usd(2500.0, Some(100.0)), 25.0);
        assert_eq!(usage_to_usd(2500.0, None), 25.0);
    }

    #[test]
    fn classify_401_and_404() {
        assert_eq!(
            classify_status(401, "{}", Expected::Grants),
            Hit::Unauthorized
        );
        assert_eq!(
            classify_status(404, "nope", Expected::Subscription),
            Hit::NotFound
        );
        assert_eq!(
            classify_status(200, "not-json", Expected::Usage),
            Hit::Unsupported
        );
        assert!(matches!(
            classify_status(502, "down", Expected::Grants),
            Hit::Error(_)
        ));
        assert_eq!(
            classify_status(403, "<!DOCTYPE html><html>", Expected::Grants),
            Hit::Unsupported
        );
        assert_eq!(
            classify_status(
                403,
                r#"{"error":{"message":"forbidden"}}"#,
                Expected::Grants
            ),
            Hit::Unauthorized
        );
    }

    #[test]
    fn parse_token_usage_prefers_display_cny() {
        let parsed = parse_token_usage(&json!({
            "code": true,
            "data": {
                "display": {
                    "remaining": 999.693074,
                    "total": 1000,
                    "unit": "CNY",
                    "used": 0.306926
                },
                "expires_at": 0,
                "total_available": 499846537,
                "total_granted": 500000000,
                "total_used": 153463,
                "unlimited_quota": true
            },
            "message": "ok"
        }))
        .unwrap();
        assert_eq!(parsed.remaining, Some(999.693074));
        assert_eq!(parsed.used, Some(0.306926));
        assert_eq!(parsed.total, Some(1000.0));
        assert_eq!(parsed.unit, "CNY");
        assert!(!parsed.unlimited);
    }

    #[test]
    fn token_usage_wins_over_dummy_unlimited_subscription() {
        let sub = Hit::Subscription(Subscription {
            limit_usd: Some(100_000_000.0),
            expires_at: None,
        });
        let usage = Hit::Usage(Usage {
            total_usage: 8.9686,
        });
        let token = Hit::Token(TokenUsage {
            remaining: Some(999.69),
            used: Some(0.31),
            total: Some(1000.0),
            unit: "CNY".into(),
            unlimited: false,
            expires_at: None,
        });
        let outcome = interpret(Hit::NotFound, sub, usage, token, true);
        match outcome {
            RoundOutcome::Available(q) => {
                assert_eq!(q.source, Some(QuotaSource::TokenUsage));
                assert_eq!(q.remaining_usd, Some(999.69));
                assert_eq!(q.total_usd, Some(1000.0));
                assert_eq!(q.unit.as_deref(), Some("CNY"));
                assert!(!q.unlimited);
            }
            other => panic!("expected available token usage, got {other:?}"),
        }
    }

    #[test]
    fn grants_win_over_subscription() {
        let grants = Hit::Grants(Grants {
            remaining: Some(87.5),
            used: Some(12.5),
            total: Some(100.0),
        });
        let sub = Hit::Subscription(Subscription {
            limit_usd: Some(999.0),
            expires_at: Some(1767225600),
        });
        let usage = Hit::Usage(Usage { total_usage: 1.0 });
        let outcome = interpret_round(
            &grants,
            &sub,
            &usage,
            &Hit::Unsupported,
            "https://api.example.com/v1/dashboard/billing/credit_grants",
            "https://api.example.com/v1/dashboard/billing/subscription",
            "https://api.example.com/v1/dashboard/billing/usage",
            "t",
            1,
            10,
            true,
        );
        match outcome {
            RoundOutcome::Available(q) => {
                assert_eq!(q.source, Some(QuotaSource::CreditGrants));
                assert_eq!(q.remaining_usd, Some(87.5));
                assert_eq!(q.expires_at, Some(1767225600));
                assert_eq!(
                    q.endpoint.as_deref(),
                    Some("https://api.example.com/v1/dashboard/billing/credit_grants")
                );
            }
            other => panic!("expected available, got {other:?}"),
        }
    }

    #[test]
    fn subscription_usage_converts_and_clamps() {
        let grants = Hit::NotFound;
        let sub = Hit::Subscription(Subscription {
            limit_usd: Some(20.0),
            expires_at: None,
        });
        let usage = Hit::Usage(Usage {
            total_usage: 2500.0,
        });
        let outcome = interpret(grants, sub, usage, Hit::Unsupported, true);
        match outcome {
            RoundOutcome::Available(q) => {
                assert_eq!(q.source, Some(QuotaSource::SubscriptionUsage));
                assert_eq!(q.used_usd, Some(25.0));
                assert_eq!(q.remaining_usd, Some(0.0));
                assert_eq!(q.total_usd, Some(20.0));
            }
            other => panic!("expected available, got {other:?}"),
        }
    }

    #[test]
    fn huge_hard_limit_is_unlimited() {
        let grants = Hit::NotFound;
        let sub = Hit::Subscription(Subscription {
            limit_usd: Some(100_000_000.0),
            expires_at: None,
        });
        let usage = Hit::Unsupported;
        let outcome = interpret(grants, sub, usage, Hit::Unsupported, true);
        match outcome {
            RoundOutcome::Available(q) => {
                assert!(q.unlimited);
                assert_eq!(q.total_usd, None);
                assert_eq!(q.remaining_usd, None);
                assert_eq!(q.source, Some(QuotaSource::SubscriptionOnly));
            }
            other => panic!("expected available, got {other:?}"),
        }
    }

    #[test]
    fn all_404_requests_fallback() {
        let outcome = interpret(
            Hit::NotFound,
            Hit::NotFound,
            Hit::NotFound,
            Hit::NotFound,
            true,
        );
        assert_eq!(outcome, RoundOutcome::Fallback);
        let outcome = interpret(
            Hit::NotFound,
            Hit::NotFound,
            Hit::NotFound,
            Hit::NotFound,
            false,
        );
        match outcome {
            RoundOutcome::Quiet(q) => assert_eq!(q.status, QuotaProbeStatus::Unsupported),
            other => panic!("expected quiet unsupported, got {other:?}"),
        }
    }

    #[test]
    fn unauthorized_falls_back_then_stays_unauthorized() {
        let outcome = interpret(
            Hit::Unauthorized,
            Hit::NotFound,
            Hit::Unsupported,
            Hit::Unsupported,
            true,
        );
        assert_eq!(outcome, RoundOutcome::Fallback);
        let outcome = interpret(
            Hit::Unauthorized,
            Hit::NotFound,
            Hit::Unsupported,
            Hit::Unsupported,
            false,
        );
        match outcome {
            RoundOutcome::Quiet(q) => assert_eq!(q.status, QuotaProbeStatus::Unauthorized),
            other => panic!("expected unauthorized, got {other:?}"),
        }
    }

    #[test]
    fn empty_key_is_unsupported() {
        let q = empty_key_result();
        assert_eq!(q.status, QuotaProbeStatus::Unsupported);
        assert!(q.source.is_none());
    }

    #[test]
    fn redact_replaces_raw_api_key_in_error_hit() {
        let key = "sk-abcdefghijklmnop";
        let hit = Hit::Error(sanitize_error(&format!("proxy failed for {key}"), key));
        match hit {
            Hit::Error(msg) => {
                assert!(!msg.contains(key));
                assert!(msg.contains("sk-a…mnop") || msg.contains("sk-ab"));
            }
            _ => panic!("expected error hit"),
        }
    }
}
