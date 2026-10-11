//! Agent-proposed changes (Project API build plan W2, W3b, W3c; contract brief
//! §13). W2a: proposing — `litria_changes_prepare`. W2b: applying —
//! `litria_changes_apply` — and the review seam. W3b: new files. W3c: edits
//! to documents the editor does not hold, planned on the disk text the agent
//! read and opened into the session unsaved, in a background tab (owner
//! ruling, 2026-10-11).
//!
//! A proposal's edits are checked against the editor's latest text (the
//! bridge's `editor.checkChanges`, W1's planning), its new files' names
//! against the disk, after the disclosure policy (so a withheld path answers
//! `denied`, never `exists`). Only when every change is ready does it become
//! a plan: immutable (its canonical changes and their hash), bound to the
//! requester and the workspace epoch, and expiring ten minutes after
//! preparation if it is not applied. Plans live in memory (durable operations
//! are W4).
//!
//! Applying runs in a fixed order: every new file's name is checked again
//! (one taken means nothing lands); the edits apply all or none; then the
//! files are created through the frontend's filesystem write manager
//! (`files.create`), each only if nothing has its name, and shown on the
//! canvas. A disk change and a buffer change never happen together, so a
//! plan can end `partial`; every change reports its own outcome.
//!
//! Who must agree (owner rulings, 2026-10-11): the agent's own approval is
//! enough — its client already asked the person, and Litria never stacks a
//! second prompt on it or restricts the agent — so `litria_changes_apply`
//! applies a `prepared` plan. Litria's own review (`ReviewPolicy::PersonReview`,
//! plans start `pendingReview`) stays behind the review seam, off until track
//! T gives it a surface. Either way a plan is claimed atomically — to
//! `applying`, so it executes at most once — and applied through the
//! editor's `editor.applyChanges`, all or none. An outcome Litria cannot be
//! sure of is recorded as `needsReview` and never retried (R5).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use rand::Rng;
use sha2::{Digest, Sha256};

use super::bridge::{self, Bridge, CallFailure};
use super::reader::{disk_revision, identity, read_disk, DiskRead, Identity};
use super::workspace;
use crate::contracts::boundary::invalid;
use crate::contracts::context::{CallContext, Principal};
use crate::contracts::error::{ContractError, ErrorCode};
use crate::contracts::project_api::changes_apply::{ChangeOutcome, ChangesApplyRequest, ChangesApplyResult, Effect};
use crate::contracts::project_api::changes_prepare::{
    ChangeCheck, ChangesPrepareRequest, ChangesPrepareResult, PlanState, PreparedPlan, ProposedChange,
    MAX_OPEN_FILE_BYTES, PLAN_ID_LENGTH, PLAN_TTL_SECONDS,
};
use crate::contracts::project_api_bridge::canvas::{ShowFilesOp, ShowFilesRequest, ShownFile};
use crate::contracts::project_api_bridge::editor::{
    ApplyChangesOp, ApplyEntry, ChangeToCheck, CheckChangesOp, CheckChangesRequest, CheckedChange, EditToCheck,
    FileToOpen,
};
use crate::contracts::project_api_bridge::files::{CreateFilesOp, CreateFilesRequest, CreatedFile, FileToCreate};
use crate::db;

/// Plans one requester may have waiting (prepared or pending review) at once.
/// More are refused, never made room for by expiring older ones early.
pub(crate) const MAX_PENDING_PER_PRINCIPAL: usize = 16;
const PLAN_TTL: Duration = Duration::from_secs(PLAN_TTL_SECONDS as u64);
/// How long an expired plan is remembered, so it can still be answered as
/// expired (W2b) before it is forgotten.
const EXPIRED_RETENTION: Duration = Duration::from_secs(60 * 60);

pub(crate) fn handle(context: &CallContext, request: ChangesPrepareRequest) -> Result<ChangesPrepareResult, ContractError> {
    handle_with(context, request, bridge::global(), plans(), Instant::now(), db::workspace_read_only)
}

pub(crate) fn handle_with(
    context: &CallContext,
    request: ChangesPrepareRequest,
    bridge: &Bridge,
    store: &Mutex<PlanStore>,
    now: Instant,
    read_only: impl Fn() -> Option<bool>,
) -> Result<ChangesPrepareResult, ContractError> {
    workspace::fenced(context, |root| {
        if read_only() == Some(true) {
            return Err(ContractError::new(
                ErrorCode::NotReady,
                "the project opened read-only (safety mode), so agent edits are off",
            ));
        }
        prepare(root, context, &request, bridge, store, now)
    })
}

