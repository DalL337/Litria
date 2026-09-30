//! The S0 exemplar family: two illustrative Project API read operations.
//!
//! These are NOT the Project API contract — ADR-031's canonical brief owns its
//! operations, outcomes, authorization and limits. The shapes exist to put the
//! ADR-033 pipeline under realistic serde load: defaulted, optional and
//! omitted-when-empty fields, a `kind`-tagged outcome union, bounded strings
//! and arrays, a bounded integer, and a structured error. The bounds are S0
//! values, not measured product limits.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::boundary::{invalid, schema_length, Validate};
use super::catalog::{entry, Dispatcher, Operation, OperationEntry};
use super::error::ContractError;

pub(crate) const FAMILY: &str = "project-api";
/// Version 0: pre-contract. The first real Project API contract starts at 1.
pub(crate) const API_VERSION: u32 = 0;

pub(crate) const MIN_READ_PATHS: usize = 1;
pub(crate) const MAX_READ_PATHS: usize = 20;
pub(crate) const MIN_PATH_LENGTH: usize = 1;
pub(crate) const MAX_PATH_LENGTH: usize = 1024;
pub(crate) const MIN_DOCUMENT_BYTES: u32 = 1;
pub(crate) const MAX_DOCUMENT_BYTES: u32 = 1024 * 1024;

// ---------------------------------------------------------------------------
// litria_project_context
// ---------------------------------------------------------------------------

pub(crate) struct ProjectContextOp;

impl Operation for ProjectContextOp {
    const NAME: &'static str = "litria_project_context";
    const DESCRIPTION: &'static str =
        "Small project summary: workspace epoch, name, optional selection and per-language capabilities.";
    const CAPABILITY: &'static str = "project.context.read";
    type Request = ProjectContextRequest;
    type Result = ProjectContext;
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProjectContextRequest {
    /// Include the current canvas selection. Defaults to false.
    #[serde(default)]
    pub include_selection: bool,
}

impl Validate for ProjectContextRequest {
    fn validate(&self) -> Result<(), ContractError> {
        Ok(())
    }
}

#[derive(Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectContext {
    /// Opaque workspace epoch (ADR-032). A string, never a JSON number.
    pub workspace_epoch: String,
    pub project_name: String,
    /// Omitted from output when empty; defaults to empty on input.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selection: Vec<NodeRef>,
    pub languages: Vec<LanguageCapabilities>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeRef {
    /// Opaque node identifier.
    pub node_id: String,
    /// Project-relative path, when the node is backed by a file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// One language's capabilities, reported separately: installing a language
/// server does not imply all six.
#[derive(Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanguageCapabilities {
    pub language_id: String,
    pub document_access: bool,
    pub diagnostics: bool,
    pub navigation: bool,
    pub symbols: bool,
    pub relationship_discovery: bool,
    pub source_transformations: bool,
}

// ---------------------------------------------------------------------------
// litria_files_read
// ---------------------------------------------------------------------------

pub(crate) struct FilesReadOp;

impl Operation for FilesReadOp {
    const NAME: &'static str = "litria_files_read";
    const DESCRIPTION: &'static str =
        "Read documents by project-relative path: the effective open buffer unless disk is requested.";
    const CAPABILITY: &'static str = "project.files.read";
    type Request = FilesReadRequest;
    type Result = FilesReadResult;
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FilesReadRequest {
    /// Project-relative paths to read.
    #[schemars(
        length(min = MIN_READ_PATHS, max = MAX_READ_PATHS),
        inner(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH))
    )]
    pub paths: Vec<String>,
    /// Which text to return. Defaults to the effective (open-buffer) text.
    #[serde(default)]
    pub source: ReadSource,
    /// Per-document text budget in bytes; absent means the server default.
    #[serde(default)]
    #[schemars(range(min = MIN_DOCUMENT_BYTES, max = MAX_DOCUMENT_BYTES))]
    pub max_bytes_per_document: Option<u32>,
}

impl Validate for FilesReadRequest {
    fn validate(&self) -> Result<(), ContractError> {
        let count = self.paths.len();
        if !(MIN_READ_PATHS..=MAX_READ_PATHS).contains(&count) {
            return Err(invalid(format!(
                "paths: expected {MIN_READ_PATHS} to {MAX_READ_PATHS} entries, got {count}"
            )));
        }
        for path in &self.paths {
            let length = schema_length(path);
            if !(MIN_PATH_LENGTH..=MAX_PATH_LENGTH).contains(&length) {
                return Err(invalid(format!(
                    "paths: each entry must be {MIN_PATH_LENGTH} to {MAX_PATH_LENGTH} characters, got {length}"
                )));
            }
        }
        if let Some(bytes) = self.max_bytes_per_document {
            if !(MIN_DOCUMENT_BYTES..=MAX_DOCUMENT_BYTES).contains(&bytes) {
                return Err(invalid(format!(
                    "maxBytesPerDocument: expected {MIN_DOCUMENT_BYTES} to {MAX_DOCUMENT_BYTES}, got {bytes}"
                )));
            }
        }
        Ok(())
    }
}

