use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use super::{Listener, Read, Stream, WRITE_DEADLINE};

const SHORT: Duration = Duration::from_millis(200);
const LONG: Duration = Duration::from_secs(10);

/// A listener and one connected pair: (server side, helper side).
fn connected_pair() -> (Arc<Listener>, Arc<Stream>, Arc<Stream>) {
    let listener = Arc::new(Listener::bind_new().expect("bind"));
    let accepting = Arc::clone(&listener);
    let server = thread::spawn(move || accepting.accept().expect("accept"));
    let client = Stream::connect(listener.address()).expect("connect");
    let server = server.join().expect("accept thread");
    (listener, Arc::new(server), Arc::new(client))
}

fn read_exact(stream: &Stream, len: usize) -> Vec<u8> {
    let mut got = Vec::new();
    let mut buf = [0u8; 4096];
    let deadline = Instant::now() + LONG;
    while got.len() < len {
        assert!(Instant::now() < deadline, "timed out after {} of {len} bytes", got.len());
        match stream.read(&mut buf, Some(LONG)).expect("read") {
            Read::Data(n) => got.extend_from_slice(&buf[..n]),
            other => panic!("expected data, got {other:?} after {} bytes", got.len()),
        }
    }
    got
}

#[test]
fn bytes_cross_in_both_directions() {
    let (_listener, server, client) = connected_pair();
    client.write_all(b"hello\n", WRITE_DEADLINE).unwrap();
    assert_eq!(read_exact(&server, 6), b"hello\n");
    server.write_all(b"ready\n", WRITE_DEADLINE).unwrap();
    assert_eq!(read_exact(&client, 6), b"ready\n");
}

/// The helper reads and writes from two threads at once. On a synchronous
/// Windows handle the waiting read would block the write, and the request
/// would never be sent.
#[test]
fn a_waiting_read_does_not_block_a_write_on_the_same_stream() {
    let (_listener, server, client) = connected_pair();
    let reader_side = Arc::clone(&client);
    let reader = thread::spawn(move || read_exact(&reader_side, 5));
    // Let the read start waiting first.
    thread::sleep(SHORT);
    let started = Instant::now();
    client.write_all(b"ping\n", WRITE_DEADLINE).unwrap();
    assert!(started.elapsed() < Duration::from_secs(2), "the write waited on the read");
    assert_eq!(read_exact(&server, 5), b"ping\n");
    server.write_all(b"pong\n", WRITE_DEADLINE).unwrap();
    assert_eq!(reader.join().unwrap(), b"pong\n");
}

/// Large writes in both directions at once, more than the pipe buffers, with
/// each side reading only on another thread.
#[test]
fn large_transfers_both_ways_at_once_complete() {
    let (_listener, server, client) = connected_pair();
    let size = 1024 * 1024;
    let payload: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
    let (to_server, to_client) = (payload.clone(), payload.clone());
    let server_reader = {
        let server = Arc::clone(&server);
        thread::spawn(move || read_exact(&server, size))
    };
    let client_reader = {
        let client = Arc::clone(&client);
        thread::spawn(move || read_exact(&client, size))
    };
    let server_writer = {
        let server = Arc::clone(&server);
        thread::spawn(move || server.write_all(&to_client, WRITE_DEADLINE).unwrap())
    };
    client.write_all(&to_server, WRITE_DEADLINE).unwrap();
    server_writer.join().unwrap();
    assert!(server_reader.join().unwrap() == payload, "server received the payload intact");
    assert!(client_reader.join().unwrap() == payload, "client received the payload intact");
}

#[test]
fn a_read_with_a_deadline_times_out() {
    let (_listener, server, _client) = connected_pair();
    let mut buf = [0u8; 16];
    let started = Instant::now();
    assert_eq!(server.read(&mut buf, Some(SHORT)).unwrap(), Read::TimedOut);
    assert!(started.elapsed() >= SHORT - Duration::from_millis(20));
    assert!(started.elapsed() < Duration::from_secs(3));
}

/// Data that arrives after a timeout is still delivered to the next read.
#[test]
fn a_timed_out_read_loses_nothing() {
    let (_listener, server, client) = connected_pair();
    let mut buf = [0u8; 16];
    assert_eq!(server.read(&mut buf, Some(SHORT)).unwrap(), Read::TimedOut);
    client.write_all(b"late\n", WRITE_DEADLINE).unwrap();
    assert_eq!(read_exact(&server, 5), b"late\n");
}

#[test]
fn cancel_wakes_a_blocked_read_and_refuses_later_ones() {
    let (_listener, server, _client) = connected_pair();
    let reading = Arc::clone(&server);
    let reader = thread::spawn(move || {
        let mut buf = [0u8; 16];
        reading.read(&mut buf, None).unwrap()
    });
    thread::sleep(SHORT);
    let started = Instant::now();
    server.cancel();
    assert_eq!(reader.join().unwrap(), Read::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(2));
    let mut buf = [0u8; 16];
    assert_eq!(server.read(&mut buf, Some(SHORT)).unwrap(), Read::Cancelled);
    assert!(server.write_all(b"x", WRITE_DEADLINE).is_err(), "a cancelled stream refuses writes");
}

