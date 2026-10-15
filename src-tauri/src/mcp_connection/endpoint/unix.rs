//! Unix: a domain socket in a fresh private directory.
//!
//! - **Who can open it.** The directory is created with mode `0700`, so only
//!   the current user can reach the socket inside it. `mkdir` fails if
//!   anything already has the name (a link included), so the directory is
//!   always this process's own: no other user can plant one first.
//! - **Where.** `$XDG_RUNTIME_DIR` (per-user, Linux) when set, else the
//!   system temporary directory (`$TMPDIR` is per-user on macOS). The socket
//!   path stays below `sun_path`'s limit (104 bytes on macOS); a base that is
//!   too long falls back to `/tmp`.
//! - **Cleanup.** The socket and its directory are removed when the listener
//!   drops. A crash leaves the directory and its dead socket behind, under
//!   its random name; nothing can connect to it.
//! - **Cancel.** `shutdown(Both)` wakes a blocked read; a flag set first tells
//!   it apart from the peer closing.

use std::io::{self, Read as _, Write as _};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::{random_suffix, Read};

/// macOS allows 104 bytes in `sun_path`, Linux 108; leave room for the NUL.
const MAX_SOCKET_PATH: usize = 100;

const SOCKET_NAME: &str = "mcp.sock";

/// `EINVAL`: 22 on Linux and macOS alike (no `libc` dependency for one number).
const EINVAL: i32 = 22;

fn base_dir() -> PathBuf {
    if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
        let runtime = PathBuf::from(runtime);
        if runtime.is_absolute() && runtime.is_dir() {
            return runtime;
        }
    }
    std::env::temp_dir()
}

/// The app's side: hands out one connected [`Stream`] per client.
pub(crate) struct Listener {
    dir: PathBuf,
    address: String,
    listener: UnixListener,
    shut_down: AtomicBool,
}

impl Listener {
    /// A new socket in a new private directory with a random name.
    pub(crate) fn bind_new() -> io::Result<Self> {
        let suffix = random_suffix()?;
        let mut base = base_dir();
        let probe = base.join(format!("litria-mcp-{suffix}")).join(SOCKET_NAME);
        if probe.as_os_str().len() > MAX_SOCKET_PATH {
            base = PathBuf::from("/tmp");
        }
        Self::bind_in(&base, &suffix)
    }

    /// Bind in `base` under exactly `suffix` (tests use this to show a taken
    /// name is refused).
    pub(super) fn bind_in(base: &Path, suffix: &str) -> io::Result<Self> {
        let dir = base.join(format!("litria-mcp-{suffix}"));
        // Not create_dir_all: an existing directory must be an error.
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
        let path = dir.join(SOCKET_NAME);
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) => {
                let _ = std::fs::remove_dir(&dir);
                return Err(error);
            }
        };
        let address = path
            .to_str()
            .ok_or_else(|| io::Error::other("the socket path is not UTF-8"))?
            .to_owned();
        Ok(Self { dir, address, listener, shut_down: AtomicBool::new(false) })
    }

    /// The address a helper connects to.
    pub(crate) fn address(&self) -> &str {
        &self.address
    }

    /// The private directory holding the socket, for tests.
    #[cfg(test)]
    pub(super) fn dir(&self) -> &Path {
        &self.dir
    }

    /// Wait for the next client. Fails once [`Listener::shutdown`] is called.
    pub(crate) fn accept(&self) -> io::Result<Stream> {
        loop {
            if self.shut_down.load(Ordering::SeqCst) {
                return Err(io::Error::other("the listener is shut down"));
            }
            let (stream, _) = match self.listener.accept() {
                Ok(accepted) => accepted,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            };
            if self.shut_down.load(Ordering::SeqCst) {
                return Err(io::Error::other("the listener is shut down"));
            }
            return Ok(Stream::from_stream(stream));
        }
    }

    /// Wake a pending [`Listener::accept`], refuse every later one, and
    /// remove the socket so new clients fail at once.
    pub(crate) fn shutdown(&self) {
        self.shut_down.store(true, Ordering::SeqCst);
        // accept(2) has no timeout; a connection of our own wakes it.
        let _ = UnixStream::connect(Path::new(&self.address));
        let _ = std::fs::remove_file(&self.address);
        let _ = std::fs::remove_dir(&self.dir);
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.address);
        let _ = std::fs::remove_dir(&self.dir);
    }
}

