//! Operation catalog, typed registration and dispatch (ADR-033 decision 7).
//!
//! Each operation is one `Operation` impl naming its request and result
//! types. A handler can only be registered for an `Operation`, taking its
//! request type and returning its result type, so a type mismatch is a compile
//! error. `check_complete` (tests) catches the other two ways names drift
//! apart: an entry without a handler, or a handler without an entry.
//!
//! Dispatch order (Project API contract brief §9–§10): unknown operation →
//! grant → in-flight ceiling → the three-layer inbound boundary → handler →
//! encoded response ceiling. Workspace fencing belongs to the family's service,
//! not to this generic machinery.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use super::boundary::{accept, Validate};
use super::context::{CallContext, Principal};
use super::error::{ContractError, ErrorCode};

pub(crate) trait Operation: 'static {
    const NAME: &'static str;
    // Read by artifact generation (tests) today; the MCP transport's
    // `tools/list` publishes it (build plan track T).
    #[cfg_attr(not(test), allow(dead_code))]
    const DESCRIPTION: &'static str;
    /// Capability an external principal needs to call the operation.
    const CAPABILITY: &'static str;
    type Request: DeserializeOwned + Validate;
    /// Emitted to callers; also readable back, so the fixtures can prove the
    /// tolerant-reader rules (ADR-033 decision 6).
    type Result: Serialize + DeserializeOwned;
}

/// Ceilings a dispatcher enforces around every call.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    /// Operations one principal may have in flight at once; more get `busy`.
    pub max_in_flight_per_principal: usize,
    /// Encoded size of a successful result. Handlers build within it; this is
    /// the backstop that turns an overrun into `internal` instead of sending it.
    pub max_response_bytes: usize,
}

type Handler = Box<dyn Fn(&CallContext, &[u8]) -> Result<Value, ContractError> + Send + Sync>;

struct Registered {
    capability: &'static str,
    handler: Handler,
}

/// Hand-written dispatch, bound to the catalog by typed registration.
pub(crate) struct Dispatcher {
    limits: Limits,
    handlers: BTreeMap<&'static str, Registered>,
    in_flight: Mutex<BTreeMap<Principal, usize>>,
}

impl Dispatcher {
    pub(crate) fn new(limits: Limits) -> Self {
        Self {
            limits,
            handlers: BTreeMap::new(),
            in_flight: Mutex::new(BTreeMap::new()),
        }
    }

    pub(crate) fn register<O: Operation>(
        &mut self,
        handler: impl Fn(&CallContext, O::Request) -> Result<O::Result, ContractError> + Send + Sync + 'static,
    ) -> &mut Self {
        let erased: Handler = Box::new(move |context, raw| {
            let request = accept::<O::Request>(raw)?;
            let result = handler(context, request)?;
            serde_json::to_value(result)
                .map_err(|_| ContractError::new(ErrorCode::Internal, "the result could not be encoded"))
        });
        let previous = self.handlers.insert(
            O::NAME,
            Registered {
                capability: O::CAPABILITY,
                handler: erased,
            },
        );
        assert!(previous.is_none(), "operation `{}` registered twice", O::NAME);
        self
    }

    /// Every capability some registered operation requires.
    pub(crate) fn capabilities(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.handlers.values().map(|registered| registered.capability)
    }

    pub(crate) fn dispatch(&self, context: &CallContext, name: &str, raw: &[u8]) -> Result<Value, ContractError> {
        let registered = self.handlers.get(name).ok_or_else(|| {
            ContractError::new(ErrorCode::UnknownOperation, "no operation of that name is in the catalog")
        })?;
        if !context.grant.allows(registered.capability) {
            return Err(ContractError::new(
                ErrorCode::Denied,
                format!("this connection is not granted `{}`", registered.capability),
            ));
        }
        let _slot = self.acquire(context.principal)?;
        let value = (registered.handler)(context, raw)?;
        let encoded = serde_json::to_vec(&value)
            .map_err(|_| ContractError::new(ErrorCode::Internal, "the result could not be encoded"))?;
        if encoded.len() > self.limits.max_response_bytes {
            return Err(ContractError::new(
                ErrorCode::Internal,
                "the result exceeded the encoded response ceiling",
            ));
        }
        Ok(value)
    }

