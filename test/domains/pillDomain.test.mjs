import test from 'node:test';
import assert from 'node:assert/strict';

import { createPillDomain } from '../../src/terminal/pillDomain.js';

test('PillDomain addPill creates a pill with unique id', () => {
  const domain = createPillDomain();
  const id = domain.commands.addPill({
    projectId: 'p1',
    message: 'Process completed',
    severity: 'success',
    exitCode: 0
  });

  assert.equal(typeof id, 'number');
  const pills = domain.selectors.getPills();
  assert.equal(pills.length, 1);
  assert.equal(pills[0].id, id);
  assert.equal(pills[0].projectId, 'p1');
  assert.equal(pills[0].message, 'Process completed');
  assert.equal(pills[0].severity, 'success');
  assert.equal(pills[0].exitCode, 0);
  assert.equal(typeof pills[0].timestamp, 'number');
});

test('PillDomain dismissPill removes by id', () => {
  const domain = createPillDomain();
  const id1 = domain.commands.addPill({ projectId: 'p1', message: 'a' });
  const id2 = domain.commands.addPill({ projectId: 'p1', message: 'b' });

  domain.commands.dismissPill(id1);
  const pills = domain.selectors.getPills();
  assert.equal(pills.length, 1);
  assert.equal(pills[0].id, id2);
});

test('PillDomain clearForProject removes all pills for a project', () => {
  const domain = createPillDomain();
  domain.commands.addPill({ projectId: 'p1', message: 'a' });
  domain.commands.addPill({ projectId: 'p2', message: 'b' });
  domain.commands.addPill({ projectId: 'p1', message: 'c' });

  domain.commands.clearForProject('p1');
  const pills = domain.selectors.getPills();
  assert.equal(pills.length, 1);
  assert.equal(pills[0].projectId, 'p2');
});

test('PillDomain subscribe notifies on state changes', () => {
  const domain = createPillDomain();
  const snapshots = [];
  const unsub = domain.subscribe((pills) => snapshots.push(pills));

  domain.commands.addPill({ projectId: 'p1', message: 'x' });
  domain.commands.addPill({ projectId: 'p1', message: 'y' });
  domain.commands.dismissPill(1);

  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[0].length, 1);
  assert.equal(snapshots[1].length, 2);
  assert.equal(snapshots[2].length, 1);

  unsub();
  domain.commands.addPill({ projectId: 'p1', message: 'z' });
  assert.equal(snapshots.length, 3, 'should not notify after unsubscribe');
});

test('PillDomain defaults severity to info', () => {
  const domain = createPillDomain();
  domain.commands.addPill({ projectId: 'p1', message: 'test' });
  assert.equal(domain.selectors.getPills()[0].severity, 'info');
});
