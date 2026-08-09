import test from 'node:test';
import assert from 'node:assert/strict';

import { createGroupDomain } from '../../src/app/groupDomain.js';

function createStateSetter(getter, setter) {
  return (updater) => {
    const current = getter();
    const next = typeof updater === 'function' ? updater(current) : updater;
    setter(next);
  };
}

test('GroupDomain toggleCollapse toggles only target group', () => {
  let groups = [
    { id: 'g1', isCollapsed: false },
    { id: 'g2', isCollapsed: true }
  ];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => {
      groups = next;
    })
  });

  domain.commands.toggleCollapse('g1');
  assert.deepEqual(groups, [
    { id: 'g1', isCollapsed: true },
    { id: 'g2', isCollapsed: true }
  ]);
});

test('GroupDomain createFolderGroup rehomes pieces and appends new group', () => {
  let groups = [
    { id: 'g0', pieceIds: [1, 2], isCollapsed: false },
    { id: 'g9', pieceIds: [9], isCollapsed: false }
  ];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => {
      groups = next;
    })
  });

  domain.commands.createFolderGroup({
    groupId: 'group-2',
    name: 'Group 2',
    pieceIds: [2, 3],
    folderPath: 'Group-2'
  });

  assert.deepEqual(groups, [
    { id: 'g0', pieceIds: [1], isCollapsed: false },
    { id: 'g9', pieceIds: [9], isCollapsed: false },
    { id: 'group-2', name: 'Group 2', pieceIds: [2, 3], isCollapsed: false, folderPath: 'Group-2', themeId: null, color: null, seedBounds: null, gridTier: 0 }
  ]);
});

test('GroupDomain createFolderGroup applies a default color when provided', () => {
  let groups = [];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => { groups = next; })
  });

  domain.commands.createFolderGroup({
    groupId: 'g1', name: 'src', pieceIds: [1], folderPath: 'src', color: '#26a69a'
  });

  assert.equal(groups[0].color, '#26a69a');
});

test('GroupDomain removePieces keeps emptied FOLDER groups (D1 — the folder outlives its pieces)', () => {
  let groups = [
    { id: 'g1', pieceIds: [1, 2], folderPath: 'g1' },
    { id: 'g2', pieceIds: [3], folderPath: 'g2' }
  ];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => {
      groups = next;
    })
  });

  domain.commands.removePieces([2, 3]);
  assert.deepEqual(groups, [
    { id: 'g1', pieceIds: [1], folderPath: 'g1' },
    { id: 'g2', pieceIds: [], folderPath: 'g2' }
  ]);
});

test('GroupDomain removePieces keeps an emptied MANUAL group (folderPath null)', () => {
  // ADR-018 box-first: manual groups exist by user intent and die only by
  // explicit deleteGroup — mirrors the reconciler's folder-less skip rule.
  let groups = [
    { id: 'manual-1', pieceIds: [3], folderPath: null },
    { id: 'g1', pieceIds: [1], folderPath: 'g1' }
  ];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => {
      groups = next;
    })
  });

  domain.commands.removePieces([3]);
  assert.deepEqual(groups, [
    { id: 'manual-1', pieceIds: [], folderPath: null },
    { id: 'g1', pieceIds: [1], folderPath: 'g1' }
  ]);
});

test('GroupDomain removePieceFromGroup keeps an emptied manual group', () => {
  let groups = [{ id: 'manual-1', pieceIds: [7], folderPath: null }];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => { groups = next; })
  });

  domain.commands.removePieceFromGroup('manual-1', 7);
  assert.deepEqual(groups, [{ id: 'manual-1', pieceIds: [], folderPath: null }]);
});

// createManualGroup retired (W3, brief-group-physicality) — nothing is born
// folder-less; disk-first creation + open-time rectification replaced it.

test('GroupDomain createFolderGroup strip pass keeps manual groups it empties', () => {
  let groups = [{ id: 'manual-1', pieceIds: [2], folderPath: null }];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => { groups = next; })
  });

  domain.commands.createFolderGroup({
    groupId: 'group-2',
    name: 'Group 2',
    pieceIds: [2],
    folderPath: 'Group-2'
  });

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { id: 'manual-1', pieceIds: [], folderPath: null });
});

