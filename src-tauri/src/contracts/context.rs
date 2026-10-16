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
    /// over CDP.
    #[cfg_attr(not(debug_assertions), allow(dead_code))] // the dev call is debug-only
    Dev,
    /// One agent session Litria started (track T, T1b): every call over its
    /// MCP connections, and the plans and receipts those calls make.
    Agent(AgentId),
}

impl Principal {
    /// How receipts record the principal (`api_operations.principal`).
    pub(crate) fn key(self) -> String {
        match self {
            Principal::Test => "test".to_owned(),
            Principal::Dev => "dev".to_owned(),
            Principal::Agent(agent) => agent.key(),
        }
    }

    /// The principal a receipt names, if it is one this build knows.
    pub(crate) fn from_key(key: &str) -> Option<Principal> {
        match key {
            "test" => Some(Principal::Test),
            "dev" => Some(Principal::Dev),
            _ => AgentId::parse(key).map(Principal::Agent),
        }
    }
}

/// An agent session's identity: 16 random bytes, minted with the session and
/// never reused, so a session of a later run of Litria is a different one
/// (track T plan D6). Its key, `agent-<32 hex>`, is the session's id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct AgentId([u8; 16]);

impl AgentId {
    const PREFIX: &'static str = "agent-";

    pub(crate) fn new(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    pub(crate) fn key(self) -> String {
        let hex: String = self.0.iter().map(|byte| format!("{byte:02x}")).collect();
        format!("{}{hex}", Self::PREFIX)
    }

    pub(crate) fn parse(key: &str) -> Option<AgentId> {
        let hex = key.strip_prefix(Self::PREFIX)?;
        if hex.len() != 32 || !hex.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) {
            return None;
        }
        let mut bytes = [0u8; 16];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()?;
        }
        Some(AgentId(bytes))
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_principal_survives_its_key() {
        let agent = Principal::Agent(AgentId::new([0xab; 16]));
        for principal in [Principal::Test, Principal::Dev, agent] {
            assert_eq!(Principal::from_key(&principal.key()), Some(principal));
        }
        assert_eq!(agent.key(), format!("agent-{}", "ab".repeat(16)));
    }

    #[test]
    fn a_key_this_build_does_not_know_is_no_principal() {
        let good = "ab".repeat(16);
        for key in [
            String::new(),
            "Test".into(),
            "agent-".into(),
            format!("agent-{}", &good[..30]),
            format!("agent-{good}00"),
            format!("agent-{}", good.to_uppercase()),
            format!("Agent-{good}"),
            format!("agent-{}zz", &good[..30]),
        ] {
            assert_eq!(Principal::from_key(&key), None, "{key}");
        }
    }
}
