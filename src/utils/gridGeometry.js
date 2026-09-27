/**
 * gridGeometry.js — the structural grid's pure geometry (ADR-030,
 * brief-structural-grid §4 "Applied grid definition").
 *
 * One world-space lattice with three levels, anchored at the fixed origin
 * (0, 0). A definition stores the major step per axis plus integer division
 * counts; the minor and sub steps are derived here and never stored, so the
 * three spacings can never disagree. Zoom, theme and visibility change how
 * the lattice is drawn, never which coordinates exist.
 *
 * Pure data in and out: no React, Konva or DOM imports.
 */

export const GRID_SCHEMA_VERSION = 1;
export const GRID_COORDINATE_SYSTEM = 'canvas-2d';

export const GRID_LIMITS = Object.freeze({
  minMajor: 10,
  maxMajor: 1000,
  minDivisions: 1,
  maxDivisions: 10,
});

// Owner ruling 2026-09-27 (playground review): 100 · 20 · 10, square. The
// 100 and 20 match the lines CanvasGrid drew before the grid existed, so a
// workspace saved before the grid record reads the same lattice.
export const DEFAULT_GRID_DEFINITION = Object.freeze({
  schemaVersion: GRID_SCHEMA_VERSION,
  coordinateSystem: GRID_COORDINATE_SYSTEM,
  origin: Object.freeze({ x: 0, y: 0 }),
  majorX: 100,
  majorY: 100,
  minorDivisions: 5,
  subDivisions: 2,
});

// The spacing presets offered in the Grid widget. Each keeps the sub step a
// divisor of 10 = gcd(180, 110), so a flush dock against an on-lattice
// neighbor stays on the Flex lattice.
export const GRID_PRESETS = Object.freeze([
  Object.freeze({ id: '100-20-10', label: '100·20·10', majorX: 100, majorY: 100, minorDivisions: 5, subDivisions: 2 }),
  Object.freeze({ id: '100-20-5', label: '100·20·5', majorX: 100, majorY: 100, minorDivisions: 5, subDivisions: 4 }),
  Object.freeze({ id: '50-10-5', label: '50·10·5', majorX: 50, majorY: 50, minorDivisions: 5, subDivisions: 2 }),
]);

const EPSILON = 1e-6;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function checkMajor(value, name, errors) {
  if (!isFiniteNumber(value)) {
    errors.push(`${name} must be a finite number`);
  } else if (value < GRID_LIMITS.minMajor || value > GRID_LIMITS.maxMajor) {
    errors.push(`${name} must be between ${GRID_LIMITS.minMajor} and ${GRID_LIMITS.maxMajor}`);
  }
}

function checkDivisions(value, name, errors) {
  if (!Number.isInteger(value)) {
    errors.push(`${name} must be a whole number`);
  } else if (value < GRID_LIMITS.minDivisions || value > GRID_LIMITS.maxDivisions) {
    errors.push(`${name} must be between ${GRID_LIMITS.minDivisions} and ${GRID_LIMITS.maxDivisions}`);
  }
}

/**
 * Validate a grid definition without changing it.
 *
 * Returns `{ ok, definition, errors, futureVersion }`. `definition` is a
 * normalized copy when `ok`; otherwise null. A record written by a newer
 * schema reports `futureVersion` so callers can refuse to overwrite it.
 * Missing `schemaVersion`, `coordinateSystem` and `origin` take the v1
 * values; present ones must match them.
 */
