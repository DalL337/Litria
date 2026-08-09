# Brief: Exit to Launcher + Exit (File menu)

> **For:** Claude Code
> **Scope:** Two new File-menu items — **Exit to Launcher** (return to the launch screen without closing the app) and **Exit** (close the app). Includes extracting the project-switch teardown into a shared coordinator and a dirty-tab prompt gate for the launcher path.
> **Stack:** React 19, Tauri v2.
> **Status:** Single slice, implemented alongside this brief (the brief is the design record).

---

## Motivation (owner, 2026-07-10)

While streaming Litria there was no clean way to get back to the launcher — the
launcher gate (`if (!projectInstance)` in `App.jsx`) is a one-way door; nothing
in the codebase ever sets `projectInstance` back to null. Exiting to the
launcher should behave like live project switching (same teardown), just with
the launcher as the destination instead of another project.

**Naming decision:** the item is **"Exit to Launcher"**, not the conventional
"Close Project". Litria's identity is visual legibility — the label says where
you land. Convention/muscle-memory of the status quo deliberately loses here.

## Ground truth (verified against the code)

- **Teardown already exists but is inlined.** The hardened project-switch
  coordinator lives inside `handleOpenProjectInstance`
  (`src/app/useProjectLaunch.js`): terminal `teardownAll` → TS LSP teardown →
  Python LSP teardown → `clearAllDiagnostics()` → `dbCloseProject()`, each
  under a 5s `withTimeout`. Ordering is load-bearing — see
  `docs/plans/persistence/project-switch-crash-investigation.md` Phase 3.
- **Dirty tab content is memory-only.** `workingCode` lives in editor tab
  state and piece state; it reaches disk only on save, and hydration reads
  from disk (`useProjectPersistence.js`). The debounced DB writes persist tab
  *layout* (open/active tab ids) and viewport — **not content**. So live
  project switching today silently discards unsaved edits. For Exit to
  Launcher the unsaved-changes prompt is therefore load-bearing, not just
  polish.
- **Exit path exists, minus the menu item.** `useWindowCloseGuard` intercepts
  `onCloseRequested`: dirty tabs → `UnsavedChangesPrompt`; clean → crash-marker
  ritual (`performCleanShutdown`) → close.
- **Editor session resets for free.** `useProjectPersistence` mirrors
  `projectInstance?.instanceId ?? null` into `setProjectInstanceId`, and
  `EditorSessionContext` dispatches `RESET_SESSION` on any instance-id change —
  including → null.
- **Crash crumbs handle null already.** `App.jsx` crumbs
  `project: none` and clears the crash project name whenever `projectInstance`
  changes.
- **Undo history is never cleared on switch** (`createUndoManager` has
  `clear()`; no caller). Latent pre-existing bug: undo after a live switch
  could resurrect the previous project's canvas state.

## Design

### 1. Shared coordinator: `teardownActiveProject()`

