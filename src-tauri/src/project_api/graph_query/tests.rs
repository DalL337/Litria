//! `litria_graph_query` handler tests (P4c task 6): the sequences that must
//! hold, over a scripted owner that answers `workspace.graph` like the live
//! bridge — plus one end-to-end pass over the real bridge and the epoch fence.

// This whole file is the handler's test module (`#[cfg(test)] mod tests;`), so
// the Windows-hidden-spawn guard may skip it: test code (the junction helper
// below) spawns `cmd` directly, as the reader's own link tests do.
#[cfg(test)]
use super::*;
use crate::contracts::project_api_bridge::editor::{BufferIndexEntry, BufferState};
use crate::contracts::project_api_bridge::workspace::{
    EdgeProvenance as BProv, GraphEdge as BEdge, GraphNode as BNode, GraphResult, GraphSymbol as BSym, ParsedRevision,
    ParsedSource as BSource,
};
use crate::project_api::reader::{self};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root(tag: &str) -> PathBuf {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("litria-api-graph-{tag}-{}-{stamp}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    fs::canonicalize(dir).unwrap()
}

fn put(root: &Path, path: &str, text: &str) {
    let full = root.join(path);
    fs::create_dir_all(full.parent().unwrap()).unwrap();
    fs::write(full, text).unwrap();
}

// --- A scripted owner, adjacency-driven like the real bridge ----------------

#[derive(Clone)]
struct Node {
    on_canvas: bool,
    folder: Option<String>,
    group_id: Option<String>,
    parsed: Option<(BSource, String)>,
    discoverable: bool,
}

impl Default for Node {
    fn default() -> Self {
        Self {
            on_canvas: true,
            folder: None,
            group_id: None,
            parsed: None,
            discoverable: true,
        }
    }
}

#[derive(Clone)]
struct Edge {
    importer: String,
    exporter: String,
    symbols: Vec<(String, String)>,
    symbols_truncated: bool,
    manual: bool,
    status: Option<String>,
    on_canvas: bool,
}

fn source_edge(importer: &str, exporter: &str, status: &str) -> Edge {
    Edge {
        importer: importer.into(),
        exporter: exporter.into(),
        symbols: vec![("thing".into(), "function".into())],
        symbols_truncated: false,
        manual: false,
        status: Some(status.into()),
        on_canvas: true,
    }
}

#[derive(Default)]
struct Scripted {
    nodes: BTreeMap<String, Node>,
    edges: Vec<Edge>,
    selected: Vec<String>,
    buffers: Vec<(String, String)>,
    index_omitted: u32,
    discovery_in_flight: bool,
    awaiting_canvas_pieces: bool,
    graph_error: Option<crate::contracts::error::ErrorCode>,
    graph_calls: usize,
    /// Answer every requested path, as the production owner does: a path it
    /// does not know gets a fallback node (off the canvas, nothing parsed) so an
    /// off-canvas focus still reports `discoverable` (first review 11).
    fallback_nodes: bool,
}

impl Scripted {
    fn node(mut self, path: &str, node: Node) -> Self {
        self.nodes.insert(path.into(), node);
        self
    }
    fn edge(mut self, edge: Edge) -> Self {
        self.edges.push(edge);
        self
    }
}

impl GraphEditor for Scripted {
    fn selection(&mut self) -> Result<SelectionResult, ContractError> {
        Ok(SelectionResult {
            selected: self.selected.clone(),
            omitted: 0,
            folder: None,
            active_document: None,
        })
    }

    fn buffer_index(&mut self) -> Result<BufferIndexResult, ContractError> {
        Ok(BufferIndexResult {
            entries: self
                .buffers
                .iter()
                .map(|(path, revision)| BufferIndexEntry {
                    path: path.clone(),
                    state: BufferState::Open,
                    dirty: true,
                    revision: revision.clone(),
                    byte_length: 1,
                })
                .collect(),
            omitted: self.index_omitted,
        })
    }

    fn graph(&mut self, request: &GraphRequest) -> Result<GraphResult, ContractError> {
        self.graph_calls += 1;
        if let Some(code) = self.graph_error {
            return Err(ContractError::new(code, "scripted"));
        }
        let frontier: BTreeSet<&String> = request.paths.iter().collect();
        let nodes = request
            .paths
            .iter()
            .filter_map(|path| {
                self.nodes
                    .get(path)
                    .map(|node| BNode {
                        path: path.clone(),
                        on_canvas: node.on_canvas,
                        folder: node.folder.clone(),
                        group_id: node.group_id.clone(),
                        parsed: node.parsed.as_ref().map(|(source, revision)| ParsedRevision {
                            source: *source,
                            revision: revision.clone(),
                        }),
                        discoverable: node.discoverable,
                    })
                    .or_else(|| {
                        self.fallback_nodes.then(|| BNode {
                            path: path.clone(),
                            on_canvas: false,
                            folder: None,
                            group_id: None,
                            parsed: None,
                            discoverable: true,
                        })
                    })
            })
            .collect();
        let edges = self
            .edges
            .iter()
            .filter(|edge| match request.direction {
                BridgeDirection::Imports => frontier.contains(&edge.importer),
                BridgeDirection::ImportedBy => frontier.contains(&edge.exporter),
                BridgeDirection::Both => frontier.contains(&edge.importer) || frontier.contains(&edge.exporter),
            })
            .map(|edge| BEdge {
                importer: edge.importer.clone(),
                exporter: edge.exporter.clone(),
                symbols: edge
                    .symbols
                    .iter()
                    .map(|(name, kind)| BSym {
                        name: name.clone(),
                        kind: kind.clone(),
                    })
                    .collect(),
                symbols_truncated: edge.symbols_truncated,
                provenance: if edge.manual {
                    BProv::Manual
                } else {
                    BProv::SourceDerived
                },
                status: if edge.manual { None } else { edge.status.clone() },
                on_canvas: edge.on_canvas,
            })
            .collect();
        Ok(GraphResult {
            nodes,
            edges,
            discovery_in_flight: self.discovery_in_flight,
            awaiting_canvas_pieces: self.awaiting_canvas_pieces,
            omitted: 0,
        })
    }
}

fn req(value: serde_json::Value) -> GraphQueryRequest {
    serde_json::from_value(value).unwrap()
}

fn run_ok(root: &Path, request: GraphQueryRequest, editor: &mut Scripted) -> GraphQueryResult {
    run(root, &request, editor, MAX_RESPONSE_BYTES).unwrap()
}

fn file_paths(result: &GraphQueryResult) -> Vec<String> {
    result
        .nodes
        .iter()
        .filter_map(|node| match node {
            GraphNode::File { path, .. } => Some(path.clone()),
            GraphNode::Folder { .. } => None,
        })
        .collect()
}

fn freshness_of(result: &GraphQueryResult, path: &str) -> Freshness {
    result
        .nodes
        .iter()
        .find_map(|node| match node {
            GraphNode::File { path: p, freshness, .. } if p == path => Some(*freshness),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no file node {path}"))
}

// --- Direction --------------------------------------------------------------

#[test]
fn imports_returns_what_a_file_imports_not_what_imports_it() {
    let root = temp_root("direction");
    let mut editor = Scripted::default()
        .node("a.ts", Node::default())
        .node("b.ts", Node::default())
        .edge(source_edge("a.ts", "b.ts", "resolved"));
    let imports = run_ok(&root, req(serde_json::json!({ "focus": "a.ts", "direction": "imports" })), &mut editor);
    assert_eq!(imports.edges.len(), 1);
    assert_eq!((imports.edges[0].importer.as_str(), imports.edges[0].exporter.as_str()), ("a.ts", "b.ts"));
    let imported_by = run_ok(&root, req(serde_json::json!({ "focus": "a.ts", "direction": "importedBy" })), &mut editor);
    assert!(imported_by.edges.is_empty(), "nothing imports a.ts");
    let _ = fs::remove_dir_all(&root);
}

// --- Policy -----------------------------------------------------------------

#[test]
fn a_denied_endpoint_removes_the_edge_and_the_node() {
    let root = temp_root("denied-endpoint");
    let mut editor = Scripted::default()
        .node("a.ts", Node::default())
        .node(".env", Node::default())
        .edge(source_edge("a.ts", ".env", "resolved"));
    let result = run_ok(&root, req(serde_json::json!({ "focus": "a.ts", "direction": "imports" })), &mut editor);
    assert!(result.edges.is_empty(), "the edge to a denied file is dropped");
    assert_eq!(file_paths(&result), ["a.ts"], ".env is never a node");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_denied_file_between_two_allowed_is_never_traversed_at_depth_two() {
    let root = temp_root("denied-through");
    let mut editor = Scripted::default()
        .node("a.ts", Node::default())
        .node(".env", Node::default())
        .node("c.ts", Node::default())
        .edge(source_edge("a.ts", ".env", "resolved"))
        .edge(source_edge(".env", "c.ts", "resolved"));
    let result = run_ok(&root, req(serde_json::json!({ "focus": "a.ts", "depth": 2, "direction": "imports" })), &mut editor);
    assert_eq!(file_paths(&result), ["a.ts"], "the walk does not pass through .env");
    assert!(!file_paths(&result).iter().any(|p| p == "c.ts"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn an_unindexed_endpoint_is_not_enumerated() {
    let root = temp_root("unindexed");
    let mut editor = Scripted::default()
        .node("a.ts", Node::default())
        .node("node_modules/pkg/index.js", Node::default())
        .edge(source_edge("a.ts", "node_modules/pkg/index.js", "resolved"));
    let result = run_ok(&root, req(serde_json::json!({ "focus": "a.ts", "direction": "imports" })), &mut editor);
    assert!(result.edges.is_empty());
    assert_eq!(file_paths(&result), ["a.ts"]);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_denied_focus_reveals_nothing() {
    let root = temp_root("denied-focus");
    let mut editor = Scripted::default();
    let result = run_ok(&root, req(serde_json::json!({ "focus": ".env" })), &mut editor);
    assert_eq!(result.focus, FocusOutcome::Denied);
    assert!(result.nodes.is_empty() && result.edges.is_empty());
    assert_eq!(editor.graph_calls, 0, "no walk runs for a withheld focus");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn an_invalid_focus_and_an_empty_selection_are_reported() {
    let root = temp_root("focus-outcomes");
    let mut editor = Scripted::default();
    assert_eq!(
        run_ok(&root, req(serde_json::json!({ "focus": "../escape" })), &mut editor).focus,
        FocusOutcome::InvalidPath
    );
    assert_eq!(run_ok(&root, req(serde_json::json!({})), &mut editor).focus, FocusOutcome::NoSelection);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_focus_defaults_to_the_disclosed_selection() {
    let root = temp_root("selection");
    let mut editor = Scripted {
        selected: vec![".env".into(), "a.ts".into()],
        ..Scripted::default()
    }
    .node("a.ts", Node::default())
    .node("b.ts", Node::default())
    .edge(source_edge("a.ts", "b.ts", "resolved"));
    let result = run_ok(&root, req(serde_json::json!({ "direction": "imports" })), &mut editor);
    assert_eq!(result.focus, FocusOutcome::Resolved);
    assert_eq!(result.edges.len(), 1, "the withheld .env is dropped, a.ts drives the walk");
    let _ = fs::remove_dir_all(&root);
}

// --- Freshness --------------------------------------------------------------

#[test]
fn disk_text_changed_after_parsing_with_no_buffer_is_stale() {
    let root = temp_root("fresh-disk");
    put(&root, "a.ts", "one\n");
    let revision = match reader::read_disk(&root, "a.ts") {
        DiskRead::Text { revision, .. } => revision,
        other => panic!("{other:?}"),
    };
    let current = Node {
        parsed: Some((BSource::Disk, revision.clone())),
        ..Node::default()
    };
    let mut editor = Scripted::default().node("a.ts", current.clone());
    assert_eq!(
        freshness_of(&run_ok(&root, req(serde_json::json!({ "focus": "a.ts" })), &mut editor), "a.ts"),
        Freshness::Current
    );
    // The disk changes; the parsed revision no longer matches.
    put(&root, "a.ts", "two\n");
    assert_eq!(
        freshness_of(&run_ok(&root, req(serde_json::json!({ "focus": "a.ts" })), &mut editor), "a.ts"),
        Freshness::Stale
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_buffer_edited_after_parsing_is_stale_until_re_registered() {
    let root = temp_root("fresh-buffer");
    put(&root, "a.ts", "disk\n");
    // Parsed from the editor at b1-old; the buffer now holds b1-new.
    let mut editor = Scripted {
        buffers: vec![("a.ts".into(), "b1-new".into())],
        ..Scripted::default()
    }
    .node(
        "a.ts",
        Node {
            parsed: Some((BSource::Editor, "b1-old".into())),
            ..Node::default()
        },
    );
    assert_eq!(
        freshness_of(&run_ok(&root, req(serde_json::json!({ "focus": "a.ts" })), &mut editor), "a.ts"),
        Freshness::Stale
    );
    // Re-registered at the buffer's revision: current again.
    editor.nodes.get_mut("a.ts").unwrap().parsed = Some((BSource::Editor, "b1-new".into()));
    assert_eq!(
        freshness_of(&run_ok(&root, req(serde_json::json!({ "focus": "a.ts" })), &mut editor), "a.ts"),
        Freshness::Current
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn no_recorded_revision_or_an_omitted_index_is_unknown() {
    let root = temp_root("fresh-unknown");
    put(&root, "a.ts", "x\n");
    put(&root, "b.ts", "y\n");
    let mut editor = Scripted {
        index_omitted: 1,
        ..Scripted::default()
    }
    .node("a.ts", Node::default()) // no parsed revision
    .node(
        "b.ts",
        Node {
            parsed: Some((BSource::Disk, "d1-whatever".into())),
            ..Node::default()
        },
    )
    .edge(source_edge("a.ts", "b.ts", "resolved"));
    let result = run_ok(&root, req(serde_json::json!({ "focus": "a.ts", "depth": 2, "direction": "imports" })), &mut editor);
    assert_eq!(freshness_of(&result, "a.ts"), Freshness::Unknown, "no parsed revision");
    assert_eq!(freshness_of(&result, "b.ts"), Freshness::Unknown, "the index omitted a document");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_file_re_registered_from_the_editor_is_current_again() {
    let root = temp_root("fresh-reopen");
    put(&root, "a.ts", "disk\n");
    let mut editor = Scripted {
        buffers: vec![("a.ts".into(), "b1-live".into())],
        ..Scripted::default()
    }
    .node(
        "a.ts",
        Node {
            parsed: Some((BSource::Editor, "b1-live".into())),
            ..Node::default()
        },
    );
    assert_eq!(
        freshness_of(&run_ok(&root, req(serde_json::json!({ "focus": "a.ts" })), &mut editor), "a.ts"),
        Freshness::Current
    );
    let _ = fs::remove_dir_all(&root);
}

// --- Summary and index state ------------------------------------------------

#[test]
fn the_summary_is_current_only_when_every_node_is() {
    let root = temp_root("summary");
    put(&root, "a.ts", "x\n");
    put(&root, "b.ts", "y\n");
    let rev = |p: &str| match reader::read_disk(&root, p) {
        DiskRead::Text { revision, .. } => revision,
        other => panic!("{other:?}"),
    };
    let fresh = |p: &str| Node {
        parsed: Some((BSource::Disk, rev(p))),
        ..Node::default()
    };
    let mut editor = Scripted::default()
        .node("a.ts", fresh("a.ts"))
        .node("b.ts", fresh("b.ts"))
        .edge(source_edge("a.ts", "b.ts", "resolved"));
    let result = run_ok(&root, req(serde_json::json!({ "focus": "a.ts", "depth": 2, "direction": "imports" })), &mut editor);
    assert_eq!(result.summary, IndexState::Current);
    assert!(result.reasons.is_empty());
    // Make b stale; the summary drops to partial with a reason.
    put(&root, "b.ts", "changed\n");
    let result = run_ok(&root, req(serde_json::json!({ "focus": "a.ts", "depth": 2, "direction": "imports" })), &mut editor);
    assert_eq!(result.summary, IndexState::Partial);
    assert!(result.reasons.contains(&IndexReason::StaleNodes));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn discovery_in_flight_makes_the_summary_partial() {
    let root = temp_root("partial");
    put(&root, "a.ts", "x\n");
    let rev = match reader::read_disk(&root, "a.ts") {
        DiskRead::Text { revision, .. } => revision,
        other => panic!("{other:?}"),
    };
    let mut editor = Scripted {
        discovery_in_flight: true,
        ..Scripted::default()
    }
    .node(
        "a.ts",
        Node {
            parsed: Some((BSource::Disk, rev)),
            ..Node::default()
        },
    );
    let result = run_ok(&root, req(serde_json::json!({ "focus": "a.ts" })), &mut editor);
    assert_eq!(result.summary, IndexState::Partial);
    assert!(result.reasons.contains(&IndexReason::DiscoveryInFlight));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_focus_without_relationship_discovery_is_unavailable() {
    let root = temp_root("unavailable");
    put(&root, "a.ts", "x\n");
    let mut editor = Scripted::default().node(
        "a.ts",
        Node {
            discoverable: false,
            ..Node::default()
        },
    );
    let result = run_ok(&root, req(serde_json::json!({ "focus": "a.ts" })), &mut editor);
    assert_eq!(result.summary, IndexState::Unavailable);
    assert!(result.reasons.contains(&IndexReason::NoRelationshipDiscovery));
    let _ = fs::remove_dir_all(&root);
}

// --- Canvas shapes ----------------------------------------------------------

#[test]
fn off_canvas_discovered_edges_manual_wires_and_group_shapes() {
    let root = temp_root("shapes");
    let mut editor = Scripted::default()
        .node(
            "a.ts",
            Node {
                folder: Some("src".into()),
                ..Node::default()
            },
        )
        .node(
            "b.ts",
            Node {
                on_canvas: false,
                group_id: Some("group-9".into()),
                folder: None,
                ..Node::default()
            },
        )
        .edge(Edge {
            on_canvas: false,
            ..source_edge("a.ts", "b.ts", "pending")
        })
        .edge(Edge {
            importer: "a.ts".into(),
            exporter: "b.ts".into(),
            symbols: Vec::new(),
            symbols_truncated: false,
            manual: true,
            status: None,
            on_canvas: true,
        });
    let result = run_ok(&root, req(serde_json::json!({ "focus": "a.ts", "depth": 2, "direction": "imports" })), &mut editor);
    // Two edges between the same pair: one sourceDerived off-canvas, one manual.
    assert_eq!(result.edges.len(), 2);
    let discovered = result.edges.iter().find(|e| matches!(e.provenance, EdgeProvenance::SourceDerived { .. })).unwrap();
    assert!(!discovered.on_canvas);
    assert!(result.edges.iter().any(|e| matches!(e.provenance, EdgeProvenance::Manual)));
    // A folder group and a legacy group both yield folder nodes.
    let folders: Vec<&GraphNode> = result.nodes.iter().filter(|n| matches!(n, GraphNode::Folder { .. })).collect();
    assert_eq!(folders.len(), 2);
    assert!(result.nodes.iter().any(|n| matches!(n, GraphNode::Folder { folder: Some(f), .. } if f == "src")));
    assert!(result.nodes.iter().any(|n| matches!(n, GraphNode::Folder { group_id: Some(g), .. } if g == "group-9")));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_orphaned_status_is_reported_as_itself() {
    let root = temp_root("orphaned");
    let mut editor = Scripted::default()
        .node("a.ts", Node::default())
        .node("b.ts", Node::default())
        .edge(source_edge("a.ts", "b.ts", "orphaned"));
    let result = run_ok(&root, req(serde_json::json!({ "focus": "a.ts", "direction": "imports" })), &mut editor);
    match &result.edges[0].provenance {
        EdgeProvenance::SourceDerived { status } => assert_eq!(status, "orphaned"),
        other => panic!("{other:?}"),
    }
    let _ = fs::remove_dir_all(&root);
}

// --- Bounds -----------------------------------------------------------------

#[test]
fn truncation_at_max_nodes() {
    let root = temp_root("max-nodes");
    let mut editor = Scripted::default().node("a.ts", Node::default());
    for index in 0..10 {
        let path = format!("dep{index}.ts");
        editor.nodes.insert(path.clone(), Node::default());
        editor.edges.push(source_edge("a.ts", &path, "resolved"));
    }
    let result = run_ok(
        &root,
        req(serde_json::json!({ "focus": "a.ts", "depth": 2, "direction": "imports", "maxNodes": 3 })),
        &mut editor,
    );
    assert_eq!(file_paths(&result).len(), 3);
    assert!(result.truncated && result.truncated_by.contains(&TruncationReason::MaxNodes));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn truncation_at_the_symbol_ceiling() {
    let root = temp_root("symbols");
    let symbols: Vec<(String, String)> = (0..MAX_SYMBOLS_PER_EDGE + 5)
        .map(|index| (format!("s{index}"), "function".into()))
        .collect();
    let mut editor = Scripted::default()
        .node("a.ts", Node::default())
        .node("b.ts", Node::default())
        .edge(Edge {
            symbols,
            ..source_edge("a.ts", "b.ts", "resolved")
        });
    let result = run_ok(&root, req(serde_json::json!({ "focus": "a.ts", "direction": "imports" })), &mut editor);
    assert_eq!(result.edges[0].symbols.len(), MAX_SYMBOLS_PER_EDGE as usize);
    assert!(result.truncated_by.contains(&TruncationReason::Symbols));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_reply_over_the_ceiling_is_bounded_not_refused() {
    let root = temp_root("ceiling");
    let mut editor = Scripted::default().node("a.ts", Node::default());
    for index in 0..60 {
        let path = format!("dep{index:03}.ts");
        editor.nodes.insert(path.clone(), Node::default());
        editor.edges.push(source_edge("a.ts", &path, "resolved"));
    }
    let result = run(
        &root,
        &req(serde_json::json!({ "focus": "a.ts", "depth": 2, "direction": "imports", "maxNodes": 100 })),
        &mut editor,
        2 * 1024,
    )
    .unwrap();
    assert!(serde_json::to_vec(&result).unwrap().len() <= 2 * 1024);
    assert!(result.truncated_by.contains(&TruncationReason::ResponseSize));
    let _ = fs::remove_dir_all(&root);
}

// --- Lifecycle --------------------------------------------------------------

/// End to end over the wire, with the epoch fence: not attached is
/// `ownerUnavailable`; attached, the owner answers and the walk runs.
#[test]
fn walks_through_the_bridge() {
    use crate::contracts::catalog::Operation;
    use crate::contracts::context::{Grant, Principal};
    use crate::contracts::project_api::graph_query::GraphQueryOp;
    use crate::db;
    use crate::project_api::bridge::{testing::answering, Bridge};
    use std::time::Duration;

    let _serial = db::serial_guard();
    let root = temp_root("bridge");
    put(&root, "a.ts", "x\n");
    let (_ro, epoch) = db::open_workspace_db(&root).unwrap();
    let bridge: &'static Bridge = Box::leak(Box::new(Bridge::new(Duration::from_secs(5))));
    answering(bridge, |event| {
        let result = match event.op.as_str() {
            "workspace.graph" => serde_json::json!({
                "nodes": [{ "path": "a.ts", "onCanvas": true, "discoverable": true }],
                "edges": [], "discoveryInFlight": false, "omitted": 0
            }),
            "editor.bufferIndex" => serde_json::json!({ "entries": [], "omitted": 0 }),
            other => panic!("unexpected {other}"),
        };
        Some(serde_json::json!({ "kind": "result", "result": result }).to_string())
    });
    let context = CallContext {
        principal: Principal::Test,
        grant: Grant::of([GraphQueryOp::CAPABILITY]),
        epoch: epoch.clone(),
    };
    let request = || req(serde_json::json!({ "focus": "a.ts", "direction": "imports" }));
    let editor = || BridgeGraph {
        bridge,
        epoch: &epoch,
    };
    let error = handle_with(&context, request(), &mut editor(), MAX_RESPONSE_BYTES).unwrap_err();
    assert_eq!(error.code, crate::contracts::error::ErrorCode::OwnerUnavailable);
    bridge.attach(&epoch, Some(&epoch)).unwrap();
    let result = handle_with(&context, request(), &mut editor(), MAX_RESPONSE_BYTES).unwrap();
    assert_eq!(result.focus, FocusOutcome::Resolved);
    assert_eq!(file_paths(&result), ["a.ts"]);
    db::close_workspace_db().unwrap();
    let _ = fs::remove_dir_all(&root);
}

// --- First-review defects (tasks 11–15) -------------------------------------

/// Task 11 / first review 8: a file whose folder group is a denied directory
/// (`.git`) never discloses that folder — no folder node, and the file node's
/// own `folder` field is dropped.
#[test]
fn a_denied_folder_is_never_disclosed() {
    let root = temp_root("denied-folder");
    let mut editor = Scripted::default().node(
        "a.ts",
        Node {
            folder: Some(".git".into()),
            ..Node::default()
        },
    );
    let result = run_ok(&root, req(serde_json::json!({ "focus": "a.ts" })), &mut editor);
    assert!(
        !result.nodes.iter().any(|n| matches!(n, GraphNode::Folder { .. })),
        "a denied folder is never a folder node"
    );
    match result.nodes.iter().find(|n| matches!(n, GraphNode::File { .. })).unwrap() {
        GraphNode::File { folder, .. } => assert_eq!(folder.as_deref(), None, "the file node does not disclose .git"),
        _ => unreachable!(),
    }
    let _ = fs::remove_dir_all(&root);
}

/// Task 11 / first review 3: a path reached through a junction into a denied
/// directory is resolved with `identity` (not just `classify`), so it never
/// becomes a node and the walk never continues through it.
#[cfg(windows)]
#[test]
fn a_junction_endpoint_into_a_denied_directory_is_dropped() {
    let root = temp_root("junction-endpoint");
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(root.join(".git/secret.ts"), "export const x = 1;\n").unwrap();
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(root.join("alias"))
        .arg(root.join(".git"))
        .status()
        .unwrap();
    assert!(status.success(), "mklink /J");
    put(&root, "a.ts", "x\n");
    put(&root, "c.ts", "y\n");
    let mut editor = Scripted::default()
        .node("a.ts", Node::default())
        .node("alias/secret.ts", Node::default())
        .node("c.ts", Node::default())
        .edge(source_edge("a.ts", "alias/secret.ts", "resolved"))
        .edge(source_edge("alias/secret.ts", "c.ts", "resolved"));
    let result = run_ok(
        &root,
        req(serde_json::json!({ "focus": "a.ts", "depth": 2, "direction": "imports" })),
        &mut editor,
    );
    assert_eq!(file_paths(&result), ["a.ts"], "the junction path is never a node");
    assert!(result.edges.is_empty(), "the edge through the junction is dropped");
    fs::remove_dir(root.join("alias")).unwrap(); // the junction itself, before the tree
    let _ = fs::remove_dir_all(&root);
}

/// Task 12 / first review 4: at depth 1 an edge's other endpoint is a returned
/// node — no dangling edge.
#[test]
fn an_edge_at_depth_one_closes_on_a_returned_node() {
    let root = temp_root("closed");
    let mut editor = Scripted::default()
        .node("a.ts", Node::default())
        .node("b.ts", Node::default())
        .edge(source_edge("a.ts", "b.ts", "resolved"));
    let result = run_ok(
        &root,
        req(serde_json::json!({ "focus": "a.ts", "depth": 1, "direction": "imports" })),
        &mut editor,
    );
    assert_eq!(result.edges.len(), 1);
    let paths = file_paths(&result);
    let returned: BTreeSet<&str> = paths.iter().map(String::as_str).collect();
    for edge in &result.edges {
        assert!(returned.contains(edge.importer.as_str()), "importer is a returned node");
        assert!(returned.contains(edge.exporter.as_str()), "exporter is a returned node");
    }
    let _ = fs::remove_dir_all(&root);
}

/// Task 13 / first review 5: `maxNodes: 1` bounds the WALK — no edge reaches a
/// node the budget could not hold, and the truncation is flagged.
#[test]
fn max_nodes_one_bounds_the_walk() {
    let root = temp_root("maxnodes-one");
    let mut editor = Scripted::default()
        .node("a.ts", Node::default())
        .node("b.ts", Node::default())
        .node("c.ts", Node::default())
        .edge(source_edge("a.ts", "b.ts", "resolved"))
        .edge(source_edge("a.ts", "c.ts", "resolved"));
    let result = run_ok(
        &root,
        req(serde_json::json!({ "focus": "a.ts", "depth": 2, "direction": "imports", "maxNodes": 1 })),
        &mut editor,
    );
    assert_eq!(file_paths(&result), ["a.ts"], "only the focus fits the budget");
    assert!(result.edges.is_empty(), "no edge reaches past the returned node");
    assert!(result.truncated_by.contains(&TruncationReason::MaxNodes));
    let _ = fs::remove_dir_all(&root);
}

/// Task 14 / first review 6: a response shed to the ceiling stays under it
/// INCLUDING the truncation fields it then carries.
#[test]
fn the_shed_response_stays_under_the_ceiling() {
    let root = temp_root("ceiling-exact");
    let mut editor = Scripted::default().node("a.ts", Node::default());
    for index in 0..40 {
        let path = format!("dep{index:03}.ts");
        editor.nodes.insert(path.clone(), Node::default());
        editor.edges.push(source_edge("a.ts", &path, "resolved"));
    }
    for ceiling in [700usize, 900, 1100, 1500] {
        let result = run(
            &root,
            &req(serde_json::json!({ "focus": "a.ts", "depth": 2, "direction": "imports", "maxNodes": 100 })),
            &mut editor,
            ceiling,
        )
        .unwrap();
        let encoded = serde_json::to_vec(&result).unwrap().len();
        assert!(encoded <= ceiling, "encoded {encoded} over ceiling {ceiling} (incl. truncation fields)");
        assert!(result.truncated_by.contains(&TruncationReason::ResponseSize));
    }
    let _ = fs::remove_dir_all(&root);
}

/// Task 15 / first review 7: the owner cut an edge's symbols at the ceiling and
/// flagged it; the tool reports `Symbols` even though it received at most 50.
#[test]
fn an_owner_symbol_cut_is_flagged() {
    let root = temp_root("symbols-flag");
    let mut editor = Scripted::default()
        .node("a.ts", Node::default())
        .node("b.ts", Node::default())
        .edge(Edge {
            symbols_truncated: true,
            ..source_edge("a.ts", "b.ts", "resolved")
        });
    let result = run_ok(&root, req(serde_json::json!({ "focus": "a.ts", "direction": "imports" })), &mut editor);
    assert_eq!(result.edges[0].symbols.len(), 1, "the owner already carried at most the ceiling");
    assert!(result.truncated_by.contains(&TruncationReason::Symbols), "the owner's cut is flagged");
    let _ = fs::remove_dir_all(&root);
}

// --- Live-pass defects (tasks 18, 21) ---------------------------------------

/// Task 21 / live pass 4: a disclosed focus that does not exist (no file on
/// disk, no buffer, no node the owner knows) answers `notFound` with no nodes,
/// exactly as `litria_files_read` answers that path.
#[test]
fn a_missing_focus_answers_not_found() {
    let root = temp_root("missing-focus");
    // The owner knows no node for nope.ts, it is not on disk, and no buffer
    // holds it.
    let mut editor = Scripted::default();
    let result = run_ok(&root, req(serde_json::json!({ "focus": "nope.ts" })), &mut editor);
    assert_eq!(result.focus, FocusOutcome::NotFound);
    assert!(result.nodes.is_empty() && result.edges.is_empty(), "a missing focus returns no nodes");
    let _ = fs::remove_dir_all(&root);
}

/// Live pass 4, re-run on `0bc108e`: the production owner answers every
/// frontier path, inventing a fallback node (off the canvas, nothing parsed)
/// for a file it does not know. That fallback is not evidence the file exists,
/// so a missing focus is still `notFound`.
#[test]
fn a_missing_focus_is_not_found_when_the_owner_answers_every_path() {
    let root = temp_root("missing-focus-fallback");
    let mut editor = Scripted { fallback_nodes: true, ..Scripted::default() };
    let result = run_ok(&root, req(serde_json::json!({ "focus": "nope.ts" })), &mut editor);
    assert_eq!(result.focus, FocusOutcome::NotFound);
    assert!(result.nodes.is_empty() && result.edges.is_empty(), "a missing focus returns no nodes");
    let _ = fs::remove_dir_all(&root);
}

/// The same owner still vouches for a file that is placed on the canvas but
/// not on disk yet: a piece is a file the owner really knows.
#[test]
fn a_focus_on_the_canvas_but_not_on_disk_resolves() {
    let root = temp_root("canvas-focus");
    let mut editor = Scripted { fallback_nodes: true, ..Scripted::default() }.node("draft.ts", Node::default());
    let result = run_ok(&root, req(serde_json::json!({ "focus": "draft.ts" })), &mut editor);
    assert_eq!(result.focus, FocusOutcome::Resolved);
    assert_eq!(file_paths(&result), ["draft.ts"]);
    let _ = fs::remove_dir_all(&root);
}

/// Task 21: a focus that exists only in a buffer (a new file not yet saved)
/// still resolves — the buffer is where `litria_files_read` would find it.
#[test]
fn a_focus_held_only_in_a_buffer_resolves() {
    let root = temp_root("buffer-focus");
    // Not on disk, no node fact from the owner, but the editor holds a buffer.
    let mut editor = Scripted {
        buffers: vec![("a.ts".into(), "b1-live".into())],
        ..Scripted::default()
    };
    let result = run_ok(&root, req(serde_json::json!({ "focus": "a.ts" })), &mut editor);
    assert_eq!(result.focus, FocusOutcome::Resolved);
    assert_eq!(file_paths(&result), ["a.ts"]);
    let _ = fs::remove_dir_all(&root);
}

/// Task 18 / live pass 1: discovery armed on an empty canvas is waiting for
/// pieces, not reading. The graph reports `awaitingCanvasPieces` as its own
/// reason — distinct from `discoveryInFlight`, which it never claims here.
#[test]
fn awaiting_canvas_pieces_is_its_own_reason() {
    let root = temp_root("awaiting");
    put(&root, "a.ts", "x\n");
    let revision = match reader::read_disk(&root, "a.ts") {
        DiskRead::Text { revision, .. } => revision,
        other => panic!("{other:?}"),
    };
    let mut editor = Scripted {
        awaiting_canvas_pieces: true,
        discovery_in_flight: false,
        ..Scripted::default()
    }
    .node(
        "a.ts",
        Node {
            parsed: Some((BSource::Disk, revision)),
            ..Node::default()
        },
    );
    let result = run_ok(&root, req(serde_json::json!({ "focus": "a.ts" })), &mut editor);
    assert_eq!(result.summary, IndexState::Partial);
    assert!(result.reasons.contains(&IndexReason::AwaitingCanvasPieces), "the empty-canvas state is reported");
    assert!(
        !result.reasons.contains(&IndexReason::DiscoveryInFlight),
        "a waiting discovery does not claim to be in flight"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_bridge_workspace_change_propagates() {
    let root = temp_root("switch");
    let mut editor = Scripted {
        graph_error: Some(crate::contracts::error::ErrorCode::WorkspaceChanged),
        ..Scripted::default()
    }
    .node("a.ts", Node::default());
    let error = run(&root, &req(serde_json::json!({ "focus": "a.ts" })), &mut editor, MAX_RESPONSE_BYTES).unwrap_err();
    assert_eq!(error.code, crate::contracts::error::ErrorCode::WorkspaceChanged);
    let _ = fs::remove_dir_all(&root);
}
