# Brief: Group Physicality — No Ghost Groups

> **Status**: Delivered — all five workstreams shipped 2026-08-01/02, same
> session the ruling was made: W1 PR #241 (empty folders first-class, D1/D2
> enforced in the reconciler, keepGroup, and the drop path), W4 PR #242
> (ghost rectification on open + info pill, DP2), W2+W5 PR #243 (name-first
> disk-first creation per DP1/DP3; confirm-guarded folder deletion per DP4),
> W3 in the retirement PR (promote flow, dotted visual per DP5,
> membership-only drops, `createManualGroup` — all removed; the
> `promoteToFolderGroup` domain command survives as the rectifier's engine).
> Known residual: a group that empties at runtime with no persisted seed is
> alive but geometry-less until reconciliation heals it — seed-backfill is
> the natural follow-up slice.
> All five DPs owner-ruled (see §4).
> **Owner ruling (2026-08-01, verbatim intent)**: "Empty folders/groups need to
> have real physicality/existence in the app — in the scaffold and in the canvas
> as well. That means they need to exist on the disk and not be a ghost
> operation. Originally this was part of the plan-mode staircase, but this
> exposes a bad operation expectation."
> **Trigger**: live incident 2026-08-01 — an empty folder (`newfolder`, created
> via the scaffold New Group pill) could not be dragged onto the canvas: the
> folder-to-canvas spawn silently early-returns on zero files, and the
> reconciler never creates groups for empty folders. Investigating exposed the
> wider ghost-group ambiguity.
> **Supersedes in part**: ADR-018's box-first *manual (folder-less) group*
> concept as a persistent default state; the containment brief's scope-out of
> manual groups ("unaffected by all of the above"); the manual
> promote-to-folder flow as the only materialization path.
> **Preserves**: plan-only mode as a FUTURE, EXPLICIT mode (the `group_pieces`
> seam stays); ADR-019/ADR-013 grammar; D1/D2 rulings of
> `brief-nested-group-containment.md` (this brief is their enforcement
> vehicle for the empty case).

## 1. The principle

**A group IS a folder.** The scaffold's New Group pill already says so in its
own comment. The canvas must say the same:

- Creating a group — from any surface — creates a folder on disk, through the
  filesystem write manager, before or atomically with the state write
  (implementation-policy Rule 7: state follows disk).
- An empty folder is a first-class citizen on every surface: it exists on disk,
  renders in the scaffold (already true), and has a canvas presence (D2:
  "every folder on disk has a canvas presence, including scaffold-created
  empty ones"; D1: "a group lives exactly as long as its folder does, however
  it got empty").
- No surface performs a "ghost operation" — an action that looks structural but
  writes no disk. Deferred materialization is not an ambient default; if
  plan-only mode ships someday, it is an explicit, labeled mode.

## 2. Current ghost inventory (verified in code, 2026-08-01)

| Ghost | Where | Behavior today |
|---|---|---|
| Canvas New Group | `useGroupMenuActions.js` `handleCreateManualGroup` | Auto-named `Group N`, persisted with `folderPath: null`. No disk write ever. |
| Manual-group membership | `groupDropHandlers.js` (folder-less branch) | Dropping a piece into a manual group writes `group_pieces` rows only — the file does not move on disk. |
| Materialization | `groupDomain.promoteToFolderGroup` + menu item | Manual, user-invoked, gated on ≥1 member. Nothing automatic. |
| Empty-folder drop | `useScaffoldActions.js` `handleScaffoldOpenFolder` | `if (filesInFolder.length === 0) return;` — silent no-op, no group. |
| Empty-folder reconcile | `reconcileGroupsWithFolders.js` | Creates groups only for folders holding direct pieces — empty folders never materialize on canvas. |
| Visual language | `useWorkspaceRenderSelectors` (`isManual`) | Dotted box = "not on disk yet" — a state this ruling abolishes. |

## 3. Workstreams

- **W1 — Empty folders exist on canvas** (the live-incident fix): the
  folder-drop path creates the (empty, collapsed) group instead of
  early-returning; the reconciler gains D2 parity — every folder on disk gets
  a group, empty included. Empty groups need seed geometry — the existing
  `seedBounds` machinery is reused as the geometry for empty *disk* groups
  (spawn-position logic for the drop; reconciler placement per DP1).
- **W2 — Canvas group creation is disk-first**: New Group (HUD / menubar)
  creates a real folder via the write manager, then the group derives from it.
  Needs a name before disk contact (DP3) and a parent folder (DP1). Refusals
  (reserved names, conflicts) surface exactly like scaffold folder creation.
- **W3 — Retire the ghost machinery**: `promoteToFolderGroup` + its menu item
  (everything is born material); the dotted-box "not on disk yet" language
  (DP5); the membership-only drop branch (drag-into-group always moves the
  file on disk — one consistent rule).
- **W4 — Migration**: existing projects may hold folder-less groups in
  SQLite. One-time materialization on open (DP2).
- **W5 — Lifecycle symmetry**: delete/undo semantics for born-material groups
  (DP4). D1 governs: the group lives exactly as long as its folder.

## 4. Decision points (owner rulings 2026-08-01)

- **DP1 — RULED: the cursor is the measurement.** "It goes where it's
  created": creating inside an open expanded group's box → nested folder in
  that group's folder (innermost wins, same rule as drops); creating over an
  open section of canvas → project root.
- **DP2 — RULED: silent rectification + informational pill.** On open, any
  `folderPath: null` group row auto-materializes its folder (named after the
  group, uniquified per the promote flow's rules), and a one-line pill
  reports it — notification, not consent: "we did this so Litria doesn't eat
  itself or the workspace.db doesn't burn down and you find out later"
  (owner, verbatim). Context: these rows are ADR-018 Stage-1 manual groups
  (HUD + New Group, `folderPath: null`, scaffold-invisible until promoted);
  internal-beta population ≈ the owner's own test projects.
- **DP3 — RULED: name-first.** Inline name input before disk contact, like
  the scaffold flow; no auto-named folder litter.
- **DP4 — RULED with amendment: confirm before deleting.** Undo of group
  creation deletes the empty folder only after an "are you sure" confirm
  (UnsavedChangesPrompt/AlertDialog precedent — it deletes something real).
  A folder that has since gained content is never deleted: undo refuses
  with a whisper.
- **DP5 — RULED: retire the dotted language entirely.** Owner note: dotted +
  the solid edit-mode highlight reads busy — the edit-mode solid highlight
  around a group is sufficient differentiation on its own. Plan-only mode,
  if built, proposes its own language as part of being an explicit mode.

## 5. Non-goals

- Plan-only mode itself (future, explicit; `group_pieces` seam untouched).
- D4 (parent drag carries subtree) and D5 (containment tint/occlusion) — same
  brief family, separate delivery.
- Scaffold-side behavior: already material (its New Group creates real
  folders); only its empty-folder canvas absence changes (W1).

## 6. Sequencing sketch

W1 (small, fixes the live incident; no rulings needed beyond D1/D2 already
given — DP1 affects only reconciler placement, drop placement uses the drop
point) → DP rulings → W2+W3 (one arc; touches creation grammar) → W4
(migration; DP2) → W5 rides W2.
