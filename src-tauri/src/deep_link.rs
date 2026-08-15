use crate::crypto::Crypto;
use crate::domain::{
    CreateSiteInput, DeepLinkSiteImportInput, DeepLinkSiteImportResult, SiteProtocol, SiteRow,
    UpdateSiteInput,
};
use crate::error::{AppError, AppResult};
use crate::repo::site;
use crate::state::AppState;
use crate::url_normalize::normalize_base_urls;
use rusqlite::Connection;

pub const MAX_NAME: usize = 128;
pub const MAX_NOTES: usize = 2000;
pub const MAX_ROUTES: usize = 20;
pub const MAX_URL_LEN: usize = 2048;

pub fn parse_deep_link_protocol(value: Option<&str>) -> AppResult<SiteProtocol> {
    match value.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(SiteProtocol::OpenaiCompatible),
        Some(raw) => match raw.to_ascii_lowercase().as_str() {
            "openai" | "openai_compatible" => Ok(SiteProtocol::OpenaiCompatible),
            "anthropic" => Ok(SiteProtocol::Anthropic),
            other => Err(AppError::new(
                "validation_failed",
                format!("unsupported protocol: {other}"),
            )),
        },
    }
}

fn url_set_eq(a: &[String], b: &[String]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut sa = a.to_vec();
    let mut sb = b.to_vec();
    sa.sort();
    sb.sort();
    sa == sb
}

fn find_matching_site(
    conn: &Connection,
    protocol: &SiteProtocol,
    urls: &[String],
) -> AppResult<Option<SiteRow>> {
    let sites = site::list_sites(conn)?;
    Ok(sites
        .into_iter()
        .find(|row| &row.protocol == protocol && url_set_eq(&row.base_urls, urls)))
}

pub fn import_site_from_deep_link_conn(
    conn: &Connection,
    crypto: &Crypto,
    input: DeepLinkSiteImportInput,
) -> AppResult<DeepLinkSiteImportResult> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME {
        return Err(AppError::new(
            "validation_failed",
            "site name is required (max 128 chars)",
        ));
    }

    let api_key = input.api_key.trim();
    if api_key.is_empty() {
        return Err(AppError::new("validation_failed", "API key is required"));
    }

    if input
        .base_urls
        .iter()
        .any(|u| u.chars().count() > MAX_URL_LEN)
    {
        return Err(AppError::new(
            "validation_failed",
            "base URL exceeds 2048 characters",
        ));
    }

    let urls = normalize_base_urls(&input.base_urls)?;
    if urls.len() > MAX_ROUTES {
        return Err(AppError::new(
            "validation_failed",
            "at most 20 base URLs are allowed",
        ));
    }

    let protocol = parse_deep_link_protocol(input.protocol.as_deref())?;
    let notes = input
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if notes
        .as_ref()
        .is_some_and(|s| s.chars().count() > MAX_NOTES)
    {
        return Err(AppError::new(
            "validation_failed",
            "notes exceed 2000 characters",
        ));
    }

    if let Some(existing) = find_matching_site(conn, &protocol, &urls)? {
        let same_key = crypto.decrypt(&existing.api_key_encrypted)? == api_key;
        let name_changed = existing.name != name;
        let notes_changed = notes
            .as_ref()
            .is_some_and(|incoming| existing.notes.as_ref() != Some(incoming));
        if same_key && !name_changed && !notes_changed {
            return Ok(DeepLinkSiteImportResult {
                site: existing.to_dto(),
                created: false,
                updated_key: false,
                reused: true,
            });
        }

        let row = site::update_site(
            conn,
            crypto,
            &existing.id,
            UpdateSiteInput {
                name: Some(name.to_string()),
                notes,
                api_key: if same_key {
                    None
                } else {
                    Some(api_key.to_string())
                },
                ..UpdateSiteInput::default()
            },
        )?;

        return Ok(DeepLinkSiteImportResult {
            site: row.to_dto(),
            created: false,
            updated_key: !same_key,
            reused: same_key,
        });
    }

    let row = site::create_site(
        conn,
        crypto,
        CreateSiteInput {
            name: name.to_string(),
            base_url: urls[0].clone(),
            base_urls: Some(urls),
            api_key: api_key.to_string(),
            protocol: Some(protocol.as_str().to_string()),
            claude_auth_key_style: None,
            notes,
        },
    )?;

    Ok(DeepLinkSiteImportResult {
        site: row.to_dto(),
        created: true,
        updated_key: false,
        reused: false,
    })
}

