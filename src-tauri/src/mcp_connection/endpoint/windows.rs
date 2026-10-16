//! Windows: a named pipe `\\.\pipe\litria-mcp-<random>`.
//!
//! - **Who can open it.** The pipe's DACL grants the current user, and only
//!   the current user, full access (SDDL `D:P(A;;GA;;;<user SID>)`). The
//!   default DACL would also grant Everyone read access.
//! - **No network.** `PIPE_REJECT_REMOTE_CLIENTS` refuses SMB clients.
//! - **No squatting.** The first instance is created with
//!   `FILE_FLAG_FIRST_PIPE_INSTANCE`, which fails if any process already owns
//!   the name. Later instances need `FILE_CREATE_PIPE_INSTANCE` on that DACL,
//!   which only the current user holds.
//! - **The client never lends its identity.** The helper opens the pipe with
//!   `SECURITY_IDENTIFICATION`, so even a hostile server could not act as it.
//! - **Overlapped I/O.** On a handle opened for synchronous I/O, Windows
//!   serializes every operation, so a read waiting for data blocks a write
//!   from another thread: the helper's two relay threads would deadlock.
//!   Overlapped handles let a read and a write run at once, and let a wait be
//!   cut short by a deadline or by [`Stream::cancel`]. Every operation waits
//!   for its own completion (after `CancelIoEx` if need be) before it returns,
//!   so the `OVERLAPPED` and the buffer outlive the kernel's use of them.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_OPERATION_ABORTED,
    ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE, HLOCAL,
    WAIT_OBJECT_0, WAIT_TIMEOUT, WIN32_ERROR,
};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
    FILE_SHARE_NONE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, WaitNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, OpenProcessToken, SetEvent, WaitForMultipleObjects, INFINITE,
};

use super::{random_suffix, Read};

/// Bytes the kernel buffers in each direction of one pipe instance.
const PIPE_BUFFER: u32 = 64 * 1024;

/// How long [`Stream::connect`] keeps trying while every instance is busy.
const CONNECT_DEADLINE: Duration = Duration::from_secs(2);

/// An owned kernel handle, closed on drop.
struct Owned(HANDLE);

// A HANDLE is an opaque kernel reference; the kernel object is safe to use
// from any thread.
unsafe impl Send for Owned {}
unsafe impl Sync for Owned {}

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

fn manual_reset_event() -> io::Result<Owned> {
    unsafe { CreateEventW(None, true, false, PCWSTR::null()) }
        .map(Owned)
        .map_err(|error| win32_io_error(&error))
}

/// `windows::core::Error` converts to `io::Error` by its HRESULT, which
/// `io::ErrorKind` cannot classify; recover the Win32 code it wraps (the same
/// mapping as `write_ops::win32_io_error`).
fn win32_io_error(error: &windows::core::Error) -> io::Error {
    let code = error.code().0 as u32;
    if code & 0xFFFF_0000 == 0x8007_0000 {
        io::Error::from_raw_os_error((code & 0xFFFF) as i32)
    } else {
        io::Error::other(error.message())
    }
}

fn is(error: &windows::core::Error, code: WIN32_ERROR) -> bool {
    error.code() == code.to_hresult()
}

/// A security descriptor from SDDL, freed on drop.
struct Descriptor(PSECURITY_DESCRIPTOR);

unsafe impl Send for Descriptor {}
unsafe impl Sync for Descriptor {}

impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(self.0 .0)));
        }
    }
}

/// The current process user's SID, as a string (`S-1-5-21-…`).
pub(super) fn current_user_sid() -> io::Result<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(|e| win32_io_error(&e))?;
        let token = Owned(token);
        let mut needed = 0u32;
        // The first call only reports the size.
        let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            return Err(io::Error::other("the process token's user could not be sized"));
        }
        // u64 storage keeps TOKEN_USER suitably aligned.
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
        GetTokenInformation(token.0, TokenUser, Some(buffer.as_mut_ptr().cast()), needed, &mut needed)
            .map_err(|e| win32_io_error(&e))?;
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text).map_err(|e| win32_io_error(&e))?;
        let sid = text.to_string();
        let _ = LocalFree(Some(HLOCAL(text.0.cast())));
        sid.map_err(|_| io::Error::other("the user SID is not valid UTF-16"))
    }
}

