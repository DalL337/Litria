# Project Switch Crash — Investigation & Fix Plan

**Status:** Open, investigation phase
**First confirmed:** 2026-04-08, App.jsx Shell Extraction Session 1 smoke test
**Reproduces on:** `main` at `d3d3d16` (post PR #35 + PR #36, the SQLite cutover)
**Branch for the fix:** TBD (open new branch from `main` per AGENTS.md branch lifecycle policy)

## Symptom

Switching from one open project to another via the recent-projects dropdown causes the app to crash. The crash is **silent on the JavaScript side** — devtools console (docked side-by-side prior to repro) shows no errors, no React warnings, nothing. The crash is in the native layer (Rust / Tauri / WebView2).

Circumstantial evidence at finding-time:

- 3 orphaned `conhost.exe` processes left behind (parents already dead)
- LED health staleness observed in the same session (green LED on a dirty file with diagnostics; grey parent-folder LED over green-children LEDs) — may or may not share root cause
- Live project switching demonstrably worked in earlier eras of this codebase, so this is a regression, not an architectural impossibility

## Why it matters

Live project switching is a flagship "no friction" interaction. The IDE-like fallback (close current → open next) exists but is explicitly *not* the desired flow — *"its not intuitive flow of conscious"* (2026-04-08).

---

## Phase 1 — Diagnose (DO NOT skip; do not start fixing without a backtrace)

The single most expensive mistake in this investigation would be to start patching things based on the audit findings below before confirming where the crash actually happens. Several of the issues found in the audit are real bugs but may not be *the* crash. We need a backtrace, a faulting module/offset, or at minimum a Rust panic message before committing to a fix.

### 1.1 — Capture Rust panic output from the dev terminal

The Rust side prints to the same terminal that runs `npm run tauri dev`, **not** the browser devtools console. JS-side silence is expected for native crashes.

```bash
RUST_BACKTRACE=1 npm run tauri dev
```

Then reproduce the crash (open project A → switch to project B). Watch the terminal that hosts the Tauri Rust process for:
- `thread 'main' panicked at ...`
- `thread '<thread name>' panicked at ...` (worker threads)
- `note: run with RUST_BACKTRACE=full environment variable to display a longer backtrace`
- `Access violation`, `STATUS_ACCESS_VIOLATION`, segfault-style messages
- `error: process didn't exit successfully` / non-zero exit code

If a panic message appears, **save it verbatim** into this doc under "Diagnosis Results" before doing anything else.

### 1.2 — Windows Event Viewer

After a confirmed crash repro, check:

> Event Viewer → Windows Logs → Application

Filter for source `Application Error` or `Windows Error Reporting` with `litria.exe` (or `litria-dev.exe` if dev build) as the faulting application. The entry will include:

- Faulting module name (e.g. `litria_lib.dll`, `WebView2.dll`, `ntdll.dll`, `KERNELBASE.dll`)
- Faulting module offset (hex)
- Exception code (e.g. `0xc0000005` access violation)

The faulting module narrows the crash to a layer:
- `WebView2.dll` / `msedgewebview2.exe` → WebView2 process crash, possibly from a JS-side issue that surfaces only natively
- `litria_lib.dll` → Rust panic that wasn't caught (or `panic = abort` somewhere we don't know about)
- `ntdll.dll` / `KERNELBASE.dll` → likely from a syscall in our code (PTY teardown, file handle, mutex)
- `rusqlite` / `sqlite3` symbol → SQLite-side fault (would actually rule SQLite **in**)

Save the relevant Event Viewer entry into this doc under "Diagnosis Results".

### 1.3 — Strategic `println!` instrumentation (only if 1.1 and 1.2 are inconclusive)

If RUST_BACKTRACE and Event Viewer both come up empty (the crash is genuinely below the panic handler), bisect the project-switch path with `eprintln!` checkpoints in this order:

