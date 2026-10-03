/**
 * useDiscoveryLifecycle.js — React hook to discover edges from existing code.
 *
 * Runs once after project load completes and canvas pieces are populated.
 * For each discovered edge (import relationship between two files on canvas),
 * creates a canvas connection + syntax edge with pre-resolved symbols.
 *
 * Only discovers edges between files that have a corresponding piece on canvas.
 * Files not on canvas are silently skipped.
 *
 * Usage:
 *   useDiscoveryLifecycle({
 *     projectRoot, syntaxDomain, syntaxAdapter,
 *     connectionDomain, piecesById, enabled,
 *   });
 */

import { useEffect, useRef } from 'react';
import { discoverProjectEdges } from './discoveryEngine.js';
import { listProjectTree, readProjectFileWithRevision } from '../project/storage.js';
import { chooseFacingSides } from './connectionAnchoring.js';

/** File extensions to include in discovery: JS/TS family + Python (ADR-020
 *  follow-up — wiring parity). `.pyi` stubs are deliberately excluded: their
 *  imports describe types, not runtime structure. */
const DISCOVERY_EXTENSIONS = /\.(js|jsx|ts|tsx|mjs|py)$/;

/**
 * Decide what discovery should do this render — pure so the (subtle) run-once
 * orchestration is unit-testable without React.
 *
 * Discovery must run exactly once per PROJECT LOAD (keyed on `loadToken`, a
 * fresh object per `dbOpenProject` — so reopening the same project re-runs it),
 * and must NOT run against the previous project's pieces. On a project switch
 * the new load token arrives one render before the new project's pieces hydrate
 * (`piecesById` is memoized on `pieces`, App.jsx), so we "arm" on the token
 * change and only "run" once `piecesById` has swapped to a new, non-empty map.
 *
 * @param {{
 *   ranForToken: any, armedToken: any, armedPieces: Map|null,
 *   loadToken: any, piecesById: Map|null,
 * }} state
 * @returns {{ action: 'skip'|'arm'|'run' }}
 */
export function decideDiscoveryStep({ ranForToken, armedToken, armedPieces, loadToken, piecesById }) {
  if (ranForToken === loadToken) return { action: 'skip' };      // already ran for this load
  if (armedToken !== loadToken) return { action: 'arm' };        // new load — arm, wait for pieces
  if (!piecesById || piecesById.size === 0) return { action: 'skip' };
  if (piecesById === armedPieces) return { action: 'skip' };     // pieces haven't swapped yet
  return { action: 'run' };
}

/**
 * @param {object} params
 * @param {string|null} params.projectRoot         - Absolute path to project root.
 * @param {any} params.loadToken                   - Per-open identity (projectInstance._dbState);
 *                                                    changes on every open so discovery re-runs.
 * @param {object} params.syntaxDomain             - SyntaxDomain instance.
 * @param {object} params.syntaxAdapter            - SyntaxAdapter instance.
 * @param {object} params.connectionDomain         - ConnectionDomain instance.
 * @param {Map} params.piecesById                  - Map<id, piece> of canvas pieces.
 * @param {Map} [params.persistedSides]            - Per-pair anchor-side override
 *   (`${fromPieceId}-${toPieceId}` → { sourceSide, targetSide }); geometry fallback when absent.
 * @param {boolean} params.enabled                 - Gate flag (false skips discovery).
 */
/**
 * Should a save event (dirty set shrank) schedule a discovery refresh?
 * Pure so the S5 trigger rule is unit-testable: only after the initial
 * per-load run, and only when something actually left the dirty set.
 */
export function shouldRefreshOnDirtyShrink({ initialRunDone, prevDirty, nextDirty }) {
  if (!initialRunDone) return false;
  if (!prevDirty || !nextDirty) return false;
  return nextDirty.size < prevDirty.size;
}

/** Debounce for incremental discovery re-runs (S5) — long enough to batch a
 *  save burst, short enough that a wire appears "on save". */
export const DISCOVERY_REFRESH_DEBOUNCE_MS = 800;

