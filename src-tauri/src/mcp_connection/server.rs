//! One connection, from the helper's hello to its close (track T, T1a).
//!
//! 1. **Hello.** Before any MCP, the helper sends one line,
//!    `{"litria":"hello","v":1,"token":"<64 hex>"}`, within
//!    [`HELLO_DEADLINE`] and [`MAX_HELLO_BYTES`]. A valid token gets
//!    `{"litria":"ready","v":1}`; anything else gets `{"litria":"refused","v":1}`
//!    and the connection closes. No Project API or MCP code runs before the
//!    token is accepted.
//! 2. **MCP.** Newline-delimited JSON-RPC, one message per line. A line is
//!    capped at [`MAX_MESSAGE_BYTES`] while it is still being read, so an
//!    endless line costs at most that much memory; it is discarded up to its
//!    newline and answered with an error, unparsed. The cap is a call's own
//!    budget plus its envelope (T1b), so nothing bigger than a call may carry
//!    is ever parsed.
//! 3. **The session must keep holding.** Before every message, and every
//!    [`TICK`] while idle, the connection checks that its session has not
//!    ended and that its project is still the one open. When either changes,
//!    the connection closes without answering. Ending the session also
//!    cancels its connections at once.
//! 4. **Tool calls run beside the reading** (T1b), up to
//!    [`MAX_CALLS_PER_CONNECTION`] at once, as the session's own principal.
//!    Pings, cancellations and the session check go on while they run. A
//!    connection lets go of its place only once its calls have finished.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::endpoint::{Read, Stream, WRITE_DEADLINE};
use super::protocol::{Conversation, Reply, INVALID_REQUEST};
use super::sessions::{Registry, Session};
use crate::contracts::boundary::MAX_REQUEST_BYTES;
use crate::contracts::catalog::Dispatcher;
use crate::contracts::error::{ContractError, ErrorCode};

pub(crate) const HELLO_DEADLINE: Duration = Duration::from_secs(5);
pub(crate) const MAX_HELLO_BYTES: usize = 1024;
/// Room for the JSON-RPC envelope around a call's arguments: the method, the
/// id, the tool's name, `_meta`.
pub(crate) const ENVELOPE_BYTES: usize = 8 * 1024;
/// The largest MCP message accepted, newline excluded: a call's own budget
/// (its encoded arguments) plus the envelope around them.
pub(crate) const MAX_MESSAGE_BYTES: usize = MAX_REQUEST_BYTES + ENVELOPE_BYTES;
/// Calls one connection runs at once: the dispatcher's ceiling for one
/// principal, which every connection of a session shares.
pub(crate) const MAX_CALLS_PER_CONNECTION: usize = crate::project_api::LIMITS.max_in_flight_per_principal;
/// How often an idle connection re-checks its session.
pub(crate) const TICK: Duration = Duration::from_secs(1);
/// How long a refused connection waits for the helper to read the refusal
/// and close, before closing itself.
const REFUSAL_LINGER: Duration = Duration::from_secs(2);

pub(crate) const HELLO: &str = "hello";
pub(crate) const READY: &str = "ready";
pub(crate) const REFUSED: &str = "refused";
pub(crate) const HELLO_VERSION: u64 = 1;

pub(crate) fn status_line(status: &str) -> Vec<u8> {
    let mut line = json!({ "litria": status, "v": HELLO_VERSION }).to_string().into_bytes();
    line.push(b'\n');
    line
}

/// What [`Lines::next`] produced.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Next {
    Line(Vec<u8>),
    /// A line longer than the cap, already discarded through its newline.
    TooLong,
    /// The read waited `wait` with nothing to finish.
    Idle,
    Closed,
}

/// Newline framing over a [`Stream`], bounded by the caller's cap.
pub(crate) struct Lines<'a> {
    stream: &'a Stream,
    pending: Vec<u8>,
    discarding: bool,
}

impl<'a> Lines<'a> {
    pub(crate) fn new(stream: &'a Stream) -> Self {
        Self { stream, pending: Vec::new(), discarding: false }
    }

