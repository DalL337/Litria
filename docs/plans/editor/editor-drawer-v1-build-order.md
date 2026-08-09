# Editor Drawer v1 Build Order

## 1) Core Editor State Contracts
- Define project-instance scoped editor state:
  - `openTabs`
  - `activeTabId`
  - `workingCode`
  - `code`
  - dirty flags
  - recovery snapshot
- Enforce tab limit rule (max 8).
- Define filename-based tab identity.
- Define save API contract (piece state + disk write path).

## 2) Selection-to-Editor Bridge
- Show/hide editor rail tab based on selection count.
- Implement open behavior:
  - single-select affordance
  - double-click immediate open
- Rebuild tabs from current selection (alphabetical by `filename`).

## 3) Editor Drawer Shell (No Monaco Yet)
- Add dedicated editor drawer at 75-80% Desk width.
- Add top tab strip with active/close states.
- Drawer close is hide-only (no save prompt).

## 4) Tab Lifecycle + Dirty UX
- Dirty rule: `workingCode !== code`.
- Render dirty indicators (dot + italic filename).
- Tab close (`X`) behavior:
  - clean tab -> close
  - dirty tab -> prompt `Save / Discard / Cancel` for that tab only

## 5) App Exit Guard
- On app exit with dirty tabs, prompt `Save / Discard / Cancel`.
- Support:
  - save all dirty tabs
  - discard all dirty tabs
  - cancel exit

## 6) Monaco Integration (Lazy)
- Lazy-mount Monaco on first editor open.
- Keep Monaco mounted after first load.
- Bind Monaco models to tab buffers (`workingCode`).

## 7) File Header + Language Comment Rules
- For brand-new empty files, inject filename header comment.
- Use fallback comment syntax for unknown language.

## 8) Persistence Layer
- Save updates both:
  - in-memory piece `code`
  - project file on disk
- Keep `workingCode` as active editor buffer while editing.

## 9) Crash/Restart Recovery
- Persist unsaved session snapshot per project instance.
- Restore tabs, order, active tab, and working buffers on restart.
- Ensure no cross-project state bleed.

## 10) Hardening + Acceptance Sweep
- Validate every checklist item in:
  - `docs/plans/editor-drawer-v1-acceptance-checklist.md`
- Validate edge cases:
  - tab limit overflow
  - deleted piece while tab open
  - missing file on disk
  - corrupted recovery snapshot