    fn acquire(&self, principal: Principal) -> Result<InFlightSlot<'_>, ContractError> {
        let mut counts = self.in_flight.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let count = counts.entry(principal).or_insert(0);
        if *count >= self.limits.max_in_flight_per_principal {
            return Err(ContractError::new(
                ErrorCode::Busy,
                "too many operations are in flight for this connection; retry shortly",
            ));
        }
        *count += 1;
        Ok(InFlightSlot {
            dispatcher: self,
            principal,
        })
    }

    #[cfg(test)]
    pub(crate) fn operation_names(&self) -> Vec<&'static str> {
        self.handlers.keys().copied().collect()
    }
}

/// Releases a principal's in-flight slot however the call ends.
struct InFlightSlot<'a> {
    dispatcher: &'a Dispatcher,
    principal: Principal,
}

impl Drop for InFlightSlot<'_> {
    fn drop(&mut self) {
        let mut counts = self
            .dispatcher
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(count) = counts.get_mut(&self.principal) {
            *count = count.saturating_sub(1);
        }
    }
}

// ---------------------------------------------------------------------------
// Test-only catalog entries: schemas and acceptance, for generation, drift and
// fixture verdicts. The `JsonSchema` bounds live here, not on `Operation`, so
// production contract types compile without schemars (brief §12, Q6).
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) use schema_entry::{check_complete, entry, OperationEntry};

#[cfg(test)]
mod schema_entry {
    use std::collections::BTreeSet;

    use schemars::{JsonSchema, Schema};
    use serde::de::DeserializeOwned;

