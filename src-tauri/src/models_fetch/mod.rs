use crate::domain::{AppSettings, FetchModelsResult, SiteModelDto, SiteProtocol, SiteRow};
use crate::error::{AppError, AppResult};
use crate::url_normalize::normalize_base_url;
use chrono::Utc;
use serde::Deserialize;
use serde_json::Value;
use std::time::Instant;
use uuid::Uuid;

/// Both OpenAI- and Anthropic-style listings share the `{data: [...]}` shape;
/// items are kept as raw JSON so relay-provided metadata (context window,
/// modalities, …) survives into `site_models.raw_json`.
#[derive(Debug, Deserialize)]
struct ModelsListResponse {
    data: Option<Vec<Value>>,
}

fn dto_from_item(site_id: &str, item: Value) -> Option<SiteModelDto> {
    if !item.is_object() {
        return None;
    }
    let model_id = item.get("id").and_then(Value::as_str)?.trim().to_string();
    if model_id.is_empty() {
        return None;
    }
    let display_name = item
        .get("display_name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let owned_by = item
        .get("owned_by")
        .and_then(Value::as_str)
        .map(str::to_string)
        // Anthropic-style items carry display_name instead of owned_by.
        .or_else(|| display_name.as_ref().map(|_| "anthropic".to_string()));
    Some(SiteModelDto {
        id: Uuid::new_v4().to_string(),
        site_id: site_id.to_string(),
        display_name: display_name.unwrap_or_else(|| model_id.clone()),
        model_id,
        owned_by,
        raw: Some(item),
        is_manual: false,
    })
}

fn dtos_from_body(site_id: &str, body: ModelsListResponse) -> Vec<SiteModelDto> {
    body.data
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| dto_from_item(site_id, item))
        .collect()
}

pub async fn fetch_models(
    site: &SiteRow,
    api_key: &str,
    settings: &AppSettings,
) -> AppResult<FetchModelsResult> {
    let preview = normalize_base_url(&site.base_url)?;
    let client = crate::http_client::build_client(settings, std::time::Duration::from_secs(15))?;

    let start = Instant::now();
    let (endpoint, models) = match site.protocol {
        // OpenAI-native endpoints expose the same GET /v1/models listing.
        SiteProtocol::OpenaiCompatible | SiteProtocol::OpenaiNative => {
            let endpoint = preview.models_url.clone();
            let resp = client.get(&endpoint).bearer_auth(api_key).send().await?;
            let status = resp.status();
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err(AppError::new("unauthorized", "unauthorized"));
            }
            if status.as_u16() == 404 {
                return Err(AppError::new("not_found", "models endpoint not found"));
            }
            if !status.is_success() {
                return Err(AppError::new(
                    "network",
                    format!("HTTP {}", status.as_u16()),
                ));
            }
            let body: ModelsListResponse = resp
                .json()
                .await
                .map_err(|e| AppError::new("invalid_response", e.to_string()))?;
            (endpoint, dtos_from_body(&site.id, body))
        }
        SiteProtocol::Anthropic => {
            // Prefer Anthropic-style list; fall back to OpenAI-compatible path with x-api-key
            let endpoint = preview.models_url.clone();
            let resp = client
                .get(&endpoint)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .send()
                .await;
            match resp {
                Ok(resp) => {
                    let status = resp.status();
                    if status.as_u16() == 401 || status.as_u16() == 403 {
                        return Err(AppError::new("unauthorized", "unauthorized"));
                    }
                    if !status.is_success() {
                        return Err(AppError::new(
                            "network",
                            format!(
                                "Anthropic models HTTP {}. You can enter model id manually.",
                                status.as_u16()
                            ),
                        ));
                    }
                    let text = resp.text().await?;
                    // One parser covers both shapes: OpenAI items expose
                    // id/owned_by, Anthropic items id/display_name.
                    match serde_json::from_str::<ModelsListResponse>(&text) {
                        Ok(body) => (endpoint, dtos_from_body(&site.id, body)),
                        Err(_) => {
                            return Err(AppError::new(
                                "invalid_response",
                                "Could not parse models response. Enter model id manually.",
                            ));
                        }
                    }
                }
                Err(e) => return Err(e.into()),
            }
        }
    };

    let latency_ms = start.elapsed().as_millis() as u64;
    Ok(FetchModelsResult {
        models,
        latency_ms,
        endpoint,
        fetched_at: Utc::now().timestamp_millis(),
    })
}