fn prepare(
    root: &Path,
    context: &CallContext,
    request: &ChangesPrepareRequest,
    bridge: &Bridge,
    store: &Mutex<PlanStore>,
    now: Instant,
) -> Result<ChangesPrepareResult, ContractError> {
    // Paths first, exactly as reads judge them: a denied or invalid path never
    // reaches the editor, is never written, and is never checked for
    // existence (so `exists` reveals nothing the policy withholds).
    let count = request.changes.len();
    let mut checks: Vec<Option<ChangeCheck>> = vec![None; count];
    let mut planned: Vec<Option<PlannedChange>> = vec![None; count];
    let mut to_check: Vec<(usize, ChangeToCheck)> = Vec::new();
    let mut documents = HashSet::new();
    for (index, change) in request.changes.iter().enumerate() {
        let path = change.path().to_string();
        match identity(root, change.path()) {
            Identity::InvalidPath => checks[index] = Some(ChangeCheck::InvalidPath { path }),
            Identity::Denied => checks[index] = Some(ChangeCheck::Denied { path }),
            Identity::Key(key) => {
                // Two spellings of one document would make one plan change it
                // twice.
                if !documents.insert(key.clone()) {
                    return Err(invalid(format!("changes: entry {index} names a document an earlier entry names")));
                }
                match change {
                    ProposedChange::TextEdit { expected_revision, edits, .. } => to_check.push((
                        index,
                        ChangeToCheck {
                            path: key,
                            expected_revision: expected_revision.clone(),
                            edits: edits
                                .iter()
                                .map(|edit| EditToCheck {
                                    old_text: edit.old_text.clone(),
                                    new_text: edit.new_text.clone(),
                                })
                                .collect(),
                        },
                    )),
                    ProposedChange::FileCreate { .. } if name_is_taken(root, &key) => {
                        checks[index] = Some(ChangeCheck::Exists { path });
                    }
                    ProposedChange::FileCreate { text, .. } => {
                        checks[index] = Some(ChangeCheck::Ready { path });
                        planned[index] = Some(PlannedChange::Create(FileToCreate { path: key, text: text.clone() }));
                    }
                }
            }
        }
    }

    if !to_check.is_empty() {
        let reply = bridge.call::<CheckChangesOp>(
            &context.epoch,
            &CheckChangesRequest {
                changes: to_check.iter().map(|(_, change)| change.clone()).collect(),
                opens: Vec::new(),
            },
        )?;
        // The reply answers exactly what was asked, in order; anything else is
        // a misbehaving bridge, never partial truth.
        if reply.changes.len() != to_check.len()
            || reply.changes.iter().zip(&to_check).any(|(got, (_, sent))| got.path() != sent.path)
        {
            return Err(bridge::malformed());
        }
        for (checked, (index, change)) in reply.changes.into_iter().zip(to_check) {
            let path = request.changes[index].path().to_string();
            let (check, plan) = match checked {
                CheckedChange::Ready { .. } => (ChangeCheck::Ready { path }, Some(PlannedChange::Edit(change))),
                CheckedChange::Conflict { revision, .. } => (ChangeCheck::Conflict { path, revision }, None),
                CheckedChange::NoMatch { edit, .. } => (ChangeCheck::NoMatch { path, edit }, None),
                CheckedChange::Ambiguous { edit, .. } => (ChangeCheck::Ambiguous { path, edit }, None),
                // Not held with text of its own: an edit to the file on disk,
                // as the agent read it (W3c).
                CheckedChange::NotInSession { .. } => judge_disk_edit(root, path, change),
            };
            checks[index] = Some(check);
            planned[index] = plan;
        }
    }

    let changes: Vec<ChangeCheck> = checks.into_iter().map(|check| check.expect("every change was judged")).collect();
    if !changes.iter().all(ChangeCheck::is_ready) {
        return Ok(ChangesPrepareResult { plan: None, changes });
    }
    let planned: Vec<PlannedChange> =
        planned.into_iter().map(|change| change.expect("every ready change was planned")).collect();
    let plan = store
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .propose(context.principal, &context.epoch, planned, now)?;
    Ok(ChangesPrepareResult {
        plan: Some(plan),
        changes,
    })
}

// ---------------------------------------------------------------------------
// litria_changes_apply: the outcome
// ---------------------------------------------------------------------------

pub(crate) fn handle_apply(context: &CallContext, request: ChangesApplyRequest) -> Result<ChangesApplyResult, ContractError> {
    handle_apply_with(context, request, bridge::global(), plans(), Instant::now())
}

