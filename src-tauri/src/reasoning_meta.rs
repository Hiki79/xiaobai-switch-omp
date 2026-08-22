//! Cross-target reasoning constraints that must be enforced at the host boundary.
//!
//! Some relay models always think and reject an explicit disabled/off request.
//! Keep those hard constraints here so adapters cannot accidentally diverge.

/// Returns the only safe reasoning ladder for an always-thinking model family.
pub fn always_thinking_levels(model_id: &str) -> Option<Vec<String>> {
    let id = model_id.trim().to_ascii_lowercase();
    if id.contains("ox-alpha") {
        Some(
            ["low", "high", "max"]
                .into_iter()
                .map(String::from)
                .collect(),
        )
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ox_alpha_never_exposes_an_off_level() {
        assert_eq!(
            always_thinking_levels("OX-ALPHA-FREE"),
            Some(vec!["low".into(), "high".into(), "max".into()])
        );
        assert_eq!(always_thinking_levels("deepseek-chat"), None);
    }
}
