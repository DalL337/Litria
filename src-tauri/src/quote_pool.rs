// Litria Quote Pool
// -----------------
// Picks one random quote from quotes.json for stamping into a
// blank project's generated README.
//
// Design rules:
//   1. Quotes live in JSON (embedded via include_str! at the call site),
//      never in code.
//   2. This module is Tauri-agnostic: JSON string in -> Quote out.
//      The caller is responsible for loading the file.
//   3. Failure is silent and safe. Bad/missing JSON -> fallback quote.
//      A fortune cookie must never break project creation.

use rand::seq::IndexedRandom;
use serde::Deserialize;

/// One quote from the pool.
#[derive(Debug, Clone, Deserialize)]
pub struct Quote {
    #[allow(dead_code)]
    pub category: String,
    pub text: String,
}

/// Shape of quotes.json. The `version` field lets future code detect
/// schema changes without guessing.
#[derive(Debug, Deserialize)]
struct QuotePool {
    #[allow(dead_code)]
    version: u32,
    quotes: Vec<Quote>,
}

/// The quote used if anything at all goes wrong.
/// (Fitting, no?)
fn fallback_quote() -> Quote {
    Quote {
        category: "stoicism".to_string(),
        text: "The obstacle is not blocking the path. It is the path.".to_string(),
    }
}

/// Pick one random quote from a JSON string.
/// Never fails: malformed JSON or an empty pool returns the fallback.
pub fn random_quote(json: &str) -> Quote {
    serde_json::from_str::<QuotePool>(json)
        .ok()
        .and_then(|pool| pool.quotes.choose(&mut rand::rng()).cloned())
        .unwrap_or_else(fallback_quote)
}

/// Format a quote as a Markdown blockquote for the README.
/// Kept separate from picking so the README template can evolve
/// without touching selection logic.
pub fn as_markdown(quote: &Quote) -> String {
    format!("> *\"{}\"*\n", quote.text)
}

// ---------------------------------------------------------------------------
// Tests: run with `cargo test quote_pool`
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_a_quote_from_valid_json() {
        let json = r#"{
            "version": 1,
            "quotes": [
                { "category": "creativity", "text": "Every masterpiece began as someone's mess." }
            ]
        }"#;
        let q = random_quote(json);
        assert_eq!(q.text, "Every masterpiece began as someone's mess.");
    }

    #[test]
    fn falls_back_on_garbage_json() {
        let q = random_quote("this is not json at all {{{");
        assert_eq!(q.text, fallback_quote().text);
    }

    #[test]
    fn falls_back_on_empty_pool() {
        let q = random_quote(r#"{ "version": 1, "quotes": [] }"#);
        assert_eq!(q.text, fallback_quote().text);
    }

    #[test]
    fn markdown_wraps_as_blockquote() {
        let q = fallback_quote();
        let md = as_markdown(&q);
        assert!(md.starts_with("> *\""));
    }

    #[test]
    fn embedded_pool_parses_and_yields_a_real_quote() {
        // The actual bundled pool must never silently degrade to the fallback.
        let json = include_str!("quotes.json");
        let q = random_quote(json);
        assert_ne!(q.text, fallback_quote().text);
        assert!(!q.text.is_empty());
    }
}