test('GroupDomain translateGroupSeed shifts a seed-positioned group by the drag delta', () => {
  let groups = [
    { id: 'g1', name: 'newfolder', folderPath: 'newfolder', pieceIds: [], seedBounds: { x: 100, y: 200, width: 160, height: 80 } },
    { id: 'g2', name: 'src', folderPath: 'src', pieceIds: [1], seedBounds: null }
  ];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => { groups = next; })
  });

  domain.commands.translateGroupSeed({ groupId: 'g1', dx: 40, dy: -25 });
  assert.deepEqual(groups[0].seedBounds, { x: 140, y: 175, width: 160, height: 80 });

  // No seed → no-op; zero delta → no-op; content stays untouched.
  domain.commands.translateGroupSeed({ groupId: 'g2', dx: 10, dy: 10 });
  domain.commands.translateGroupSeed({ groupId: 'g1', dx: 0, dy: 0 });
  assert.deepEqual(groups[0].seedBounds, { x: 140, y: 175, width: 160, height: 80 });
  assert.equal(groups[1].seedBounds, null);
});

test('GroupDomain replaceAll swaps to provided groups collection', () => {
  let groups = [{ id: 'g1', pieceIds: [1] }];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => {
      groups = next;
    })
  });

  domain.commands.replaceAll([{ id: 'g9', pieceIds: [9] }]);
  assert.deepEqual(groups, [{ id: 'g9', pieceIds: [9] }]);
});

test('GroupDomain deleteGroup removes only the target group', () => {
  let groups = [
    { id: 'g1', pieceIds: [1, 2] },
    { id: 'g2', pieceIds: [3] }
  ];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => {
      groups = next;
    })
  });

  domain.commands.deleteGroup('g2');
  assert.deepEqual(groups, [{ id: 'g1', pieceIds: [1, 2] }]);
});

test('GroupDomain expand sets target group collapsed=false', () => {
  let groups = [
    { id: 'g1', isCollapsed: true },
    { id: 'g2', isCollapsed: true }
  ];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => {
      groups = next;
    })
  });

  domain.commands.expand('g2');
  assert.deepEqual(groups, [
    { id: 'g1', isCollapsed: true },
    { id: 'g2', isCollapsed: false }
  ]);
});

test('GroupDomain rename trims and applies valid names', () => {
  let groups = [{ id: 'g1', name: 'Old' }];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => {
      groups = next;
    })
  });

  domain.commands.rename('g1', '  New Name  ');
  assert.deepEqual(groups, [{ id: 'g1', name: 'New Name' }]);
});

test('GroupDomain rename supports folderPath patch payload', () => {
  let groups = [{ id: 'g1', name: 'Old', folderPath: 'Group-1' }];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => {
      groups = next;
    })
  });

  domain.commands.rename('g1', { name: 'Renamed', folderPath: 'Renamed' });
  assert.deepEqual(groups, [{ id: 'g1', name: 'Renamed', folderPath: 'Renamed' }]);
});

test('GroupDomain selector returns matching group', () => {
  const groups = [{ id: 'g1' }, { id: 'g2' }];
  const domain = createGroupDomain({ setGroups: () => {} });

  assert.deepEqual(domain.selectors.getGroupById(groups, 'g2'), { id: 'g2' });
  assert.equal(domain.selectors.getGroupById(groups, 'missing'), null);
});

test('GroupDomain setTheme assigns and clears theme id for target group', () => {
  let groups = [
    { id: 'g1', name: 'Group 1', themeId: null },
    { id: 'g2', name: 'Group 2', themeId: null }
  ];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => {
      groups = next;
    })
  });

  domain.commands.setTheme('g1', 'ocean');
  assert.equal(groups[0].themeId, 'ocean');
  assert.equal(groups[1].themeId, null);

  domain.commands.setTheme('g1', null);
  assert.equal(groups[0].themeId, null);
});

test('GroupDomain history-backed commands support undo/redo roundtrip', () => {
  let groups = [{ id: 'g1', name: 'Old', isCollapsed: false, pieceIds: [1, 2] }];
  const executed = [];
  const history = {
    beginGroup() {},
    execute(action) {
      executed.push(action);
      action.do();
    },
    endGroup() {}
  };
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => {
      groups = next;
    }),
    history,
    getGroups: () => groups
  });

  domain.commands.rename('g1', 'New');
  assert.equal(groups[0].name, 'New');
  executed[0].undo();
  assert.equal(groups[0].name, 'Old');
  executed[0].do();
  assert.equal(groups[0].name, 'New');

  domain.commands.toggleCollapse('g1');
  assert.equal(groups[0].isCollapsed, true);
  executed[1].undo();
  assert.equal(groups[0].isCollapsed, false);
  executed[1].do();
  assert.equal(groups[0].isCollapsed, true);
});

// ---------------------------------------------------------------------------
// promoteToFolderGroup (plan-only staircase step 1: manual group → folder)
// ---------------------------------------------------------------------------