#[test]
fn the_peer_closing_reads_as_eof() {
    let (_listener, server, client) = connected_pair();
    client.write_all(b"bye\n", WRITE_DEADLINE).unwrap();
    drop(client);
    // What was written before the close still arrives, then EOF.
    assert_eq!(read_exact(&server, 4), b"bye\n");
    let mut buf = [0u8; 16];
    assert_eq!(server.read(&mut buf, Some(LONG)).unwrap(), Read::Eof);
}

#[test]
fn several_clients_get_separate_streams() {
    let listener = Arc::new(Listener::bind_new().unwrap());
    let accepting = Arc::clone(&listener);
    let server = thread::spawn(move || (accepting.accept().unwrap(), accepting.accept().unwrap()));
    let first = Stream::connect(listener.address()).unwrap();
    let second = Stream::connect(listener.address()).unwrap();
    let (a, b) = server.join().unwrap();
    first.write_all(b"1", WRITE_DEADLINE).unwrap();
    second.write_all(b"2", WRITE_DEADLINE).unwrap();
    let mut got = vec![read_exact(&a, 1), read_exact(&b, 1)];
    got.sort();
    assert_eq!(got, vec![b"1".to_vec(), b"2".to_vec()]);
}

#[test]
fn shutdown_wakes_a_pending_accept() {
    let listener = Arc::new(Listener::bind_new().unwrap());
    let accepting = Arc::clone(&listener);
    let waiter = thread::spawn(move || accepting.accept().is_err());
    thread::sleep(SHORT);
    listener.shutdown();
    assert!(waiter.join().unwrap(), "accept fails after shutdown");
    assert!(listener.accept().is_err(), "and keeps failing");
}

#[test]
fn connecting_to_an_address_nobody_serves_fails() {
    let listener = Listener::bind_new().unwrap();
    let address = listener.address().to_owned();
    drop(listener);
    assert!(Stream::connect(&address).is_err());
}

#[test]
fn every_address_is_new() {
    let a = Listener::bind_new().unwrap();
    let b = Listener::bind_new().unwrap();
    assert_ne!(a.address(), b.address());
    assert!(a.address().contains("litria-mcp-"));
}

#[cfg(windows)]
mod windows_only {
    use super::*;
    use crate::mcp_connection::endpoint::windows::{current_user_sid, pipe_sddl};
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1, SE_KERNEL_OBJECT,
    };
    use windows::Win32::Security::{DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};

    fn dacl_of(stream: &Stream) -> String {
        unsafe {
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            let status = GetSecurityInfo(
                stream.raw_handle(),
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                None,
                None,
                Some(&mut descriptor),
            );
            assert!(status.is_ok(), "GetSecurityInfo: {status:?}");
            let mut text = PWSTR::null();
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                None,
            )
            .unwrap();
            let sddl = text.to_string().unwrap();
            let _ = LocalFree(Some(HLOCAL(text.0.cast())));
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            sddl
        }
    }

    /// Read back from the live pipe: a protected DACL with exactly one entry,
    /// allowing the current user. Nobody else, Everyone included, can open it.
    #[test]
    fn only_the_current_user_may_open_the_pipe() {
        let (_listener, server, _client) = connected_pair();
        let sid = current_user_sid().unwrap();
        assert!(sid.starts_with("S-1-"), "{sid}");
        let dacl = dacl_of(&server);
        assert!(dacl.starts_with("D:P"), "the DACL is protected from inheritance: {dacl}");
        assert_eq!(dacl.matches('(').count(), 1, "exactly one entry: {dacl}");
        assert!(dacl.starts_with("D:P(A;;"), "the entry allows: {dacl}");
        assert!(dacl.ends_with(&format!(";;;{sid})")), "the entry is the current user's: {dacl}");
        assert_eq!(pipe_sddl(&sid), format!("D:P(A;;GA;;;{sid})"));
    }

    /// A name someone already holds is refused, never shared.
    #[test]
    fn a_taken_pipe_name_is_refused() {
        let first = Listener::bind_new().unwrap();
        let taken = first.address().to_owned();
        assert!(Listener::bind_named(taken).is_err());
    }
}

#[cfg(unix)]
mod unix_only {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn the_socket_lives_in_a_directory_only_this_user_can_enter() {
        let listener = Listener::bind_new().unwrap();
        let mode = std::fs::metadata(listener.dir()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode & 0o077, 0, "no group or other access: {mode:o}");
        assert!(listener.address().len() <= 100, "fits sun_path: {}", listener.address());
    }

    /// A directory someone already made (or a link planted there) is refused.
    #[test]
    fn a_taken_directory_name_is_refused() {
        let base = std::env::temp_dir();
        let suffix = format!("taken-{}", std::process::id());
        let planted = base.join(format!("litria-mcp-{suffix}"));
        std::fs::create_dir_all(&planted).unwrap();
        assert!(Listener::bind_in(&base, &suffix).is_err());
        let _ = std::fs::remove_dir(&planted);
    }

    #[test]
    fn dropping_the_listener_removes_its_socket_and_directory() {
        let listener = Listener::bind_new().unwrap();
        let dir = listener.dir().to_path_buf();
        assert!(dir.exists());
        drop(listener);
        assert!(!dir.exists());
    }
}
