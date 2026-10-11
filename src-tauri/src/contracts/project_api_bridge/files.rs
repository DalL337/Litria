//! FilesystemWriteManager operations of the bridge family (Project API build
//! plan W3b): `files.create`.
//!
//! Every disk write passes through the frontend's filesystem write manager
//! (contract brief §8), so an agent's new files are created there, with the
//! manager's create-if-absent (W3a), and put on the canvas by the same owner.

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

pub(crate) struct CreateFilesOp;

impl BridgeOperation for CreateFilesOp {
    const NAME: &'static str = "files.create";
    const DESCRIPTION: &'static str = "Create each file through the filesystem write manager, only if nothing has \
         its name (never an overwrite), and show each created file on the canvas (not opened in the editor). One \
         answer per file, in request order: created; exists (something has the name, on disk or open in the \
         editor); or failed (not created: the write failed, or the workspace changed while creating). Rust sends \
         only paths the disclosure policy allows.";
    const OWNER: &'static str = "FilesystemWriteManager";
    /// Disk work and canvas pieces for up to sixteen files: five times the
    /// bridge's usual wait.
    const DEADLINE_FACTOR: u32 = 5;
    type Request = CreateFilesRequest;
    type Result = CreateFilesResult;
}

/// Rust → JavaScript.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateFilesRequest {
    pub files: Vec<FileToCreate>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileToCreate {
    /// The project-relative path, exactly as the plan names it.
    pub path: String,
    pub text: String,
}

/// JavaScript → Rust: one entry per requested file, in request order.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateFilesResult {
    #[cfg_attr(test, schemars(length(min = 1, max = MAX_CHANGES)))]
    pub files: Vec<CreatedFile>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub(crate) enum CreatedFile {
    /// Created on disk with exactly the requested text.
    Created {
        #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
        path: String,
    },
    /// Not created: something has the name. Nothing was replaced.
    Exists {
        #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
        path: String,
    },
    /// Not created, for any other reason.
    Failed {
        #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
        path: String,
    },
}

impl CreatedFile {
    pub(crate) fn path(&self) -> &str {
        match self {
            CreatedFile::Created { path } | CreatedFile::Exists { path } | CreatedFile::Failed { path } => path,
        }
    }
}

impl Validate for CreateFilesResult {
    fn validate(&self) -> Result<(), ContractError> {
        let count = self.files.len();
        if !(1..=MAX_CHANGES).contains(&count) {
            return Err(invalid(format!("files: expected 1 to {MAX_CHANGES} entries")));
        }
        self.files.iter().try_for_each(|file| check_path(file.path()))
    }
}
