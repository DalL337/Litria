import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveWireAppearance,
  isExceptionStatus,
  WIRE_GAUGE_NEUTRAL_REST,
  WIRE_GAUGE_EXCEPTION_REST,
  WIRE_GAUGE_HOVER,
  WIRE_GAUGE_SELECTED,
  WIRE_MIN_PX_NEUTRAL,
  WIRE_MIN_PX_STATUS,
  WIRE_FOCUS_DIM_OPACITY,
} from '../../src/utils/wireAppearance.js';

// ---------------------------------------------------------------------------
// isExceptionStatus — which statuses rest popped (ADR-025 §5)
// ---------------------------------------------------------------------------

test('healthy syntax statuses are not exceptions (green retires at rest)', () => {
  assert.equal(isExceptionStatus('resolved', 'valid'), false);
  assert.equal(isExceptionStatus(null, 'valid'), false);
  assert.equal(isExceptionStatus(null, undefined), false);
});

test('unhealthy syntax statuses are exceptions', () => {
  for (const s of ['broken', 'orphaned', 'drifted', 'unused', 'pending']) {
    assert.equal(isExceptionStatus(s, 'valid'), true, s);
  }
});

test('syntax status takes priority over piece health (mirrors color logic)', () => {
  // resolved syntax + broken piece health → healthy (syntax wins)
  assert.equal(isExceptionStatus('resolved', 'error'), false);
  // no syntax edge → piece health decides
  assert.equal(isExceptionStatus(null, 'error'), true);
  assert.equal(isExceptionStatus(null, 'empty'), true);
  assert.equal(isExceptionStatus(null, 'warning'), true);
});

// ---------------------------------------------------------------------------
// resolveWireAppearance — rest states
// ---------------------------------------------------------------------------

test('healthy wire rests thin, neutral, glowless, fully opaque', () => {
  const a = resolveWireAppearance({ syntaxStatus: 'resolved' });
  assert.equal(a.gauge, WIRE_GAUGE_NEUTRAL_REST);
  assert.equal(a.useStatusColor, false);
  assert.equal(a.glow, false);
  assert.equal(a.opacity, 1);
  assert.equal(a.minPx, WIRE_MIN_PX_NEUTRAL);
});

test('exception wire rests popped in status color without hover (PR #166 property)', () => {
  const a = resolveWireAppearance({ syntaxStatus: 'broken' });
  assert.equal(a.gauge, WIRE_GAUGE_EXCEPTION_REST);
  assert.equal(a.useStatusColor, true);
  assert.equal(a.glow, false); // glow stays confined to hover/selection
  assert.equal(a.opacity, 1);
  assert.equal(a.minPx, WIRE_MIN_PX_STATUS);
});

test('neutral rest may drop below the status color-channel floor', () => {
  assert.ok(WIRE_MIN_PX_NEUTRAL < WIRE_MIN_PX_STATUS);
});

// ---------------------------------------------------------------------------
// resolveWireAppearance — attention states (hover = inspect, click = hold)
// ---------------------------------------------------------------------------

test('hover pops any wire to gauge + status color + glow', () => {
  const healthy = resolveWireAppearance({ syntaxStatus: 'resolved', isHovered: true });
  assert.equal(healthy.gauge, WIRE_GAUGE_HOVER);
  assert.equal(healthy.useStatusColor, true); // inspect reveals health (green)
  assert.equal(healthy.glow, true);

  const broken = resolveWireAppearance({ syntaxStatus: 'broken', isHovered: true });
  assert.equal(broken.gauge, WIRE_GAUGE_HOVER);
  assert.equal(broken.useStatusColor, true);
});

test('selection holds the pop with glow', () => {
  const a = resolveWireAppearance({ syntaxStatus: 'resolved', isSelected: true });
  assert.equal(a.gauge, WIRE_GAUGE_SELECTED);
  assert.equal(a.useStatusColor, true);
  assert.equal(a.glow, true);
  assert.equal(a.opacity, 1);
});

// ---------------------------------------------------------------------------
// resolveWireAppearance — global focus swap
// ---------------------------------------------------------------------------

test('focus swap dims every non-hovered wire, exceptions included', () => {
  const neutral = resolveWireAppearance({ syntaxStatus: 'resolved', isFocusDimmed: true });
  assert.equal(neutral.opacity, WIRE_FOCUS_DIM_OPACITY);

  const exception = resolveWireAppearance({ syntaxStatus: 'broken', isFocusDimmed: true });
  assert.equal(exception.opacity, WIRE_FOCUS_DIM_OPACITY);
  // A dimmed exception keeps its popped body and status color — it whispers,
  // it doesn't lose its identity.
  assert.equal(exception.gauge, WIRE_GAUGE_EXCEPTION_REST);
  assert.equal(exception.useStatusColor, true);
});

test('the hovered wire never dims itself', () => {
  const a = resolveWireAppearance({ syntaxStatus: 'resolved', isHovered: true, isFocusDimmed: true });
  assert.equal(a.opacity, 1);
});

test('selection is exempt from the focus swap (gesture outranks attention)', () => {
  const a = resolveWireAppearance({ syntaxStatus: 'resolved', isSelected: true, isFocusDimmed: true });
  assert.equal(a.opacity, 1);
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test('no arguments resolves to a healthy neutral rest wire', () => {
  const a = resolveWireAppearance();
  assert.equal(a.gauge, WIRE_GAUGE_NEUTRAL_REST);
  assert.equal(a.useStatusColor, false);
  assert.equal(a.opacity, 1);
});

// ---------------------------------------------------------------------------
// D1c adjacency fade band (replaces the binary reveal cliff)
// ---------------------------------------------------------------------------

const { adjacencyFadeFactor, WIRE_FADE_HIDE_PX, WIRE_FADE_FULL_PX } =
  await import('../../src/utils/wireAppearance.js');

test('contact and near-contact render nothing', () => {
  assert.equal(adjacencyFadeFactor(0), 0);
  assert.equal(adjacencyFadeFactor(WIRE_FADE_HIDE_PX), 0);
  assert.equal(adjacencyFadeFactor(NaN), 0);
});

test('the band ramps linearly to full ink', () => {
  const mid = (WIRE_FADE_HIDE_PX + WIRE_FADE_FULL_PX) / 2;
  assert.equal(adjacencyFadeFactor(mid), 0.5);
  assert.equal(adjacencyFadeFactor(WIRE_FADE_FULL_PX), 1);
  assert.equal(adjacencyFadeFactor(1000), 1);
});
