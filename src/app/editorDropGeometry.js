/**
 * Pure geometry for dragging a canvas node into an editor pane (ADR-017
 * Phase C, node→pane slice). The canvas and the editor drawer are different
 * rendering worlds (Konva stage below, DOM overlay above), so the drop
 * target is resolved from bounding rects, not DOM hit-testing — during a
 * canvas drag the overlays drop pointer-events (internals note 2), which
 * makes elementsFromPoint blind to them.
 *
 * Returns:
 *   null            — cursor not over an open editor drawer
 *   { paneId: 1|2 } — drop opens/moves the file into that pane
 *   { paneId: 'side' } — right-edge zone while single-pane: create the split
 */

// Fraction of the editor body width (from the left) that still targets the
// main pane while single-pane; the remainder is the split-preview zone.
export const SIDE_ZONE_START = 0.62;

const contains = (rect, x, y) => (
  rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
);

export function resolveEditorDrop({ x, y, drawerRect, bodyRect, shellRects = [], isSplit }) {
  if (!contains(drawerRect, x, y)) return null;

  if (isSplit && shellRects.length >= 2) {
    // Two panes: whichever shell the cursor is inside; tab-strip zone above
    // the shells falls back to horizontal halves so strips are targets too.
    if (contains(shellRects[0], x, y)) return { paneId: 1 };
    if (contains(shellRects[1], x, y)) return { paneId: 2 };
    const midX = (shellRects[0].right + shellRects[1].left) / 2;
    return { paneId: x < midX ? 1 : 2 };
  }

  // Single pane: right-edge zone previews "open in new pane".
  if (bodyRect && contains(bodyRect, x, y)) {
    const inSideZone = x > bodyRect.left + bodyRect.width * SIDE_ZONE_START;
    if (inSideZone) return { paneId: 'side' };
  }
  return { paneId: 1 };
}
