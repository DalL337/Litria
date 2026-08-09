import { useEffect, useRef } from 'react';

import { isPrimaryModifier } from '../platform/modifierKeys';

/**
 * useGlobalShortcuts — owns the window-level keydown listener and the
 * key → action dispatch table App.jsx used to declare inline (Tier 1
 * debt cleanup). This is the seam the future shortcut registry fills:
 * the table below becomes registry-driven without App.jsx changing.
 *
 * The listener is attached once for the component lifetime; the actions
 * bag is read through a per-render ref so every dispatch sees the current
 * callbacks, never mount-time closures. Callers may therefore pass fresh
 * inline callbacks each render without re-binding the listener.
 *
 * Focus guards are part of the dispatch, not the callers:
 * - Monaco keeps its own keybindings — shortcuts marked `monacoGuard`
 *   never fire while focus is inside a Monaco editor.
 * - Select-all never steals from text-editing surfaces (inputs,
 *   textareas, contentEditable — which covers the xterm helper textarea).
 */
export function useGlobalShortcuts(actions) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const isInMonaco = () => Boolean(document.activeElement?.closest('.monaco-editor'));

    const handleKeyDown = (e) => {
      if (!isPrimaryModifier(e)) return;
      const act = actionsRef.current;

      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        act.undo();
      }

      if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
        e.preventDefault();
        act.redo();
      }

      if (e.key === '0' && !e.shiftKey) {
        if (isInMonaco()) return;
        e.preventDefault();
        act.fitContent();
      }

      if (e.key === '0' && e.shiftKey) {
        if (isInMonaco()) return;
        e.preventDefault();
        act.fitSelection();
      }

      if (e.key === 'p') {
        if (isInMonaco()) return;
        e.preventDefault();
        act.toggleNodeSearch();
      }

      if (e.key === 'a') {
        // Never steal select-all from text editing surfaces (inputs, Monaco,
        // the xterm helper textarea).
        const target = e.target;
        if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;
        if (isInMonaco()) return;
        e.preventDefault();
        act.selectAllVisible();
      }

      if (e.key === '\\') {
        // ADR-017: generic Split Editor verb (View menu twin).
        e.preventDefault();
        act.splitEditor?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
