import { useCallback, useState } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';

/**
 * SyntaxSymbolPicker — floating dropdown to resolve pending syntax connections.
 *
 * Appears after a canvas drag creates a connection between two file-nodes.
 * Lists the available definitions from the source file so the user can pick
 * one or more to import in the target file.
 *
 * Multi-select: symbols are toggled via click. A "Connect selected" button
 * commits all toggled symbols at once.
 *
 * Hosting: a Radix Popover anchored to a 0×0 point at the drop position
 * (ADR-007 — interactive overlay). Radix owns outside-click and Escape
 * dismissal plus viewport collision handling; both dismissals funnel through
 * onOpenChange → onDismiss. Non-modal, so canvas interaction beneath stays
 * live, and auto-focus is suppressed both ways to keep canvas keyboard flows
 * undisturbed (the hand-rolled version never moved focus either).
 *
 * Props:
 *   symbols       {object[]}  Definition[] from getAvailableSymbolsForEdge / getDefinitionsForFile.
 *   style         {object}    { left, top } screen-pixel position for the panel.
 *   onPick        {function}  (symbolIds: string[]) => void
 *   onDismiss     {function}  () => void — called on Escape or outside-click.
 */
export default function SyntaxSymbolPicker({ symbols, style, onPick, onDismiss }) {
  // Pre-select when there's exactly one symbol so the common single-symbol case
  // (e.g. a default-only file) is a one-click "Connect" instead of select-then-connect.
  const [selected, setSelected] = useState(
    () => new Set(symbols.length === 1 ? [symbols[0].symbolId] : []),
  );

  const handleOpenChange = useCallback((open) => {
    if (!open) onDismiss();
  }, [onDismiss]);

  const toggleSymbol = useCallback((symbolId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(symbolId)) next.delete(symbolId);
      else next.add(symbolId);
      return next;
    });
  }, []);

  const handleConnect = useCallback(() => {
    if (selected.size === 0) return;
    onPick([...selected]);
  }, [selected, onPick]);

  // Group symbols by definitionKind for visual organization
  const groups = groupByKind(symbols);

  return (
    <Popover open onOpenChange={handleOpenChange}>
      <PopoverAnchor
        aria-hidden="true"
        style={{ position: 'fixed', left: style?.left ?? 0, top: style?.top ?? 0, width: 0, height: 0 }}
      />
      <PopoverContent
        className="syntax-symbol-picker"
        side="bottom"
        align="start"
        sideOffset={0}
        collisionPadding={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        <div className="syntax-symbol-picker-header">Select symbols to import</div>
        {symbols.length === 0 ? (
          <div className="syntax-symbol-picker-empty">No definitions found in source file</div>
        ) : (
          <ul className="syntax-symbol-picker-list">
            {groups.map(({ kind, items }) => (
              <li key={kind} className="syntax-symbol-picker-group">
                <div className="syntax-symbol-group-label">{KIND_LABELS[kind] || kind}</div>
                <ul className="syntax-symbol-group-items">
                  {items.map((sym) => {
                    const isSelected = selected.has(sym.symbolId);
                    return (
                      <li key={sym.symbolId}>
                        <button
                          className={`syntax-symbol-picker-item${isSelected ? ' is-selected' : ''}`}
                          onClick={() => toggleSymbol(sym.symbolId)}
                        >
                          <span className={`syntax-symbol-check${isSelected ? ' is-checked' : ''}`} />
                          <span className="syntax-symbol-kind">{sym.definitionKind}</span>
                          <span className="syntax-symbol-name">{sym.name}</span>
                          {sym.exported && <span className="syntax-symbol-exported">exported</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <div className="syntax-symbol-picker-footer">
          {selected.size > 0 && (
            <button className="syntax-symbol-picker-connect" onClick={handleConnect}>
              Connect {selected.size} symbol{selected.size > 1 ? 's' : ''}
            </button>
          )}
          <button className="syntax-symbol-picker-dismiss" onClick={onDismiss}>
            Skip for now
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Kind display order and labels. */
const KIND_ORDER = ['function', 'class', 'const', 'let', 'var', 'type', 'interface', 'enum'];
const KIND_LABELS = {
  function: 'Functions',
  class: 'Classes',
  const: 'Constants',
  let: 'Variables',
  var: 'Variables',
  type: 'Types',
  interface: 'Interfaces',
  enum: 'Enums',
};

/**
 * Group symbols by definitionKind, preserving KIND_ORDER ordering.
 * @param {object[]} symbols
 * @returns {{ kind: string, items: object[] }[]}
 */
function groupByKind(symbols) {
  const map = new Map();
  for (const sym of symbols) {
    const k = sym.definitionKind || 'other';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(sym);
  }
  const groups = [];
  for (const kind of KIND_ORDER) {
    if (map.has(kind)) {
      groups.push({ kind, items: map.get(kind) });
      map.delete(kind);
    }
  }
  // Any remaining kinds not in KIND_ORDER
  for (const [kind, items] of map) {
    groups.push({ kind, items });
  }
  return groups;
}
