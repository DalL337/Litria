/**
 * pieceDimensions.js — canonical piece rect size.
 *
 * Hoisted out of PuzzlePiece.jsx (which re-exports for compatibility) so
 * pure modules and node tests can import the dimensions without resolving
 * a JSX component. One source of truth; do not redefine these numbers.
 */
export const PIECE_WIDTH = 180;
export const PIECE_HEIGHT = 110;
