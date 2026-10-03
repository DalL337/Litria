//! `litria_graph_query` (Project API contract brief §7.4, §10).
//!
//! A bounded, path-identified neighbourhood of import relationships. Rust
//! drives the walk one level at a time over the `workspace.graph` bridge
//! operation, applies the disclosure policy before each expansion (so a walk
//! never passes through a denied or unindexed file), bounds the result, and
//! reports honest per-node freshness by comparing each file's parsed revision
//! (as the owner recorded it) with its effective revision when the query runs
//! (§5: the buffer when open or dirty, otherwise disk).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use super::bridge::{self, Bridge};
use super::paths::is_valid_api_path;
use super::policy::{classify, Class};
use super::reader::{identity, read_disk, DiskRead, Identity};
use super::{workspace, MAX_RESPONSE_BYTES};
use crate::contracts::context::CallContext;
use crate::contracts::error::ContractError;
use crate::contracts::project_api::graph_query::{
    EdgeProvenance, FocusOutcome, Freshness, GraphDirection, GraphEdge, GraphNode, GraphQueryRequest,
    GraphQueryResult, GraphSymbol, IndexReason, IndexState, TruncationReason, DEFAULT_DEPTH, DEFAULT_MAX_NODES,
    MAX_DEPTH, MAX_EDGES, MAX_NODES, MAX_SYMBOLS_PER_EDGE, MIN_DEPTH,
};
use crate::contracts::project_api_bridge::editor::{BufferIndexOp, BufferIndexRequest, BufferIndexResult};
use crate::contracts::project_api_bridge::workspace::{
    EdgeProvenance as BridgeProvenance, GraphDirection as BridgeDirection, GraphNode as BridgeNode, GraphOp,
    GraphRequest, GraphResult, ParsedSource, MAX_EDGES_PER_NODE, MAX_GRAPH_FRONTIER,
};
use crate::contracts::project_api_bridge::workspace::{SelectionOp, SelectionRequest, SelectionResult, MAX_SELECTED_PATHS};

pub(crate) fn handle(context: &CallContext, request: GraphQueryRequest) -> Result<GraphQueryResult, ContractError> {
    let mut editor = BridgeGraph {
        bridge: bridge::global(),
        epoch: &context.epoch,
    };
    handle_with(context, request, &mut editor, MAX_RESPONSE_BYTES)
}

pub(crate) fn handle_with(
    context: &CallContext,
    request: GraphQueryRequest,
    editor: &mut dyn GraphEditor,
    ceiling: usize,
) -> Result<GraphQueryResult, ContractError> {
    workspace::fenced(context, |root| run(root, &request, editor, ceiling))
}

// ---------------------------------------------------------------------------
// The owner's side: the bridge in production, a script in tests.
// ---------------------------------------------------------------------------

pub(crate) trait GraphEditor {
    fn selection(&mut self) -> Result<SelectionResult, ContractError>;
    fn buffer_index(&mut self) -> Result<BufferIndexResult, ContractError>;
    fn graph(&mut self, request: &GraphRequest) -> Result<GraphResult, ContractError>;
}

struct BridgeGraph<'a> {
    bridge: &'a Bridge,
    epoch: &'a str,
}

impl GraphEditor for BridgeGraph<'_> {
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
                max_entries: crate::contracts::project_api_bridge::editor::MAX_INDEX_ENTRIES,
            },
        )
    }

    fn graph(&mut self, request: &GraphRequest) -> Result<GraphResult, ContractError> {
        self.bridge.call::<GraphOp>(self.epoch, request)
    }
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

fn empty(focus: FocusOutcome) -> GraphQueryResult {
    GraphQueryResult {
        focus,
        nodes: Vec::new(),
        edges: Vec::new(),
        // A refused focus reveals nothing, so there is nothing to summarise.
        summary: IndexState::Unavailable,
        reasons: Vec::new(),
        truncated: false,
        truncated_by: Vec::new(),
    }
}

