//! The `project-api` contract family, version 1 (draft): the operations an
//! external principal — an agent over MCP, later — may call.
//!
//! ADR-031 owns the semantics; the canonical design is
//! docs/plans/agent-integration/brief-project-api-contract.md. The committed
//! artifacts in `src-tauri/contracts/project-api/v1/` are the contract of
//! record. The family stays `draft` until a release exposes an external
//! transport (brief §11); until then shapes may change, provided the
//! artifacts are regenerated.
//!
//! P1 (build plan) delivers `litria_files_read`. The other read operations
//! join the catalog in P3–P5.

pub(crate) mod files_read;

#[cfg(test)]
pub(crate) const FAMILY: &str = "project-api";
// Read by artifact generation today; `litria_project_context` returns it in
// production from build plan P3.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const API_VERSION: u32 = 1;
/// Published in the catalog; readers must not treat a draft as stable.
#[cfg(test)]
pub(crate) const STATUS: &str = "draft";

/// The family's operation catalog, in publication order.
#[cfg(test)]
pub(crate) fn catalog() -> Vec<crate::contracts::catalog::OperationEntry> {
    use crate::contracts::catalog::entry;
    vec![entry::<files_read::FilesReadOp>()]
}

/// A dispatcher whose handlers return the representative values in
/// `samples` — for the catalog, fixture and MCP-proof tests, which exercise
/// the contract rather than the service.
#[cfg(test)]
pub(crate) fn test_dispatcher() -> crate::contracts::catalog::Dispatcher {
    use crate::contracts::catalog::{Dispatcher, Limits};
    let mut dispatcher = Dispatcher::new(Limits {
        max_in_flight_per_principal: 4,
        max_response_bytes: 384 * 1024,
    });
    dispatcher.register::<files_read::FilesReadOp>(|_, _| Ok(samples::files_read_result()));
    dispatcher
}

/// Representative values: every outcome kind, for outbound conformance and
/// for the result fixtures (which must equal what Rust emits).
#[cfg(test)]
pub(crate) mod samples {
    use super::files_read::{DocumentOutcome, DocumentSource, FilesReadResult, LineRange};

    pub(crate) fn files_read_result() -> FilesReadResult {
        FilesReadResult {
            documents: vec![
                DocumentOutcome::Read {
                    path: "src/auth.ts".into(),
                    source: DocumentSource::Disk,
                    dirty: false,
                    revision: "d1-9f86d081884c7d659a2feaa0c55ad015".into(),
                    text: "export function signIn() {}\n".into(),
                    range: Some(LineRange {
                        start_line: 1,
                        end_line: 1,
                    }),
                    total_lines: 1,
                    truncated: false,
                    line_cut: false,
                },
                DocumentOutcome::Read {
                    path: "dist/bundle.min.js".into(),
                    source: DocumentSource::Disk,
                    dirty: false,
                    revision: "d1-2c26b46b68ffc68ff99b453c1d304134".into(),
                    text: "!function(){var a=".into(),
                    range: Some(LineRange {
                        start_line: 1,
                        end_line: 1,
                    }),
                    total_lines: 1,
                    truncated: true,
                    line_cut: true,
                },
                DocumentOutcome::Read {
                    path: "empty.txt".into(),
                    source: DocumentSource::Disk,
                    dirty: false,
                    revision: "d1-e3b0c44298fc1c149afbf4c8996fb924".into(),
                    text: String::new(),
                    range: None,
                    total_lines: 0,
                    truncated: false,
                    line_cut: false,
                },
                DocumentOutcome::NotFound {
                    path: "src/missing.ts".into(),
                },
                DocumentOutcome::Denied { path: ".env".into() },
                DocumentOutcome::NotFile { path: "src".into() },
                DocumentOutcome::NotText {
                    path: "assets/logo.png".into(),
                },
                DocumentOutcome::TooLarge {
                    path: "data/dump.sql".into(),
                    limit_bytes: 8 * 1024 * 1024,
                },
                DocumentOutcome::InvalidPath {
                    path: "../outside".into(),
                },
                DocumentOutcome::Unreadable {
                    path: "locked.log".into(),
                },
                DocumentOutcome::Skipped {
                    path: "src/later.ts".into(),
                },
            ],
        }
    }
}
