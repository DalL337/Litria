//! Who is calling, with which grant, against which workspace (Project API
//! contract brief §4.2).
//!
//! A transport builds the context from its authenticated channel. Request
//! payloads never carry a principal, a grant, an epoch or a root.

use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Principal {
    /// Rust tests.
    #[cfg_attr(not(test), allow(dead_code))] // constructed only by tests
    Test,
    /// Debug builds only: `project_api_dev_call`, for driving the live app
    /// over CDP. Real agent principals arrive with the transport (track T).
    #[cfg_attr(not(debug_assertions), allow(dead_code))] // the dev call is debug-only
    Dev,
}

/// The capabilities a principal holds, named as in the operation catalog
/// (for example `project.files.read`).
#[derive(Debug, Clone, Default)]
pub(crate) struct Grant {
    capabilities: BTreeSet<&'static str>,
}

impl Grant {
    pub(crate) fn of(capabilities: impl IntoIterator<Item = &'static str>) -> Self {
        Self {
            capabilities: capabilities.into_iter().collect(),
        }
    }

    pub(crate) fn allows(&self, capability: &str) -> bool {
        self.capabilities.contains(capability)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CallContext {
    pub principal: Principal,
    pub grant: Grant,
    /// The workspace epoch the channel was attached to (ADR-032). Every
    /// operation is fenced against it (contract brief §4.3).
    pub epoch: String,
}
