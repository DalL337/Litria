//! `languages.capabilities` (Project API contract brief §7.1, §8): what Litria
//! can do for each kind of file in this session.
//!
//! Rows are capability classes, not just languages: flags can differ between
//! extensions of one language (relationship discovery covers `.ts` but not
//! `.mts`), so each row names the exact extensions its flags hold for.

#[cfg(test)]
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::BridgeOperation;
use crate::contracts::boundary::{invalid, schema_length, Validate};
use crate::contracts::error::ContractError;

pub(crate) const MAX_LANGUAGE_ROWS: usize = 32;
pub(crate) const MAX_LANGUAGE_ID_LENGTH: usize = 32;
pub(crate) const MAX_EXTENSIONS_PER_ROW: usize = 16;
pub(crate) const MAX_EXTENSION_LENGTH: usize = 16;

pub(crate) struct CapabilitiesOp;

impl BridgeOperation for CapabilitiesOp {
    const NAME: &'static str = "languages.capabilities";
    const DESCRIPTION: &'static str = "For each kind of file Litria recognises (a language and the exact extensions \
         that share its flags), what is available in this session: document access, diagnostics, navigation, \
         symbols, relationship discovery and source transformations, plus the state of its language server.";
    const OWNER: &'static str = "LanguageSupportDomain, SyntaxDomain";
    type Request = CapabilitiesRequest;
    type Result = CapabilitiesResult;
}

/// Rust → JavaScript: no parameters.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
pub(crate) struct CapabilitiesRequest {}

/// JavaScript → Rust.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CapabilitiesResult {
    #[cfg_attr(test, schemars(length(max = MAX_LANGUAGE_ROWS)))]
    pub languages: Vec<CapabilityRow>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CapabilityRow {
    /// The editor's language id (for example `typescript`).
    #[cfg_attr(test, schemars(length(min = 1, max = MAX_LANGUAGE_ID_LENGTH)))]
    pub language: String,
    /// Lower-case extensions with their dot (`.ts`), for which every flag
    /// below holds.
    #[cfg_attr(
        test,
        schemars(length(min = 1, max = MAX_EXTENSIONS_PER_ROW), inner(length(min = 2, max = MAX_EXTENSION_LENGTH)))
    )]
    pub extensions: Vec<String>,
    pub language_server: LanguageServerState,
    pub document_access: bool,
    pub diagnostics: bool,
    pub navigation: bool,
    pub symbols: bool,
    pub relationship_discovery: bool,
    pub source_transformations: bool,
}

/// The state of the language server that serves a row, as the editor knows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum LanguageServerState {
    Installed,
    NotInstalled,
    Error,
    /// Not checked yet in this session (it is checked when a file of the
    /// language is first shown).
    Unknown,
    /// Litria has no language server for this language.
    None,
}

impl Validate for CapabilitiesResult {
    fn validate(&self) -> Result<(), ContractError> {
        if self.languages.len() > MAX_LANGUAGE_ROWS {
            return Err(invalid(format!("languages: at most {MAX_LANGUAGE_ROWS}")));
        }
        for row in &self.languages {
            if !(1..=MAX_LANGUAGE_ID_LENGTH).contains(&schema_length(&row.language)) {
                return Err(invalid(format!("language: 1 to {MAX_LANGUAGE_ID_LENGTH} characters")));
            }
            if !(1..=MAX_EXTENSIONS_PER_ROW).contains(&row.extensions.len()) {
                return Err(invalid(format!("extensions: 1 to {MAX_EXTENSIONS_PER_ROW} entries")));
            }
            for extension in &row.extensions {
                if !(2..=MAX_EXTENSION_LENGTH).contains(&schema_length(extension)) {
                    return Err(invalid(format!("extensions: each 2 to {MAX_EXTENSION_LENGTH} characters")));
                }
            }
        }
        Ok(())
    }
}
