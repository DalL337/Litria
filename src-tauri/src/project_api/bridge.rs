//! The bridge client (Project API contract brief §4.3, §8): Rust asks the
//! frontend's live owners for state and waits for a typed, bounded answer.
//!
//! Lifecycle:
//! - The frontend's bridge becomes READY only after hydration for its project
//!   instance finishes, then attaches for that instance's epoch
//!   (`project_api_bridge_attach`) and receives a generation. Rust sends a
//!   request only to a bridge attached for the request's epoch; otherwise the
//!   call returns `ownerUnavailable`.
//! - A new attach or a detach ends the previous generation. Its pending
//!   requests fail at once with `ownerUnavailable` (their listener is gone or
//!   superseded, so no reply could ever be accepted), and any later reply that
//!   carries the old generation is dropped.
//!
//! Every request carries its id, epoch and generation. Replies arrive through
//! an asynchronous command that never waits: it matches the pending entry and
//! hands the raw text to the waiting thread with a non-blocking send. The
//! waiting thread applies the reply boundary (ceiling, strict serde,
//! validation). No lock is held while waiting, and the database lock is never
//! taken here at all.

use std::collections::HashMap;
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use crate::contracts::boundary::accept_within;
use crate::contracts::error::{ContractError, ErrorCode};
use crate::contracts::project_api_bridge::{
    BridgeErrorCode, BridgeOperation, BridgeReply, BridgeRequestEvent, MAX_REPLY_BYTES,
};

/// Requests waiting for a reply, across all callers (brief §10). Beyond it,
/// a request fails fast with `busy` instead of queueing without bound.
pub(crate) const MAX_PENDING: usize = 32;
/// How long one request waits for its reply (brief §10).
pub(crate) const DEADLINE: Duration = Duration::from_secs(2);

/// Delivers a request event to the frontend. `false` means it could not be
/// sent (no window), which the caller answers as `ownerUnavailable`.
pub(crate) trait Emit: Send + Sync {
    fn emit(&self, event: &BridgeRequestEvent) -> bool;
}

/// What the reply command did with a reply. Dropped replies are counted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Disposition {
    Delivered,
    /// No pending request has that id: late (timed out or already answered),
    /// duplicate, or never issued.
    DroppedUnknown,
    /// The reply came from a generation other than the one the request was
    /// addressed to.
    DroppedStaleGeneration,
}

/// Counters for dropped replies (tests and diagnostics).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Dropped {
    pub unknown: u64,
    pub stale_generation: u64,
}

type Delivery = Result<String, ContractError>;

struct Pending {
    generation: String,
    reply: SyncSender<Delivery>,
}

struct Attachment {
    epoch: String,
    generation: String,
}

#[derive(Default)]
struct State {
    attachment: Option<Attachment>,
    next_generation: u64,
    next_request: u64,
    pending: HashMap<String, Pending>,
    dropped: Dropped,
}

pub(crate) struct Bridge {
    state: Mutex<State>,
    emitter: Mutex<Option<Arc<dyn Emit>>>,
    deadline: Duration,
}

/// The application's bridge. Its emitter is installed at startup (debug
/// builds, until track T's transport gives the bridge a release consumer).
pub(crate) fn global() -> &'static Bridge {
    static BRIDGE: OnceLock<Bridge> = OnceLock::new();
    BRIDGE.get_or_init(|| Bridge::new(DEADLINE))
}

fn unavailable() -> ContractError {
    ContractError::new(
        ErrorCode::OwnerUnavailable,
        "the editor is not connected for this workspace; it connects once the project has finished loading",
    )
}

