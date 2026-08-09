# Brief — Activity Feed (successor concept to the top-drawer "Console")

**Status:** Idea only — no implementation planned. Recorded so the definition
survives the removal of the Console placeholder tab (owner decision,
2026-07-19).

## Origin

The top drawer rail shipped with a disabled "Console" tab reserved during the
terminal PTY work (`docs/plans/terminal/terminal-pty-implementation-plan.md`,
Slice 3A) with no behavior ever specified. Its one recorded intent was
*background-process visibility*: a transparency window into what Litria itself
runs on the user's behalf, never requiring interaction.

During DevSight planning (2026-03) a boundary was drawn: the DevSight Console
tab (bottom panel, on hold) is a read-only parsed view of the **user's**
terminal stream (`docs/prds/devsight-prd.md` §8.2); the top-drawer Console was
for **app-initiated** activity. That boundary holds for this concept.

On 2026-07-19 the owner ruled: remove the placeholder tab, keep the hardened
definition on paper. This brief is that definition.

## Why the tab was removed

An inventory (2026-07-19, `.research` journal) found every output-producing
background process already has a purpose-built, context-local surface:

| Process | Surface today |
|---|---|
| Scaffold steps (ADR-021, npm et al.) | `ScaffoldEvent` stream → New Project wizard progress UI |
| Python deps (`uv sync`, ADR-020) | Deps pill → run executes in the visible Terminal |
| LSP server downloads (ADR-005) | Throttled progress events → settings download pane |
| LSP crashes / native failures | Crash-log system + crash-loop handling |

No orphaned output stream needed a Console home, so the tab was dead UI with
an implied promise. Removal also deleted the drawer `disabled` affordance —
the lesson codified is *don't ship disabled placeholder tabs*; a drawer
appears when it works.

## The hardened definition

If this returns, it is an **Activity feed**, not a console:

- A read-only, timestamped, append-only feed of **app-initiated operations**:
  scaffold runs, dependency syncs, LSP server downloads/updates, LSP
  restarts and crash-loop backoffs, project reconciliation actions.
- Each entry: timestamp, operation label, outcome (success/warning/failure),
  and an expandable detail (the already-captured output for that operation).
- Aggregation, not duplication: entries are fed by the event streams the
  existing surfaces already consume (scaffold channel, `lsp:download-*`
  events, crash-log writes) via a small subscriber — no new process taps.
- UX governance constraints (owner-ratified): never required for any
  workflow; never auto-opens; purely a trust/after-the-fact debugging
  surface. All primary feedback stays context-local (pills, wizard, panes).
- Not a terminal, not a REPL, no interactivity beyond expand/copy.
- Distinct from DevSight (user-project diagnostics, separate bottom-panel
  system, on hold).

## Addendum (2026-07-19) — project-session retention (owner decision)

Ratified in discussion the same day the brief landed; resolves the retention
open question:

- **Lifetime = the project session.** The feed accumulates from project open
  and is erased on project switch and on Litria exit. Whether the session
  runs minutes or hours, the inventory holds. No cross-session persistence:
  the feed is live transparency, not a durable record — crash logs remain
  the durable postmortem artifact. (Initially leaned app-session-scoped with
  project tags; owner ratified project scope — cleanup on switch — which
  also matches the terminal's per-project session model.)
- **App-level operations log into the active project session.** Operations
  that aren't project-owned (LSP server downloads, managed-server updates)
  appear in the feed of whichever project session is active when they run,
  and vanish with it on switch. Accepted consequence of project scope, not
  a bug — the durable record for those is the download/crash logging that
  already exists.
- **Independent of UI visibility.** Entries collect whether or not the feed
  surface has ever been opened; closing and reopening the surface shows the
  same accumulated inventory. Hard contrast with the Terminal drawer (whose
  close currently ends the shell session): the feed store must live in its
  owning domain, subscribed for the app's lifetime, with the drawer/panel as
  a stateless view over it. By construction the UI lifecycle can never touch
  the data.
- **Bounded by nature, not by cap.** Entries are coarse operations, not log
  lines; an hours-long session produces at most hundreds. No ring-buffer cap
  unless evidence says otherwise.

## Addendum (2026-07-19) — stream scope: app-initiated only (owner decision)

Ratified after poking the boundary with a concrete edge case: a user hand-runs
a tauri install in the terminal (outside the wizard), answering its
interactive prompts. What does the feed show?

**Nothing — and that is the boundary working.** The feed inventories
*app-initiated* operations only. User-typed commands are user work; the
terminal is their record. The only honest entry from that scenario is the
wrapper event that was Litria's doing: `Terminal session started (project:
myapp)`. The install output and prompt dialog never reach the feed.

Contrast: the same tauri scaffold run *through the wizard* IS a feed entry,
because Litria initiated it (ScaffoldEvent stream).

Ratified non-goals that fall out of this:

- **No command-boundary detection in the user's PTY stream.** Even a coarse
  one-liner (`tauri ran, exited 0`) requires shell-integration hooks or
  prompt heuristics — that is the DevSight terminal-tap architecture waking
  up through a side door. If command-level summaries ever feel worth it,
  reopen that decision on its own merits; don't absorb it into the feed.
- **No rich decision tracking of interactive prompts.** Semantically parsing
  every CLI's questions/answers is unbounded per-tool work and duplicates
  terminal scrollback — violating the feed's aggregation-not-duplication
  principle. Same reasoning that made DevSight Console "not a terminal
  replacement."

## Open questions (for if/when it's picked up)

- Home: top drawer (the registry seam in `src/components/useTopDrawers.jsx`
  makes re-adding trivial) vs a status-bar popover.
- Domain placement per `docs/Orchestration.md` §2 — likely a new small
  `activity` domain owning the event bus; evaluate against the Domain
  Register before building.
