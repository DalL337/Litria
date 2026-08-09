import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveEditorDrop, SIDE_ZONE_START } from '../../src/app/editorDropGeometry.js';

const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });

const drawerRect = rect(1000, 0, 900, 1000);   // drawer on the right
const bodyRect = rect(1010, 200, 880, 780);    // editor body inside it
const shell1 = rect(1010, 240, 430, 700);
const shell2 = rect(1460, 240, 430, 700);

test('cursor outside the drawer resolves to null', () => {
  assert.equal(resolveEditorDrop({ x: 500, y: 500, drawerRect, bodyRect, isSplit: false }), null);
  assert.equal(resolveEditorDrop({ x: 500, y: 500, drawerRect: null, bodyRect, isSplit: false }), null);
});

test('single pane: left of the side zone targets pane 1', () => {
  const x = bodyRect.left + bodyRect.width * (SIDE_ZONE_START - 0.1);
  assert.deepEqual(
    resolveEditorDrop({ x, y: 500, drawerRect, bodyRect, isSplit: false }),
    { paneId: 1 }
  );
});

test('single pane: right-edge zone previews the split', () => {
  const x = bodyRect.left + bodyRect.width * (SIDE_ZONE_START + 0.1);
  assert.deepEqual(
    resolveEditorDrop({ x, y: 500, drawerRect, bodyRect, isSplit: false }),
    { paneId: 'side' }
  );
});

test('single pane: drawer chrome above the body still targets pane 1', () => {
  assert.deepEqual(
    resolveEditorDrop({ x: 1800, y: 100, drawerRect, bodyRect, isSplit: false }),
    { paneId: 1 }
  );
});

test('split: each shell is its own target; the gap splits at the midline', () => {
  const common = { drawerRect, bodyRect, shellRects: [shell1, shell2], isSplit: true };
  assert.deepEqual(resolveEditorDrop({ ...common, x: 1200, y: 500 }), { paneId: 1 });
  assert.deepEqual(resolveEditorDrop({ ...common, x: 1700, y: 500 }), { paneId: 2 });
  // Tab-strip zone above the shells: horizontal halves.
  assert.deepEqual(resolveEditorDrop({ ...common, x: 1200, y: 220 }), { paneId: 1 });
  assert.deepEqual(resolveEditorDrop({ ...common, x: 1700, y: 220 }), { paneId: 2 });
});
