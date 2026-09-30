//! The workspace fence (Project API contract brief §4.1, §4.3).
//!
//! The root comes from Rust's own binding (`db::workspace_binding`), never
//! from a request. Each operation checks the caller's epoch against the
//! binding when it starts and again before it answers; a switch in between
//! discards the partial result. The database lock is held only to copy the
//! binding out — never across file work.

use std::path::{Path, PathBuf};

use crate::contracts::context::CallContext;
use crate::contracts::error::{ContractError, ErrorCode};
use crate::db;

fn bound_root(context: &CallContext) -> Result<PathBuf, ContractError> {
    match db::workspace_binding() {
        None => Err(ContractError::new(ErrorCode::NotReady, "no project workspace is open")),
        Some((epoch, _)) if epoch != context.epoch => Err(ContractError::new(
            ErrorCode::WorkspaceChanged,
            "the open project changed since this connection attached",
        )),
        Some((_, None)) => Err(ContractError::new(
            ErrorCode::NotReady,
            "the open project's root could not be resolved",
        )),
        Some((_, Some(root))) => Ok(root),
    }
}

/// Run `work` against the root bound to the caller's epoch, and answer only
/// if that binding still holds afterwards.
pub(crate) fn fenced<T>(
    context: &CallContext,
    work: impl FnOnce(&Path) -> Result<T, ContractError>,
) -> Result<T, ContractError> {
    let root = bound_root(context)?;
    let value = work(&root)?;
    bound_root(context)?;
    Ok(value)
}

/// The epoch a debug-build dev call attaches to: whatever is open now.
#[cfg(debug_assertions)]
pub(crate) fn current_epoch() -> Option<String> {
    db::workspace_binding().map(|(epoch, _)| epoch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::context::{Grant, Principal};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(tag: &str) -> PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("litria-api-fence-{tag}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn context(epoch: &str) -> CallContext {
        CallContext {
            principal: Principal::Test,
            grant: Grant::default(),
            epoch: epoch.to_owned(),
        }
    }

    #[test]
    fn no_open_workspace_is_not_ready() {
        let _serial = db::serial_guard();
        db::close_workspace_db().unwrap();
        let error = fenced(&context("ws-any"), |_| Ok(())).unwrap_err();
        assert_eq!(error.code, ErrorCode::NotReady);
    }

    #[test]
    fn a_stale_epoch_is_refused_before_any_work() {
        let _serial = db::serial_guard();
        let root = temp_root("stale");
        let (_ro, epoch) = db::open_workspace_db(&root).unwrap();
        let ran = std::cell::Cell::new(false);
        let error = fenced(&context("ws-stale"), |_| {
            ran.set(true);
            Ok(())
        })
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::WorkspaceChanged);
        assert!(!ran.get(), "no work runs against the wrong workspace");
        // The live epoch works, against the canonical root.
        let seen = fenced(&context(&epoch), |bound| Ok(bound.to_path_buf())).unwrap();
        assert_eq!(seen, fs::canonicalize(&root).unwrap());
        db::close_workspace_db().unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    /// A switch injected between start and answer returns `workspaceChanged`
    /// and discards the result.
    #[test]
    fn a_switch_during_the_work_discards_the_result() {
        let _serial = db::serial_guard();
        let first = temp_root("switch-a");
        let second = temp_root("switch-b");
        let (_ro, epoch) = db::open_workspace_db(&first).unwrap();
        let error = fenced(&context(&epoch), |_| {
            db::open_workspace_db(&second).unwrap();
            Ok("a result computed for the first project")
        })
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::WorkspaceChanged);
        assert!(!error.message.contains("ws-"), "epochs are not disclosed: {}", error.message);
        db::close_workspace_db().unwrap();
        let _ = fs::remove_dir_all(&first);
        let _ = fs::remove_dir_all(&second);
    }
}
