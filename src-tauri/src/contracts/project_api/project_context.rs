//! `litria_project_context` (Project API contract brief §6, §7.1, §10): a small
//! orientation read.
//!
//! It never returns the workspace epoch (the channel is already bound; an
//! epoch in a result would invite a model to hand it back as if it conferred
//! authority) and never an absolute path. Every path it lists or counts has
//! passed the disclosure policy first.

#[cfg(test)]
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::contracts::boundary::Validate;
use crate::contracts::catalog::Operation;
use crate::contracts::error::ContractError;

/// Paths listed per list (selection, open documents). More are counted.
pub(crate) const MAX_LISTED_PATHS: usize = 100;

pub(crate) struct ProjectContextOp;

impl Operation for ProjectContextOp {
    const NAME: &'static str = "litria_project_context";
    const DESCRIPTION: &'static str = "Orientation for this project: its name, what is selected on the canvas, which \
         documents the editor holds open or unsaved, what Litria can do for each kind of file, the operations this \
         connection may call, the server's limits, and a summary of what the disclosure policy withholds. Paths are \
         project-relative; withheld paths are never listed or counted.";
    const CAPABILITY: &'static str = "project.context.read";
    type Request = ProjectContextRequest;
    type Result = ProjectContextResult;
}

/// No parameters.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(deny_unknown_fields)]
pub(crate) struct ProjectContextRequest {}

impl Validate for ProjectContextRequest {
    fn validate(&self) -> Result<(), ContractError> {
        Ok(())
    }
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectContextResult {
    /// The `project-api` family version this server speaks.
    pub api_version: u32,
    pub project: ProjectSummary,
    pub selection: SelectionSummary,
    pub documents: DocumentsSummary,
    /// What Litria can do for each kind of file in this session.
    pub languages: Vec<LanguageCapabilities>,
    /// The operations this connection may call, by name.
    pub operations: Vec<String>,
    pub limits: ServerLimits,
    pub policy: PolicySummary,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSummary {
    /// The project's name, as its `litria.toml` gave it.
    pub name: String,
    /// The name of the project's root folder (never its full path).
    pub root_name: String,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectionSummary {
    /// Files selected on the canvas, in path order, at most 100.
    pub paths: Vec<String>,
    /// Further selected files that were not listed.
    pub omitted: u32,
    /// The selected folder group's path, when one is selected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// False when the editor reported more selected files than it listed;
    /// those could not be checked, so `omitted` leaves them out.
    pub complete: bool,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentsSummary {
    /// The document the editor shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<ActiveDocument>,
    /// Documents open in the editor, in path order, at most 100.
    pub open: Vec<String>,
    /// Further open documents that were not listed.
    pub open_omitted: u32,
    /// Documents with unsaved changes, open or closed.
    pub dirty_count: u32,
    /// False when the editor held more buffers than it listed; the counts
    /// above then leave those out.
    pub complete: bool,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActiveDocument {
    pub path: String,
    /// Whether the editor holds unsaved changes for it.
    pub dirty: bool,
}

/// One kind of file: a language and the exact extensions its flags hold for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanguageCapabilities {
    /// The editor's language id, for example `typescript`.
    pub language: String,
    /// Lower-case extensions with their dot, for example `.ts`.
    pub extensions: Vec<String>,
    pub language_server: LanguageServer,
    /// Its files can be read through the API.
    pub document_access: bool,
    /// The editor reports errors and warnings for it now.
    pub diagnostics: bool,
    /// The editor can go to definitions or references.
    pub navigation: bool,
    /// The editor lists the symbols a file declares.
    pub symbols: bool,
    /// Litria discovers import relationships between its files (the canvas
    /// graph).
    pub relationship_discovery: bool,
    /// Wiring files on the canvas can write import code into them.
    pub source_transformations: bool,
}

/// A reader that meets an unfamiliar value must treat the server as unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum LanguageServer {
    Installed,
    NotInstalled,
    Error,
    /// Not checked yet in this session.
    Unknown,
    /// Litria has no language server for this language.
    None,
}

/// The server's ceilings (contract brief §10). Server ceilings are
/// authoritative: a request over one is refused or answered in part.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerLimits {
    /// Encoded request, checked before parsing.
    pub max_request_bytes: u32,
    /// Encoded response, any operation.
    pub max_response_bytes: u32,
    /// Operations one connection may have in flight at once.
    pub max_in_flight: u32,
    pub files_read: FilesReadLimits,
    pub files_search: FilesSearchLimits,
    pub project_context: ProjectContextLimits,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilesReadLimits {
    pub max_documents: u32,
    pub default_bytes_per_document: u32,
    pub max_bytes_per_document: u32,
    pub max_text_bytes_per_response: u32,
    /// Larger files are answered `tooLarge`.
    pub max_file_bytes: u32,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilesSearchLimits {
    pub max_query_length: u32,
    pub default_results: u32,
    pub max_results: u32,
    pub preview_length: u32,
    pub max_files_scanned: u32,
    /// Larger files and buffers are counted as too large, not searched.
    pub max_bytes_per_file: u32,
    pub max_buffers: u32,
    pub time_budget_ms: u32,
    pub max_concurrent_searches: u32,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectContextLimits {
    pub max_listed_paths: u32,
}

/// What the disclosure policy withholds, by class — never a list of files.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct PolicySummary {
    /// Never disclosed on any surface.
    pub denied: Vec<DeniedClass>,
    /// Directory names search and the graph never enter, at any depth.
    /// Their files are still readable by explicit path.
    pub unindexed_directories: Vec<String>,
    /// Search skips what the project's `.gitignore` files exclude unless a
    /// request sets `includeIgnored`, and counts what it skipped. Ignored
    /// files stay readable by explicit path: `.gitignore` is never a
    /// disclosure rule.
    pub gitignore_honoured: bool,
}

/// A reader that meets an unfamiliar class must still treat it as withheld.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeniedClass {
    /// `.litria/`, `litria.toml`.
    LitriaState,
    /// `.git`, `.hg/`, `.svn/`.
    VersionControl,
    /// `.env` and `.env.*`, except the template files `.env.example`,
    /// `.env.sample`, `.env.template` and `.env.dist`.
    EnvironmentFiles,
    /// `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`.
    KeyMaterial,
    /// `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`.
    SshKeys,
    /// `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.ssh/`, `.aws/`,
    /// `.gnupg/`.
    Credentials,
}
