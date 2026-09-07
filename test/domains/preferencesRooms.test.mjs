import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREFERENCE_REGISTRY,
  PREFERENCE_ROOMS,
  PREFERENCE_ROOM_IDS,
  entriesForPlace,
  entriesByRoom
} from '../../src/preferences/registry.js';

// Preferences panel v2, slice 1 (brief-preferences-panel-v2.md §3): every
// registry entry lives in a room, and the panel renders rooms from the
// registry — never a hand-placed list. The settings-key guard enforces the
// same shape at build time; this is the executable contract.

test('rooms are declared in display order with a label and a description', () => {
  assert.deepEqual(PREFERENCE_ROOM_IDS, ['appearance', 'projectCreation', 'behavior']);
  for (const room of PREFERENCE_ROOMS) {
    assert.ok(room.label?.length > 0, `${room.id}: label required`);
    assert.ok(room.description?.length > 0, `${room.id}: one-line description required (rooms explain themselves)`);
  }
  assert.equal(new Set(PREFERENCE_ROOM_IDS).size, PREFERENCE_ROOM_IDS.length, 'room ids are unique');
});

test('every registry entry declares a room that exists', () => {
  for (const entry of PREFERENCE_REGISTRY) {
    assert.ok(PREFERENCE_ROOM_IDS.includes(entry.room), `${entry.key}: room '${entry.room}' is not a PREFERENCE_ROOMS id`);
  }
});

test('the rooms hold what the brief says they hold', () => {
  const byKey = Object.fromEntries(PREFERENCE_REGISTRY.map((e) => [e.key, e.room]));
  assert.equal(byKey.appearance, 'appearance');
  assert.equal(byKey.energyLevel, 'appearance');
  assert.equal(byKey.defaultProjectLocation, 'projectCreation');
  assert.equal(byKey.defaultBaseTheme, 'projectCreation');
  assert.equal(byKey.buildTracePause, 'projectCreation');
  assert.equal(byKey.buildLogAutoSend, 'projectCreation');
  assert.equal(byKey.wireDropOnCollapsedGroup, 'behavior');
  assert.equal(byKey.terminalDrawerClose, 'behavior');
  assert.equal(byKey.splashScreen, 'behavior');
});

test('entriesByRoom groups the place query by room, in room order then registry order', () => {
  const rooms = entriesByRoom('preferences.global');
  assert.deepEqual(rooms.map((r) => r.id), ['appearance', 'projectCreation', 'behavior']);
  const flattened = rooms.flatMap((r) => r.entries.map((e) => e.key));
  const viaPlace = entriesForPlace('preferences.global').map((e) => e.key);
  assert.deepEqual([...flattened].sort(), [...viaPlace].sort(), 'no entry is lost or duplicated');
  for (const room of rooms) {
    const registryOrder = PREFERENCE_REGISTRY.filter((e) => e.room === room.id && e.place.includes('preferences.global')).map((e) => e.key);
    assert.deepEqual(room.entries.map((e) => e.key), registryOrder, `${room.id}: entries keep registry order`);
    assert.ok(room.label && room.description, `${room.id}: carries its heading`);
  }
});

test('entriesByRoom omits rooms with nothing to show for the place', () => {
  // Project scope today: only Appearance (energy) and Behavior (wire drop)
  // hold an overridable entry; Project creation has none.
  const projectRooms = entriesByRoom('preferences.project');
  assert.deepEqual(projectRooms.map((r) => r.id), ['appearance', 'behavior']);
  assert.ok(projectRooms.every((r) => r.entries.length > 0));
  assert.deepEqual(entriesByRoom('no.such.place'), []);
});

test('entriesByRoom honors the when(state) predicate and custom rooms', () => {
  const rooms = [{ id: 'a', label: 'A', description: 'a' }, { id: 'b', label: 'B', description: 'b' }];
  const synthetic = [
    { key: 'x', room: 'a', place: ['spot'] },
    { key: 'y', room: 'b', place: ['spot'], when: (st) => st.open === true },
    { key: 'z', room: 'b', place: ['elsewhere'] }
  ];
  assert.deepEqual(entriesByRoom('spot', {}, synthetic, rooms).map((r) => [r.id, r.entries.map((e) => e.key)]), [['a', ['x']]]);
  assert.deepEqual(
    entriesByRoom('spot', { open: true }, synthetic, rooms).map((r) => [r.id, r.entries.map((e) => e.key)]),
    [['a', ['x']], ['b', ['y']]]
  );
});