export function useDiscoveryLifecycle({
  projectRoot,
  loadToken,
  syntaxDomain,
  syntaxAdapter,
  connectionDomain,
  piecesById,
  persistedSides = null,
  onPendingEdges = null,
  // S5 (brief-cross-group-wires): incremental refresh triggers. A discovery
  // re-run is idempotent by construction (pair-keyed connection dedup,
  // edge reuse in connectDiscovered, no-op resolve merges), so re-running on
  // save / scaffold changes never duplicates wires or churns files.
  scaffoldRefreshToken = null,
  dirtyPieceIds = null,
  enabled = true,
}) {
  const ranForTokenRef = useRef(null);
  const armedTokenRef = useRef(null);
  // Discovery-in-flight signal for the owner bridge (brief §("Bridge inputs"),
  // P4c): true while an initial run or a refresh is reading files, or while
  // armed for the current load but not yet started. The graph reports
  // `partial` with a "discovery run pending" reason while it is true. A ref,
  // not state: the bridge polls it when it answers; no re-render is needed.
  const initialRunInFlightRef = useRef(false);
  // The load token the in-flight initial run belongs to. A stale project's run
  // finishing must not clear the CURRENT project's signal (first review 10,
  // P4c task 16): the `.finally` clears only when the finishing run is current.
  const initialRunTokenRef = useRef(null);
  const armedPiecesRef = useRef(null);
  const latestArgsRef = useRef(null);
  const refreshTimerRef = useRef(null);
  const refreshInFlightRef = useRef(false);
  // A refresh is scheduled (timer armed) but has not started reading yet
  // (first review 9, P4c task 16): the signal must already read in-flight.
  const refreshArmedRef = useRef(false);
  const refreshTokenRef = useRef(null);
  const prevDirtyRef = useRef(null);
  const prevScaffoldTokenRef = useRef(scaffoldRefreshToken);
  // The project load discovery may act for. A run is tied to the load it
  // started under and stops at its next step once that load is no longer
  // current: a run still reading when the user switched projects used to
  // finish against the NEW project's domains with the OLD project's file and
  // piece lookups, and piece ids repeat across projects (P4, 2026-10-01).
  const currentLoadRef = useRef(loadToken);
  currentLoadRef.current = enabled ? loadToken : null;
  useEffect(() => () => { currentLoadRef.current = null; }, []);
  const stillCurrent = (token) => () => token != null && currentLoadRef.current === token;

  // Discovery refreshes read CURRENT args (pieces placed since load matter).
  latestArgsRef.current = {
    projectRoot,
    syntaxDomain,
    syntaxAdapter,
    connectionDomain,
    piecesById,
    persistedSides,
    onPendingEdges,
  };

  const scheduleRefresh = () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    // Armed from the moment the timer is set: a refresh is "in flight" while it
    // waits, so the graph reports `partial` for it (first review 9, P4c task 16).
    refreshArmedRef.current = true;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      refreshArmedRef.current = false;
      if (refreshInFlightRef.current) return;
      const args = latestArgsRef.current;
      if (!args?.projectRoot) return;
      const runToken = currentLoadRef.current;
      refreshInFlightRef.current = true;
      refreshTokenRef.current = runToken;
      _runDiscovery({ ...args, isCurrent: stillCurrent(runToken) })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[discovery] Error during incremental refresh:', err);
        })
        .finally(() => {
          // Clear only if this finishing run is still the current one, so a
          // stale project's refresh cannot clear the live signal (task 16).
          if (refreshTokenRef.current === runToken) refreshInFlightRef.current = false;
        });
    }, DISCOVERY_REFRESH_DEBOUNCE_MS);
  };

  // Trigger 1: a save landed (dirty set shrank) — a typed import may now be
  // on disk.
  useEffect(() => {
    const prevDirty = prevDirtyRef.current;
    prevDirtyRef.current = dirtyPieceIds;
    if (!enabled) return;
    if (shouldRefreshOnDirtyShrink({
      initialRunDone: ranForTokenRef.current === loadToken && loadToken != null,
      prevDirty,
      nextDirty: dirtyPieceIds,
    })) {
      scheduleRefresh();
    }
  }, [dirtyPieceIds, enabled, loadToken]);

  // Trigger 2: the scaffold changed (files created/deleted/moved).
  useEffect(() => {
    const prevToken = prevScaffoldTokenRef.current;
    prevScaffoldTokenRef.current = scaffoldRefreshToken;
    if (!enabled) return;
    if (ranForTokenRef.current !== loadToken || loadToken == null) return;
    if (prevToken === scaffoldRefreshToken) return;
    scheduleRefresh();
  }, [scaffoldRefreshToken, enabled, loadToken]);

  // Cancel a pending refresh on unmount / project switch.
  useEffect(() => () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshArmedRef.current = false;
  }, [loadToken]);

  useEffect(() => {
    if (!enabled || !projectRoot || !loadToken || !syntaxDomain || !syntaxAdapter || !connectionDomain) return;

    const { action } = decideDiscoveryStep({
      ranForToken: ranForTokenRef.current,
      armedToken: armedTokenRef.current,
      armedPieces: armedPiecesRef.current,
      loadToken,
      piecesById,
    });

    if (action === 'arm') {
      armedTokenRef.current = loadToken;
      armedPiecesRef.current = piecesById;
      return;
    }
    if (action !== 'run') return;

    ranForTokenRef.current = loadToken;
    initialRunInFlightRef.current = true;
    initialRunTokenRef.current = loadToken;
    _runDiscovery({
      projectRoot,
      syntaxDomain,
      syntaxAdapter,
      connectionDomain,
      piecesById,
      persistedSides,
      onPendingEdges,
      isCurrent: stillCurrent(loadToken),
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[discovery] Error during import discovery:', err);
    }).finally(() => {
      // Clear only if this finishing run is still the current one, so a stale
      // project's run cannot clear the live signal (first review 10, task 16).
      if (initialRunTokenRef.current === loadToken) initialRunInFlightRef.current = false;
    });
  }, [enabled, projectRoot, loadToken, syntaxDomain, syntaxAdapter, connectionDomain, piecesById, persistedSides]);

  // Whether discovery is reading or armed but not yet started (brief §("Bridge
  // inputs"), P4c). Read-only; the owner bridge polls it when it answers
  // `workspace.graph`.
  const isDiscoveryInFlight = () =>
    initialRunInFlightRef.current
    || refreshInFlightRef.current
    || refreshArmedRef.current
    || (loadToken != null && armedTokenRef.current === loadToken && ranForTokenRef.current !== loadToken);

  return { isDiscoveryInFlight };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Build a map of normalized file path → piece for quick lookup.
 * Exported for the off-canvas badge flow (brief-cross-group-wires S3), which
 * needs the same abs-path→piece resolution when wiring a just-placed piece.
 * @param {Map} piecesById
 * @param {string} projectRoot
 * @returns {Map<string, object>} normalizedPath → piece
 */
