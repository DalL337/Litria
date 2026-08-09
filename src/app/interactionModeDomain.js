/**
 * interactionModeDomain.js — Pure factory for the canvas interaction mode
 * system (ADR-013 Phases 1-2).
 *
 * Two mutually-exclusive modes:
 *   - 'default' — current canvas manipulation (drag = move, Ctrl+click = connect)
 *   - 'edit'    — structural editing; sub-modes 'additive' / 'subtractive'
 *
 * State lives in the host (React useState in interactionDomain) and is reached
 * through injected getters/setters, mirroring the pieceDomain/groupDomain
 * pattern so the transitions stay unit-testable without React.
 *
 * Pure: no React, no side effects beyond the injected setters.
 */

import { ACTION_TOKENS, DEFAULT_SUB_MODE } from './actionTokens.js';

/**
 * @param {object} params
 * @param {() => ('default'|'edit')} params.getMode
 * @param {(mode: 'default'|'edit') => void} params.applyMode
 * @param {() => string} params.getSubMode
 * @param {(tokenId: string) => void} params.applySubMode
 */
export function createInteractionModeDomain({ getMode, applyMode, getSubMode, applySubMode }) {
  return {
    commands: {
      /** Flip default ↔ edit. Entering edit resets the sub-mode to additive. */
      toggleMode() {
        const next = getMode() === 'edit' ? 'default' : 'edit';
        applyMode(next);
        if (next === 'edit') applySubMode(DEFAULT_SUB_MODE);
      },
      /** Force edit mode on (resets sub-mode to additive). */
      enterEditMode() {
        applyMode('edit');
        applySubMode(DEFAULT_SUB_MODE);
      },
      /** Force default mode. */
      exitEditMode() {
        applyMode('default');
      },
      /**
       * Switch the active sub-mode. No-op outside edit mode or for an unknown
       * token — sub-mode is only meaningful while editing.
       */
      setSubMode(tokenId) {
        if (getMode() !== 'edit') return;
        if (!ACTION_TOKENS[tokenId]) return;
        applySubMode(tokenId);
      },
    },
    selectors: {
      isEditMode() {
        return getMode() === 'edit';
      },
      /** Active token id while editing, else null (default mode has no token). */
      activeActionToken() {
        return getMode() === 'edit' ? getSubMode() : null;
      },
      /** Full token object while editing, else null. */
      activeToken() {
        if (getMode() !== 'edit') return null;
        return ACTION_TOKENS[getSubMode()] ?? null;
      },
    },
  };
}