    use super::super::artifacts::{inbound_schema, outbound_schema};
    use super::super::boundary::{accept, Validate};
    use super::super::error::{ContractError, ErrorCode};
    use super::{Dispatcher, Operation};

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
        /// Reading a result back, as a tolerant reader would.
        pub accept_result: fn(&[u8]) -> Result<(), ContractError>,
    }

    pub(crate) fn entry<O: Operation>() -> OperationEntry
    where
        O::Request: JsonSchema,
        O::Result: JsonSchema,
    {
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
            .map_err(|error| ContractError::new(ErrorCode::InvalidParams, super::super::boundary::parse_failure(&error)))
    }

    /// Every catalog entry has a handler and every handler has an entry.
    pub(crate) fn check_complete(dispatcher: &Dispatcher, catalog: &[OperationEntry]) -> Result<(), String> {
        let registered: BTreeSet<&str> = dispatcher.operation_names().into_iter().collect();
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::context::Grant;
    use crate::contracts::project_api::files_read::{FilesReadOp, FilesReadRequest, FilesReadResult};
    use crate::contracts::project_api::{catalog, samples, test_dispatcher};

    /// An operation that exists in code but not in the family's catalog.
    struct OrphanOp;

    impl Operation for OrphanOp {
        const NAME: &'static str = "litria_orphan";
        const DESCRIPTION: &'static str = "Registered, never listed.";
        const CAPABILITY: &'static str = "project.files.read";
        type Request = FilesReadRequest;
        type Result = FilesReadResult;
    }

    fn context(capabilities: &[&'static str]) -> CallContext {
        CallContext {
            principal: Principal::Test,
            grant: Grant::of(capabilities.iter().copied()),
            epoch: "ws-test".into(),
        }
    }

    const LIMITS: Limits = Limits {
        max_in_flight_per_principal: 4,
        max_response_bytes: 1024 * 1024,
    };

    #[test]
    fn the_test_dispatcher_covers_the_catalog_exactly() {
        check_complete(&test_dispatcher(), &catalog()).unwrap();
    }

    #[test]
    fn a_catalog_entry_without_a_handler_fails() {
        let dispatcher = Dispatcher::new(LIMITS);
        let error = check_complete(&dispatcher, &catalog()).unwrap_err();
        assert!(error.contains(FilesReadOp::NAME), "{error}");
    }

    #[test]
    fn a_handler_without_a_catalog_entry_fails() {
        let mut dispatcher = test_dispatcher();
        dispatcher.register::<OrphanOp>(|_, _| Ok(samples::files_read_result()));
        let error = check_complete(&dispatcher, &catalog()).unwrap_err();
        assert!(error.contains(OrphanOp::NAME), "{error}");
    }

    #[test]
    #[should_panic(expected = "registered twice")]
    fn registering_an_operation_twice_panics() {
        let mut dispatcher = test_dispatcher();
        dispatcher.register::<FilesReadOp>(|_, _| Ok(samples::files_read_result()));
    }

    #[test]
    fn an_unknown_operation_is_reported_as_such() {
        let error = test_dispatcher()
            .dispatch(&context(&[FilesReadOp::CAPABILITY]), "litria_nope", b"{}")
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::UnknownOperation);
    }

    #[test]
    fn a_missing_capability_is_denied_before_the_request_is_parsed() {
        // Not even valid JSON: the grant check comes first.
        let error = test_dispatcher()
            .dispatch(&context(&[]), FilesReadOp::NAME, b"not json")
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Denied);
    }

    #[test]
    fn dispatch_runs_the_full_boundary_before_the_handler() {
        let error = test_dispatcher()
            .dispatch(
                &context(&[FilesReadOp::CAPABILITY]),
                FilesReadOp::NAME,
                br#"{"documents":[{"path":"a"}],"extra":1}"#,
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidParams);
    }

    /// The caller's field names and values never come back in a message.
    #[test]
    fn parse_failures_do_not_echo_the_request() {
        let dispatcher = test_dispatcher();
        let context = context(&[FilesReadOp::CAPABILITY]);
        for raw in [
            br#"{"documents":[{"path":"a"}],"sneakyFieldName":1}"#.as_slice(),
            br#"{"documents":[{"path":"a"}],"source":"secretValueXyz"}"#.as_slice(),
            br#"{"documents":[{"path":"a","startLine":"notANumberQq"}]}"#.as_slice(),
            br#"{"documents": [ {"path": "a" "#.as_slice(),
        ] {
            let error = dispatcher.dispatch(&context, FilesReadOp::NAME, raw).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidParams);
            for echoed in ["sneakyFieldName", "secretValueXyz", "notANumberQq", "documents", "path"] {
                assert!(!error.message.contains(echoed), "message echoes `{echoed}`: {}", error.message);
            }
        }
    }

    /// A principal's fifth concurrent call gets `busy`; slots free on return.
    #[test]
    fn the_in_flight_ceiling_is_per_principal() {
        let dispatcher = test_dispatcher();
        let held: Vec<_> = (0..4).map(|_| dispatcher.acquire(Principal::Test).unwrap()).collect();
        let error = dispatcher.acquire(Principal::Test).err().expect("the fifth call is refused");
        assert_eq!(error.code, ErrorCode::Busy);
        // Another principal is unaffected.
        drop(dispatcher.acquire(Principal::Dev).unwrap());
        drop(held);
        drop(dispatcher.acquire(Principal::Test).expect("slots are released when calls end"));
    }

    #[test]
    fn an_oversized_result_is_withheld() {
        let mut dispatcher = Dispatcher::new(Limits {
            max_in_flight_per_principal: 4,
            max_response_bytes: 16,
        });
        dispatcher.register::<FilesReadOp>(|_, _| Ok(samples::files_read_result()));
        let error = dispatcher
            .dispatch(
                &context(&[FilesReadOp::CAPABILITY]),
                FilesReadOp::NAME,
                br#"{"documents":[{"path":"a"}]}"#,
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Internal);
    }
}
