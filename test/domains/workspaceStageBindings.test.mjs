import test from 'node:test';
import assert from 'node:assert/strict';

import { useWorkspaceStageBindings } from '../../src/app/useWorkspaceStageBindings.js';

// The bindings assembler is an explicit-enumeration seam: a prop added to
// App's input object but not threaded here is SILENTLY dropped, and the
// stage renders without it. That exact failure shipped once — wireRoutes
// vanished at this hop and every wire fell back to the unrouted cubic
// (ADR-025 live-verify, 2026-07-31). This pins the wire-render contract.

// Despite the use* name the assembler is a pure function of its props (no
// hooks), so it is callable directly.
const stubInput = () => ({
  selectionDomain: { selectors: { isSelected: () => false } },
  connectionDomain: { selectors: { getTabsForPiece: () => [], getSlotsForPiece: () => [] } },
  lasso: { selectionBox: null },
  viewport: { scale: 1, offsetX: 0, offsetY: 0, zoomAtPoint: () => {} },
  renderableWires: [{ marker: 'wires' }],
  wireRoutes: new Map([['w', { points: [], routed: true }]]),
  syntaxConnStatuses: new Map(),
  selectedConnectionId: 7,
});

test('the wire-render contract survives the bindings hop', () => {
  const input = stubInput();
  const out = useWorkspaceStageBindings(input);
  assert.equal(out.renderableWires, input.renderableWires);
  assert.equal(out.wireRoutes, input.wireRoutes);
  assert.equal(out.syntaxConnStatuses, input.syntaxConnStatuses);
  assert.equal(out.selectedConnectionId, input.selectedConnectionId);
});