/// Inbound-only, but `Serialize` too: schemars emits a field's `default` only
/// when it can serialize the default value, and callers should see it.
#[derive(Debug, Default, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReadSource {
    /// The open buffer when the document is open, otherwise disk.
    #[default]
    Effective,
    /// The saved file, even when a dirty buffer exists.
    Disk,
}

#[derive(Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilesReadResult {
    pub documents: Vec<DocumentOutcome>,
}

/// Per-document outcome. A reader that meets an unfamiliar `kind` must treat
/// it as unknown, never as one of these.
#[derive(Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum DocumentOutcome {
    Read {
        path: String,
        /// Opaque document identity.
        document_id: String,
        /// Opaque revision token.
        revision: String,
        source: DocumentSource,
        /// Defaulted on input (a producer may omit it); always emitted on
        /// output — the field that makes this type's two directions differ.
        #[serde(default)]
        dirty: bool,
        text: String,
    },
    NotFound {
        path: String,
    },
    Denied {
        path: String,
    },
    TooLarge {
        path: String,
        limit_bytes: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DocumentSource {
    Editor,
    Disk,
}

// ---------------------------------------------------------------------------
// Catalog, dispatch and representative values
// ---------------------------------------------------------------------------

/// The family's operation catalog, in publication order.
pub(crate) fn catalog() -> Vec<OperationEntry> {
    vec![entry::<ProjectContextOp>(), entry::<FilesReadOp>()]
}

/// A dispatcher whose handlers stand in for the live owners and return the
/// representative values below.
pub(crate) fn sample_dispatcher() -> Dispatcher {
    let mut dispatcher = Dispatcher::default();
    dispatcher
        .register::<ProjectContextOp>(|request| Ok(samples::project_context(request.include_selection)))
        .register::<FilesReadOp>(|request| Ok(samples::files_read_result_from(request.source)));
    dispatcher
}

pub(crate) mod samples {
    use super::*;

    pub(crate) fn project_context(with_selection: bool) -> ProjectContext {
        let selection = if with_selection {
            vec![
                NodeRef {
                    node_id: "node-7f3a".into(),
                    path: Some("src/auth.ts".into()),
                },
                NodeRef {
                    node_id: "node-group-02".into(),
                    path: None,
                },
            ]
        } else {
            Vec::new()
        };
        ProjectContext {
            workspace_epoch: "ws-12".into(),
            project_name: "alice-shop".into(),
            selection,
            languages: vec![
                LanguageCapabilities {
                    language_id: "typescript".into(),
                    document_access: true,
                    diagnostics: true,
                    navigation: true,
                    symbols: true,
                    relationship_discovery: true,
                    source_transformations: true,
                },
                LanguageCapabilities {
                    language_id: "go".into(),
                    document_access: true,
                    diagnostics: true,
                    navigation: false,
                    symbols: false,
                    relationship_discovery: false,
                    source_transformations: false,
                },
            ],
        }
    }

    /// The effective-source answer, as a disk read would see it when asked:
    /// saved text only, so never dirty.
    pub(crate) fn files_read_result_from(requested: ReadSource) -> FilesReadResult {
        let mut result = files_read_result();
        if requested == ReadSource::Disk {
            for document in &mut result.documents {
                if let DocumentOutcome::Read { source, dirty, .. } = document {
                    *source = DocumentSource::Disk;
                    *dirty = false;
                }
            }
        }
        result
    }

    pub(crate) fn files_read_result() -> FilesReadResult {
        FilesReadResult {
            documents: vec![
                DocumentOutcome::Read {
                    path: "src/auth.ts".into(),
                    document_id: "doc-9007199254740993".into(),
                    revision: "rev-42".into(),
                    source: DocumentSource::Editor,
                    dirty: true,
                    text: "export function signIn() {}\n".into(),
                },
                DocumentOutcome::Read {
                    path: "README.md".into(),
                    document_id: "doc-3".into(),
                    revision: "rev-7".into(),
                    source: DocumentSource::Disk,
                    dirty: false,
                    text: "# alice-shop\n".into(),
                },
                DocumentOutcome::NotFound {
                    path: "src/missing.ts".into(),
                },
                DocumentOutcome::Denied {
                    path: ".env".into(),
                },
                DocumentOutcome::TooLarge {
                    path: "assets/bundle.js".into(),
                    limit_bytes: MAX_DOCUMENT_BYTES,
                },
            ],
        }
    }
}
