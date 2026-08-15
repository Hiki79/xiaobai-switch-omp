use crate::crypto::key_prefix;

pub fn api_key(value: &str) -> String {
    key_prefix(value)
}

pub fn maybe_secret_header(name: &str, value: &str) -> String {
    let lower = name.to_lowercase();
    if lower.contains("auth") || lower.contains("key") || lower.contains("token") {
        api_key(value)
    } else {
        value.to_string()
    }
}
