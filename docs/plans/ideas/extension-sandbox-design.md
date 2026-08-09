# Extension Sandbox & Capability Model — Design

> **Status**: Draft / not yet planned for implementation
> **Author**: DalL337 + Claude
> **Date**: 2026-07-05 (hardening pass folded in same day: op protocol, events, buffer model,
> threading, WASM road-not-taken, supervision, build pipeline, budgets)
> **Companion to**: earlier extension-management working notes (2026-03-13, unpublished) —
> storage, versioning, dual-build. This doc answers that draft's open questions: *"Security
> model — sandboxed or trusted?"* and *"Extension host isolation — one shared JS context, or
> per-extension workers/iframes?"*
> **Prerequisite discovered**: the sandbox window requires two concurrent project sessions —
> see `brief-multi-session-support.md`.

---

## Problem — two documents disagree

The March extension-management doc assumes full TypeScript extensions whose compiled JS bundles
are "evaluated in a controlled context" — but never defines the control. The July HUD capture
(user-widgets vision, 2026-07-03) sketched a rung ladder and ruled full-JS-with-Tauri-IPC
"Rung 3, likely never."

The resolution: **the "never" was about *where* the JS runs, not *that* it runs.** Extension
code executing inside the UI webview with access to Tauri IPC is still never — that's handing an
extension the same authority as the app. Extension code executing in a **Rust-side JS engine
with no ambient authority**, reaching the app only through a capability broker, is a different
animal entirely. This doc gives that animal its form.

## Decision summary

1. **One ladder, three rungs, one broker.** Rungs differ in *what executes* (nothing / DOM /
   JS), never in *what they may touch*. Access is always a capability grant checked by the same
   broker, regardless of rung.
2. **Deny-by-default is structural, not bolted on.** In an embedded engine there *is no*
   filesystem, network, or IPC unless the host registers an op for it. The sandbox isn't a
   wall built around a powerful runtime; it's a powerless runtime that must ask for everything.
3. **Trusted now, hostile-ready.** v1 assumes curated/self-written extensions and defends
   against honest mistakes. The broker architecture is the part that must survive a future
   hostile posture unchanged; process isolation and resource metering are additive later.
4. **The broker protocol is the durable artifact; the engine is a choice.** Ops travel as a
   JSON-serializable envelope, so the engine (deno_core vs QuickJS vs a future sidecar process)
   is swappable without touching extension-facing API.
5. **The interface is defined once, in an IDL, and everything is generated from it** — the JS
   shim, the `.d.ts`, the Rust dispatch, the manifest schema. Drift between shim, docs, and
   dispatch is made impossible by construction (Zed does this with WIT; Deno with its op
   registry). This is what makes commitment #4 enforced rather than aspirational.

---

## Threat model

| Tier | Adversary | Defenses | When |
|---|---|---|---|
| **v1 defends** | Honest mistakes in trusted code: writes outside the project, path traversal bugs, runaway loops, accidental network calls | Capability grants; project-root path canonicalization; isolate heap limit + wall-clock interrupt; no network op unless granted | Day one |
| **Architecture must permit** | Actively malicious third-party code: exfiltration, resource abuse, broker probing | Per-extension OS process isolation; CPU/memory quotas; per-capability prompts; scoped network grants; signature verification | If/when a marketplace exists |
| **Permanently out of scope** | Compromise of Litria itself, the OS, or the user's account | — | Never a sandbox problem |

The load-bearing observation: because every rung already routes through the broker, moving from
"trusted" to "hostile" hardens the *broker's enforcement*, not the *extension contract*.
Extensions written against v1 don't change when the walls get thicker.

---

## The ladder

| Rung | What executes | Where | Sandbox mechanism | Covers |
|---|---|---|---|---|
| **1 — Declarative** | Nothing. Pure JSON contributions | Parsed by the app | Schema validation + action-ID whitelist | HUD widgets, buttons, menu entries, keybindings, themes-as-tokens, **language servers** |
| **2 — Webview UI** | HTML/CSS/JS inside a sandboxed frame | Isolated iframe in the UI webview | `sandbox` attribute + CSP + no Tauri injection; postMessage → broker | Custom panels, rich widget bodies, visualizations |
| **3 — Brokered logic** | Compiled TS bundle | Rust-embedded JS engine | No ambient authority; every op is a brokered capability check | Commands, linters, formatters, canvas behaviors — real extensions |

