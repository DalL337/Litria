//! Litria's MCP connection (track T, slice T1a): how an agent Litria started
//! reaches the Project API.
//!
//! ```text
//! agent ──stdio──▶ litria --mcp-helper ──pipe/socket──▶ this app ──▶ Project API
//! ```
//!
//! - The agent starts the helper as a stdio MCP server (`helper.rs`). The
//!   helper is this app's own binary with a flag: nothing extra ships.
//! - The helper connects to the app's local endpoint (`endpoint/`), which only
//!   the current user can reach, and presents its session's token.
//! - The app checks the token against the agent sessions it started
//!   (`sessions.rs`) and serves MCP on that connection (`server.rs`,
//!   `protocol.rs`), bound to the session's project open.
//!
//! The listener exists only once a session has started, and stops with the
//! app. Design and evidence: `docs/plans/agent-integration/track-t-build-plan.md`
//! (T1a); agent integration brief §3 and §9.

pub(crate) mod endpoint;
pub(crate) mod helper;
mod protocol;
mod server;
mod sessions;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::contracts::context::Grant;

use endpoint::Listener;
use server::{Calls, Host, Timing};
use sessions::{EpochSource, Registry};

/// Connections alive at once, counting those still saying hello.
pub(crate) const MAX_CONNECTIONS: usize = 16;

/// Environment variables the helper reads (set by whoever starts the agent).
pub(crate) const ENDPOINT_VAR: &str = "LITRIA_MCP_ENDPOINT";
pub(crate) const TOKEN_VAR: &str = "LITRIA_MCP_TOKEN";

/// What an agent needs to connect: handed to whoever starts it, once.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentConnection {
    pub session_id: String,
    pub endpoint: String,
    pub token: String,
}

/// The listener and the sessions it serves.
pub(crate) struct Service {
    listener: Listener,
    registry: Registry,
    live: AtomicUsize,
    timing: Timing,
    calls: Calls,
    shut: AtomicBool,
    accepting: Mutex<Option<std::thread::JoinHandle<()>>>,
}

/// How long [`Service::shutdown`] waits for the accept thread to let go of
/// the endpoint.
const ACCEPT_STOP_BUDGET: Duration = Duration::from_secs(2);

/// How long [`Service::shutdown`] lets calls already running finish and
/// answer before it ends the sessions. Calls are bounded (the owner bridge
/// answers within seconds), and an apply cut off by the exit would leave its
/// changes partly made until the next open settles it.
const DRAIN_BUDGET: Duration = Duration::from_secs(2);

