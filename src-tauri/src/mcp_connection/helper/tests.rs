use std::io::{BufRead, BufReader, Write as _};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::contracts::context::Grant;
use crate::mcp_connection::tests::service;

const WAIT: Duration = Duration::from_secs(10);

/// The helper on its own thread, with pipes for its stdin and stdout.
struct Running {
    stdin: Option<io::PipeWriter>,
    stdout: mpsc::Receiver<String>,
    done: mpsc::Receiver<(i32, String)>,
}

fn run_helper(endpoint: Option<String>, token: Option<String>) -> Running {
    let (input, stdin) = io::pipe().unwrap();
    let (stdout_reader, output) = io::pipe().unwrap();
    let (line_tx, stdout) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout_reader).lines() {
            let Ok(line) = line else { break };
            if line_tx.send(line).is_err() {
                break;
            }
        }
    });
    let (done_tx, done) = mpsc::channel();
    thread::spawn(move || {
        let mut errors = Vec::new();
        let code = run_with(endpoint, token, input, output, &mut errors);
        let _ = done_tx.send((code, String::from_utf8_lossy(&errors).into_owned()));
    });
    Running { stdin: Some(stdin), stdout, done }
}

impl Running {
    fn send(&mut self, message: Value) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{message}").unwrap();
    }

    fn receive(&self) -> Value {
        serde_json::from_str(&self.stdout.recv_timeout(WAIT).expect("a line on stdout")).unwrap()
    }

    fn close_stdin(&mut self) {
        self.stdin = None;
    }

    fn finish(&self) -> (i32, String) {
        self.done.recv_timeout(WAIT).expect("the helper exited")
    }

    /// After the helper exits its stdout closes: true if it wrote nothing.
    fn wrote_nothing(&self) -> bool {
        self.stdout.recv_timeout(Duration::from_secs(2)).is_err()
    }
}

#[test]
fn without_a_session_it_says_so_and_exits() {
    for (endpoint, token) in [(None, None), (Some("x".to_string()), None), (None, Some("t".into())), (Some(String::new()), Some(String::new()))] {
        let running = run_helper(endpoint, token);
        let (code, errors) = running.finish();
        assert_eq!(code, EXIT_NO_SESSION);
        assert!(errors.contains("no Litria session"), "{errors}");
    }
}

#[test]
fn an_endpoint_nobody_serves_is_unreachable() {
    let (service, _open) = service();
    let connection = service.start_session("ws-1", Grant::default()).unwrap();
    service.shutdown();
    let running = run_helper(Some(connection.endpoint), Some(connection.token.clone()));
    let (code, errors) = running.finish();
    assert_eq!(code, EXIT_UNREACHABLE);
    assert!(errors.contains("not reachable"), "{errors}");
    assert!(!errors.contains(&connection.token), "the token is never printed");
}

#[test]
fn a_refused_token_exits_with_its_reason_and_never_prints_the_token() {
    let (service, _open) = service();
    let connection = service.start_session("ws-1", Grant::default()).unwrap();
    let wrong = "0".repeat(64);
    let mut running = run_helper(Some(connection.endpoint.clone()), Some(wrong.clone()));
    running.send(json!({"jsonrpc":"2.0","id":0,"method":"ping"}));
    let (code, errors) = running.finish();
    assert_eq!(code, EXIT_REFUSED);
    assert!(errors.contains("refused"), "{errors}");
    assert!(!errors.contains(&wrong) && !errors.contains(&connection.token));
    assert!(running.wrote_nothing(), "nothing but MCP ever reaches stdout");
}

/// The whole path: the agent's stdio, the helper, the endpoint, the server.
#[test]
fn it_relays_mcp_both_ways_and_exits_when_stdin_closes() {
    let (service, _open) = service();
    let connection = service.start_session("ws-1", crate::project_api::agent_grant()).unwrap();
    let mut running = run_helper(Some(connection.endpoint), Some(connection.token));
    running.send(json!({"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{}},"jsonrpc":"2.0","id":0}));
    let answer = running.receive();
    assert_eq!(answer["id"], 0);
    assert_eq!(answer["result"]["protocolVersion"], "2025-11-25");
    running.send(json!({"method":"notifications/initialized","jsonrpc":"2.0"}));
    running.send(json!({"method":"tools/list","jsonrpc":"2.0","id":1}));
    let list = running.receive();
    assert_eq!(
        list["result"],
        crate::contracts::mcp::tools_list(crate::contracts::mcp::Revision::V2025_11_25, &crate::project_api::agent_grant())
    );
    running.close_stdin();
    let (code, errors) = running.finish();
    assert_eq!(code, EXIT_STDIN_CLOSED, "{errors}");
    assert!(errors.is_empty(), "a normal close says nothing: {errors}");
}

#[test]
fn it_exits_when_its_session_ends() {
    let (service, _open) = service();
    let connection = service.start_session("ws-1", Grant::default()).unwrap();
    let mut running = run_helper(Some(connection.endpoint), Some(connection.token));
    running.send(json!({"jsonrpc":"2.0","id":"p","method":"ping"}));
    assert_eq!(running.receive()["id"], "p");
    assert!(service.end_session(&connection.session_id));
    let (code, errors) = running.finish();
    assert_eq!(code, EXIT_LITRIA_CLOSED);
    assert!(errors.contains("closed the connection"), "{errors}");
}

#[test]
fn it_exits_when_the_project_closes() {
    let (service, open) = service();
    let connection = service.start_session("ws-1", Grant::default()).unwrap();
    let mut running = run_helper(Some(connection.endpoint), Some(connection.token));
    running.send(json!({"jsonrpc":"2.0","id":"p","method":"ping"}));
    assert_eq!(running.receive()["id"], "p");
    open.store(0, std::sync::atomic::Ordering::SeqCst);
    let (code, _errors) = running.finish();
    assert_eq!(code, EXIT_LITRIA_CLOSED);
}
