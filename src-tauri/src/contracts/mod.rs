//! ADR-033 — contract types and the machinery that checks them.
//!
//! Rust contract types are the source of truth. In test builds, schemars
//! derives JSON Schema 2020-12 from them in both directions — inbound (what
//! Rust accepts) and outbound (what Rust emits) — and the results are
//! committed under `src-tauri/contracts/`. The Rust boundary enforces; the
//! schema describes; the test-only modules prove the two agree, and that
//! mistakes in the types, the committed artifacts, catalog registration and
//! the MCP mapping fail a test.
//!
//! Production inclusion (Project API contract brief §12, Q6): the types,
//! boundary, catalog and error compile into the application; `JsonSchema` is
//! derived only under `cfg(test)`, so schemars 1.x stays a dev-dependency and
//! the shipped graph gains no crate. The running application never generates
//! schemas; when a transport publishes them (track T), it embeds the committed
//! files.
//!
//! Design: docs/adrs/033-contract-schema-source-of-truth.md,
//! docs/plans/contracts/brief-contract-schemas.md, and for the Project API
//! family docs/plans/agent-integration/brief-project-api-contract.md.
//!
//! After changing a contract type, regenerate the committed artifacts with
//!   LITRIA_UPDATE_CONTRACTS=1 cargo test contracts::
//! and review the diff like any other change.

pub(crate) mod boundary;
pub(crate) mod catalog;
pub(crate) mod context;
pub(crate) mod error;
pub(crate) mod project_api;

#[cfg(test)]
mod artifacts;
#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod mcp;
