// ---------------------------------------------------------------------------
// preview-canvas.js — Workspace Style Sample renderer.
//
// Two independent previews:
//   drawGroupSample(canvas, state)       — folder group pill + inherited piece
//   drawStandaloneSample(canvas, state)  — one piece, outside any group
//
// Each only responds to its own color decision, so toggling the group color
// doesn't shift the standalone preview and vice versa.
//
// No selection ring, no edge-glow — those are click/hover states, not style.
// ---------------------------------------------------------------------------

(() => {

// Dimensions match the production primitives verbatim.
const PIECE_W = 180, PIECE_H = 110, PIECE_R = 12;
const PILL_W = 180, PILL_H = 80, PILL_R = 14;
const DIVIDER_W = PILL_W * 0.4;
const GROUP_OUTLINE_PAD = 12;

// Each preview canvas — width stays at 240, height trimmed to 228 to help
// the right-column rhythm meet the (now taller) theme cards on the left.
const CANVAS_W = 240;
const CANVAS_H = 228;

// Theme backgrounds — subset of gradients that matter for the preview.
const THEME_GRADIENTS = {
  glass:    { a: 'rgba(99, 102, 241, 0.22)', b: 'rgba(20, 184, 166, 0.12)' },
  obsidian: { a: 'rgba(26, 26, 46, 0.9)',    b: 'rgba(22, 33, 62, 0.9)'    },
  terminal: { a: 'rgba(0, 255, 65, 0.14)',   b: 'rgba(0, 0, 0, 0.9)'       },
  paper:    { a: 'rgba(255, 248, 240, 0.95)', b: 'rgba(255, 236, 210, 0.95)' },
};

const LED_COLORS = {
  empty: 'rgba(180, 180, 190, 0.5)',
  blue:  'rgba(60, 140, 255, 0.95)',
  green: 'rgba(50, 205, 100, 0.9)',
  amber: 'rgba(240, 180, 40, 0.9)',
  red:   'rgba(240, 60, 60, 0.95)',
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function traceRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

// Snell-inspired corner highlights — ported from PuzzlePiece sceneFunc
function drawSnellCorners(ctx, w, h, r, rimW, refractiveIndex = 1.5) {
  const sa = Math.min(1, (refractiveIndex - 1.0) * 0.6 + 0.1);
  if (sa <= 0.02) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = rimW * 0.8;
  ctx.lineCap = 'round';
  ctx.globalAlpha = sa;
  ctx.beginPath(); ctx.arc(w - r, r, r, -Math.PI / 2, 0); ctx.stroke();
  ctx.beginPath(); ctx.arc(r, r, r, Math.PI, -Math.PI / 2); ctx.stroke();
  ctx.globalAlpha = sa * 0.6;
  ctx.beginPath(); ctx.arc(w - r, h - r, r, 0, Math.PI / 2); ctx.stroke();
  ctx.globalAlpha = sa * 0.4;
  ctx.beginPath(); ctx.arc(r, h - r, r, Math.PI / 2, Math.PI); ctx.stroke();
  ctx.restore();
}

// Health LED — radial gradient dot
function drawLed(ctx, cx, cy, radius, health) {
  const color = LED_COLORS[health] ?? LED_COLORS.empty;
  const grad = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.3, 0, cx, cy, radius * 1.8);
  grad.addColorStop(0, color);
  grad.addColorStop(0.5, color.replace(/[\d.]+\)$/, '0.35)'));
  grad.addColorStop(1, 'transparent');
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 1.8, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function drawGroupOutline(ctx, bounds, color) {
  const pad = GROUP_OUTLINE_PAD;
  const x = bounds.minX - pad;
  const y = bounds.minY - pad;
  const w = bounds.maxX - bounds.minX + pad * 2;
  const h = bounds.maxY - bounds.minY + pad * 2;

  const stroke = color ? `${color}40` : 'rgba(92, 107, 192, 0.35)';
  const fill = color ? `${color}0F` : 'rgba(92, 107, 192, 0.06)';

  ctx.save();
  traceRoundRect(ctx, x, y, w, h, 14);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawFolderGroupPill(ctx, x, y, opts) {
  const { name, pieceCount, color, groupHealth = 'empty' } = opts;
  const w = PILL_W, h = PILL_H, r = PILL_R;

  ctx.save();
  ctx.translate(x, y);

  // Shadow
  traceRoundRect(ctx, 0, 0, w, h, r);
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.01)';
  ctx.fill();
  ctx.restore();

  // Tinted fill
  traceRoundRect(ctx, 0, 0, w, h, r);
  if (color) {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, `${color}33`);
    grad.addColorStop(1, `${color}14`);
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = 'rgba(30, 30, 30, 0.75)';
  }
  ctx.fill();

  // Rim
  traceRoundRect(ctx, 0, 0, w, h, r);
  ctx.strokeStyle = color ? `${color}CC` : '#5c6bc0';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  drawSnellCorners(ctx, w, h, r, 1.5);

  // Name
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.font = '500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
  ctx.shadowBlur = 6;
  ctx.fillText(name, w / 2, h * 0.15);
  ctx.restore();

  // Divider
  ctx.save();
  ctx.strokeStyle = color ? `${color}99` : 'rgba(92, 107, 192, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo((w - DIVIDER_W) / 2, h * 0.52);
  ctx.lineTo((w + DIVIDER_W) / 2, h * 0.52);
  ctx.stroke();
  ctx.restore();

  // Count
  ctx.save();
  ctx.fillStyle = color ? color : '#7986cb';
  ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 4;
  const label = pieceCount === 1 ? '1 file' : `${pieceCount} files`;
  ctx.fillText(label, w / 2, h * 0.62);
  ctx.restore();

  drawLed(ctx, w - 13, 13, 5, groupHealth);

  ctx.restore();
}

function drawPuzzlePiece(ctx, x, y, opts) {
  const {
    filename, sublabel = null, edgeColor = null,
    healthState = 'empty',
  } = opts;
  const w = PIECE_W, h = PIECE_H, r = PIECE_R;

  ctx.save();
  ctx.translate(x, y);

  // Shadow
  traceRoundRect(ctx, 0, 0, w, h, r);
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.01)';
  ctx.fill();
  ctx.restore();

  // Glass fill
  traceRoundRect(ctx, 0, 0, w, h, r);
  ctx.save();
  ctx.globalAlpha = 0.32;
  ctx.fillStyle = '#141824';
  ctx.fill();
  ctx.restore();

  // Rim
  traceRoundRect(ctx, 0, 0, w, h, r);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  drawSnellCorners(ctx, w, h, r, 1.5);

  // NOTE: no selection outline. Selection is a click-state, not a style decision.

  // Corner LED — arc-style
  const ledSize = 26;
  ctx.save();
  ctx.translate(w - ledSize - 6, 6);
  const armLen = ledSize;
  const arcR = Math.min(r, armLen);
  const ledColor = LED_COLORS[healthState] ?? LED_COLORS.empty;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(armLen - arcR, 0);
  ctx.arcTo(armLen, 0, armLen, arcR, arcR);
  ctx.lineTo(armLen, armLen);
  ctx.strokeStyle = ledColor;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();

  // Edge-assignment gradient
  if (edgeColor) {
    const inset = 16;
    const edgeH = 2;
    const gradW = w - inset * 2;
    if (gradW > 0) {
      const topGrad = ctx.createLinearGradient(inset, 0, inset + gradW, 0);
      topGrad.addColorStop(0, 'transparent');
      topGrad.addColorStop(0.15, edgeColor);
      topGrad.addColorStop(0.5, edgeColor);
      topGrad.addColorStop(0.85, edgeColor);
      topGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = topGrad;
      ctx.fillRect(inset, 0, gradW, edgeH);
      ctx.fillRect(inset, h - edgeH, gradW, edgeH);
    }
  }

  // Sublabel
  if (sublabel) {
    ctx.save();
    ctx.fillStyle = 'rgba(160, 165, 180, 0.7)';
    ctx.font = '600 9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'black';
    ctx.shadowBlur = 6;
    ctx.fillText(sublabel.toUpperCase(), 14, h - 32);
    ctx.restore();
  }

  // Filename
  ctx.save();
  ctx.fillStyle = '#f3f6ff';
  ctx.font = '500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'black';
  ctx.shadowBlur = 8;
  ctx.fillText(filename, 14, h - 18);
  ctx.restore();

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Backgrounds — scoped per preview so the two samples don't bleed into each
// other. Only the color relevant to that preview tints the background.
// ---------------------------------------------------------------------------

function drawBackgroundBase(ctx, w, h, themeId) {
  ctx.fillStyle = '#0a0b10';
  ctx.fillRect(0, 0, w, h);
  const pal = THEME_GRADIENTS[themeId] ?? THEME_GRADIENTS.glass;
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, pal.a);
  grad.addColorStop(1, pal.b);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

function drawColorWash(ctx, w, h, color, cx, cy) {
  if (!color) return;
  const r = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.55);
  r.addColorStop(0, `${color}26`);
  r.addColorStop(1, 'transparent');
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, w, h);
}

