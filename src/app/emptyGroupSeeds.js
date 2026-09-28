/**
 * emptyGroupSeeds.js — where the boxes of newly found empty folders go.
 *
 * An empty folder's group has no members to derive a box from, so it is
 * drawn at its seed (D2 parity, brief-group-physicality). A reconciliation
 * pass can find many at once: a project opened for the first time finds
 * `.vscode`, `public`, `src-tauri` and `src-tauri`'s subfolders together.
 * Seeding each from one spawn point piled them up: top-level ones 24 units
 * apart, and every subfolder of a parent created in the same pass on exactly
 * the same spot (owner smoke test, 2026-09-27).
 *
 * The layout here: each empty subtree is a column, its subfolders indented
 * under their parent in folder order, one row apart, so every box and name
 * tab is visible and each parent's box encloses its children. A column whose
 * parent folder already has a box (an existing group, or one being created
 * with members) sits under that box, as before. Any other column takes the
 * free major intersection nearest the spawn point, clear of nodes, group
 * boxes and the columns already placed — the same search new nodes use.
 *
 * Pure: no React, no I/O.
 */

import { latticeCandidates } from '../utils/gridGeometry.js';
import { rectsOverlap } from '../utils/spatialGeometry2d.js';
import { GROUP_OUTLINE_PAD, GROUP_NEST_PAD } from './selectors/workspaceSelectors.js';

// The name tab drawn above each group box (WorkspaceStage).
export const GROUP_TAB_HEIGHT = 20;
// Air between one drawn box (tab and padding included) and the next.
const CLEARANCE = 8;
// Rings of major intersections searched for a free spot.
const ROOT_SEARCH_RINGS = 12;
// Lattice used when the workspace has no grid.
const FALLBACK_STEP = 10;
const FALLBACK_MAJOR = 100;

const ceilTo = (value, step) => Math.ceil(value / step) * step;

/** Row pitch and indent for seed columns, on the minor lattice. */
export function seedColumnSpacing({ steps = null, seedHeight }) {
  const minorX = steps?.minorX ?? FALLBACK_STEP;
  const minorY = steps?.minorY ?? FALLBACK_STEP;
  const pad = GROUP_OUTLINE_PAD + GROUP_NEST_PAD;
  return {
    // A nested box is padded on both sides and carries its tab above.
    pitch: ceilTo(seedHeight + 2 * pad + GROUP_TAB_HEIGHT + CLEARANCE, minorY),
    // Enough that a child's padded box starts inside its parent's.
    indent: ceilTo(2 * pad, minorX),
  };
}

/**
 * The rectangle a column of seeds occupies once drawn: boxes padded, the
 * first row's tab above, and clearance all round.
 */
function drawnFootprint(x, y, size) {
  const pad = GROUP_OUTLINE_PAD + GROUP_NEST_PAD;
  return {
    x: x - pad - CLEARANCE,
    y: y - pad - GROUP_TAB_HEIGHT - CLEARANCE,
    width: size.width + 2 * (pad + CLEARANCE),
    height: size.height + 2 * pad + GROUP_TAB_HEIGHT + 2 * CLEARANCE,
  };
}

/**
 * @param {object} params
 * @param {Array} params.creations - this pass's creations:
 *   { groupId, folderPath, parentFolderPath, pieceIds }. Only those without
 *   members get a seed; the others are only consulted as parents.
 * @param {function} params.anchorBoundsFor - (folderPath) => { minX, minY,
 *   maxX, maxY } for a parent folder that already has a box (an existing
 *   group, or a creation with members), else null.
 * @param {{x:number, y:number}} params.origin - where new content spawns
 * @param {Array} [params.obstacles] - drawn rectangles to keep clear of
 *   ({ x, y, width, height }): nodes and existing group boxes
 * @param {object|null} [params.steps] - the workspace grid's steps
 * @param {number} params.seedWidth
 * @param {number} params.seedHeight
 * @returns {Map<string, {x:number, y:number, width:number, height:number}>}
 */
