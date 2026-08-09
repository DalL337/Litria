/**
 * wireAppearance.js — the wire visual language resolver (ADR-025 §5, S0).
 *
 * Pure state → appearance mapping so the language is unit-testable without a
 * canvas. ConnectionLine feeds it the wire's status + attention state and
 * draws exactly what it returns; no appearance decisions live in the
 * component.
 *
 * The language (ADR-025 §5, canonical detail in brief-edge-routing.md
 * §Wire visual language):
 *   - Rest = topology: healthy wires rest thin, solid, NEUTRAL (green
 *     retires at rest).
 *   - Exception-based status: unhealthy wires rest POPPED — body + status
 *     color + presence — without waiting for hover (preserves the PR #166
 *     property: dead imports read red from first load).
 *   - Hover = inspect: pop to gauge + status color + glow. Click = held pop.
 *   - Global focus swap: while one wire is hovered, every other wire drops
 *     a half-step. Selection is exempt: a held pop is an explicit gesture,
 *     and gesture outranks attention (ADR-025 §3 hierarchy).
 *   - Hover is paint-only — nothing here feeds geometry.
 */

// --- Gauge ladder (canvas-space px; on-screen result clamped by min/max) ---
export const WIRE_GAUGE_NEUTRAL_REST = 2;    // thin topology line
export const WIRE_GAUGE_EXCEPTION_REST = 5;  // popped rest presence
export const WIRE_GAUGE_HOVER = 6;
export const WIRE_GAUGE_SELECTED = 6;        // + glow, not extra width

// --- On-screen clamps (applied after zoom) ---
// Neutral rest may drop BELOW the color-channel floor by design: overview
// zoom shows structure while exception wires stand out from altitude
// (ADR-025 §5 routing-constant consequences).
export const WIRE_MIN_PX_NEUTRAL = 0.75;
export const WIRE_MIN_PX_STATUS = 2;         // status color channel never vanishes
export const WIRE_MAX_PX = 9;

// --- Global focus swap: the non-hovered majority's half-step ---
export const WIRE_FOCUS_DIM_OPACITY = 0.4;

// --- D4 unroutable fallback (ADR-025 §9): the wire de-emphasizes and
// passes beneath — existing z-order renders the under-pass gracefully. ---
export const WIRE_UNROUTED_DIM_OPACITY = 0.45;

// --- D1c adjacency fade band (ADR-025 §4): contact suppression is a
// continuum, not a cliff. Terminal distance ≤ HIDE renders nothing
// (contact IS the display); opacity ramps to full by FULL. Replaces the
// binary 20px ADJACENCY_THRESHOLD reveal (owner ruling: kill the
// magic-number cliff; proximity substitutes for ink). ---
export const WIRE_FADE_HIDE_PX = 16;
export const WIRE_FADE_FULL_PX = 28;

/**
 * Adjacency fade factor for a wire whose terminals are `distance` apart
 * (canvas px). 0 = fully hidden (caller skips rendering), 1 = full ink.
 *
 * @param {number} distance
 * @returns {number} 0..1
 */
export function adjacencyFadeFactor(distance) {
  if (!Number.isFinite(distance) || distance <= WIRE_FADE_HIDE_PX) return 0;
  if (distance >= WIRE_FADE_FULL_PX) return 1;
  return (distance - WIRE_FADE_HIDE_PX) / (WIRE_FADE_FULL_PX - WIRE_FADE_HIDE_PX);
}

// Syntax statuses that rest popped (exception-based status). `resolved` is
// deliberately absent: a healthy wire has nothing to say.
const EXCEPTION_SYNTAX_STATUSES = new Set([
  'broken', 'orphaned', 'drifted', 'unused', 'pending',
]);

// Piece-health statuses that rest popped (wires with no syntax edge carry
// piece health instead). `valid` is deliberately absent.
const EXCEPTION_HEALTH_STATUSES = new Set(['error', 'empty', 'warning']);

/**
 * Does this wire's status make it an exception (rests popped)?
 * syntaxStatus takes priority over piece health, mirroring the color logic.
 *
 * @param {string|null|undefined} syntaxStatus - syntax-domain status, or null
 * @param {string|null|undefined} healthStatus - piece-health status fallback
 * @returns {boolean}
 */
export function isExceptionStatus(syntaxStatus, healthStatus) {
  if (syntaxStatus != null) return EXCEPTION_SYNTAX_STATUSES.has(syntaxStatus);
  return EXCEPTION_HEALTH_STATUSES.has(healthStatus ?? 'valid');
}

/**
 * Resolve the full drawn appearance for one wire.
 *
 * @param {object} state
 * @param {string|null} [state.syntaxStatus] - syntax-domain status, or null
 * @param {string} [state.healthStatus] - piece-health status ('valid' default)
 * @param {boolean} [state.isHovered]
 * @param {boolean} [state.isSelected]
 * @param {boolean} [state.isFocusDimmed] - some OTHER wire is hovered
 * @returns {{
 *   gauge: number,        // canvas-space stroke before zoom clamp
 *   minPx: number,        // on-screen floor
 *   maxPx: number,        // on-screen cap
 *   useStatusColor: boolean, // status color when true, neutral when false
 *   glow: boolean,        // soft outer glow (hover + selection only)
 *   opacity: number,      // 1, or the focus-swap half-step
 * }}
 */
export function resolveWireAppearance({
  syntaxStatus = null,
  healthStatus = 'valid',
  isHovered = false,
  isSelected = false,
  isFocusDimmed = false,
  isUnrouted = false,
} = {}) {
  const exception = isExceptionStatus(syntaxStatus, healthStatus);
  const popped = isHovered || isSelected || exception;

  const gauge = isSelected
    ? WIRE_GAUGE_SELECTED
    : isHovered
      ? WIRE_GAUGE_HOVER
      : exception
        ? WIRE_GAUGE_EXCEPTION_REST
        : WIRE_GAUGE_NEUTRAL_REST;

  // Attention (hover/select) is exempt from the focus swap; a hovered or
  // held wire never dims itself.
  const dimmed = isFocusDimmed && !isHovered && !isSelected;

  // D4: an unroutable wire de-emphasizes at rest (the under-pass), but
  // attention still pops it to full — inspectability wins on hover/select.
  // Dim factors compose multiplicatively so an unrouted wire whispering
  // during a focus swap sits below either factor alone.
  const attention = isHovered || isSelected;
  const opacity = (dimmed ? WIRE_FOCUS_DIM_OPACITY : 1)
    * (isUnrouted && !attention ? WIRE_UNROUTED_DIM_OPACITY : 1);

  return {
    gauge,
    minPx: popped ? WIRE_MIN_PX_STATUS : WIRE_MIN_PX_NEUTRAL,
    maxPx: WIRE_MAX_PX,
    useStatusColor: popped,
    glow: isHovered || isSelected,
    opacity,
  };
}