/// Apply the requester's `prepared` plan (claimed atomically, so it runs at
/// most once), or report where the plan stands. A plan pending a person's
/// review is never applied here.
pub(crate) fn handle_apply_with(
    context: &CallContext,
    request: ChangesApplyRequest,
    bridge: &Bridge,
    store: &Mutex<PlanStore>,
    now: Instant,
) -> Result<ChangesApplyResult, ContractError> {
    workspace::fenced(context, |_root| {
        // Bound first: a guard in a `match` scrutinee would outlive the arms.
        let claimed = lock(store).claim(&request.plan_id, &context.epoch, now, Claimant::Agent(context.principal));
        let (state, changes) = match claimed {
            Ok(changes) => {
                let applied = execute(&request.plan_id, changes, &context.epoch, bridge, store);
                (applied.state, applied.changes)
            }
            Err(_) => lock(store).status(&request.plan_id, context.principal, &context.epoch, now),
        };
        Ok(ChangesApplyResult {
            plan_id: request.plan_id.clone(),
            state,
            effects: effects_of(&changes),
            changes,
        })
    })
}

// ---------------------------------------------------------------------------
// The review seam
// ---------------------------------------------------------------------------

/// A person's decision on a plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Decision {
    Approve,
    Reject,
}

/// Where a plan stands after a decision.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Reviewed {
    pub state: PlanState,
    pub changes: Vec<ChangeOutcome>,
}

/// A person's decision on a plan of the workspace `epoch` — the seam a
/// review surface calls (track T designs whether and where one appears;
/// tests and a debug-only command drive it until then). Approving applies a
/// waiting plan through the editor, at most once; rejecting ends it.
#[cfg_attr(not(debug_assertions), allow(dead_code))] // the debug command is its caller until track T
pub(crate) fn review(plan_id: &str, decision: Decision, epoch: &str) -> Reviewed {
    review_with(plan_id, decision, epoch, bridge::global(), plans(), Instant::now())
}

pub(crate) fn review_with(
    plan_id: &str,
    decision: Decision,
    epoch: &str,
    bridge: &Bridge,
    store: &Mutex<PlanStore>,
    now: Instant,
) -> Reviewed {
    if decision == Decision::Reject {
        let state = lock(store).reject(plan_id, epoch, now);
        return Reviewed { state, changes: Vec::new() };
    }
    // Bound first, so the store's guard is released before either arm runs:
    // a guard created in a `match` scrutinee lives to the end of the match,
    // and the second lock below would deadlock on it.
    let claimed = lock(store).claim(plan_id, epoch, now, Claimant::Person);
    match claimed {
        Ok(changes) => execute(plan_id, changes, epoch, bridge, store),
        // Not waiting (applied, applying, rejected, expired, …) or not this
        // workspace's: nothing runs, the plan's standing is the answer.
        Err(state) => lock(store).reviewed(plan_id, epoch, state),
    }
}

/// Apply a claimed plan and record the outcome. The store is not locked while
/// the owners work.
fn execute(plan_id: &str, changes: Vec<PlannedChange>, epoch: &str, bridge: &Bridge, store: &Mutex<PlanStore>) -> Reviewed {
    let (state, outcomes) = carry_out(&changes, epoch, bridge);
    lock(store).finish(plan_id, state, outcomes.clone());
    Reviewed { state, changes: outcomes }
}