/// One end of a connected socket.
pub(crate) struct Stream {
    stream: UnixStream,
    reading: Mutex<()>,
    writing: Mutex<()>,
    cancelled: AtomicBool,
}

impl Stream {
    fn from_stream(stream: UnixStream) -> Self {
        Self { stream, reading: Mutex::new(()), writing: Mutex::new(()), cancelled: AtomicBool::new(false) }
    }

    /// The helper's side.
    pub(crate) fn connect(address: &str) -> io::Result<Self> {
        UnixStream::connect(address).map(Self::from_stream)
    }

    /// Read into `buf`, giving up after `timeout` (`None`: no deadline).
    pub(crate) fn read(&self, buf: &mut [u8], timeout: Option<Duration>) -> io::Result<Read> {
        if buf.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "read into an empty buffer"));
        }
        let _reading = self.reading.lock().unwrap_or_else(|p| p.into_inner());
        let deadline = timeout.map(|t| Instant::now() + t);
        loop {
            if self.cancelled.load(Ordering::SeqCst) {
                return Ok(Read::Cancelled);
            }
            let wait = match deadline {
                None => None,
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Ok(Read::TimedOut);
                    }
                    Some(left)
                }
            };
            match self.stream.set_read_timeout(wait) {
                Ok(()) => {}
                // macOS refuses SO_RCVTIMEO once the socket can no longer
                // receive (the peer closed it, or `cancel` shut it down): the
                // read below then returns at once, with what is left or 0.
                // Linux allows the call. Found by CI on macos-14 (T1a).
                Err(error) if error.raw_os_error() == Some(EINVAL) => {}
                Err(error) => return Err(error),
            }
            match (&self.stream).read(buf) {
                Ok(0) if self.cancelled.load(Ordering::SeqCst) => return Ok(Read::Cancelled),
                Ok(0) => return Ok(Read::Eof),
                Ok(read) => return Ok(Read::Data(read)),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error)
                    if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) =>
                {
                    continue
                }
                Err(_) if self.cancelled.load(Ordering::SeqCst) => return Ok(Read::Cancelled),
                Err(error) if error.kind() == io::ErrorKind::ConnectionReset => return Ok(Read::Eof),
                Err(error) => return Err(error),
            }
        }
    }

    /// Write all of `data`, within `timeout`.
    pub(crate) fn write_all(&self, data: &[u8], timeout: Duration) -> io::Result<()> {
        let _writing = self.writing.lock().unwrap_or_else(|p| p.into_inner());
        let deadline = Instant::now() + timeout;
        let mut sent = 0usize;
        while sent < data.len() {
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "the connection was cancelled"));
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "the other side stopped reading"));
            }
            match self.stream.set_write_timeout(Some(left)) {
                Ok(()) => {}
                // As for reads: on macOS this fails once the socket is shut
                // down, which for a write means the other side is gone.
                Err(error) if error.raw_os_error() == Some(EINVAL) => {
                    return Err(io::Error::new(io::ErrorKind::BrokenPipe, "the other side closed"))
                }
                Err(error) => return Err(error),
            }
            match (&self.stream).write(&data[sent..]) {
                Ok(0) => return Err(io::Error::new(io::ErrorKind::BrokenPipe, "the other side closed")),
                Ok(written) => sent += written,
                Err(error) if matches!(error.kind(), io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock) => {
                    continue
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    /// Wake any read or write in progress and refuse every later one. Safe
    /// from any thread, any number of times.
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}
