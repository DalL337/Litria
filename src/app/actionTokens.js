/**
 * actionTokens.js — Action token registry + key bindings for the interaction
 * mode system (ADR-013).
 *
 * A token is the semantic intent layer within Edit mode. Consumers ask
 * "is this intent active?" via useActionToken — they never read keyboard or
 * mode internals. Tokens declare their label, cursor treatment, and description.
 *
 * Pure data + lookup maps. No React, no side effects.
 */

export const ACTION_TOKENS = {
  additive: {
    id: 'additive',
    label: 'Add',
    cursor: 'plus',
    description: 'Add item to target',
  },
  subtractive: {
    id: 'subtractive',
    label: 'Remove',
    cursor: 'minus',
    description: 'Remove item from target',
  },
};

/** Sub-mode Edit mode resets to on entry. */
export const DEFAULT_SUB_MODE = 'additive';

/**
 * Which key tap switches to which sub-mode (ADR-013 §Layer 2). User-remappable
 * later; this is the default binding map.
 */
export const DEFAULT_ACTION_BINDINGS = {
  additive: 'ctrl',
  subtractive: 'alt',
};

/** Inverse of DEFAULT_ACTION_BINDINGS: binding key → token id. */
export const TOKEN_FOR_BINDING = {
  ctrl: 'additive',
  alt: 'subtractive',
};

/** Return the token object for an id, or null. */
export function getActionToken(tokenId) {
  return ACTION_TOKENS[tokenId] ?? null;
}