Extract the teardown block from `handleOpenProjectInstance` into a
`teardownActiveProject` callback in `useProjectLaunch`. Two callers: project
switch and Exit to Launcher. One copy, no drift. It additionally calls
`clearHistory?.()` (the undo manager's `clear`) — correct for both callers and
fixes the latent stale-undo bug on live switch as a side effect.

### 2. `handleExitToLauncher` (unguarded action, in `useProjectLaunch`)

```
await teardownActiveProject()
wipe workspace state          // pieces, nextId, groups, nextGroupId,
                              // selectedGroupId, hiddenScaffoldPaths,
                              // selection, connections, nextConnectionId
setProjectInstance(null)      // launcher gate re-renders LaunchScreen;
                              // instanceId → null dispatches RESET_SESSION
```

The explicit wipe matters because `App` itself never unmounts — without it,
stale pieces sit in memory and (a) could flash before the next project's
hydration replaces them, (b) would leak into a subsequent launcher
"Open File"/"New File" single-file session, whose hydration path loads
nothing (`manifestPath === null`). Connections are included in the wipe for
the same reason — the launcher makes single-file sessions reachable *after*
a project for the first time. Wipe list mirrors `startSingleFileSession`.

No clean-shutdown ritual: this is not an app exit; the session continues.

### 3. Dirty-tab gate: `useUnsavedChangesGate` (new hook, `src/app/`)

*(Originally shipped as `useExitToLauncher`, launcher-only; generalized in
the follow-up slice when the same gap was closed for live project switch.)*

One shared, promise-based gate for project-lifecycle transitions.
`guardUnsavedChanges(kind)` resolves `true` when the transition may proceed:

- clean (no dirty tabs) → resolves `true` immediately, no prompt.
- **Save** → `saveAllTabs()`; resolves `false` (untitled Save As canceled) →
  gate resolves `false`, stay in workspace. Same abort contract as the
  window-close exit prompt.
- **Discard** → `discardAllTabs()` → resolves `true`.
- **Cancel** → resolves `false`.

Injected into `useProjectLaunch`, which gates at two choke points:

- `handleExitToLauncher` (`kind: 'exit-to-launcher'`).
- `handleOpenProjectInstance` (`kind: 'switch-project'`) — covering **all**
  live-switch entry points at once: File → Open Project… (gate fires AFTER
  the folder picker, so Discard can never fire for a switch the user then
  abandons at the picker), the in-workspace **ProjectSwitcher** dropdown,
  and the launcher open paths (no-op there — no tabs can be dirty).

Rendered as a single `UnsavedChangesPrompt` instance with per-kind copy
(`UNSAVED_CHANGES_PROMPT_COPY`). The window-close prompt and its shutdown
semantics (`beginShutdown`, ritual) are untouched.

### 4. Exit menu item

`useWindowCloseGuard` gains `requestAppClose()` — asks the Tauri window to
close, which fires `onCloseRequested` and routes through the *existing* guard
(dirty prompt / ritual / close). File → Exit and the title-bar X are the same
code path by construction; no duplicated guard logic.

### 5. Menu placement (`buildFileMenu`)

```
… Save / Save All
─────────────
Exit to Launcher
─────────────
Exit
```

Exit sits dead last — bottom-of-File-menu Exit is load-bearing Windows
convention. Both items are enabled unconditionally in the workspace (the menu
bar only renders with a project open; single-file/untitled sessions included).

## Non-goals / follow-ups

- ~~**File → Open Project… still has no dirty-tab gate**~~ — **RESOLVED** in
  the follow-up slice (same day): gate generalized to
  `useUnsavedChangesGate` and applied inside `handleOpenProjectInstance`,
  which also covered the in-workspace ProjectSwitcher (a second silent-discard
  entry point found during implementation). Ordering decision: prompt AFTER
  the folder picker — prompting before would let Discard destroy edits for a
  switch the user then cancels at the picker.
- **Viewport state is not reset** on exit-to-launcher — next DB-backed project
  hydrates its own viewport; single-file sessions inherit the stale viewport
  exactly as the existing Open File flow does today.
- No launcher-side changes: recents already show the just-left project
  (recorded on open).

## Found by the round-trip test: disposed-model crash (fixed in this slice)

First owner round-trip (dirty tab → Save → launcher → reopen same project)
crashed the renderer: **"Model is disposed!"** in `EditorMonacoPane`'s
model-sync effect (B5 crash log `crash-1783717220366-2492-react.json`; the
breadcrumbs show two clean round-trips, then the crash on the reopen that
followed a Save with an editor tab open).

Root cause: `monacoWorkspace.js` keeps a **module-level** `models` map
(tabId → ITextModel) that outlives the React tree. `@monaco-editor/react`'s
`<Editor>` disposes its attached model on unmount (`keepCurrentModel` defaults
to false). Within a project the EditorMonaco tree stays mounted once
initialized, so that dispose never used to fire — Exit to Launcher unmounts
the whole workspace, disposing the active model *behind the registry's back*,
and the container's `releaseClosedTabs` effect (which would purge the map)
never runs because it unmounts in the same commit. Reopening the **same**
project reuses the same tab ids, so `getModel`/`acquireModel` served the
disposed model. Live project switch never trips this because the workspace
stays mounted and `releaseClosedTabs([])` runs on the RESET_SESSION.

Fix: self-healing registry — every read of the models map goes through
`getLiveModel()`, which treats `isDisposed()` entries as absent (purge +
recreate on next acquire). Also guarded: `releaseClosedTabs` (skip
marker-clear/dispose on already-disposed models) and the LSP session-replay
in `subscribeLspEvents` (`model.getValue()` on restart would have hit the
same corpse via stale `openLspTabs` entries).

## Verification

- `node --test` domain suite + guards green; vite build green.
- **Round-trip smoke test (the one that earns the merge):** open project →
  Exit to Launcher → reopen the *same* project. Exercises the `PROJECT_DB`
  singleton (`db/mod.rs`) through close→reopen of the same path and every
  instanceId-keyed lifecycle through the never-before-seen non-null → null →
  non-null transition. Also: dirty tab → all three prompt branches; untitled
  session → Save → cancel the Save As dialog → session stays open.
