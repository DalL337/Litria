//! `litria_graph_query` (Project API contract brief §7.4, §10): a bounded,
//! path-identified neighbourhood of import relationships, with derived
//! provenance and honest per-node freshness.

#[cfg(test)]
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::files_read::{MAX_PATH_LENGTH, MIN_PATH_LENGTH};
use crate::contracts::boundary::{invalid, schema_length, Validate};
use crate::contracts::catalog::Operation;
use crate::contracts::error::ContractError;

/// Walk depth (brief §7.4). At most two levels out from the focus.
pub(crate) const MIN_DEPTH: u32 = 1;
pub(crate) const MAX_DEPTH: u32 = 2;
pub(crate) const DEFAULT_DEPTH: u32 = 1;
/// Nodes returned per call (brief §10): the default and the server ceiling.
pub(crate) const DEFAULT_MAX_NODES: u32 = 50;
pub(crate) const MAX_NODES: u32 = 100;
/// Edges returned per call (brief §10).
pub(crate) const MAX_EDGES: u32 = 500;
/// Symbols named on one edge (brief §10).
pub(crate) const MAX_SYMBOLS_PER_EDGE: u32 = 50;

pub(crate) struct GraphQueryOp;

impl Operation for GraphQueryOp {
    const NAME: &'static str = "litria_graph_query";
    const DESCRIPTION: &'static str = "Return a bounded neighbourhood of import relationships around a focus (a \
         project-relative path, or the current canvas selection), out to a depth of 1 or 2, in a direction (imports, \
         importedBy or both). File nodes carry their folder group and whether they are on the canvas; folder nodes \
         stand for the folder groups the file nodes belong to. Edges run from importer to exporter, with the imported \
         symbols, a provenance (sourceDerived with the syntax status, or manual) and whether the wire is drawn. \
         Denied and unindexed paths are never nodes and edges touching them are dropped. Each node carries its \
         freshness (current, stale or unknown); the summary is current only when every node is, otherwise partial or \
         unavailable with reasons. A walk that hits maxNodes, the edge ceiling or the symbol ceiling says so in \
         truncatedBy.";
    const CAPABILITY: &'static str = "project.graph.read";
    type Request = GraphQueryRequest;
    type Result = GraphQueryResult;
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GraphQueryRequest {
    /// The focus file (project-relative, forward slashes). Absent means the
    /// current canvas selection.
    #[serde(default)]
    #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
    pub focus: Option<String>,
    /// How far to walk (1 or 2); absent means the server default.
    #[serde(default)]
    #[cfg_attr(test, schemars(range(min = MIN_DEPTH, max = MAX_DEPTH)))]
    pub depth: Option<u32>,
    /// Which edges to follow. Defaults to both.
    #[serde(default)]
    pub direction: GraphDirection,
    /// At most this many nodes; absent means the server default.
    #[serde(default)]
    #[cfg_attr(test, schemars(range(min = 1, max = MAX_NODES)))]
    pub max_nodes: Option<u32>,
}

/// The walk direction, importer to exporter.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum GraphDirection {
    /// What the focus imports.
    Imports,
    /// What imports the focus.
    ImportedBy,
    /// Both.
    #[default]
    Both,
}

