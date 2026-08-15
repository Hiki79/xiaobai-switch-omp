use crate::domain::{HttpBytesResult, UrlProbeResult};
use crate::error::AppResult;
use crate::repo;
use crate::state::AppState;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::State;

const MAX_BODY: usize = 512 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpTextResult {
    pub status: u16,
    pub content_type: String,
    pub final_url: String,
    pub body: String,
}

fn settings_client(state: &AppState, timeout: Duration) -> AppResult<reqwest::Client> {
    let settings = state.db.with_conn(repo::settings::get_settings)?;
    crate::http_client::build_client(&settings, timeout)
}

#[tauri::command]
pub async fn fetch_http_text(state: State<'_, AppState>, url: String) -> AppResult<HttpTextResult> {
    let client = settings_client(&state, Duration::from_secs(8))?;

    let resp = match client
        .get(&url)
        .header("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            return Ok(HttpTextResult {
                status: 0,
                content_type: String::new(),
                final_url: url,
                body: String::new(),
            });
        }
    };

    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let final_url = resp.url().to_string();
    let bytes = resp.bytes().await.unwrap_or_default();
    let slice = if bytes.len() > MAX_BODY {
        &bytes[..MAX_BODY]
    } else {
        &bytes
    };
    let body = String::from_utf8_lossy(slice).into_owned();
    Ok(HttpTextResult {
        status,
        content_type,
        final_url,
        body,
    })
}

#[tauri::command]
pub async fn fetch_http_bytes(
    state: State<'_, AppState>,
    url: String,
) -> AppResult<HttpBytesResult> {
    let client = settings_client(&state, Duration::from_secs(8))?;
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(_) => {
            return Ok(HttpBytesResult {
                status: 0,
                content_type: String::new(),
                final_url: url,
                base64: String::new(),
            });
        }
    };
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let final_url = resp.url().to_string();
    let bytes = resp.bytes().await.unwrap_or_default();
    let slice = if bytes.len() > MAX_BODY {
        &bytes[..MAX_BODY]
    } else {
        &bytes
    };
    Ok(HttpBytesResult {
        status,
        content_type,
        final_url,
        base64: B64.encode(slice),
    })
}

#[tauri::command]
pub async fn probe_urls(
    state: State<'_, AppState>,
    urls: Vec<String>,
) -> AppResult<Vec<UrlProbeResult>> {
    let client = settings_client(&state, Duration::from_secs(8))?;
    let mut set = tokio::task::JoinSet::new();
    for (i, url) in urls.into_iter().enumerate() {
        let c = client.clone();
        set.spawn(async move { (i, probe_one(&c, url).await) });
    }
    let mut pairs = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(pair) = joined {
            pairs.push(pair);
        }
    }
    pairs.sort_by_key(|(i, _)| *i);
    Ok(pairs.into_iter().map(|(_, r)| r).collect())
}

async fn probe_one(client: &reqwest::Client, url: String) -> UrlProbeResult {
    let start = Instant::now();
    match client.get(&url).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            drop(resp);
            UrlProbeResult {
                url,
                ok: true,
                latency_ms: start.elapsed().as_millis() as u64,
                status: Some(status),
                error: None,
            }
        }
        Err(e) => UrlProbeResult {
            url,
            ok: false,
            latency_ms: start.elapsed().as_millis() as u64,
            status: None,
            error: Some(e.to_string()),
        },
    }
}
