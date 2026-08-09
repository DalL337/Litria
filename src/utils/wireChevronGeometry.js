// wireChevronGeometry.js
// Pure geometry for the directional wire chevron (bezier Phase 2). Separate from
// wireGeometry (the wire's own compute/draw seam) and from the Konva component,
// so the chevron stays a decoration that can be restyled/removed without
// touching wire code — and so the math is unit-testable without react-konva.

/**
 * Flat Konva `points` for an open `>` chevron at `point`, pointing along its
 * unit tangent: apex swept forward, two wings swept back.
 *
 * @param {{ x:number, y:number, tangent:{x:number,y:number} }} point - from buildWireCurve's pointAt
 * @param {number} half - half the chevron size, in canvas units
 * @returns {number[]} [wing1x, wing1y, apexX, apexY, wing2x, wing2y]
 */
export function chevronPoints({ x, y, tangent }, half) {
  const dx = tangent.x;
  const dy = tangent.y;
  const nx = -dy; // normal to the tangent
  const ny = dx;
  return [
    x - dx * half + nx * half, y - dy * half + ny * half, // wing 1 (back + side)
    x + dx * half,             y + dy * half,             // apex (forward)
    x - dx * half - nx * half, y - dy * half - ny * half, // wing 2 (back - side)
  ];
}
