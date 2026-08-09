export function getPieceDisplayName(piece) {
  const label = typeof piece?.label === 'string' ? piece.label.trim() : '';
  if (label) return label;
  if (typeof piece?.filename !== 'string') return '';
  const normalized = piece.filename.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}