export function buildPathToPiece(piecesById, projectRoot) {
  const map = new Map();
  const root = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');

  for (const piece of piecesById.values()) {
    if (!piece.filename) continue;
    const normalized = piece.filename.replace(/\\/g, '/');
    // Pieces may store relative or absolute paths — normalize to absolute
    const absPath = normalized.startsWith('/')
      ? normalized
      : `${root}/${normalized}`;
    map.set(absPath, piece);
  }
  return map;
}

/**
 * Map a `list_project_tree` result to absolute, forward-slashed discoverable
 * file paths (JS/TS + Python).
 *
 * `list_project_tree` returns ProjectTreeEntry objects ({ path, entryType, depth }),
 * NOT bare path strings — so we pull `.path` off each (tolerating a plain string
 * too, for robustness/tests). The extension regex naturally drops directory
 * entries. Passing the raw entries to the regex would stringify each object to
 * "[object Object]", match nothing, and silently discover zero files.
 *
 * @param {Array<string | { path?: string }>} tree
 * @param {string} root  - Normalized project root (forward slashes, no trailing slash).
 * @returns {string[]} absolute file paths
 */
export function toDiscoverableAbsPaths(tree, root) {
  if (!Array.isArray(tree)) return [];
  return tree
    .map((entry) => (typeof entry === 'string' ? entry : entry?.path))
    .filter((relPath) => typeof relPath === 'string' && DISCOVERY_EXTENSIONS.test(relPath))
    .map((relPath) => `${root}/${relPath.replace(/\\/g, '/')}`);
}

/** @deprecated Renamed — kept as an alias for existing callers/tests. */
export const toJsTsAbsPaths = toDiscoverableAbsPaths;

/**
 * Whether discovery reads a file of this kind for import relationships. The
 * Project API's capability matrix reads this
 * (`src/app/languageCapabilities.js`), so the extension set keeps one owner.
 */
