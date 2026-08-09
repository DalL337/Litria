import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { dbLoadPreferences, dbSavePreference } from '../project/dbStorage.js';
import { isEditableTarget } from './interactionDomain.js';
import {
  HUD_WIDGETS,
  HUD_PREF_KEY,
  HUD_DEFAULT_POSITION,
  getDefaultVisibleIds,
  toggleVisibleId,
  clampHudPosition,
  parseHudState,
  serializeHudState,
} from './hudState.js';

// Canvas quick-action HUD state (ADR-018 Phase A) — position, visibility set,
// hidden bool, persistence, and the H keybind. Extracted per the app-shell
// convention: App.jsx composes; this hook owns the logic; hudState.js holds
// the pure, node-tested pieces.
//
// Persistence mirrors useThemeActions' `appearance` pattern: one JSON blob in
// the app-level SQLite prefs (dbSavePreference / dbLoadPreferences), restored
// when a project opens, written fire-and-forget on change.
// Canvas-space footprint of a freshly spawned manual group box (matches the
// signed-off prototype's box).
const GROUP_SEED_WIDTH = 340;
const GROUP_SEED_HEIGHT = 230;

export function useCanvasHud({
  projectRootPath,
  viewport,
  deskWidth,
  deskHeight,
  pieceWidth,
  pieceHeight,
  isCreatePieceModalOpen,
  onCommitGroupCreate,
}) {
  const [hudPosition, setHudPosition] = useState(HUD_DEFAULT_POSITION);
  const [hudVisibleIds, setHudVisibleIds] = useState(() => getDefaultVisibleIds());
  const [isHudHidden, setIsHudHidden] = useState(false);
  const hasRestoredRef = useRef(false);

  const stateRef = useRef({ x: hudPosition.x, y: hudPosition.y, visibleIds: hudVisibleIds, hidden: isHudHidden });
  stateRef.current = { x: hudPosition.x, y: hudPosition.y, visibleIds: hudVisibleIds, hidden: isHudHidden };

  const persist = useCallback(() => {
    if (!hasRestoredRef.current) return;
    dbSavePreference(HUD_PREF_KEY, serializeHudState(stateRef.current)).catch(() => {});
  }, []);

  // Restore once per project open (same gate as the theme prefs restore).
  useEffect(() => {
    if (!projectRootPath) return;
    let cancelled = false;
    (async () => {
      try {
        const prefs = await dbLoadPreferences();
        if (cancelled) return;
        const restored = parseHudState(prefs?.[HUD_PREF_KEY]);
        setHudPosition({ x: restored.x, y: restored.y });
        setHudVisibleIds(restored.visibleIds);
        setIsHudHidden(restored.hidden);
      } catch {
        // No prefs available — defaults stand.
      } finally {
        if (!cancelled) hasRestoredRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [projectRootPath]);

  const moveHud = useCallback((position) => {
    setHudPosition(position);
  }, []);

  const commitHudPosition = useCallback((position) => {
    setHudPosition(position);
    stateRef.current = { ...stateRef.current, x: position.x, y: position.y };
    persist();
  }, [persist]);

  const toggleHudWidget = useCallback((id) => {
    setHudVisibleIds((prev) => {
      const next = toggleVisibleId(prev, id);
      stateRef.current = { ...stateRef.current, visibleIds: next };
      persist();
      return next;
    });
  }, [persist]);

  const toggleHudHidden = useCallback(() => {
    setIsHudHidden((prev) => {
      const next = !prev;
      stateRef.current = { ...stateRef.current, hidden: next };
      persist();
      return next;
    });
  }, [persist]);

  /* ── Pan & Zoom (Phase B dial) — thin calls into the viewport transform ── */

  // Camera moves in the given direction; content shifts opposite.
  const panBy = useCallback((dx, dy) => {
    viewport?.setOffsetX((x) => x + dx);
    viewport?.setOffsetY((y) => y + dy);
  }, [viewport?.setOffsetX, viewport?.setOffsetY]);

  // Center-anchored zoom via the same clamped transform the wheel uses
  // (zoomAtPoint treats deltaY sign as direction: negative = in).
  const zoomIn = useCallback(() => {
    viewport?.zoomAtPoint((deskWidth ?? 0) / 2, (deskHeight ?? 0) / 2, -1);
  }, [viewport?.zoomAtPoint, deskWidth, deskHeight]);
  const zoomOut = useCallback(() => {
    viewport?.zoomAtPoint((deskWidth ?? 0) / 2, (deskHeight ?? 0) / 2, 1);
  }, [viewport?.zoomAtPoint, deskWidth, deskHeight]);

  // 1:1 — back to 100% while keeping whatever is centered, centered.
  // (The app's "Reset View" is a fit, and the status-bar zoom is
  // origin-anchored setScale; neither matches the dial's 1:1 intent.)
  const resetZoom = useCallback(() => {
    if (!viewport?.stateRef) return;
    const cx = (deskWidth ?? 0) / 2;
    const cy = (deskHeight ?? 0) / 2;
    const { scale: s, offsetX: ox, offsetY: oy } = viewport.stateRef.current;
    if (s === 1) return;
    const canvasX = (cx - ox) / s;
    const canvasY = (cy - oy) / s;
    viewport.setScale(1);
    viewport.setOffsetX(cx - canvasX);
    viewport.setOffsetY(cy - canvasY);
  }, [viewport, deskWidth, deskHeight]);

  // Keybinds: bare H (no modifiers) toggles the whole HUD, pill included —
  // the separate axis from the checkbox composition (ADR-018). Arrow keys
  // pan the camera (key auto-repeat gives the held-glide). Both follow the
  // interactionDomain `E` precedent: window listener + editable-target
  // guard. Arrows additionally require focus to be on <body> so they never
  // hijack tree/menu keyboard navigation in the drawers.
  useEffect(() => {
    const KEY_PAN = 60;
    const ARROW_PAN = {
      ArrowUp: [0, KEY_PAN],
      ArrowDown: [0, -KEY_PAN],
      ArrowLeft: [KEY_PAN, 0],
      ArrowRight: [-KEY_PAN, 0],
    };
    const onKeyDown = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (isEditableTarget()) return;
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        toggleHudHidden();
        return;
      }
      const pan = ARROW_PAN[e.key];
      if (pan) {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        e.preventDefault();
        panBy(pan[0], pan[1]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleHudHidden, panBy]);

  // Spawn ghost: while the create-piece modal is open, the HUD shows a
  // dashed placeholder where the node will land. computeSpawnPosition
  // anchors at the viewport center, so in canvas-area screen space the
  // ghost is simply centered — no transform math needed. The spiral
  // fallback can nudge the real spawn if the center is occupied; the
  // ghost is the intent, not a promise.
  const scale = viewport?.scale ?? 1;
  const spawnGhost = useMemo(() => {
    if (!isCreatePieceModalOpen) return null;
    const w = (pieceWidth ?? 0) * scale;
    const h = (pieceHeight ?? 0) * scale;
    return {
      left: (deskWidth ?? 0) / 2 - w / 2,
      top: (deskHeight ?? 0) / 2 - h / 2,
      width: w,
      height: h,
    };
  }, [isCreatePieceModalOpen, deskWidth, deskHeight, pieceWidth, pieceHeight, scale]);

  /* ── Name-first New Group (brief-group-physicality W2, DP3) ──
     The + Group pill drops a PREVIEW box at the viewport center with an
     inline name input; NOTHING exists until Enter commits a non-blank name,
     at which point the folder is created on disk and the group derives from
     it (onCommitGroupCreate — DP1 resolves parentage from the box center).
     Escape or a blank Enter discards the preview — there is nothing to
     delete, because nothing was created. No ghost operations. */
  const [pendingGroupName, setPendingGroupName] = useState(null); // { seedBounds }

  const startGroupCreate = useCallback(() => {
    if (typeof onCommitGroupCreate !== 'function' || !viewport) return;
    const b = viewport.getVisibleBounds();
    const seedBounds = {
      x: b.x + b.width / 2 - GROUP_SEED_WIDTH / 2,
      y: b.y + b.height / 2 - GROUP_SEED_HEIGHT / 2,
      width: GROUP_SEED_WIDTH,
      height: GROUP_SEED_HEIGHT,
    };
    setPendingGroupName({ seedBounds });
  }, [onCommitGroupCreate, viewport]);

  const commitGroupName = useCallback(async (value) => {
    const pending = pendingGroupName;
    if (!pending) return;
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) {
      // Blank commit = discard: name-first means no auto-named folder litter.
      setPendingGroupName(null);
      return;
    }
    const ok = await onCommitGroupCreate(name, pending.seedBounds);
    // Refusals (reserved name, collision, disk failure) keep the input open —
    // the handler toasts the reason.
    if (ok !== false) setPendingGroupName(null);
  }, [onCommitGroupCreate, pendingGroupName]);

  const cancelGroupName = useCallback(() => {
    setPendingGroupName(null); // preview only — nothing exists yet
  }, []);

  // Screen-space anchor for the inline name input + the preview rect, pinned
  // to the box's top-left (GroupMenuOverlay precedent: canvasToScreen +
  // absolute div). The rect is screen-space too: the group is not real yet,
  // so nothing renders on the Konva stage.
  const groupNameOverlay = useMemo(() => {
    if (!pendingGroupName || !viewport) return null;
    const p = viewport.canvasToScreen(pendingGroupName.seedBounds.x, pendingGroupName.seedBounds.y);
    const previewScale = viewport.scale ?? 1;
    return {
      left: p.x + 10,
      top: p.y + 8,
      name: '',
      box: {
        left: p.x,
        top: p.y,
        width: pendingGroupName.seedBounds.width * previewScale,
        height: pendingGroupName.seedBounds.height * previewScale,
      },
    };
  }, [pendingGroupName, viewport]);

  const clampPosition = useCallback((position, hudSize) => clampHudPosition(position, {
    hudWidth: hudSize?.width ?? 0,
    hudHeight: hudSize?.height ?? 0,
    containerWidth: deskWidth ?? 0,
    containerHeight: deskHeight ?? 0,
  }), [deskWidth, deskHeight]);

  // Re-clamp when the canvas area resizes so the pill is never stranded.
  useEffect(() => {
    setHudPosition((prev) => clampHudPosition(prev, {
      hudWidth: 0,
      hudHeight: 0,
      containerWidth: deskWidth ?? 0,
      containerHeight: deskHeight ?? 0,
    }));
  }, [deskWidth, deskHeight]);

  return {
    widgets: HUD_WIDGETS,
    hudPosition,
    hudVisibleIds,
    isHudHidden,
    moveHud,
    commitHudPosition,
    toggleHudWidget,
    toggleHudHidden,
    clampPosition,
    spawnGhost,
    panBy,
    zoomIn,
    zoomOut,
    resetZoom,
    viewportScale: scale,
    startGroupCreate,
    commitGroupName,
    cancelGroupName,
    groupNameOverlay,
  };
}
