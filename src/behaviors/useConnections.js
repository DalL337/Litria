// useConnections.js
// Tracks explicit code relationships between pieces
// Created via Shift + Right-click drag from one piece to another
//
// This is CODE WIRING — imports, calls, references
// Different from useAdjacency which is just physical proximity
//
// Rules:
// - One connection per direction (A→B allowed, B→A allowed, but not two A→B)
// - No self-connections

import { useState, useCallback, useRef } from 'react';

const connectionExistsInDirection = (connections, sourceId, targetId) => {
  return connections.some(conn =>
    conn.sourceId === sourceId && conn.targetId === targetId
  );
};

const buildConnection = ({ id, sourceId, sourceSide, targetId, targetSide, type = 'reference' }, connections) => {
  if (sourceId === targetId) return null;
  if (connectionExistsInDirection(connections, sourceId, targetId)) return null;

  return {
    id,
    sourceId,
    sourceSide,
    targetId,
    targetSide,
    type
  };
};

function useConnections() {
  // All established connections
  const [connections, setConnections] = useState([]);
  
  // Auto-incrementing ID for connections
  const nextConnectionIdRef = useRef(1);

  const getNextConnectionId = useCallback(() => {
    const id = `conn_${nextConnectionIdRef.current}`;
    nextConnectionIdRef.current += 1;
    return id;
  }, []);

  // ============================================
  // ACTIONS
  // ============================================

  const createConnection = useCallback(({
    sourceId,
    sourceSide,
    targetId,
    targetSide,
    type = 'reference',
    id
  }) => {
    const connectionId = id ?? getNextConnectionId();
    return buildConnection(
      { id: connectionId, sourceId, sourceSide, targetId, targetSide, type },
      connections
    );
  }, [connections, getNextConnectionId]);

  const insertConnection = useCallback((connection) => {
    if (!connection) return;
    setConnections(prev => {
      if (prev.some(conn => conn.id === connection.id)) return prev;
      return [...prev, connection];
    });
  }, []);

  // Remove a specific connection by ID
  const removeConnection = useCallback((connectionId) => {
    setConnections(prev => prev.filter(conn => conn.id !== connectionId));
  }, []);

  // Remove all connections involving a piece (for when piece is deleted)
  const removeConnectionsForPiece = useCallback((pieceId) => {
    setConnections(prev => prev.filter(conn =>
      conn.sourceId !== pieceId && conn.targetId !== pieceId
    ));
  }, []);

  // ============================================
  // QUERIES
  // ============================================

  // Get all connections originating FROM a piece
  const getConnectionsFrom = useCallback((pieceId) => {
    return connections.filter(conn => conn.sourceId === pieceId);
  }, [connections]);

  // Get all connections pointing TO a piece
  const getConnectionsTo = useCallback((pieceId) => {
    return connections.filter(conn => conn.targetId === pieceId);
  }, [connections]);

  // Get which sides of a piece have outgoing tabs
  const getTabsForPiece = useCallback((pieceId) => {
    const outgoing = connections.filter(conn => conn.sourceId === pieceId);
    const sides = [...new Set(outgoing.map(conn => conn.sourceSide))];
    return sides;
  }, [connections]);

  // Get which sides of a piece have incoming slots
  const getSlotsForPiece = useCallback((pieceId) => {
    const incoming = connections.filter(conn => conn.targetId === pieceId);
    const sides = [...new Set(incoming.map(conn => conn.targetSide))];
    return sides;
  }, [connections]);

  // Check if two pieces are connected (in either direction)
  const isConnected = useCallback((pieceIdA, pieceIdB) => {
    return connections.some(conn =>
      (conn.sourceId === pieceIdA && conn.targetId === pieceIdB) ||
      (conn.sourceId === pieceIdB && conn.targetId === pieceIdA)
    );
  }, [connections]);

  // Check if a connection exists in a specific direction
  const hasConnectionInDirection = useCallback((sourceId, targetId) => {
    return connections.some(conn =>
      conn.sourceId === sourceId && conn.targetId === targetId
    );
  }, [connections]);

  // Get a specific connection between two pieces (if exists)
  const getConnection = useCallback((sourceId, targetId) => {
    return connections.find(conn =>
      conn.sourceId === sourceId && conn.targetId === targetId
    ) || null;
  }, [connections]);

  // Get all connections (for rendering lines, debugging, etc.)
  const getAllConnections = useCallback(() => {
    return connections;
  }, [connections]);

  // Count total connections
  const countConnections = useCallback(() => {
    return connections.length;
  }, [connections]);

  // Bulk-load setter for persistence restore
  const bulkSetConnections = useCallback((conns) => {
    setConnections(Array.isArray(conns) ? conns : []);
  }, []);

  // ID counter accessors for persistence
  const getNextConnectionIdValue = useCallback(() => nextConnectionIdRef.current, []);
  const setNextConnectionIdValue = useCallback((value) => {
    if (Number.isFinite(value) && value >= 1) {
      nextConnectionIdRef.current = value;
    }
  }, []);

  return {
    // State
    connections,

    // Actions
    createConnection,
    insertConnection,
    removeConnection,
    removeConnectionsForPiece,

    // Bulk restore
    setConnections: bulkSetConnections,
    getNextConnectionIdValue,
    setNextConnectionIdValue,

    // Queries
    getConnectionsFrom,
    getConnectionsTo,
    getTabsForPiece,
    getSlotsForPiece,
    isConnected,
    hasConnectionInDirection,
    getConnection,
    getAllConnections,
    countConnections
  };
}

export default useConnections;

