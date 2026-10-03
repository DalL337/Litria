//! `workspace.selection` (Project API contract brief §7.1, §8): what the user
//! has selected on the canvas, and which document the editor shows.
//!
//! Paths are project-relative and unfiltered: the bridge does not know the
//! disclosure policy, so Rust filters every path here before it counts or
//! returns one (brief §8).

#[cfg(test)]
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::editor::check_path;
use super::BridgeOperation;
use crate::contracts::boundary::{invalid, Validate};
use crate::contracts::error::ContractError;
#[cfg(test)]
use crate::contracts::project_api::files_read::{MAX_PATH_LENGTH, MIN_PATH_LENGTH};

/// Selected paths per reply (brief §10). More are counted as omitted.
pub(crate) const MAX_SELECTED_PATHS: u32 = 1000;
#[cfg(test)]
const MAX_U32: u32 = u32::MAX;

pub(crate) struct SelectionOp;

impl BridgeOperation for SelectionOp {
    const NAME: &'static str = "workspace.selection";
    const DESCRIPTION: &'static str = "The project-relative paths of the files selected on the canvas (in path order, \
         without duplicates, up to maxPaths; the rest are counted as omitted), the selected folder group's path, and \
         the document the editor shows with its unsaved state.";
    const OWNER: &'static str = "SelectionDomain, GroupDomain, EditorDomain";
    type Request = SelectionRequest;
    type Result = SelectionResult;
}

/// Rust → JavaScript.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectionRequest {
    /// List at most this many selected paths.
    pub max_paths: u32,
}

/// JavaScript → Rust.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectionResult {
    /// Selected files, in path order, without duplicates.
    #[cfg_attr(
        test,
        schemars(length(max = MAX_SELECTED_PATHS), inner(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))
    )]
    pub selected: Vec<String>,
    /// Selected files that were not listed (the limit or the reply ceiling).
    #[cfg_attr(test, schemars(range(max = MAX_U32)))]
    pub omitted: u32,
    /// The selected group's folder, when the selected group is a folder group.
    #[serde(default)]
    #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
    pub folder: Option<String>,
    /// The document the editor shows, if any.
    #[serde(default)]
    pub active_document: Option<ActiveDocument>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActiveDocument {
    #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
    pub path: String,
    /// Whether the editor holds unsaved changes for it.
    pub dirty: bool,
}