impl Validate for GraphQueryRequest {
    fn validate(&self) -> Result<(), ContractError> {
        if let Some(focus) = &self.focus {
            let length = schema_length(focus);
            if !(MIN_PATH_LENGTH..=MAX_PATH_LENGTH).contains(&length) {
                return Err(invalid(format!(
                    "focus: expected {MIN_PATH_LENGTH} to {MAX_PATH_LENGTH} characters, got {length}"
                )));
            }
        }
        if let Some(depth) = self.depth {
            if !(MIN_DEPTH..=MAX_DEPTH).contains(&depth) {
                return Err(invalid(format!("depth: expected {MIN_DEPTH} to {MAX_DEPTH}")));
            }
        }
        if let Some(max_nodes) = self.max_nodes {
            if !(1..=MAX_NODES).contains(&max_nodes) {
                return Err(invalid(format!("maxNodes: expected 1 to {MAX_NODES}")));
            }
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphQueryResult {
    /// What became of the focus. A neighbourhood is returned only when it is
    /// `resolved`; every other outcome mirrors `litria_files_read`, revealing
    /// nothing more.
    pub focus: FocusOutcome,
    /// File and folder nodes, file nodes in path order.
    pub nodes: Vec<GraphNode>,
    /// Edges from importer to exporter.
    pub edges: Vec<GraphEdge>,
    /// The neighbourhood's freshness, summarised.
    pub summary: IndexState,
    /// Why the summary is not `current`, in a fixed order.
    pub reasons: Vec<IndexReason>,
    /// The walk stopped before covering everything; see `truncatedBy`.
    pub truncated: bool,
    pub truncated_by: Vec<TruncationReason>,
}

/// What the focus resolved to. A reader that meets an unfamiliar value must not
/// assume a neighbourhood was returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum FocusOutcome {
    /// A neighbourhood was walked (nodes and edges below).
    Resolved,
    /// The disclosure policy withholds the focus. Existence is not revealed.
    Denied,
    /// The focus is in a directory the graph never enters (dependencies, build
    /// output). Readable by explicit path, but not graphed.
    Unindexed,
    /// The focus is not a path the API accepts (contract brief §6).
    InvalidPath,
    /// No focus was given and nothing disclosable is selected on the canvas.
    NoSelection,
}

/// A node, identified by path (file) or by its folder group (folder).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum GraphNode {
    /// A file in the neighbourhood.
    File {
        path: String,
        /// A piece for the file is on the canvas.
        on_canvas: bool,
        /// The folder group's folder, when the file's piece is in a folder group.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        folder: Option<String>,
        /// An opaque id for a legacy group without a folder.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        group_id: Option<String>,
        /// Honest freshness of the parsed text against the file's effective text.
        freshness: Freshness,
        /// The file's language has relationship discovery.
        discoverable: bool,
    },
    /// A folder group the returned file nodes belong to.
    Folder {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        folder: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        group_id: Option<String>,
    },
}

/// Per-node freshness (brief §7.4). A reader that meets an unfamiliar value
/// must not treat the node as current.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum Freshness {
    /// The parsed revision equals the file's effective revision, same source.
    Current,
    /// Both revisions are known and differ (including a different source).
    Stale,
    /// No parsed revision is recorded, the effective one cannot be observed,
    /// or the buffer index omitted the document. Never shown as current.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphEdge {
    pub importer: String,
    pub exporter: String,
    /// The imported symbols, at most 50.
    pub symbols: Vec<GraphSymbol>,
    pub provenance: EdgeProvenance,
    /// The wire is drawn on the canvas.
    pub on_canvas: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphSymbol {
    pub name: String,
    pub kind: String,
}

/// An edge's provenance. A reader that meets an unfamiliar `kind` must treat
/// the edge as of unknown origin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum EdgeProvenance {
    /// A syntax edge exists; its SyntaxDomain status is included (the
    /// domain-only `orphaned` is reported as itself).
    SourceDerived { status: String },
    /// A hand-drawn wire with no syntax edge behind it.
    Manual,
}

/// The neighbourhood's freshness, summarised. A reader that meets an
/// unfamiliar value must not treat the neighbourhood as current.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum IndexState {
    /// Every returned node is `current`.
    Current,
    /// Some nodes are stale or unknown; see `reasons`.
    Partial,
    /// The focus itself has no relationship discovery, so no neighbourhood
    /// can be trusted.
    Unavailable,
}

/// Why the summary is not `current`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum IndexReason {
    /// A returned file has no recorded parsed revision.
    NotParsed,
    /// A discovery run is in flight.
    DiscoveryInFlight,
    /// A returned node is stale.
    StaleNodes,
    /// A returned node's freshness is unknown.
    UnknownNodes,
    /// A returned file's language has no relationship discovery.
    NoRelationshipDiscovery,
}

/// A limit that ended or narrowed the walk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum TruncationReason {
    /// More nodes exist than `maxNodes` allowed.
    MaxNodes,
    /// The edge ceiling was reached.
    Edges,
    /// An edge named more than 50 symbols.
    Symbols,
    /// The encoded response ceiling was reached.
    ResponseSize,
}
