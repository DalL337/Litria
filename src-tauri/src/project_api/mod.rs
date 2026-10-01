//! The Project API service (ADR-031): the Rust boundary an external
//! principal's calls pass through.
//!
//! Contract design: docs/plans/agent-integration/brief-project-api-contract.md.
//! Delivery: docs/plans/agent-integration/project-api-build-plan.md.
//! Contract types live in `contracts::project_api`; this module holds the
//! behaviour behind them — the workspace fence, path validation, the
//! disclosure policy and bounded reads. It calls `path_guard` and `db`
//! directly, never the Tauri command adapters.
//!
//! Consumers today: the debug-only `project_api_dev_call` and the tests. The
//! external transport (build plan track T) is the release consumer.

pub(crate) mod bridge;
mod files_read;
mod paths;
mod policy;
mod reader;
mod workspace;

use std::sync::OnceLock;

#[cfg(debug_assertions)]
use serde_json::Value;

use crate::contracts::catalog::{Dispatcher, Limits};
#[cfg(debug_assertions)]
use crate::contracts::context::{CallContext, Grant, Principal};
#[cfg(debug_assertions)]
use crate::contracts::error::{ContractError, ErrorCode};
use crate::contracts::project_api::files_read::FilesReadOp;
#[cfg(debug_assertions)]
use crate::contracts::project_api_bridge::{BridgeRequestEvent, REQUEST_EVENT};

/// Encoded size of any operation's result (brief §10).
pub(crate) const MAX_RESPONSE_BYTES: usize = 384 * 1024;

const LIMITS: Limits = Limits {
    max_in_flight_per_principal: 4,
    max_response_bytes: MAX_RESPONSE_BYTES,
};

/// The family's dispatcher, shared so in-flight ceilings hold across callers.
pub(crate) fn dispatcher() -> &'static Dispatcher {
    static DISPATCHER: OnceLock<Dispatcher> = OnceLock::new();
    DISPATCHER.get_or_init(|| {
        let mut dispatcher = Dispatcher::new(LIMITS);
        dispatcher.register::<FilesReadOp>(files_read::handle);
        dispatcher
    })
}

/// Debug builds only (implementation-policy Rule 3): call an operation as the
/// `dev` principal with every capability, bound to whatever workspace is open
/// now. For driving the live app over CDP before a transport exists. `payload`
/// is the raw request JSON, so byte budgets and parsing run exactly as they
/// will for an external caller.
#[cfg(debug_assertions)]
pub(crate) fn dev_call(operation: &str, payload: &[u8]) -> Result<Value, ContractError> {
    let epoch = workspace::current_epoch()
        .ok_or_else(|| ContractError::new(ErrorCode::NotReady, "no project workspace is open"))?;
    let dispatcher = dispatcher();
    let context = CallContext {
        principal: Principal::Dev,
        grant: Grant::of(dispatcher.capabilities()),
        epoch,
    };
    dispatcher.dispatch(&context, operation, payload)
}

// --- The owner bridge's command side (debug builds, see commands.rs) --------

/// Attach the frontend bridge for `epoch`; refused unless it is the
/// workspace open now.
#[cfg(debug_assertions)]
pub(crate) fn bridge_attach(epoch: &str) -> Result<String, ContractError> {
    bridge::global().attach(epoch, workspace::current_epoch().as_deref())
}

#[cfg(debug_assertions)]
pub(crate) fn bridge_detach(generation: &str) -> bool {
    bridge::global().detach(generation)
}

#[cfg(debug_assertions)]
pub(crate) fn bridge_reply(request_id: &str, generation: &str, reply: String) {
    bridge::global().deliver_reply(request_id, generation, reply);
}

/// Emits bridge requests to the main window only.
#[cfg(debug_assertions)]
struct MainWindow(tauri::AppHandle);

#[cfg(debug_assertions)]
impl bridge::Emit for MainWindow {
    fn emit(&self, event: &BridgeRequestEvent) -> bool {
        use tauri::Emitter;
        self.0.emit_to("main", REQUEST_EVENT, event).is_ok()
    }
}

/// Called once at startup.
#[cfg(debug_assertions)]
pub(crate) fn install_bridge(app: tauri::AppHandle) {
    bridge::global().install_emitter(std::sync::Arc::new(MainWindow(app)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::catalog::check_complete;
    use crate::contracts::project_api::catalog;

    /// The production dispatcher registers exactly the family's catalog.
    #[test]
    fn the_service_covers_the_catalog_exactly() {
        check_complete(dispatcher(), &catalog()).unwrap();
    }
}
