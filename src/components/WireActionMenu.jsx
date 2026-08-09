import { useEffect, useRef } from 'react';

/**
 * WireActionMenu — floating actions for a selected connection wire (Phase 3).
 *
 * Modeless: a wire is selected by clicking it (like selecting a node), and this
 * small menu appears at the wire's midpoint with the actions that operate on the
 * existing edge — Delete (removes the edge + its generated import) and Add
 * symbol (reopens the symbol picker to grow the edge's bundle).
 *
 * Dismissal is handled by the caller (empty-canvas click, piece/group select);
 * this component adds Escape as a convenience.
 *
 * Props:
 *   style      {object}    { left, top } screen-pixel anchor.
 *   onDelete   {function}  () => void
 *   onAddSymbol{function}  () => void
 *   onDismiss  {function}  () => void — Escape.
 */
/**
 * WireBundleMenu — member list for an AGGREGATED wire (multiple edges folded
 * into one pill-anchored wire, brief-cross-group-wires D2). Modeless inline
 * list, not a modal: clicking an entry selects that member connection, which
 * surfaces the standard WireActionMenu with the existing per-wire actions.
 *
 * Generic pick-one list (also reused by the off-canvas import badge, S3).
 *
 * Props:
 *   style   {object}   { left, top } screen-pixel anchor.
 *   entries {Array}    [{ id, label }]
 *   onPick  {function} (id) => void
 *   onDismiss {function} () => void — Escape.
 */
export function WireBundleMenu({ style, entries, onPick, onDismiss }) {
  useEscapeDismiss(onDismiss);
  const ref = useRef(null);

  // Click-away dismissal (owner refinement, wire-arc E): any pointerdown
  // outside the list — canvas, group, anywhere — closes it. Capture phase so
  // Konva's own handling can't swallow it. The opening click can't
  // self-dismiss: the listener attaches only after the menu renders.
  useEffect(() => {
    function handlePointerDown(e) {
      if (ref.current && !ref.current.contains(e.target)) onDismiss?.();
    }
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [onDismiss]);

  return (
    <div ref={ref} className="wire-action-menu" style={{ position: 'fixed', ...style }}>
      {entries.map((entry) => (
        <button
          key={entry.id}
          className="wire-action-menu-item"
          onClick={() => onPick?.(entry.id)}
        >
          <span className="wire-action-menu-icon">→</span>
          {entry.label}
        </button>
      ))}
    </div>
  );
}

// Escape-to-dismiss for the bundle menu (WireActionMenu keeps its inline copy).
function useEscapeDismiss(onDismiss) {
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismiss?.();
      }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onDismiss]);
}

export default function WireActionMenu({ style, onDelete, onAddSymbol, onDismiss }) {
  const ref = useRef(null);

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismiss?.();
      }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onDismiss]);

  return (
    <div ref={ref} className="wire-action-menu" style={{ position: 'fixed', ...style }}>
      <button className="wire-action-menu-item" onClick={onAddSymbol}>
        <span className="wire-action-menu-icon">+</span>
        Add symbol
      </button>
      <button className="wire-action-menu-item is-danger" onClick={onDelete}>
        <span className="wire-action-menu-icon">×</span>
        Delete wire
      </button>
    </div>
  );
}
