//! Agent sessions and their tokens (track T, slice T1a).
//!
//! An agent session is one agent Litria started for the project open now.
//! Litria mints its token when the session starts, and the agent's MCP helper
//! presents it on connecting. A token:
//! - is 32 bytes from the OS random source, written as 64 hex digits;
//! - is never stored: the registry keeps its SHA-256, so the token exists only
//!   in the agent's environment and in the hand-off that started it;
//! - is bound to one project open: the session's workspace epoch. Epochs are
//!   a per-process counter that never repeats within a run (adversarial-check
//!   Learned Flaw 12), and nothing here is persisted, so a token from an
//!   earlier run of Litria is simply unknown;
//! - stops working for good when the session ends, when the project it was
//!   bound to closes or another opens, or when Litria exits.
//!
//! Every refusal reads the same ([`Refused`]): an unknown, malformed, ended or
//! stale token cannot be told apart from outside.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};

use crate::contracts::context::Grant;

use super::endpoint::Stream;

/// Sessions alive at once (the terminal registry's total cap: an agent
/// session runs in a terminal session from T2b).
pub(crate) const MAX_SESSIONS: usize = 24;

/// Live connections per session. An agent normally keeps one; a reconnect can
/// overlap the old one briefly.
pub(crate) const MAX_CONNECTIONS_PER_SESSION: usize = 4;

const TOKEN_BYTES: usize = 32;

/// The one answer every failed authentication gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Refused;

/// What [`Registry::start`] hands back once. The token is never seen again.
#[derive(Debug)]
pub(crate) struct Started {
    pub session_id: String,
    pub token: String,
}

/// The parts of a session a connection works with.
#[derive(Debug)]
pub(crate) struct Session {
    pub id: String,
    pub epoch: String,
    pub grant: Grant,
}

type TokenHash = [u8; 32];

struct Entry {
    session: Arc<Session>,
    hash: TokenHash,
    connections: HashMap<u64, Arc<Stream>>,
}

#[derive(Default)]
struct Inner {
    by_hash: HashMap<TokenHash, String>,
    sessions: HashMap<String, Entry>,
    next_connection: u64,
}

/// Where the registry learns which project open is current.
pub(crate) type EpochSource = Box<dyn Fn() -> Option<String> + Send + Sync>;

pub(crate) struct Registry {
    inner: Mutex<Inner>,
    current_epoch: EpochSource,
}

/// One connection's place in its session. Dropping it releases the place.
pub(crate) struct Attached<'a> {
    registry: &'a Registry,
    session_id: String,
    connection: u64,
}

impl Drop for Attached<'_> {
    fn drop(&mut self) {
        let mut inner = self.registry.lock();
        if let Some(entry) = inner.sessions.get_mut(&self.session_id) {
            entry.connections.remove(&self.connection);
        }
    }
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    use rand::TryRngCore;
    let mut bytes = [0u8; N];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|error| format!("the system random source failed: {error}"))?;
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hash_of(token: &str) -> TokenHash {
    Sha256::digest(token.as_bytes()).into()
}