    /// The next line (without its newline or a trailing `\r`), waiting at
    /// most `wait` overall.
    pub(crate) fn next(&mut self, wait: Duration, cap: usize) -> Next {
        let deadline = Instant::now() + wait;
        let mut chunk = [0u8; 8 * 1024];
        loop {
            if let Some(found) = self.take_line(cap) {
                return found;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Next::Idle;
            }
            match self.stream.read(&mut chunk, Some(left)) {
                Ok(Read::Data(read)) => self.pending.extend_from_slice(&chunk[..read]),
                Ok(Read::TimedOut) => return Next::Idle,
                Ok(Read::Eof | Read::Cancelled) | Err(_) => return Next::Closed,
            }
        }
    }

    /// A complete line from what has arrived, enforcing the cap on the line
    /// in progress.
    fn take_line(&mut self, cap: usize) -> Option<Next> {
        loop {
            match self.pending.iter().position(|&byte| byte == b'\n') {
                Some(end) => {
                    let mut line: Vec<u8> = self.pending.drain(..=end).collect();
                    line.pop();
                    if self.discarding || line.len() > cap + 1 {
                        self.discarding = false;
                        return Some(Next::TooLong);
                    }
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    if line.len() > cap {
                        return Some(Next::TooLong);
                    }
                    if line.iter().all(u8::is_ascii_whitespace) {
                        continue;
                    }
                    return Some(Next::Line(line));
                }
                None if self.pending.len() > cap + 1 => {
                    // Over the cap with no end in sight: keep nothing of it.
                    self.pending.clear();
                    self.discarding = true;
                    return None;
                }
                None => return None,
            }
        }
    }

    /// Bytes read past the last line returned, for the helper's hand-off.
    pub(crate) fn into_pending(self) -> Vec<u8> {
        self.pending
    }
}

/// The token in a hello line, if the line is one.
pub(crate) fn hello_token(line: &[u8]) -> Option<String> {
    let hello: Value = serde_json::from_slice(line).ok()?;
    let object = hello.as_object()?;
    if object.get("litria")?.as_str()? != HELLO || object.get("v")?.as_u64()? != HELLO_VERSION {
        return None;
    }
    Some(object.get("token")?.as_str()?.to_owned())
}

/// The waits a connection uses; tests shorten them.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Timing {
    pub hello: Duration,
    pub tick: Duration,
}

pub(crate) const TIMING: Timing = Timing { hello: HELLO_DEADLINE, tick: TICK };

/// What a connection works with: the sessions it may serve, the service's
/// running calls, and the operations calls reach.
pub(crate) struct Host<'a> {
    pub registry: &'a Registry,
    pub calls: &'a Calls,
    pub dispatcher: &'a Dispatcher,
}

/// The service's running calls, and whether it still takes new ones.
#[derive(Default)]
pub(crate) struct Calls {
    state: Mutex<CallsState>,
    finished: Condvar,
}

#[derive(Default)]
struct CallsState {
    running: usize,
    closing: bool,
}

/// One running call's place under [`Calls`]; dropping it ends the call.
pub(crate) struct Running<'a>(&'a Calls);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        let mut state = lock(&self.0.state);
        state.running -= 1;
        if state.running == 0 {
            self.0.finished.notify_all();
        }
    }
}

