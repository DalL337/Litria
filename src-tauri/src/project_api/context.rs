//! `litria_project_context` (Project API contract brief §6, §7.1, §10).
//!
//! The editor's owners answer three bridge requests — the selection, the
//! buffer index and the language capabilities — and Rust builds the answer.
//! Every path the owners return passes the disclosure policy, on its own name
//! and on its canonical target, before it is listed or counted: a denied
//! `.env` open in a dirty tab appears nowhere and is not counted.

use std::path::Path;

use rusqlite::OptionalExtension;

use super::bridge::{self, Bridge};
use super::files_read::MAX_TEXT_PER_RESPONSE;
use super::policy::{denied_classes, unindexed_directories};
use super::reader::{identity, Identity, HARD_CAP_BYTES};
use super::search::{MAX_CONCURRENT_SEARCHES, MAX_FILES_SCANNED, SCAN_CAP_BYTES, TIME_BUDGET};
use super::{workspace, LIMITS, MAX_RESPONSE_BYTES};
use crate::contracts::boundary::MAX_REQUEST_BYTES;
use crate::contracts::context::CallContext;
use crate::contracts::error::{ContractError, ErrorCode};
use crate::contracts::project_api::files_read::{DEFAULT_BYTES_PER_DOCUMENT, MAX_BYTES_PER_DOCUMENT, MAX_DOCUMENTS};
use crate::contracts::project_api::files_search::{DEFAULT_RESULTS, MAX_QUERY_LENGTH, MAX_RESULTS, PREVIEW_LENGTH};
use crate::contracts::project_api::project_context::{
    ActiveDocument, DocumentsSummary, FilesReadLimits, FilesSearchLimits, LanguageCapabilities, LanguageServer,
    PolicySummary, ProjectContextLimits, ProjectContextRequest, ProjectContextResult, ProjectSummary,
    SelectionSummary, ServerLimits, MAX_LISTED_PATHS,
};
use crate::contracts::project_api::API_VERSION;
use crate::contracts::project_api_bridge::editor::{
    BufferIndexOp, BufferIndexRequest, BufferIndexResult, BufferState, MAX_INDEX_ENTRIES,
};
use crate::contracts::project_api_bridge::languages::{
    CapabilitiesOp, CapabilitiesRequest, CapabilitiesResult, LanguageServerState,
};
use crate::contracts::project_api_bridge::workspace::{SelectionOp, SelectionRequest, SelectionResult, MAX_SELECTED_PATHS};
use crate::db;

pub(crate) fn handle(context: &CallContext, _request: ProjectContextRequest) -> Result<ProjectContextResult, ContractError> {
    let operations = super::dispatcher().operations_for(&context.grant);
    let mut editor = BridgeEditor {
        bridge: bridge::global(),
        epoch: &context.epoch,
    };
    handle_with(context, &mut editor, operations, MAX_RESPONSE_BYTES)
}

/// Where the owners' answers come from: the bridge in production, a script
/// in tests.
pub(crate) trait ContextEditor {
    fn selection(&mut self) -> Result<SelectionResult, ContractError>;
    fn buffer_index(&mut self) -> Result<BufferIndexResult, ContractError>;
    fn capabilities(&mut self) -> Result<CapabilitiesResult, ContractError>;
}

struct BridgeEditor<'a> {
    bridge: &'a Bridge,
    epoch: &'a str,
}

impl ContextEditor for BridgeEditor<'_> {
    fn selection(&mut self) -> Result<SelectionResult, ContractError> {
        self.bridge.call::<SelectionOp>(
            self.epoch,
            &SelectionRequest {
                max_paths: MAX_SELECTED_PATHS,
            },
        )
    }

    fn buffer_index(&mut self) -> Result<BufferIndexResult, ContractError> {
        self.bridge.call::<BufferIndexOp>(
            self.epoch,
            &BufferIndexRequest {
                max_entries: MAX_INDEX_ENTRIES,
            },
        )
    }

    fn capabilities(&mut self) -> Result<CapabilitiesResult, ContractError> {
        self.bridge.call::<CapabilitiesOp>(self.epoch, &CapabilitiesRequest {})
    }
}