test('GroupDomain promoteToFolderGroup sets folderPath, drops seedBounds, claims members', () => {
  let groups = [
    { id: 'manual-1', pieceIds: [1, 2], folderPath: null, seedBounds: { x: 0, y: 0, width: 340, height: 230 } },
    { id: 'g-src', pieceIds: [2, 3], folderPath: 'src' }
  ];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => { groups = next; })
  });

  domain.commands.promoteToFolderGroup({ groupId: 'manual-1', folderPath: 'My-Group' });

  const promoted = groups.find((g) => g.id === 'manual-1');
  assert.equal(promoted.folderPath, 'My-Group');
  assert.equal(promoted.seedBounds, null);
  assert.deepEqual(promoted.pieceIds, [1, 2]);
  // Piece 2's file is moving into the new folder — the old folder group loses it.
  assert.deepEqual(groups.find((g) => g.id === 'g-src').pieceIds, [3]);
});

test('GroupDomain promoteToFolderGroup promotes empty groups (W4) but refuses already-folder groups', () => {
  const seed = { x: 0, y: 0, width: 340, height: 230 };
  const initial = [
    { id: 'manual-empty', pieceIds: [], folderPath: null, seedBounds: seed },
    { id: 'g-src', pieceIds: [1], folderPath: 'src' }
  ];
  let groups = initial;
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => { groups = next; })
  });

  // Blank folder path: no-op.
  domain.commands.promoteToFolderGroup({ groupId: 'manual-empty', folderPath: '   ' });
  assert.deepEqual(groups, initial);

  // Folder-backed group: promotion is a manual-group-only transition.
  domain.commands.promoteToFolderGroup({ groupId: 'g-src', folderPath: 'Other' });
  assert.deepEqual(groups, initial);

  // Empty manual group promotes since W4 (D1 killed the reconciler GC that
  // motivated the old ≥1-member gate); its seed survives as the geometry.
  domain.commands.promoteToFolderGroup({ groupId: 'manual-empty', folderPath: 'Empty' });
  const promoted = groups.find((g) => g.id === 'manual-empty');
  assert.equal(promoted.folderPath, 'Empty');
  assert.deepEqual(promoted.seedBounds, seed);
});

test('GroupDomain promoteToFolderGroup claims members; emptied folder groups survive (D1)', () => {
  let groups = [
    { id: 'manual-1', pieceIds: [1], folderPath: null, seedBounds: null },
    { id: 'g-old', pieceIds: [1], folderPath: 'old' }
  ];
  const domain = createGroupDomain({
    setGroups: createStateSetter(() => groups, (next) => { groups = next; })
  });

  domain.commands.promoteToFolderGroup({ groupId: 'manual-1', folderPath: 'New' });

  const promoted = groups.find((g) => g.id === 'manual-1');
  assert.equal(promoted.folderPath, 'New');
  const donor = groups.find((g) => g.id === 'g-old');
  assert.ok(donor, 'emptied donor folder group survives — its folder still exists');
  assert.deepEqual(donor.pieceIds, []);
});

test('GroupDomain allocateGroupId mints sequential ids and advances the counter', () => {
  let nextGroupId = 7;
  const domain = createGroupDomain({
    setGroups: () => {},
    getNextGroupId: () => nextGroupId,
    setNextGroupId: (updater) => {
      nextGroupId = typeof updater === 'function' ? updater(nextGroupId) : updater;
    }
  });

  assert.deepEqual(domain.commands.allocateGroupId(), { groupId: 'group-7', groupIndex: 7 });
  assert.deepEqual(domain.commands.allocateGroupId(), { groupId: 'group-8', groupIndex: 8 });
  assert.equal(nextGroupId, 9);
});

test('GroupDomain applyFsSyncPlan applies folderPaths, removals, additions, and upserts in one update', () => {
  let groups = [
    { id: 'g1', name: 'src', pieceIds: [1, 2], folderPath: 'src' },
    { id: 'g2', name: 'lib', pieceIds: [3], folderPath: 'lib' }
  ];
  let updateCount = 0;
  const domain = createGroupDomain({
    setGroups: (updater) => {
      updateCount += 1;
      groups = typeof updater === 'function' ? updater(groups) : updater;
    }
  });

  domain.commands.applyFsSyncPlan({
    folderPathUpdates: [{ groupId: 'g2', folderPath: 'moved/lib' }],
    removals: [{ groupId: 'g1', pieceId: 2 }],
    additions: [{ groupId: 'g2', pieceId: 2 }],
    upserts: [{ groupId: 'g3', name: 'newdir', folderPath: 'newdir', pieceIds: [4] }]
  });

  assert.equal(updateCount, 1, 'whole plan lands in ONE state update');
  assert.deepEqual(groups.find((g) => g.id === 'g1').pieceIds, [1]);
  const g2 = groups.find((g) => g.id === 'g2');
  assert.equal(g2.folderPath, 'moved/lib');
  assert.deepEqual(g2.pieceIds, [3, 2]);
  const g3 = groups.find((g) => g.id === 'g3');
  assert.deepEqual(
    g3,
    { id: 'g3', name: 'newdir', pieceIds: [4], isCollapsed: false, folderPath: 'newdir', parentId: null, themeId: null, color: null, seedBounds: null, gridTier: 0 }
  );
});

