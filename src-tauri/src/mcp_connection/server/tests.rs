use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::*;
use crate::contracts::context::Grant;
use crate::mcp_connection::endpoint::Listener;
use crate::mcp_connection::sessions::MAX_CONNECTIONS_PER_SESSION;

const FAST: Timing = Timing { hello: Duration::from_millis(400), tick: Duration::from_millis(40) };
const WAIT: Duration = Duration::from_secs(5);

/// A listener and a registry whose open project the test controls (`ws-<n>`).
struct Rig {
    listener: Arc<Listener>,
    registry: Arc<Registry>,
    open: Arc<AtomicUsize>,
}

impl Rig {
    fn new() -> Self {
        let open = Arc::new(AtomicUsize::new(1));
        let source = Arc::clone(&open);
        let registry = Registry::new(Box::new(move || match source.load(Ordering::SeqCst) {
            0 => None,
            n => Some(format!("ws-{n}")),
        }));
        Self { listener: Arc::new(Listener::bind_new().unwrap()), registry: Arc::new(registry), open }
    }

    fn start(&self) -> (String, String) {
        let started = self.registry.start("ws-1", Grant::of(["project.files.read"])).unwrap();
        (started.session_id, started.token)
    }

    /// A client, and the thread serving it.
    fn connect(&self) -> (Stream, JoinHandle<()>) {
        let listener = Arc::clone(&self.listener);
        let registry = Arc::clone(&self.registry);
        let serving = thread::spawn(move || {
            let stream = Arc::new(listener.accept().unwrap());
            serve(stream, &registry, FAST);
        });
        (Stream::connect(self.listener.address()).unwrap(), serving)
    }

    fn connect_ready(&self, token: &str) -> (Stream, JoinHandle<()>) {
        let (client, serving) = self.connect();
        assert_eq!(say_hello(&client, token)["litria"], READY);
        (client, serving)
    }
}

fn send(client: &Stream, message: &Value) {
    let mut line = message.to_string().into_bytes();
    line.push(b'\n');
    client.write_all(&line, WRITE_DEADLINE).unwrap();
}

fn receive(client: &Stream) -> Option<Value> {
    let mut lines = Lines::new(client);
    match lines.next(WAIT, MAX_MESSAGE_BYTES) {
        Next::Line(line) => {
            assert!(lines.into_pending().is_empty(), "one answer at a time");
            Some(serde_json::from_slice(&line).unwrap())
        }
        Next::Closed => None,
        other => panic!("expected a line, got {other:?}"),
    }
}

fn say_hello(client: &Stream, token: &str) -> Value {
    send(client, &json!({ "litria": "hello", "v": 1, "token": token }));
    receive(client).expect("a reply to the hello")
}

fn finished_within(serving: JoinHandle<()>, limit: Duration) {
    let deadline = Instant::now() + limit;
    while !serving.is_finished() {
        assert!(Instant::now() < deadline, "the connection was still being served");
        thread::sleep(Duration::from_millis(10));
    }
    serving.join().unwrap();
}

fn closed(client: &Stream) -> bool {
    let mut buf = [0u8; 64];
    matches!(client.read(&mut buf, Some(WAIT)), Ok(Read::Eof))
}

#[test]
fn a_valid_token_gets_ready_and_then_mcp() {
    let rig = Rig::new();
    let (_id, token) = rig.start();
    let (client, _serving) = rig.connect_ready(&token);
    send(&client, &json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}));
    let answer = receive(&client).unwrap();
    assert_eq!(answer["result"]["protocolVersion"], "2025-11-25");
    send(&client, &json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
    send(&client, &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}));
    let list = receive(&client).unwrap();
    let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["litria_files_read"], "the session's grant decides the list");
}