export function isDiscoverableFilename(filename) {
  return typeof filename === 'string' && DISCOVERY_EXTENSIONS.test(filename);
}

/**
 * Forget the files a previous discovery run registered that the project
 * listing no longer has (deleted from a terminal, a checkout, another editor).
 * Discovery used to register and never unregister, so a vanished file stayed
 * indexed as `ok` and its wires resolved (P4, 2026-10-01). Only discovery's
 * own registrations under this root are judged: a file the editor holds open
 * is left to the editor, and a file discovery never listed (an opened
 * dependency under node_modules) is not discovery's to forget. The file's
 * piece and wires, if any, stay on the canvas, so their links are kept.
 *
 * @param {{ syntaxDomain: object, root: string, previous: Set<string>,
 *   listed: Iterable<string>, isHeldOpen?: (path: string) => boolean }} args
 * @returns {string[]} the forgotten absolute paths
 */
export function forgetVanishedFiles({ syntaxDomain, root, previous, listed, isHeldOpen = () => false }) {
  if (!syntaxDomain?.commands?.forgetFile || !previous || previous.size === 0) return [];
  const base = String(root ?? '').replace(/\\/g, '/').replace(/\/$/, '');
  if (!base) return [];
  const present = new Set(listed);
  const forgotten = [];
  for (const path of [...previous].sort()) {
    if (!path.startsWith(`${base}/`) || present.has(path) || isHeldOpen(path)) continue;
    syntaxDomain.commands.forgetFile(path, { connectionsRemoved: false });
    forgotten.push(path);
  }
  return forgotten;
}

// The files each SyntaxDomain was given by discovery's last run, so the next
// run can tell which of them vanished.
const discoveryRegistrations = new WeakMap();

/**
 * Run the discovery flow asynchronously.
 *
 * `isCurrent` says whether the project load this run started under is still
 * the current one. The run checks it after every wait and before it touches
 * any shared domain, and stops once its load is gone: a run that finished
 * after a project switch drew the old project's wires between the new
 * project's same-id pieces, pruned the new project's wires, registered the
 * old project's files and replaced its off-canvas badges (P4, 2026-10-01).
 * Between two checks the run makes no `await`, so nothing it does lands in
 * a project it did not start under.
 */
