# Project API build plan

Status: Accepted, 2026-09-30 (owner ruling on PR #85). Proposed the same day and revised with the brief after peer review by Codex. **All slices are pending. No code has been delivered.** *(Superseded 2026-09-30: P1 merged as PR #86; P2 is built — the slice map holds each slice's status.)*

Decisions: [ADR-031](031-agent-integration-and-lifecycle.md) (semantics), [ADR-033](../../adrs/033-contract-schema-source-of-truth.md) (contract pipeline), [ADR-032](../../adrs/032-workspace-epoch-fencing-and-write-truthfulness.md) (workspace epoch).
Canonical contract design: [Project API contract brief](brief-project-api-contract.md). Parent design: [agent integration brief](brief-agent-integration.md).
This document owns sequencing, executable evidence and completion status. It owns no decisions: where it seems to decide something, the brief is the authority.

## 1. Delivery rules and baseline

- **Order (owner direction, 2026-09-29/30):**
  1. contract;
  2. bounded reads;
  3. one version-checked buffer edit;
  4. conditional disk writes and receipts.

  `litria_files_search` is in the first read set.
- **The P and W tracks are independent of any agent runtime.** They are built and verified with Rust tests, JavaScript tests and a debug-only development call. **Nothing is exposed to users or to an external process until track T passes ADR-031's runtime-qualification gate.** A read that works through the development call has not shipped.
- **One slice, one branch, one pull request**, in a worktree off a refreshed `main` ([AGENTS.md §7.1](../../../Agents/AGENTS.md)). A slice's contract types, regenerated artifacts (`LITRIA_UPDATE_CONTRACTS=1 cargo test contracts::`) and fixtures land in the same pull request as the handlers that use them (ADR-033 decisions 5 and 7).
- **Standard checks for every slice:**
  - `cargo build` with zero warnings;
  - `cargo test`;
  - `npm run check:architecture`;
  - `npm run test:domains`;
  - `npm run build`.

  Any slice that touches `contracts/` also records `cargo tree -e normal` before and after: the shipped graph must gain no crate unless a recorded dependency decision says otherwise (brief §12, Q6).
- **Policies:** [implementation](../../../Agents/docs/implementation-policy.md) and [verification](../../../Agents/docs/verification-policy.md) for every slice. [Security](../../../Agents/docs/security-policy.md) for P1 (the disclosure policy), P2 (a new command and event surface) and P6. [Dependency change](../../../Agents/docs/dependency-change-policy.md) for any new crate.
- **Live passes** use a debug build on a **scratch project**, driven over CDP (WebView2 remote debugging). Never use the Litria repository itself under `tauri dev`: dogfooding there rewrites the dev server's own source.
- **Evidence:** update each slice with its pull request, exact commands, outcomes and environment. A checkbox is not evidence. A failed or unavailable check stays visible, with its next action.
- **Placement:** placement follows the brief §3. Before the first JavaScript file lands (P2), the [Domain Register](../../Orchestration.md#2-domain-register) gets its entry. The Rust module is recorded in [`rust-module-ownership.md`](../../rust-module-ownership.md) in P1.

## 2. Slice map

| Slice | Delivers | Depends on | Status |
|---|---|---|---|
| P1 | Workspace binding in Rust, production contract machinery, call context and fencing, disclosure policy, bounded disk reads (`litria_files_read`, `source: disk`), debug-only development call | — | Done: PR #86, merged 2026-09-30 (see [P1 record](#p1-record)) |
| P2 | Owner bridge family, JS `ProjectApiBridge`, effective reads | P1 | In review: PR #89 (see [P2 record](#p2-record)) |
| P3 | `litria_project_context`, `litria_files_search`, budget measurements (**first read set complete**) | P2 | Pending |
| P4 | `litria_graph_query` | P2 | Pending |
| P5 | `litria_diagnostics_list` and its detail store | P2 | Pending |
| P6 | MCP conformance over the real read catalog (in process, no transport) | P3 | Pending |
| W1 | EditorDomain compare-and-apply port and its two prerequisite fixes | P2 | Outline |
| W2 | Buffer `text.edit` through `litria_changes_prepare` and `litria_changes_apply`; in-memory operations | W1, P3 | Outline |
| W3 | Native conditional disk operations (create-if-absent, replace-if-expected-revision) | P1 | Outline |
| W4 | Durable operations, receipts, `litria_operations_get`, recovery | W2, W3 | Outline |
| T | Runtime qualification, stdio MCP helper and authenticated local IPC, real principals and grants | ADR-031 gate; P6 | Separate plan |

P4 and P5 can run alongside P3 and alongside each other. W-slices get their Tasks, Tests and Acceptance when the write contract is written, after P3 lands (brief §13).

## P1. Binding, boundary and bounded disk reads

### Goal

The Rust boundary can answer a `litria_files_read` request for disk content:
- against a workspace root Rust itself recorded;
- fenced by the epoch;
- filtered by the disclosure policy;
- with bounded memory.

The contract machinery compiles into the application, while schemars stays out of the shipped graph.

### Tasks

1. **Workspace binding** (brief §4.1)
   - Record the canonical root in `OpenWorkspace` when `db_open_project` or `db_bootstrap_project` mints the epoch. Clear it on close.
   - Add an accessor that copies the binding out under the lock. No file work happens under the database lock.
   - Existing `db_*` behavior is unchanged.
2. **Production contract machinery** (brief §12, Q6)
   - Compile `mod contracts` in all builds.
   - Keep generation, drift, fixture and MCP-proof modules `#[cfg(test)]`.
   - Derive `JsonSchema` with `cfg_attr(test, …)` and gate every `schemars(...)` attribute the same way.
   - Move the `JsonSchema` bounds from `Operation` to the test-only generation helpers.
   - Split the catalog entry into a runtime part (name, description, capability, request acceptance) and a test-only schema part.
3. **Call context and fencing** (brief §4.2–4.3)
   - Handlers receive `&CallContext { principal, grant, epoch }`.
   - Dispatch returns `denied` when the grant lacks the operation's capability.
   - It returns `notReady` when there is no binding.
   - It returns `workspaceChanged` when the epoch differs, checked at start and again before returning.
   - It returns `busy` when a principal exceeds its in-flight ceiling (brief §10).
   - Adopt the v1 error codes (brief §9).
   - **Sanitize parse errors.** Replace the boundary's verbatim serde text (`contracts/boundary.rs:41-42`) with fixed messages by category. No supplied field name or value is echoed.
4. **Typed resolver** (brief §12, Q4). Add a sibling to `path_guard`'s resolvers that returns an error enum (invalid, outside the root, not found, other I/O kind). The existing string-returning functions become wrappers over it, and their behaviour is unchanged (the existing `path_guard` tests pass untouched).
5. **Service module** `src-tauri/src/project_api/`
   - Path validation, returning per-item `invalidPath` (brief §6).
   - The disclosure policy: denied and unindexed classes, with denied winning; ASCII case-insensitive; applied to the requested path and the canonical target. The unindexed set reuses `project_tree::IGNORED_DIRS` rather than copying it.
   - The bounded reader (brief §5):
     - policy, then the typed resolver;
     - a single open (non-blocking on Unix), with the checks made on the handle; `notFile` for anything other than a regular file;
     - a capped `take(cap + 1)` read with overflow detection;
     - the text check, hash, range, truncation and `lineCut`;
     - shrink-to-fit against the encoded response ceiling.
6. **`project-api` v1 family**
   - `litria_files_read` types and handler (brief §7.2), with artifacts at `src-tauri/contracts/project-api/v1/` and `status: draft`.
   - `source: disk` is complete.
   - `source: effective` returns `ownerUnavailable` until P2. It never falls back to disk silently, because that would hide dirty buffers.
7. **Retire the S0 exemplar**
   - Delete `src-tauri/contracts/project-api/v0/` and its exemplar types.
   - Delete `test/support/project-api-adapter.mjs` and `test/domains/contractFixtures.test.mjs`. The external family has no JavaScript consumer; ADR-033's JavaScript-side proof returns in P2 against the bridge family and the real bridge module.
8. **Docs:** add `contracts` and `project_api` entries to `rust-module-ownership.md`, and record this slice here.

### Tests

- **Boundary verdict equals schema verdict** for every v1 fixture:
  - unknown field;
  - `null`;
  - missing field;
  - over-length ASCII and non-ASCII paths;
  - range bounds;
  - an integer beyond 2^53−1;
  - an over-budget request, which is schema-valid and rejected with `limitExceeded`.
- **Outbound conformance** for every outcome `kind`.
- **Drift and catalog:** a drift check over the complete v1 file set; catalog completeness; a mismatched handler fails to compile.
- **Path validation table:** each brief §6 rejection, including `a.txt:stream`, device names in any case, trailing dot or space, backslash, `..`, and a drive or UNC prefix. Accepted forms pass.
- **Policy table:** each denied pattern at the root and in depth; case variants (`.ENV`, `ID_RSA`); `.git` as a file; unindexed directories are readable by explicit path; allowed files are readable.
- **Denied wins over unindexed:** `.git/config` and `.litria/workspace.db` are denied, not readable by explicit path.
- **Links:** an in-project link to a denied file is denied. This uses a Unix symlink under `cfg(unix)`. On Windows, a junction to a denied directory; a symlink test skips itself without the privilege, following the `path_guard` precedent.
- **Bounded reader:**
  - a file over the hard cap returns `tooLarge` without being read (a sparse file via `set_len`);
  - **growth after the size check:** a test seam appends to the file between the handle check and the read. The reader returns `tooLarge`, and the bytes it held never exceed the cap plus one;
  - **non-regular files:** a directory path returns `notFile`. A FIFO returns `notFile` without blocking (`cfg(unix)`, created with `mkfifo`);
  - NUL bytes and invalid UTF-8 return `notText`;
  - ranges and line-boundary truncation, with `totalLines`;
  - **oversized line:** a 300 KiB one-line file returns a cut line with `lineCut: true`, and asking for the next line makes progress;
  - **escape-heavy text:** a first document whose escaped form exceeds the encoded ceiling is shrunk to fit and marked `truncated`, never `skipped`. Later documents that cannot fit become `skipped`;
  - the revision is stable for identical bytes and changes with the content.
- **Typed resolver:** a missing file maps to `notFound` from the error kind, not from message text. The legacy wrappers return the same strings as before.
- **Parse errors:** for an unknown field and a wrong-typed value, the error message contains neither the supplied field name nor the value.
- **Concurrency:** a principal's fifth in-flight call returns `busy`.
- **Fencing:**
  - no binding returns `notReady`;
  - a stale epoch returns `workspaceChanged`;
  - an epoch switch injected between start and return returns `workspaceChanged` with no result;
  - a missing capability returns `denied`.
- `source: effective` returns `ownerUnavailable`.
- **Binding:** open records the canonical root; close clears it; reopening the same folder mints a new epoch with the same root.

### Acceptance

- All tests and standard checks pass.
- `cargo tree -e normal` shows no new crate.
- Messages contain no absolute path and no denied path (asserted).
- The slice record here names the pull request and the commands.

### P1 record

**2026-09-30, branch `feat/project-api-p1`,** a worktree off `main` `b381467`. Environment: Windows 10, rustc 1.97.1, Node 24.14.0. The pull request is linked from the branch.

**Delivered, as tasked above:**
- the workspace binding;
- production contract machinery, with schemars test-only;
- the call context, grant, in-flight ceiling and epoch fence;
- sanitized parse errors;
- the typed `path_guard` resolver;
- path validation, the disclosure policy and the bounded reader;
- `project-api` v1 with `litria_files_read` (26 fixtures, including one generated);
- the S0 `v0` family and its JavaScript prototype retired;
- `rust-module-ownership.md` entries.

**Deviations, each recorded where it applies:**
- **The debug-only development call moved here from P2 (task 5).** Without it, P1's production code has no consumer and `cargo build` reports it all as dead code. Release builds allow the dead code at module level (`lib.rs`), with a reason naming track T's transport.
- **A ninth outcome kind, `unreadable`,** for an I/O failure other than not-found (brief §7.2, dated). The list had no outcome for a locked or permission-denied file.
- **`endLine` before `startLine` is not a request error.** It is a cross-field constraint JSON Schema cannot express, so rejecting it would break verdict equality. It returns no lines, and a fixture records the case.
- **The hard-cap test uses an injected cap rather than a sparse 8 MiB file.** The reader takes the cap as a parameter, and a hook proves the size check refuses the file before anything is read.
- **A unix-only direct dependency on `libc` 0.2** (for `O_NONBLOCK`). It is already in the lockfile through Tauri and portable-pty, so it adds a direct edge and no crate. `Cargo.lock` gains one line.

**Checks (all run in the worktree):**

| Command | Outcome |
|---|---|
| `cargo build` | zero warnings |
| `cargo check --release` | zero warnings; the development call compiles out |
| `cargo test` | 396 passed, 3 ignored (pre-existing) |
| `LITRIA_UPDATE_CONTRACTS=1 cargo test contracts:: -- --test-threads=1`, then `cargo test contracts::` | 25 contract tests pass against the committed `v1` artifacts |
| `npm run check:architecture` | all seven guards pass |
| `npm run test:domains` | 1316 of 1316. This is 1325 before, minus the 9 retired S0 JavaScript tests. |
| `npm run build` | pass |
| `cargo tree -e normal`, before and after | host graph identical (416 lines). On Linux, `libc` gains the direct edge from `litria`. Neither schemars 1.x nor jsonschema is in any normal graph. (schemars 0.8.22 is Tauri's own, through `tauri-utils`, and is unchanged from `main`.) |

**Planted mistakes, each caught and then restored** (the restore was verified by content and then `touch`ed):

| Planted mistake | Caught by |
|---|---|
| Path length measured in bytes (`str::len`) | The fixture verdict test (`max-length-non-ascii`) |
| No policy check on the canonical target | The Windows junction test |
| No overflow check after the capped read | The growth-after-check test |
| No end-of-call fence | The switch-during-work test |

A fifth plant, an uncapped read, was malformed and failed to compile, so it proved nothing. The overflow-check plant replaced it.

**Platform coverage:**
- The FIFO test (`cfg(unix)`) and the Unix symlink test run on the Linux and macOS jobs of `rust-tests.yml`, not locally. Both passed on PR #86: `cargo test (linux-x86_64)` and `cargo test (macos-aarch64)` each reported 390 passed and 3 ignored, and their logs show both tests as `ok`.
- The Windows junction test ran locally.
- The Architecture Guard also passed on the PR.

**Peer review by Codex (2026-09-30, commit `c03d22e`).** Codex reported four findings. Each was verified with a reproduction test written against the unfixed code before anything changed:

| Finding | Verified | Fix |
|---|---|---|
| **High.** The reader authorized the resolved path and then opened it separately, so a file or parent swapped for a link in between was read. | **Reproduced** on Windows: with `sub/` swapped for a junction into `.git`, the read returned `.git/config`'s content; a junction to a directory outside the project returned the outside file. (The Unix symlink variant runs in CI.) | After opening, the reader asks the handle for its real path (`GetFinalPathNameByHandleW`, `/proc/self/fd`, `F_GETPATH`; any other platform fails closed) and repeats containment and the policy on it. Brief §5 step 3 and §6 are amended. |
| **Medium.** The typed resolver reused the legacy validator, which trims. | **Reproduced:** `" notes.txt"` returned `notes.txt`'s content. `" .env"` answered `denied` or `notFound` depending on whether `.env` existed, leaking existence. | The typed resolver takes names exactly. The legacy resolver trims first and then delegates, so its results and messages are unchanged (tested). |
| **Medium.** Slicing collected every line into a `Vec<&str>`. | Confirmed from the code: 16 bytes per line, so an 8 MiB file of newlines costs about 128 MiB. | Lines are counted and walked by iterator, and memory is proportional to the returned text. A new test covers a million short lines. |
| **Medium.** One character was kept even when it exceeded the budget. | **Reproduced:** 4 bytes were returned against a 3-byte budget, and 262,147 bytes against the 262,144-byte response budget. | Budgets are strict. The minimum per-document budget rises from 1 to 4 bytes, the largest UTF-8 character, which changes the contract schema and adds two fixtures. A later document whose next character cannot fit is `skipped`. |

**Checks after the fixes:**
- `cargo test`: 403 passed, 3 ignored. That is the 396 above plus 7 new tests that run on Windows; the Unix race test runs in CI.
- Contract tests: 25 pass.
- `cargo build` and `cargo check --release`: zero warnings.
- Host normal graph: identical.
- `Cargo.lock`: unchanged.
- Guards: all seven pass.
- `windows` gains the `Win32_Storage_FileSystem` feature. Another crate already enables it on `windows` 0.61.3, so nothing new compiles.
- **CI on the fix commits:** Linux and macOS each passed 396 tests with 3 ignored. `a_file_swapped_for_a_symlink_after_resolution_is_denied` passed on both. Every read test there goes through the new post-open path query, so these runs are also the evidence that `/proc/self/fd` (Linux) and `F_GETPATH` (macOS) work.

**Re-review by Codex (2026-09-30, commit `b85b6f0`).** Codex confirmed the three medium fixes and raised one more high finding. On Linux, `/proc/self/fd` reports an unlinked file as `<path> (deleted)`. That name matches no deny rule, while the open handle still reads the contents.

Codex could not run commands (its sandbox asked for extra authentication), so the finding was reproduced here:
- **Environment:** Docker Desktop, image `rust:1-bookworm`, kernel `6.6.87.2-microsoft-standard-WSL2`.
- **Code under test:** the real `path_guard`, `project_tree`, `project_types`, `paths`, `policy` and `reader` modules, copied unmodified (verified with `cmp`) into a throwaway crate.
- **Kernel behavior:** a shell check showed `readlink` returning `…/.env (deleted)` after the unlink, while the handle still read the secret.
- **The reader:** the new test `a_denied_file_unlinked_after_opening_is_still_withheld` returned the `.env` contents against the unfixed reader.

**Fix.** After the path query, the reader checks that the opened object still has a name, and fails closed (`unreadable`) if it has none. Brief §5 step 3 records this.
- On Unix it checks for a link count of 0, and on Linux also for the ` (deleted)` marker.
- **Windows** gets the equivalent check (`NumberOfLinks` of 0, or `DeletePending`). This came from our own analysis while fixing: with POSIX delete semantics, a deleted file's path moves to `\$Extend\$Deleted\…`, which is inside a project stored at a drive root.

**Results after the fix:**
- Linux, in the same container: all 42 tests of the copied modules pass, including the one that failed before the fix.
- Windows: `cargo test` gives 405 passed and 3 ignored.
- `cargo check --release`: zero warnings.
- New tests:
  - unlink after open, for `.env` and a `.pem` (Unix);
  - delete after open (Windows);
  - a file deleted behind an open handle reads as unlinked (all platforms);
  - the Linux marker.
- **CI on the fix:** Linux passed 399 and macOS passed 398, each with 3 ignored. Both logs show the unlink-after-open regression test and the direct unlinked-handle test as `ok`, and the Linux log also shows the marker test.
  - That macOS pass is the first evidence of how `F_GETPATH` behaves for a deleted file.
  - The Architecture Guard also passed.

**Security review** (security policy Rule 1: a new command touching the filesystem):
- `project_api_dev_call` exists only in debug builds.
- It reads nothing the webview cannot already read through `read_project_file`.
- Its reads pass the disclosure policy and the epoch fence.

Residual risks:
- The policy's denied list is not a confidentiality guarantee (brief §6).
- A FIFO swapped in between the stat and the non-blocking open is answered as `notFile`. On Windows, named pipes are not reachable through project paths.
- A hard link to a denied file under an allowed name is read like a copy of that file (brief §6).
- Platforms other than Windows, Linux and macOS fail closed (`unreadable`), because they have no post-open path query.

## P2. Owner bridge and effective reads

### Goal

Rust can ask live frontend owners for state through a typed, fenced and bounded bridge. `litria_files_read` returns what the editor actually holds, and the result can be exercised in the running app.

### Tasks

1. **`project-api-bridge` v1 family** (brief §8)
   - Types for `editor.documents` and `editor.bufferIndex`, with artifacts at `src-tauri/contracts/project-api-bridge/v1/`.
   - The direction is reversed: requests are outbound from Rust, and replies are inbound and pass the three-layer boundary. The first layer is the encoded reply ceiling.
2. **Rust bridge client**
   - Minted request ids, a pending map, deadlines, and the epoch and attach generation carried in every request.
   - The pending map has a ceiling; beyond it, requests fail with `busy`.
   - Emit `project-api://bridge-request` to the main window.
   - `project_api_bridge_attach` returns a generation, and `project_api_bridge_detach` ends it. Rust sends requests only to a bridge attached for the request's epoch; otherwise it returns `ownerUnavailable`.
   - An asynchronous `project_api_bridge_reply` command, which never waits on the replying thread.
   - Late, duplicate, unknown and stale-generation replies are dropped and counted. No lock is held while waiting.
3. **JavaScript**
   - `src/app/projectApiBridge.js`: the pure factory. It checks the request epoch against its ready epoch and `getWorkspaceEpoch()`, runs the operation port, mints buffer revisions, pages and slices within the reply ceiling, and replies exactly once.
   - `src/app/useProjectApiBridge.js`: the hook. It derives the ready epoch from `projectInstance._dbState.workspaceEpoch`. It attaches only after hydration completes (DB state applied, piece contents loaded, editor session restored), and detaches when the project instance changes. It builds its ports from selectors.
   - Where hydration completion is not observable today, expose it as a read-only signal from its owner. The persistence hook tracks it internally (`hasLoadedPiecesRef`, `hasRestoredEditorSessionRef`); App.jsx must not grow logic for this.
   - An EditorDomain read selector for session entries by path. It covers closed entries the session retains, and maps tab ids to paths inside the bridge.
   - A Domain Register entry in `Orchestration.md`.
   - One hook invocation in `App.jsx`, with a rationale line in the shell composition manifest.
4. **Effective `litria_files_read`**
   - Documents whose session state is `open` or `closedDirty` come from the buffer. All others come from disk.
   - `source` and `dirty` are reported.
5. **Debug-only development call** — *delivered in P1 (2026-09-30), as P1's first consumer; see the [P1 record](#p1-record).*
   - `project_api_dev_call(operation, payload)` under `#[cfg(debug_assertions)]`.
   - The `dev` principal gets the full read grant, bound to the current epoch.
   - It is absent from release builds (asserted by a release-profile `cargo build` check or a test).

### Tests

- **Rust:**
  - reply verdicts equal the schemas' verdicts;
  - an over-ceiling reply is rejected before parsing;
  - a deadline expiry returns `ownerTimeout`;
  - no listener, or a listener attached for another epoch, returns `ownerUnavailable`;
  - late and duplicate replies are ignored;
  - a reply for a stale epoch is refused;
  - a reply from a stale attach generation is refused, which is the webview-reload case;
  - the 33rd pending request returns `busy`;
  - the reply command never blocks.
- **JavaScript** (real bridge module, transport mocked, ADR-033 decision 4). Each of these fails a test:
  - a wrong field name;
  - an identifier sent as a number;
  - an unfamiliar outcome `kind` that is not surfaced as unknown;
  - a missing epoch check.

  Also covered:
  - a closed dirty tab is served from the session;
  - the revision is stable across calls and changes after an edit;
  - slices and pages respect ranges and the reply ceiling, including escape-heavy text.
- **Hydration (JavaScript, owner state mocked):**
  - While the global epoch is already B's but the editor still holds A's, the bridge is detached and B requests get `ownerUnavailable`.
  - While B is half-hydrated (pieces loaded, session not yet restored), the bridge is still detached.
  - After hydration it attaches under B's epoch, and answers from B's state.
  - A request from A that is interrupted by the switch to B is refused with `workspaceChanged`.
- **Live pass** (CDP, debug build, scratch project):
  - After typing without saving, an effective read returns the buffer with `dirty: true`, and a disk read returns the saved text.
  - After closing the dirty tab, an effective read still returns the buffer.
  - Switching projects during a call returns `workspaceChanged`.
  - A call issued immediately after opening another project returns `ownerUnavailable` or B's state, never A's.
  - After reloading the webview, calls work again once it re-attaches.

### Acceptance

- All tests, standard checks and the live pass pass.
- The editor-engine guard is unchanged: the bridge reads no Monaco state.
- The Domain Register and the shell manifest are updated in the same pull request.

### P2 record

**2026-09-30, branch `feat/project-api-p2`, PR #89,** a worktree off `main` `835e4dd`. Environment: Windows 10, rustc 1.97.1, Node 24.14.0.

**Delivered, as tasked above:**
- the `project-api-bridge` v1 family: `editor.documents` and `editor.bufferIndex`, the request event envelope, and the reply union, with artifacts and 25 fixtures (two generated) in `src-tauri/contracts/project-api-bridge/v1/`. The test-only artifact and fixture machinery now serves two families;
- the Rust bridge client (`project_api/bridge.rs`): minted request ids, a pending map of at most 32, a 2 s deadline, attach generations, the reply ceiling checked before parsing, and a reply command that never waits;
- the JavaScript factory `src/app/projectApiBridge.js` and the hook `src/app/useProjectApiBridge.js`; EditorDomain's read selector `getSessionDocumentsByPath`; the hydration signal `sessionReadyFor` from `useProjectPersistence`; one hook call in `App.jsx`, with its shell-manifest line and a Domain Register entry;
- effective `litria_files_read`: buffers for `open` and `closedDirty` session entries, disk otherwise, with `source` and `dirty` reported.

**Deviations, each recorded where it applies (contract brief §4.3 and §8 carry dated notes):**
- **Debug builds only.** The three bridge commands and the hook exist only in debug builds, like `project_api_dev_call`, their only consumer before track T.
- **Requests fail fast when their generation ends** (`ownerUnavailable`), instead of timing out.
- **A page protocol for `editor.documents`:** `notBuffered`, `buffer` and `deferred` entries; the first entry of a page is never deferred. Rust checks every reply against its request (paths, order, budgets, ranges) and fails the call on a mismatch.
- **Buffer lookups use the document's canonical path,** so a case variant or an in-project link finds the buffer of the file it names.
- **`editor.bufferIndex` has no consumer yet.** Its contract, owner port and client call land here; `litria_files_search` (P3) consumes it. The Rust items carry per-item `dead_code` allows naming that consumer.
- **Three fixes beyond the tasks,** all found while verifying this slice (the third by peer review):
  - **The editor session now resets per project load, not per project identity** (`useProjectPersistence`, `EditorSessionContext`). A project's `instanceId` is stored in its own database, so a folder copy of a project, or the project reopened, kept the previous session: the copy showed the original's buffers under "All Saved", and the bridge served them as the copy's (a save would also write them into the copy — by inspection, not exercised). Reproduced and verified below.
  - **A request that arrives while the bridge's attach is resolving is held, then answered.** Rust records an attach before the frontend's call returns; such a request used to be ignored and time out after 2 s.
  - **The session is restored only from the load's own pieces** (`useProjectPersistence`). The restore was gated on a shared "pieces loaded" ref. A project with no pieces finished loading synchronously, so the restore ran with the previous render's pieces: opening an empty project whose saved editor state listed a tab id restored the previous project's piece, including an edit already discarded there, as an unsaved tab, and the bridge served it. Restoration now waits for this load's own loaded marker, and only a still-current reader sets the shared ref. Found by Codex's review of PR #89; reproduced and verified below.

**Checks (all run in the worktree):**

| Command | Outcome |
|---|---|
| `cargo build` | zero warnings |
| `cargo check --release` | zero warnings; the bridge commands compile out |
| `cargo test` | 445 passed, 3 ignored (pre-existing) |
| `LITRIA_UPDATE_CONTRACTS=1 cargo test contracts:: -- --test-threads=1`, then `cargo test contracts::` | 30 contract tests pass against the committed artifacts of both families; the `project-api` v1 artifacts are unchanged |
| `npm run check:architecture` | all seven guards pass; the editor-engine guard is unchanged |
| `npm run test:domains` | 1341 of 1341 (1316 before; 20 bridge tests, 3 session-selector tests and 2 real-hook hydration tests added) |
| `npm run build` | pass |
| `cargo tree -e normal`, before and after | identical (814 lines); no manifest or lockfile changes |

**Planted mistakes, each caught and then restored** (verified identical by content):

| Planted mistake | Caught by |
|---|---|
| JavaScript: `totalLine` instead of `totalLines` | the committed-reply test and the ceiling test |
| JavaScript: the request id echoed as a number | both committed-reply tests and the attach-window test |
| JavaScript: an unfamiliar operation served as `editor.documents` | the unfamiliar-operation test |
| JavaScript: no check against the frontend's current epoch | the epoch-check test and the project-switch test |
| JavaScript: restore gated on the shared loaded ref again, not on the load | the exact-sequence hydration test |
| JavaScript: a cancelled loader sets the shared loaded ref again | **not caught.** The restore no longer reads that ref, and its other readers (viewport and position persistence) show no harm from it by inspection; the guard stays as defense in depth. The delayed-loader test fails only when both halves are removed. |
| Rust: a request sent to a bridge attached for another epoch | `an_attachment_for_another_epoch_is_owner_unavailable` |
| Rust: a reply accepted from any generation | `a_reply_from_a_stale_generation_is_refused` |
| Rust: no policy check on the canonical identity | `a_link_to_a_denied_directory_never_reaches_the_bridge` |
| Rust: a buffer entry accepted for another path | `a_reply_that_misanswers_the_page_fails_the_call` |
| Rust: an attach accepted for a workspace that is not open | `attach_requires_the_current_workspace` |

**Adversarial check** ([policy](../../../Agents/docs/adversarial-check-policy.md)). Guarantees: a reply never describes another project; a reply is accepted only for a pending request, from the generation it was addressed to; Rust never parses more than 512 KiB of reply and accepts only replies that answer exactly what was asked; a denied path, requested or resolved, never reaches the bridge; pending requests are capped and every wait ends. Findings:

| Finding | Status |
|---|---|
| **High.** The editor session survived a switch to a folder copy (or a reopen), so the bridge served the previous load's buffers. | **Reproduced** live on Windows (a copy of the scratch project opened showing, and reading back, the original's `main.ts`). **Verified fixed** live on Windows with the same script. The fix is in JavaScript only. |
| **Low (liveness).** A request emitted inside the attach window timed out after 2 s. | **Reproduced** live on Windows (three of three read loops stalled 2 s right after a switch); the JavaScript test written for it failed first. **Verified fixed** live with the same burst (no stall) and by the test. |
| A case variant on macOS, or a different Unicode normalization, may miss the buffer and read disk. | **Suspected.** Not a disclosure path. The case test detects case-insensitive volumes at runtime, so the macOS CI job exercises it. |
| **High** (peer review, Codex, 2026-09-30). Edit a file in project A, Discard, then open an empty project B whose saved editor state lists that tab id: B restored A's discarded edit as an unsaved tab, and the bridge served it as B's file. A cancelled loader could also let B restore tabs before its own contents loaded (empty text). Present on `main` without the bridge; the readiness signal turned it into a cross-project reply. | **Reproduced**: in Codex's real-hook harness (Windows; rerun here), the same sequence on `main` 835e4dd without the bridge (B's session held A's edit, unsaved), live on Windows (debug app over CDP: an empty project with a stale saved tab id read back the other project's discarded edit), and by the two new real-hook tests, which failed first (the delayed-loader one also reproduces the empty-text variant, previously only suspected). **Verified fixed** by those tests and live with the same script on Windows. The fix is JavaScript only. |
| A hard link to a buffered file under another name reads disk. | Accepted residual, as for P1's hard-link note. |
| The IPC layer allocates a reply string before the ceiling check. | Accepted residual: the reply comes from the application's own webview, and the ceiling bounds what Rust parses. |

**Live pass** (debug build from the worktree, CDP, app data redirected to a scratch folder, scratch projects only):

| Check | Outcome |
|---|---|
| Effective read right after opening a project | `ownerUnavailable` while it hydrates (about 0.4 s), then answers |
| Typing without saving | effective read: the buffer, `source: editor`, `dirty: true`; disk read: the saved text; revision stable across calls |
| Closing the dirty tab | effective read still returns the buffer |
| A switch during a call (debugger pause inside the bridge's handler, workspace switched in Rust, resumed) | `workspaceChanged`; the old project's answer was discarded |
| Calls issued immediately after opening another project (three concurrent loops, both directions) | `notReady`, then `ownerUnavailable`, then the new project's text; never the old project's |
| Reloading the webview | the old listener's request times out; after reopening, calls work again |
| After the restore fix: edit and Discard in A, then open an empty project with a stale saved tab id | its session is empty, it has no unsaved changes, and the effective read returns its own file from disk (before the fix: the other project's discarded edit). The checks above were repeated on the fixed code and pass. |

**Platform coverage:** the Unix-symlink variant of the link-alias test and the case-variant test on a case-insensitive macOS volume run in the Linux and macOS CI jobs; the junction variant and the case test ran locally on Windows.
- **CI on PR #89:** `cargo test (linux-x86_64)` passed 441 and `cargo test (macos-aarch64)` passed 440, each with 3 ignored; the Architecture Guard passed. Both logs show `a_link_alias_finds_the_buffer_of_the_file_it_names` (a Unix symlink there) and `a_link_to_a_denied_directory_never_reaches_the_bridge` as `ok`.
- **Not proven on macOS:** the case-variant test also reports `ok` on both jobs, but it returns early, without output, on a case-sensitive volume. The log cannot show which branch ran on macOS, so the macOS case finding stays suspected.

**Security review** (security policy Rule 1: new commands): the three bridge commands exist only in debug builds and touch no filesystem; replies are accepted only for pending requests and pass the reply boundary; owner error text is never forwarded; denied paths are answered in Rust before the bridge is asked.

**Found in passing:** a slower file-contents load from the previous project can mark the next one's contents as loaded (`hasLoadedPiecesRef` is set without the `isMounted` guard), so its session restore can open tabs with empty text. *(Corrected 2026-09-30: this was first recorded as "not fixed here", with the claim that the bridge's readiness does not rely on that ref. That claim was wrong: readiness trusted the restore, and the restore was gated on that ref. Peer review then found a synchronous variant that leaks across projects. Both are now fixed in this slice; see the third fix above.)*

## P3. Project context and search — the first read set

### Goal

An agent can orient itself (`litria_project_context`), read (P1–P2) and search (`litria_files_search`) with honest limits. The provisional budgets gain evidence.

### Tasks

1. **Bridge operations** `workspace.selection` and `languages.capabilities`, with their EditorDomain, SelectionDomain, GroupDomain, LanguageSupportDomain and SyntaxDomain ports.
2. **`litria_project_context`** (brief §7.1). It returns no epoch and no absolute path. It includes the operations the grant permits and the server's limits. Rust filters denied paths out of the selection, open documents, active document and dirty count before listing or counting.
3. **`litria_files_search`** (brief §7.3):
   - a walker that skips denied and unindexed paths, never follows links, counts unreadable directories, and orders results by path then line;
   - literal matching with ASCII case folding;
   - `text` and `path` targets;
   - the buffer-coverage protocol: the buffer index first, then paged buffer text; documents in the index are never searched on disk; buffer-only documents are included; any uncovered buffer is reported as `truncated` with the reason `bufferCoverage`;
   - the observed revision on every match;
   - concurrent-search ceiling;
   - every brief §10 bound, with truncation reasons. `.gitignore` is documented as not honoured.
4. **Measurements.** Record response sizes, walk times and truncation behaviour on a scratch copy of this repository and on a large synthetic tree. Revise brief §10 with the evidence, dated. Small-context model budgets move to track T, because they need a runtime.

### Tests

- **Search:**
  - denied files never appear in results or counts;
  - unindexed directories are not walked;
  - links are not followed;
  - an unreadable directory is skipped and counted;
  - each truncation reason is reachable;
  - ordering is deterministic;
  - buffer text wins for dirty documents, labelled `editor`;
  - case folding changes no column;
  - a non-ASCII query matches exactly;
  - every match carries its observed revision, and that revision equals the revision a following read returns when nothing changed.
- **Buffer coverage:**
  - a dirty buffer larger than the scan cap is counted as too large, not searched on disk;
  - a buffer index over its cap, a failed page and a time budget expiring mid-buffers each report `truncated` with `bufferCoverage` and the uncovered count;
  - a dirty buffer whose file was deleted on disk is searched, labelled `editor`;
  - a search is reported complete only when every indexed buffer was searched.
- **Denied files in context:** with a denied file selected, open, active and dirty, `litria_project_context` lists it nowhere, and the dirty count excludes it. The same file does not appear in the search's buffer coverage.
- **Project context:** the capability matrix matches the language tiers; selection maps to paths only; no epoch; no absolute path.
- **Concurrency:** a third concurrent search returns `busy`.
- **Live pass:** search finds unsaved text in a dirty buffer, and context reflects a selection change.

### Acceptance

- All tests, standard checks and the live pass pass.
- Brief §10 carries a dated measurement note.
- The first read set is usable end to end through the development call.

## P4. Graph query

### Goal

`litria_graph_query` returns a bounded, path-identified neighbourhood with derived provenance and honest freshness (brief §7.4).

### Tasks

- A read-only `SyntaxDomain` selector for provenance per connection, or derivation inside the bridge from `getEdgeIdForConnection`, whichever keeps SyntaxDomain dependency-free.
- `SyntaxDomain` records the revision of the text each file was parsed from, using the same revision functions as reads (brief §7.4).
- The bridge operation `workspace.graph`: pieces, groups, wires and pending edges, mapped to paths, with each file's parsed-text revision.
- The Rust handler:
  - neighbourhood by depth and direction;
  - the policy applied to nodes and edges (edges touching denied files are dropped);
  - node, edge and symbol ceilings, and the encoded response ceiling;
  - per-node freshness from comparing each file's parsed-text revision with its effective revision;
  - the summary index state with its reasons.

### Tests

- Provenance for discovered, hand-drawn and off-canvas edges.
- A denied endpoint removes the edge.
- **Freshness:**
  - a file whose disk text changed after parsing, with no open buffer, is `stale`, not `current`;
  - a file edited in a buffer after parsing is `stale` until it is re-registered;
  - a file with no recorded parsed revision is `unknown`;
  - the summary is `current` only when every node is.
- Index state is `partial` while files are parsing, and `unavailable` for a language without relationship discovery.
- Truncation at `maxNodes`, and at the edge and symbol ceilings.

### Acceptance

All tests and standard checks pass, plus a live pass on a JS/TS scratch project.

## P5. Diagnostics list

### Goal

`litria_diagnostics_list` returns detailed diagnostics with a producer and an explicit `unavailable` state (brief §7.5).

### Tasks

- Choose the detail store (a Rust LSP-bridge cache or a JS store). Record the reasoning, and the freshness it can prove from the producer session and the diagnosed document version. Build it.
- Message bounds and redaction: no absolute paths; denied path tokens replaced; related locations in denied files removed (brief §7.5).
- Paths are denied before any diagnostic is returned.

### Tests

- Closed-file diagnostics.
- A producer that is not bridged returns `unavailable`, not an empty list.
- Denied paths are omitted.
- **Denied references on allowed files:** a diagnostic on an allowed file whose message names `./.env` is redacted, and a related location in a denied file is removed.
- Freshness: diagnostics from a restarted producer session or for an older document version are not reported as current.
- Severity filtering, and the per-file and per-response ceilings.

### Acceptance

All tests and standard checks pass, plus a live pass with a real language server.

## P6. MCP conformance over the read catalog

### Goal

Prove the future adapter's contract against the real v1 read catalog, without a transport.

### Tasks

- An in-process MCP adapter:
  - `tools/list` is built from the committed artifacts, embedded with `include_str!`;
  - `tools/call` runs through the boundary and the dispatcher with a test principal.
- Decide between an MCP SDK (a dependency decision) and S0's thin serializer, and record it.

### Tests

- Published schemas are byte-identical to the committed artifacts, and every `$ref` is local.
- Success and error results validate against the outbound schemas.
- The mapping to `isError` and to −32602.
- A denied capability is reported as a tool error.

### Acceptance

All tests and standard checks pass. The adapter is test-only or unreachable in release builds until track T.

## W-track outline

The brief §13 holds the direction. Slices are detailed when the write contract is written.

- **W1: compare-and-apply.** An EditorDomain command, applied to session state and any live model in the same turn, through an engine-injected capability. It first fixes the two prerequisite defects:
  - the rename leaves the model URI and LSP tab maps stale;
  - a programmatic edit to an unattached model is not mirrored into the session.
- **W2: buffer edits.** `text.edit` as exact-text replacement, through `litria_changes_prepare` and `litria_changes_apply`. Plan identity, expiry and one execution claim. Buffer effects only. An approval surface is designed with the owner.
- **W3: native conditional operations.** Create-if-absent and replace-if-the-disk-revision-matches. These are the remainder of R2, with fault-injection proofs from the [Project API proposal](../ideas/brief-project-api-mcp.md) R2.
- **W4: durable operations.** Per-effect receipts, `litria_operations_get`, and recovery without replay (R5).

## Track T: runtime and transport (separate plan)

ADR-031's [implementation gates](brief-agent-integration.md#10-implementation-gates-and-unresolved-choices) come first:
- runtime and platform qualification;
- cloud and local model routes;
- authentication;
- foreground lifecycle.

Then:
- the bundled stdio MCP helper;
- authenticated local IPC bound to one project session;
- real principals, with grants from project grant records;
- small-context budget measurement.

A separate plan owns these once a runtime is chosen. No P or W slice may add a listener, socket or external process.

## Acceptance record

Done on acceptance (2026-09-30, PR #85). The items below are kept as written:

- **Amend the [agent integration brief §10](brief-agent-integration.md#10-implementation-gates-and-unresolved-choices) sequencing explicitly**, with a dated addendum. Its closing paragraphs list choices to settle "before coding" (including the helper transport and the native-tool capability set). They also put runtime qualification first in the "sensible implementation order", and place the build plan after the runtime spike. The owner's direction now builds the runtime-independent Project API (the P and W tracks) first, while every external exposure stays behind the qualification gates (track T). A pointer under §7 would leave that conflict standing.
- Add dated pointer notes to:
  - the [agent integration brief §7](brief-agent-integration.md#7-project-api-and-mcp-contract), pointing to the contract brief;
  - the [contract schemas brief §10](../contracts/brief-contract-schemas.md#10-open-questions), questions 2, 4, 5 and 6, pointing to the contract brief §12.

## Side findings (outside this plan)

These were found during the 2026-09-30 inspection and are tracked separately. They are not scheduled here:

- `delete_project_path` checks `is_symlink()` on an already-canonicalized path, so deleting an in-project link to an in-project directory would remove the directory itself. `move_project_path` resolves its source the same way, so moving a link would move its target (brief §16). Both are confirmed by reading the code, not reproduced, and belong in one separate fix. *(Fixed 2026-09-30 in PR #88. That fix also covers `remove_empty_directory` and a dangling link at the destination of a cross-device copy. Status: reproduced on all three platforms, then verified fixed on all three; see Agents/docs/adversarial-check-policy.md, learned flaw 6.)*
- `docs/rust-module-ownership.md` and `docs/rust-command-contracts.md` are stale (P1 refreshes only the entries it touches).
- The Domain Register omits `buildLogDomain` and `preferencesDomain`, and its introduction counts five guards where seven exist.
