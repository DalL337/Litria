import test from 'node:test';
import assert from 'node:assert/strict';

import { createConnectionDomain } from '../../src/app/connectionDomain.js';

test('ConnectionDomain createConnectionFromDrag creates and executes history action', () => {
  const calls = [];
  const connection = {
    id: 'conn_1',
    sourceId: 1,
    sourceSide: 'right',
    targetId: 2,
    targetSide: 'left',
    type: 'reference'
  };

  const connections = {
    createConnection(input) {
      calls.push(['createConnection', input]);
      return connection;
    },
    insertConnection(next) {
      calls.push(['insertConnection', next.id]);
    },
    removeConnection(id) {
      calls.push(['removeConnection', id]);
    },
    getAllConnections() {
      return [connection];
    },
    getTabsForPiece() {
      return ['right'];
    },
    getSlotsForPiece() {
      return ['left'];
    }
  };

  const history = {
    beginGroup(label) {
      calls.push(['beginGroup', label]);
    },
    execute(action) {
      calls.push(['execute', action.label]);
      action.do();
    },
    endGroup() {
      calls.push(['endGroup']);
    }
  };

  const domain = createConnectionDomain({ connections, history });
  const created = domain.commands.createConnectionFromDrag({
    sourceId: 1,
    sourceSide: 'right',
    targetId: 2,
    targetSide: 'left'
  });

  assert.equal(created.id, 'conn_1');
  assert.deepEqual(calls, [
    ['createConnection', { sourceId: 1, sourceSide: 'right', targetId: 2, targetSide: 'left', type: 'reference' }],
    ['beginGroup', 'Create connection'],
    ['execute', 'Create connection'],
    ['insertConnection', 'conn_1'],
    ['endGroup']
  ]);
});

test('ConnectionDomain selectors proxy connection queries', () => {
  const calls = [];
  let store = [{ id: 'conn_1', sourceId: 1, targetId: 2 }];
  const connections = {
    getAllConnections() {
      return store;
    },
    getTabsForPiece() {
      return ['top'];
    },
    getSlotsForPiece() {
      return ['bottom'];
    },
    createConnection(input) {
      calls.push(['createConnection', input]);
      return input?.targetId === 8
        ? { id: 'conn_8', ...input }
        : null;
    },
    insertConnection(connection) {
      store = [...store.filter((entry) => entry.id !== connection.id), connection];
      calls.push(['insertConnection', connection?.id ?? null]);
    },
    removeConnection(connectionId) {
      store = store.filter((entry) => entry.id !== connectionId);
      calls.push(['removeConnection', connectionId]);
    },
    removeConnectionsForPiece(pieceId) {
      calls.push(['removeConnectionsForPiece', pieceId]);
    },
    getConnection() {
      return null;
    }
  };

  const domain = createConnectionDomain({
    connections,
    history: { beginGroup() {}, execute() {}, endGroup() {} }
  });

  assert.deepEqual(domain.selectors.getAllConnections(), [{ id: 'conn_1', sourceId: 1, targetId: 2 }]);
  assert.deepEqual(domain.selectors.getConnectionById('conn_1'), { id: 'conn_1', sourceId: 1, targetId: 2 });
  assert.equal(domain.selectors.getConnectionById('missing'), null);
  assert.deepEqual(domain.selectors.getTabsForPiece(1), ['top']);
  assert.deepEqual(domain.selectors.getSlotsForPiece(1), ['bottom']);

  domain.commands.createConnection({ sourceId: 1, targetId: 2 });
  domain.commands.createConnectionAndInsert({ sourceId: 7, targetId: 8, sourceSide: 'right', targetSide: 'left' });
  domain.commands.insertConnection({ id: 'conn_9' });
  domain.commands.removeConnectionById('conn_9');
  domain.commands.removeConnectionsForPiece(3);
  domain.commands.removeConnectionsForPieces([4, 5]);

  assert.deepEqual(calls, [
    ['createConnection', { sourceId: 1, targetId: 2 }],
    ['createConnection', { sourceId: 7, targetId: 8, sourceSide: 'right', targetSide: 'left' }],
    ['insertConnection', 'conn_8'],
    ['insertConnection', 'conn_9'],
    ['removeConnection', 'conn_9'],
    ['removeConnectionsForPiece', 3],
    ['removeConnectionsForPiece', 4],
    ['removeConnectionsForPiece', 5]
  ]);
});