pub(crate) fn handle_with(
    context: &CallContext,
    editor: &mut dyn ContextEditor,
    operations: Vec<String>,
    ceiling: usize,
) -> Result<ProjectContextResult, ContractError> {
    workspace::fenced(context, |root| {
        let project = project_summary(&context.epoch, root)?;
        let selection = editor.selection()?;
        let index = editor.buffer_index()?;
        let capabilities = editor.capabilities()?;
        Ok(fit(build(root, project, selection, index, capabilities, operations), ceiling))
    })
}

/// The name the project's `litria.toml` gave it, as the workspace recorded it
/// when it opened — read through the epoch-checked connection, so it is this
/// workspace's name or an error. The root folder's name, never its path.
fn project_summary(epoch: &str, root: &Path) -> Result<ProjectSummary, ContractError> {
    let root_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_owned();
    let name = db::with_workspace_db(epoch, |conn| {
        conn.query_row("SELECT name FROM project LIMIT 1", [], |row| row.get::<_, String>(0))
            .optional()
            .map_err(db::DbError::sqlite("read the project name"))
    })
    .map_err(|error| match error {
        db::DbError::WorkspaceChanged { .. } => ContractError::new(
            ErrorCode::WorkspaceChanged,
            "the open project changed since this connection attached",
        ),
        _ => ContractError::new(ErrorCode::Internal, "the project's name could not be read"),
    })?;
    Ok(ProjectSummary {
        name: name.unwrap_or_else(|| root_name.clone()),
        root_name,
    })
}

fn build(
    root: &Path,
    project: ProjectSummary,
    selection: SelectionResult,
    index: BufferIndexResult,
    capabilities: CapabilitiesResult,
    operations: Vec<String>,
) -> ProjectContextResult {
    // Valid, and allowed on both the name and what it resolves to.
    let disclosed = |path: &str| matches!(identity(root, path), Identity::Key(_));

    let mut selected: Vec<String> = selection.selected.into_iter().filter(|path| disclosed(path)).collect();
    selected.sort();
    selected.dedup();
    let (paths, omitted) = listed(selected);

    let entries: Vec<_> = index.entries.into_iter().filter(|entry| disclosed(&entry.path)).collect();
    let dirty_count = entries.iter().filter(|entry| entry.dirty).count() as u32;
    let mut open: Vec<String> = entries
        .into_iter()
        .filter(|entry| entry.state == BufferState::Open)
        .map(|entry| entry.path)
        .collect();
    open.sort();
    open.dedup();
    let (open, open_omitted) = listed(open);

    ProjectContextResult {
        api_version: API_VERSION,
        project,
        selection: SelectionSummary {
            paths,
            omitted,
            folder: selection.folder.filter(|folder| disclosed(folder)),
            complete: selection.omitted == 0,
        },
        documents: DocumentsSummary {
            active: selection
                .active_document
                .filter(|active| disclosed(&active.path))
                .map(|active| ActiveDocument {
                    path: active.path,
                    dirty: active.dirty,
                }),
            open,
            open_omitted,
            dirty_count,
            complete: index.omitted == 0,
        },
        languages: capabilities.languages.into_iter().map(language).collect(),
        operations,
        limits: limits(),
        policy: PolicySummary {
            denied: denied_classes(),
            unindexed_directories: unindexed_directories(),
            gitignore_honoured: true,
        },
    }
}

/// At most `MAX_LISTED_PATHS`, and how many more there were.
fn listed(mut paths: Vec<String>) -> (Vec<String>, u32) {
    let omitted = paths.len().saturating_sub(MAX_LISTED_PATHS);
    paths.truncate(MAX_LISTED_PATHS);
    (paths, omitted as u32)
}