export function layoutEmptyGroupSeeds({
  creations,
  anchorBoundsFor,
  origin,
  obstacles = [],
  steps = null,
  seedWidth,
  seedHeight,
}) {
  const seeds = new Map();
  const list = Array.isArray(creations) ? creations : [];
  const isEmpty = (entry) => !entry?.pieceIds?.length;
  const creationByFolder = new Map(list.map((entry) => [entry.folderPath, entry]));
  const byFolderPath = (a, b) => a.folderPath.localeCompare(b.folderPath);

  // Empty creations nest under empty creations; every other empty creation
  // heads a column.
  const childrenOf = new Map();
  const heads = [];
  for (const entry of list.filter(isEmpty).sort(byFolderPath)) {
    const parent = entry.parentFolderPath ? creationByFolder.get(entry.parentFolderPath) : null;
    if (parent && isEmpty(parent)) {
      if (!childrenOf.has(parent.folderPath)) childrenOf.set(parent.folderPath, []);
      childrenOf.get(parent.folderPath).push(entry);
    } else {
      heads.push(entry);
    }
  }
  if (!heads.length) return seeds;

  const { pitch, indent } = seedColumnSpacing({ steps, seedHeight });
  const columnOf = (head) => {
    const rows = [];
    const walk = (entry, depth) => {
      rows.push({ groupId: entry.groupId, dx: depth * indent, dy: rows.length * pitch });
      for (const child of childrenOf.get(entry.folderPath) ?? []) walk(child, depth + 1);
    };
    walk(head, 0);
    const width = Math.max(...rows.map((row) => row.dx)) + seedWidth;
    const height = rows[rows.length - 1].dy + seedHeight;
    return { rows, size: { width, height } };
  };
  const place = (column, x, y) => {
    for (const row of column.rows) {
      seeds.set(row.groupId, { x: x + row.dx, y: y + row.dy, width: seedWidth, height: seedHeight });
    }
  };

  const minorX = steps?.minorX ?? FALLBACK_STEP;
  const minorY = steps?.minorY ?? FALLBACK_STEP;
  const placed = [];

  // Columns under a parent that already has a box stack below that box.
  const underAnchor = new Map();
  const roots = [];
  for (const head of heads) {
    const bounds = head.parentFolderPath ? anchorBoundsFor?.(head.parentFolderPath) ?? null : null;
    if (bounds) {
      if (!underAnchor.has(head.parentFolderPath)) underAnchor.set(head.parentFolderPath, { bounds, heads: [] });
      underAnchor.get(head.parentFolderPath).heads.push(head);
    } else {
      roots.push(head);
    }
  }
  for (const { bounds, heads: anchoredHeads } of underAnchor.values()) {
    const x = ceilTo(bounds.minX + indent, minorX);
    let y = ceilTo(bounds.maxY + pitch - seedHeight, minorY);
    for (const head of anchoredHeads) {
      const column = columnOf(head);
      place(column, x, y);
      placed.push(drawnFootprint(x, y, column.size));
      y = ceilTo(y + column.size.height + pitch - seedHeight, minorY);
    }
  }

  // Every other column takes the free major intersection nearest the spawn
  // point, in folder order.
  const majorX = steps?.majorX ?? FALLBACK_MAJOR;
  const majorY = steps?.majorY ?? FALLBACK_MAJOR;
  const blocked = (rect) => obstacles.some((other) => rectsOverlap(rect, other))
    || placed.some((other) => rectsOverlap(rect, other));
  let fallbackY = null;
  for (const head of roots) {
    const column = columnOf(head);
    let spot = null;
    for (const candidate of latticeCandidates(origin, majorX, majorY, ROOT_SEARCH_RINGS)) {
      if (!blocked(drawnFootprint(candidate.x, candidate.y, column.size))) {
        spot = candidate;
        break;
      }
    }
    if (!spot) {
      // Nothing free nearby: continue downward from the lowest column placed,
      // so the boxes still never share a spot.
      const lowest = placed.reduce((max, rect) => Math.max(max, rect.y + rect.height), origin.y);
      fallbackY = ceilTo(Math.max(fallbackY ?? lowest, lowest) + GROUP_TAB_HEIGHT + GROUP_OUTLINE_PAD + GROUP_NEST_PAD, majorY);
      spot = { x: ceilTo(origin.x, majorX), y: fallbackY };
    }
    place(column, spot.x, spot.y);
    placed.push(drawnFootprint(spot.x, spot.y, column.size));
  }
  return seeds;
}
