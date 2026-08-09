/**
 * useWireDropOnPill — S4 of brief-cross-group-wires (owner-ratified D3).
 *
 * A wire drag dropped on a collapsed group's pill resolves the target via the
 * `wireDropOnCollapsedGroup` preference (ADR-019 registry):
 *   - 'picker' (default): a modeless list of the group's member files opens at
 *     the drop point; picking one completes the connection exactly like a
 *     normal piece-to-piece draw (persisted sides, syntax edge, symbol picker).
 *   - 'open-group': the group expands so the user can aim at a piece directly.
 *
 * The preference resolves project → global → registry default, reloaded per
 * project open.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { chooseFacingSides } from './connectionAnchoring.js';
import { prefsLoadGlobal, prefsLoadProject } from '../preferences/preferencesStore.js';
import { findEntry, PREF_KEYS } from '../preferences/registry.js';

// Key, default, and legal values all come from the registry entry — declared
// once, no local copy to drift.
const PREF_ENTRY = findEntry(PREF_KEYS.wireDropOnCollapsedGroup);
const PREF_KEY = PREF_ENTRY.key;
const PREF_DEFAULT = PREF_ENTRY.defaultValue;
const PREF_VALUES = PREF_ENTRY.values;

/** Pure: the topmost collapsed group whose pill stub contains the point. */
export function findCollapsedGroupAtPoint(groups, getGroupBounds, x, y) {
  for (const group of groups ?? []) {
    if (!group?.isCollapsed) continue;
    const bounds = getGroupBounds(group);
    if (!bounds) continue;
    if (x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY) {
      return group;
    }
  }
  return null;
}

/** Pure: project → global → default resolution for the drop preference. */
export function resolveWireDropPreference(projectPrefs, globalPrefs) {
  const candidate = projectPrefs?.[PREF_KEY] ?? globalPrefs?.[PREF_KEY];
  return PREF_VALUES.includes(candidate) ? candidate : PREF_DEFAULT;
}

export function useWireDropOnPill({
  groups,
  getGroupBounds,
  piecesById,
  groupDomain,
  connectionDomain,
  syntaxAdapter,
  persistConnectionSides,
  onSyntaxPendingCreated,
  projectRootPath,
  stageRef,
  canvasToScreen,
  showToast,
}) {
  const [dropPreference, setDropPreference] = useState(PREF_DEFAULT);
  // null | { entries: [{ id: pieceId, label }], style, sourceId, sourceSide }
  const [pillDropMenu, setPillDropMenu] = useState(null);

  useEffect(() => {
    let canceled = false;
    (async () => {
      const globalPrefs = await prefsLoadGlobal().catch(() => null);
      const projectPrefs = projectRootPath
        ? await prefsLoadProject(projectRootPath).catch(() => null)
        : null;
      if (!canceled) setDropPreference(resolveWireDropPreference(projectPrefs, globalPrefs));
    })();
    return () => { canceled = true; };
  }, [projectRootPath]);

  const toScreenAnchor = useCallback((canvasX, canvasY) => {
    const stage = stageRef.current;
    let left = canvasX;
    let top = canvasY;
    if (stage) {
      const screenPos = canvasToScreen(canvasX, canvasY);
      const rect = stage.container().getBoundingClientRect();
      left = screenPos.x + rect.left;
      top = screenPos.y + rect.top;
    }
    return { left, top };
  }, [stageRef, canvasToScreen]);

  const basename = (piece) => {
    const normalized = String(piece?.filename ?? '').replace(/\\/g, '/');
    return normalized.split('/').pop() || '?';
  };

  const handleWireDragMiss = useCallback(({ sourceId, sourceSide, canvasX, canvasY }) => {
    const group = findCollapsedGroupAtPoint(groups, getGroupBounds, canvasX, canvasY);
    if (!group) return;

    if (dropPreference === 'open-group') {
      groupDomain.commands.expand(group.id);
      return;
    }

    const entries = (group.pieceIds ?? [])
      .filter((id) => id !== sourceId)
      .map((id) => piecesById.get(id))
      .filter(Boolean)
      .map((piece) => ({ id: piece.id, label: basename(piece) }));
    if (!entries.length) return;
    setPillDropMenu({
      entries,
      style: toScreenAnchor(canvasX, canvasY),
      sourceId,
      sourceSide,
    });
  }, [groups, getGroupBounds, dropPreference, groupDomain, piecesById, toScreenAnchor]);

  const dismissPillDropMenu = useCallback(() => setPillDropMenu(null), []);

  /** Complete the connection to the picked member — mirrors the interaction
   *  controller's normal post-draw block (persist, syntax edge, picker). */
  const handlePickPillDropTarget = useCallback((targetId) => {
    const menu = pillDropMenu;
    setPillDropMenu(null);
    if (!menu) return;
    const sourcePiece = piecesById.get(menu.sourceId);
    const targetPiece = piecesById.get(targetId);
    if (!sourcePiece || !targetPiece) return;

    const geo = chooseFacingSides(sourcePiece, targetPiece);
    const connection = connectionDomain.commands.createConnectionFromDrag({
      sourceId: menu.sourceId,
      sourceSide: menu.sourceSide ?? geo.sourceSide,
      targetId,
      targetSide: geo.targetSide,
    });
    if (!connection) {
      showToast?.('Already connected', { severity: 'info' });
      return;
    }
    persistConnectionSides?.(connection);

    if (syntaxAdapter && projectRootPath && sourcePiece.filename && targetPiece.filename) {
      const root = projectRootPath.replace(/\\/g, '/').replace(/\/$/, '');
      const srcPath = `${root}/${String(sourcePiece.filename).replace(/^\//, '')}`;
      const tgtPath = `${root}/${String(targetPiece.filename).replace(/^\//, '')}`;
      Promise.resolve(syntaxAdapter.handleConnect({
        connectionId: connection.id,
        sourceFilePath: srcPath,
        targetFilePath: tgtPath,
      })).then((connectResult) => {
        if (connectResult?.success && onSyntaxPendingCreated) {
          const midX = ((sourcePiece.x ?? 0) + (targetPiece.x ?? 0)) / 2;
          const midY = ((sourcePiece.y ?? 0) + (targetPiece.y ?? 0)) / 2;
          onSyntaxPendingCreated(connection.id, srcPath, midX, midY, connectResult.edgeId);
        }
      }).catch(() => {});
    }
  }, [pillDropMenu, piecesById, connectionDomain, persistConnectionSides, syntaxAdapter, projectRootPath, onSyntaxPendingCreated, showToast]);

  return {
    handleWireDragMiss,
    pillDropMenu,
    handlePickPillDropTarget,
    dismissPillDropMenu,
  };
}
