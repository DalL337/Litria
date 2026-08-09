import { useEffect, useMemo, useRef, useState } from 'react';
import { useCanvasInteractionController } from '../behaviors/useCanvasInteractionController';
import { createInteractionModeDomain } from './interactionModeDomain.js';
import { DEFAULT_SUB_MODE, TOKEN_FOR_BINDING } from './actionTokens.js';

// Mode toggle key (ADR-013 §User remapping — `E` is the default, unbound today).
const MODE_TOGGLE_KEY = 'e';

// Exported for other non-modifier canvas keybinds (e.g. the HUD toggle in
// useCanvasHud) so all bare-letter shortcuts share one editable-target rule.
export function isEditableTarget() {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (!el) return false;
  if (el.closest?.('.monaco-editor')) return true;
  if (el.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '');
}

export function useInteractionDomain(params) {
  // ── Interaction mode state (ADR-013 Phases 1-2) ──────────────────────────
  // Created BEFORE the controller so its selectors can be injected — Phase 3
  // gates structural drag behavior (merge/extract) on the active mode/sub-mode.
  const [interactionMode, setInteractionMode] = useState('default');
  const [activeSubMode, setActiveSubMode] = useState(DEFAULT_SUB_MODE);

  const modeDomain = useMemo(() => createInteractionModeDomain({
    getMode: () => interactionMode,
    applyMode: setInteractionMode,
    getSubMode: () => activeSubMode,
    applySubMode: setActiveSubMode,
  }), [interactionMode, activeSubMode]);

  const controller = useCanvasInteractionController({
    ...params,
    isEditMode: modeDomain.selectors.isEditMode,
    activeActionToken: modeDomain.selectors.activeActionToken,
  });

  // Keyboard wiring lives here (not App.jsx) so the shell stays composition-only
  // and the existing modifier-gated shortcut handler is untouched.
  //   E          → toggle default/edit
  //   Ctrl tap   → additive sub-mode   (edit mode only)
  //   Alt tap    → subtractive sub-mode (edit mode only)
  // A "tap" is a modifier keydown→keyup with no other key pressed in between,
  // so Ctrl+Z / Alt+<x> combos never switch sub-mode.
  const tapRef = useRef({ key: null, used: false });
  useEffect(() => {
    const onKeyDown = (e) => {
      if (isEditableTarget()) return;
      if (
        (e.key === MODE_TOGGLE_KEY || e.key === MODE_TOGGLE_KEY.toUpperCase()) &&
        !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
      ) {
        e.preventDefault();
        modeDomain.commands.toggleMode();
        return;
      }
      if (e.key === 'Control' || e.key === 'Alt') {
        tapRef.current = { key: e.key, used: false };
      } else if (tapRef.current.key) {
        tapRef.current.used = true;
      }
    };
    const onKeyUp = (e) => {
      if (e.key !== 'Control' && e.key !== 'Alt') return;
      const pending = tapRef.current;
      if (pending.key === e.key && !pending.used) {
        const binding = e.key === 'Control' ? 'ctrl' : 'alt';
        modeDomain.commands.setSubMode(TOKEN_FOR_BINDING[binding]);
      }
      tapRef.current = { key: null, used: false };
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [modeDomain]);

  return useMemo(() => ({
    lifecycle: {
      isLassoSelecting: Boolean(params.lasso?.isSelecting),
      isConnectionDragging: Boolean(params.connectionDrag?.isDragging),
      isDraggingPiece: controller.isDraggingPiece(),
      isDragActive: controller.isDragActive,
      dragOverGroupId: controller.dragOverGroupId,
      subtractiveDragSource: controller.subtractiveDragSource,
      interactionMode,
      // Only meaningful while editing; null in default mode for clarity.
      activeSubMode: interactionMode === 'edit' ? activeSubMode : null
    },
    commands: {
      handleStageMouseDown: controller.handleStageMouseDown,
      handleStageMouseMove: controller.handleStageMouseMove,
      handleStageMouseUp: controller.handleStageMouseUp,
      handleStageMouseLeave: controller.handleStageMouseLeave,
      handlePieceDragMove: controller.handlePieceDragMove,
      handlePieceDragStart: controller.handlePieceDragStart,
      finalizePieceDragWithSnap: controller.handlePieceDragEnd,
      handlePieceDragEnd: controller.handlePieceDragEnd,
      handleConnectionStart: controller.handleConnectionStart,
      handleGroupPillDragStart: controller.handleGroupPillDragStart,
      handleGroupPillDragMove: controller.handleGroupPillDragMove,
      handleGroupPillDragEnd: controller.handleGroupPillDragEnd,
      scaleSelectedPieces: controller.scaleSelectedPieces,
      toggleMode: modeDomain.commands.toggleMode,
      setSubMode: modeDomain.commands.setSubMode
    },
    selectors: {
      getDragLine() {
        return params.connectionDrag?.getDragLine() ?? null;
      },
      getHoverTarget() {
        return params.connectionDrag?.getHoverTarget() ?? null;
      },
      getDragOverGroupId() {
        return controller.dragOverGroupId;
      },
      isEditMode: modeDomain.selectors.isEditMode,
      activeActionToken: modeDomain.selectors.activeActionToken,
      activeToken: modeDomain.selectors.activeToken
    },
    // Exposed for WorkspaceContext → useActionToken consumers (ADR-013 Layer 3).
    modeDomain
  }), [controller, params.connectionDrag, params.lasso?.isSelecting, modeDomain, interactionMode, activeSubMode]);
}