1. Top of `db_open_project` ([src-tauri/src/db/commands.rs:132](../../../src-tauri/src/db/commands.rs#L132))
2. Just before `db::open_workspace_db` call (line 147)
3. Just before `let mut guard = lock.lock()...` and `*guard = Some(conn);` in `open_workspace_db` ([src-tauri/src/db/mod.rs:36-40](../../../src-tauri/src/db/mod.rs#L36-L40)) — this is where the previous Connection gets `Drop`'d under the lock
4. Top of `load_full_state` (called at line 148)
5. Just before `Ok(state)` at line 150
6. Top of `terminal_session_manager::teardown_all_sessions` ([src-tauri/src/terminal_session_manager.rs:281](../../../src-tauri/src/terminal_session_manager.rs#L281))
7. Inside the teardown loop at line 291, before `pty.teardown()`
8. Top of `lsp::session::teardown_all_sessions` ([src-tauri/src/lsp/session.rs:276](../../../src-tauri/src/lsp/session.rs#L276))

The last checkpoint that prints before the crash points at the offending region. Add a 10ms `std::thread::sleep` after each checkpoint to make sure stdout is flushed before the crash.

### 1.4 — Diagnosis Results (2026-04-08)

**RUST_BACKTRACE output:** *empty.* Terminal showed no panic message, only:

```
error: process didn't exit successfully: `target\debug\litria.exe` (exit code: 0xcfffffff)
```

The exit code `0xcfffffff` is non-standard (not a typical Windows exception code like `0xc0000005`). It is consistent with the host process exiting because its WebView2 child died, rather than a Rust panic.

**Windows Event Viewer entry:**

> Source: Windows Error Reporting (Application Hang category)
> Time: 2026-04-08
>
> The program msedgewebview2.exe version 146.0.3856.109 stopped interacting with Windows and was closed. To see if more information about the problem is available, check the problem history in the Security and Maintenance control panel.
>
> Process ID: 47c
> Application Path: `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\146.0.3856.109\msedgewebview2.exe`
> Report Id: 7146f986-21a5-46b6-afb6-b949272663a9
> **Hang type: Unknown**

**No `litria.exe` / `litria_lib.dll` Application Error entry. No faulting module from our Rust code.**

### 1.5 — Refined repro (2026-04-08, second pass)

The crash trigger has been narrowed significantly via experimental probing:

1. Start in project A (the complex Tauri/React/TS/Tailwind/shadcn dev test project)
2. Switch to project B (a smaller, cleaner project) → fine
3. Switch back to project A → fine
4. **Open the terminal drawer in A** (spawns a PTY session for A on the Rust side)
5. **Close the terminal drawer in A** (drawer hides, but Rust PTY session is still alive — see 1.6 below)
6. Switch from A back to B → **HANG** (Windows "not responding" dialog, WER kills msedgewebview2.exe)

**Critical refinement:** the terminal drawer was already CLOSED on the JS side at the moment of the switch. The user's mental model was "the terminal is gone." The Rust side had not received that signal — the PTY session was still loaded in `SESSIONS_BY_PROJECT[A]`, the child shell was still alive, and the reader thread was still pumping `channel.send(TerminalEvent::Output)` events through the Tauri IPC bridge.

**Without step 4, the crash does not occur.** Live project switching by itself works. Even with a brief terminal interaction followed by a close, switching does not crash *unless* the close-to-switch path leaves a leaked Rust session whose teardown happens during the next switch.

### 1.6 — Diagnosis interpretation

This is **not a Rust panic / native crash**. It is a **WebView2 renderer hang** — the main UI thread of the renderer process became unresponsive long enough (typically 5+ seconds of no message pump activity) that Windows watchdog declared it unresponsive and force-killed it. The Tauri host process then exited with `0xcfffffff` because its renderer child was gone.

This rules out:
- Scenario X (SQLite Connection drop crash)
- Scenario Y (Rust PTY teardown panic / native fault)
- Anything that would have produced a `litria.exe` / `litria_lib.dll` faulting module entry

This points squarely at **Scenario Z** (renderer issue), with the refinement that it is a *hang*, not a *crash*. The investigation now needs to identify *what is blocking the WebView2 main thread* during the switch when a terminal is active.

### 1.7 — The leaked session bug (root cause of the user's specific repro path)

[src/drawers/DrawerContentTerminal.jsx:42-46](../../../src/drawers/DrawerContentTerminal.jsx#L42-L46) is the only useEffect cleanup the terminal drawer has, and it is a *project-change reset*, not a close handler:

```js
useEffect(() => {
  spawnAttemptedRef.current = false;
  setChannel(null);
  setSessionId(null);
}, [projectId]);
```

There is **no** cleanup that calls `terminalDomain.commands.endForProject(projectId)` when the drawer hides, when `isVisible` flips false, or when the component unmounts. The xterm.js component on the inside ([TerminalRenderer.jsx:119-128](../../../src/components/TerminalRenderer.jsx#L119-L128)) disposes itself and sets `channel.onmessage = null`, which mutes the JS-side listener — but **Rust never gets told the session is over**.

Result: every time the user opens and closes the terminal drawer, a fully-alive PTY session leaks in `SESSIONS_BY_PROJECT`. The child shell process is still running, the reader thread is still calling `channel.send()`, and the events accumulate in the Tauri IPC queue with no JS-side listener consuming them. The leak persists until either the user re-opens the terminal for the same `project_id` (in which case `start_pty_session` cleans up the prior entry — see [terminal_session_manager.rs:81-94](../../../src-tauri/src/terminal_session_manager.rs#L81-L94)) or until the next project switch fires `teardownAll` from `useTerminalLifecycle`.

The next switch is when the leak is collected — and that is exactly when the WebView2 hang manifests.

### 1.8 — Working hypothesis

When a terminal session in B is active at the moment of the switch back to A, the Rust PTY reader thread is still running and still calling `channel.send(TerminalEvent::Output { chunk })` through the Tauri `Channel` IPC bridge. The shutdown flag in [terminal_pty.rs:171-193](../../../src-tauri/src/terminal_pty.rs#L171-L193) is checked at the *top* of the read loop, but the thread spends most of its wall-clock time blocked inside `reader.read(&mut tmp)`, which is a Windows pipe syscall that does **not** observe the shutdown flag. The pipe only unblocks when the master half is closed.

The master pipe is owned by `PtySession.master` ([terminal_pty.rs:65-74](../../../src-tauri/src/terminal_pty.rs#L65-L74)) and only drops when `PtySession` itself is dropped. Inside `teardown()` ([terminal_pty.rs:295-314](../../../src-tauri/src/terminal_pty.rs#L295-L314)):

```rust
pub(crate) fn teardown(&mut self) -> Option<i32> {
    self.shutdown.store(true, Ordering::SeqCst);
    // ... flush writer ...
    let exit_code = self.wait_or_kill();   // up to 2s for child wait
    if let Some(handle) = self.reader_handle.take() {
        let _ = handle.join();             // ← UNBOUNDED, blocks until reader exits
    }
    exit_code
}
```

`wait_or_kill()` only addresses the child process. The `join()` on the reader thread is **unbounded** — it waits for the reader to return, which only happens when the pipe `read()` returns Err or 0, which only happens when the master is closed, which only happens when `PtySession` drops, which is *after* `teardown()` returns. Classic ordering bug.

Meanwhile on the JS side, [src/terminal/useTerminalLifecycle.js:10-20](../../../src/terminal/useTerminalLifecycle.js#L10-L20) calls `terminalDomain.commands.teardownAll()` *fire-and-forget* (not awaited). The terminal pane component for B is being unmounted by React in the same render. While all that is happening, the reader thread on the Rust side keeps pushing `Channel::send` events at the WebView2 IPC bridge. The IPC queue backs up faster than the (busy unmounting/rendering) WebView2 main thread can drain it. Eventually Windows declares the UI thread unresponsive and force-kills the renderer.

**This hypothesis is unproven.** Alternative plausible hangs include:
- xterm.js `dispose()` doing something synchronous and slow during the unmount
- React render loop triggered by `_dbState` reference change in `useProjectPersistence`
- Some other useEffect cleanup blocking the unmount path

The fix plan in Phase 4 addresses the root cause regardless of which exact mechanism is blocking the message pump (proper teardown ordering, awaited cleanup, terminal-specific teardown before the switch fires).

---

## Phase 2 — Audit Findings (already known; do not let these distract from Phase 1)

These two regressions were found by code audit on 2026-04-08. They are real and need fixing regardless of whether they are *the* crash. **They are listed here so they're not forgotten, not so they can be fixed first.**

### Finding A — `PtySession` has no `Drop` impl

[src-tauri/src/terminal_pty.rs:65-74](../../../src-tauri/src/terminal_pty.rs#L65-L74) defines `PtySession` with a reader thread `JoinHandle`, an `AtomicBool` shutdown flag, and (on Windows) a `win32job::Job`. `teardown()` is the *only* path that:

1. Sets the shutdown flag
2. Force-flushes the writer
3. Waits/kills the child with timeout
4. Joins the reader thread

If a `PtySession` is dropped without `teardown()` being called explicitly, the reader thread is **detached and leaked**. The Windows Job object backstop kills the child process via `kill_on_job_close`, which is good — but the reader thread on the Rust side leaks.

**Why this matters for the crash:** `start_pty_session` ([src-tauri/src/terminal_session_manager.rs:81-94](../../../src-tauri/src/terminal_session_manager.rs#L81-L94)) does correctly call `teardown()` on existing entries when replacing a session for the same `project_id`. **But on a project switch, the OLD project's session entry is keyed by the OLD `project_id` and is never replaced** — it just sits in `SESSIONS_BY_PROJECT` forever, alive, until the next time someone happens to re-open a project with the exact same ID, or the app exits.

This is a strong candidate for the orphan conhost evidence.

### Finding B — Project-switch flow has inverted teardown ordering

[src/app/useProjectLaunch.js:108-137](../../../src/app/useProjectLaunch.js#L108-L137) (`handleOpenProjectInstance`) does:

```js
const projectState = await dbOpenProject(trimmedRootPath);  // ← Rust swaps PROJECT_DB
setProjectInstance({ ...new instance });                     // ← React re-renders
```

There is **no** call to `db_close_project`, **no** awaited teardown of terminals / LSP / watchers, and **no** coordinator function for "switch project". On the Rust side, [src-tauri/src/db/mod.rs:36-40](../../../src-tauri/src/db/mod.rs#L36-L40) silently overwrites the global `PROJECT_DB` (the previous `Connection` is dropped *under the lock*).

The cleanup that *does* exist is fanned out across React useEffects:

| Hook | Location | Trigger | Action |
|---|---|---|---|
| `useTerminalLifecycle` | [src/terminal/useTerminalLifecycle.js:10](../../../src/terminal/useTerminalLifecycle.js#L10) | `instanceId` change | `terminalDomain.commands.teardownAll()` |
| `useTsLspLifecycle` | [src/app/useTsLspLifecycle.js:27](../../../src/app/useTsLspLifecycle.js#L27) | `instanceId` change | `teardownTsLifecycle()` |
| `usePythonLspLifecycle` | similar | `instanceId` change | similar |
| `useDiscoveryLifecycle` | [src/App.jsx:532](../../../src/App.jsx#L532) | `rootPath` change | discovery teardown |
| `useProjectPersistence` (hydration) | [src/project/useProjectPersistence.js:126](../../../src/project/useProjectPersistence.js#L126) | `instanceId` change | hydrates *new* state |

**These all run AFTER `setProjectInstance` causes the re-render.** So the actual sequence today is:

1. `dbOpenProject(B)` → Rust: drops old SQLite Connection under the lock, opens B's Connection. (~ms)
2. JS resolves the promise, calls `setProjectInstance(B)`.
3. React commits → effects run in registration order:
   a. `useProjectPersistence` hydrates pieces/groups/connections/viewport from B's `_dbState` — sets pieces array to B's pieces (now stale references to A's files have been replaced).
   b. `useProjectPersistence` async `readFile` loop reads each of B's files from disk via `projectDomain.commands.readFile`.
   c. `useTerminalLifecycle` calls `teardownAll` — A's terminals finally get torn down. **But A's `project_id` doesn't match anything in the new state**, and the teardown is actually `teardown_all_sessions`, which drains the whole map. Good — at least sweeping.
   d. `usePythonLspLifecycle` / `useTsLspLifecycle` tear down old LSP sessions for the old `project_id`.
   e. `useDiscoveryLifecycle` tears down on `rootPath` change.

During step 3a-3b, any in-flight Tauri command from before the switch (debounced viewport write, debounced editor state write, in-flight piece update from old session) lands in **B's** database, not A's. That's data corruption, not a crash — but it shows the seams are loose.

**The crash vector hidden in this:** if any of those late teardown calls (especially LSP `stop_session` or terminal `teardown_all`) panics — for example because a child process's stdin is already closed, a Mutex is poisoned from a previous panic, or an `unwrap()` hits a `None` — and the panic strategy in this build is `abort`, the whole process dies.

We don't currently know if this build uses `panic = "unwind"` or `panic = "abort"`. `Cargo.toml` doesn't specify it, so the default is `unwind`. **But** Tauri internally may translate panics to abort in some paths, and `Mutex::lock().unwrap()` on a poisoned mutex inside a Tauri command will panic; if that panic isn't caught by Tauri's command wrapper, it propagates.

### Finding C (suspicion, not yet evidence)

`session.transport.kill()` is called inside `teardown_all_sessions` for LSP **while the global `SESSIONS` mutex is still held** ([src-tauri/src/lsp/session.rs:276-284](../../../src-tauri/src/lsp/session.rs#L276-L284)). That's a violation of the AGENTS.md "Mutex / Lock Hold Duration" engineering rule (don't hold a lock across slow operations). It's not the crash itself (no other thread is contending the same lock during shutdown), but it's a smell, and if `kill()` itself panics under the lock, the mutex becomes poisoned for the rest of the session — and any subsequent command that calls `sessions().lock().unwrap()` will panic the calling thread.

---

## Phase 3 — Implementation Plan (finalized 2026-04-08)

After diagnosis (Phase 1), an audit pass that surfaced and corrected several wrong hypotheses (Z.5 v1 was implemented and reverted — see history at commits 00f64e9 and ee58825), and a step-back design discussion with the user, the plan was finalized as five phases below. The earlier Scenario X / Y / Z and Z.1-Z.5 framings are kept further down this document as a historical record but are superseded by the plan in this section.

### Plan goal

When the user switches between projects, every per-project subsystem (terminals, LSP servers, SQLite connection, file write timers) tears down cleanly and bounded-in-time before the new project's setup begins, with no leaked OS resources, no race windows, no UI hangs, and no surprises about which project a save lands in.

### Why the fix is more than "patch the crash"

The crash is one symptom of a deeper structural issue: nobody owns the project-switch sequence. Today the switch is "JS calls `dbOpenProject` and hopes that five separate React useEffects fan out, do their cleanups in some order, finish before the new render commits, and don't trip over each other." That's brittle by design. The crash is the first time that brittleness escalated to a hang. The plan introduces an explicit owner (a coordinator function) and the supporting hardening that lets the owner work reliably.

For the coordinator to be tractable, each subsystem it orchestrates needs a teardown call that is awaitable from JS, completes in bounded time, doesn't leak threads/processes/file handles, and reports its status. The terminal subsystem currently violates all four. So the plan fixes the terminal subsystem first (Phases 1, 2, 4), then builds the coordinator on top of it (Phase 3), then validates everything end-to-end (Phase 5).

---

### Phase 1 — Terminal becomes a per-project React resource

**What:** Make `DrawerContentTerminal` mount and unmount with the project, instead of persisting across switches. Add a single unmount-only `useEffect` that calls `endForProject(projectId)` on cleanup. No `isVisible` in its deps, so it can't fire on toggle and kill a spawning session — that was the failure mode of Z.5 v1.

**How:**
1. In [src/drawers/TopDrawerShell.jsx](../../../src/drawers/TopDrawerShell.jsx) L66-77, add `key={projectInstance?.instanceId ?? 'no-project'}` to the wrapper div that holds the cloned drawer content for the terminal drawer. (Per-drawer key, not on the map iteration key — the iteration already uses `drawer.id`.)
2. In [src/drawers/DrawerContentTerminal.jsx](../../../src/drawers/DrawerContentTerminal.jsx), add a new `useEffect` keyed on `[projectId, terminalDomain]` (NO `isVisible`) whose cleanup calls `terminalDomain.commands.endForProject(projectId)` if `spawnAttemptedRef.current` is true.

**Why this works where Z.5 v1 didn't:** Z.5 v1 had `isVisible` in the dep array, which meant the cleanup fired on the open transition (false → true) as well as on close, killing the just-spawned session. This effect's deps don't include `isVisible`, so it only fires on project change or unmount — both of which are correct moments to end the session.

**Validation gate:** Run dev build. Open terminal in A, type some commands, switch to B → terminal disappears (correct), open terminal in B → fresh shell rooted in B (correct), switch back to A → terminal disappears in B, A starts with no terminal (correct), open terminal in A → fresh shell. Then run the original crash repro (open terminal in A, close drawer, switch to B) — should not hang.

**Files:** `src/drawers/TopDrawerShell.jsx`, `src/drawers/DrawerContentTerminal.jsx`.

---

### Phase 2 — Bounded-time teardown in Rust

**What:** Fix the unbounded `reader_handle.join()` in `PtySession::teardown` ([src-tauri/src/terminal_pty.rs:295-314](../../../src-tauri/src/terminal_pty.rs#L295-L314)) so the reader thread join can never hang indefinitely. Add a defensive `Drop` impl as a backstop for any code path that forgets to call teardown explicitly.

**How:**
1. Migrate `master: Box<dyn MasterPty + Send>` to `Option<Box<dyn MasterPty + Send>>`. Same for `writer`. This is the structural change that makes step 2 legal — we need to take ownership of the master pipe out of `&mut self`.
2. Reorder `teardown()` so the master is dropped *before* joining the reader thread:
   - Set shutdown flag
   - Flush writer
   - `wait_or_kill()` (existing 2s child wait/kill)
   - **Drop the master pipe** (`self.master.take()`) — closes the read half from the host side, causes `reader.read()` to return Err, the reader loop exits
   - Join the reader thread (now bounded — should complete in ms)
3. Add a join timeout backstop using a worker thread + 5s deadline. If join doesn't complete in time, force-detach via `mem::forget` or similar and log a warning. In normal operation the reorder makes the join complete in milliseconds; the timeout exists only for "the OS pipe did something weird" cases.
4. `impl Drop for PtySession { fn drop(&mut self) { if self.reader_handle.is_some() { let _ = self.teardown(); } } }`. The `is_some()` check tracks whether teardown has already run.

**Files:** `src-tauri/src/terminal_pty.rs` only. Struct migration ripples to `resize()`, `write_input()`, `pause_output()`, `resume_output()` call sites in the same file (mechanical `as_ref().unwrap()` updates).

**Validation gate:** `cargo test` — existing terminal tests should pass. Add a regression test that constructs a `PtySession`, drops it without calling `teardown()` explicitly, and verifies the child process is dead and the reader thread joined within 5 seconds.

---

### Phase 3 — The project-switch coordinator

**What:** Replace the current `handleOpenProjectInstance` ("open new, hope cleanups happen") with an explicit sequence: stop old, await, swap, start new.

**How:** Rewrite [src/app/useProjectLaunch.js handleOpenProjectInstance](../../../src/app/useProjectLaunch.js#L108-L137) as:

```js
async function handleOpenProjectInstance({ rootPath }) {
  // Validation...

  // If a project is currently open, tear down its per-project workers.
  // Each step awaited with a timeout safety net so a hung subsystem
  // can't lock the UI forever.
  if (projectInstance && projectInstance.instanceId) {
    await withTimeout(terminalDomain.commands.teardownAll(), 5000, 'terminal teardown');
    await withTimeout(languageSupportDomain.commands.teardownTsLifecycle(), 5000, 'ts lsp teardown');
    await withTimeout(languageSupportDomain.commands.teardownPythonLifecycle(), 5000, 'python lsp teardown');
    flushPendingFilesystemWrites();   // synchronous flush of debounced writes for OLD project
    await dbCloseProject();           // close OLD SQLite cleanly
  }

  // Open NEW project — Rust opens fresh connection, returns hydrated state.
  const projectState = await dbOpenProject(rootPath);

  // Swap React state. Hydration useEffects fire as today, but only see the
  // NEW instanceId from this point. Old project has no leftover workers.
  setProjectInstance(buildInstanceFromState(projectState, rootPath));
}
```

`withTimeout` is a small helper (`src/utils/withTimeout.js`, ~10 lines) that races a promise against a timeout, logging and returning on timeout rather than throwing.

The existing per-subsystem useEffects (`useTerminalLifecycle`, `useTsLspLifecycle`, `usePythonLspLifecycle`) stay in place but become **backstops for the unmount case** (app close, project close-without-replace). The coordinator handles the project-switch case explicitly. No more fighting over who owns the cleanup.

**Files:** `src/app/useProjectLaunch.js` (rewrite), `src/App.jsx` (pass `terminalDomain`, `languageSupportDomain`, `flushPendingFilesystemWrites` to `useProjectLaunch`), new `src/utils/withTimeout.js`.

**Validation gate:** Domain tests + architecture guards + the full repro matrix subset (Phase 5).

---

### Phase 4 — Drawer-close cleanup with transition-detecting ref

**What:** Eliminate the small "leak per drawer toggle within a single project session" remaining after Phases 1-3. When the user collapses the terminal drawer without switching projects, end the Rust session immediately rather than letting it linger until the next switch.

**Why this comes after Phase 3 and not before:** Z.5 v1 used a useEffect-cleanup pattern that fired at unintended moments and killed the spawning session. The transition-ref pattern below is structurally different — it has no cleanup function, it acts only on a specifically-detected state transition, and it's testable in isolation against a known-good baseline (Phases 1-3).

**How:** Add to [src/drawers/DrawerContentTerminal.jsx](../../../src/drawers/DrawerContentTerminal.jsx):

```jsx
const wasVisibleRef = useRef(false);
useEffect(() => {
  // Only act on the specific transition: drawer was open, now is closed.
  // Does NOT use a useEffect cleanup — uses a transition-detecting ref so
  // it only fires when isVisible specifically goes true → false.
  if (wasVisibleRef.current && !isVisible) {
    if (spawnAttemptedRef.current && projectId && terminalDomain) {
      terminalDomain.commands.endForProject(projectId);
      spawnAttemptedRef.current = false;
      setChannel(null);
      setSessionId(null);
    }
  }
  wasVisibleRef.current = isVisible;
}, [isVisible, projectId, terminalDomain]);
```

**Why this is safe vs. Z.5 v1:** Z.5 v1 used a `useEffect` whose cleanup fired on every dep change including the open transition. This effect uses a ref-based comparison inside the effect body, with no cleanup. It only takes action when `wasVisible (true) && !isVisible (false)` — i.e., specifically the close transition. On the open transition, the condition is `false && true = false`, no action. On any non-isVisible dep change, the condition compares the unchanged isVisible against itself, no action.

**Files:** `src/drawers/DrawerContentTerminal.jsx`.

**Validation gate:** Open terminal, type, close drawer (verify Rust session ends — process explorer or println debug), reopen terminal (should spawn fresh session, see banner). Plus the full Phase 1 validation flow to confirm no regression.

---

### Phase 5 — Full validation matrix

Mandatory before merge. Manual exercise of the following scenarios with a fresh `npm run tauri dev`:

| # | Scenario | Expected behavior |
|---|---|---|
| 1 | Switch with no terminal in either project | Clean, no hang (preserves baseline) |
| 2 | Switch with terminal open in OLD project | OLD terminal disappears; NEW project starts with no terminal |
| 3 | Switch, open terminal in NEW project | Fresh shell rooted in NEW project's directory |
| 4 | Switch with terminal closed (collapsed) but session leaked in OLD | Coordinator's awaited teardown collects the leak; no hang |
| 5 | Rapid switch A→B→A→B 5x with terminals open in both | No accumulation, no orphan conhosts in Task Manager, no hang |
| 6 | Switch with TS LSP active in OLD project | LSP gracefully terminates; NEW project's LSP starts fresh on next .ts file open |
| 7 | Switch with Python LSP active in OLD project | Same as #6 for Python |
| 8 | Switch with both TS LSP and terminal active in OLD | Both tear down in order; no race |
| 9 | Switch with dirty editor tabs | Save prompt fires (existing behavior); after save, switch completes cleanly |
| 10 | Switch with debounced viewport save in flight | Save lands in OLD project's DB (correct), not NEW |
| 11 | Open project, terminal, then close window/quit app | All resources released; no orphan processes after exit |
| 12 | Drawer collapse without project switch (Phase 4 specific) | Rust session ends immediately on collapse; reopen spawns fresh session |
| 13 | Drawer collapse + reopen multiple times in same project | Each cycle creates and destroys a session; no accumulation |

After each manual test, check Task Manager for orphan processes:
- `conhost.exe` (PTY children — should be zero after teardown)
- `node.exe` (TS LSP children, except the dev server)
- `python.exe` (Python LSP children)

After all manual tests pass, run the standard test trio:
- `npm run check:architecture`
- `npm run test:domains`
- `npm run build`

Plus `cargo test` in `src-tauri/` for the Rust changes.

---

### Out of scope (deliberately deferred)

- **IDE-traditional close-then-open as a UX option.** Considered and parked. The plan above gives robust live switching, which is what the user wanted in the first place. If after living with it for a while the maintenance cost outweighs the UX benefit, a future PR could add a "close project" button that uses the unmount path.
- **Background terminals** (sessions that survive drawer collapse and project switch). Currently every drawer collapse and every project switch tears down the terminal. If a "watch tests" persistent terminal is ever needed, it becomes a deliberate feature with its own UX (a pin button, a separate "background tasks" panel).
- **Multi-terminal-per-project.** Currently each project has at most one terminal session. Tabs / panes / multiple terminals would be a separate feature.
- **Monaco editor model cleanup on project switch.** Monaco has a global model cache that survives React unmounts. There may be a similar latent bug ("models for files in project A persist after switching to B") but it's not part of the current crash and hasn't been investigated.
- **File watchers.** Litria doesn't currently watch the filesystem for external changes. Future addition would need to plug into the coordinator.
- **Refactoring `useTerminalLifecycle` / `useTsLspLifecycle` / `usePythonLspLifecycle` out of existence.** They become backstops after the coordinator lands; removing them entirely would be a separate cleanup pass.

---

## Appendix — Earlier Fix Plan Sketches (superseded)

The sections below are the earlier fix-plan sketches that preceded the finalized Phase 3 plan above. They are kept for historical context — they show how the diagnosis evolved from "we don't know what scenario this is" through "scenario Z confirmed, here's the Z.1-Z.5 fix" to the current shape. They should not be used as a guide for implementation; the canonical plan is Phase 3 above.

### Scenario X — Crash is in SQLite Connection drop

If the backtrace points at `rusqlite::Connection::Drop` or `sqlite3_close`, the issue is that the previous Connection is being dropped while a worker thread or in-flight command still holds a borrow / statement / transaction. Fix:

1. Add a `db_close_project` call to JS `handleOpenProjectInstance` *before* `dbOpenProject(newPath)`.
2. In Rust `db_open_project`, take a brief lock, swap the `Option<Connection>` with `None`, release the lock, then `drop()` the old connection *outside* the lock. Same shape as `start_pty_session`.
3. Add a guard in `with_workspace_db` that returns a clean error rather than panicking if the connection is `None`.

### Scenario Y — Crash is in PTY/terminal teardown or Job object closure

If the backtrace points at `portable_pty`, `win32job`, `CloseHandle`, `KERNELBASE`, or the reader thread's pipe Read:

1. **Add `Drop for PtySession`** that just calls `self.teardown()`. This makes the cleanup unconditional regardless of how the session is removed. Use `take()` on `Option<JoinHandle>` to make Drop safe (no double-join).
2. **Move terminal teardown to BEFORE `dbOpenProject`** in the JS coordinator (Phase 4). Current order has terminals being torn down inside the *next* render's effects, which is too late.
3. Add a `terminal_session_end_for_project` Tauri command and call it explicitly with the OLD `project_id` before the switch, so the cleanup is targeted rather than sweeping.

### Scenario Z — WebView2 renderer hang during project switch with active terminal ✅ CONFIRMED

The actual diagnosis (see Phase 1.6). The fix has three independent components, listed in order of importance. They should ideally all land in a single PR, but the first one alone is most likely to resolve the visible crash.

#### Z.1 — Tear down terminal sessions BEFORE the project switch, not after, and AWAIT the teardown

Currently in [src/app/useProjectLaunch.js:108-137](../../../src/app/useProjectLaunch.js#L108-L137), `handleOpenProjectInstance` does:

```js
const projectState = await dbOpenProject(trimmedRootPath);
setProjectInstance({ ... new instance ... });
```

There is no terminal teardown here. The teardown happens *later*, inside [useTerminalLifecycle](../../../src/terminal/useTerminalLifecycle.js#L10-L20), which fires after `setProjectInstance` causes the next render — and is fire-and-forget (`terminalDomain.commands.teardownAll()` is not awaited).

The fix is to make the project-switch flow do the teardown synchronously *before* swapping anything:

```js
const handleOpenProjectInstance = useCallback(async ({ rootPath }) => {
  // ... validation ...

  // 1. Tear down terminal sessions for the OLD project FIRST.
  //    Awaited so we don't proceed until the Rust side has joined the
  //    reader thread and dropped the PtySession.
  if (projectInstance) {
    try {
      await terminalDomain.commands.teardownAll();
    } catch (e) {
      console.warn('[switch] terminal teardown failed:', e);
      // Proceed anyway — better to switch with a leak than to block forever
    }
  }

  // 2. NOW open the new project's SQLite (Rust drops the old Connection).
  let projectState;
  try {
    projectState = await dbOpenProject(trimmedRootPath);
  } catch (err) { ... }

  // 3. Swap React state.
  setProjectInstance({ ... });
}, [...]);
```

This requires `useProjectLaunch` to receive `terminalDomain` and `projectInstance` as inputs, which is a small interface change.

The existing `useTerminalLifecycle` effect is kept as a backstop for the unmount case and any switch path that doesn't go through `useProjectLaunch`. It is no longer the primary teardown route for the project-switch case, but it does no harm to leave it.

#### Z.2 — Fix the unbounded `reader_handle.join()` in `PtySession::teardown`

[src-tauri/src/terminal_pty.rs:295-314](../../../src-tauri/src/terminal_pty.rs#L295-L314) has an ordering bug: the reader thread is joined while the master pipe is still alive. Because the reader is blocked in a Windows pipe `read()` syscall and the shutdown flag is only checked at the *top* of the loop, the join can hang forever.

The fix is to **drop the master pipe before joining the reader**, so the read() syscall returns Err and the loop exits:

```rust
pub(crate) fn teardown(&mut self) -> Option<i32> {
    self.shutdown.store(true, Ordering::SeqCst);
    self.flow_control.resume();

    if let Ok(mut writer) = self.writer.lock() {
        let _ = writer.flush();
    }

    let exit_code = self.wait_or_kill();

    // Close the master pipe BEFORE joining the reader thread.
    // The reader is blocked in reader.read(); dropping the master closes
    // its half of the pipe, which causes read() to return Err and the
    // reader loop to exit. Without this, join() can hang indefinitely
    // because the shutdown flag is only checked at the TOP of the loop.
    //
    // The master is replaced with a sentinel via mem::replace; this is
    // necessary because we cannot move out of `&mut self`.
    drop(std::mem::replace(
        &mut self.master,
        // ... or use Option<Box<dyn MasterPty>> on the struct field
    ));

    if let Some(handle) = self.reader_handle.take() {
        let _ = handle.join();
    }

    exit_code
}
```

The cleanest implementation changes `master` from `Box<dyn MasterPty + Send>` to `Option<Box<dyn MasterPty + Send>>` so we can `master.take()` cleanly. Same for `writer`. This is a small struct refactor.

**Add a teardown timeout** as belt-and-braces: spawn the join on a separate thread with a timeout (2-5 seconds), and force-detach if it doesn't complete. This ensures `teardown()` always returns in bounded time even if the OS pipe does something weird.

#### Z.3 — Implement `Drop for PtySession` as a backstop

[Finding A from the audit](#finding-a--ptysession-has-no-drop-impl). Even after Z.1 and Z.2, defensive Drop ensures cleanup happens unconditionally. If a future code path forgets to call `teardown()` explicitly, Drop catches it.

```rust
impl Drop for PtySession {
    fn drop(&mut self) {
        if self.reader_handle.is_some() {
            // teardown() hasn't been called — call it now as backstop
            let _ = self.teardown();
        }
    }
}
```

#### Z.4 — Fold `Option` migration of `master`/`writer` into Z.2

Mentioned above. Worth calling out separately because it's the structural change that makes Z.2's `drop(self.master)` legal.

#### Z.5 — Drawer-close needs to call `endForProject` ✅ root cause of the user's specific repro path

This is the missing piece that lines up "drawer closed in UI" with "PTY session ended in Rust." Without it, every open-then-close cycle on the terminal drawer leaks a live PTY session into `SESSIONS_BY_PROJECT`. See section 1.6 for the bug, and section 1.5 for the user-visible repro that exposed it.

Fix: add an explicit "session lifecycle" effect to [src/drawers/DrawerContentTerminal.jsx](../../../src/drawers/DrawerContentTerminal.jsx) that:

1. **On unmount**, calls `terminalDomain.commands.endForProject(projectId)` if a session is active.
2. **On `isVisible` going from true → false** (drawer collapse), also calls `endForProject`. This is a deliberate UX choice — closing the terminal drawer ends the shell session. If we want a "background terminal" UX where the session survives drawer collapse, that's a different design decision and Z.5 should be limited to the unmount path only. **Recommended:** end the session on collapse for now. Background terminals can be a future feature.
3. Make sure `spawnAttemptedRef`, `channel`, and `sessionId` get reset whenever the session is ended, so a re-open spawns a fresh session.

```js
// In DrawerContentTerminal.jsx
useEffect(() => {
  return () => {
    if (projectId && terminalDomain) {
      // Fire-and-forget on unmount is OK — React doesn't wait for unmount cleanup
      terminalDomain.commands.endForProject(projectId);
    }
  };
}, [projectId, terminalDomain]);

useEffect(() => {
  // When drawer collapses (isVisible: true → false), end the session
  if (!isVisible && spawnAttemptedRef.current && projectId && terminalDomain) {
    terminalDomain.commands.endForProject(projectId);
    spawnAttemptedRef.current = false;
    setChannel(null);
    setSessionId(null);
  }
}, [isVisible, projectId, terminalDomain]);
```

Z.5 alone, without Z.1/Z.2/Z.3, would *probably* fix the user's specific repro because there would no longer be a leaked session waiting to be torn down at switch time. But Z.1/Z.2/Z.3 are still needed for defense-in-depth: any future code path that ends up with a leaked session (e.g., a future "background terminal" feature, a crash in the close handler, a renamed component that forgets the cleanup) would re-create the same hang. The only way to make the system robust to leaked sessions is to fix the teardown ordering bug in Rust.

### Implementation order

When implementing, do them in this order:

1. **Z.5 first** — fixes the user's repro most directly, smallest change, lowest risk
2. **Z.2 + Z.4** — Rust teardown ordering fix, makes the system robust
3. **Z.3** — Drop backstop, defense in depth
4. **Z.1** — JS coordinator: tear down terminals before `dbOpenProject`, awaited. This is structural cleanup that would have prevented the bug from being possible regardless of whether Z.5 existed; do it last because it's the largest interface change

Validate after each step. If Z.5 alone fixes the repro, that's a strong signal. Continue with Z.2/Z.3/Z.1 anyway to harden the system, but they're now bug-prevention rather than bug-fix work.

---

### Earlier coordinator sketch

After the immediate crash is fixed, introduce a single coordinator that owns the project-switch sequence end-to-end. This eliminates the fan-out-via-useEffects pattern and gives us a clear audit point.

Sketch (location: `src/app/useProjectSwitch.js` or fold into `useProjectLaunch.js`):

```js
async function switchToProject(rootPath) {
  // 1. Signal intent: stop accepting new state writes for the OLD project
  flushAllDebouncedWrites();         // viewport, editor state, etc.

  // 2. Tear down OLD project workers (in dependency order)
  await terminalDomain.commands.teardownAll();
  await languageSupportDomain.commands.teardownTsLifecycle();
  await languageSupportDomain.commands.teardownPythonLifecycle();
  await syntaxDomain.commands.teardown();
  await discoveryDomain.commands.teardown();

  // 3. Close the OLD SQLite connection cleanly
  await dbCloseProject();

  // 4. Open the NEW project (Rust opens fresh connection, returns hydrated state)
  const projectState = await dbOpenProject(rootPath);

  // 5. Swap React state to NEW project
  setProjectInstance({ ...buildInstanceFromState(projectState) });

  // 6. Hydration and per-project workers spin up via existing useEffects
  //    (they only see the NEW instanceId from this point forward)
}
```

**Why this is the right shape:** it makes the teardown cascade ordering explicit (matches AGENTS.md "Teardown Cascade Ordering" rule), it makes the coordinator the *single* place where switch logic lives, and it lets the existing per-project hooks keep their per-project setup logic without being responsible for cross-project cleanup.

The existing useEffects that *react* to `instanceId` change for cleanup become redundant for the project-switch case (the coordinator handles it explicitly), but should be kept for the **unmount** case (app close, project close-without-replace).

---

### Earlier validation guidance

1. Repro the original failure on `main` to confirm crash still happens (record exact steps, including initial project + target project + any open tabs/terminals at switch time).
2. Apply the targeted fix from Phase 3.
3. Repro again — should not crash.
4. Apply the Phase 4 coordinator.
5. Repro again with all the variants:
   - Switch with no terminals open
   - Switch with one terminal open in OLD project
   - Switch with terminals + Python LSP active in OLD project
   - Switch with terminals + TS LSP active in OLD project
   - Switch with dirty editor tabs in OLD project (verify save prompt still works)
   - Switch back-and-forth A → B → A → B rapidly (5×)
6. After each successful repro, check Task Manager for:
   - Orphan `conhost.exe` processes (should be zero)
   - Orphan `node.exe` (TS LSP) (should be zero — except the dev server's vite node)
   - Orphan `python.exe` (should be zero)
7. Run the standard test trio:
   - `npm run check:architecture`
   - `npm run test:domains`
   - `npm run build`
8. Verify Rust tests still pass (`cargo test` in `src-tauri/`).

---

## Notes / Open Questions

- **Cargo.toml** currently has no `[profile.dev]` / `[profile.release]` section, so panic strategy is the Cargo default (`unwind` for both dev and release). Confirm this hasn't been overridden by Tauri's bundler config.
- **The `M src-tauri/Cargo.toml` line in `git status`** is the long-standing CRLF noise (memory entry "Hygiene Snapshots"), unrelated to this investigation.
- **The LED health staleness** observed in the same session may share a root cause with the project-switch crash (both involve stale-state-after-mutation). Worth re-checking after the fix.
- **Branch policy**: per AGENTS.md, this gets its own new branch off `main`. Suggested name: `fix/project-switch-crash`. Bug fix → `fix/*` prefix.