/// No token, a wrong one, an ended one, an earlier run's, a malformed hello:
/// one refusal, then the connection closes. Nothing MCP is answered.
#[test]
fn every_bad_hello_is_refused_alike_and_closed() {
    let rig = Rig::new();
    let (ended_id, ended) = rig.start();
    assert!(rig.registry.end(&ended_id));
    let hellos = [
        json!({ "litria": "hello", "v": 1 }),
        json!({ "litria": "hello", "v": 1, "token": "0".repeat(64) }),
        json!({ "litria": "hello", "v": 1, "token": ended }),
        json!({ "litria": "hello", "v": 2, "token": "0".repeat(64) }),
        json!({ "litria": "hi", "v": 1, "token": "0".repeat(64) }),
        json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}),
    ];
    for hello in hellos {
        let (client, serving) = rig.connect();
        send(&client, &hello);
        let reply = receive(&client).unwrap();
        assert_eq!(reply, json!({ "litria": "refused", "v": 1 }), "{hello}");
        // An MCP request after the refusal gets nothing back.
        let _ = client.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n", WRITE_DEADLINE);
        drop(client);
        finished_within(serving, WAIT);
    }
}

#[test]
fn a_refusal_closes_even_if_the_client_never_does() {
    let rig = Rig::new();
    let (client, serving) = rig.connect();
    send(&client, &json!({ "litria": "hello", "v": 1, "token": "f".repeat(64) }));
    assert_eq!(receive(&client).unwrap()["litria"], REFUSED);
    // The client keeps the pipe open; the server gives up after its linger.
    finished_within(serving, REFUSAL_LINGER + WAIT);
    assert!(closed(&client));
}

#[test]
fn a_silent_client_is_closed_at_the_hello_deadline() {
    let rig = Rig::new();
    let (client, serving) = rig.connect();
    let started = Instant::now();
    finished_within(serving, WAIT);
    assert!(started.elapsed() >= FAST.hello - Duration::from_millis(50));
    assert!(closed(&client), "closed without a word");
}

#[test]
fn an_endless_hello_is_dropped_without_an_answer() {
    let rig = Rig::new();
    let (client, serving) = rig.connect();
    let flood = vec![b'a'; 64 * 1024];
    let _ = client.write_all(&flood, WRITE_DEADLINE);
    finished_within(serving, WAIT);
    assert!(closed(&client));
}

#[test]
fn ending_the_session_closes_its_connection_at_once() {
    let rig = Rig::new();
    let (id, token) = rig.start();
    let (client, serving) = rig.connect_ready(&token);
    let started = Instant::now();
    assert!(rig.registry.end(&id));
    finished_within(serving, Duration::from_secs(2));
    assert!(closed(&client));
    assert!(started.elapsed() < Duration::from_secs(2));
}

/// The project switches while the agent is idle: the connection closes
/// within a tick, and a message after the switch is never answered.
#[test]
fn a_project_switch_closes_the_connection_unanswered() {
    let rig = Rig::new();
    let (_id, token) = rig.start();
    let (idle, idle_serving) = rig.connect_ready(&token);
    let (busy, _busy_serving) = rig.connect_ready(&token);
    rig.open.store(2, Ordering::SeqCst);
    finished_within(idle_serving, Duration::from_secs(2));
    assert!(closed(&idle));
    // The other connection may not have ticked yet: what it sends now must
    // still go unanswered.
    let _ = busy.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n", WRITE_DEADLINE);
    assert!(receive(&busy).is_none(), "nothing is answered for a project no longer open");
    // And the token is spent for good.
    rig.open.store(1, Ordering::SeqCst);
    let (again, _serving) = rig.connect();
    assert_eq!(say_hello(&again, &token)["litria"], REFUSED);
}

#[test]
fn an_oversized_message_is_refused_unparsed_and_the_connection_goes_on() {
    let rig = Rig::new();
    let (_id, token) = rig.start();
    let (client, _serving) = rig.connect_ready(&token);
    let mut huge = vec![b' '; MAX_MESSAGE_BYTES + 10];
    huge.push(b'\n');
    client.write_all(&huge, WRITE_DEADLINE).unwrap();
    let answer = receive(&client).unwrap();
    assert_eq!(answer["error"]["code"], INVALID_REQUEST);
    assert_eq!(answer["id"], Value::Null);
    send(&client, &json!({"jsonrpc":"2.0","id":"p","method":"ping"}));
    assert_eq!(receive(&client).unwrap()["id"], "p");
}