// ---------------------------------------------------------------------------
// Setup helper — DPR scaling + clear
// ---------------------------------------------------------------------------

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = CANVAS_W * dpr;
  canvas.height = CANVAS_H * dpr;
  canvas.style.width = CANVAS_W + 'px';
  canvas.style.height = CANVAS_H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// ---------------------------------------------------------------------------
// Color resolution — each sample is scoped to its own concern.
// ---------------------------------------------------------------------------

function resolveGroupColor(state) {
  // Both remaining modes ('auto' and 'manual') commit to a color.
  return state.groupColor;
}

function resolveStandaloneColor(state) {
  // 'inherit' means borrow from parent group — a standalone piece has none,
  // so it renders theme-neutral. Only 'custom' applies a color here.
  return state.nodeColorMode === 'custom' ? state.nodeColor : null;
}

// ---------------------------------------------------------------------------
// drawGroupSample — folder group pill + one piece inside the outline
// ---------------------------------------------------------------------------

function drawGroupSample(canvas, state) {
  const ctx = setupCanvas(canvas);
  const groupColor = resolveGroupColor(state);

  drawBackgroundBase(ctx, CANVAS_W, CANVAS_H, state.theme);
  drawColorWash(ctx, CANVAS_W, CANVAS_H, groupColor, CANVAS_W * 0.5, CANVAS_H * 0.45);

  // Layout: pill top, piece below, outline wraps both.
  // Tuned for CANVAS_H=228 so the outline pad (12px) doesn't clip top/bottom.
  const PILL_X = 30, PILL_Y = 12;
  const PIECE_X = 30, PIECE_Y = 106;
  const bounds = {
    minX: PILL_X, minY: PILL_Y,
    maxX: PILL_X + PILL_W,
    maxY: PIECE_Y + PIECE_H,
  };

  drawGroupOutline(ctx, bounds, groupColor);

  drawFolderGroupPill(ctx, PILL_X, PILL_Y, {
    name: 'frontend',
    pieceCount: 3,
    color: groupColor,
    groupHealth: 'green',
  });

  // Inherited piece — edge strip inherits group color
  drawPuzzlePiece(ctx, PIECE_X, PIECE_Y, {
    filename: 'App.tsx',
    sublabel: 'frontend',
    edgeColor: groupColor,
    healthState: 'green',
  });
}

// ---------------------------------------------------------------------------
// drawStandaloneSample — one piece, outside any group
// ---------------------------------------------------------------------------

function drawStandaloneSample(canvas, state) {
  const ctx = setupCanvas(canvas);
  const nodeColor = resolveStandaloneColor(state);

  drawBackgroundBase(ctx, CANVAS_W, CANVAS_H, state.theme);
  drawColorWash(ctx, CANVAS_W, CANVAS_H, nodeColor, CANVAS_W * 0.5, CANVAS_H * 0.5);

  // Center the piece
  const PIECE_X = Math.round((CANVAS_W - PIECE_W) / 2);
  const PIECE_Y = Math.round((CANVAS_H - PIECE_H) / 2);

  drawPuzzlePiece(ctx, PIECE_X, PIECE_Y, {
    filename: 'theme.ts',
    sublabel: null,
    edgeColor: nodeColor,
    healthState: 'amber',
  });
}

window.PreviewCanvas = {
  drawGroupSample,
  drawStandaloneSample,
  CANVAS_W,
  CANVAS_H,
};

})();