Rungs are à la carte, not sequential tiers of the same thing. A themed keybinding pack is pure
Rung 1. ExtractToFile is pure Rung 3 (it has no custom UI). A dependency-graph panel would be
Rung 3 logic + Rung 2 presentation.

### Rung 1 — declarative contributions

A manifest contributes entries to existing app surfaces: HUD widget sections (ADR-018's
registry contract `{ id, title, node, defaultVisible }`), menu items, keybindings, command-
palette entries. Buttons reference **whitelisted action IDs** with schema-validated params — the
"sandbox" is that nothing executes and only known actions with valid params can be named.

This is the convergence point already noted in the HUD work: shortcut registry + HUD widget
registry + menubar actions → one **central action registry** serving menus, keys, and widgets.
`knownIds` already gives clean install/uninstall semantics: removing an extension removes its
contributed IDs, and every surface generated from the registry updates for free.

**Language support belongs on this rung** — Zed's biggest lesson. In Zed, most "language
extensions" contain zero imperative logic: a grammar plus an LSP server configuration. Litria
already has a working LSP client and a drafted language-server registry (management slices
2–7), so a `contributes.languageServers` manifest field plugs straight into existing infra.
The common "add language X" extension becomes manifest-only, deleting an entire class of
would-be Rung 3 code and its whole failure surface.

### Rung 2 — sandboxed webview UI

For extensions that need real UI beyond composed buttons. Mechanics:

- Content served from the central extension store via the asset protocol into an iframe with
  `sandbox="allow-scripts"` and a CSP that blocks all external hosts.
- **No Tauri IPC injection into the frame** — the frame must not see `__TAURI__` or any IPC
  primitive. This is the exact "likely never" hazard, structurally excluded.
- The frame talks only `postMessage` to the host shell. The shell validates source and forwards
  the message as a broker op **using the same envelope as Rung 3**. A Rung 2 panel that wants to
  read a file needs `workspace.read` granted, same as anyone.

A Rung 2 frame is thus a *dumb terminal*: it can render anything, but it can *do* only what its
capability grants allow, enforced outside the frame.

### Rung 3 — brokered TypeScript logic

The March doc's full extension model, made viable by relocating execution:

- The compiled bundle runs in a JS engine **embedded in the Rust core** — never the UI webview.
- One isolate/context per extension (cheap in both candidate engines), all isolates on a
  dedicated extension-host thread in v1 (threading model below).
- The `litria.*` API surface from the March doc (`litria.workspace.*`, `litria.commands.*`,
  `litria.canvas.*`, …) is a thin JS shim over broker ops. All ops are async/promise-based.
- Notably, **canvas APIs need no UI access at all**: Litria's canvas is state-driven, so
  `canvas.mutate` (spawn piece, draw connection, form group) is a domain mutation the renderer
  picks up. The engine never touches a DOM.

### Static vs. dynamic contributions

One rule keeps lazy activation possible: **the UI must never need to activate an extension to
draw itself.** Everything renderable before activation — command titles for the palette, Rung 1
widgets, keybindings, language-server declarations, configuration schema — lives statically in
the manifest (`contributes`). Runtime registration only *binds behavior*: `activate()` attaches
the handler to an already-visible command. Invoking a contributed command whose extension isn't
active yet fires its `onCommand` activation and queues the invocation until `activate()`
completes — VS Code's `contributes`/`registerCommand` duality, adopted deliberately.

---

## The capability broker — shared spine

Every op is `(extensionId, capability, params)`. The broker checks the extension's grant table,
validates params (paths canonicalized and confined to the project root before any FS op), then
dispatches to the Rust core.

### The op protocol (wire shape)

The envelope is JSON-RPC 2.0 in shape — the protocol Litria's LSP client already speaks
fluently, and what Lapce uses for its plugin protocol:

```json
{ "jsonrpc": "2.0", "id": 412, "method": "workspace/readFile", "params": { "path": "src/a.ts" } }
```

Rules that make it load-bearing:

- **Identity is assigned by the host, never claimed in the payload.** The broker knows which
  isolate (or Rung 2 frame) a message arrived from and stamps the extension id itself. An
  envelope field for "who I am" would make grant checks spoofable the day two extensions share
  any channel.
- **Correlation and cancellation**: request ids for correlation; `$/cancel` notifications
  (LSP-style) for cancellation; events arrive as id-less notifications.
- **Error taxonomy extensions can branch on**: `denied` (capability missing/revoked),
  `invalid_params`, `not_found`, `cancelled`, `host_error`, `shutting_down`. A linter should
  distinguish "I'm not allowed" from "the file vanished."
- **In-process, the wire is virtual.** The envelope is a Rust struct that *is* JSON-serializable
  (deno_core moves it via serde_v8, no stringify per op). Actual serialization happens only at
  a real process boundary — the v2 sidecar — which is exactly why the same protocol survives
  that migration untouched.

### Capability vocabulary (initial sketch)

| Capability | Grants | Notes |
|---|---|---|
| `actions.invoke:<id>` | Fire a whitelisted registry action | Rung 1's entire world, also available to 2/3 |
| `commands.register` | Contribute commands to the palette/registry | Static title in manifest; handler bound at activate |
| `editor.selection.read` | Read the active selection | |
| `editor.document.read` | Read open document contents (buffer truth, incl. dirty state) | See document model below |
| `workspace.read` | Read files within the project root (disk truth) | |
| `workspace.write` | Create/modify files within the project root | **Routes through the Filesystem Write Manager** — extensions get journaled, undoable writes for free, and the broker gets one write chokepoint |
| `canvas.read` | Query pieces, groups, connections | |
| `canvas.mutate` | Spawn pieces, connections, groups | |
| `events.subscribe:<topic>` | Receive host events (see events section) | A capability class, not one grant |
| `ui.widget` | Contribute a Rung 1 HUD section | |
| `ui.panel` | Open a Rung 2 webview panel | |
| `net.fetch:<host>` | HTTP to named hosts | Absent by default; host-scoped when granted |
| `storage.extension` | Private key-value storage | SQLite-backed: project-scoped rows in `workspace.db`, global rows in the app DB. Per-extension namespace, no cross-reads, quota-able later |

