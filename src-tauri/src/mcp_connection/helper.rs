//! The MCP helper: `litria --mcp-helper` (track T, slice T1a).
//!
//! An agent starts it as a stdio MCP server. It connects to the running app's
//! endpoint, presents its session's token, and then relays bytes both ways
//! until either side closes. It parses nothing after the hello: MCP is
//! between the agent and the app.
//!
//! - It reads `LITRIA_MCP_ENDPOINT` and `LITRIA_MCP_TOKEN` from its
//!   environment. Whoever starts the agent sets them (slice T2b), so the
//!   token never appears in a command line, a shell history or a file.
//! - It writes nothing to stdout but what the app sends: stdout is the MCP
//!   channel. Its own messages go to stderr, which agents log, and never
//!   include the token.
//! - It exits when the agent closes stdin, when the app closes the
//!   connection, or when the app refuses it. No helper outlives either side.
//! - It is the app's own binary, branched in `main` before anything else
//!   starts: no window, no crash marker, no database. On Windows, release
//!   builds use the GUI subsystem, so it never opens a console window.

use std::io::{self, Write};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::endpoint::{Read, Stream, WRITE_DEADLINE};
use super::server::{self, Lines, Next};
use super::{ENDPOINT_VAR, TOKEN_VAR};

/// The command-line flag that selects helper mode.
pub(crate) const FLAG: &str = "--mcp-helper";

pub(crate) const EXIT_STDIN_CLOSED: i32 = 0;
pub(crate) const EXIT_NO_SESSION: i32 = 2;
pub(crate) const EXIT_UNREACHABLE: i32 = 3;
pub(crate) const EXIT_REFUSED: i32 = 4;
pub(crate) const EXIT_LITRIA_CLOSED: i32 = 5;

/// A little longer than the app's own hello deadline, so the app's answer
/// (or its close) always arrives first.
const REPLY_DEADLINE: Duration = Duration::from_secs(8);

const PREFIX: &str = "litria --mcp-helper";

/// Run as the helper with the process's own stdio and environment.
pub(crate) fn run() -> i32 {
    let endpoint = std::env::var(ENDPOINT_VAR).ok();
    let token = std::env::var(TOKEN_VAR).ok();
    run_with(endpoint, token, io::stdin(), io::stdout(), &mut io::stderr())
}

/// The helper, over any input and output (tests use pipes).
pub(crate) fn run_with(
    endpoint: Option<String>,
    token: Option<String>,
    input: impl io::Read + Send + 'static,
    mut output: impl Write,
    errors: &mut impl Write,
) -> i32 {
    let (Some(endpoint), Some(token)) = (endpoint.filter(|e| !e.is_empty()), token.filter(|t| !t.is_empty()))
    else {
        let _ = writeln!(
            errors,
            "{PREFIX}: no Litria session. Litria sets {ENDPOINT_VAR} and {TOKEN_VAR} when it starts an agent; \
             this helper is not meant to be run by hand."
        );
        return EXIT_NO_SESSION;
    };
    let stream = match Stream::connect(&endpoint) {
        Ok(stream) => Arc::new(stream),
        Err(_) => {
            let _ = writeln!(errors, "{PREFIX}: Litria is not reachable. Is it still running?");
            return EXIT_UNREACHABLE;
        }
    };
    let mut hello = json!({ "litria": server::HELLO, "v": server::HELLO_VERSION, "token": token })
        .to_string()
        .into_bytes();
    hello.push(b'\n');
    if stream.write_all(&hello, WRITE_DEADLINE).is_err() {
        let _ = writeln!(errors, "{PREFIX}: Litria closed the connection before it could start.");
        return EXIT_UNREACHABLE;
    }
    let mut lines = Lines::new(&stream);
    let accepted = match lines.next(REPLY_DEADLINE, server::MAX_HELLO_BYTES) {
        Next::Line(line) => serde_json::from_slice::<Value>(&line)
            .ok()
            .is_some_and(|reply| reply["litria"] == server::READY),
        _ => false,
    };
    if !accepted {
        let _ = writeln!(
            errors,
            "{PREFIX}: Litria refused the connection: this agent's session has ended, or its project is no longer open."
        );
        return EXIT_REFUSED;
    }
    let early = lines.into_pending();
    if !early.is_empty() && (output.write_all(&early).is_err() || output.flush().is_err()) {
        return EXIT_STDIN_CLOSED;
    }
    relay(stream, input, output, errors)
}

enum Ended {
    InputClosed,
    LitriaClosed,
}

fn relay(stream: Arc<Stream>, mut input: impl io::Read + Send + 'static, mut output: impl Write, errors: &mut impl Write) -> i32 {
    let (ended, why) = mpsc::channel();
    let upstream = Arc::clone(&stream);
    let _ = std::thread::Builder::new().name("mcp-helper-stdin".into()).spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        let reason = loop {
            match input.read(&mut buf) {
                Ok(0) => break Ended::InputClosed,
                Ok(read) => {
                    if upstream.write_all(&buf[..read], WRITE_DEADLINE).is_err() {
                        break Ended::LitriaClosed;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break Ended::InputClosed,
            }
        };
        let _ = ended.send(reason);
        // Wake the other direction: the helper is done.
        upstream.cancel();
    });
    let mut buf = vec![0u8; 64 * 1024];
    let downstream_closed = loop {
        match stream.read(&mut buf, None) {
            Ok(Read::Data(read)) => {
                if output.write_all(&buf[..read]).is_err() || output.flush().is_err() {
                    // The agent stopped reading: it is gone.
                    return EXIT_STDIN_CLOSED;
                }
            }
            Ok(Read::TimedOut) => continue,
            Ok(Read::Cancelled) => break false,
            Ok(Read::Eof) | Err(_) => break true,
        }
    };
    let reason = if downstream_closed { Ended::LitriaClosed } else { why.recv().unwrap_or(Ended::InputClosed) };
    match reason {
        Ended::InputClosed => EXIT_STDIN_CLOSED,
        Ended::LitriaClosed => {
            let _ = writeln!(
                errors,
                "{PREFIX}: Litria closed the connection: the session ended, its project closed, or Litria quit."
            );
            EXIT_LITRIA_CLOSED
        }
    }
}

#[cfg(test)]
mod tests;