/// The plan's changes, in order: new files' names checked again, the edits
/// all or none, then the new files. Each change's outcome is in plan order;
/// one Litria cannot know is left out, and the plan is then `needsReview`.
fn carry_out(changes: &[PlannedChange], epoch: &str, bridge: &Bridge) -> (PlanState, Vec<ChangeOutcome>) {
    let mut outcomes: Vec<Option<ChangeOutcome>> = vec![None; changes.len()];
    let edits: Vec<(usize, &ChangeToCheck)> = changes
        .iter()
        .enumerate()
        .filter_map(|(index, change)| match change {
            PlannedChange::Edit(edit) => Some((index, edit)),
            _ => None,
        })
        .collect();
    let creates: Vec<(usize, &FileToCreate)> = changes
        .iter()
        .enumerate()
        .filter_map(|(index, change)| match change {
            PlannedChange::Create(file) => Some((index, file)),
            _ => None,
        })
        .collect();
    let opens: Vec<(usize, &OpenEdit)> = changes
        .iter()
        .enumerate()
        .filter_map(|(index, change)| match change {
            PlannedChange::Open(open) => Some((index, open)),
            _ => None,
        })
        .collect();
    let unknown = |outcomes: Vec<Option<ChangeOutcome>>| (PlanState::NeedsReview, outcomes.into_iter().flatten().collect());

    // 1. Every new file, judged again as at the proposal — the policy, then
    // the name: a folder swapped for a link since could otherwise lead the
    // create into a withheld folder (W3b adversarial check, reproduced). And
    // every document to open, read again from disk: still the revision the
    // edits were planned on (W3c). One that is not as planned means nothing
    // lands.
    let mut to_open: Vec<FileToOpen> = Vec::new();
    if !creates.is_empty() || !opens.is_empty() {
        let Some(root) = bound_root(epoch) else {
            return (PlanState::Failed, Vec::new());
        };
        let mut blocked: Vec<(usize, ChangeOutcome)> = creates
            .iter()
            .filter_map(|(index, file)| {
                let path = file.path.clone();
                match identity(&root, &file.path) {
                    Identity::Key(key) if !name_is_taken(&root, &key) => None,
                    Identity::Key(_) => Some((*index, ChangeOutcome::Exists { path })),
                    Identity::Denied | Identity::InvalidPath => Some((*index, ChangeOutcome::Denied { path })),
                }
            })
            .collect();
        for (index, open) in &opens {
            let path = open.path.clone();
            match read_for_edit(&root, &open.path) {
                DiskEdit::Text { text, revision } if revision == open.base_revision => {
                    match plan_text_edits(&text, &open.edits) {
                        Ok(edited) => to_open.push(FileToOpen { path, base_text: text, text: edited }),
                        // The same text plans the same way; only a planner
                        // change could get here.
                        Err(_) => blocked.push((*index, ChangeOutcome::Conflict { path, revision })),
                    }
                }
                DiskEdit::Text { revision, .. } => blocked.push((*index, ChangeOutcome::Conflict { path, revision })),
                DiskEdit::Missing => blocked.push((*index, ChangeOutcome::NotInSession { path })),
                DiskEdit::Denied => blocked.push((*index, ChangeOutcome::Denied { path })),
                DiskEdit::NotEditable => blocked.push((*index, ChangeOutcome::Unavailable { path })),
            }
        }
        if !blocked.is_empty() {
            let outcomes = changes
                .iter()
                .enumerate()
                .map(|(index, change)| match blocked.iter().find(|(blocked, _)| *blocked == index) {
                    Some((_, outcome)) => outcome.clone(),
                    None => ChangeOutcome::Ready { path: change.path().to_string() },
                })
                .collect();
            return (PlanState::Conflict, outcomes);
        }
    }

    // 2. The documents to open go on the canvas first: every session document
    // belongs to a piece (W3c). A piece only shows a file that exists, so one
    // made for a plan that then does not apply is harmless; if any cannot be
    // made, nothing is applied.
    if !to_open.is_empty() {
        let request = ShowFilesRequest { paths: to_open.iter().map(|open| open.path.clone()).collect() };
        let shown = match bridge.call_reporting::<ShowFilesOp>(epoch, &request) {
            Ok(result) if result.files.iter().map(ShownFile::path).eq(request.paths.iter().map(String::as_str)) => {
                result.files
            }
            // Pieces only: no change was applied, whatever happened.
            _ => return (PlanState::Failed, Vec::new()),
        };
        if shown.iter().any(|file| matches!(file, ShownFile::Failed { .. })) {
            let failed: Vec<&str> = shown
                .iter()
                .filter_map(|file| match file {
                    ShownFile::Failed { path } => Some(path.as_str()),
                    ShownFile::Shown { .. } => None,
                })
                .collect();
            let outcomes = changes
                .iter()
                .map(|change| match change {
                    PlannedChange::Open(open) if failed.contains(&open.path.as_str()) => {
                        ChangeOutcome::Unavailable { path: open.path.clone() }
                    }
                    other => ChangeOutcome::Ready { path: other.path().to_string() },
                })
                .collect();
            return (PlanState::Failed, outcomes);
        }
    }

    // 3. The edits and the opened documents, all or none.
    if !edits.is_empty() || !to_open.is_empty() {
        let request = CheckChangesRequest {
            changes: edits.iter().map(|(_, edit)| (*edit).clone()).collect(),
            opens: to_open.clone(),
        };
        let asked: Vec<(usize, &str)> = edits
            .iter()
            .map(|(index, edit)| (*index, edit.path.as_str()))
            .chain(opens.iter().zip(&to_open).map(|((index, _), open)| (*index, open.path.as_str())))
            .collect();
        match bridge.call_reporting::<ApplyChangesOp>(epoch, &request) {
            Ok(result) if result.changes.iter().map(ApplyEntry::path).eq(asked.iter().map(|(_, path)| *path)) => {
                for ((index, _), entry) in asked.iter().zip(result.changes) {
                    outcomes[*index] = Some(outcome_of(entry));
                }
                if !result.applied {
                    // Nothing landed; the new files would have been created
                    // after the edits.
                    for (index, file) in &creates {
                        outcomes[*index] = Some(ChangeOutcome::Ready { path: file.path.clone() });
                    }
                    return (PlanState::Conflict, outcomes.into_iter().flatten().collect());
                }
            }
            // An answer about other documents: the editor acted on something,
            // but what is unknown.
            Ok(_) => return unknown(outcomes),
            // Never delivered, or refused before the editor acted: nothing
            // applied.
            Err(CallFailure { delivered: false, .. }) => return (PlanState::Failed, Vec::new()),
            Err(CallFailure { error, .. }) if error.code == ErrorCode::WorkspaceChanged => {
                return (PlanState::Failed, Vec::new())
            }
            // Delivered, then lost (no answer in time, a broken answer): the
            // editor may have applied it. Unknown — and never retried.
            Err(_) => return unknown(outcomes),
        }
    }

    // 4. The new files, through the filesystem write manager.
    if !creates.is_empty() {
        let request = CreateFilesRequest { files: creates.iter().map(|(_, file)| (*file).clone()).collect() };
        match bridge.call_reporting::<CreateFilesOp>(epoch, &request) {
            Ok(result) if result.files.iter().map(CreatedFile::path).eq(creates.iter().map(|(_, file)| file.path.as_str())) => {
                for ((index, file), created) in creates.iter().zip(result.files) {
                    outcomes[*index] = Some(match created {
                        // Rust mints every disk revision (brief §4.5): the
                        // file holds exactly the bytes of the plan's text.
                        CreatedFile::Created { path } => {
                            ChangeOutcome::Created { path, revision: disk_revision(file.text.as_bytes()) }
                        }
                        CreatedFile::Exists { path } => ChangeOutcome::Exists { path },
                        CreatedFile::Failed { path } => ChangeOutcome::Failed { path },
                    });
                }
            }
            Ok(_) => return unknown(outcomes),
            // Never delivered, or refused before the manager acted: no file
            // was created.
            Err(CallFailure { delivered: false, .. }) => fail_creates(&mut outcomes, &creates),
            Err(CallFailure { error, .. }) if error.code == ErrorCode::WorkspaceChanged => {
                fail_creates(&mut outcomes, &creates)
            }
            // Delivered, then lost: files may have been created.
            Err(_) => return unknown(outcomes),
        }
    }

    let outcomes: Vec<ChangeOutcome> = outcomes.into_iter().map(|outcome| outcome.expect("every change has an outcome")).collect();
    let landed = outcomes.iter().filter(|outcome| landed(outcome)).count();
    let state = if landed == outcomes.len() {
        PlanState::Applied
    } else if landed > 0 {
        PlanState::Partial
    } else if outcomes.iter().any(|outcome| matches!(outcome, ChangeOutcome::Exists { .. })) {
        PlanState::Conflict
    } else {
        PlanState::Failed
    };
    (state, outcomes)
}