/// The SDDL of the pipe's DACL: the current user only, protected from
/// inheritance.
pub(super) fn pipe_sddl(sid: &str) -> String {
    format!("D:P(A;;GA;;;{sid})")
}

fn descriptor_for_current_user() -> io::Result<Descriptor> {
    let sddl = HSTRING::from(pipe_sddl(&current_user_sid()?));
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(&sddl, SDDL_REVISION_1, &mut descriptor, None)
            .map_err(|e| win32_io_error(&e))?;
    }
    Ok(Descriptor(descriptor))
}

/// The app's side: hands out one connected [`Stream`] per client.
pub(crate) struct Listener {
    name: String,
    descriptor: Descriptor,
    /// The instance the next client will connect to, created ahead so a
    /// client never finds no instance at all.
    next: Mutex<Option<Owned>>,
    accept_event: Owned,
    shutdown_event: Owned,
    shut_down: AtomicBool,
}

impl Listener {
    /// A new pipe with a random name, refused if the name is taken.
    pub(crate) fn bind_new() -> io::Result<Self> {
        Self::bind_named(format!(r"\\.\pipe\litria-mcp-{}", random_suffix()?))
    }

    /// Bind exactly `name` (tests use this to show a taken name is refused).
    pub(super) fn bind_named(name: String) -> io::Result<Self> {
        let descriptor = descriptor_for_current_user()?;
        let listener = Self {
            name,
            descriptor,
            next: Mutex::new(None),
            accept_event: manual_reset_event()?,
            shutdown_event: manual_reset_event()?,
            shut_down: AtomicBool::new(false),
        };
        let first = listener.create_instance(true)?;
        *listener.next.lock().unwrap_or_else(|p| p.into_inner()) = Some(first);
        Ok(listener)
    }

    /// The address a helper connects to.
    pub(crate) fn address(&self) -> &str {
        &self.name
    }

    fn create_instance(&self, first: bool) -> io::Result<Owned> {
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor.0 .0,
            bInheritHandle: false.into(),
        };
        let mut open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
        if first {
            open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
        }
        let handle = unsafe {
            CreateNamedPipeW(
                &HSTRING::from(self.name.as_str()),
                open_mode,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                PIPE_BUFFER,
                PIPE_BUFFER,
                0,
                Some(&attributes),
            )
        };
        if handle.is_invalid() {
            return Err(io::Error::last_os_error());
        }
        Ok(Owned(handle))
    }

    /// Wait for the next client. Fails once [`Listener::shutdown`] is called.
    pub(crate) fn accept(&self) -> io::Result<Stream> {
        if self.shut_down.load(Ordering::SeqCst) {
            return Err(io::Error::other("the listener is shut down"));
        }
        let instance = match self.next.lock().unwrap_or_else(|p| p.into_inner()).take() {
            Some(instance) => instance,
            None => self.create_instance(false)?,
        };
        let mut overlapped = OVERLAPPED { hEvent: self.accept_event.0, ..Default::default() };
        let connected = match unsafe { ConnectNamedPipe(instance.0, Some(&mut overlapped)) } {
            Ok(()) => true,
            Err(error) if is(&error, ERROR_PIPE_CONNECTED) => true,
            Err(error) if is(&error, ERROR_IO_PENDING) => false,
            Err(error) => return Err(win32_io_error(&error)),
        };
        if !connected {
            let woke = unsafe { WaitForMultipleObjects(&[self.accept_event.0, self.shutdown_event.0], false, INFINITE) };
            let mut transferred = 0u32;
            if woke != WAIT_OBJECT_0 {
                unsafe {
                    let _ = CancelIoEx(instance.0, Some(&overlapped));
                    let _ = GetOverlappedResult(instance.0, &overlapped, &mut transferred, true);
                }
                return Err(io::Error::other("the listener is shut down"));
            }
            unsafe { GetOverlappedResult(instance.0, &overlapped, &mut transferred, false) }
                .map_err(|e| win32_io_error(&e))?;
        }
        // A client that connected as the listener shut down is let go, not
        // served (dropping the instance closes it).
        if self.shut_down.load(Ordering::SeqCst) {
            return Err(io::Error::other("the listener is shut down"));
        }
        // The next client's instance, before this one is handed over. A
        // failure here only costs the next client a retry.
        if let Ok(next) = self.create_instance(false) {
            let mut slot = self.next.lock().unwrap_or_else(|p| p.into_inner());
            if !self.shut_down.load(Ordering::SeqCst) {
                *slot = Some(next);
            }
        }
        Stream::from_handle(instance)
    }

    /// Wake a pending [`Listener::accept`], refuse every later one, and close
    /// the instance waiting for the next client, so new clients fail at once.
    pub(crate) fn shutdown(&self) {
        self.shut_down.store(true, Ordering::SeqCst);
        unsafe {
            let _ = SetEvent(self.shutdown_event.0);
        }
        drop(self.next.lock().unwrap_or_else(|p| p.into_inner()).take());
    }
}

