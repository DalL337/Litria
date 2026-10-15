//! The MCP helper as a real process (track T, slice T1a): the built binary,
//! `litria --mcp-helper`, started the way an agent starts a stdio MCP server,
//! against a real MCP service running in this test process.
//!
//! Debug builds only: the service comes from the hidden `mcp_test_support`.

#![cfg(debug_assertions)]

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use litria_lib::mcp_test_support;
use serde_json::{json, Value};

const HELPER: &str = env!("CARGO_BIN_EXE_litria");
const WAIT: Duration = Duration::from_secs(10);

struct Helper {
    child: Child,
    lines: mpsc::Receiver<String>,
}

fn spawn(endpoint: Option<&str>, token: Option<&str>) -> Helper {
    let mut command = Command::new(HELPER);
    command
        .arg("--mcp-helper")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("LITRIA_MCP_ENDPOINT")
        .env_remove("LITRIA_MCP_TOKEN");
    if let Some(endpoint) = endpoint {
        command.env("LITRIA_MCP_ENDPOINT", endpoint);
    }
    if let Some(token) = token {
        command.env("LITRIA_MCP_TOKEN", token);
    }
    let mut child = command.spawn().expect("the helper starts");
    let stdout: ChildStdout = child.stdout.take().unwrap();
    let (sender, lines) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    Helper { child, lines }
}

impl Helper {
    fn send(&mut self, message: Value) {
        let stdin = self.child.stdin.as_mut().expect("stdin open");
        writeln!(stdin, "{message}").unwrap();
        stdin.flush().unwrap();
    }

    fn receive(&self) -> Value {
        let line = self.lines.recv_timeout(WAIT).expect("a line from the helper");
        serde_json::from_str(&line).unwrap_or_else(|_| panic!("stdout carries only MCP: {line}"))
    }

    fn close_stdin(&mut self) {
        drop(self.child.stdin.take());
    }

    /// Wait for the process to exit; it must, within `limit`.
    fn exit_within(&mut self, limit: Duration) -> (ExitStatus, String) {
        let deadline = Instant::now() + limit;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                let mut errors = String::new();
                if let Some(mut stderr) = self.child.stderr.take() {
                    let _ = stderr.read_to_string(&mut errors);
                }
                return (status, errors);
            }
            if Instant::now() > deadline {
                let _ = self.child.kill();
                panic!("the helper outlived {limit:?}");
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn initialize(helper: &mut Helper) -> Value {
    helper.send(json!({"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{}},"jsonrpc":"2.0","id":0}));
    helper.receive()
}

#[test]
fn started_by_hand_it_explains_and_exits() {
    let mut helper = spawn(None, None);
    let (status, errors) = helper.exit_within(WAIT);
    assert_eq!(status.code(), Some(2));
    assert!(errors.contains("no Litria session"), "{errors}");
    assert!(helper.lines.recv_timeout(Duration::from_millis(500)).is_err(), "nothing on stdout");
}

/// The handshake both installed agents perform, through the real binary.
#[test]
fn an_agent_can_initialize_and_list_tools_then_close() {
    let app = mcp_test_support::start();
    let (endpoint, token, _session) = app.start_session();
    let started = Instant::now();
    let mut helper = spawn(Some(&endpoint), Some(&token));
    let answer = initialize(&mut helper);
    let first_answer = started.elapsed();
    assert_eq!(answer["id"], 0);
    assert_eq!(answer["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(answer["result"]["serverInfo"]["name"], "litria");
    helper.send(json!({"method":"notifications/initialized","jsonrpc":"2.0"}));
    helper.send(json!({"method":"tools/list","jsonrpc":"2.0","id":1}));
    let list = helper.receive();
    let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"litria_files_read") && names.contains(&"litria_changes_apply"), "{names:?}");
    // The agent closes stdin: the helper exits at once, cleanly and quietly.
    helper.close_stdin();
    let (status, errors) = helper.exit_within(Duration::from_secs(3));
    assert_eq!(status.code(), Some(0), "{errors}");
    assert!(errors.is_empty(), "{errors}");
    eprintln!("[evidence] helper start to first answer: {first_answer:?}");
}

#[test]
fn a_wrong_token_is_refused_and_the_helper_exits() {
    let app = mcp_test_support::start();
    let (endpoint, token, _session) = app.start_session();
    let wrong = "0".repeat(64);
    let mut helper = spawn(Some(&endpoint), Some(&wrong));
    let (status, errors) = helper.exit_within(WAIT);
    assert_eq!(status.code(), Some(4));
    assert!(errors.contains("refused"), "{errors}");
    assert!(!errors.contains(&wrong) && !errors.contains(&token), "no token in the log");
}

#[test]
fn ending_the_session_ends_the_helper() {
    let app = mcp_test_support::start();
    let (endpoint, token, session) = app.start_session();
    let mut helper = spawn(Some(&endpoint), Some(&token));
    assert_eq!(initialize(&mut helper)["id"], 0);
    assert!(app.end_session(&session));
    let (status, errors) = helper.exit_within(Duration::from_secs(3));
    assert_eq!(status.code(), Some(5), "{errors}");
}

#[test]
fn closing_the_project_ends_the_helper() {
    let app = mcp_test_support::start();
    let (endpoint, token, _session) = app.start_session();
    let mut helper = spawn(Some(&endpoint), Some(&token));
    assert_eq!(initialize(&mut helper)["id"], 0);
    app.close_project();
    let (status, _errors) = helper.exit_within(Duration::from_secs(5));
    assert_eq!(status.code(), Some(5));
}

#[test]
fn litria_quitting_ends_the_helper() {
    let app = mcp_test_support::start();
    let (endpoint, token, _session) = app.start_session();
    let mut helper = spawn(Some(&endpoint), Some(&token));
    assert_eq!(initialize(&mut helper)["id"], 0);
    app.quit();
    let (status, _errors) = helper.exit_within(Duration::from_secs(3));
    assert_eq!(status.code(), Some(5));
}

/// Litria's process going away without a word (a crash): the helper sees the
/// channel break and exits. Run as a separate process so it can die.
#[test]
fn the_app_dying_ends_the_helper() {
    let mut fake_app = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "fake_app_process", "--ignored", "--nocapture"])
        .env("LITRIA_FAKE_APP", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut out = BufReader::new(fake_app.stdout.take().unwrap());
    let mut connection = String::new();
    let deadline = Instant::now() + WAIT;
    while !connection.starts_with("CONNECTION\t") {
        connection.clear();
        assert!(Instant::now() < deadline, "the fake app never reported its endpoint");
        out.read_line(&mut connection).unwrap();
    }
    let parts: Vec<&str> = connection.trim_end().splitn(3, '\t').collect();
    let mut helper = spawn(Some(parts[1]), Some(parts[2]));
    assert_eq!(initialize(&mut helper)["id"], 0);
    fake_app.kill().unwrap();
    let _ = fake_app.wait();
    let (status, _errors) = helper.exit_within(Duration::from_secs(3));
    assert_eq!(status.code(), Some(5));
}

/// The process `the_app_dying_ends_the_helper` kills: serves until killed.
#[test]
#[ignore = "run only as the child of the_app_dying_ends_the_helper"]
fn fake_app_process() {
    if std::env::var_os("LITRIA_FAKE_APP").is_none() {
        return;
    }
    let app = mcp_test_support::start();
    let (endpoint, token, _session) = app.start_session();
    println!("CONNECTION\t{endpoint}\t{token}");
    std::io::stdout().flush().unwrap();
    thread::sleep(Duration::from_secs(60));
}
