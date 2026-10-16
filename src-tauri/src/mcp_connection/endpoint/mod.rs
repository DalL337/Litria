//! The local channel between the MCP helper and the running app (track T,
//! slice T1a): a named pipe on Windows, a Unix domain socket elsewhere. Only
//! the current user can reach it, and there is never a network listener
//! (agent integration brief §3).
//!
//! Both platforms offer the same shape:
//! - [`Listener::bind_new`] creates a fresh, unguessable address for this run;
//! - [`Listener::accept`] waits for the next client;
//! - [`Stream::connect`] is the helper's side;
//! - [`Stream::read`] takes a deadline and can be cancelled from another
//!   thread ([`Stream::cancel`]), so a connection can be closed the moment its
//!   session ends, and an idle one still wakes to re-check its session;
//! - reads and writes may run on different threads at once (the helper relays
//!   both directions).

use std::time::Duration;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) use self::windows::{Listener, Stream};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub(crate) use self::unix::{Listener, Stream};

/// What one read produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Read {
    /// This many bytes, at the start of the buffer (never zero).
    Data(usize),
    /// The other side closed.
    Eof,
    /// The deadline passed with nothing to read.
    TimedOut,
    /// [`Stream::cancel`] was called.
    Cancelled,
}

/// Writes give up after this long: a client that stops reading must not hold
/// a connection's thread forever.
pub(crate) const WRITE_DEADLINE: Duration = Duration::from_secs(30);

/// A random, unguessable token for an address: 128 bits as hex.
fn random_suffix() -> std::io::Result<String> {
    use rand::TryRngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|error| std::io::Error::other(format!("the system random source failed: {error}")))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests;