fn fail_creates(outcomes: &mut [Option<ChangeOutcome>], creates: &[(usize, &FileToCreate)]) {
    for (index, file) in creates {
        outcomes[*index] = Some(ChangeOutcome::Failed { path: file.path.clone() });
    }
}

fn landed(outcome: &ChangeOutcome) -> bool {
    matches!(outcome, ChangeOutcome::Applied { .. } | ChangeOutcome::Created { .. })
}

/// Where the changes that landed went: `buffer` for edits, then `disk` for
/// new files.
fn effects_of(outcomes: &[ChangeOutcome]) -> Vec<Effect> {
    let mut effects = Vec::new();
    if outcomes.iter().any(|outcome| matches!(outcome, ChangeOutcome::Applied { .. })) {
        effects.push(Effect::Buffer);
    }
    if outcomes.iter().any(|outcome| matches!(outcome, ChangeOutcome::Created { .. })) {
        effects.push(Effect::Disk);
    }
    effects
}

/// Whether anything has a new file's name now: a file, a folder or a link
/// (never followed). Anything but "not found" counts as taken, so a name
/// that cannot be inspected is never created over.
fn name_is_taken(root: &Path, path: &str) -> bool {
    !matches!(fs::symlink_metadata(root.join(path)), Err(error) if error.kind() == ErrorKind::NotFound)
}