/// The shape every token has; anything else is refused before hashing.
fn well_formed(token: &str) -> bool {
    token.len() == TOKEN_BYTES * 2 && token.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

impl Registry {
    pub(crate) fn new(current_epoch: EpochSource) -> Self {
        Self { inner: Mutex::new(Inner::default()), current_epoch }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Start a session for the project open as `epoch`, with `grant`. Refused
    /// unless `epoch` is the project open now, and beyond [`MAX_SESSIONS`].
    pub(crate) fn start(&self, epoch: &str, grant: Grant) -> Result<Started, String> {
        let current = (self.current_epoch)();
        if current.as_deref() != Some(epoch) {
            return Err("that project is no longer open".into());
        }
        let token = hex(&random_bytes::<TOKEN_BYTES>()?);
        let session_id = format!("agent-{}", hex(&random_bytes::<16>()?));
        let hash = hash_of(&token);
        let mut inner = self.lock();
        Self::sweep(&mut inner, current.as_deref());
        if inner.sessions.len() >= MAX_SESSIONS {
            return Err(format!("{MAX_SESSIONS} agent sessions are already running"));
        }
        let session = Arc::new(Session { id: session_id.clone(), epoch: epoch.to_owned(), grant });
        inner.by_hash.insert(hash, session_id.clone());
        inner
            .sessions
            .insert(session_id.clone(), Entry { session, hash, connections: HashMap::new() });
        Ok(Started { session_id, token })
    }

    /// The live session `token` belongs to, if it still holds.
    pub(crate) fn authenticate(&self, token: &str) -> Result<Arc<Session>, Refused> {
        if !well_formed(token) {
            return Err(Refused);
        }
        let hash = hash_of(token);
        let current = (self.current_epoch)();
        let mut inner = self.lock();
        let id = inner.by_hash.get(&hash).cloned().ok_or(Refused)?;
        if !Self::holds(&inner, &id, current.as_deref()) {
            Self::remove(&mut inner, &id);
            return Err(Refused);
        }
        Ok(Arc::clone(&inner.sessions[&id].session))
    }

    /// Whether `session` still holds: not ended, and its project still open.
    /// A session that no longer holds is ended here, for good.
    pub(crate) fn still_holds(&self, session: &Session) -> bool {
        let current = (self.current_epoch)();
        let mut inner = self.lock();
        if Self::holds(&inner, &session.id, current.as_deref()) {
            return true;
        }
        Self::remove(&mut inner, &session.id);
        false
    }

    /// The epoch source is read before the registry is locked (it takes the
    /// database lock), so no lock is ever held inside another here.
    fn holds(inner: &Inner, id: &str, current: Option<&str>) -> bool {
        match inner.sessions.get(id) {
            None => false,
            Some(entry) => current == Some(entry.session.epoch.as_str()),
        }
    }

    /// Give `stream` a place in `session`, or refuse it beyond
    /// [`MAX_CONNECTIONS_PER_SESSION`] or once the session no longer holds.
    pub(crate) fn attach(&self, session: &Session, stream: &Arc<Stream>) -> Result<Attached<'_>, Refused> {
        let current = (self.current_epoch)();
        let mut inner = self.lock();
        if !Self::holds(&inner, &session.id, current.as_deref()) {
            Self::remove(&mut inner, &session.id);
            return Err(Refused);
        }
        let connection = inner.next_connection;
        inner.next_connection += 1;
        let entry = inner.sessions.get_mut(&session.id).ok_or(Refused)?;
        if entry.connections.len() >= MAX_CONNECTIONS_PER_SESSION {
            return Err(Refused);
        }
        entry.connections.insert(connection, Arc::clone(stream));
        Ok(Attached { registry: self, session_id: session.id.clone(), connection })
    }

    /// End a session: its token stops working and its connections close now.
    pub(crate) fn end(&self, session_id: &str) -> bool {
        let mut inner = self.lock();
        Self::remove(&mut inner, session_id)
    }

    /// End every session (Litria is closing).
    pub(crate) fn end_all(&self) {
        let mut inner = self.lock();
        let ids: Vec<String> = inner.sessions.keys().cloned().collect();
        for id in ids {
            Self::remove(&mut inner, &id);
        }
    }

    /// End the sessions whose project is no longer open.
    fn sweep(inner: &mut Inner, current: Option<&str>) {
        let stale: Vec<String> =
            inner.sessions.keys().filter(|id| !Self::holds(inner, id, current)).cloned().collect();
        for id in stale {
            Self::remove(inner, &id);
        }
    }

    fn remove(inner: &mut Inner, session_id: &str) -> bool {
        let Some(entry) = inner.sessions.remove(session_id) else {
            return false;
        };
        inner.by_hash.remove(&entry.hash);
        // Cancelling only sets an event (or shuts a socket down): no I/O
        // waits under the lock.
        for stream in entry.connections.values() {
            stream.cancel();
        }
        true
    }

    #[cfg(test)]
    pub(crate) fn session_count(&self) -> usize {
        self.lock().sessions.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A registry whose current epoch the test sets: `ws-<n>`, or none.
    fn registry() -> (Registry, Arc<AtomicUsize>) {
        let open = Arc::new(AtomicUsize::new(1));
        let source = Arc::clone(&open);
        let registry = Registry::new(Box::new(move || match source.load(Ordering::SeqCst) {
            0 => None,
            n => Some(format!("ws-{n}")),
        }));
        (registry, open)
    }

    #[test]
    fn a_started_session_authenticates_with_its_token() {
        let (registry, _open) = registry();
        let started = registry.start("ws-1", Grant::of(["project.files.read"])).unwrap();
        assert!(started.session_id.starts_with("agent-"));
        assert!(well_formed(&started.token), "{}", started.token);
        let session = registry.authenticate(&started.token).unwrap();
        assert_eq!(session.id, started.session_id);
        assert_eq!(session.epoch, "ws-1");
        assert!(session.grant.allows("project.files.read"));
    }

    #[test]
    fn tokens_and_ids_are_new_every_time() {
        let (registry, _open) = registry();
        let a = registry.start("ws-1", Grant::default()).unwrap();
        let b = registry.start("ws-1", Grant::default()).unwrap();
        assert_ne!(a.token, b.token);
        assert_ne!(a.session_id, b.session_id);
    }

    #[test]
    fn only_the_project_open_now_can_start_a_session() {
        let (registry, open) = registry();
        assert!(registry.start("ws-2", Grant::default()).is_err());
        open.store(0, Ordering::SeqCst);
        assert!(registry.start("ws-1", Grant::default()).is_err(), "nothing open");
    }

    /// Missing, malformed, wrong, ended, other-project and earlier-run tokens
    /// all get the same refusal.
    #[test]
    fn every_bad_token_is_refused_alike() {
        let (registry, open) = registry();
        let live = registry.start("ws-1", Grant::default()).unwrap();
        let ended = registry.start("ws-1", Grant::default()).unwrap();
        assert!(registry.end(&ended.session_id));

        let mut wrong = live.token.clone();
        let last = if wrong.ends_with('0') { "1" } else { "0" };
        wrong.replace_range(63..64, last);
        let upper = live.token.to_uppercase();
        let padded = format!(" {}", live.token);
        let long = format!("{}0", live.token);
        // A well-formed token this run never minted: what an earlier run's
        // token looks like to this one.
        let earlier_run = "ab".repeat(32);
        for bad in ["", "not-a-token", &wrong, &upper, &padded, &long, &earlier_run, &ended.token] {
            assert_eq!(registry.authenticate(bad).unwrap_err(), Refused, "{bad:?}");
        }
        // The project the token was bound to closes: refused, and for good.
        open.store(2, Ordering::SeqCst);
        assert_eq!(registry.authenticate(&live.token).unwrap_err(), Refused);
        open.store(1, Ordering::SeqCst);
        assert_eq!(registry.authenticate(&live.token).unwrap_err(), Refused, "a stale session never comes back");
        assert_eq!(registry.session_count(), 0);
    }

    #[test]
    fn a_session_stops_holding_when_its_project_closes() {
        let (registry, open) = registry();
        let started = registry.start("ws-1", Grant::default()).unwrap();
        let session = registry.authenticate(&started.token).unwrap();
        assert!(registry.still_holds(&session));
        open.store(0, Ordering::SeqCst);
        assert!(!registry.still_holds(&session));
        open.store(1, Ordering::SeqCst);
        assert!(!registry.still_holds(&session), "ended for good");
    }

    #[test]
    fn sessions_are_capped_and_stale_ones_free_their_place() {
        let (registry, open) = registry();
        for _ in 0..MAX_SESSIONS {
            registry.start("ws-1", Grant::default()).unwrap();
        }
        assert!(registry.start("ws-1", Grant::default()).is_err(), "one over the cap");
        open.store(2, Ordering::SeqCst);
        assert!(registry.start("ws-2", Grant::default()).is_ok(), "the old project's sessions ended");
        assert_eq!(registry.session_count(), 1);
    }

    #[test]
    fn end_all_ends_every_session() {
        let (registry, _open) = registry();
        let a = registry.start("ws-1", Grant::default()).unwrap();
        let b = registry.start("ws-1", Grant::default()).unwrap();
        registry.end_all();
        assert!(registry.authenticate(&a.token).is_err());
        assert!(registry.authenticate(&b.token).is_err());
    }
}
