import { useCallback, useSyncExternalStore } from 'react';
import {
  getDiagnosticsForFile,
  subscribeToDiagnostics
} from '../lsp/diagnosticStore';

/**
 * Compute the LED health state for a single node.
 *
 * Priority waterfall:
 *   1. dirty (unsaved changes)    → 'blue'
 *   2. errors from LSP            → 'red'
 *   3. warnings from LSP          → 'amber'
 *   4. file is empty (no content) → 'empty'
 *   5. clean                      → 'green'
 *
 * @param {object} piece - Piece data from pieceDomain
 * @param {boolean} isDirty - Whether the piece has unsaved changes
 * @param {string|null} projectRoot - Absolute project root path
 * @returns {'blue'|'red'|'amber'|'green'|'empty'}
 */
export function computeNodeHealth(piece, isDirty, projectRoot) {
  if (isDirty) return 'blue';

  const diags = getDiagnosticsForFile(piece?.filename, projectRoot);
  if (diags) {
    if (diags.errors > 0) return 'red';
    if (diags.warnings > 0) return 'amber';
    return 'green';
  }

  // No diagnostics data — check if file has content
  const hasContent = typeof piece?.code === 'string' && piece.code.trim().length > 0;
  return hasContent ? 'green' : 'empty';
}

/**
 * React hook that subscribes to diagnostic store updates.
 * Returns a monotonically increasing version number that changes when
 * any diagnostic data updates, causing consumers to recompute health.
 */
let diagnosticVersion = 0;
function getSnapshot() { return diagnosticVersion; }
function subscribe(cb) {
  return subscribeToDiagnostics(() => {
    diagnosticVersion++;
    cb();
  });
}

export function useDiagnosticVersion() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Compute health states for all pieces in a single pass.
 * Used by WorkspaceStage to batch health computation.
 *
 * @param {Array} pieces - All visible pieces
 * @param {Set} dirtyPieceIds - Set of piece IDs with unsaved changes
 * @param {string|null} projectRoot - Absolute project root path
 * @returns {Map<number|string, string>} pieceId → health state
 */
export function computeAllNodeHealth(pieces, dirtyPieceIds, projectRoot) {
  const healthMap = new Map();
  if (!Array.isArray(pieces)) return healthMap;

  for (const piece of pieces) {
    const isDirty = dirtyPieceIds?.has(piece.id) ?? false;
    healthMap.set(piece.id, computeNodeHealth(piece, isDirty, projectRoot));
  }
  return healthMap;
}
