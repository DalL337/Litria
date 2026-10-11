//! Canvas operations of the bridge family (Project API build plan W3c):
//! `canvas.showFiles`.
//!
//! Every session document belongs to a canvas piece, so a document an agent's
//! edit opens is put on the canvas first: a piece for each file that has none,
//! made by PieceDomain from the file on disk, with no editor tab.

#[cfg(test)]
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::editor::check_path;
use super::BridgeOperation;
use crate::contracts::boundary::{invalid, Validate};
use crate::contracts::error::ContractError;
use crate::contracts::project_api::changes_prepare::MAX_CHANGES;
#[cfg(test)]
use crate::contracts::project_api::files_read::{MAX_PATH_LENGTH, MIN_PATH_LENGTH};

pub(crate) struct ShowFilesOp;

impl BridgeOperation for ShowFilesOp {
    const NAME: &'static str = "canvas.showFiles";
    const DESCRIPTION: &'static str = "Put each existing file on the canvas: a piece made from the file on disk for \
         each file that has none (no editor tab). One answer per file, in request order: shown (it has a piece now) \
         or failed. Rust sends only paths the disclosure policy allows.";
    const OWNER: &'static str = "PieceDomain";
    /// A piece is a database row per file: five times the bridge's usual wait.
    const DEADLINE_FACTOR: u32 = 5;
    type Request = ShowFilesRequest;
    type Result = ShowFilesResult;
}

/// Rust → JavaScript.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShowFilesRequest {
    pub paths: Vec<String>,
}

/// JavaScript → Rust: one entry per requested path, in request order.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ShowFilesResult {
    #[cfg_attr(test, schemars(length(min = 1, max = MAX_CHANGES)))]
    pub files: Vec<ShownFile>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub(crate) enum ShownFile {
    /// The file has a canvas piece now (made, or already there).
    Shown {
        #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
        path: String,
    },
    /// No piece could be made.
    Failed {
        #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
        path: String,
    },
}

impl ShownFile {
    pub(crate) fn path(&self) -> &str {
        match self {
            ShownFile::Shown { path } | ShownFile::Failed { path } => path,
        }
    }
}

impl Validate for ShowFilesResult {
    fn validate(&self) -> Result<(), ContractError> {
        let count = self.files.len();
        if !(1..=MAX_CHANGES).contains(&count) {
            return Err(invalid(format!("files: expected 1 to {MAX_CHANGES} entries")));
        }
        self.files.iter().try_for_each(|file| check_path(file.path()))
    }
}