fn run(
    root: &Path,
    request: &GraphQueryRequest,
    editor: &mut dyn GraphEditor,
    ceiling: usize,
) -> Result<GraphQueryResult, ContractError> {
    // 1. The focus, judged by the same policy a read applies, before any walk.
    let seeds = match &request.focus {
        Some(focus) => {
            if !is_valid_api_path(focus) {
                return Ok(empty(FocusOutcome::InvalidPath));
            }
            match identity(root, focus) {
                Identity::InvalidPath => return Ok(empty(FocusOutcome::InvalidPath)),
                Identity::Denied => return Ok(empty(FocusOutcome::Denied)),
                Identity::Key(key) => {
                    if classify(focus) == Class::Unindexed || classify(&key) == Class::Unindexed {
                        return Ok(empty(FocusOutcome::Unindexed));
                    }
                    vec![key]
                }
            }
        }
        None => {
            let selection = editor.selection()?;
            let mut seeds: Vec<String> = Vec::new();
            for path in selection.selected {
                if let Some(key) = graphable_key(root, &path) {
                    if !seeds.contains(&key) {
                        seeds.push(key);
                    }
                }
            }
            if seeds.is_empty() {
                return Ok(empty(FocusOutcome::NoSelection));
            }
            seeds
        }
    };

    let depth = request.depth.unwrap_or(DEFAULT_DEPTH).clamp(MIN_DEPTH, MAX_DEPTH);
    let max_nodes = request.max_nodes.unwrap_or(DEFAULT_MAX_NODES).min(MAX_NODES) as usize;
    let direction = match request.direction {
        GraphDirection::Imports => BridgeDirection::Imports,
        GraphDirection::ImportedBy => BridgeDirection::ImportedBy,
        GraphDirection::Both => BridgeDirection::Both,
    };

    // 2. Breadth-first over the bridge, one level per call. Only allowed paths
    // are ever requested, so a denied or unindexed file is never enumerated
    // and the walk cannot pass through it.
    let mut visited: BTreeSet<String> = seeds.iter().cloned().collect();
    let mut facts: BTreeMap<String, BridgeNode> = BTreeMap::new();
    let mut seen_edges: BTreeSet<(String, String, bool)> = BTreeSet::new();
    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut reasons: BTreeSet<IndexReason> = BTreeSet::new();
    let mut truncation: BTreeSet<TruncationReason> = BTreeSet::new();
    let mut discovery_in_flight = false;

    let mut frontier: Vec<String> = seeds.clone();
    let mut level = 0u32;
    while level < depth && !frontier.is_empty() {
        frontier.truncate(MAX_GRAPH_FRONTIER as usize);
        let reply = editor.graph(&GraphRequest {
            paths: frontier.clone(),
            direction,
            max_edges_per_node: MAX_EDGES_PER_NODE,
        })?;
        discovery_in_flight |= reply.discovery_in_flight;
        // The owner trimmed incident edges or nodes to its own bounds or the
        // reply ceiling: the neighbourhood is incomplete at this level.
        if reply.omitted > 0 {
            truncation.insert(TruncationReason::Edges);
        }

        for node in reply.nodes {
            if classify(&node.path) == Class::Allowed {
                facts.entry(node.path.clone()).or_insert(node);
            }
        }

        let mut next: Vec<String> = Vec::new();
        for edge in reply.edges {
            // A denied or unindexed endpoint removes the edge.
            if classify(&edge.importer) != Class::Allowed || classify(&edge.exporter) != Class::Allowed {
                continue;
            }
            let manual = matches!(edge.provenance, BridgeProvenance::Manual);
            if !seen_edges.insert((edge.importer.clone(), edge.exporter.clone(), manual)) {
                continue;
            }
            if edges.len() >= MAX_EDGES as usize {
                truncation.insert(TruncationReason::Edges);
                continue;
            }
            let mut symbols: Vec<GraphSymbol> = edge
                .symbols
                .into_iter()
                .map(|symbol| GraphSymbol {
                    name: symbol.name,
                    kind: symbol.kind,
                })
                .collect();
            if symbols.len() > MAX_SYMBOLS_PER_EDGE as usize {
                symbols.truncate(MAX_SYMBOLS_PER_EDGE as usize);
                truncation.insert(TruncationReason::Symbols);
            }
            let provenance = match edge.provenance {
                BridgeProvenance::SourceDerived => EdgeProvenance::SourceDerived {
                    status: edge.status.unwrap_or_default(),
                },
                BridgeProvenance::Manual => EdgeProvenance::Manual,
            };
            for endpoint in [&edge.importer, &edge.exporter] {
                if !visited.contains(endpoint) {
                    next.push(endpoint.clone());
                }
            }
            edges.push(GraphEdge {
                importer: edge.importer,
                exporter: edge.exporter,
                symbols,
                provenance,
                on_canvas: edge.on_canvas,
            });
        }

        frontier.clear();
        for path in next {
            if visited.insert(path.clone()) {
                frontier.push(path);
            }
        }
        level += 1;
    }

    // 3. Freshness, per file node, against the effective revision.
    let index = editor.buffer_index()?;
    let index_omitted = index.omitted > 0;
    let mut buffered: BTreeMap<String, String> = BTreeMap::new();
    for entry in &index.entries {
        if let Identity::Key(key) = identity(root, &entry.path) {
            buffered.insert(key, entry.revision.clone());
        }
    }

    let mut file_nodes: Vec<GraphNode> = Vec::new();
    let mut folders: BTreeSet<String> = BTreeSet::new();
    let mut group_ids: BTreeSet<String> = BTreeSet::new();
    let mut seed_discoverable = false;
    let mut any_stale = false;
    let mut any_unknown = false;
    let mut any_not_parsed = false;
    let mut any_not_discoverable = false;

    // In path order (the facts map is already sorted by path).
    for (path, node) in &facts {
        let effective_key = match identity(root, path) {
            Identity::Key(key) => key,
            _ => path.clone(),
        };
        let freshness = freshness(root, node.parsed.as_ref(), &effective_key, &buffered, index_omitted);
        if node.parsed.is_none() {
            any_not_parsed = true;
        }
        match freshness {
            Freshness::Stale => any_stale = true,
            Freshness::Unknown => any_unknown = true,
            Freshness::Current => {}
        }
        if !node.discoverable {
            any_not_discoverable = true;
        }
        if seeds.contains(path) && node.discoverable {
            seed_discoverable = true;
        }
        if file_nodes.len() >= max_nodes {
            truncation.insert(TruncationReason::MaxNodes);
            continue;
        }
        if let Some(folder) = &node.folder {
            folders.insert(folder.clone());
        } else if let Some(group_id) = &node.group_id {
            group_ids.insert(group_id.clone());
        }
        file_nodes.push(GraphNode::File {
            path: path.clone(),
            on_canvas: node.on_canvas,
            folder: node.folder.clone(),
            group_id: node.group_id.clone(),
            freshness,
            discoverable: node.discoverable,
        });
    }

    // Whether any seed is discoverable at all decides unavailability.
    let seeds_known: Vec<&BridgeNode> = seeds.iter().filter_map(|seed| facts.get(seed)).collect();
    let focus_discoverable = if seeds_known.is_empty() {
        // No facts for the focus (nothing on the canvas for it): neither its
        // discoverability nor its neighbourhood could be observed.
        false
    } else {
        seed_discoverable
    };

    // 4. Folder nodes stand for the folder groups the file nodes belong to.
    let mut nodes = file_nodes;
    for folder in folders {
        nodes.push(GraphNode::Folder {
            folder: Some(folder),
            group_id: None,
        });
    }
    for group_id in group_ids {
        nodes.push(GraphNode::Folder {
            folder: None,
            group_id: Some(group_id),
        });
    }

    // 5. The summary and its reasons.
    if discovery_in_flight {
        reasons.insert(IndexReason::DiscoveryInFlight);
    }
    if any_not_parsed {
        reasons.insert(IndexReason::NotParsed);
    }
    if any_stale {
        reasons.insert(IndexReason::StaleNodes);
    }
    if any_unknown {
        reasons.insert(IndexReason::UnknownNodes);
    }
    if any_not_discoverable {
        reasons.insert(IndexReason::NoRelationshipDiscovery);
    }
    let summary = if !focus_discoverable {
        IndexState::Unavailable
    } else if reasons.is_empty() {
        IndexState::Current
    } else {
        IndexState::Partial
    };

    let mut result = GraphQueryResult {
        focus: FocusOutcome::Resolved,
        nodes,
        edges,
        summary,
        reasons: reasons.into_iter().collect(),
        truncated: false,
        truncated_by: truncation.into_iter().collect(),
    };
    fit(&mut result, ceiling);
    result.truncated = !result.truncated_by.is_empty();
    Ok(result)
}