Extension *configuration* is contribution, not capability: `contributes.configuration` declares
a JSON schema the settings drawer renders; the extension reads values via a `config.read` op
and receives change events. Deliberately **not capabilities** (they don't exist as ops at all):
shell execution, absolute filesystem paths, raw Tauri IPC, cross-extension memory access.

### Manifest & grant flow

Capabilities are declared in the extension manifest alongside the March doc's fields:

```json
{
  "id": "ext-extract-to-file",
  "version": "0.1.0",
  "main": "./dist/litria-entry.js",
  "engines": { "litria": ">=0.9.0" },
  "activationEvents": ["onCommand:extractToFile.extract"],
  "capabilities": ["commands.register", "editor.selection.read", "workspace.write"],
  "contributes": {
    "commands": [{ "id": "extractToFile.extract", "title": "Extract to File" }]
  }
}
```

**v1 grant flow (trusted posture)**: install-time, show the declared list, accept-all-or-don't-
install. **Hostile-ready path**: per-capability toggles, first-use prompts for sensitive grants
(`workspace.write`, `net.fetch`), and grant revocation — all changes to broker enforcement and
UI, zero changes to extension manifests.

Litmus test for the vocabulary: **ExtractToFile's manifest should read like its one-sentence
description** ("read the selection, write a file, via a command"). It does — three capabilities.
Its future canvas incarnation adds exactly one: `canvas.mutate`.

---

## Events & subscriptions

Extensions are overwhelmingly *reactive* — onSave, onLanguage, selection-changed. Request/
response alone doesn't cover the dominant use pattern, so events are core design, not an
afterthought:

- **Subscription is a capability class**: `events.subscribe:<topic>`. Initial topic sketch:
  `workspace/fileChanged`, `editor/documentSaved`, `editor/selectionChanged`,
  `editor/documentChanged`, `canvas/pieceMoved`, `config/changed`. Topics are part of the
  IDL and versioned with it.
- **Delivery**: id-less JSON-RPC notifications into the isolate's event loop.
- **Backpressure is policy, not hope.** High-frequency topics (`selectionChanged`,
  `documentChanged`) coalesce latest-wins per subscriber; discrete topics (`documentSaved`)
  use a bounded per-subscriber queue. A slow isolate gets events dropped with a counter, and
  the drop count is visible in the broker op log — never an unbounded queue into a stalled
  extension.
- **Activation events are just subscriptions the host holds on the extension's behalf** —
  ones whose handler creates the isolate, runs `activate()`, then replays the triggering
  event. One mechanism, not two.

---

## Document & buffer model

`workspace.read` and `editor.document.read` are different planes of truth, and conflating them
produces wrong linters:

- **`workspace.read` is disk truth.** What's in the file on disk right now.
- **`editor.document.*` is buffer truth** — including unsaved changes. A linter or formatter
  must see this plane or it analyzes stale text.
- **Text sync is incremental and versioned, LSP-style** — the protocol Litria already
  implements client-side. Shipping whole documents per keystroke-frequency event doesn't
  survive contact with a real editing session.
- **The shim maintains a document mirror** (VS Code's extension-host trick): on first access
  the extension's shim opens the document (one full-text op), then applies incremental deltas
  from `editor/documentChanged` events. After that, `document.getText()` is a local, synchronous
  read inside the isolate — zero ops on the hot path. Writes are never direct: edits go out as
  `applyEdit` ops through the broker (and thus the FSM journal).

---

## Rung 3 host: engine survey & recommendation

| Option | Isolation ceiling | Cost | Verdict |
|---|---|---|---|
| **deno_core (V8)** | Strong: per-isolate heap limits, `terminate_execution`, snapshots | Binary +25–35MB, painful compile times for the v8 crate | **Recommended.** Its "ops" model *is* a capability broker — every host function is explicitly registered, nothing ambient. Best perf and longest runway |
| **QuickJS (rquickjs)** | Good: interrupt handler, memory limit | ~1MB, interpreter-speed, weaker debugging/tooling | Viable fallback if V8's binary/compile cost offends. Fine at v1 extension scale |
| **Wasmtime (WASM/WASI)** | Excellent: capability imports are the *only* authority; epoch/fuel interruption; memory limits native | Wrong toolchain for the mission — see below | The Zed/Lapce road; not taken, argued below |
| **Boa** (pure Rust) | — | — | Too immature; not considered further |
| **Sidecar Deno process** | Strongest: OS process boundary + Deno's own permission flags | Ship a runtime binary; process management | Not v1 — but note this is the natural **hostile-posture endgame**: the same op envelope over stdio |

### The road not taken: WASM (and what we steal from it)

Both flagship Rust IDEs chose WASM, not an embedded JS engine. **Zed** runs extensions compiled
to `wasm32-wasi` under Wasmtime, with the host interface defined in WIT. **Lapce** runs WASI
plugins speaking JSON-RPC. WASM gives capability security and interruption for free, and it's a
genuinely great fit — *for extensions authored in Rust*.

Litria's mission constraint points the other way: the March doc's hard requirement is
**TypeScript extensions with a VSIX dual-build path**, which means the target ecosystem is JS.
TS→WASM toolchains (Javy, StarlingMonkey) are immature and amount to embedding a JS engine
*inside* WASM — an extra indirection layer for the same result. So: JS engine, embedded
directly.

But two Zed ideas get stolen outright:

1. **IDL-first interface, everything generated.** One op-registry definition (WIT, or a plainer
   schema file) → codegen for: the TS shim + `.d.ts` published as `@litria/extension-api`, the
   Rust dispatch skeleton + capability table, the manifest JSON schema, and the docs table in
   this file's successor. Commitment #5 above.
2. **Epoch-style interruption budgets** for fairness (threading model, next).

### Threading & event-loop model

- **All isolates live on a dedicated extension-host thread** (a tokio `LocalSet`), never the
  Tauri main thread, never the UI. V8 isolates are single-threaded and pinned; they don't
  migrate.
- **Ops leave via channels**: the isolate issues an op → dispatched to the core's async runtime
  → completion re-enters the extension thread's event loop and resolves the promise. The
  extension thread never blocks on core work; the core never blocks on extensions.
- **Fairness by interrupt budget**: N isolates share one thread cooperatively, so one
  extension's synchronous 200ms loop would stall every other extension's op completions. Each
  isolate gets a wall-clock slice enforced by V8's interrupt/termination mechanism (Wasmtime's
  epoch idea, transplanted). Long-running compute in extensions is documented as an
  anti-pattern; heavy work belongs behind an op.
- **v2 escape hatch unchanged**: moving hostile-tier extensions to a sidecar process relocates
  the whole thread's contents across a real process boundary — same envelope, now serialized.

### Supervision & failure policy

- **Per-op timeout** (default on the order of 10s; op-class overrides in the IDL).
- **Heap breach or interrupt-budget breach → terminate the isolate**, complete its in-flight
  ops as `host_error`, report.
- **Restart policy**: auto-restart with exponential backoff; more than N crashes in a window →
  **quarantined** (disabled until the user re-enables from the extension panel).
- **Health surfacing has a home on each side**: in the sandbox window, the red tab's op log;
  in real Litria, **DevSight** (the planned diagnostics panel) grows an extension-health row —
  state, restart count, last error.

### API delivery

`@litria/extension-api` is a types-and-docs package only — ambient declarations, like
`@types/vscode`. The real implementation (the shim) is injected by the host at isolate init, or
baked into the snapshot. Both artifacts are generated from the same IDL, and
`engines.litria` in the manifest is checked against the shim's API version at load.

---

## Performance budgets

Targets to validate in the walking skeleton — "load-bearing" means numbers, and these are the
numbers a design review measures against (all in-process; sidecar-tier budgets come with v2):

| Metric | Target |
|---|---|
| Op round-trip, ≤1KB params | < 0.5ms |
| Event dispatch, per subscriber | < 0.2ms |
| Isolate memory baseline | ~3MB; default heap cap 8–16MB per extension |
| Cold activation (snapshot warm) | < 50ms |
| First-ever activation (no snapshot) | < 300ms |
| Sandbox window spawn → interactive | < 2s (matches app-startup ethos) |

For calibration: in-process op dispatch is microsecond-class in deno_core; VS Code's
cross-process host is millisecond-class per call. The in-process choice is what buys the
document-mirror and event models their headroom.

---

## Build pipeline & the dev loop

The dogfood plan names the bundling pipeline the *primary purpose* — so it's specified, not
gestured at:

1. **Launch Sandbox** (from the extension project in the main window): run esbuild on
   `litria-entry.ts` per the manifest, stage the bundle + manifest into the central store as a
   dev-mode entry, spawn the sandbox window with it installed.
2. **Watch mode**: file change → rebuild → **hot reload op** into the running sandbox window.
   v1 hot reload is honest: tear down the isolate, recreate, re-fire activation (isolates are
   cheap; preserving extension state across reloads is not a v1 promise).
3. **Build errors** surface in the red tab, not a terminal you have to know to check.
4. **CLI variant later** for CI and the VSIX dual-build (`build/vscode` + `build/litria` per
   the March doc's layout).

The edit → rebuild → reload loop *is* the developer experience being sold; the sandbox window
is its face.

---

## Lifecycle

1. **Install** — bundle lands in the central store (`~/.litria/extensions/<id>/<version>/`),
   manifest validated against the generated schema, capabilities shown and accepted,
   contributed IDs registered (`knownIds`).
2. **Activate** — on a declared activation event (a host-held subscription), the host creates
   the extension's isolate on the extension thread, evaluates the bundle, calls `activate()`,
   replays the trigger.
3. **Run** — ops flow through the broker; events flow back as notifications; Rung 1/2
   contributions were already live from install (static/dynamic rule).
4. **Deactivate / uninstall** — isolate torn down (cheap → **hot reload is feasible**, answering
   the March doc's open question #4); registry entries removed; generated surfaces update.

---

## The sandbox window — developer test host (added 2026-07-05)

"Sandbox" names two coupled things in this design: the **capability sandbox** (runtime
containment — everything above) and the **sandbox window** — the developer-facing test host
where an extension under development actually runs. This section is the second one; it is where
the first one gets exercised.

### The prior art fails at legibility

VS Code's Extension Development Host is a pixel-identical second window. Nothing structural
establishes that a test instance was spawned — no message, no visible separation of concerns.
You just have to know what you're doing, and developers routinely lose track of which window is
the host. That is poor UI/UX. Litria's position: **the fact that you are in a sandbox must be
legible from the window itself, at all times, without theming tricks.**

### Design

- **A separate window, differentiated by shape, not theme.** The sandbox spawns as a second
  Tauri window, inset ~5px relative to the main window, with 8–12px rounded corners. The
  sandbox **fully respects the user's themes, preferences, and UI affordances** — you test in
  the exact environment users actually run. The *chrome* carries the "not real Litria" signal;
  no theme override pollutes what you're testing.
- **A red sandbox tab on the left rail** (the settings/scaffold rail) — permanent, not
  dismissible while the sandbox lives. It houses:
  - Banner at top: *"You are in a sandbox of Litria. This is for testing purposes."*
  - Sandbox dev settings — test workspace picker, extension build info (id / version / bundle
    timestamp), reload.
  - **Candidate: a live broker op log** — every capability call by the extension under test,
    with its grant-check result (and event drop counters). The broker makes this free, and it's
    exactly the dev tool extension authors never get from VS Code.
  - Two exit buttons: **Close and Save** / **Close and Don't Save**.
- **Fully capable.** Not a reduced Litria — everything works, so what you observe in test is
  what ships.

### Transactional test workspace

The defining behavior, and the reason for the two-button close: **everything the extension
under test does to the workspace is staged, not real.**

- All `workspace.write` ops already route through the FSM write manager; in sandbox mode the
  journal simply never flushes to disk. **Close and Save** commits the journal; **Close and
  Don't Save** discards it — the test workspace is untouched, byte for byte.
- Canvas mutations ride session state the same way: committed with the session or dropped
  with it.
- This is only possible *because* of the broker architecture. VS Code cannot offer it —
  extensions there have ambient filesystem access, so there is no chokepoint at which to stage.
  The transactional close is the sandbox window's headline differentiator, and it falls out of
  the capability design rather than being built on top of it.

### Test target

The sandbox opens a **designated test workspace**, not the extension's own source tree —
keeping test fixtures and generated junk out of the extension repo. Chosen via the red tab's
workspace picker, persisted per extension project; optionally seeded from a manifest field
(e.g. `dev.testWorkspace`) so a cloned extension repo knows its test target out of the box.

### Structural prerequisite: two concurrent project sessions

The test workspace is a *different project* open in a *second window of the same process* —
which today Litria cannot do. A 2026-07-05 code audit found the app is closer than expected:
LSP sessions and terminal sessions are already keyed by `project_id`, and backend commands pass
`project_root` explicitly rather than reading a global. The hard blockers are narrow: the
process-wide single-slot project DB (`db/mod.rs` `PROJECT_DB` OnceLock), single-window
`tauri.conf.json`, no window-creation code, and the frontend's destructive in-place project
switch. **Direction and sequencing live in `brief-multi-session-support.md`** — multi-session
lands as its own effort well before extensions, and the sandbox window simply rides it.

### Window-specific open questions

- Title-bar ✕ semantics — prompt Save/Don't-Save, or default to Don't Save?
- Nested sandboxes: launching a sandbox from inside a sandbox should be forbidden (the
  sandbox-launch action is simply absent from the sandbox's action registry).
- Window behavior details: independent vs. child-of-main, multi-monitor, remembered size/pos.

---

## Hardening roadmap (trusted → hostile)

| Stage | Trigger | Adds |
|---|---|---|
| **v1** | Now | Broker + grants, path confinement, heap limit + interrupt budget, per-op timeouts, restart/quarantine policy, no-network default |
| **v1.5** | Sharing extensions with testers | First-use prompts for `workspace.write` / `net.fetch`; grant revocation UI |
| **v2** | Any public distribution | Per-extension process (sidecar) for non-curated extensions; resource quotas; scoped-host network enforcement |
| **v3** | Marketplace | Signing, publisher identity, static capability audit at publish time |

---

## What this doc does *not* reopen

- **Theme Rung-4 (programmatic materials)** stays cut, per the theme-material doc's deliberate
  Rung-2 ceiling. A sandbox existing doesn't reverse that decision — there is no
  `canvas.material` capability. If the theme doc ever revisits, this broker is the mechanism
  it would ride, but that's its call, not this doc's.
- **Marketplace, signing, auto-update, extension dependencies** — inherited non-goals from the
  March doc.
- **Per-extension OS processes in v1** — architecture-ready, not built.

## Open questions

1. **Grant UX details** — install-time list presentation; where revocation and quarantine
   recovery live (extension panel's project view seems natural).
2. **Rung 2 panel placement** — HUD registry section vs docked panel vs floating; likely rides
   the ADR-018 registry but needs sizing/layout rules.
3. **Central action registry** — the shortcut-registry idea, ADR-018's HUD registry, and Rung 1
   converge on one registry serving menus + keys + widgets. Needs its own consolidation pass.
4. **IDL format** — actual WIT, or a plainer schema file feeding the codegen? Decide when the
   walking skeleton starts; the commitment is to *an* IDL, not a specific one.
5. **Event topic taxonomy** — the initial sketch needs a pass against real extension use cases
   before it calcifies into the IDL.
6. **Broker API versioning** — `engines.litria` semantics when the capability vocabulary grows;
   probably additive-only until 1.0.
7. **Bundle format naming** — the March doc's `cm-` prefixes and `.cmx` predate the Litria
   rename; pick final names (`litria-entry.js` used here, container format TBD).
8. **Snapshot strategy vs lazy creation** — lean lazy-with-snapshot (budgets table assumes
   both paths); measure in the skeleton.
9. **Crash-of-extension UX in the sandbox window** — supervision policy defines the mechanics;
   the red tab's presentation of an isolate death needs design.

## Dogfood path

Unchanged from the standing plan: **ExtractToFile** is the first-run target once a walking
skeleton exists (engine embedded, broker with `commands.register` + `editor.selection.read` +
`workspace.write`, manual install). Its failure modes isolate to the pipeline, and its manifest
is the capability vocabulary's acceptance test.

It is also the sandbox *window's* acceptance test: launch the window against a scratch test
workspace, run Extract to File, see the new file appear, then **Close and Don't Save** and
verify the workspace is byte-identical — the transactional journal's first proof. Then repeat
with **Close and Save** and verify exactly one new file.

## References

- Extension-management working notes (2026-03-13, unpublished) — storage, versioning, dual-build, VSIX path
- `docs/plans/ideas/brief-multi-session-support.md` — the sandbox window's structural prerequisite
- ADR-018 — HUD widget registry (Rung 1 surface), `knownIds` install/uninstall semantics
- `docs/plans/ideas/shortcut-registry.md` — action-registry convergence
- `docs/plans/ideas/theme-material-system.md` — the Rung-2 modding ceiling this doc respects
- Filesystem Write Manager plan — the `workspace.write` chokepoint
- Prior art: Zed extensions (Wasmtime + WIT): https://zed.dev/docs/extensions ·
  Lapce plugins (WASI + JSON-RPC) · VS Code extension host (separate process, JSON-RPC,
  contributes/activation model): https://code.visualstudio.com/api
- deno_core: https://crates.io/crates/deno_core · rquickjs: https://crates.io/crates/rquickjs