/// A document read from disk for an edit (W3c).
enum DiskEdit {
    Text { text: String, revision: String },
    Missing,
    Denied,
    /// Binary, not a regular file, unreadable, or over 1 MiB.
    NotEditable,
}

/// Read a document the editor does not hold, as `litria_files_read` reads it
/// (syntax, policy, typed resolution, policy on the canonical target), for an
/// edit: whole, and no larger than an editor tab takes.
fn read_for_edit(root: &Path, path: &str) -> DiskEdit {
    match read_disk(root, path) {
        DiskRead::Text { text, revision } if text.len() <= MAX_OPEN_FILE_BYTES => DiskEdit::Text { text, revision },
        DiskRead::NotFound => DiskEdit::Missing,
        DiskRead::Denied | DiskRead::InvalidPath => DiskEdit::Denied,
        DiskRead::Text { .. } | DiskRead::NotFile | DiskRead::NotText | DiskRead::TooLarge | DiskRead::Unreadable => {
            DiskEdit::NotEditable
        }
    }
}

/// An edit to a document the editor does not hold (W3c): checked against the
/// disk text the agent read (its revision), and planned on it.
fn judge_disk_edit(root: &Path, path: String, change: ChangeToCheck) -> (ChangeCheck, Option<PlannedChange>) {
    match read_for_edit(root, &change.path) {
        DiskEdit::Missing => (ChangeCheck::NotInSession { path }, None),
        DiskEdit::Denied => (ChangeCheck::Denied { path }, None),
        DiskEdit::NotEditable => (ChangeCheck::NotEditable { path }, None),
        DiskEdit::Text { revision, .. } if revision != change.expected_revision => {
            (ChangeCheck::Conflict { path, revision }, None)
        }
        DiskEdit::Text { text, revision } => match plan_text_edits(&text, &change.edits) {
            Err(EditMiss::NoMatch(edit)) => (ChangeCheck::NoMatch { path, edit }, None),
            Err(EditMiss::Ambiguous(edit)) => (ChangeCheck::Ambiguous { path, edit }, None),
            Ok(_) => (
                ChangeCheck::Ready { path },
                Some(PlannedChange::Open(OpenEdit {
                    path: change.path,
                    base_revision: revision,
                    edits: change.edits,
                })),
            ),
        },
    }
}

/// Why an edit did not plan.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EditMiss {
    NoMatch(u32),
    Ambiguous(u32),
}

/// Apply exact-text edits in order, exactly as the editor plans them
/// (`planBufferEdit`): each `oldText` must occur exactly once in the text as
/// the earlier edits leave it, overlapping occurrences counting.
pub(crate) fn plan_text_edits(text: &str, edits: &[EditToCheck]) -> Result<String, EditMiss> {
    let mut text = text.to_string();
    for (index, edit) in edits.iter().enumerate() {
        let index = index as u32;
        let Some(at) = text.find(&edit.old_text) else {
            return Err(EditMiss::NoMatch(index));
        };
        // Search again from the next character: an overlapping occurrence
        // counts, as `indexOf(oldText, at + 1)` counts it.
        let next = at + text[at..].chars().next().map_or(1, char::len_utf8);
        if text[next..].contains(edit.old_text.as_str()) {
            return Err(EditMiss::Ambiguous(index));
        }
        text.replace_range(at..at + edit.old_text.len(), &edit.new_text);
    }
    Ok(text)
}

/// The project root bound to `epoch`, if it is still the open workspace.
fn bound_root(epoch: &str) -> Option<PathBuf> {
    match db::workspace_binding() {
        Some((bound, Some(root))) if bound == epoch => Some(root),
        _ => None,
    }
}

fn outcome_of(entry: ApplyEntry) -> ChangeOutcome {
    match entry {
        ApplyEntry::Applied { path, revision } => ChangeOutcome::Applied { path, revision },
        ApplyEntry::Ready { path } => ChangeOutcome::Ready { path },
        ApplyEntry::Conflict { path, revision } => ChangeOutcome::Conflict { path, revision },
        ApplyEntry::NoMatch { path, edit } => ChangeOutcome::NoMatch { path, edit },
        ApplyEntry::Ambiguous { path, edit } => ChangeOutcome::Ambiguous { path, edit },
        ApplyEntry::NotInSession { path } => ChangeOutcome::NotInSession { path },
        ApplyEntry::Unavailable { path } => ChangeOutcome::Unavailable { path },
    }
}

fn lock(store: &Mutex<PlanStore>) -> std::sync::MutexGuard<'_, PlanStore> {
    store.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// The plan store
// ---------------------------------------------------------------------------

