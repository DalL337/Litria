use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::endpoint::{Read, Stream, WRITE_DEADLINE};
use super::*;

pub(super) const FAST: Timing = Timing { hello: Duration::from_millis(400), tick: Duration::from_millis(40) };

/// A service whose open project the test controls (`ws-<n>`, or none at 0).
pub(super) fn service() -> (Arc<Service>, Arc<AtomicUsize>) {
    let open = Arc::new(AtomicUsize::new(1));
    let source = Arc::clone(&open);
    let service = Service::start(
        Box::new(move || match source.load(Ordering::SeqCst) {
            0 => None,
            n => Some(format!("ws-{n}")),
        }),
        FAST,
    )
    .unwrap();
    (service, open)
}

fn wait_until(limit: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + limit;
    while !done() {
        assert!(Instant::now() < deadline, "condition not reached in {limit:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_started_session_names_the_services_endpoint() {
    let (service, _open) = service();
    let connection = service.start_session("ws-1", Grant::default()).unwrap();
    assert_eq!(connection.endpoint, service.address());
    assert!(connection.session_id.starts_with("agent-"));
    assert_eq!(connection.token.len(), 64);
    assert!(service.end_session(&connection.session_id));
    assert!(!service.end_session(&connection.session_id), "already ended");
}

/// Connections still saying hello count too: a flood of silent clients takes
/// at most the cap, and the places come back once they are dropped.
#[test]
fn connections_are_capped_hello_included() {
    let (service, _open) = service();
    let mut silent = Vec::new();
    for _ in 0..MAX_CONNECTIONS {
        silent.push(Stream::connect(service.address()).unwrap());
    }
    wait_until(Duration::from_secs(5), || service.live_connections() == MAX_CONNECTIONS);
    // One more is accepted and dropped at once.
    let extra = Stream::connect(service.address()).unwrap();
    let mut buf = [0u8; 16];
    assert_eq!(extra.read(&mut buf, Some(Duration::from_secs(5))).unwrap(), Read::Eof);
    assert_eq!(service.live_connections(), MAX_CONNECTIONS);
    // The silent ones time out at the hello deadline and free their places.
    wait_until(Duration::from_secs(5), || service.live_connections() == 0);
    drop(silent);
}

#[test]
fn shutdown_ends_sessions_and_stops_accepting() {
    let (service, _open) = service();
    let connection = service.start_session("ws-1", Grant::default()).unwrap();
    let client = Stream::connect(service.address()).unwrap();
    let hello = format!("{{\"litria\":\"hello\",\"v\":1,\"token\":\"{}\"}}\n", connection.token);
    client.write_all(hello.as_bytes(), WRITE_DEADLINE).unwrap();
    let mut buf = [0u8; 64];
    assert!(matches!(client.read(&mut buf, Some(Duration::from_secs(5))).unwrap(), Read::Data(_)));
    service.shutdown();
    // The live connection closes...
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match client.read(&mut buf, Some(Duration::from_millis(100))).unwrap() {
            Read::Eof => break,
            Read::TimedOut if Instant::now() < deadline => continue,
            other => panic!("expected the connection to close, got {other:?}"),
        }
    }
    // ...no session starts, and nobody new gets in.
    assert!(service.start_session("ws-1", Grant::default()).is_err());
    assert!(Stream::connect(service.address()).is_err(), "the endpoint is gone");
}
