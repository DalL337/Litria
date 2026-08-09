export function getLassoSelectedIds(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => item?.id)
    .filter((id) => Number.isFinite(id));
}

export function applyDragEndSnap({
  pieces,
  dragIds,
  draggedPieceId,
  dragX,
  dragY,
  getGroupSnapDelta,
  checkSnap
}) {
  if (!Array.isArray(pieces) || !Array.isArray(dragIds) || !dragIds.length) {
    return pieces;
  }

  if (dragIds.length > 1) {
    const snapDelta = getGroupSnapDelta?.(dragIds);
    if (snapDelta && (snapDelta.dx || snapDelta.dy)) {
      const selected = new Set(dragIds);
      return pieces.map((piece) =>
        selected.has(piece.id)
          ? { ...piece, x: piece.x + snapDelta.dx, y: piece.y + snapDelta.dy }
          : piece
      );
    }
    return pieces;
  }

  const piece = pieces.find((entry) => entry.id === draggedPieceId);
  if (!piece) return pieces;
  const snap = checkSnap?.(piece, dragX, dragY);
  if (!snap) return pieces;
  return pieces.map((entry) =>
    entry.id === draggedPieceId ? { ...entry, x: snap.x, y: snap.y } : entry
  );
}

export function executeInteractionHistoryAction(history, { label, action, skipDo = false }) {
  if (!action) return;
  history.beginGroup?.(label);
  try {
    history.execute(action, skipDo ? { skipDo: true } : undefined);
  } finally {
    history.endGroup?.();
  }
}

