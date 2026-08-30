# Litria Architecture — Domains, Contracts, and Guards

This is the living reference for Litria's frontend architecture: which domains exist, what
each owns, how they may depend on each other, and the contract every domain must satisfy.
The five guard scripts in `scripts/` are the enforcement of record — when this document and
a guard disagree, the guard is the floor and this document is the one that gets fixed.

This document began life as the execution PRD for the App.jsx de-monolith refactor. That
refactor is complete; its history lives in the appendix and in `docs/plans/refactors/`.

---

# 1. Architecture Principles

## 1.1 Domain Principles

1. Single ownership: each state slice has one owning domain.
2. Command/query separation: mutations via commands, reads via selectors.
3. Explicit boundaries: domains communicate through their exposed APIs only — no direct
   cross-domain state writes.
4. Deterministic behavior: domain commands are pure, or their side effects are isolated
   behind adapters.
5. Incremental migration: architectural change lands one responsibility per PR, guarded by
   characterization tests — never big-bang.

## 1.2 Runtime Lifecycle Principles

These apply to any code that spawns processes, threads, or connections (terminal PTYs, LSP
servers, watchers) — on both the JS and Rust sides.

1. Resource lifecycle ownership: every spawned resource has exactly one owner responsible
   for cleanup. The owner is whoever calls spawn/open/connect. Shared access uses
   reference-counted handles with a single teardown coordinator.
2. Teardown cascade ordering: shutdown follows a strict sequence — signal intent, flush
   buffers, wait with timeout, force kill, join/reap. Misordering causes hangs, leaks, or
   data loss.
3. Lock-then-release-then-operate: when an entry must be both removed from shared state and
   torn down, acquire the lock, remove the entry (fast), release the lock, then run slow
   teardown outside the lock. This prevents blocking other consumers of the shared state.

## 1.3 App Shell Contract

`App.jsx` is a composition shell. Anything living there must pass the four-rule test:

1. **Imports.**
2. **Hook invocations** (calling a hook that lives in `src/app/use*` or `src/behaviors/use*`).
3. **Truly cross-cutting wiring** with no natural domain owner.
4. **Composition** that would force a bad abstraction to extract.

Anything else — inline async handlers, fat `useCallback`/`useMemo` bodies, business logic
over imported helpers — belongs in a domain, hook, or selector. When `app-shell-guard.mjs`
rejects a new import, the default response is **extract**, not **amend the manifest**.
Line count is a symptom, not the invariant; the four-rule test is the invariant.

The guard's entry list is the **shell composition manifest** (ratified 2026-07-10 after the
Tier 1/2 debt cleanup removed every four-rule violation from the shell): a permanent,
affirmative registry of what the shell composes, not a transitional allowlist. It growing
with new features is healthy — a shell that composes N domains imports N modules. Every
entry carries a rationale comment; additions must too.

Known guard blind spot: the shell guard checks the import surface only. Logic can
accumulate inside App.jsx with zero new imports, and the guard cannot see it. Reviews of
App.jsx-touching PRs should apply the four-rule test by hand.

---

# 2. Domain Register

One entry per domain: module, wiring, ownership, dependencies. All `*Domain.js` files under
`src/app`, `src/terminal`, `src/scaffold`, and `src/project` are contract-checked by
`domain-contract-guard.mjs` (13 domains at last count). Domains outside that pattern are
marked below.

## 2.1 Canvas / Workspace Domains

1. `PieceDomain`
- Module: `src/app/pieceDomain.js` — wired via `createPieceDomain` in App.jsx.
- Owns: piece entities, create/update/delete/move commands, derived selectors.

2. `SelectionDomain`
- Module: `src/app/selectionDomain.js` — wired via `createSelectionDomain` in App.jsx.
- Owns: selected IDs, focus, multi-select semantics, keyboard modifiers.

3. `InteractionDomain`
- Module: `src/app/interactionDomain.js` — wired via `useInteractionDomain` in App.jsx.
- Owns: drag lifecycle, snap/lasso logic, pointer-state machine.
- Depends on: `PieceDomain`, `SelectionDomain`, `ConnectionDomain`, `HistoryDomain`.
- Cross-domain wiring: receives `syntaxAdapter` as an injected param from the App shell
  (no direct import — composition-shell pattern).

4. `InteractionModeDomain`
- Module: `src/app/interactionModeDomain.js` — exposed as `interactionDomain.modeDomain`.
- Owns: canvas interaction mode system (ADR-013): `default` vs `edit` modes,
  additive/subtractive sub-modes.

