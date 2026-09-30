//! ADR-033 S0 — the contract schema pipeline, exercised end to end.
//!
//! Rust contract types are the source of truth. schemars derives JSON Schema
//! 2020-12 from them in both directions — inbound (what Rust accepts) and
//! outbound (what Rust emits) — and the results are committed under
//! `src-tauri/contracts/`. The Rust boundary enforces; the schema describes;
//! the tests in this module prove the two agree, and that mistakes in the
//! types, the committed artifacts, catalog registration and the MCP mapping
//! fail a test. (JavaScript handling is covered by
//! `test/domains/contractFixtures.test.mjs` against the same fixtures.)
//!
//! Design: docs/adrs/033-contract-schema-source-of-truth.md and
//! docs/plans/contracts/brief-contract-schemas.md §9.
//!
//! The whole module is `#[cfg(test)]` (see lib.rs): S0 ships nothing, and its
//! two dependencies are dev-dependencies. The shapes in `project_api` are
//! illustrative — ADR-031's canonical brief owns the real Project API.
//!
//! After changing a contract type, regenerate the committed artifacts with
//!   LITRIA_UPDATE_CONTRACTS=1 cargo test contracts::
//! and review the diff like any other change.

mod artifacts;
mod boundary;
mod catalog;
mod error;
mod fixtures;
mod mcp;
mod project_api;
