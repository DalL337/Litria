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
//!    newline and answered with an error, unparsed.
//! 3. **The session must keep holding.** Before every message, and every
//!    [`TICK`] while idle, the connection checks that its session has not
//!    ended and that its project is still the one open. When either changes,
//!    the connection closes without answering. Ending the session also
//!    cancels its connections at once.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::endpoint::{Read, Stream, WRITE_DEADLINE};
use super::protocol::{Conversation, INVALID_REQUEST};
use super::sessions::{Registry, Session};

pub(crate) const HELLO_DEADLINE: Duration = Duration::from_secs(5);
pub(crate) const MAX_HELLO_BYTES: usize = 1024;
/// The largest MCP message accepted, newline excluded.
pub(crate) const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
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

/// Serve one accepted connection until it closes. Runs on the connection's
/// own thread.
pub(crate) fn serve(stream: Arc<Stream>, registry: &Registry, timing: Timing) {
    let mut lines = Lines::new(&stream);
    let token = match lines.next(timing.hello, MAX_HELLO_BYTES) {
        Next::Line(line) => hello_token(&line),
        // Silence, an oversized hello, or a close: nothing to answer.
        _ => return,
    };
    let session = token.as_deref().map(|token| registry.authenticate(token));
    let (session, _attached) = match session {
        Some(Ok(session)) => match registry.attach(&session, &stream) {
            Ok(attached) => (session, attached),
            Err(_) => return refuse(&stream, lines),
        },
        _ => return refuse(&stream, lines),
    };
    if stream.write_all(&status_line(READY), WRITE_DEADLINE).is_err() {
        return;
    }
    converse(&stream, lines, registry, &session, timing.tick);
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

fn converse(stream: &Stream, mut lines: Lines<'_>, registry: &Registry, session: &Session, tick: Duration) {
    let mut conversation = Conversation::new(session.grant.clone());
    loop {
        let next = lines.next(tick, MAX_MESSAGE_BYTES);
        if next == Next::Closed || !registry.still_holds(session) {
            return;
        }
        let answer = match next {
            Next::Line(message) => conversation.handle(&message),
            Next::TooLong => Some(json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": { "code": INVALID_REQUEST, "message": "the message is larger than Litria accepts" },
            })),
            Next::Idle | Next::Closed => None,
        };
        if let Some(answer) = answer {
            let mut line = answer.to_string().into_bytes();
            line.push(b'\n');
            if stream.write_all(&line, WRITE_DEADLINE).is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests;
