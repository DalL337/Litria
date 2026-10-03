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
//! P1 (build plan) delivers `litria_files_read`; P3 adds
//! `litria_project_context` and `litria_files_search`. The graph and
//! diagnostics reads join the catalog in P4–P5.

pub(crate) mod files_read;
pub(crate) mod files_search;
pub(crate) mod graph_query;
pub(crate) mod project_context;

#[cfg(test)]
pub(crate) const FAMILY: &str = "project-api";
/// Returned by `litria_project_context`; also published in the catalog.
pub(crate) const API_VERSION: u32 = 1;
/// Published in the catalog; readers must not treat a draft as stable.
#[cfg(test)]
pub(crate) const STATUS: &str = "draft";

/// The family's operation catalog, in publication order.
#[cfg(test)]
pub(crate) fn catalog() -> Vec<crate::contracts::catalog::OperationEntry> {
    use crate::contracts::catalog::entry;
    vec![
        entry::<files_read::FilesReadOp>(),
        entry::<project_context::ProjectContextOp>(),
        entry::<files_search::FilesSearchOp>(),
        entry::<graph_query::GraphQueryOp>(),
    ]
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
    dispatcher.register::<project_context::ProjectContextOp>(|_, _| Ok(samples::project_context_result()));
    dispatcher.register::<files_search::FilesSearchOp>(|_, _| Ok(samples::files_search_result()));
    dispatcher.register::<graph_query::GraphQueryOp>(|_, _| Ok(samples::graph_query_result()));
    dispatcher
}

/// Representative values: every outcome kind, for outbound conformance and
/// for the result fixtures (which must equal what Rust emits).
#[cfg(test)]
pub(crate) mod samples {
    use super::files_read::{DocumentOutcome, DocumentSource, FilesReadResult, LineRange};
    use super::files_search::{FilesSearchResult, SearchMatch, SearchScope, SkippedCounts, TruncationReason};
    use super::graph_query::{
        EdgeProvenance, FocusOutcome, Freshness, GraphEdge, GraphNode, GraphQueryResult, GraphSymbol, IndexReason,
        IndexState, TruncationReason as GraphTruncationReason,
    };
    use super::project_context::{
        ActiveDocument, DeniedClass, DocumentsSummary, FilesReadLimits, FilesSearchLimits, GraphQueryLimits,
        LanguageCapabilities, LanguageServer, PolicySummary, ProjectContextLimits, ProjectContextResult,
        ProjectSummary, SelectionSummary, ServerLimits,
    };

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

    /// Every optional part present, every language-server state, every
    /// denied class.
    pub(crate) fn project_context_result() -> ProjectContextResult {
        let row = |language: &str, extensions: &[&str], language_server, flags: [bool; 6]| LanguageCapabilities {
            language: language.into(),
            extensions: extensions.iter().map(|extension| (*extension).to_owned()).collect(),
            language_server,
            document_access: flags[0],
            diagnostics: flags[1],
            navigation: flags[2],
            symbols: flags[3],
            relationship_discovery: flags[4],
            source_transformations: flags[5],
        };
        ProjectContextResult {
            api_version: 1,
            project: ProjectSummary {
                name: "Acme Web".into(),
                root_name: "acme-web".into(),
            },
            selection: SelectionSummary {
                paths: vec!["src/auth.ts".into(), "src/session.ts".into()],
                omitted: 0,
                folder: Some("src".into()),
                complete: true,
            },
            documents: DocumentsSummary {
                active: Some(ActiveDocument {
                    path: "src/auth.ts".into(),
                    dirty: true,
                }),
                open: vec!["README.md".into(), "src/auth.ts".into()],
                open_omitted: 0,
                dirty_count: 2,
                complete: true,
            },
            languages: vec![
                row("typescript", &[".ts", ".tsx"], LanguageServer::Installed, [true; 6]),
                row(
                    "python",
                    &[".py"],
                    LanguageServer::NotInstalled,
                    [true, false, true, true, true, true],
                ),
                row("rust", &[".rs"], LanguageServer::Unknown, [true, false, false, false, false, false]),
                row("go", &[".go"], LanguageServer::Error, [true, false, false, false, false, false]),
                row("json", &[".json"], LanguageServer::None, [true, true, false, true, false, false]),
            ],
            operations: vec![
                "litria_files_read".into(),
                "litria_files_search".into(),
                "litria_graph_query".into(),
                "litria_project_context".into(),
            ],
            limits: ServerLimits {
                max_request_bytes: 65536,
                max_response_bytes: 393216,
                max_in_flight: 4,
                files_read: FilesReadLimits {
                    max_documents: 20,
                    default_bytes_per_document: 65536,
                    max_bytes_per_document: 262144,
                    max_text_bytes_per_response: 262144,
                    max_file_bytes: 8388608,
                },
                files_search: FilesSearchLimits {
                    max_query_length: 256,
                    default_results: 50,
                    max_results: 200,
                    preview_length: 200,
                    max_files_scanned: 20000,
                    max_bytes_per_file: 1048576,
                    max_buffers: 500,
                    time_budget_ms: 2000,
                    max_concurrent_searches: 2,
                },
                project_context: ProjectContextLimits { max_listed_paths: 100 },
                graph: GraphQueryLimits {
                    default_depth: 1,
                    max_depth: 2,
                    default_max_nodes: 50,
                    max_nodes: 100,
                    max_edges: 500,
                    max_symbols_per_edge: 50,
                },
            },
            policy: PolicySummary {
                denied: vec![
                    DeniedClass::LitriaState,
                    DeniedClass::VersionControl,
                    DeniedClass::EnvironmentFiles,
                    DeniedClass::KeyMaterial,
                    DeniedClass::SshKeys,
                    DeniedClass::Credentials,
                ],
                unindexed_directories: vec!["node_modules".into(), "dist".into()],
                gitignore_honoured: false,
            },
        }
    }

