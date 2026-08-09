// actions.js
// Reusable command factories for common piece actions.

const clonePiece = (piece) => ({
  ...piece,
  adjacentTo: piece?.adjacentTo ? { ...piece.adjacentTo } : piece?.adjacentTo,
  references: Array.isArray(piece?.references) ? [...piece.references] : piece?.references
});

const mapById = (pieces) => new Map(pieces.map(piece => [piece.id, piece]));

const getChangedPieces = (beforePieces, afterPieces) => {
  const beforeById = mapById(beforePieces);
  const afterById = mapById(afterPieces);
  const before = [];
  const after = [];

  for (const [id, afterPiece] of afterById) {
    const beforePiece = beforeById.get(id);
    if (!beforePiece) continue;
    if (JSON.stringify(beforePiece) !== JSON.stringify(afterPiece)) {
      before.push(clonePiece(beforePiece));
      after.push(clonePiece(afterPiece));
    }
  }

  return { before, after };
};

const applyPieceUpdates = (pieces, updates) => {
  if (!updates.length) return pieces;
  const updatesById = new Map(updates.map(piece => [piece.id, piece]));
  return pieces.map(piece => updatesById.get(piece.id) ?? piece);
};

const cloneGroups = (groups) => (
  Array.isArray(groups)
    ? groups.map((group) => ({
      ...group,
      pieceIds: Array.isArray(group?.pieceIds) ? [...group.pieceIds] : group?.pieceIds
    }))
    : []
);

export const createPieceAction = ({ piece, setPieces }) => ({
  label: 'Create piece',
  do: () => {
    setPieces(prev => [...prev, clonePiece(piece)]);
  },
  undo: () => {
    setPieces(prev => prev.filter(p => p.id !== piece.id));
  }
});

export const deletePieceAction = ({ piece, setPieces }) => ({
  label: 'Delete piece',
  do: () => {
    setPieces(prev => prev.filter(p => p.id !== piece.id));
  },
  undo: () => {
    setPieces(prev => {
      const next = [...prev];
      // If an index is provided, reinsert to preserve ordering.
      const index = Math.min(next.length, piece.index ?? next.length);
      next.splice(index, 0, clonePiece(piece));
      return next;
    });
  }
});

export const movePiecesAction = ({
  beforePieces,
  afterPieces,
  setPieces,
  label = 'Move pieces',
  ids = [],
  finalizePieces
}) => {
  const { before, after } = getChangedPieces(beforePieces, afterPieces);

  if (!before.length && !after.length) return null;

  const action = {
    label,
    ids,
    do: () => {
      setPieces(prev => {
        const next = applyPieceUpdates(prev, after);
        return typeof finalizePieces === 'function' ? finalizePieces(next) : next;
      });
    },
    undo: () => {
      setPieces(prev => {
        const next = applyPieceUpdates(prev, before);
        return typeof finalizePieces === 'function' ? finalizePieces(next) : next;
      });
    },
    merge: (previous) => {
      if (!previous || previous.label !== label) return null;
      if (!Array.isArray(previous.ids) || previous.ids.length !== ids.length) return null;
      const sameIds = previous.ids.every((id, index) => id === ids[index]);
      if (!sameIds) return null;
      return movePiecesAction({
        beforePieces: previous.beforePieces ?? beforePieces,
        afterPieces,
        setPieces,
        label,
        ids
      });
    }
  };

  // Preserve raw arrays for merging without recomputing diff.
  action.beforePieces = beforePieces;
  action.afterPieces = afterPieces;

  return action;
};

export const createConnectionAction = ({ connection, insertConnection, removeConnection }) => ({
  label: 'Create connection',
  do: () => {
    insertConnection(connection);
  },
  undo: () => {
    removeConnection(connection.id);
  }
});

export const deleteConnectionAction = ({ connection, insertConnection, removeConnection }) => ({
  label: 'Delete connection',
  do: () => {
    removeConnection(connection.id);
  },
  undo: () => {
    insertConnection(connection);
  }
});

export const updateConnectionAction = ({
  beforeConnection,
  afterConnection,
  insertConnection,
  removeConnection
}) => ({
  label: 'Update connection',
  do: () => {
    removeConnection(beforeConnection.id);
    insertConnection(afterConnection);
  },
  undo: () => {
    removeConnection(afterConnection.id);
    insertConnection(beforeConnection);
  }
});

export const replaceGroupsAction = ({
  beforeGroups,
  afterGroups,
  setGroups,
  label = 'Update groups'
}) => ({
  label,
  do: () => {
    setGroups(cloneGroups(afterGroups));
  },
  undo: () => {
    setGroups(cloneGroups(beforeGroups));
  }
});