#[test]
fn a_session_holds_a_bounded_number_of_connections() {
    let rig = Rig::new();
    let (_id, token) = rig.start();
    let mut held = Vec::new();
    for _ in 0..MAX_CONNECTIONS_PER_SESSION {
        held.push(rig.connect_ready(&token));
    }
    let (extra, serving) = rig.connect();
    assert_eq!(say_hello(&extra, &token)["litria"], REFUSED, "one over the cap");
    drop(extra);
    finished_within(serving, WAIT);
    // Closing one frees its place.
    let (first, first_serving) = held.remove(0);
    drop(first);
    finished_within(first_serving, WAIT);
    let (_again, _serving) = rig.connect_ready(&token);
}

// --- Line framing --------------------------------------------------------------

fn pair() -> (Stream, Stream) {
    let listener = Arc::new(Listener::bind_new().unwrap());
    let accepting = Arc::clone(&listener);
    let server = thread::spawn(move || accepting.accept().unwrap());
    let client = Stream::connect(listener.address()).unwrap();
    (server.join().unwrap(), client)
}

#[test]
fn lines_split_on_newlines_and_drop_carriage_returns_and_blank_lines() {
    let (server, client) = pair();
    client.write_all(b"one\r\n\n  \r\ntwo\nthr", WRITE_DEADLINE).unwrap();
    let mut lines = Lines::new(&server);
    assert_eq!(lines.next(WAIT, 16), Next::Line(b"one".to_vec()));
    assert_eq!(lines.next(WAIT, 16), Next::Line(b"two".to_vec()));
    assert_eq!(lines.next(Duration::from_millis(100), 16), Next::Idle, "half a line is not a line");
    client.write_all(b"ee\n", WRITE_DEADLINE).unwrap();
    assert_eq!(lines.next(WAIT, 16), Next::Line(b"three".to_vec()));
}

#[test]
fn the_cap_is_exact() {
    let (server, client) = pair();
    let cap = 8;
    // Exactly at the cap, with and without CR; then one over, both ways.
    client.write_all(b"12345678\n12345678\r\n123456789\n123456789\r\nok\n", WRITE_DEADLINE).unwrap();
    let mut lines = Lines::new(&server);
    assert_eq!(lines.next(WAIT, cap), Next::Line(b"12345678".to_vec()));
    assert_eq!(lines.next(WAIT, cap), Next::Line(b"12345678".to_vec()));
    assert_eq!(lines.next(WAIT, cap), Next::TooLong);
    assert_eq!(lines.next(WAIT, cap), Next::TooLong);
    assert_eq!(lines.next(WAIT, cap), Next::Line(b"ok".to_vec()));
}

/// A line far over the cap, arriving in many reads, is dropped as it comes:
/// what is held never grows past the cap and one read.
#[test]
fn an_endless_line_is_discarded_as_it_arrives() {
    let (server, client) = pair();
    let cap = 1024;
    let writer = thread::spawn(move || {
        for _ in 0..256 {
            client.write_all(&[b'x'; 4096], WRITE_DEADLINE).unwrap();
        }
        client.write_all(b"\nafter\n", WRITE_DEADLINE).unwrap();
        client
    });
    let mut lines = Lines::new(&server);
    let mut held_most = 0;
    let first = loop {
        match lines.next(Duration::from_millis(20), cap) {
            Next::Idle => held_most = held_most.max(lines.pending.len()),
            other => break other,
        }
    };
    assert_eq!(first, Next::TooLong);
    assert!(held_most <= cap + 1 + 8 * 1024, "held {held_most} bytes");
    assert_eq!(lines.next(WAIT, cap), Next::Line(b"after".to_vec()));
    drop(writer.join().unwrap());
}

#[test]
fn closing_ends_the_lines() {
    let (server, client) = pair();
    drop(client);
    assert_eq!(Lines::new(&server).next(WAIT, 16), Next::Closed);
}

#[test]
fn hello_lines_are_read_strictly() {
    let token = "a".repeat(64);
    assert_eq!(hello_token(json!({"litria":"hello","v":1,"token":token}).to_string().as_bytes()), Some(token.clone()));
    for bad in [
        json!({"litria":"hello","v":1,"token":7}),
        json!({"litria":"hello","token":token}),
        json!({"litria":"hello","v":"1","token":token}),
        json!(["hello", token]),
    ] {
        assert_eq!(hello_token(bad.to_string().as_bytes()), None, "{bad}");
    }
    assert_eq!(hello_token(b"not json"), None);
}