/// Within the encoded `ceiling`: listed paths move into the omitted counts,
/// the longer list first, until the result fits. Paths are bounded, so this
/// only matters for many very long names.
fn fit(mut result: ProjectContextResult, ceiling: usize) -> ProjectContextResult {
    let size = |result: &ProjectContextResult| serde_json::to_vec(result).map_or(usize::MAX, |bytes| bytes.len());
    while size(&result) > ceiling {
        let documents = &mut result.documents;
        let selection = &mut result.selection;
        if documents.open.len() >= selection.paths.len() && documents.open.pop().is_some() {
            documents.open_omitted += 1;
        } else if selection.paths.pop().is_some() {
            selection.omitted += 1;
        } else {
            break; // nothing left to shed; the dispatcher's ceiling is the backstop
        }
    }
    result
}

fn language(row: crate::contracts::project_api_bridge::languages::CapabilityRow) -> LanguageCapabilities {
    LanguageCapabilities {
        language: row.language,
        extensions: row.extensions,
        language_server: match row.language_server {
            LanguageServerState::Installed => LanguageServer::Installed,
            LanguageServerState::NotInstalled => LanguageServer::NotInstalled,
            LanguageServerState::Error => LanguageServer::Error,
            LanguageServerState::Unknown => LanguageServer::Unknown,
            LanguageServerState::None => LanguageServer::None,
        },
        document_access: row.document_access,
        diagnostics: row.diagnostics,
        navigation: row.navigation,
        symbols: row.symbols,
        relationship_discovery: row.relationship_discovery,
        source_transformations: row.source_transformations,
    }
}

