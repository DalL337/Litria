import { PIECE_WIDTH, PIECE_HEIGHT } from '../components/PuzzlePiece';

/**
 * Grid layout engine for folder groups.
 *
 * Positions pieces in a bounded grid when a folder group expands.
 * Default tier is 3×3 (9 file slots). Progressive expansion grows
 * the grid by alternating column/row additions.
 *
 * Layout structure:
 *   ┌──────────────────────────────┐
 *   │  [file] [file] [file]        │  ← file grid (cols × rows)
 *   │  [file] [file] [file]        │
 *   │  [file] [file] [file]        │
 *   │  [📁sub1] [📁sub2]  [<] [>] │  ← subfolder row + chevrons
 *   └──────────────────────────────┘
 */

const GAP_X = 20;     // horizontal gap between nodes
const GAP_Y = 16;     // vertical gap between nodes
const SUBFOLDER_GAP = 20;  // gap between file grid and subfolder row
const PADDING = 24;   // bounding box padding

// Squircle pill dimensions (must match WorkspaceStage)
const PILL_W = PIECE_WIDTH;
const PILL_H = 80;

/**
 * Grid tier definitions.
 * Each tier alternates adding a column then a row to stay roughly square.
 */
const GRID_TIERS = [
  { cols: 3, rows: 3 },  // tier 0: 9
  { cols: 4, rows: 3 },  // tier 1: 12
  { cols: 4, rows: 4 },  // tier 2: 16
  { cols: 5, rows: 4 },  // tier 3: 20
  { cols: 5, rows: 5 },  // tier 4: 25
  { cols: 6, rows: 5 },  // tier 5: 30
  { cols: 6, rows: 6 },  // tier 6: 36
  { cols: 7, rows: 6 },  // tier 7: 42
  { cols: 7, rows: 7 },  // tier 8: 49
  { cols: 8, rows: 7 },  // tier 9: 56
];

/**
 * Get tier definition by index (capped at max tier).
 */
export function getGridTier(tierIndex) {
  const clamped = Math.max(0, Math.min(tierIndex, GRID_TIERS.length - 1));
  return GRID_TIERS[clamped];
}

/**
 * Get the maximum tier index.
 */
export function getMaxTier() {
  return GRID_TIERS.length - 1;
}

/**
 * How many file slots a tier provides.
 */
export function getTierCapacity(tierIndex) {
  const tier = getGridTier(tierIndex);
  return tier.cols * tier.rows;
}

/**
 * Compute grid positions for a freshly-spawned batch of pieces, keyed by
 * batch index (0..count-1). Used at folder-spawn time before SQLite IDs
 * exist. Lays every piece out in a 3-column grid with unlimited rows so
 * nothing stacks at the origin. Callers should pass pieces pre-sorted
 * alphabetically so creation order matches the alphabetical order the
 * group-expand layout uses later.
 */
const SPAWN_COLS = 3;
export function computeSpawnGridPositions(count, originX, originY) {
  const positions = [];
  for (let i = 0; i < count; i++) {
    const col = i % SPAWN_COLS;
    const row = Math.floor(i / SPAWN_COLS);
    positions.push({
      x: originX + col * (PIECE_WIDTH + GAP_X),
      y: originY + row * (PIECE_HEIGHT + GAP_Y)
    });
  }
  return positions;
}

/**
 * Compute grid positions for pieces in a folder group.
 *
 * @param {object} params
 * @param {Array} params.filePieceIds - piece IDs for files (sorted)
 * @param {Array} params.subfolderGroupIds - group IDs for subfolders
 * @param {number} params.tierIndex - current grid tier (0 = 3×3)
 * @param {number} params.originX - top-left X of the group bounding box content area
 * @param {number} params.originY - top-left Y of the group bounding box content area
 * @returns {{ piecePositions: Map, subfolderPositions: Map, bounds: { width, height }, showMore: boolean, showLess: boolean }}
 */
export function computeGridLayout({
  filePieceIds = [],
  subfolderGroupIds = [],
  tierIndex = 0,
  originX = 0,
  originY = 0
}) {
  const tier = getGridTier(tierIndex);
  const { cols, rows } = tier;
  const capacity = cols * rows;
  const visibleFiles = filePieceIds.slice(0, capacity);
  const showMore = filePieceIds.length > capacity;
  const showLess = tierIndex > 0;

  // ── File grid positions ──
  const piecePositions = new Map();
  visibleFiles.forEach((pieceId, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    piecePositions.set(pieceId, {
      x: originX + col * (PIECE_WIDTH + GAP_X),
      y: originY + row * (PIECE_HEIGHT + GAP_Y)
    });
  });

  // ── Grid dimensions ──
  const actualRows = Math.min(rows, Math.ceil(visibleFiles.length / cols));
  const gridWidth = cols * PIECE_WIDTH + (cols - 1) * GAP_X;
  const gridHeight = actualRows * PIECE_HEIGHT + Math.max(0, actualRows - 1) * GAP_Y;

  // ── Subfolder row positions ──
  const subfolderPositions = new Map();
  const hasSubfolderRow = subfolderGroupIds.length > 0 || showMore || showLess;
  const subfolderY = originY + gridHeight + (hasSubfolderRow ? SUBFOLDER_GAP : 0);

  subfolderGroupIds.forEach((groupId, index) => {
    subfolderPositions.set(groupId, {
      x: originX + index * (PILL_W + GAP_X),
      y: subfolderY
    });
  });

  // ── Total bounds ──
  const subfolderRowWidth = subfolderGroupIds.length > 0
    ? subfolderGroupIds.length * PILL_W + Math.max(0, subfolderGroupIds.length - 1) * GAP_X
    : 0;
  const totalWidth = Math.max(gridWidth, subfolderRowWidth);
  const totalHeight = gridHeight + (hasSubfolderRow ? SUBFOLDER_GAP + PILL_H : 0);

  // ── Chevron positions (after subfolder pills) ──
  const chevronX = originX + (subfolderGroupIds.length * (PILL_W + GAP_X));
  const chevronY = subfolderY;

  return {
    piecePositions,
    subfolderPositions,
    bounds: {
      width: totalWidth + PADDING * 2,
      height: totalHeight + PADDING * 2
    },
    gridWidth,
    gridHeight,
    showMore,
    showLess,
    chevronX,
    chevronY,
    capacity
  };
}
