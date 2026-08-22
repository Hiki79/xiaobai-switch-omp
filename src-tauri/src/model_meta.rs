//! Model metadata (context window / output limit / modalities) resolution.
//!
//! Relays expose wildly inconsistent fields on `/v1/models`, so raw values win
//! when present, a conservative family table fills the well-known gaps, and
//! unknown models stay untouched (targets apply their own defaults).

use serde_json::Value;

/// Keys relays commonly use for the input/context token limit, most specific
/// first.
const CONTEXT_KEYS: [&str; 7] = [
    "context_length",
    "context_window",
    "max_context_window",
    "max_context_window_tokens",
    "max_model_len",
    "max_input_tokens",
    "context",
];

/// Keys for the output token limit.
const OUTPUT_KEYS: [&str; 2] = ["max_output_tokens", "max_tokens"];

fn u64_at(value: &Value, keys: &[&str]) -> Option<u64> {
    for key in keys {
        let Some(raw) = value.get(*key) else {
            continue;
        };
        if let Some(n) = raw.as_u64() {
            if n > 0 {
                return Some(n);
            }
        }
        // Some relays stringify numbers.
        if let Some(s) = raw.as_str() {
            if let Ok(n) = s.trim().parse::<u64>() {
                if n > 0 {
                    return Some(n);
                }
            }
        }
    }
    None
}

/// (context, output) advertised by the model object from `/v1/models`.
pub fn context_from_raw(raw: &Value) -> Option<(u64, Option<u64>)> {
    if !raw.is_object() {
        return None;
    }
    let context = u64_at(raw, &CONTEXT_KEYS)?;
    Some((context, u64_at(raw, &OUTPUT_KEYS)))
}

/// Whether the raw model object declares image input.
pub fn vision_from_raw(raw: &Value) -> bool {
    for key in ["input_modalities", "modalities"] {
        if let Some(list) = raw.get(key).and_then(Value::as_array) {
            if list
                .iter()
                .filter_map(Value::as_str)
                .any(|v| v.eq_ignore_ascii_case("image"))
            {
                return true;
            }
        }
    }
    false
}

/// Conservative published limits per model family; unknown families are left
/// to the target's own default.
const FAMILY_LIMITS: [(&str, u64, u64); 8] = [
    // GLM-5.x / zai coding plans expose 1M in / 128K out.
    ("glm", 1_000_000, 128_000),
    ("bigmodel", 1_000_000, 128_000),
    ("zai", 1_000_000, 128_000),
    ("gemini", 1_000_000, 64_000),
    ("gpt-4.1", 1_000_000, 32_768),
    ("gpt", 400_000, 128_000),
    ("claude", 200_000, 64_000),
    ("kimi", 256_000, 8_192),
];

fn family_limits(model_id: &str) -> Option<(u64, u64)> {
    let id = model_id.to_ascii_lowercase();
    // "gpt-4.1" must win over the generic "gpt" row.
    FAMILY_LIMITS
        .iter()
        .find(|(needle, _, _)| id.contains(needle))
        .map(|(_, context, output)| (*context, *output))
}

/// raw relay values beat the family table; None when neither knows.
pub fn resolve_limits(model_id: &str, raw: Option<&Value>) -> Option<(u64, Option<u64>)> {
    if let Some(raw) = raw {
        if let Some(found) = context_from_raw(raw) {
            return Some(found);
        }
    }
    family_limits(model_id).map(|(context, output)| (context, Some(output)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_context_and_output_from_raw_keys() {
        let raw = json!({"id": "m", "context_length": "1000000", "max_tokens": 65536});
        assert_eq!(context_from_raw(&raw), Some((1_000_000, Some(65_536))));
        // DeepSeek-style key.
        let raw = json!({"id": "m", "max_model_len": 131072});
        assert_eq!(context_from_raw(&raw), Some((131_072, None)));
        // No context keys at all.
        assert_eq!(context_from_raw(&json!({"id": "m"})), None);
    }

    #[test]
    fn detects_image_modality() {
        assert!(vision_from_raw(&json!({"input_modalities": ["text", "image"]})));
        assert!(vision_from_raw(&json!({"modalities": ["image"]})));
        assert!(!vision_from_raw(&json!({"modalities": ["text"]})));
        assert!(!vision_from_raw(&json!({"id": "m"})));
    }

    #[test]
    fn raw_wins_over_family_table() {
        let raw = json!({"context_window": 64000});
        assert_eq!(
            resolve_limits("glm-5.3", Some(&raw)),
            Some((64_000, None))
        );
    }

    #[test]
    fn family_table_covers_known_families_and_gpt41_wins() {
        assert_eq!(
            resolve_limits("glm-5.3", None),
            Some((1_000_000, Some(128_000)))
        );
        assert_eq!(
            resolve_limits("gpt-4.1-mini", None),
            Some((1_000_000, Some(32_768)))
        );
        assert_eq!(
            resolve_limits("gpt-5.2", None),
            Some((400_000, Some(128_000)))
        );
        assert_eq!(resolve_limits("mystery-model", None), None);
    }
}