impl Validate for SelectionResult {
    fn validate(&self) -> Result<(), ContractError> {
        if self.selected.len() > MAX_SELECTED_PATHS as usize {
            return Err(invalid(format!("selected: at most {MAX_SELECTED_PATHS}")));
        }
        for path in &self.selected {
            check_path(path)?;
        }
        if let Some(folder) = &self.folder {
            check_path(folder)?;
        }
        if let Some(active) = &self.active_document {
            check_path(&active.path)?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// workspace.graph (Project API contract brief §7.4; P4c)
// ---------------------------------------------------------------------------
//
// The contract is complete and committed (artifacts, fixtures, the JavaScript
// owner answer and its tests). Its Rust consumer is the `litria_graph_query`
// handler (`project_api::graph_query`), which drives the walk one level at a
// time over this operation.
mod graph_contract {
    #[cfg(test)]
    use schemars::JsonSchema;
    use serde::{Deserialize, Serialize};

    use super::check_path;
    use super::BridgeOperation;
    use crate::contracts::boundary::{invalid, Validate};
    use crate::contracts::error::ContractError;
    #[cfg(test)]
    use crate::contracts::project_api::files_read::{MAX_PATH_LENGTH, MIN_PATH_LENGTH};

/// Frontier paths named in one `workspace.graph` request (one walk level).
pub(crate) const MAX_GRAPH_FRONTIER: u32 = 200;
/// Edges incident to one frontier node that a reply may carry.
pub(crate) const MAX_EDGES_PER_NODE: u32 = 500;
/// Symbols named on one edge (brief §10).
pub(crate) const MAX_SYMBOLS_PER_EDGE: u32 = 50;
/// Nodes and edges a reply may carry overall (the per-level walk is bounded,
/// so these only backstop a reply the owner should already have trimmed).
pub(crate) const MAX_GRAPH_NODES: u32 = 10_000;
pub(crate) const MAX_GRAPH_EDGES: u32 = 50_000;
#[cfg(test)]
const MAX_U32: u32 = u32::MAX;

pub(crate) struct GraphOp;

impl BridgeOperation for GraphOp {
    const NAME: &'static str = "workspace.graph";
    const DESCRIPTION: &'static str = "A frontier-scoped slice of the import graph. For each requested project-relative \
         path, the reply carries its node facts (on-canvas, its folder group or an opaque legacy group id, the parsed \
         source and revision if recorded, and whether its language has relationship discovery) and the edges incident \
         to it in the requested direction (importer to exporter, with symbols, provenance and whether the wire is \
         drawn). The graph is built from pieces, wires and pending edges, never from raw registrations; an edge's \
         paths may be stale. Anything over a bound is counted in omitted. The reply also carries whether a discovery \
         run is in flight.";
    const OWNER: &'static str = "PieceDomain, GroupDomain, SyntaxDomain, DiscoveryLifecycle";
    type Request = GraphRequest;
    type Result = GraphResult;
}

/// The walk direction, importer to exporter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum GraphDirection {
    /// Edges where the requested path is the importer: what it imports.
    Imports,
    /// Edges where the requested path is the exporter: what imports it.
    ImportedBy,
    /// Either side.
    Both,
}

/// Rust → JavaScript.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphRequest {
    /// The frontier: project-relative paths, forward slashes, already allowed.
    pub paths: Vec<String>,
    pub direction: GraphDirection,
    /// At most this many incident edges per frontier node.
    pub max_edges_per_node: u32,
}

/// JavaScript → Rust.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GraphResult {
    #[cfg_attr(test, schemars(length(max = MAX_GRAPH_NODES)))]
    pub nodes: Vec<GraphNode>,
    #[cfg_attr(test, schemars(length(max = MAX_GRAPH_EDGES)))]
    pub edges: Vec<GraphEdge>,
    /// An initial discovery run or a refresh is reading files or armed.
    pub discovery_in_flight: bool,
    /// Nodes or edges that did not fit a bound or the reply ceiling.
    #[cfg_attr(test, schemars(range(max = MAX_U32)))]
    pub omitted: u32,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GraphNode {
    #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
    pub path: String,
    /// A piece for the file is on the canvas.
    pub on_canvas: bool,
    /// The folder group's folder, when the file's piece is in a folder group.
    #[serde(default)]
    #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
    pub folder: Option<String>,
    /// An opaque id for a legacy group without a folder.
    #[serde(default)]
    pub group_id: Option<String>,
    /// The `{ source, revision }` the file was parsed from, if recorded.
    #[serde(default)]
    pub parsed: Option<ParsedRevision>,
    /// The file's language has relationship discovery (`isDiscoverableFilename`).
    pub discoverable: bool,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ParsedRevision {
    pub source: ParsedSource,
    #[cfg_attr(test, schemars(length(min = 1, max = crate::contracts::project_api_bridge::editor::MAX_REVISION_LENGTH)))]
    pub revision: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum ParsedSource {
    Editor,
    Disk,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GraphEdge {
    #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
    pub importer: String,
    #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
    pub exporter: String,
    #[cfg_attr(test, schemars(length(max = MAX_SYMBOLS_PER_EDGE)))]
    pub symbols: Vec<GraphSymbol>,
    pub provenance: EdgeProvenance,
    /// The SyntaxDomain aggregate status for a `sourceDerived` edge (including
    /// the domain-only `orphaned`); absent for a `manual` wire.
    #[serde(default)]
    #[cfg_attr(test, schemars(length(max = MAX_STATUS_LENGTH)))]
    pub status: Option<String>,
    /// The wire is drawn on the canvas.
    pub on_canvas: bool,
}

/// A SyntaxDomain status is a short opaque token; this bounds the field.
#[cfg(test)]
const MAX_STATUS_LENGTH: usize = 64;

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GraphSymbol {
    #[cfg_attr(test, schemars(length(min = 1, max = MAX_SYMBOL_LENGTH)))]
    pub name: String,
    #[cfg_attr(test, schemars(length(max = MAX_SYMBOL_LENGTH)))]
    pub kind: String,
}

#[cfg(test)]
const MAX_SYMBOL_LENGTH: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum EdgeProvenance {
    /// Derived from a SyntaxDomain import edge.
    SourceDerived,
    /// A hand-drawn wire with no import behind it.
    Manual,
}

impl Validate for GraphResult {
    fn validate(&self) -> Result<(), ContractError> {
        if self.nodes.len() > MAX_GRAPH_NODES as usize {
            return Err(invalid(format!("nodes: at most {MAX_GRAPH_NODES}")));
        }
        if self.edges.len() > MAX_GRAPH_EDGES as usize {
            return Err(invalid(format!("edges: at most {MAX_GRAPH_EDGES}")));
        }
        for node in &self.nodes {
            check_path(&node.path)?;
            if let Some(folder) = &node.folder {
                check_path(folder)?;
            }
        }
        for edge in &self.edges {
            check_path(&edge.importer)?;
            check_path(&edge.exporter)?;
            if edge.symbols.len() > MAX_SYMBOLS_PER_EDGE as usize {
                return Err(invalid(format!("symbols: at most {MAX_SYMBOLS_PER_EDGE} per edge")));
            }
            for symbol in &edge.symbols {
                if symbol.name.is_empty() {
                    return Err(invalid("symbols: a symbol name is empty"));
                }
            }
        }
        Ok(())
    }
}
}

#[allow(unused_imports)]
pub(crate) use graph_contract::*;
