import { createConnectionAction, deleteConnectionAction, updateConnectionAction } from '../history/actions.js';
import { executeInteractionHistoryAction } from './interactionHelpers.js';

export function createConnectionDomain({ connections, history }) {
  const getConnectionById = (connectionId) => {
    if (!connectionId) return null;
    const all = connections.getAllConnections();
    return all.find((connection) => connection.id === connectionId) ?? null;
  };

  return {
    commands: {
      createConnection(input) {
        return connections.createConnection(input);
      },
      insertConnection(connection) {
        connections.insertConnection(connection);
      },
      createConnectionAndInsert(input) {
        const connection = connections.createConnection(input);
        if (!connection) return null;
        connections.insertConnection(connection);
        return connection;
      },
      removeConnectionById(connectionId) {
        connections.removeConnection(connectionId);
      },
      deleteConnectionByIdWithHistory(connectionId) {
        const connection = getConnectionById(connectionId);
        if (!connection) return false;
        executeInteractionHistoryAction(history, {
          label: 'Delete connection',
          action: deleteConnectionAction({
            connection,
            insertConnection: connections.insertConnection,
            removeConnection: connections.removeConnection
          })
        });
        return true;
      },
      updateConnectionByIdWithHistory(connectionId, patch) {
        const connection = getConnectionById(connectionId);
        if (!connection) return false;
        const next = { ...connection, ...(patch ?? {}), id: connection.id };
        executeInteractionHistoryAction(history, {
          label: 'Update connection',
          action: updateConnectionAction({
            beforeConnection: connection,
            afterConnection: next,
            insertConnection: connections.insertConnection,
            removeConnection: connections.removeConnection
          })
        });
        return true;
      },
      removeConnectionsForPiece(pieceId) {
        connections.removeConnectionsForPiece(pieceId);
      },
      removeConnectionsForPieces(pieceIds) {
        if (!Array.isArray(pieceIds) || pieceIds.length === 0) return;
        pieceIds.forEach((pieceId) => {
          connections.removeConnectionsForPiece(pieceId);
        });
      },
      createConnectionFromDrag(result) {
        if (!result) return null;
        const connection = connections.createConnection({
          sourceId: result.sourceId,
          sourceSide: result.sourceSide,
          targetId: result.targetId,
          targetSide: result.targetSide,
          type: 'reference'
        });
        if (!connection) return null;

        executeInteractionHistoryAction(history, {
          label: 'Create connection',
          action: createConnectionAction({
            connection,
            insertConnection: connections.insertConnection,
            removeConnection: connections.removeConnection
          })
        });
        return connection;
      }
    },
    selectors: {
      getAllConnections() {
        return connections.getAllConnections();
      },
      getConnectionById(connectionId) {
        return getConnectionById(connectionId);
      },
      getTabsForPiece(pieceId) {
        return connections.getTabsForPiece(pieceId);
      },
      getSlotsForPiece(pieceId) {
        return connections.getSlotsForPiece(pieceId);
      }
    }
  };
}
