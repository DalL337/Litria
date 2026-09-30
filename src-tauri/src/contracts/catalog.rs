//! Operation catalog and typed registration (ADR-033 decision 7).
//!
//! Each operation is one `Operation` impl naming its request and result types.
//! The catalog the generator and transports read, and the dispatcher that runs
//! handlers, are both built from those impls: a handler can only be registered
//! for an `Operation`, taking its request type and returning its result type,
//! so a type mismatch is a compile error. `check_complete` catches the other
//! two ways names drift apart — an entry without a handler, or a handler
//! without an entry.

use std::collections::{BTreeMap, BTreeSet};

use schemars::{JsonSchema, Schema};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use super::artifacts::{inbound_schema, outbound_schema};
use super::boundary::{accept, Validate};
use super::error::{ContractError, ErrorCode};

pub(crate) trait Operation: 'static {
    const NAME: &'static str;
    const DESCRIPTION: &'static str;
    /// Capability an external principal needs to call the operation.
    const CAPABILITY: &'static str;
    type Request: DeserializeOwned + JsonSchema + Validate;
    /// Emitted to external callers and read back from the JavaScript bridge,
    /// so results are both serializable and deserializable.
    type Result: Serialize + DeserializeOwned + JsonSchema;
}

/// A type-erased catalog entry: everything the generator, transports and
/// fixture tests need, without knowing the concrete types.
pub(crate) struct OperationEntry {
    pub name: &'static str,
    pub description: &'static str,
    pub capability: &'static str,
    pub request_schema: fn() -> Schema,
    pub result_schema_out: fn() -> Schema,
    pub result_schema_in: fn() -> Schema,
    /// The full inbound boundary for a request (budget, serde, validation).
    pub accept_request: fn(&[u8]) -> Result<(), ContractError>,
    /// Reading a result back from a producer (the JavaScript bridge side).
    pub accept_result: fn(&[u8]) -> Result<(), ContractError>,
}

pub(crate) fn entry<O: Operation>() -> OperationEntry {
    OperationEntry {
        name: O::NAME,
        description: O::DESCRIPTION,
        capability: O::CAPABILITY,
        request_schema: inbound_schema::<O::Request>,
        result_schema_out: outbound_schema::<O::Result>,
        result_schema_in: inbound_schema::<O::Result>,
        accept_request: accept_request::<O::Request>,
        accept_result: accept_result::<O::Result>,
    }
}

fn accept_request<T: DeserializeOwned + Validate>(raw: &[u8]) -> Result<(), ContractError> {
    accept::<T>(raw).map(|_| ())
}

fn accept_result<T: DeserializeOwned>(raw: &[u8]) -> Result<(), ContractError> {
    serde_json::from_slice::<T>(raw)
        .map(|_| ())
        .map_err(|error| ContractError::new(ErrorCode::InvalidParams, error.to_string()))
}

type Handler = Box<dyn Fn(&[u8]) -> Result<Value, ContractError>>;

/// Hand-written dispatch, bound to the catalog by typed registration.
#[derive(Default)]
pub(crate) struct Dispatcher {
    handlers: BTreeMap<&'static str, Handler>,
}

impl Dispatcher {
    pub(crate) fn register<O: Operation>(
        &mut self,
        handler: impl Fn(O::Request) -> Result<O::Result, ContractError> + 'static,
    ) -> &mut Self {
        let erased: Handler = Box::new(move |raw| {
            let request = accept::<O::Request>(raw)?;
            let result = handler(request)?;
            serde_json::to_value(result)
                .map_err(|error| ContractError::new(ErrorCode::Internal, error.to_string()))
        });
        let previous = self.handlers.insert(O::NAME, erased);
        assert!(previous.is_none(), "operation `{}` registered twice", O::NAME);
        self
    }

    /// Every catalog entry has a handler and every handler has an entry.
    pub(crate) fn check_complete(&self, catalog: &[OperationEntry]) -> Result<(), String> {
        let registered: BTreeSet<&str> = self.handlers.keys().copied().collect();
        let listed: BTreeSet<&str> = catalog.iter().map(|entry| entry.name).collect();
        let missing: Vec<&str> = listed.difference(&registered).copied().collect();
        let orphaned: Vec<&str> = registered.difference(&listed).copied().collect();
        if missing.is_empty() && orphaned.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "catalog entries without a handler: {missing:?}; handlers without a catalog entry: {orphaned:?}"
            ))
        }
    }

    pub(crate) fn dispatch(&self, name: &str, raw: &[u8]) -> Result<Value, ContractError> {
        let handler = self.handlers.get(name).ok_or_else(|| {
            ContractError::new(
                ErrorCode::UnknownOperation,
                format!("unknown operation `{name}`"),
            )
        })?;
        handler(raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::project_api::{
        catalog, sample_dispatcher, samples, FilesReadOp, ProjectContext, ProjectContextOp,
        ProjectContextRequest,
    };

    /// An operation that exists in code but not in the family's catalog.
    struct OrphanOp;

    impl Operation for OrphanOp {
        const NAME: &'static str = "litria_orphan";
        const DESCRIPTION: &'static str = "Registered, never listed.";
        const CAPABILITY: &'static str = "project.context.read";
        type Request = ProjectContextRequest;
        type Result = ProjectContext;
    }

    #[test]
    fn the_sample_dispatcher_covers_the_catalog_exactly() {
        sample_dispatcher().check_complete(&catalog()).unwrap();
    }

    #[test]
    fn a_catalog_entry_without_a_handler_fails() {
        let mut dispatcher = Dispatcher::default();
        dispatcher.register::<ProjectContextOp>(|_| Ok(samples::project_context(false)));
        let error = dispatcher.check_complete(&catalog()).unwrap_err();
        assert!(error.contains(FilesReadOp::NAME), "{error}");
    }

    #[test]
    fn a_handler_without_a_catalog_entry_fails() {
        let mut dispatcher = sample_dispatcher();
        dispatcher.register::<OrphanOp>(|_| Ok(samples::project_context(false)));
        let error = dispatcher.check_complete(&catalog()).unwrap_err();
        assert!(error.contains(OrphanOp::NAME), "{error}");
    }

    #[test]
    #[should_panic(expected = "registered twice")]
    fn registering_an_operation_twice_panics() {
        let mut dispatcher = sample_dispatcher();
        dispatcher.register::<FilesReadOp>(|_| Ok(samples::files_read_result()));
    }

    #[test]
    fn dispatch_runs_the_full_boundary_before_the_handler() {
        let dispatcher = sample_dispatcher();
        let error = dispatcher
            .dispatch(ProjectContextOp::NAME, br#"{"includeSelection":true,"extra":1}"#)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidParams);
        let error = dispatcher.dispatch("litria_nope", b"{}").unwrap_err();
        assert_eq!(error.code, ErrorCode::UnknownOperation);
    }
}
