# Phase 6 Manual Closeout Script (Phase 0 Parity)

## Goal
Run the Phase 0 parity checks end-to-end on the current Phase 6 build and record pass/fail.

## Setup
1. Launch Litria in your normal dev workflow.
2. Use one existing test project (or create one if needed).
3. Keep DevTools open for error visibility.

## Script
1. Launch project from launch screen.
Expected: project opens to desk with no blank screen or runtime error.

2. Open/create at least one piece.
Expected: piece appears on desk and in scaffold.

3. Select one piece and open editor via launcher tab.
Expected: editor opens focused on selected piece file.

4. Edit tab content and save.
Expected: save succeeds, dirty indicator clears.

5. Reopen project and verify persisted content.
Expected: saved content restores.

6. Dirty tab close prompt behavior.
Expected: `Save`, `Discard`, and `Cancel` all behave correctly.

7. App exit with dirty tabs.
Expected: unsaved-changes exit prompt appears and each action path works.

8. Lasso multi-select.
Expected: box-select includes intended pieces.

9. Multi-piece drag.
Expected: selected pieces move together.

10. Snap on drag end.
Expected: snap behavior still applies when appropriate.

11. Undo/redo on move + create/delete.
Expected: undo/redo stack transitions are correct.

12. Group menu actions.
Expected: create/collapse/expand/rename/delete behave correctly.

13. Scaffold drawer select/open-entry.
Expected: selecting/highlighting/opening entries works.

14. Folder group path updates.
Expected: folder-group create/rename updates associated file paths correctly.

15. Drag smoothness spot check.
Expected: no obvious frame drops during normal dragging.

## Record
- Result: `PASS` (user-run, 2026-02-14)
- Failed step(s): `None (initial blockers fixed during closeout pass)`
- Notes:
  - Fixed during closeout:
    - project create root-path instancing (parent path bleed into scaffold)
    - new piece file not appearing in scaffold immediately
    - group drag Leadpiece/Sister piece(s) snap+adjacency drift
    - scaffold root-child indentation hierarchy
  - Final verification confirms:
    - project instancing works
    - piece/file appears in scaffold
    - group drag + adjacency + snapping stable with relative positioning preserved