test('ConnectionDomain deleteConnectionByIdWithHistory executes transactional delete', () => {
  const calls = [];
  let store = [{ id: 'conn_2', sourceId: 2, targetId: 3 }];
  const connections = {
    getAllConnections() {
      return store;
    },
    createConnection() {
      return null;
    },
    insertConnection(connection) {
      store = [...store, connection];
      calls.push(['insertConnection', connection.id]);
    },
    removeConnection(connectionId) {
      store = store.filter((entry) => entry.id !== connectionId);
      calls.push(['removeConnection', connectionId]);
    },
    removeConnectionsForPiece() {},
    getTabsForPiece() {
      return [];
    },
    getSlotsForPiece() {
      return [];
    }
  };
  const history = {
    beginGroup(label) {
      calls.push(['beginGroup', label]);
    },
    execute(action) {
      calls.push(['execute', action.label]);
      action.do();
    },
    endGroup() {
      calls.push(['endGroup']);
    }
  };

  const domain = createConnectionDomain({ connections, history });
  const deleted = domain.commands.deleteConnectionByIdWithHistory('conn_2');

  assert.equal(deleted, true);
  assert.deepEqual(calls, [
    ['beginGroup', 'Delete connection'],
    ['execute', 'Delete connection'],
    ['removeConnection', 'conn_2'],
    ['endGroup']
  ]);
});

test('ConnectionDomain updateConnectionByIdWithHistory executes transactional update', () => {
  const calls = [];
  let store = [{ id: 'conn_3', sourceId: 3, sourceSide: 'right', targetId: 4, targetSide: 'left' }];
  const connections = {
    getAllConnections() {
      return store;
    },
    createConnection() {
      return null;
    },
    insertConnection(connection) {
      store = [...store.filter((entry) => entry.id !== connection.id), connection];
      calls.push(['insertConnection', connection.id, connection.targetSide]);
    },
    removeConnection(connectionId) {
      store = store.filter((entry) => entry.id !== connectionId);
      calls.push(['removeConnection', connectionId]);
    },
    removeConnectionsForPiece() {},
    getTabsForPiece() {
      return [];
    },
    getSlotsForPiece() {
      return [];
    }
  };
  const history = {
    beginGroup(label) {
      calls.push(['beginGroup', label]);
    },
    execute(action) {
      calls.push(['execute', action.label]);
      action.do();
    },
    endGroup() {
      calls.push(['endGroup']);
    }
  };

  const domain = createConnectionDomain({ connections, history });
  const updated = domain.commands.updateConnectionByIdWithHistory('conn_3', { targetSide: 'bottom' });

  assert.equal(updated, true);
  assert.deepEqual(calls, [
    ['beginGroup', 'Update connection'],
    ['execute', 'Update connection'],
    ['removeConnection', 'conn_3'],
    ['insertConnection', 'conn_3', 'bottom'],
    ['endGroup']
  ]);
});

test('ConnectionDomain history actions support undo/redo for delete and update', () => {
  let store = [{ id: 'conn_4', sourceId: 4, sourceSide: 'right', targetId: 5, targetSide: 'left' }];
  const executed = [];
  const connections = {
    getAllConnections() {
      return store;
    },
    createConnection() {
      return null;
    },
    insertConnection(connection) {
      store = [...store.filter((entry) => entry.id !== connection.id), connection];
    },
    removeConnection(connectionId) {
      store = store.filter((entry) => entry.id !== connectionId);
    },
    removeConnectionsForPiece() {},
    getTabsForPiece() {
      return [];
    },
    getSlotsForPiece() {
      return [];
    }
  };
  const history = {
    beginGroup() {},
    execute(action) {
      executed.push(action);
      action.do();
    },
    endGroup() {}
  };
  const domain = createConnectionDomain({ connections, history });

  const deleted = domain.commands.deleteConnectionByIdWithHistory('conn_4');
  assert.equal(deleted, true);
  assert.equal(store.length, 0);
  executed[0].undo();
  assert.equal(store.length, 1);
  assert.equal(store[0].id, 'conn_4');
  executed[0].do();
  assert.equal(store.length, 0);

  store = [{ id: 'conn_4', sourceId: 4, sourceSide: 'right', targetId: 5, targetSide: 'left' }];
  const updated = domain.commands.updateConnectionByIdWithHistory('conn_4', { targetSide: 'bottom' });
  assert.equal(updated, true);
  assert.equal(store[0].targetSide, 'bottom');
  executed[1].undo();
  assert.equal(store[0].targetSide, 'left');
  executed[1].do();
  assert.equal(store[0].targetSide, 'bottom');
});