impl Bridge {
    pub(crate) fn new(deadline: Duration) -> Self {
        Self {
            state: Mutex::new(State::default()),
            emitter: Mutex::new(None),
            deadline,
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn install_emitter(&self, emitter: Arc<dyn Emit>) {
        *self.emitter.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(emitter);
    }

    /// Attach the frontend bridge for `epoch`, which must be the workspace
    /// open now (`current`). Returns the new generation; the previous one, if
    /// any, ends here.
    pub(crate) fn attach(&self, epoch: &str, current: Option<&str>) -> Result<String, ContractError> {
        match current {
            None => {
                return Err(ContractError::new(ErrorCode::NotReady, "no project workspace is open"));
            }
            Some(current) if current != epoch => {
                return Err(ContractError::new(
                    ErrorCode::WorkspaceChanged,
                    "the open project changed before the editor connected",
                ));
            }
            Some(_) => {}
        }
        let mut state = self.state();
        state.next_generation += 1;
        let generation = format!("g{}", state.next_generation);
        // Every pending request was addressed to the superseded listener and
        // can never be answered: dropping its sender fails it now.
        state.pending.clear();
        state.attachment = Some(Attachment {
            epoch: epoch.to_owned(),
            generation: generation.clone(),
        });
        Ok(generation)
    }

    /// End `generation`. A stale detach — one for a generation that is no
    /// longer current — changes nothing, so an out-of-order cleanup cannot
    /// detach a newer listener. Returns whether it detached.
    pub(crate) fn detach(&self, generation: &str) -> bool {
        let mut state = self.state();
        if state
            .attachment
            .as_ref()
            .is_some_and(|attachment| attachment.generation == generation)
        {
            state.attachment = None;
            state.pending.clear();
            true
        } else {
            false
        }
    }

    /// Ask the owner for `O`'s answer about the workspace `epoch`.
    pub(crate) fn call<O: BridgeOperation>(&self, epoch: &str, request: &O::Request) -> Result<O::Result, ContractError> {
        let emitter = self
            .emitter
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(unavailable)?;
        let payload = serde_json::to_value(request)
            .map_err(|_| ContractError::new(ErrorCode::Internal, "the bridge request could not be encoded"))?;
        let (sender, receiver) = sync_channel::<Delivery>(1);
        let event = {
            let mut state = self.state();
            let generation = match &state.attachment {
                Some(attachment) if attachment.epoch == epoch => attachment.generation.clone(),
                _ => return Err(unavailable()),
            };
            if state.pending.len() >= MAX_PENDING {
                return Err(ContractError::new(
                    ErrorCode::Busy,
                    "too many requests are waiting for the editor; retry shortly",
                ));
            }
            state.next_request += 1;
            let request_id = format!("r{}", state.next_request);
            state.pending.insert(
                request_id.clone(),
                Pending {
                    generation: generation.clone(),
                    reply: sender,
                },
            );
            BridgeRequestEvent {
                request_id,
                epoch: epoch.to_owned(),
                generation,
                op: O::NAME.to_owned(),
                request: payload,
            }
        };
        if !emitter.emit(&event) {
            self.state().pending.remove(&event.request_id);
            return Err(unavailable());
        }
        let delivery = match receiver.recv_timeout(self.deadline) {
            Ok(delivery) => delivery,
            Err(RecvTimeoutError::Timeout) => {
                // Withdraw the request; a reply delivered in the same instant
                // is already in the channel and still counts.
                self.state().pending.remove(&event.request_id);
                match receiver.try_recv() {
                    Ok(delivery) => delivery,
                    Err(_) => {
                        return Err(ContractError::new(
                            ErrorCode::OwnerTimeout,
                            "the editor did not answer in time",
                        ))
                    }
                }
            }
            // The generation ended (re-attach or detach) while waiting.
            Err(RecvTimeoutError::Disconnected) => return Err(unavailable()),
        };
        let raw = delivery?;
        match accept_within::<BridgeReply<O::Result>>(raw.as_bytes(), MAX_REPLY_BYTES) {
            Ok(BridgeReply::Result { result }) => Ok(result),
            Ok(BridgeReply::Error {
                code: BridgeErrorCode::WorkspaceChanged,
                ..
            }) => Err(ContractError::new(
                ErrorCode::WorkspaceChanged,
                "the open project changed while the editor was answering",
            )),
            // The owner's own message is not forwarded: it is free text from
            // the webview and could name a path.
            Ok(BridgeReply::Error { .. }) => Err(ContractError::new(
                ErrorCode::Internal,
                "the editor could not answer the request",
            )),
            Err(_) => Err(malformed()),
        }
    }

    /// The reply command's work: never waits, never parses. The ceiling is
    /// checked first, so an oversized reply fails its request at once without
    /// being read.
    pub(crate) fn deliver_reply(&self, request_id: &str, generation: &str, reply: String) -> Disposition {
        let delivery = if reply.len() > MAX_REPLY_BYTES {
            Err(ContractError::new(
                ErrorCode::Internal,
                "the editor's reply exceeded the bridge reply ceiling",
            ))
        } else {
            Ok(reply)
        };
        let pending = {
            let mut state = self.state();
            match state.pending.get(request_id) {
                None => {
                    state.dropped.unknown += 1;
                    return Disposition::DroppedUnknown;
                }
                Some(pending) if pending.generation != generation => {
                    state.dropped.stale_generation += 1;
                    return Disposition::DroppedStaleGeneration;
                }
                Some(_) => state.pending.remove(request_id).expect("present under the same lock"),
            }
        };
        // Capacity 1 and exactly one send per pending entry: never blocks. If
        // the waiter has already gone, the reply is simply discarded.
        let _ = pending.reply.try_send(delivery);
        Disposition::Delivered
    }

    #[cfg(test)]
    pub(crate) fn dropped(&self) -> Dropped {
        self.state().dropped
    }

    #[cfg(test)]
    pub(crate) fn pending_count(&self) -> usize {
        self.state().pending.len()
    }
}

/// A reply that failed the boundary. The caller learns only that the owner
/// misbehaved, never the parse details (they would quote the reply).
pub(crate) fn malformed() -> ContractError {
    ContractError::new(ErrorCode::Internal, "the editor's reply did not match the bridge contract")
}

#[cfg(test)]
pub(crate) mod testing {
    //! A scripted frontend for bridge tests: every emitted request is handed
    //! to a closure on its own thread, which may reply (or not) through the
    //! same `deliver_reply` path the command uses.

    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::{Arc, Mutex};

    use super::{Bridge, Emit};
    use crate::contracts::project_api_bridge::BridgeRequestEvent;

    pub(crate) struct Recorder {
        sent: Mutex<Sender<BridgeRequestEvent>>,
    }

    impl Emit for Recorder {
        fn emit(&self, event: &BridgeRequestEvent) -> bool {
            self.sent.lock().unwrap().send(event.clone()).is_ok()
        }
    }

    /// Installs an emitter that records events; the test answers them.
    pub(crate) fn recording(bridge: &Bridge) -> Receiver<BridgeRequestEvent> {
        let (sender, receiver) = channel();
        bridge.install_emitter(Arc::new(Recorder {
            sent: Mutex::new(sender),
        }));
        receiver
    }

    /// Installs an emitter that answers every request with `answer(event)`,
    /// delivered from another thread. `None` means no reply at all.
    pub(crate) fn answering(
        bridge: &'static Bridge,
        answer: impl Fn(&BridgeRequestEvent) -> Option<String> + Send + Sync + 'static,
    ) {
        struct Answering<F> {
            bridge: &'static Bridge,
            answer: Arc<F>,
        }
        impl<F: Fn(&BridgeRequestEvent) -> Option<String> + Send + Sync + 'static> Emit for Answering<F> {
            fn emit(&self, event: &BridgeRequestEvent) -> bool {
                let event = event.clone();
                let answer = Arc::clone(&self.answer);
                let bridge = self.bridge;
                std::thread::spawn(move || {
                    if let Some(reply) = answer(&event) {
                        bridge.deliver_reply(&event.request_id, &event.generation, reply);
                    }
                });
                true
            }
        }
        bridge.install_emitter(Arc::new(Answering {
            bridge,
            answer: Arc::new(answer),
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{answering, recording};
    use super::*;
    use crate::contracts::project_api_bridge::editor::{
        BufferIndexOp, BufferIndexRequest, DocumentEntry, DocumentQuery, DocumentsOp, DocumentsRequest,
    };
    use std::time::Instant;

    fn leaked(deadline: Duration) -> &'static Bridge {
        Box::leak(Box::new(Bridge::new(deadline)))
    }

    fn documents_request(path: &str) -> DocumentsRequest {
        DocumentsRequest {
            documents: vec![DocumentQuery {
                path: path.into(),
                start_line: None,
                end_line: None,
                max_bytes: 1024,
            }],
            max_text_bytes: 1024,
        }
    }

    fn not_buffered(path: &str) -> String {
        format!(r#"{{"kind":"result","result":{{"documents":[{{"kind":"notBuffered","path":"{path}","state":"none"}}]}}}}"#)
    }

    #[test]
    fn no_attachment_is_owner_unavailable() {
        let bridge = leaked(DEADLINE);
        let _events = recording(bridge);
        let error = bridge.call::<DocumentsOp>("ws-1", &documents_request("a.txt")).unwrap_err();
        assert_eq!(error.code, ErrorCode::OwnerUnavailable);
    }

    #[test]
    fn no_emitter_is_owner_unavailable() {
        let bridge = leaked(DEADLINE);
        bridge.attach("ws-1", Some("ws-1")).unwrap();
        let error = bridge.call::<DocumentsOp>("ws-1", &documents_request("a.txt")).unwrap_err();
        assert_eq!(error.code, ErrorCode::OwnerUnavailable);
    }

    /// A bridge attached for another workspace is not asked.
    #[test]
    fn an_attachment_for_another_epoch_is_owner_unavailable() {
        let bridge = leaked(DEADLINE);
        let events = recording(bridge);
        bridge.attach("ws-a", Some("ws-a")).unwrap();
        let error = bridge.call::<DocumentsOp>("ws-b", &documents_request("a.txt")).unwrap_err();
        assert_eq!(error.code, ErrorCode::OwnerUnavailable);
        assert!(events.try_recv().is_err(), "nothing was emitted");
    }

    #[test]
    fn attach_requires_the_current_workspace() {
        let bridge = leaked(DEADLINE);
        assert_eq!(bridge.attach("ws-a", None).unwrap_err().code, ErrorCode::NotReady);
        assert_eq!(
            bridge.attach("ws-a", Some("ws-b")).unwrap_err().code,
            ErrorCode::WorkspaceChanged
        );
        let first = bridge.attach("ws-b", Some("ws-b")).unwrap();
        let second = bridge.attach("ws-b", Some("ws-b")).unwrap();
        assert_ne!(first, second, "every attach mints a new generation");
    }

    #[test]
    fn a_reply_round_trips_through_the_boundary() {
        let bridge = leaked(DEADLINE);
        bridge.attach("ws-1", Some("ws-1")).unwrap();
        answering(bridge, |event| {
            assert_eq!(event.op, "editor.documents");
            assert_eq!(event.epoch, "ws-1");
            assert_eq!(event.request["documents"][0]["path"], "a.txt");
            Some(not_buffered("a.txt"))
        });
        let result = bridge.call::<DocumentsOp>("ws-1", &documents_request("a.txt")).unwrap();
        assert!(matches!(&result.documents[0], DocumentEntry::NotBuffered { path, .. } if path == "a.txt"));
        assert_eq!(bridge.pending_count(), 0);
    }

    #[test]
    fn a_deadline_expiry_is_owner_timeout() {
        let bridge = leaked(Duration::from_millis(50));
        bridge.attach("ws-1", Some("ws-1")).unwrap();
        let events = recording(bridge);
        let error = bridge.call::<DocumentsOp>("ws-1", &documents_request("a.txt")).unwrap_err();
        assert_eq!(error.code, ErrorCode::OwnerTimeout);
        assert_eq!(bridge.pending_count(), 0, "a timed-out request is withdrawn");
        // Its reply, arriving late, is dropped and counted.
        let event = events.try_recv().unwrap();
        let disposition = bridge.deliver_reply(&event.request_id, &event.generation, not_buffered("a.txt"));
        assert_eq!(disposition, Disposition::DroppedUnknown);
        assert_eq!(bridge.dropped().unknown, 1);
    }

    #[test]
    fn duplicate_and_unknown_replies_are_dropped_and_counted() {
        let bridge = leaked(DEADLINE);
        bridge.attach("ws-1", Some("ws-1")).unwrap();
        let events = recording(bridge);
        let waiter = std::thread::spawn(move || bridge.call::<DocumentsOp>("ws-1", &documents_request("a.txt")));
        let event = events.recv().unwrap();
        let reply = not_buffered("a.txt");
        assert_eq!(
            bridge.deliver_reply(&event.request_id, &event.generation, reply.clone()),
            Disposition::Delivered
        );
        assert_eq!(
            bridge.deliver_reply(&event.request_id, &event.generation, reply.clone()),
            Disposition::DroppedUnknown
        );
        assert_eq!(bridge.deliver_reply("r-never", &event.generation, reply), Disposition::DroppedUnknown);
        assert!(waiter.join().unwrap().is_ok());
        assert_eq!(bridge.dropped().unknown, 2);
    }

    /// The webview-reload case: a listener from an old generation cannot
    /// answer a request addressed to the new one.
    #[test]
    fn a_reply_from_a_stale_generation_is_refused() {
        let bridge = leaked(Duration::from_millis(200));
        let old = bridge.attach("ws-1", Some("ws-1")).unwrap();
        let current = bridge.attach("ws-1", Some("ws-1")).unwrap();
        let events = recording(bridge);
        let waiter = std::thread::spawn(move || bridge.call::<DocumentsOp>("ws-1", &documents_request("a.txt")));
        let event = events.recv().unwrap();
        assert_eq!(event.generation, current);
        assert_eq!(
            bridge.deliver_reply(&event.request_id, &old, not_buffered("a.txt")),
            Disposition::DroppedStaleGeneration
        );
        assert_eq!(bridge.dropped().stale_generation, 1);
        // The request is still waiting for its own listener, which answers.
        assert_eq!(
            bridge.deliver_reply(&event.request_id, &current, not_buffered("a.txt")),
            Disposition::Delivered
        );
        assert!(waiter.join().unwrap().is_ok());
    }

    /// Re-attaching (for another workspace or after a reload) ends the old
    /// generation: its pending requests fail at once instead of timing out,
    /// and their late replies are refused.
    #[test]
    fn a_new_attachment_fails_the_old_generations_requests() {
        let bridge = leaked(Duration::from_secs(30));
        bridge.attach("ws-a", Some("ws-a")).unwrap();
        let events = recording(bridge);
        let started = Instant::now();
        let waiter = std::thread::spawn(move || bridge.call::<DocumentsOp>("ws-a", &documents_request("a.txt")));
        let event = events.recv().unwrap();
        bridge.attach("ws-b", Some("ws-b")).unwrap();
        let error = waiter.join().unwrap().unwrap_err();
        assert_eq!(error.code, ErrorCode::OwnerUnavailable);
        assert!(started.elapsed() < Duration::from_secs(10), "failed fast, not by deadline");
        assert_eq!(
            bridge.deliver_reply(&event.request_id, &event.generation, not_buffered("a.txt")),
            Disposition::DroppedUnknown
        );
    }

    #[test]
    fn a_stale_detach_leaves_the_current_listener_attached() {
        let bridge = leaked(DEADLINE);
        let old = bridge.attach("ws-1", Some("ws-1")).unwrap();
        let current = bridge.attach("ws-1", Some("ws-1")).unwrap();
        assert!(!bridge.detach(&old));
        // Still attached: the call is emitted and answered.
        answering(bridge, |_| Some(not_buffered("a.txt")));
        assert!(bridge.call::<DocumentsOp>("ws-1", &documents_request("a.txt")).is_ok());
        assert!(bridge.detach(&current));
        assert_eq!(
            bridge.call::<DocumentsOp>("ws-1", &documents_request("a.txt")).unwrap_err().code,
            ErrorCode::OwnerUnavailable
        );
    }

    /// The 33rd waiting request is refused with `busy`.
    #[test]
    fn the_pending_ceiling_returns_busy() {
        let bridge = leaked(Duration::from_secs(30));
        bridge.attach("ws-1", Some("ws-1")).unwrap();
        let events = recording(bridge);
        let waiters: Vec<_> = (0..MAX_PENDING)
            .map(|_| std::thread::spawn(move || bridge.call::<DocumentsOp>("ws-1", &documents_request("a.txt"))))
            .collect();
        let emitted: Vec<_> = (0..MAX_PENDING).map(|_| events.recv().unwrap()).collect();
        assert_eq!(bridge.pending_count(), MAX_PENDING);
        let error = bridge.call::<DocumentsOp>("ws-1", &documents_request("a.txt")).unwrap_err();
        assert_eq!(error.code, ErrorCode::Busy);
        for event in emitted {
            bridge.deliver_reply(&event.request_id, &event.generation, not_buffered("a.txt"));
        }
        for waiter in waiters {
            assert!(waiter.join().unwrap().is_ok());
        }
    }

    /// The reply command hands off without waiting. Here the reply is
    /// delivered INSIDE the emit, on the calling thread itself, before that
    /// thread starts to wait: a delivery that waited for its receiver would
    /// deadlock, which the outer timeout turns into a failure.
    #[test]
    fn delivery_never_waits_for_the_receiver() {
        struct ReplyWhileEmitting(&'static Bridge);
        impl Emit for ReplyWhileEmitting {
            fn emit(&self, event: &BridgeRequestEvent) -> bool {
                let disposition = self
                    .0
                    .deliver_reply(&event.request_id, &event.generation, not_buffered("a.txt"));
                assert_eq!(disposition, Disposition::Delivered);
                true
            }
        }
        let bridge = leaked(DEADLINE);
        bridge.attach("ws-1", Some("ws-1")).unwrap();
        bridge.install_emitter(Arc::new(ReplyWhileEmitting(bridge)));
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(bridge.call::<DocumentsOp>("ws-1", &documents_request("a.txt")));
        });
        let result = finished
            .recv_timeout(Duration::from_secs(5))
            .expect("a delivery made before the caller waited must not block it");
        assert!(result.is_ok());
    }

    /// The ceiling is checked before parsing: an oversized reply fails its
    /// request with `internal`, whatever it contains.
    #[test]
    fn an_over_ceiling_reply_is_rejected_before_parsing() {
        let bridge = leaked(DEADLINE);
        bridge.attach("ws-1", Some("ws-1")).unwrap();
        answering(bridge, |_| Some("x".repeat(MAX_REPLY_BYTES + 1)));
        let error = bridge.call::<DocumentsOp>("ws-1", &documents_request("a.txt")).unwrap_err();
        assert_eq!(error.code, ErrorCode::Internal);
        assert!(error.message.contains("ceiling"), "{}", error.message);
    }

    #[test]
    fn a_malformed_reply_is_internal_and_not_quoted() {
        let bridge = leaked(DEADLINE);
        bridge.attach("ws-1", Some("ws-1")).unwrap();
        answering(bridge, |_| {
            Some(r#"{"kind":"result","result":{"documents":[{"kind":"notBuffered","path":"a.txt","state":"none","sneakyField":1}]}}"#.into())
        });
        let error = bridge.call::<DocumentsOp>("ws-1", &documents_request("a.txt")).unwrap_err();
        assert_eq!(error.code, ErrorCode::Internal);
        assert!(!error.message.contains("sneakyField"), "{}", error.message);
    }

    #[test]
    fn owner_errors_map_without_forwarding_their_text() {
        let bridge = leaked(DEADLINE);
        bridge.attach("ws-1", Some("ws-1")).unwrap();
        answering(bridge, |event| {
            let code = if event.request["documents"][0]["path"] == "changed.txt" {
                "workspaceChanged"
            } else {
                "internal"
            };
            Some(format!(r#"{{"kind":"error","code":"{code}","message":"C:/Users/alice/secret.txt"}}"#))
        });
        let changed = bridge.call::<DocumentsOp>("ws-1", &documents_request("changed.txt")).unwrap_err();
        assert_eq!(changed.code, ErrorCode::WorkspaceChanged);
        let failed = bridge.call::<DocumentsOp>("ws-1", &documents_request("a.txt")).unwrap_err();
        assert_eq!(failed.code, ErrorCode::Internal);
        for error in [changed, failed] {
            assert!(!error.message.contains("alice"), "{}", error.message);
        }
    }

    #[test]
    fn the_buffer_index_round_trips() {
        let bridge = leaked(DEADLINE);
        bridge.attach("ws-1", Some("ws-1")).unwrap();
        answering(bridge, |event| {
            assert_eq!(event.op, "editor.bufferIndex");
            assert_eq!(event.request["maxEntries"], 500);
            Some(
                r#"{"kind":"result","result":{"entries":[{"path":"a.txt","state":"closedDirty","dirty":true,"revision":"b1-x","byteLength":3}],"omitted":2}}"#
                    .into(),
            )
        });
        let index = bridge
            .call::<BufferIndexOp>("ws-1", &BufferIndexRequest { max_entries: 500 })
            .unwrap();
        assert_eq!(index.entries.len(), 1);
        assert_eq!(index.omitted, 2);
    }
}