pub fn import_site_from_deep_link(
    state: &AppState,
    input: DeepLinkSiteImportInput,
) -> AppResult<DeepLinkSiteImportResult> {
    state
        .db
        .with_conn(|c| import_site_from_deep_link_conn(c, &state.crypto, input))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup() -> (Connection, Crypto) {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        (conn, Crypto::from_key([7u8; 32]))
    }

    fn input(
        name: &str,
        urls: &[&str],
        key: &str,
        protocol: Option<&str>,
        notes: Option<&str>,
    ) -> DeepLinkSiteImportInput {
        DeepLinkSiteImportInput {
            name: name.into(),
            base_urls: urls.iter().map(|s| (*s).to_string()).collect(),
            api_key: key.into(),
            protocol: protocol.map(|s| s.into()),
            notes: notes.map(|s| s.into()),
        }
    }

    #[test]
    fn deep_link_import_creates_site_with_multiple_routes() {
        let (conn, crypto) = setup();
        let result = import_site_from_deep_link_conn(
            &conn,
            &crypto,
            input(
                "Relay",
                &["https://a.example.com/v1", "https://b.example.com/v1"],
                "sk-example",
                Some("openai"),
                Some("hi"),
            ),
        )
        .unwrap();

        assert!(result.created);
        assert!(!result.updated_key);
        assert!(!result.reused);
        assert_eq!(result.site.name, "Relay");
        assert_eq!(result.site.base_url, "https://a.example.com/v1");
        assert_eq!(
            result.site.base_urls,
            vec![
                "https://a.example.com/v1".to_string(),
                "https://b.example.com/v1".to_string()
            ]
        );
        assert_eq!(result.site.protocol, "openai_compatible");
        assert_eq!(result.site.notes.as_deref(), Some("hi"));
        assert_eq!(
            crypto
                .decrypt(
                    &site::get_site(&conn, &result.site.id)
                        .unwrap()
                        .api_key_encrypted
                )
                .unwrap(),
            "sk-example"
        );
    }

    #[test]
    fn deep_link_import_reuses_same_protocol_and_url_set() {
        let (conn, crypto) = setup();
        let first = import_site_from_deep_link_conn(
            &conn,
            &crypto,
            input(
                "First",
                &["https://b.example.com", "https://a.example.com"],
                "sk-same",
                Some("openai_compatible"),
                None,
            ),
        )
        .unwrap();
        let second = import_site_from_deep_link_conn(
            &conn,
            &crypto,
            input(
                "First",
                &["https://a.example.com", "https://b.example.com"],
                "sk-same",
                Some("openai"),
                None,
            ),
        )
        .unwrap();

        assert_eq!(second.site.id, first.site.id);
        assert!(!second.created);
        assert!(second.reused);
        assert!(!second.updated_key);
        // Reuse must not reorder the active route.
        assert_eq!(second.site.base_url, first.site.base_url);
        assert_eq!(site::list_sites(&conn).unwrap().len(), 1);
    }

    #[test]
    fn deep_link_import_updates_key_when_urls_match() {
        let (conn, crypto) = setup();
        let first = import_site_from_deep_link_conn(
            &conn,
            &crypto,
            input("Relay", &["https://a.example.com"], "sk-old", None, None),
        )
        .unwrap();
        let second = import_site_from_deep_link_conn(
            &conn,
            &crypto,
            input(
                "Relay Two",
                &["https://a.example.com"],
                "sk-new-key",
                None,
                Some("updated"),
            ),
        )
        .unwrap();

        assert_eq!(second.site.id, first.site.id);
        assert!(!second.created);
        assert!(second.updated_key);
        assert!(!second.reused);
        assert_eq!(second.site.name, "Relay Two");
        assert_eq!(second.site.notes.as_deref(), Some("updated"));
        assert_eq!(
            crypto
                .decrypt(
                    &site::get_site(&conn, &second.site.id)
                        .unwrap()
                        .api_key_encrypted
                )
                .unwrap(),
            "sk-new-key"
        );
    }

    #[test]
    fn deep_link_import_creates_when_url_set_differs() {
        let (conn, crypto) = setup();
        let first = import_site_from_deep_link_conn(
            &conn,
            &crypto,
            input("A", &["https://a.example.com"], "sk-a", None, None),
        )
        .unwrap();
        let second = import_site_from_deep_link_conn(
            &conn,
            &crypto,
            input(
                "A",
                &["https://a.example.com", "https://b.example.com"],
                "sk-a",
                None,
                None,
            ),
        )
        .unwrap();

        assert_ne!(second.site.id, first.site.id);
        assert!(second.created);
        assert_eq!(site::list_sites(&conn).unwrap().len(), 2);
    }

    #[test]
    fn deep_link_import_rejects_invalid_input() {
        let (conn, crypto) = setup();
        let cases = [
            input("", &["https://a.example.com"], "sk", None, None),
            input("N", &["ftp://a.example.com"], "sk", None, None),
            input("N", &["https://a.example.com"], "", None, None),
            input("N", &["https://a.example.com"], "sk", Some("gemini"), None),
        ];
        for case in cases {
            let err = import_site_from_deep_link_conn(&conn, &crypto, case).unwrap_err();
            let msg = err.to_string();
            assert!(!msg.is_empty(), "expected validation error");
        }
    }
}
