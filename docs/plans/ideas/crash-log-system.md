# Crash Log System — Beta Design

> **Status**: Delivered — shipped as PR #104 (2026-07-06, the day after this
> design), owner-verified via taskkill→banner. All five capture hooks live.
> Known residuals: macOS engine-death hook is a marker backstop until wry
> exposes the Darwin hook; per-surface error boundaries and the soft-crash
> status-line indicator remain deferred; `REPO_ISSUE_BASE` must be
> repointed at a public repo before external beta (assisted reports 404
> while this repo is private). *(Status corrected 2026-07-28 — this banner
> had never been flipped from Draft.)*
> **Author**: DalL337 + Claude
> **Date**: 2026-07-05
> **Scope discipline**: beta-grade, deliberately not meaty. Catch crashes from every layer
> (React, JS-outside-React, Rust, Tauri/hard death), attribute them (what error, where in code,
> what the user was doing), and give the user a low-friction path to report. Local-only,
> assisted reporting, zero server infrastructure. Not telemetry.

---

## Posture (decided 2026-07-05)

- **Local + assisted report.** Crash logs are local files, never auto-sent. The report action
  opens a pre-filled GitHub issue in the browser — the user sees exactly what's shared and
  attaches the log file themselves.
- **Both notice modes.** Hard crashes surface via a **next-launch notice**; soft (renderer)
  crashes surface **immediately** in the React error boundary's fallback screen, which can
  render because React's host survived.
- The next-launch notice is an **inline banner, not a modal** — per the standing
  no-questionnaire-modal rule (modals conflict with the IDE window).

Current state: a 2026-07-05 audit found **zero existing capture** — no error boundary, no
`window.onerror`/`unhandledrejection` handler, no Rust panic hook, no logging crate. All four
hooks below are greenfield.

---

## Capture matrix

| # | Layer | Failure mode | Hook | What we get |
|---|---|---|---|---|
| 1 | React | Throw during render/lifecycle | Top-level `ErrorBoundary` (class, `componentDidCatch`) | Error + message + **componentStack**; app keeps running behind a fallback screen |
| 2 | JS outside React | Event handlers, async code, promise rejections — **including Konva canvas callbacks, which never reach a React boundary** | `window.onerror` + `unhandledrejection` listener, installed once in `main.jsx` | Message, source file, line:col, stack |
| 3 | Rust | Panic in any backend thread | `std::panic::set_hook` in `main` before the Tauri builder | Panic payload + `file:line` location + forced backtrace (`Backtrace::force_capture`, no env var needed) |
| 4 | Webview process death | WebView2's separate OS process crashes (renderer, GPU) or hangs — **no Rust panic fires, and the JS world is dead, so hooks 1–3 all miss it** | The Rust host survives → subscribe to **WebView2 `ProcessFailed`** (reason codes: render-process exited, unresponsive, GPU failure) via `with_webview` platform access; write an attributed record in real time, optionally offer webview reload | Failure reason + breadcrumbs, from the surviving Rust side. Windows-first; macOS equivalent (`webContentProcessDidTerminate`) best-effort |
| 5 | Whole-process death | OOM kill, native segfault in a C dependency, force-kill — nothing survives to log | **Clean-shutdown marker**: written at startup, removed only when the **frontend's** clean-shutdown ritual completes. Marker present at next startup with no crash file explaining it → synthesize an `unclean-shutdown` record from the persisted breadcrumb tail | Breadcrumbs + "it died and didn't say goodbye" |

Two boundary clarifications:

- **Tauri command `Err` results are not crashes** — they already propagate to the frontend as
  handled errors. They feed the breadcrumb trail (command name + ok/err), nothing more. Crashes
  *inside* Tauri's Rust machinery or plugins are panics, and the process-global panic hook
  (hook #3) attributes them regardless of whose code panicked.
- **Marker removal must be driven by the frontend ritual, not Rust process exit.** If the
  webview dies (hook #4) the frontend can never complete its shutdown ritual — which is exactly
  right: a session whose webview crashed must be *unable* to look clean, even if the Rust host
  later exits gracefully.

Bonus synergies of hook #5: the marker doubles as a clean-shutdown verifier (an ethos Litria
already holds), and may finally produce evidence for the NSIS uninstaller process-linger bug
(marker still present after "close" = something didn't shut down). Hook #2 would have caught
and attributed the long-standing dev-startup `Error: Project path is required.` mystery.

---

## Crash record

One JSON file per crash: `~/.litria/logs/crashes/crash-<UTC timestamp>-<layer>.json`
(decided 2026-07-05 — discoverability over platform-dir purity).

Location rationale:
- **`~/.litria/` is the emerging "Litria home"** — a per-user data directory created by the
  app (not the installer), distinct from the install dir, from internal app-data
  (`%LOCALAPPDATA%/com.litria.app/`), and from per-project `<project>/.litria/`. It survives
  uninstall/reinstall — exactly what you want for crash evidence from a broken install. The
  extension design already puts its central store at `~/.litria/extensions/`; logs slot in
  beside it. (Naming rhyme with per-project `.litria/` is deliberate — npm/cargo/git use the
  same home-vs-project dotfolder pattern.)
- **One verbatim path across all three OSes** for the README, the issue template, and every
  "where are my logs" support answer — vs. the `%LOCALAPPDATA%` / `~/Library` / `~/.config`
  trifecta. Windows Explorer doesn't hide dot-folders, so it's plainly browsable.
- **Principled split**: internal state the user never touches (app DB, preferences) stays in
  app-data; **user-facing artifacts** — things a human is expected to find and attach to an
  issue — live under `~/.litria/`. Crash logs are the first citizen of that category.
- **Per-user survives team deployments** (2026-07-05): one person's instance eating itself
  leaves its evidence on that machine, under that user — isolated by construction, no shared
  location to sift, no cross-contamination on shared workstations. Combined with
  `litriaVersion`/OS in each record, team triage gets a clean differential: same panic
  location across several users' logs → the build; one user's logs → that machine or setup.
  (Relevant to eventual Team Edition.)
- The View log / Report buttons remain the *primary* discoverability; the memorable path is
  the fallback for the app-won't-launch case, and the pre-filled issue body states it in full.

```json
{
  "schema": 1,
  "timestamp": "2026-07-05T21:14:03Z",
  "litriaVersion": "0.9.2",
  "os": "windows 10.0.19045",
  "layer": "react | js | rust | unclean-shutdown",
  "error": {
    "message": "...",
    "stack": "...",
    "source": "file:line:col (js) / file:line (rust panic location)",
    "componentStack": "(react only)"
  },
  "breadcrumbs": [ { "t": "...", "kind": "action|command|mode|project", "name": "..." } ],
  "session": { "id": "...", "uptimeSecs": 812, "projectName": "..." }
}
```

Retention: keep the last 20 crash files, prune on startup. Local-only means project names/paths
are fine to record; the assisted-report flow is what makes sharing explicit and reviewed.

---

## Breadcrumbs — "what was the user doing"

A ring buffer (~50 entries) of recent, **content-free** events:

- **Action dispatches** — the natural tap point is the emerging central action registry
  (menubar + HUD + pills + shortcuts converge there per the ADR-018 work); one tap covers every
  surface, and the crash system becomes one more registry consumer.
- **Tauri command invocations** — name and ok/err only, never args (args can carry file
  content).
- Mode changes (edit mode), project open/close, saves, window events.

No file contents, no keystrokes, no selection text — ever.

Persistence: the renderer mirrors the ring to a small rolling file
(`~/.litria/logs/breadcrumbs.jsonl`) on a debounce (~5s), so the whole-process-death path
(hook #5) has a tail to synthesize from. Losing the last few seconds of
breadcrumbs on a hard kill is accepted — beta-grade, not flight-recorder-grade.

---

## Surfacing & report flow

**Hard crash → next launch**: startup scans for unexplained markers / unseen crash files and
shows an inline banner: *"Litria closed unexpectedly last time."* Actions:
**View log** (opens the crash file / folder) · **Report** · **Dismiss** (marks seen).

**Soft crash → immediately**: the error boundary's fallback screen (themed, since the app shell
survives) shows the same actions plus **Reload**. JS errors from hook #2 that don't take the UI
down get a quieter path: logged + a dismissable status-line indicator, no banner.

**Report** builds a pre-filled GitHub issue URL — title (error summary), body (version, OS,
layer, error excerpt, breadcrumb tail) — and opens the browser. URL length caps (~8KB) mean the
body carries an *excerpt* plus instructions to attach the full crash file. Pairs with a
`.github` crash-report issue template so arriving reports have a consistent shape.

---

## Implementation sketch (one PR, small)

- **Rust**: a `crash` module — panic hook + crash-file writer (synchronous, allocation-light;
  the process may be dying) + marker write/remove + startup scan command + prune. Marker removal
  rides the existing window-close guard / clean-shutdown path.
- **Frontend**: `src/crash/` — `ErrorBoundary` (top-level, inside theme providers so the
  fallback is themed; App.jsx four-rule test applies — this is shell chrome and qualifies),
  global handler install in `main.jsx`, breadcrumb store + registry tap, banner component.
- **Tests**: crash-record serialization, prune/retention, marker lifecycle, breadcrumb ring +
  debounce, issue-URL builder truncation. The panic hook gets a manual `debug_assertions`-only
  test command (`crash_test_panic`) rather than an automated test.

## Non-goals

- Auto-upload, telemetry, or any receiving endpoint.
- Native crash handlers / minidumps (crashpad/breakpad) and symbolication — beta ships with
  panic locations and JS stacks, which is enough to act on.
- Extension crash handling — that's the sandbox supervision policy's remit
  (`extension-sandbox-design.md`); at most, a quarantine event drops a breadcrumb here.
- Log aggregation / general-purpose logging framework. This system records *crashes*, not logs.
  (If a `log`/`tracing` crate arrives later for other reasons, the panic hook stays the
  authority for crash files.)

## Reliability & overhead research (2026-07-06)

Three-track research pass (WebView2/Tauri API surface; Rust panic-hook reliability; JS-side
capture on React 19 + Vite). Full sources in the session record; load-bearing findings below.

### Overhead verdict: near-zero — the lightest legitimate point in the design space

Every hook is pay-on-fire: panic hook (one boxed closure, 0 until a panic), window
handlers/error boundaries/root options (0 until an error), `ProcessFailed` subscription
(event-driven, 0), marker (two tiny file ops per session). The only recurring cost is the
breadcrumb ring (few KB RAM, O(1) per action) and its debounced mirror — **which must be
event-driven (dirty-flag, timer armed only when breadcrumbs arrive), so an idle app performs
zero writes**; that rule, not SSD wear (~5 orders of magnitude below endurance budgets), is
what protects the 1–5% idle-CPU target. Total: 0 extra processes, <1MB RAM, 0 idle CPU.
Contrast: Crashpad/Sentry-native runs a persistent handler process — a material line item
in an 80–150MB budget, and it *still* wouldn't see a dead renderer with a surviving host
(sentry-tauri hooks host-process crashes only — our hook #4 gap analysis confirmed).

### Hook #4 (Windows) — CONFIRMED FEASIBLE, exact API resolved (OQ4 answered)

No first-class event in tauri 2.x / wry (wry 0.54+ has a **Darwin-only** terminate handler;
`tauri::WebviewEvent` has only `DragDrop`). The supported Windows route:
`WebviewWindow::with_webview(|pw| ...)` → `pw.controller().CoreWebView2()` →
`add_ProcessFailed` via `webview2_com::ProcessFailedEventHandler`. Bonus: `pw.environment()`
casts to `ICoreWebView2Environment11` → **`FailureReportFolderPath`** — WebView2 runs its own
Crashpad and writes minidumps there; reference the nearest-by-mtime dump in our crash record
(free fidelity upgrade; dumps may be absent or stale, match by time). **Crate pinning is the
real trap**: our `webview2-com`/`windows` versions must match tauri's own pins exactly
(currently 0.38 / 0.61 — our Cargo.lock already agrees) or COM types won't unify; add a
`cargo tree -d` check and re-verify on every tauri bump.

Per-kind policy (MS guidance):
- `RenderProcessExited` → **the** crash signal: record (Reason + ExitCode + nearest minidump), offer/auto `Reload()`.
- `BrowserProcessExited` → fatal, record; window is gone.
- `RenderProcessUnresponsive` → **re-raises ~every 15s; never log as crash on first raise** —
  record a *hang* (not crash) after 2–3 consecutive raises with no recovery; offer Reload,
  don't auto-reload (an IDE user may be running a legitimately long script). ExitCode is
  meaningless here (259/STILL_ACTIVE).
- `GpuProcessExited`/`Utility`/`Ppapi*`/etc. → ignore (breadcrumb at most); GPU exits are
  "the most common WebView2 process failure" and auto-recover.
- ExitCode `-1073740760` (STATUS_INVALID_IMAGE_HASH) or `FailureSourceModulePath` set →
  record as **environment/code-integrity** (AV/injected DLL), not an app bug.
- Handler fires on the UI thread — push over a channel to the writer; dedupe (one failure can
  fan out to multiple events).

### Hook #4 (macOS) — backstop-only for now

wry 0.54+ implements `webContentProcessDidTerminate` but **tauri does not expose it** (it sits
on tauri-runtime's `PendingWebview`, no public builder method; the CEF-runtime work reuses the
same field, so the shape is stable). Don't fight the WKNavigationDelegate — rely on the
marker (hook #5) on macOS and consider a small upstream PR exposing the hook (plumbing exists
end-to-end; even then it carries zero metadata — `Fn()`, no reason/exit code).

### Hook #3 — panic-hook hardening rules (the hook must be panic-free)

The hook runs under **both** unwind and abort (OQ3: keep unwind for beta; the hook logs either
way). A panic inside the hook = double-panic = silent abort, report lost. Rules:
- No `unwrap`/`expect`/indexing; `let _ =` every I/O result. No locks the app takes —
  `try_lock` the breadcrumb ring, skip breadcrumbs on contention (documented std deadlock:
  rust#130187). Reentrancy guard via `AtomicBool` compare-exchange.
- **Write order: minimal facts first** (timestamp, message, `file:line`, thread), flush, then
  attempt backtrace (`force_capture` is fine but allocates; Display-formatting is where the
  cost/locks live) + breadcrumbs, then `sync_all`. If the expensive half dies, the cheap half
  is already on disk.
- **Pre-work at startup, while healthy**: pre-create/canonicalize the crash dir into a
  `OnceLock`, pre-serialize static context (version/OS/session id) — the hook only
  concatenates. Chain the previous hook so dev stderr output survives.
- One **fresh file per crash** (`create_new(true)` + single write + `sync_all`) — never append
  to a shared file at panic time. Prune at startup, never at panic time.
- Scope honesty (confirmed): the hook catches pure-Rust panics only. Stack overflow, C
  `abort()`/fail-fast, `STATUS_HEAP_CORRUPTION` (never reaches UEF on Windows), OOM-kill,
  power loss all bypass it → marker's remit. **No VEH/SetUnhandledExceptionFilter for beta**
  — the graduation path, if ever, is out-of-process (`crash-handler` + `minidumper`), which is
  exactly why Crashpad is a separate process.

### Hook #5 — marker amendments (Chrome polarity confirmed: assume dirty, prove clean)

- **Markers are per-instance** — `session-<pid>-<starttime>` — and startup only declares a
  crash after verifying that PID is dead (or reused: start time mismatch). Mandatory once the
  multi-session brief lands; cheap now.
- **Marker lives in local app-data (`%LOCALAPPDATA%`), NOT `~/.litria`** — markers are
  internal state, not user-facing artifacts (the doc's own split); home dirs can be
  synced/roaming, and sync engines resurrect/delete markers. Crash *records* stay in
  `~/.litria/logs/crashes/` as designed.
- **Phase checkpoints** (Firefox CrashMonitor model): marker carries a `phase` field advanced
  at startup milestones (pre-webview → webview-ready → frontend-ritual-armed) — an
  early-startup crash then self-identifies by phase instead of being unattributable.
- **Prefer state-rewrite over delete-as-signal** (`state: "clean"`), retry briefly on failure —
  AV can transiently lock fresh files; a failed delete must never read as "crash".

### Hook #2 + #1 — React 19 changes the capture matrix (design must add root options)

- React 19 **no longer rethrows render errors**: uncaught ones surface via `reportError` (→
  window `error` handler, but with **no componentStack**); boundary-caught ones go to
  `console.error` only and **never reach window handlers**. Therefore: pass
  **`onUncaughtError` + `onCaughtError` to `createRoot`** — that's where render-phase logging
  lives (componentStack included); boundaries own fallback UI only. Dedupe window-handler vs
  root-option double-reports by error identity.
- Konva/rAF/event-handler throws do reach `window.onerror` (confirmed); Monaco re-throws its
  internal errors onto a `setTimeout` (they arrive), but **filter `err?.name === 'Canceled'`**
  rejections or Monaco cancellations will spam the ring. Same-origin Vite bundle on
  `http://tauri.localhost` → no 'Script error.' degradation for our own code.
- Boundary granularity: top-level last-resort + per-surface boundaries (canvas, each editor
  pane, HUD/drawer chrome) so one dead surface doesn't unmount Monaco with unsaved state.
- **NEW PREREQUISITE — production stacks are currently garbage**: vite.config has no
  sourcemap setting, so shipped stacks are `index-XXXX.js:1:234567`. Fix:
  `build.sourcemap: 'hidden'` + **exclude `.map` from the Tauri bundle** + archive maps per
  release; symbolicate pasted stacks offline (`source-map` consumer / stacktracify — 30-line
  script). Belt-and-braces: `esbuild: { minifyIdentifiers: false }` so raw frames keep real
  function names (skip `keepNames` — flaky under Vite). This rides the release pipeline, so
  it should land with B0 release mechanics.
- Flush policy: **immediate flush on error capture** (before showing any banner), 5s trailing
  debounce for breadcrumbs, plus flush on Tauri `onCloseRequested` — NOT
  `beforeunload`/`visibilitychange`, which are unreliable in Tauri webviews.
- Scrubbing boundary: full paths are fine in local logs; scrub at **GitHub-issue assembly
  time** (user profile → `~`, project root → `<project>`) — that's where text goes public.

## Open questions

1. Exact banner surface and styling; eventual home is likely **DevSight** once it exists —
   beta ships the banner, DevSight later absorbs "crash history" as a view.
2. Does the next-launch scan also offer "reopen last project" on unclean shutdown, or stay
   strictly informational? (Lean informational for beta.)
3. ~~Rust panic behavior policy~~ **Resolved 2026-07-06**: keep default unwind for beta — the
   hook runs under both unwind and abort, so the crash file is written either way; observe
   field behavior before considering `panic = "abort"`.
4. ~~Exact API surface for hook #4~~ **Resolved 2026-07-06** — see research section: Windows
   via `with_webview` → `webview2-com 0.38` `add_ProcessFailed` (+ `FailureReportFolderPath`
   minidump reference); macOS backstop-only until tauri exposes wry's Darwin hook.

## References

- `extension-sandbox-design.md` — supervision policy owns extension deaths
- ADR-018 / shortcut-registry — the central action registry the breadcrumb tap rides
- Feedback rule: no questionnaire modals (inline banner mandate)
- Known bugs this would illuminate: NSIS uninstaller process-linger; dev-startup
  `Error: Project path is required.`