/// One end of a connected pipe.
pub(crate) struct Stream {
    handle: Owned,
    /// One event per direction; the mutexes keep one operation per direction
    /// in flight, which is all the overlapped bookkeeping below allows.
    read_event: Mutex<Owned>,
    write_event: Mutex<Owned>,
    cancel_event: Owned,
    cancelled: AtomicBool,
}

impl Stream {
    fn from_handle(handle: Owned) -> io::Result<Self> {
        Ok(Self {
            handle,
            read_event: Mutex::new(manual_reset_event()?),
            write_event: Mutex::new(manual_reset_event()?),
            cancel_event: manual_reset_event()?,
            cancelled: AtomicBool::new(false),
        })
    }

    /// The helper's side: open `address`, waiting a short while if every
    /// instance is busy.
    pub(crate) fn connect(address: &str) -> io::Result<Self> {
        let name = HSTRING::from(address);
        let deadline = Instant::now() + CONNECT_DEADLINE;
        loop {
            let flags: FILE_FLAGS_AND_ATTRIBUTES = FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION;
            match unsafe {
                CreateFileW(
                    &name,
                    (GENERIC_READ | GENERIC_WRITE).0,
                    FILE_SHARE_NONE,
                    None,
                    OPEN_EXISTING,
                    flags,
                    None,
                )
            } {
                Ok(handle) => return Self::from_handle(Owned(handle)),
                Err(error) if is(&error, ERROR_PIPE_BUSY) && Instant::now() < deadline => {
                    let left = deadline.saturating_duration_since(Instant::now()).as_millis().max(1) as u32;
                    unsafe {
                        let _ = WaitNamedPipeW(&name, left.min(500));
                    }
                }
                Err(error) => return Err(win32_io_error(&error)),
            }
        }
    }

