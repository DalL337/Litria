/**
 * useActionToken — the one-line extension API for the interaction mode system
 * (ADR-013 Layer 3).
 *
 * Consumers ask "is this intent active?" without touching mode management,
 * cursor rendering, or key detection. If the user remaps the sub-mode toggle
 * keys or the mode internals change, consumers are unaffected — the token id
 * is the stable API boundary.
 *
 *   const { isActive } = useActionToken('additive');
 *   // isActive: true when edit mode is on AND the active sub-mode is 'additive'
 */

import { useWorkspace } from './WorkspaceContext.jsx';

export function useActionToken(tokenId) {
  const { modeDomain } = useWorkspace();
  const activeToken = modeDomain?.selectors?.activeActionToken?.() ?? null;
  return {
    isActive: activeToken != null && activeToken === tokenId,
    activeToken
  };
}