impl Calls {
    /// A place for a new call, or `None` once Litria is closing.
    pub(crate) fn begin(&self) -> Option<Running<'_>> {
        let mut state = lock(&self.state);
        if state.closing {
            return None;
        }
        state.running += 1;
        Some(Running(self))
    }

    /// Take no new call, then wait up to `budget` for the running ones to
    /// finish and answer, so that quitting never cuts an apply off halfway.
    /// Returns whether they all finished.
    pub(crate) fn close(&self, budget: Duration) -> bool {
        let deadline = Instant::now() + budget;
        let mut state = lock(&self.state);
        state.closing = true;
        while state.running > 0 {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            state = self.finished.wait_timeout(state, left).unwrap_or_else(|p| p.into_inner()).0;
        }
        true
    }

    #[cfg(test)]
    pub(crate) fn running(&self) -> usize {
        lock(&self.state).running
    }

    #[cfg(test)]
    pub(crate) fn is_closing(&self) -> bool {
        lock(&self.state).closing
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Serve one accepted connection until it closes. Runs on the connection's
/// own thread.
pub(crate) fn serve(stream: Arc<Stream>, host: &Host<'_>, timing: Timing) {
    let mut lines = Lines::new(&stream);
    let token = match lines.next(timing.hello, MAX_HELLO_BYTES) {
        Next::Line(line) => hello_token(&line),
        // Silence, an oversized hello, or a close: nothing to answer.
        _ => return,
    };
    let session = token.as_deref().map(|token| host.registry.authenticate(token));
    let (session, _attached) = match session {
        Some(Ok(session)) => match host.registry.attach(&session, &stream) {
            Ok(attached) => (session, attached),
            Err(_) => return refuse(&stream, lines),
        },
        _ => return refuse(&stream, lines),
    };
    if stream.write_all(&status_line(READY), WRITE_DEADLINE).is_err() {
        return;
    }
    converse(&stream, lines, host, &session, timing.tick);
}

fn refuse(stream: &Stream, mut lines: Lines<'_>) {
    if stream.write_all(&status_line(REFUSED), WRITE_DEADLINE).is_ok() {
        // Let the helper read the refusal before the pipe goes away.
        let until = Instant::now() + REFUSAL_LINGER;
        while Instant::now() < until {
            if lines.next(until.saturating_duration_since(Instant::now()), MAX_HELLO_BYTES) == Next::Closed {
                break;
            }
        }
    }
}

fn converse(stream: &Stream, mut lines: Lines<'_>, host: &Host<'_>, session: &Session, tick: Duration) {
    let mut conversation = Conversation::new(session.grant.clone());
    let context = session.call_context();
    // One answer is written at a time, so lines never interleave.
    let writer = Mutex::new(());
    // The calls this connection is running, by id, and whether the client has
    // cancelled each.
    let running: Mutex<HashMap<String, bool>> = Mutex::new(HashMap::new());
    // Leaving the scope waits for every call still running.
    std::thread::scope(|scope| loop {
        let next = lines.next(tick, MAX_MESSAGE_BYTES);
        if next == Next::Closed || !host.registry.still_holds(session) {
            return;
        }
        let reply = match next {
            Next::Line(message) => conversation.handle(&message),
            Next::TooLong => Reply::Now(json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": { "code": INVALID_REQUEST, "message": "the message is larger than Litria accepts" },
            })),
            Next::Idle | Next::Closed => Reply::Nothing,
        };
        let answer = match reply {
            Reply::Nothing => None,
            Reply::Now(answer) => Some(answer),
            // A call that has already answered, or never ran, is ignored.
            Reply::Cancel(key) => {
                if let Some(cancelled) = lock(&running).get_mut(&key) {
                    *cancelled = true;
                }
                None
            }
            Reply::Call(call) => {
                let key = call.key();
                let refusal = {
                    let calls = lock(&running);
                    if calls.contains_key(&key) {
                        Some(call.duplicate_id())
                    } else if calls.len() >= MAX_CALLS_PER_CONNECTION {
                        Some(call.refused(&ContractError::new(
                            ErrorCode::Busy,
                            "too many operations are in flight for this connection; retry shortly",
                        )))
                    } else {
                        None
                    }
                };
                if refusal.is_some() {
                    refusal
                } else if let Some(place) = host.calls.begin() {
                    let unstarted = call.refused(&ContractError::new(ErrorCode::Internal, "the call could not start"));
                    lock(&running).insert(key.clone(), false);
                    let ran = key.clone();
                    let (writer, running, context) = (&writer, &running, &context);
                    let started = std::thread::Builder::new().name("mcp-call".into()).spawn_scoped(scope, move || {
                        let answer = call.run(host.dispatcher, context);
                        let cancelled = lock(running).remove(&ran).unwrap_or(false);
                        if !cancelled {
                            let _ = write_answer(stream, writer, &answer);
                        }
                        // Released only once the answer is out: a quit waiting
                        // on running calls waits for their answers too.
                        drop(place);
                    });
                    match started {
                        Ok(_) => None,
                        Err(_) => {
                            lock(&running).remove(&key);
                            Some(unstarted)
                        }
                    }
                } else {
                    Some(call.refused(&ContractError::new(ErrorCode::ShuttingDown, "Litria is closing")))
                }
            }
        };
        if let Some(answer) = answer {
            if !write_answer(stream, &writer, &answer) {
                return;
            }
        }
    });
}

fn write_answer(stream: &Stream, writer: &Mutex<()>, answer: &Value) -> bool {
    let mut line = answer.to_string().into_bytes();
    line.push(b'\n');
    let _turn = lock(writer);
    stream.write_all(&line, WRITE_DEADLINE).is_ok()
}

#[cfg(test)]
mod tests;