async function _runDiscovery({ projectRoot, syntaxDomain, syntaxAdapter, connectionDomain, piecesById, persistedSides, onPendingEdges = null, isCurrent = () => true }) {
  // 1. List all project files
  const tree = await listProjectTree(projectRoot);
  if (!isCurrent()) return;
  if (!tree || !Array.isArray(tree)) return;

  const root = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');

  // 2. Filter to discoverable files (absolute, forward-slashed).
  const discoverableFiles = toDiscoverableAbsPaths(tree, root);

  // 2b. Forget what the last run registered and the listing no longer has —
  // before the empty-project return, so deleting the last file counts too.
  forgetVanishedFiles({
    syntaxDomain,
    root,
    previous: discoveryRegistrations.get(syntaxDomain) ?? new Set(),
    listed: discoverableFiles,
    isHeldOpen: (path) => Boolean(syntaxAdapter?.getModelRegistry?.()?.has(path)),
  });
  discoveryRegistrations.set(syntaxDomain, new Set(discoverableFiles));

  if (discoverableFiles.length === 0) return;

  // 3. Build path→piece lookup
  const pathToPiece = buildPathToPiece(piecesById, projectRoot);

  // 4. Read files, then register them with syntaxDomain — all at once, after
  // the last read, so a run stopped mid-read registers nothing.
  // Discovery reads disk, so it registers with the disk revision Rust mints
  // for the bytes read (brief §4.5/§7.4): the graph can then tell whether the
  // text the index parsed is still the file's effective text. A read that
  // cannot carry a revision registers none (reads `unknown`, never a wrong
  // `current`).
  const fileContents = new Map();
  for (const absPath of discoverableFiles) {
    const relPath = absPath.slice(root.length + 1);
    const read = await readProjectFileWithRevision(projectRoot, relPath);
    if (!isCurrent()) return;
    if (read && read.text != null) {
      const parsedRevision = typeof read.revision === 'string'
        ? { source: 'disk', revision: read.revision }
        : undefined;
      fileContents.set(absPath, { text: read.text, parsedRevision });
    }
  }
  for (const [absPath, { text, parsedRevision }] of fileContents) {
    syntaxDomain.commands.registerFile(absPath, text, parsedRevision);
  }

  // 5. Discover edges
  const { edges } = discoverProjectEdges({
    projectRoot,
    filePaths: [...fileContents.keys()],
    readFile: (path) => fileContents.get(path)?.text ?? null,
  });

  // 6. Create canvas connections + syntax edges for discovered edges
  const { pendingEdges } = await createConnectionsForEdges({
    edges,
    pathToPiece,
    syntaxDomain,
    connectionDomain,
    persistedSides,
  });

  // 7. PRUNE stale wires — import-backed connections whose backing import is
  // gone from the scanned code (imports authoritative: delete the import,
  // save, and the wire follows). Manual pending wires are never touched.
  const discoveredPairKeys = new Set();
  for (const edge of edges) {
    const sourcePiece = pathToPiece.get(edge.sourceFilePath);
    const targetPiece = pathToPiece.get(edge.targetFilePath);
    if (sourcePiece && targetPiece) discoveredPairKeys.add(`${sourcePiece.id}-${targetPiece.id}`);
  }
  const scannedPieceIds = new Set();
  for (const absPath of fileContents.keys()) {
    const piece = pathToPiece.get(absPath);
    if (piece) scannedPieceIds.add(piece.id);
  }
  const staleConnectionIds = computeStaleDiscoveredConnections({
    connections: connectionDomain.selectors.getAllConnections(),
    discoveredPairKeys,
    scannedPieceIds,
    getEdgeForConnectionId: (connId) => {
      const edgeId = syntaxDomain.selectors.getEdgeIdForConnection(connId);
      return edgeId ? syntaxDomain.selectors.getSyntaxEdge(edgeId) : null;
    },
  });
  for (const connId of staleConnectionIds) {
    if (!isCurrent()) return;
    connectionDomain.commands.removeConnectionById(connId);
    await Promise.resolve(syntaxAdapter.handleDisconnect({ connectionId: connId })).catch(() => {});
  }

  // 8. Surface off-canvas edges to the badge flow (S3). Full-replace
  // semantics: each discovery run re-derives the pending set.
  if (!isCurrent()) return;
  onPendingEdges?.(pendingEdges);
}

/**
 * Create one anchored, id-linked canvas connection + syntax edge per discovered
 * edge whose endpoints are both on canvas. Extracted from _runDiscovery so the
 * connection/edge linkage is unit-testable without the file-IO surface.
 *
 * Two correctness points (see brief-discovery-canvas-sync.md, Phase 1A):
 *  - Anchoring: sides come from relative piece geometry (nearest facing edges)
 *    instead of being left undefined, so discovered wires don't all launch the
 *    same direction.
 *  - One identity: we reuse the id `createConnectionFromDrag` mints for the
 *    syntax edge (`connectDiscovered`), so the visual connection and its syntax
 *    edge share one id — exactly as the manual-draw path already does. This
 *    replaces the old `discovery-N` id, which the visual layer ignored (it
 *    minted its own `conn_N`), leaving the two layers unlinked.
 *
 * Writes nothing: the syntax edge and its symbols are metadata
 * (`connectDiscovered`, `resolveSymbolsMetadata`). Both discovery entry points
 * (project load and placing an off-canvas file) come through here.
 *
 * Anchor sides come from the PERSISTED per-pair override (`persistedSides`, the
 * user's chosen edges from a prior manual draw) when present, else from relative
 * piece geometry (`chooseFacingSides`). This keeps discovery the sole creator of
 * visual connections (imports-authoritative) while honoring hand-picked edges
 * across a reopen — see project_discovery_canvas_sync (Phase 1B).
 *
 * @param {{
 *   edges: Array<{ sourceFilePath: string, targetFilePath: string, moduleSpecifier?: string,
 *                  importLine?: number, symbols: Array<{ name: string }> }>,
 *   pathToPiece: Map<string, { id: number, x: number, y: number }>,
 *   syntaxDomain: object,
 *   connectionDomain: object,
 *   persistedSides?: Map<string, { sourceSide: string|null, targetSide: string|null }>,
 * }} params
 */
