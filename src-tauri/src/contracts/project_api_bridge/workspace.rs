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
