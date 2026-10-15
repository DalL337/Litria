import test from 'node:test';
import assert from 'node:assert/strict';

import { createTerminalEndGate } from '../../src/app/terminalEndGate.js';
import { createPillDomain } from '../../src/terminal/pillDomain.js';

// Closing a project ends its terminals (owner ruling, 2026-10-14). Busy ones
// get an inline pill first, never a modal; idle shells end without asking.
// These drive the REAL pill domain.

const request = (busyCount) => ({ projectId: 'p1', busyCount, action: 'Switch', subject: 'Switching' });

test('no busy session: go ahead, no pill', async () => {
  const pills = createPillDomain();
  const gate = createTerminalEndGate({ pillDomain: pills });
  assert.equal(await gate.confirm(request(0)), true);
  assert.equal(pills.selectors.getPills().length, 0);
});

test('busy sessions raise one pill; its button goes ahead and clears it', async () => {
  const pills = createPillDomain();
  const gate = createTerminalEndGate({ pillDomain: pills });
  const answer = gate.confirm(request(2));
  const [pill] = pills.selectors.getPills();
  assert.equal(pill.severity, 'warning');
  assert.equal(pill.message, '2 terminals are still running commands. Switching ends them.');
  assert.equal(pill.secondary.label, 'Switch');
  pill.secondary.run();
  assert.equal(await answer, true);
  assert.equal(pills.selectors.getPills().length, 0);
});

test('dismissing the pill means stay', async () => {
  const pills = createPillDomain();
  const gate = createTerminalEndGate({ pillDomain: pills });
  const answer = gate.confirm(request(1));
  const [pill] = pills.selectors.getPills();
  assert.equal(pill.message, 'A terminal is still running a command. Switching ends it.');
  pills.commands.dismissPill(pill.id);
  assert.equal(await answer, false);
});

test('a newer request cancels the one waiting, so a forgotten pill never holds a switch', async () => {
  const pills = createPillDomain();
  const gate = createTerminalEndGate({ pillDomain: pills });
  const first = gate.confirm(request(1));
  const second = gate.confirm(request(1));
  assert.equal(await first, false);
  assert.equal(pills.selectors.getPills().length, 1, 'only the newest pill shows');
  pills.selectors.getPills()[0].secondary.run();
  assert.equal(await second, true);
});

test('other pills coming and going do not answer the gate', async () => {
  const pills = createPillDomain();
  const gate = createTerminalEndGate({ pillDomain: pills });
  const answer = gate.confirm(request(1));
  const other = pills.commands.addPill({ projectId: 'p1', message: 'unrelated' });
  pills.commands.dismissPill(other);
  const gatePill = pills.selectors.getPills().find((p) => p.secondary);
  gatePill.secondary.run();
  assert.equal(await answer, true);
});
