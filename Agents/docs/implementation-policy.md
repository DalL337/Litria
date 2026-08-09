# Implementation Policy

Scoped agent-governance procedure (AGENTS.md §1/§2). Load when writing or
changing code. Moved here from AGENTS.md §5 (2026-07-13) so sessions load
engineering rules per-task instead of per-session.

General rules derived from real debugging sessions; they apply to any codebase
with concurrency, cross-platform targets, or stateful UI components.

**Runtime lifecycle rules** (lock hold duration, resource lifecycle ownership,
teardown cascade ordering) live in `docs/Orchestration.md` §1.2 — they are
architecture principles now, not just agent guidance. Follow them there; they
are not restated here.

## Rule 1 — React StrictMode Idempotency

React StrictMode double-fires effects in development. Any effect that creates
a backend resource (process spawn, session start, WebSocket open, database
connection) must be idempotent:

- Guard with a ref flag (`if (startedRef.current) return`).
- Deduplicate the promise so the second call reuses the first.
- Return a cleanup function that tears down the resource.

Assume every `useEffect` will run twice and design accordingly. (Corollary:
never perform side effects inside a `setState` updater — updaters must be
pure; StrictMode double-fires them too.)

## Rule 2 — Platform-Specific Code Isolation

Platform-dependent code (Windows job objects, macOS notarization, Linux
cgroups) must be isolated behind compile-time or runtime gates:

- Rust: `#[cfg(target_os = "windows")]` with fallback behavior — actual
  `#[cfg]` gates, not `if cfg!(windows)` (the latter still compiles the
  other platform's code).
- JS/TS: dynamic imports or platform-check wrappers; use `src/platform/`
  (`platformDefaults`, `modifierKeys`) rather than ad-hoc `isMac` checks.

Never inline platform-specific logic into shared business logic.

## Rule 3 — Debug-Only Safety Nets

Dev-mode workarounds (killing orphaned dev servers, verbose logging, mock
fallbacks) must be gated so they never ship in production:

- Rust: `#[cfg(debug_assertions)]`.
- JS/TS: `if (import.meta.env.DEV)` or equivalent.

These are safety nets, not features. Document why they exist so future
engineers don't mistake them for production code.

## Rule 4 — Stateful Component Mounting

Components with expensive internal state (terminal emulators, code editors,
video players, map views, 3D canvases) should use CSS visibility toggling
(`visibility: hidden` + `position: absolute`) rather than conditional
rendering (`{show && <Component />}`).

Conditional rendering destroys and recreates the component on every toggle,
losing internal state and causing expensive re-initialization. CSS toggling
preserves the instance and its state across show/hide cycles.

## Rule 5 — Dead Code Carries Its Reason (added 2026-07-13)

Zero-warning builds are the floor, but "unused" is a claim to verify, not
obey: constants may be read textually by scripts (versions.rs ×
bundle-servers.mjs), items may be Accepted-ADR prep awaiting their consumer.
Per-item `#[allow(dead_code)]` with a reason-at-site comment naming the
future consumer; never crate-wide allows; remove the allow when the consumer
lands. Genuinely dead code is deleted — git history remembers it.

## Rule 6 — Visual Changes Get Screenshot Verification (added 2026-07-26)

(Origin: the scaffold depth-rails saga — three consecutive merged PRs
(#196–#198) shipped rails the owner could not see. #196 was clobbered by a
`background:` shorthand later in the same rule; #197 fixed that but the
alpha was below perception; #198 fixed geometry that was also wrong. All
three would have been caught in one round by LOOKING at the output.)

Any change whose acceptance criterion is "how it looks" (CSS, canvas
drawing, layout, indicator styling) must be verified visually before the
PR, not shipped on geometry math:

- Build a minimal HTML repro of the real DOM structure + the exact CSS in
  the scratchpad, render it with headless Chrome
  (`chrome --headless=new --screenshot=...`), and READ the screenshot.
- Use `--force-device-scale-factor=3` to magnify hairline features; check
  at 1× as well — that is what the user sees. A 1px line below ~0.6 alpha
  over dark glass is imperceptible at 1× even when technically rendering.
- Faint/hover/state styling: screenshot the state, don't reason about it.
- CSS gotcha worth its own line: a `background:` shorthand RESETS every
  background longhand (image included) — declaration order within the
  rule matters, and state rules must use `background-color`.

## Rule 7 — State Follows Disk (added 2026-07-28)

(Origin: the reserved-name guard made two latent traps reachable. Group
rename and promote-to-folder both committed the state change — new
folderPath, promoted group — BEFORE calling the write manager's disk
operation. Any refusal (reserved name, locked file, cross-device failure)
then left state pointing at paths that never materialized on disk:
divergence the reconciler has to guess its way out of.)

In any flow that pairs a domain-state mutation with a refusable disk
operation:

- Run every check that can refuse the operation BEFORE the state write —
  or run the disk operation first and derive the state update from its
  result. Never commit state on the assumption the disk op will succeed.
- The write manager's result object is the authority: a discarded
  `result.success` is a silent divergence waiting for its trigger.
- When auditing, grep the flow for domain commands issued above the
  `fsManager.*` call — that ordering is the trap's signature.

## Rule 8 — Removal Refactors: Grep the Identifier Dead (added 2026-08-01)

(Origin: physicality-arc W3 — `isManualGroup` was removed from
`useMenuBarBindings`' params but survived in the ctx object the hook
assembles. Vite builds free identifiers without complaint and the node
tests render no components, so every check passed while the app crashed at
render with a ReferenceError — caught live by the crash boundary. Second
strike for the bindings/ctx-assembler layer: the edge-routing arc's #225
was the same file family dropping props.)

After removing any identifier (param, export, prop, handler), grep it
repo-wide before calling the removal done — imports AND bare uses. The
param list and the object literal that forwards it are SEPARATE sites, and
the assembler layers (useMenuBarBindings, useWorkspaceStageBindings) are
the repeat offenders. A `no-undef` lint in the check chain would catch the
class mechanically; until one exists, the grep is mandatory.

## Rule 9 — Persistent State Is Born Sync-Ready (added 2026-08-01)

(Origin: team-sync architecture scouting,
`.research/2026-08-01-team-sync-architecture.md`. Identity audit found
`pieces.id` and `connections.id` are `INTEGER PRIMARY KEY AUTOINCREMENT`
(`src-tauri/src/db/schema.rs:23,57`) and scaffold group ids are
`Date.now()` + a process-local counter (`useScaffoldActions.js`). All are
unique per machine only — any future replica merge (multi-user sync,
imported canvases, cross-machine copies) collides on them. Retrofitting
identity is a migration; preventing new instances is free.)

- New persistent entity types get a globally-unique text id at birth —
  `crypto.randomUUID()` in the webview, the `uuid` crate in Rust — never
  AUTOINCREMENT/rowid, timestamps, or process-local counters.
- Existing integer ids (pieces, connections) stay as-is: a known,
  deliberately deferred pre-sync migration (paths recorded in the journal —
  migrate to text UUIDs, or qualify with `project.instance_id` at the sync
  boundary). Do not extend the pattern to new tables or object kinds.
- New workspace.db tables/columns declare which side of the future sync
  line they live on — shared project truth (pieces, groups, group_pieces,
  connections) vs per-user/per-machine (viewport, editor_state,
  hidden_paths, preferences). A one-line comment in `schema.rs` suffices;
  the point is that the classification is decided at birth, not archaeology
  later.