export function validateGridDefinition(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, definition: null, errors: ['grid definition must be an object'], futureVersion: false };
  }

  const schemaVersion = raw.schemaVersion ?? GRID_SCHEMA_VERSION;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    errors.push('schemaVersion must be a positive whole number');
  } else if (schemaVersion > GRID_SCHEMA_VERSION) {
    return {
      ok: false,
      definition: null,
      errors: [`schemaVersion ${schemaVersion} is newer than this build supports (${GRID_SCHEMA_VERSION})`],
      futureVersion: true,
    };
  }

  const coordinateSystem = raw.coordinateSystem ?? GRID_COORDINATE_SYSTEM;
  if (coordinateSystem !== GRID_COORDINATE_SYSTEM) {
    errors.push(`coordinateSystem must be "${GRID_COORDINATE_SYSTEM}"`);
  }

  // v1 has no movable origin.
  if (raw.origin != null && (raw.origin.x !== 0 || raw.origin.y !== 0)) {
    errors.push('origin must be (0, 0)');
  }

  checkMajor(raw.majorX, 'majorX', errors);
  checkMajor(raw.majorY, 'majorY', errors);
  checkDivisions(raw.minorDivisions, 'minorDivisions', errors);
  checkDivisions(raw.subDivisions, 'subDivisions', errors);

  if (errors.length) return { ok: false, definition: null, errors, futureVersion: false };
  return {
    ok: true,
    definition: {
      schemaVersion: GRID_SCHEMA_VERSION,
      coordinateSystem: GRID_COORDINATE_SYSTEM,
      origin: { x: 0, y: 0 },
      majorX: raw.majorX,
      majorY: raw.majorY,
      minorDivisions: raw.minorDivisions,
      subDivisions: raw.subDivisions,
    },
    errors: [],
    futureVersion: false,
  };
}

/** Do two definitions describe the same lattice? */
export function sameGridDefinition(a, b) {
  return Boolean(a && b)
    && a.majorX === b.majorX && a.majorY === b.majorY
    && a.minorDivisions === b.minorDivisions && a.subDivisions === b.subDivisions;
}

/** The three levels' steps per axis, derived from a valid definition. */
export function deriveGridSteps(definition) {
  const minorX = definition.majorX / definition.minorDivisions;
  const minorY = definition.majorY / definition.minorDivisions;
  return {
    majorX: definition.majorX,
    majorY: definition.majorY,
    minorX,
    minorY,
    subX: minorX / definition.subDivisions,
    subY: minorY / definition.subDivisions,
  };
}

/** Normalize negative zero so -0 never reaches a coordinate or a key. */
export const normalizeZero = (value) => (value === 0 ? 0 : value);

/**
 * Round to the nearest multiple of `step`. Ties round away from zero on both
 * sides of the origin, so -150 and 150 round symmetrically (to -200 and 200
 * with a step of 100). Negative zero is normalized.
 */
export function roundToStep(value, step) {
  const q = value / step;
  const index = Math.sign(q) * Math.round(Math.abs(q));
  return normalizeZero(index * step);
}

/** Is `value` a multiple of `step`, within floating-point noise? */
export function isOnStep(value, step) {
  const q = value / step;
  return Math.abs(q - Math.round(q)) < EPSILON;
}

/**
 * The strongest level whose intersection sits at (x, y): 'major', 'minor',
 * 'sub' or 'off-grid'.
 */
export function gridLevelAt(x, y, steps) {
  if (isOnStep(x, steps.majorX) && isOnStep(y, steps.majorY)) return 'major';
  if (isOnStep(x, steps.minorX) && isOnStep(y, steps.minorY)) return 'minor';
  if (isOnStep(x, steps.subX) && isOnStep(y, steps.subY)) return 'sub';
  return 'off-grid';
}

/**
 * Lattice intersections around `anchor`, ring by ring outward, up to
 * `maxRing` steps away. Within a ring the order is deterministic: nearest to
 * the anchor first, ties broken by y, then x.
 */
export function* latticeCandidates(anchor, stepX, stepY, maxRing) {
  const cx = Math.sign(anchor.x / stepX) * Math.round(Math.abs(anchor.x / stepX));
  const cy = Math.sign(anchor.y / stepY) * Math.round(Math.abs(anchor.y / stepY));
  for (let ring = 0; ring <= maxRing; ring++) {
    const points = [];
    for (let i = -ring; i <= ring; i++) {
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        const x = normalizeZero((cx + i) * stepX);
        const y = normalizeZero((cy + j) * stepY);
        points.push({ x, y, distance: Math.hypot(x - anchor.x, y - anchor.y) });
      }
    }
    points.sort((a, b) => (a.distance - b.distance) || (a.y - b.y) || (a.x - b.x));
    for (const point of points) yield point;
  }
}

/**
 * Integer line indices covering [min, max] for a step: the first line at or
 * before `min` through the first at or after `max`. Indices, not accumulated
 * coordinates, so distant lines carry no floating-point drift.
 */
export function lineIndexRange(min, max, step) {
  return { first: Math.floor(min / step), last: Math.ceil(max / step) };
}