/// The process's plans.
pub(crate) fn plans() -> &'static Mutex<PlanStore> {
    static PLANS: OnceLock<Mutex<PlanStore>> = OnceLock::new();
    PLANS.get_or_init(|| Mutex::new(PlanStore::default()))
}

/// One change of a plan, as Litria carries it out: an edit for the editor,
/// an edit that opens its document from disk (W3c), or a new file for the
/// filesystem write manager.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub(crate) enum PlannedChange {
    Edit(ChangeToCheck),
    Open(OpenEdit),
    Create(FileToCreate),
}

/// An edit to a document the editor did not hold: planned on the disk text at
/// `base_revision`, read again when the plan applies.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub(crate) struct OpenEdit {
    pub path: String,
    pub base_revision: String,
    pub edits: Vec<EditToCheck>,
}

impl PlannedChange {
    pub(crate) fn path(&self) -> &str {
        match self {
            PlannedChange::Edit(edit) => &edit.path,
            PlannedChange::Open(open) => &open.path,
            PlannedChange::Create(file) => &file.path,
        }
    }
}

/// One immutable plan and where it stands. `changes` hold canonical
/// session paths (a new file's, as named).
#[derive(Debug)]
pub(crate) struct Plan {
    pub principal: Principal,
    pub epoch: String,
    pub hash: [u8; 32],
    pub changes: Vec<PlannedChange>,
    pub prepared_at: Instant,
    /// `PendingReview` reads as `Expired` once its time is up.
    state: PlanState,
    /// Per document, once applied or found in conflict.
    outcomes: Vec<ChangeOutcome>,
}

/// Who must agree before a plan applies (owner rulings, 2026-10-11).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum ReviewPolicy {
    /// The agent's own approval is enough: its client already asked the
    /// person. Plans start `prepared`; `litria_changes_apply` applies them.
    #[default]
    AgentApproval,
    /// Litria's own review: plans start `pendingReview` and apply only on a
    /// person's approval. Off until track T gives the review a surface.
    #[cfg_attr(not(test), allow(dead_code))]
    PersonReview,
}

/// Who is claiming a plan for applying.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Claimant {
    /// The requester, through `litria_changes_apply`: only its own
    /// `prepared` plan.
    Agent(Principal),
    /// A person, through the review seam: any waiting plan of the workspace.
    Person,
}

fn is_waiting(state: PlanState) -> bool {
    matches!(state, PlanState::Prepared | PlanState::PendingReview)
}

impl Plan {
    /// Where the plan stands at `now`.
    pub(crate) fn state(&self, now: Instant) -> PlanState {
        if is_waiting(self.state) && self.is_expired(now) {
            PlanState::Expired
        } else {
            self.state
        }
    }

    fn expires_at(&self) -> Instant {
        self.prepared_at + PLAN_TTL
    }

    pub(crate) fn is_expired(&self, now: Instant) -> bool {
        now >= self.expires_at()
    }