test('GroupDomain applyFsSyncPlan upsert unions pieceIds when the group already exists', () => {
  let groups = [
    { id: 'g3', name: 'newdir', pieceIds: [4], folderPath: 'newdir' }
  ];
  const domain = createGroupDomain({
    setGroups: (updater) => { groups = typeof updater === 'function' ? updater(groups) : updater; }
  });

  domain.commands.applyFsSyncPlan({
    upserts: [{ groupId: 'g3', name: 'newdir', folderPath: 'newdir', pieceIds: [4, 5] }]
  });

  assert.equal(groups.length, 1, 'no duplicate group minted');
  assert.deepEqual(groups[0].pieceIds, [4, 5]);
});

test('GroupDomain applyFsSyncPlan keeps groups emptied by removals — folder AND manual (D1)', () => {
  let groups = [
    { id: 'g1', name: 'src', pieceIds: [1], folderPath: 'src' },
    { id: 'm1', name: 'box', pieceIds: [2], folderPath: null }
  ];
  const domain = createGroupDomain({
    setGroups: (updater) => { groups = typeof updater === 'function' ? updater(groups) : updater; }
  });

  domain.commands.applyFsSyncPlan({
    removals: [
      { groupId: 'g1', pieceId: 1 },
      { groupId: 'm1', pieceId: 2 }
    ]
  });

  assert.deepEqual(groups.find((g) => g.id === 'g1').pieceIds, [], 'emptied folder group survives (D1)');
  assert.deepEqual(groups.find((g) => g.id === 'm1').pieceIds, [], 'manual group survives empty');
});

test('GroupDomain applyFsSyncPlan no-ops on an empty plan', () => {
  let updateCount = 0;
  const domain = createGroupDomain({
    setGroups: () => { updateCount += 1; }
  });

  domain.commands.applyFsSyncPlan({});
  domain.commands.applyFsSyncPlan();

  assert.equal(updateCount, 0);
});

test('GroupDomain applyFsSyncPlan parentUpdates set and clear parent links in the same update', () => {
  let groups = [
    { id: 'g1', name: 'main', pieceIds: [1], folderPath: 'main', parentId: null },
    { id: 'g2', name: 'sub', pieceIds: [2], folderPath: 'main/sub', parentId: null },
    { id: 'g3', name: 'loose', pieceIds: [3], folderPath: 'loose', parentId: 'g1' }
  ];
  let updateCount = 0;
  const domain = createGroupDomain({
    setGroups: (updater) => {
      updateCount += 1;
      groups = typeof updater === 'function' ? updater(groups) : updater;
    }
  });

  domain.commands.applyFsSyncPlan({
    parentUpdates: [
      { groupId: 'g2', parentId: 'g1' },
      { groupId: 'g3', parentId: null }
    ]
  }, { withHistory: false });

  assert.equal(updateCount, 1);
  assert.equal(groups.find((g) => g.id === 'g2').parentId, 'g1');
  assert.equal(groups.find((g) => g.id === 'g3').parentId, null);
});

test('GroupDomain applyFsSyncPlan groupDeletes remove groups and unlink their children', () => {
  let groups = [
    { id: 'g-dead', name: 'dead', pieceIds: [], folderPath: 'dead' },
    { id: 'g-child', name: 'child', pieceIds: [2], folderPath: 'child', parentId: 'g-dead' }
  ];
  const domain = createGroupDomain({
    setGroups: (updater) => { groups = typeof updater === 'function' ? updater(groups) : updater; }
  });

  domain.commands.applyFsSyncPlan({ groupDeletes: ['g-dead'] });

  assert.equal(groups.find((g) => g.id === 'g-dead'), undefined);
  assert.equal(groups.find((g) => g.id === 'g-child').parentId, null,
    'children of a deleted parent become top-level (mirrors FK ON DELETE SET NULL)');
});

test('GroupDomain applyFsSyncPlan upsert creation carries the provided parentId', () => {
  let groups = [
    { id: 'g1', name: 'main', pieceIds: [1], folderPath: 'main', parentId: null }
  ];
  const domain = createGroupDomain({
    setGroups: (updater) => { groups = typeof updater === 'function' ? updater(groups) : updater; }
  });

  domain.commands.applyFsSyncPlan({
    upserts: [{ groupId: 'g-new', name: 'sub', folderPath: 'main/sub', pieceIds: [2], parentId: 'g1' }]
  });

  assert.equal(groups.find((g) => g.id === 'g-new').parentId, 'g1');
});