fn limits() -> ServerLimits {
    ServerLimits {
        max_request_bytes: MAX_REQUEST_BYTES as u32,
        max_response_bytes: MAX_RESPONSE_BYTES as u32,
        max_in_flight: LIMITS.max_in_flight_per_principal as u32,
        files_read: FilesReadLimits {
            max_documents: MAX_DOCUMENTS as u32,
            default_bytes_per_document: DEFAULT_BYTES_PER_DOCUMENT,
            max_bytes_per_document: MAX_BYTES_PER_DOCUMENT,
            max_text_bytes_per_response: MAX_TEXT_PER_RESPONSE as u32,
            max_file_bytes: HARD_CAP_BYTES as u32,
        },
        files_search: FilesSearchLimits {
            max_query_length: MAX_QUERY_LENGTH as u32,
            default_results: DEFAULT_RESULTS,
            max_results: MAX_RESULTS,
            preview_length: PREVIEW_LENGTH as u32,
            max_files_scanned: MAX_FILES_SCANNED,
            max_bytes_per_file: SCAN_CAP_BYTES,
            max_buffers: MAX_INDEX_ENTRIES,
            time_budget_ms: TIME_BUDGET.as_millis() as u32,
            max_concurrent_searches: MAX_CONCURRENT_SEARCHES as u32,
        },
        project_context: ProjectContextLimits {
            max_listed_paths: MAX_LISTED_PATHS as u32,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::context::{Grant, Principal};
    use crate::contracts::project_api::files_read::FilesReadOp;
    use crate::contracts::project_api::files_search::FilesSearchOp;
    use crate::contracts::project_api::project_context::{DeniedClass, ProjectContextOp};
    use crate::contracts::catalog::Operation;
    use crate::contracts::project_api_bridge::editor::BufferIndexEntry;
    use crate::contracts::project_api_bridge::languages::CapabilityRow;
    use crate::contracts::project_api_bridge::workspace::ActiveDocument as SelectedActive;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn temp_root(tag: &str) -> PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("litria-api-context-{tag}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    fn put(root: &Path, path: &str) {
        let full = root.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, "x").unwrap();
    }

    /// Opens a workspace for `root` with a project row named `name`.
    fn open(root: &Path, name: Option<&str>) -> String {
        let (_ro, epoch) = db::open_workspace_db(root).unwrap();
        if let Some(name) = name {
            db::with_workspace_db(&epoch, |conn| {
                conn.execute(
                    "INSERT INTO project (instance_id, name, app_version, created_at, updated_at) \
                     VALUES ('i', ?1, 't', 't', 't')",
                    [name],
                )
                .map(|_| ())
                .map_err(db::DbError::sqlite("seed"))
            })
            .unwrap();
        }
        epoch
    }

    fn context_for(epoch: &str) -> CallContext {
        CallContext {
            principal: Principal::Test,
            grant: Grant::of([ProjectContextOp::CAPABILITY]),
            epoch: epoch.to_owned(),
        }
    }

    fn row(language: &str, extensions: &[&str], server: LanguageServerState, flags: [bool; 6]) -> CapabilityRow {
        CapabilityRow {
            language: language.into(),
            extensions: extensions.iter().map(|extension| (*extension).to_owned()).collect(),
            language_server: server,
            document_access: flags[0],
            diagnostics: flags[1],
            navigation: flags[2],
            symbols: flags[3],
            relationship_discovery: flags[4],
            source_transformations: flags[5],
        }
    }

    fn entry(path: &str, state: BufferState, dirty: bool) -> BufferIndexEntry {
        BufferIndexEntry {
            path: path.into(),
            state,
            dirty,
            revision: "b1-x".into(),
            byte_length: 1,
        }
    }

    #[derive(Default)]
    struct Scripted {
        selected: Vec<String>,
        selection_omitted: u32,
        folder: Option<String>,
        active: Option<(String, bool)>,
        entries: Vec<BufferIndexEntry>,
        index_omitted: u32,
        languages: Vec<CapabilityRow>,
        fail: Option<ErrorCode>,
    }

    impl ContextEditor for Scripted {
        fn selection(&mut self) -> Result<SelectionResult, ContractError> {
            if let Some(code) = self.fail {
                return Err(ContractError::new(code, "scripted"));
            }
            Ok(SelectionResult {
                selected: self.selected.clone(),
                omitted: self.selection_omitted,
                folder: self.folder.clone(),
                active_document: self.active.clone().map(|(path, dirty)| SelectedActive { path, dirty }),
            })
        }

        fn buffer_index(&mut self) -> Result<BufferIndexResult, ContractError> {
            Ok(BufferIndexResult {
                entries: std::mem::take(&mut self.entries),
                omitted: self.index_omitted,
            })
        }

        fn capabilities(&mut self) -> Result<CapabilitiesResult, ContractError> {
            Ok(CapabilitiesResult {
                languages: std::mem::take(&mut self.languages),
            })
        }
    }

    fn operations() -> Vec<String> {
        vec!["litria_project_context".into()]
    }

    /// Codex review F2 (2026-10-01): the selected folder is a DIRECTORY, so it
    /// is judged as one — a folder the user withholds (`private/`) or named
    /// like an environment template is never named in the summary.
    #[test]
    fn a_withheld_selected_folder_is_not_named() {
        let _serial = db::serial_guard();
        let _user = crate::project_api::policy::tests::Withholding::patterns("private/");
        let root = temp_root("withheld-folder");
        put(&root, "private/plan.md");
        put(&root, ".env.example/notes.md");
        put(&root, "src/a.ts");
        let epoch = open(&root, None);
        for (folder, shown) in [("private", false), (".env.example", false), ("src", true)] {
            let mut editor = Scripted {
                folder: Some(folder.into()),
                ..Scripted::default()
            };
            let result = handle_with(&context_for(&epoch), &mut editor, operations(), MAX_RESPONSE_BYTES).unwrap();
            assert_eq!(result.selection.folder.is_some(), shown, "{folder}");
        }
    }

    #[test]
    fn orients_without_an_epoch_or_an_absolute_path() {
        let _serial = db::serial_guard();
        let root = temp_root("orient");
        put(&root, "src/a.ts");
        put(&root, "src/b.ts");
        put(&root, "README.md");
        let epoch = open(&root, Some("Acme Web"));
        let mut editor = Scripted {
            selected: vec!["src/b.ts".into(), "src/a.ts".into(), "src/a.ts".into()],
            folder: Some("src".into()),
            active: Some(("src/a.ts".into(), true)),
            entries: vec![
                entry("README.md", BufferState::Open, false),
                entry("src/a.ts", BufferState::Open, true),
                entry("src/gone.ts", BufferState::ClosedDirty, true),
            ],
            languages: vec![row("typescript", &[".ts"], LanguageServerState::Installed, [true; 6])],
            ..Scripted::default()
        };
        let result = handle_with(&context_for(&epoch), &mut editor, operations(), MAX_RESPONSE_BYTES).unwrap();

        assert_eq!(result.api_version, 1);
        assert_eq!(result.project.name, "Acme Web");
        assert_eq!(result.project.root_name, root.file_name().unwrap().to_str().unwrap());
        assert_eq!(result.selection.paths, ["src/a.ts", "src/b.ts"], "path order, without duplicates");
        assert_eq!(result.selection.folder.as_deref(), Some("src"));
        assert!(result.selection.complete);
        assert_eq!(result.documents.open, ["README.md", "src/a.ts"]);
        assert_eq!(result.documents.dirty_count, 2, "open and closed unsaved documents");
        assert_eq!(
            result.documents.active,
            Some(ActiveDocument {
                path: "src/a.ts".into(),
                dirty: true
            })
        );
        assert_eq!(result.languages[0].language_server, LanguageServer::Installed);
        assert_eq!(result.policy.denied.len(), 6);
        assert!(result.policy.unindexed_directories.contains(&"node_modules".to_owned()));
        assert!(
            !result.policy.unindexed_directories.iter().any(|name| name == ".git" || name == ".litria"),
            "denied wins: never described as merely unindexed"
        );
        assert!(result.policy.gitignore_honoured);

        let text = serde_json::to_string(&result).unwrap();
        assert!(!text.contains(&epoch), "the epoch is never returned");
        let absolute = root.to_string_lossy().replace('\\', "\\\\");
        assert!(!text.contains(&absolute), "no absolute path");
        let parent = root.parent().unwrap().to_string_lossy().replace('\\', "\\\\");
        assert!(!text.contains(&parent), "no part of the absolute root");
        db::close_workspace_db().unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    /// A denied file selected, open, active and dirty — and a link to one —
    /// is listed nowhere and counted nowhere.
    #[test]
    fn denied_files_are_listed_and_counted_nowhere() {
        let _serial = db::serial_guard();
        let root = temp_root("denied");
        put(&root, ".env");
        put(&root, ".ssh/config");
        put(&root, "src/a.ts");
        let linked = make_dir_link(&root.join("cfg"), &root.join(".ssh"));
        let epoch = open(&root, Some("p"));
        let mut editor = Scripted {
            selected: vec![".env".into(), "src/a.ts".into(), "cfg/config".into(), "src/.ENV".into()],
            folder: Some(".ssh".into()),
            active: Some((".env".into(), true)),
            entries: vec![
                entry(".env", BufferState::Open, true),
                entry("cfg/config", BufferState::ClosedDirty, true),
                entry("keys/id_rsa", BufferState::ClosedDirty, true),
                entry("src/a.ts", BufferState::Open, true),
            ],
            ..Scripted::default()
        };
        let result = handle_with(&context_for(&epoch), &mut editor, operations(), MAX_RESPONSE_BYTES).unwrap();
        assert_eq!(result.selection.paths, ["src/a.ts"]);
        assert_eq!(result.selection.omitted, 0);
        assert_eq!(result.selection.folder, None);
        assert_eq!(result.documents.active, None);
        assert_eq!(result.documents.open, ["src/a.ts"]);
        assert_eq!(result.documents.dirty_count, 1);
        let text = serde_json::to_string(&result).unwrap();
        for withheld in [".env", "id_rsa", "cfg/config", ".ssh"] {
            assert!(!text.contains(&format!("\"{withheld}")), "{withheld} leaked: {text}");
        }
        if linked {
            remove_dir_link(&root.join("cfg"));
        } else {
            eprintln!("note: this host cannot create directory links; the link case was not exercised");
        }
        db::close_workspace_db().unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn long_lists_are_bounded_and_incomplete_owners_are_flagged() {
        let _serial = db::serial_guard();
        let root = temp_root("bounded");
        let epoch = open(&root, None);
        let paths: Vec<String> = (0..150).map(|index| format!("src/f{index:03}.ts")).collect();
        let mut editor = Scripted {
            selected: paths.clone(),
            selection_omitted: 7,
            entries: paths.iter().map(|path| entry(path, BufferState::Open, false)).collect(),
            index_omitted: 2,
            ..Scripted::default()
        };
        let result = handle_with(&context_for(&epoch), &mut editor, operations(), MAX_RESPONSE_BYTES).unwrap();
        assert_eq!(result.project.name, result.project.root_name, "no project row: the folder's name");
        assert_eq!((result.selection.paths.len(), result.selection.omitted), (100, 50));
        assert!(!result.selection.complete, "the owner's own unlisted paths are not counted");
        assert_eq!((result.documents.open.len(), result.documents.open_omitted), (100, 50));
        assert!(!result.documents.complete);
        db::close_workspace_db().unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_result_sheds_listed_paths_to_fit_the_ceiling() {
        let _serial = db::serial_guard();
        let root = temp_root("fit");
        let epoch = open(&root, None);
        // Long but real: no path segment exceeds what a file system allows
        // (an impossible name cannot be resolved, so it is withheld).
        let long = |index: usize| format!("{0}/{0}/{0}/{0}/{index}.ts", "d".repeat(200));
        let mut editor = Scripted {
            selected: (0..100).map(long).collect(),
            entries: (0..100).map(|index| entry(&long(index), BufferState::Open, false)).collect(),
            ..Scripted::default()
        };
        let ceiling = 64 * 1024;
        let result = handle_with(&context_for(&epoch), &mut editor, operations(), ceiling).unwrap();
        assert!(serde_json::to_vec(&result).unwrap().len() <= ceiling);
        assert_eq!(result.selection.paths.len() + result.selection.omitted as usize, 100);
        assert_eq!(result.documents.open.len() + result.documents.open_omitted as usize, 100);
        assert!(result.selection.omitted > 0 && result.documents.open_omitted > 0);
        db::close_workspace_db().unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_editor_that_cannot_answer_fails_the_call() {
        let _serial = db::serial_guard();
        let root = temp_root("unavailable");
        let epoch = open(&root, None);
        let mut editor = Scripted {
            fail: Some(ErrorCode::OwnerUnavailable),
            ..Scripted::default()
        };
        let error = handle_with(&context_for(&epoch), &mut editor, operations(), MAX_RESPONSE_BYTES).unwrap_err();
        assert_eq!(error.code, ErrorCode::OwnerUnavailable);
        db::close_workspace_db().unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn operations_are_the_catalog_intersected_with_the_grant() {
        let dispatcher = super::super::dispatcher();
        assert_eq!(
            dispatcher.operations_for(&Grant::of([FilesReadOp::CAPABILITY])),
            [FilesReadOp::NAME]
        );
        assert_eq!(
            dispatcher.operations_for(&Grant::of(dispatcher.capabilities())),
            [FilesReadOp::NAME, FilesSearchOp::NAME, ProjectContextOp::NAME]
        );
        assert!(dispatcher.operations_for(&Grant::default()).is_empty());
    }

    #[test]
    fn the_limits_are_the_servers_own() {
        let limits = limits();
        assert_eq!(limits.max_response_bytes as usize, MAX_RESPONSE_BYTES);
        assert_eq!(limits.files_search.max_files_scanned, MAX_FILES_SCANNED);
        assert_eq!(limits.files_search.time_budget_ms, 2000);
        assert_eq!(limits.files_read.max_file_bytes as u64, HARD_CAP_BYTES);
        assert_eq!(denied_classes()[0], DeniedClass::LitriaState);
    }

    /// End to end over the wire, with the epoch fence: not attached is
    /// `ownerUnavailable`; attached, the three owners answer.
    #[test]
    fn orients_through_the_bridge() {
        use crate::project_api::bridge::testing::answering;
        let _serial = db::serial_guard();
        let root = temp_root("bridge");
        put(&root, "src/a.ts");
        let epoch = open(&root, Some("Bridged"));
        let bridge: &'static Bridge = Box::leak(Box::new(Bridge::new(Duration::from_secs(5))));
        answering(bridge, |event| {
            let result = match event.op.as_str() {
                "workspace.selection" => serde_json::json!({
                    "selected": ["src/a.ts"], "omitted": 0,
                    "activeDocument": { "path": "src/a.ts", "dirty": false }
                }),
                "editor.bufferIndex" => serde_json::json!({ "entries": [
                    { "path": "src/a.ts", "state": "open", "dirty": false, "revision": "b1-x", "byteLength": 1 }
                ], "omitted": 0 }),
                "languages.capabilities" => serde_json::json!({ "languages": [{
                    "language": "typescript", "extensions": [".ts"], "languageServer": "unknown",
                    "documentAccess": true, "diagnostics": false, "navigation": true, "symbols": true,
                    "relationshipDiscovery": true, "sourceTransformations": true
                }]}),
                other => panic!("unexpected {other}"),
            };
            Some(serde_json::json!({ "kind": "result", "result": result }).to_string())
        });
        let editor = || BridgeEditor {
            bridge,
            epoch: &epoch,
        };
        let error = handle_with(&context_for(&epoch), &mut editor(), operations(), MAX_RESPONSE_BYTES).unwrap_err();
        assert_eq!(error.code, ErrorCode::OwnerUnavailable);
        bridge.attach(&epoch, Some(&epoch)).unwrap();
        let result = handle_with(&context_for(&epoch), &mut editor(), operations(), MAX_RESPONSE_BYTES).unwrap();
        assert_eq!(result.project.name, "Bridged");
        assert_eq!(result.selection.paths, ["src/a.ts"]);
        assert_eq!(result.documents.open, ["src/a.ts"]);
        assert_eq!(result.languages[0].language_server, LanguageServer::Unknown);
        db::close_workspace_db().unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_switch_while_the_owners_answer_discards_the_answer() {
        let _serial = db::serial_guard();
        let first = temp_root("switch-a");
        let second = temp_root("switch-b");
        let epoch = open(&first, Some("first"));
        struct Switching(PathBuf, Scripted);
        impl ContextEditor for Switching {
            fn selection(&mut self) -> Result<SelectionResult, ContractError> {
                db::open_workspace_db(&self.0).unwrap();
                self.1.selection()
            }
            fn buffer_index(&mut self) -> Result<BufferIndexResult, ContractError> {
                self.1.buffer_index()
            }
            fn capabilities(&mut self) -> Result<CapabilitiesResult, ContractError> {
                self.1.capabilities()
            }
        }
        let mut editor = Switching(second.clone(), Scripted::default());
        let error = handle_with(&context_for(&epoch), &mut editor, operations(), MAX_RESPONSE_BYTES).unwrap_err();
        assert_eq!(error.code, ErrorCode::WorkspaceChanged);
        db::close_workspace_db().unwrap();
        let _ = fs::remove_dir_all(&first);
        let _ = fs::remove_dir_all(&second);
    }

    #[cfg(windows)]
    fn make_dir_link(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|output| output.status.success())
    }

    #[cfg(unix)]
    fn make_dir_link(link: &Path, target: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    fn remove_dir_link(link: &Path) {
        #[cfg(windows)]
        let _ = fs::remove_dir(link);
        #[cfg(unix)]
        let _ = fs::remove_file(link);
    }
}