/// One accepted connection's place under [`MAX_CONNECTIONS`].
struct Slot(Arc<Service>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.live.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Service {
    /// Bind a fresh endpoint and start accepting on it.
    pub(crate) fn start(current_epoch: EpochSource, timing: Timing) -> std::io::Result<Arc<Self>> {
        let service = Arc::new(Self {
            listener: Listener::bind_new()?,
            registry: Registry::new(current_epoch),
            live: AtomicUsize::new(0),
            timing,
            calls: Calls::default(),
            shut: AtomicBool::new(false),
            accepting: Mutex::new(None),
        });
        let accepting = Arc::clone(&service);
        let thread = std::thread::Builder::new()
            .name("mcp-accept".into())
            .spawn(move || accepting.accept_loop())?;
        *service.accepting.lock().unwrap_or_else(|p| p.into_inner()) = Some(thread);
        Ok(service)
    }

    fn accept_loop(self: Arc<Self>) {
        loop {
            let stream = match self.listener.accept() {
                // A client that raced the shutdown is let go, not served.
                Ok(_) if self.closed() => return,
                Ok(stream) => Arc::new(stream),
                Err(_) if self.closed() => return,
                Err(error) => {
                    eprintln!("[mcp] accepting a connection failed: {error}");
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
            };
            if self.live.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                self.live.fetch_sub(1, Ordering::SeqCst);
                continue; // dropped: the helper sees the pipe close
            }
            let slot = Slot(Arc::clone(&self));
            let serving = Arc::clone(&self);
            let spawned = std::thread::Builder::new().name("mcp-connection".into()).spawn(move || {
                let _slot = slot;
                let host = Host {
                    registry: &serving.registry,
                    calls: &serving.calls,
                    dispatcher: crate::project_api::dispatcher(),
                };
                server::serve(stream, &host, serving.timing);
            });
            if let Err(error) = spawned {
                eprintln!("[mcp] starting a connection thread failed: {error}");
            }
        }
    }

    fn closed(&self) -> bool {
        CLOSED.load(Ordering::SeqCst) || self.shut.load(Ordering::SeqCst)
    }

    pub(crate) fn address(&self) -> &str {
        self.listener.address()
    }

    /// Start an agent session for the project open as `epoch`.
    pub(crate) fn start_session(&self, epoch: &str, grant: Grant) -> Result<AgentConnection, String> {
        if self.closed() {
            return Err("Litria is closing".into());
        }
        let started = self.registry.start(epoch, grant)?;
        Ok(AgentConnection {
            session_id: started.session_id,
            endpoint: self.address().to_owned(),
            token: started.token,
        })
    }

    pub(crate) fn end_session(&self, session_id: &str) -> bool {
        self.registry.end(session_id)
    }

    pub(crate) fn end_all_sessions(&self) {
        self.registry.end_all();
    }

    /// End every session and stop accepting. New calls are answered
    /// `shuttingDown` at once; calls already running get [`DRAIN_BUDGET`] to
    /// finish and answer first. Returns once the accept thread has let go of
    /// the endpoint (within [`ACCEPT_STOP_BUDGET`]): until then the instance
    /// it waits on would still take a new client.
    pub(crate) fn shutdown(&self) {
        self.shut.store(true, Ordering::SeqCst);
        if !self.calls.close(DRAIN_BUDGET) {
            eprintln!("[mcp] calls were still running after {DRAIN_BUDGET:?}; closing anyway");
        }
        self.registry.end_all();
        self.listener.shutdown();
        let thread = self.accepting.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(thread) = thread {
            let deadline = std::time::Instant::now() + ACCEPT_STOP_BUDGET;
            while !thread.is_finished() && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            if thread.is_finished() {
                let _ = thread.join();
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn live_connections(&self) -> usize {
        self.live.load(Ordering::SeqCst)
    }
}

// --- The app's one service ---------------------------------------------------

static SERVICE: Mutex<Option<Arc<Service>>> = Mutex::new(None);
/// Set at exit: no service starts after it.
static CLOSED: AtomicBool = AtomicBool::new(false);

fn app_epoch() -> Option<String> {
    crate::db::workspace_binding().map(|(epoch, _)| epoch)
}

fn service() -> Result<Arc<Service>, String> {
    let mut slot = SERVICE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if CLOSED.load(Ordering::SeqCst) {
        return Err("Litria is closing".into());
    }
    if let Some(service) = slot.as_ref() {
        return Ok(Arc::clone(service));
    }
    let service = Service::start(Box::new(app_epoch), server::TIMING)
        .map_err(|error| format!("the agent connection could not start: {error}"))?;
    *slot = Some(Arc::clone(&service));
    Ok(service)
}

fn running() -> Option<Arc<Service>> {
    SERVICE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

/// Start an agent session for the project open as `epoch`, with `grant`.
pub(crate) fn start_session(epoch: &str, grant: Grant) -> Result<AgentConnection, String> {
    service()?.start_session(epoch, grant)
}

/// End one agent session; its connections close at once.
pub(crate) fn end_session(session_id: &str) -> bool {
    running().is_some_and(|service| service.end_session(session_id))
}

/// The page reloaded: as with terminals, that is the project closing.
pub(crate) fn end_all_for_page_load() {
    if let Some(service) = running() {
        service.end_all_sessions();
    }
}

/// Litria is exiting: end every session and stop accepting. Runs once.
pub(crate) fn quit() {
    if CLOSED.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(service) = running() {
        service.shutdown();
    }
}

/// For the helper's process tests (`src-tauri/tests/mcp_helper.rs`): a real
/// service on a fresh endpoint, in the test's own process, with a project open
/// the test controls. Debug builds only, hidden, and not an API.
#[cfg(debug_assertions)]
#[doc(hidden)]
pub mod test_support {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use super::Service;

    pub struct App {
        service: Arc<Service>,
        open: Arc<AtomicBool>,
    }

    pub fn start() -> App {
        let open = Arc::new(AtomicBool::new(true));
        let source = Arc::clone(&open);
        let service = Service::start(
            Box::new(move || source.load(Ordering::SeqCst).then(|| "ws-test".to_owned())),
            super::server::TIMING,
        )
        .expect("the MCP service starts");
        App { service, open }
    }

    impl App {
        /// A new session with an agent's grant: (endpoint, token, session id).
        pub fn start_session(&self) -> (String, String, String) {
            let connection = self
                .service
                .start_session("ws-test", crate::project_api::agent_grant())
                .expect("a session starts");
            (connection.endpoint, connection.token, connection.session_id)
        }

        pub fn end_session(&self, session_id: &str) -> bool {
            self.service.end_session(session_id)
        }

        pub fn close_project(&self) {
            self.open.store(false, Ordering::SeqCst);
        }

        pub fn quit(&self) {
            self.service.shutdown();
        }
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod calls_tests;