5. `GroupDomain`
- Module: `src/app/groupDomain.js` — wired via `createGroupDomain` in App.jsx.
- Owns: group metadata, membership, collapse/expand, rename, manual-group flag.
- Depends on: `PieceDomain`.

6. `ConnectionDomain`
- Module: `src/app/connectionDomain.js` — wired via `createConnectionDomain` in App.jsx.
- Owns: links, tabs/slots, graph derivations, connection constraints.
- Depends on: `PieceDomain`.

7. `HistoryDomain`
- Module: `src/history/undoManager.js` — wired via `createUndoManager` in App.jsx.
  (Predates the `*Domain.js` naming; not scanned by the contract guard.)
- Owns: command stack, transactions, undo/redo orchestration, delete journal.

## 2.2 Project / Filesystem Domains

8. `ProjectDomain`
- Module: `src/project/projectDomain.js` — wired via `createProjectDomain` in App.jsx.
- Owns: project lifecycle side effects — create/open/save/sync, manifest IO, scaffold
  apply transactions.
- Depends on: infrastructure adapters only (fs/manifest/db storage). Must not mutate
  workspace domains directly.

9. `FilesystemWriteManager` (FSM)
- Module: `src/app/filesystemWriteManager.js` — wired via `useFilesystemWriteManager`
  in App.jsx. (Service naming; not scanned by the contract guard.)
- Owns: ALL filesystem mutations (move, rename, create, delete) within a project. Every
  surface that modifies files on disk routes through this manager — no independent Tauri
  invoke calls for fs mutation. Group-folder reconciliation
  (`useGroupFolderReconciliation`) rides on it.

10. `ScaffoldDomain`
- Module: `src/scaffold/scaffoldDomain.js` — wired in the launch flow
  (`src/components/LaunchScreen.jsx`).
- Owns: language/framework/add-on registry, scaffold plan generation (files, dependencies,
  install command, entry file, graph connections), policy defaults (`.env.example`,
  secret-safe `.gitignore` rules, placeholder conventions), preflight validation.
- Must remain side-effect free: no filesystem writes, no adapter calls.
- Collaboration contract: `ScaffoldDomain` produces a validated plan → `ProjectDomain`
  executes the filesystem changes → the scaffold tree UI refreshes from project files
  after apply. The UI gathers form state, requests preview/validation from
  `ScaffoldDomain`, and submits the selected plan to `ProjectDomain`.

## 2.3 Editor / Language Domains

11. `EditorDomain`
- Module: `src/editor/EditorSessionContext.jsx` — wired via `useEditorSession` in App.jsx.
  (Context naming; not scanned by the contract guard.)
- Owns: open files/tabs, dirty state, editor save/discard workflows, split-pane session
  state (ADR-017).
- Depends on: `ProjectDomain`, `HistoryDomain`.

12. `LanguageSupportDomain`
- Module: `src/app/languageSupportDomain.js` — wired via `createLanguageSupportDomain`
  (with LSP adapters) in App.jsx.
- Owns: language-pack prerequisite detection, canonical install-status state model,
  language support availability selectors, install/activate lifecycle orchestration.
- Depends on: infrastructure adapters only (runtime/process detection); no UI imports.

13. `SyntaxDomain`
- Module: `src/app/syntaxDomain.js` — wired via `useSyntaxDomainLifecycle` in App.jsx.
- Adapter: `src/lsp/syntaxAdapter.js` (Monaco bridge — model registry, patch plan
  application). Parser: `src/app/jstsSymbolParser.js` (editor-agnostic JS/TS export
  extractor).
- Owns: symbol index, port index, syntax connection graph, import binding records, patch
  plan generation for connection-driven code updates.
- Depends on: none (pure domain); the adapter depends on the Monaco model API only.
- Related pure services: `src/app/discoveryEngine.js` (discovers edges from existing
  imports/exports), `src/app/exportBlockManager.js` (managed `export { }` block utilities),
  `src/app/jstsImportParser.js`.

## 2.4 Runtime / Platform Domains

14. `TerminalDomain`
- Module: `src/terminal/terminalDomain.js` — wired via `createTerminalDomain` +
  `useTerminalLifecycle` in App.jsx.
- Storage adapter: `src/terminal/terminalStorage.js` (Tauri invoke/event wrappers).
- Owns: terminal session lifecycle (start/end/teardown), active session state
  (sessionId/projectId binding), input/resize proxying, event listener lifecycle,
  backpressure coordination.