    /// Read into `buf`, giving up after `timeout` (`None`: no deadline).
    pub(crate) fn read(&self, buf: &mut [u8], timeout: Option<Duration>) -> io::Result<Read> {
        if buf.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "read into an empty buffer"));
        }
        let event = self.read_event.lock().unwrap_or_else(|p| p.into_inner());
        let deadline = timeout.map(|t| Instant::now() + t);
        loop {
            if self.cancelled.load(Ordering::SeqCst) {
                return Ok(Read::Cancelled);
            }
            let wait_ms = match deadline {
                None => INFINITE,
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Ok(Read::TimedOut);
                    }
                    (left.as_millis().min(u128::from(INFINITE - 1)) as u32).max(1)
                }
            };
            let mut overlapped = OVERLAPPED { hEvent: event.0, ..Default::default() };
            let started = unsafe { ReadFile(self.handle.0, Some(&mut buf[..]), None, Some(&mut overlapped)) };
            match started {
                Ok(()) => {}
                Err(error) if is(&error, ERROR_IO_PENDING) => {}
                Err(error) if is_closed(&error) => return Ok(Read::Eof),
                Err(error) => return Err(win32_io_error(&error)),
            }
            let woke = unsafe { WaitForMultipleObjects(&[event.0, self.cancel_event.0], false, wait_ms) };
            let mut transferred = 0u32;
            let finished = if woke == WAIT_OBJECT_0 {
                unsafe { GetOverlappedResult(self.handle.0, &overlapped, &mut transferred, false) }
            } else {
                // Deadline or cancel: stop the read and wait until the kernel
                // has let go of the buffer. Data that won the race is kept.
                unsafe {
                    let _ = CancelIoEx(self.handle.0, Some(&overlapped));
                    GetOverlappedResult(self.handle.0, &overlapped, &mut transferred, true)
                }
            };
            match finished {
                Ok(()) if transferred > 0 => return Ok(Read::Data(transferred as usize)),
                // A zero-length write from the peer: nothing to report.
                Ok(()) => continue,
                Err(error) if is(&error, ERROR_OPERATION_ABORTED) => {
                    if self.cancelled.load(Ordering::SeqCst) || woke != WAIT_TIMEOUT {
                        return Ok(Read::Cancelled);
                    }
                    return Ok(Read::TimedOut);
                }
                Err(error) if is_closed(&error) => return Ok(Read::Eof),
                Err(error) => return Err(win32_io_error(&error)),
            }
        }
    }

    /// Write all of `data`, within `timeout`.
    pub(crate) fn write_all(&self, data: &[u8], timeout: Duration) -> io::Result<()> {
        let event = self.write_event.lock().unwrap_or_else(|p| p.into_inner());
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
            let mut overlapped = OVERLAPPED { hEvent: event.0, ..Default::default() };
            let started = unsafe { WriteFile(self.handle.0, Some(&data[sent..]), None, Some(&mut overlapped)) };
            match started {
                Ok(()) => {}
                Err(error) if is(&error, ERROR_IO_PENDING) => {}
                Err(error) if is_closed(&error) => {
                    return Err(io::Error::new(io::ErrorKind::BrokenPipe, "the other side closed"))
                }
                Err(error) => return Err(win32_io_error(&error)),
            }
            let wait_ms = (left.as_millis().min(u128::from(INFINITE - 1)) as u32).max(1);
            let woke = unsafe { WaitForMultipleObjects(&[event.0, self.cancel_event.0], false, wait_ms) };
            let mut transferred = 0u32;
            let finished = if woke == WAIT_OBJECT_0 {
                unsafe { GetOverlappedResult(self.handle.0, &overlapped, &mut transferred, false) }
            } else {
                unsafe {
                    let _ = CancelIoEx(self.handle.0, Some(&overlapped));
                    GetOverlappedResult(self.handle.0, &overlapped, &mut transferred, true)
                }
            };
            match finished {
                Ok(()) => sent += transferred as usize,
                Err(error) if is(&error, ERROR_OPERATION_ABORTED) => {
                    let kind = if woke == WAIT_TIMEOUT { io::ErrorKind::TimedOut } else { io::ErrorKind::Interrupted };
                    return Err(io::Error::new(kind, "the write did not complete"));
                }
                Err(error) if is_closed(&error) => {
                    return Err(io::Error::new(io::ErrorKind::BrokenPipe, "the other side closed"))
                }
                Err(error) => return Err(win32_io_error(&error)),
            }
        }
        Ok(())
    }

    /// Wake any read or write in progress and refuse every later one. Safe
    /// from any thread, any number of times.
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        unsafe {
            let _ = SetEvent(self.cancel_event.0);
        }
    }

    /// The raw handle, for tests that inspect the pipe's security.
    #[cfg(test)]
    pub(super) fn raw_handle(&self) -> HANDLE {
        self.handle.0
    }
}

fn is_closed(error: &windows::core::Error) -> bool {
    is(error, ERROR_BROKEN_PIPE) || is(error, ERROR_PIPE_NOT_CONNECTED) || is(error, ERROR_NO_DATA)
}
