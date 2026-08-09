import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGroupHealth } from '../../src/hooks/useGroupHealth.js';

// ---------------------------------------------------------------------------
// Group aggregate LED (owner-reported grey-LED bug, 2026-08-01): worst-of-
// subtree over an ALL-pieces health map. The old pipeline fed the aggregator
// visible-pieces health — from which collapse had removed the members — so
// every pill read 'empty'. These tests pin the pure aggregation; the input
// fix (all pieces, not visible) lives in useWorkspaceRenderSelectors.
// ---------------------------------------------------------------------------

const groups = [
  { id: 'parent', parentId: null, isCollapsed: true, pieceIds: [1] },
  { id: 'child', parentId: 'parent', isCollapsed: false, pieceIds: [2, 3] },
  { id: 'grand', parentId: 'child', isCollapsed: false, pieceIds: [4] },
  { id: 'unrelated', parentId: null, isCollapsed: false, pieceIds: [9] },
];

test('a collapsed group with a red member reports red — never grey', () => {
  const health = new Map([[1, 'red']]);
  assert.equal(computeGroupHealth(groups, health).get('parent'), 'red');
});

test('problems in a nested child folder propagate to every ancestor', () => {
  const health = new Map([[4, 'amber']]);
  const map = computeGroupHealth(groups, health);
  assert.equal(map.get('grand'), 'amber');
  assert.equal(map.get('child'), 'amber', 'one level up');
  assert.equal(map.get('parent'), 'amber', 'two levels up');
  assert.equal(map.get('unrelated'), 'empty', 'siblings unaffected');
});

test('aggregate order: problems outrank activity (amber beats blue)', () => {
  const health = new Map([[2, 'blue'], [3, 'amber']]);
  assert.equal(computeGroupHealth(groups, health).get('child'), 'amber');
});

test('aggregate order: red > amber, blue > green', () => {
  assert.equal(
    computeGroupHealth(groups, new Map([[2, 'amber'], [3, 'red']])).get('child'),
    'red'
  );
  assert.equal(
    computeGroupHealth(groups, new Map([[2, 'green'], [3, 'blue']])).get('child'),
    'blue'
  );
});

test('expanded groups get entries too', () => {
  const health = new Map([[9, 'red']]);
  assert.equal(computeGroupHealth(groups, health).get('unrelated'), 'red');
});

test('a group with no known member health reports empty', () => {
  assert.equal(computeGroupHealth(groups, new Map()).get('unrelated'), 'empty');
});

test('parentId cycles terminate', () => {
  const cyclic = [
    { id: 'a', parentId: 'b', pieceIds: [1] },
    { id: 'b', parentId: 'a', pieceIds: [2] },
  ];
  const map = computeGroupHealth(cyclic, new Map([[2, 'red']]));
  assert.equal(map.get('a'), 'red');
  assert.equal(map.get('b'), 'red');
});
