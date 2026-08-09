# New Project Wizard — Prototype

Standalone prototype of the matrix-driven New Project Wizard. Double-click
`index.html` or serve the folder. There is no build step; it runs in any browser.

## Files

- `compatibility-matrix.js` — copy of the production scaffold compatibility matrix. Edit this to test new stack combinations.
- `wizard.js` — vanilla JS wizard prototype with the expanded creation flow.
- `preview-canvas.js` — the real-primitive preview renderer. Ports the Canvas 2D `sceneFunc` bodies from the production `PuzzlePiece`, `FolderGroupPill`, `GroupOutline`, and `EdgeGlow` components so the style sample is the actual paint path, not a DOM approximation.
- `wizard.css` — standalone styling for the modal, stack cards, workspace setup, style sample, and capstone.
- `index.html` — entry point.

## Flow

The wizard uses four pages:

1. **Project Identity** — project name and location.
2. **Stack Setup** — wrapper, framework, language, backend, add-ons, and package manager.
3. **Workspace Style** — base theme, folder group color behavior, single-piece color behavior, and assigned-color edge glow policy.
4. **Capstone** — final review only. No new choices. Shows project, stack, workspace, command preview, and a visual style sample.

## Color palette

Group and single-piece color pickers use the real app palette — the 16 hex values in `THEME_ACCENT_SWATCHES` (`src/app/themeDomain.js`), rendered as unlabeled 22×22 squares in an 8-column grid, matching `ColorPickerPopup`. No invented swatch names.

## Style sample vs. mini workspace

The preview on page 3 and the capstone is a **Workspace Style Sample** rendered on a real `<canvas>`. It uses the same Canvas 2D paint path as the production Konva sceneFuncs, so the glass surfaces, Snell-corner highlights, rim stroke, edge-assignment gradient, corner LED, folder group pill (fill + rim + divider + LED), dashed-outline group enclosure, and multi-pass hover edge-glow all look exactly like what the user will see in the real workspace.

Fixture scene (fixed layout so sizing/spacing is stable):

- A folder group outline enclosing a folder group pill and one "inherited" piece on the left.
- A standalone piece on the right, with a left-edge hover glow.

No canvas grid is drawn — the sample is a style preview, not a promise of starting layout or snap behavior.

## Edge glow direction

The intended behavior is a color continuum:

1. piece color wins first,
2. inherited folder group color second,
3. theme connection color fallback last.

That keeps the folder group pill, group outline, node assignment strips, and hover edge glow visually coherent.

## What's simulated vs real

Real:

- Full cascade flow for stack selection.
- Matrix-driven filtering.
- Add-on dependency locking.
- Angular TypeScript lock.
- Web-only backend options.
- Flag-preview output.
- Workspace setup state and review summary.
- Real color palette from `THEME_ACCENT_SWATCHES`.
- Real primitive rendering in the Workspace Style Sample (Canvas 2D, same paint path as the Konva sceneFuncs).

Simulated:

- **Browse** uses `prompt()` instead of a native Tauri folder dialog.
- **Create Project** streams fake step output instead of running `scaffold_project`.