/// A path that may become a node: valid and allowed (not denied, not
/// unindexed), returning its identity key. Links resolve; a withheld target is
/// dropped like any denied path.
fn graphable_key(root: &Path, path: &str) -> Option<String> {
    if !is_valid_api_path(path) || classify(path) != Class::Allowed {
        return None;
    }
    match identity(root, path) {
        Identity::Key(key) if classify(&key) == Class::Allowed => Some(key),
        _ => None,
    }
}

/// Per-node freshness: compare the parsed revision the owner recorded with the
/// file's effective revision when the query runs.
fn freshness(
    root: &Path,
    parsed: Option<&crate::contracts::project_api_bridge::workspace::ParsedRevision>,
    key: &str,
    buffered: &BTreeMap<String, String>,
    index_omitted: bool,
) -> Freshness {
    let Some(parsed) = parsed else {
        return Freshness::Unknown;
    };
    if let Some(revision) = buffered.get(key) {
        // Effective source is the editor: the buffer is open or dirty.
        if parsed.source == ParsedSource::Editor && &parsed.revision == revision {
            Freshness::Current
        } else {
            Freshness::Stale
        }
    } else if index_omitted {
        // The index may have dropped a buffer for this file: it cannot be
        // ruled out, so the effective revision cannot be observed.
        Freshness::Unknown
    } else {
        // Effective source is disk.
        match read_disk(root, key) {
            DiskRead::Text { revision, .. } => {
                if parsed.source == ParsedSource::Disk && parsed.revision == revision {
                    Freshness::Current
                } else {
                    Freshness::Stale
                }
            }
            _ => Freshness::Unknown,
        }
    }
}

fn encoded_len(result: &GraphQueryResult) -> usize {
    serde_json::to_vec(result).map_or(usize::MAX, |bytes| bytes.len())
}

/// Shed, within the encoded `ceiling`, the lowest-value parts first: edges,
/// then folder nodes, then file nodes. Counts are already bounded, so this is a
/// backstop; when it fires it says so with `ResponseSize`.
fn fit(result: &mut GraphQueryResult, ceiling: usize) {
    let mut shed = false;
    while encoded_len(result) > ceiling {
        if result.edges.pop().is_some() {
            shed = true;
            continue;
        }
        if let Some(index) = result.nodes.iter().rposition(|node| matches!(node, GraphNode::Folder { .. })) {
            result.nodes.remove(index);
            shed = true;
            continue;
        }
        if result.nodes.pop().is_some() {
            shed = true;
            continue;
        }
        break; // nothing left to shed; the dispatcher ceiling is the backstop
    }
    if shed && !result.truncated_by.contains(&TruncationReason::ResponseSize) {
        result.truncated_by.push(TruncationReason::ResponseSize);
        result.truncated_by.sort();
    }
}

#[cfg(test)]
mod tests;