export async function createConnectionsForEdges({
  edges,
  pathToPiece,
  syntaxDomain,
  connectionDomain,
  persistedSides = null,
}) {
  // Edges whose endpoint(s) have no canvas piece are RETAINED, not dropped
  // (brief-cross-group-wires S3): the off-canvas badge derives from them,
  // and placing the missing piece wires them through this same function.
  const pendingEdges = [];
  for (const edge of edges) {
    const sourcePiece = pathToPiece.get(edge.sourceFilePath);
    const targetPiece = pathToPiece.get(edge.targetFilePath);

    // Both files must be on canvas to draw a wire now
    if (!sourcePiece || !targetPiece) {
      pendingEdges.push(edge);
      continue;
    }

    // Anchor from the persisted per-pair override (user's chosen edges), falling
    // back to geometry per missing side. Reuse the minted id for the syntax edge.
    const geo = chooseFacingSides(sourcePiece, targetPiece);
    const override = persistedSides?.get?.(`${sourcePiece.id}-${targetPiece.id}`) ?? null;
    const sourceSide = override?.sourceSide ?? geo.sourceSide;
    const targetSide = override?.targetSide ?? geo.targetSide;
    const connection = connectionDomain.commands.createConnectionFromDrag?.({
      sourceId: sourcePiece.id,
      sourceSide,
      targetId: targetPiece.id,
      targetSide,
    });
    // null = direction-dedup or invalid (e.g. self-connection) — skip, and do
    // NOT create a dangling syntax edge for a connection that doesn't exist.
    if (!connection) continue;

    // Create the syntax edge, keyed to the same connection id so the two
    // layers are linked. METADATA ONLY: this used to be the write-capable
    // `handleConnect`, which wrote a TODO stub into any file whose import it
    // failed to find (a directory import, an import deleted in an unsaved
    // buffer). Discovery holds no write-capable handle at all now.
    const connectResult = syntaxDomain.commands.connectDiscovered({
      connectionId: connection.id,
      sourceFilePath: edge.sourceFilePath,
      targetFilePath: edge.targetFilePath,
      moduleSpecifier: edge.moduleSpecifier,
      importLine: edge.importLine,
    });

    if (!connectResult?.edgeId) continue;

    // Pre-resolve symbols from the discovered import. Imported names with no
    // matching definition register as BROKEN so a dead import is red from
    // the first load (not stuck pending).
    const symbolIds = [];
    const brokenNames = [];
    const defs = syntaxDomain.selectors.getDefinitionsForFile(edge.sourceFilePath);
    for (const sym of edge.symbols) {
      const match = defs.find((d) => d.name === sym.name);
      if (match) symbolIds.push(match.symbolId);
      else brokenNames.push(sym.name);
    }

    if (symbolIds.length > 0 || brokenNames.length > 0) {
      // METADATA ONLY — discovery mirrors code into wires and must never
      // write code back (the write-capable resolve re-inserted an import the
      // user had just deleted in an open editor; owner-found 2026-07-18).
      syntaxDomain.commands.resolveSymbolsMetadata({
        edgeId: connectResult.edgeId,
        symbolIds,
        brokenNames,
      });
    }
  }
  return { pendingEdges };
}

/**
 * Which existing connections are STALE — import-backed wires whose backing
 * import no longer exists in the scanned code. Pure; exported for tests.
 *
 * Keep rules (never prune):
 *  - the pair was discovered this run (import still present);
 *  - either endpoint's file wasn't scanned this run (don't judge blind);
 *  - the connection has no syntax edge, or an edge with ZERO symbols — a
 *    manually-drawn pending wire is not import-backed by design.
 *
 * @returns {string[]} connection ids to remove
 */
export function computeStaleDiscoveredConnections({
  connections,
  discoveredPairKeys,
  scannedPieceIds,
  getEdgeForConnectionId,
}) {
  const stale = [];
  for (const conn of connections ?? []) {
    if (discoveredPairKeys.has(`${conn.sourceId}-${conn.targetId}`)) continue;
    if (!scannedPieceIds.has(conn.sourceId) || !scannedPieceIds.has(conn.targetId)) continue;
    const edge = getEdgeForConnectionId(conn.id);
    if (!edge || (edge.symbols?.length ?? 0) === 0) continue;
    stale.push(conn.id);
  }
  return stale;
}
