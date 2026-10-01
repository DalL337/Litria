//! The inbound boundary: the enforcement of record for a contract request
//! (ADR-033 decision 3). Three layers, in order:
//!
//! 1. an operational byte budget on the raw encoded request, applied before
//!    anything is parsed;
//! 2. typed deserialization — contract request types use
//!    `deny_unknown_fields`, so unknown input fields are rejected here;
//! 3. explicit validation of every constraint the inbound schema declares that
//!    serde does not enforce by itself (lengths, counts, ranges).
//!
//! The schema is never consulted at runtime. The fixture tests compare this
//! function's verdict with the inbound schema's, so a constraint the schema
//! declares but this code does not enforce — or enforces with a different
//! measurement — fails a test.

use serde::de::DeserializeOwned;

use super::error::{ContractError, ErrorCode};

/// Operational byte budget for one encoded request (an S0 value, not a
/// measured product limit). It measures encoded bytes, which JSON Schema has
/// no keyword for, so a request can be schema-valid and still exceed it.
pub(crate) const MAX_REQUEST_BYTES: usize = 64 * 1024;

/// Explicit validation of the schema-declared constraints serde leaves open.
pub(crate) trait Validate {
    fn validate(&self) -> Result<(), ContractError>;
}

/// The complete inbound boundary for one request.
pub(crate) fn accept<T: DeserializeOwned + Validate>(raw: &[u8]) -> Result<T, ContractError> {
    accept_within(raw, MAX_REQUEST_BYTES)
}

/// The same three layers with another family's byte budget: the bridge's
/// replies are inbound too, with a larger ceiling (contract brief §8, §10).
pub(crate) fn accept_within<T: DeserializeOwned + Validate>(raw: &[u8], limit: usize) -> Result<T, ContractError> {
    if raw.len() > limit {
        return Err(ContractError::new(
            ErrorCode::LimitExceeded,
            format!("the message is {} bytes; the limit is {limit}", raw.len()),
        ));
    }
    let value: T = serde_json::from_slice(raw)
        .map_err(|error| ContractError::new(ErrorCode::InvalidParams, parse_failure(&error)))?;
    value.validate()?;
    Ok(value)
}

/// A fixed message per failure category, with the position at most. serde's
/// own text quotes unknown field names and rejected values — the caller's
/// input — which must not flow back into messages or routine diagnostics
/// (Project API contract brief §9; agent brief §9).
pub(crate) fn parse_failure(error: &serde_json::Error) -> String {
    use serde_json::error::Category;
    let what = match error.classify() {
        Category::Syntax => "the request is not valid JSON",
        Category::Eof => "the request ended unexpectedly",
        Category::Data => "the request does not match the operation's input schema",
        Category::Io => "the request could not be read",
    };
    format!("{what} (line {}, column {})", error.line(), error.column())
}

/// A string's length as JSON Schema's `minLength`/`maxLength` measure it:
/// Unicode code points. `str::len` counts UTF-8 bytes and would disagree with
/// the schema on any non-ASCII text.
pub(crate) fn schema_length(value: &str) -> usize {
    value.chars().count()
}

pub(crate) fn invalid(message: impl Into<String>) -> ContractError {
    ContractError::new(ErrorCode::InvalidParams, message)
}