- Does not own: terminal UI rendering (xterm.js lives in the presentation layer), drawer
  open/close state, pill notification state.
- Depends on: infrastructure adapters only; no UI imports, no other domain imports.
- Rust backend: `terminal_session_manager.rs`, `terminal_ipc_bridge.rs`,
  `terminal_policy.rs`, `terminal_types.rs` (+ vendored portable-pty with sideloaded
  ConPTY — see PR #106).

15. `PillDomain`
- Module: `src/terminal/pillDomain.js` — pill notification state (queue, ids, listeners).
- Owns: pill notification lifecycle; consumed by the presentation layer.

16. `CrashDomain` (B5)
- Module: `src/crash/crashDomain.js` — pure core: breadcrumb ring, dedupe, record
  building, scrubbing, issue-URL assembly. (Lives outside the contract guard's scan
  globs; its pure core follows the same contract by convention.)
- Runtime: `src/crash/breadcrumbs.js`, `src/crash/errorCapture.js`,
  `src/crash/shutdown.js` (clean-shutdown ritual), `src/crash/invoke.js`.
- UI (deliberately co-located for coverage-over-theming): `src/crash/CrashBoundary.jsx`
  (above theme providers by design), `src/crash/CrashNoticeBanner.jsx`.
- App wiring: session context setters + startup scan in App.jsx; global handlers + React
  root options in `src/main.jsx`; ritual in `src/app/useWindowCloseGuard.js`.
- Rust backend: `src-tauri/src/crash/` (marker, record writer, panic hook, startup scan,
  WebView2 ProcessFailed watcher).
- Owns: crash records, breadcrumb ring, dirty-marker lifecycle, assisted-report assembly.
- Does not own: extension crash handling (sandbox supervision policy's remit),
  general-purpose logging.

17. `ThemeDomain`
- Module: `src/app/themeDomain.js` — wired via `createThemeDomain` in App.jsx.
- Owns: appearance state (theme presets, Live/Calm energy axis, accent), node material
  dispatch, built-in preset protection (delete/rename guards). Defaults live in
  `src/theme/themeDefaults.js`; manifest normalization in `src/project/manifest.js`.

18. `PlatformConfig`
- Module: `src/platform/` (`platformDefaults.js`, `modifierKeys.js`,
  `usePlatformConfig.jsx`). (Config layer, not a command domain.)
- Owns: platform-aware defaults (macOS/Windows/Linux), modifier-key detection — the
  single source of truth replacing ad-hoc `isMac` checks.

## 2.5 Presentation Layer

- Owns rendering only; no domain mutation logic. Composition state helpers that exist to
  serve rendering (`src/app/hudState.js` for the ADR-018 quick-action HUD,
  `src/app/actionTokens.js` for ADR-013 action tokens) are pure, node-tested modules.
- `src/components/ui/` contains shadcn-generated components — owned source, presentation
  only. Domain code must never import from it; only presentation-layer components compose
  shadcn primitives.
- New interactive overlays default to shadcn primitives unless the component is in a
  protected zone. Protected zones (Monaco, canvas, drawers, hover card, pills, status bar,
  scaffold tree, launch screen) remain hand-rolled and are enforced by
  `protected-zone-guard.mjs`. Decision framework and styling contract:
  `docs/ui-governance.md`; rationale: ADR-008.

## 2.6 Unrealized Domains (design intent, never built)

- `ViewportDomain` — planned owner of desk/artboard bounds, scale constraints, DPI
  presets. In practice viewport logic lives in hooks (`useViewportNavigation`) and the
  canvas presentation layer. Revisit only if viewport state grows a real command surface.
- `ScaffoldTreeDomain` — planned owner of explorer tree state. In practice tree state
  lives with the scaffold drawer presentation. Same bar for revival.

---

# 3. Dependency Rules

## 3.1 Allowed

- Presentation layer → any domain's selectors/commands via hooks.
- `InteractionDomain` → `PieceDomain`, `SelectionDomain`, `ConnectionDomain`,
  `HistoryDomain`.
- `GroupDomain` → `PieceDomain`.
- `ConnectionDomain` → `PieceDomain`.
- `EditorDomain` → `ProjectDomain`, `HistoryDomain`.
- `ScaffoldDomain` → pure shared utilities only (no adapters, no UI).
- `ProjectDomain` → infrastructure adapters only (fs/manifest/db).
- `LanguageSupportDomain`, `TerminalDomain` → infrastructure adapters only.
- `SyntaxDomain` → nothing (pure); its Monaco adapter is injected by the shell.
- `CrashDomain` pure core → nothing; capture runtime → window/Tauri APIs only.

## 3.2 Forbidden

- Domain-to-UI imports (domains cannot import React components).
- Any module importing `App.jsx` (only `src/main.jsx` may).
- `ProjectDomain` mutating workspace domains directly.
- Cross-domain state writes except through exposed command APIs.

## 3.3 Enforcement of Record

| Guard | Checks |
|---|---|
| `scripts/architecture-guard.mjs` | Domain files (`src/behaviors`, `src/history`, `src/project`, `src/editor`, `src/app`, `src/terminal`) cannot import UI (`src/components`, `src/drawers`); `src/project` cannot import UI/behaviors/history/editor/App; nothing imports App.jsx except `src/main.jsx`. |
| `scripts/app-shell-guard.mjs` | App.jsx's domain-coupled imports must be in the shell composition manifest (prefixes incl. `./crash/`). Entries carry rationale comments; default response to a rejection is extract. |
| `scripts/domain-contract-guard.mjs` | Every `*Domain.js` in `src/app`, `src/terminal`, `src/scaffold`, `src/project` exports `create*Domain()` or `use*Domain()` and exposes `commands`. |
| `scripts/protected-zone-guard.mjs` | ADR-008 protected files never import `src/components/ui/` or radix-ui. |
| `scripts/settings-key-guard.mjs` | ADR-019: a registered preference key appears as a string literal only in `src/preferences/registry.js` — everywhere else imports `PREF_KEYS`; distinctive keys may not be dot-accessed off raw pref blobs; registry entries satisfy shape invariants (unique keys, explicit `projectOverridable`, overridable ⇒ surfaces in the project place, enum defaults legal). |
| `scripts/editor-engine-guard.mjs` | The editor engine (Monaco) stays sealed in `ENGINE_FILES`: only those files may import the engine's npm packages or the `monacoSetup`/`monacoWorkspace` facades, use engine vocabulary (`MarkerSeverity`, `cm://`, …), or query engine-owned DOM classes (`.monaco-*`). Modules in `INJECTED_COUPLING_FILES` receive engine objects as arguments instead of importing them — allowed, and printed on every run because their union is the editor-engine contract. `TEMP_ALLOWED_DOM_COUPLING` is debt, not a grant. |

Known coverage gaps (doc is stricter than the floor): `src/crash` and `src/scaffold` are
not in the architecture guard's domain prefixes, and `src/crash` is not in the contract
guard's scan globs. The rules above still apply there; enforcement is by review until the
guards are extended.

---

# 4. Domain Contract Standard

Domains are plain JavaScript modules. Every domain exposes:

1. A factory `create<Name>Domain(deps)` — or a hook `use<Name>Domain(params)` when the
   domain is a React integration layer.
2. `commands` — mutation methods with explicit inputs; side effects isolated behind
   injected adapters.
3. `selectors` — read-only derived queries.
4. `events` (optional) — subscription points for orchestration.
5. Tests — command behavior and selector correctness under `node --test`
   (`test/` and `test/domains/`); integration tests for cross-domain flows.

The contract guard enforces (1) and (2) mechanically; (3)–(5) are held by review.

Shape sketch:

```js
export function createPieceDomain(deps) {
  // internal state owned here
  const commands = {
    createPiece(input) { /* ... */ },
    movePiece(input) { /* ... */ },
    deletePiece(input) { /* ... */ },
  };
  const selectors = {
    getPiece(id) { /* ... */ },
    listPieces() { /* ... */ },
  };
  return { commands, selectors };
}
```

---

# Appendix: Origin — the App.jsx De-Monolith (completed)

This document was originally the "Litria Platform Domain Orchestration — Execution PRD +
Engineering Plan": the six-phase plan that broke a ~2,100-line monolithic `App.jsx` into
the domain architecture described above. All six phases are complete (domain mapping →
piece/selection extraction → interaction extraction → group/connection isolation →
persistence separation → final orchestration shell), followed by a four-session app-shell
extraction pass. The guards in `scripts/` are the enduring artifact of that plan's
enforcement model.

Phase checklists, the enforcement model, baseline captures, and the sequenced execution
plan are preserved in `docs/plans/refactors/` (`app-refactor-*.md`,
`app-shell-extraction-checklist.md`).