    /// Both match kinds, both sources, every truncation reason.
    pub(crate) fn files_search_result() -> FilesSearchResult {
        FilesSearchResult {
            scope: SearchScope::Prefix,
            matches: vec![
                SearchMatch::Text {
                    path: "src/auth.ts".into(),
                    line: 12,
                    column: 17,
                    preview: "export function signIn(user: User) {".into(),
                    source: DocumentSource::Editor,
                    revision: "b1-0f3a9c2e5d7b8a1c4e6f0a2b3c4d5e6f".into(),
                },
                SearchMatch::Text {
                    path: "src/session.ts".into(),
                    line: 3,
                    column: 1,
                    preview: "signIn();".into(),
                    source: DocumentSource::Disk,
                    revision: "d1-9f86d081884c7d659a2feaa0c55ad015".into(),
                },
                SearchMatch::Path {
                    path: "src/signIn.test.ts".into(),
                    source: DocumentSource::Disk,
                },
                SearchMatch::Path {
                    path: "src/signInDraft.ts".into(),
                    source: DocumentSource::Editor,
                },
            ],
            truncated: true,
            truncated_by: vec![
                TruncationReason::Results,
                TruncationReason::FilesScanned,
                TruncationReason::TimeBudget,
                TruncationReason::BufferCoverage,
                TruncationReason::ResponseSize,
            ],
            skipped: SkippedCounts {
                too_large: 1,
                not_text: 2,
                unreadable: 1,
                unreadable_directories: 1,
                buffers_not_searched: 1,
                ignored_files: 4,
                ignored_directories: 2,
            },
            files_searched: 812,
            buffers_searched: 3,
        }
    }

    /// Both node kinds, every freshness, both edge provenances (including the
    /// domain-only `orphaned` status), every summary reason and truncation.
    pub(crate) fn graph_query_result() -> GraphQueryResult {
        GraphQueryResult {
            focus: FocusOutcome::Resolved,
            nodes: vec![
                GraphNode::File {
                    path: "src/auth.ts".into(),
                    on_canvas: true,
                    folder: Some("src".into()),
                    group_id: None,
                    freshness: Freshness::Current,
                    discoverable: true,
                },
                GraphNode::File {
                    path: "src/session.ts".into(),
                    on_canvas: true,
                    folder: None,
                    group_id: Some("group-7".into()),
                    freshness: Freshness::Stale,
                    discoverable: true,
                },
                GraphNode::File {
                    path: "src/legacy.ts".into(),
                    on_canvas: false,
                    folder: None,
                    group_id: None,
                    freshness: Freshness::Unknown,
                    discoverable: false,
                },
                GraphNode::Folder {
                    folder: Some("src".into()),
                    group_id: None,
                },
                GraphNode::Folder {
                    folder: None,
                    group_id: Some("group-7".into()),
                },
            ],
            edges: vec![
                GraphEdge {
                    importer: "src/auth.ts".into(),
                    exporter: "src/session.ts".into(),
                    symbols: vec![
                        GraphSymbol {
                            name: "createSession".into(),
                            kind: "function".into(),
                        },
                        GraphSymbol {
                            name: "Session".into(),
                            kind: "type".into(),
                        },
                    ],
                    provenance: EdgeProvenance::SourceDerived {
                        status: "resolved".into(),
                    },
                    on_canvas: true,
                },
                GraphEdge {
                    importer: "src/auth.ts".into(),
                    exporter: "src/legacy.ts".into(),
                    symbols: Vec::new(),
                    provenance: EdgeProvenance::SourceDerived {
                        status: "orphaned".into(),
                    },
                    on_canvas: false,
                },
                GraphEdge {
                    importer: "src/session.ts".into(),
                    exporter: "src/auth.ts".into(),
                    symbols: Vec::new(),
                    provenance: EdgeProvenance::Manual,
                    on_canvas: true,
                },
            ],
            summary: IndexState::Partial,
            reasons: vec![
                IndexReason::NotParsed,
                IndexReason::DiscoveryInFlight,
                IndexReason::StaleNodes,
                IndexReason::UnknownNodes,
                IndexReason::NoRelationshipDiscovery,
            ],
            truncated: true,
            truncated_by: vec![
                GraphTruncationReason::MaxNodes,
                GraphTruncationReason::Edges,
                GraphTruncationReason::Symbols,
                GraphTruncationReason::ResponseSize,
            ],
        }
    }
}