    fn summary(&self, id: &str, now: Instant) -> PreparedPlan {
        let left = self.expires_at().saturating_duration_since(now);
        PreparedPlan {
            plan_id: id.to_string(),
            state: self.state,
            // Rounded up: a plan with time left never reads as 0.
            expires_in_seconds: (left.as_millis().div_ceil(1000) as u32).min(PLAN_TTL_SECONDS),
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct PlanStore {
    plans: HashMap<String, Plan>,
    policy: ReviewPolicy,
}

impl PlanStore {
    #[cfg(test)]
    pub(crate) fn with_policy(policy: ReviewPolicy) -> Self {
        Self { plans: HashMap::new(), policy }
    }

    /// Store a proposal as a plan awaiting review, or return the pending plan
    /// the same requester already made of the same changes.
    pub(crate) fn propose(
        &mut self,
        principal: Principal,
        epoch: &str,
        changes: Vec<PlannedChange>,
        now: Instant,
    ) -> Result<PreparedPlan, ContractError> {
        self.forget_old(now);
        let hash = plan_hash(&changes);
        let pending =
            |plan: &Plan| plan.principal == principal && plan.epoch == epoch && is_waiting(plan.state(now));
        if let Some((id, plan)) = self.plans.iter().find(|(_, plan)| pending(plan) && plan.hash == hash) {
            return Ok(plan.summary(id, now));
        }
        if self.plans.values().filter(|plan| pending(plan)).count() >= MAX_PENDING_PER_PRINCIPAL {
            return Err(ContractError::new(
                ErrorCode::Busy,
                format!("{MAX_PENDING_PER_PRINCIPAL} proposals already wait to be applied; apply them or let them expire, then retry"),
            ));
        }
        let id = new_plan_id();
        let plan = Plan {
            principal,
            epoch: epoch.to_string(),
            hash,
            changes,
            prepared_at: now,
            state: match self.policy {
                ReviewPolicy::AgentApproval => PlanState::Prepared,
                ReviewPolicy::PersonReview => PlanState::PendingReview,
            },
            outcomes: Vec::new(),
        };
        let summary = plan.summary(&id, now);
        self.plans.insert(id, plan);
        Ok(summary)
    }

    /// A plan, if it exists and belongs to this requester and workspace.
    /// Another's plan is indistinguishable from none.
    #[cfg(test)]
    pub(crate) fn get(&self, id: &str, principal: Principal, epoch: &str) -> Option<&Plan> {
        self.plans.get(id).filter(|plan| plan.principal == principal && plan.epoch == epoch)
    }

    /// The requester's plan's standing and outcomes; `Unknown` for another's
    /// plan, an unknown id, or a forgotten one.
    pub(crate) fn status(&self, id: &str, principal: Principal, epoch: &str, now: Instant) -> (PlanState, Vec<ChangeOutcome>) {
        match self.plans.get(id).filter(|plan| plan.principal == principal && plan.epoch == epoch) {
            Some(plan) => (plan.state(now), plan.outcomes.clone()),
            None => (PlanState::Unknown, Vec::new()),
        }
    }

    /// Claim a plan of workspace `epoch` for applying: only a waiting,
    /// unexpired plan moves to `Applying`, so at most one claim ever wins.
    /// An agent may claim only its own `prepared` plan; a person any waiting
    /// one. Otherwise the plan's standing (`Unknown` when there is none, or
    /// when it is another requester's).
    pub(crate) fn claim(
        &mut self,
        id: &str,
        epoch: &str,
        now: Instant,
        claimant: Claimant,
    ) -> Result<Vec<PlannedChange>, PlanState> {
        let Some(plan) = self.plans.get_mut(id).filter(|plan| plan.epoch == epoch) else {
            return Err(PlanState::Unknown);
        };
        let state = plan.state(now);
        let allowed = match claimant {
            Claimant::Agent(principal) if plan.principal != principal => return Err(PlanState::Unknown),
            Claimant::Agent(_) => state == PlanState::Prepared,
            Claimant::Person => is_waiting(state),
        };
        if !allowed {
            return Err(state);
        }
        plan.state = PlanState::Applying;
        Ok(plan.changes.clone())
    }

    /// A person rejects a waiting plan of workspace `epoch`; returns where it
    /// stands.
    pub(crate) fn reject(&mut self, id: &str, epoch: &str, now: Instant) -> PlanState {
        let Some(plan) = self.plans.get_mut(id).filter(|plan| plan.epoch == epoch) else {
            return PlanState::Unknown;
        };
        if is_waiting(plan.state(now)) {
            plan.state = PlanState::Rejected;
        }
        plan.state(now)
    }

    /// Record the outcome of the claim that won.
    pub(crate) fn finish(&mut self, id: &str, state: PlanState, outcomes: Vec<ChangeOutcome>) {
        if let Some(plan) = self.plans.get_mut(id).filter(|plan| plan.state == PlanState::Applying) {
            plan.state = state;
            plan.outcomes = outcomes;
        }
    }

    /// A plan's standing for a reviewer of workspace `epoch`.
    fn reviewed(&self, id: &str, epoch: &str, state: PlanState) -> Reviewed {
        let changes = self
            .plans
            .get(id)
            .filter(|plan| plan.epoch == epoch)
            .map(|plan| plan.outcomes.clone())
            .unwrap_or_default();
        Reviewed { state, changes }
    }

    fn forget_old(&mut self, now: Instant) {
        self.plans.retain(|_, plan| now < plan.expires_at() + EXPIRED_RETENTION);
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.plans.len()
    }
}

/// `plan-` and 128 random bits: unguessable, so an id is never an oracle for
/// another requester's plan (R5), on top of the ownership check.
fn new_plan_id() -> String {
    let id = format!("plan-{:032x}", rand::rng().random::<u128>());
    debug_assert_eq!(id.len(), PLAN_ID_LENGTH);
    id
}

/// The plan's identity of content: its canonical changes, hashed.
fn plan_hash(changes: &[PlannedChange]) -> [u8; 32] {
    let encoded = serde_json::to_vec(changes).expect("planned changes serialize");
    Sha256::digest(encoded).into()
}

#[cfg(test)]
mod tests;
