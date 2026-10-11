// useProjectApiBridge — wires the Project API owner bridge
// (src/app/projectApiBridge.js) to Tauri, the editor session and the
// workspace owners.
//
// The bridge answers only for a fully hydrated project instance: the ready
// epoch comes from the instance's own load (`_dbState.workspaceEpoch`), and
// only once useProjectPersistence reports that load hydrated
// (`sessionReadyFor`). Owner ports read the latest state through refs, at
// request time.
//
// Debug builds only, like the Rust commands it calls: until the Project API's
// external transport exists (build plan track T), its only consumer is the
// debug-only `project_api_dev_call`. In a release build this hook does nothing.

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEditorSession } from '../editor/EditorSessionContext';
import { getActiveSessionDocument, getSessionDocumentsByPath } from '../editor/editorSessionDomain.js';
import { getWorkspaceEpoch } from '../project/dbStorage.js';
import { buildCapabilityMatrix } from './languageCapabilities.js';
import { isDiscoverableFilename } from './useDiscoveryLifecycle.js';
import {
  BRIDGE_REQUEST_EVENT,
  createProjectApiBridge,
  deriveReadyEpoch,
  graphSnapshot,
  selectionSnapshot,
  serializeAttachments
} from './projectApiBridge.js';

const ENABLED = import.meta.env?.DEV === true;

// One transport per realm, so attach/detach from every bridge instance (a
// StrictMode remount, a hot reload) reach Rust strictly in order.
const transport = serializeAttachments({
  attach: (epoch) => invoke('project_api_bridge_attach', { epoch }),
  detach: (generation) => invoke('project_api_bridge_detach', { generation }),
  reply: (requestId, generation, reply) => invoke('project_api_bridge_reply', { requestId, generation, reply })
});

/**
 * @param {object} owners
 * @param {object|null} owners.projectInstance
 * @param {object|null} owners.sessionReadyFor  useProjectPersistence's hydration signal
 * @param {Array} owners.selectedIds  SelectionDomain's selected piece ids
 * @param {Map} owners.piecesById  PieceDomain's pieces, to map ids to paths
 * @param {*} owners.selectedGroupId  the selected group pill
 * @param {Array} owners.groups  GroupDomain's groups (folder groups carry `folderPath`)
 * @param {object} owners.languageSupportDomain  for language-server state
 * @param {{current: {syntaxDomain?: object, getPendingEdges?: ()=>Array, isDiscoveryInFlight?: ()=>boolean, isDiscoveryAwaitingCanvasPieces?: ()=>boolean}}} [owners.graphOwnersRef]
 *   The graph owners (SyntaxDomain, the off-canvas pending-edge set, the
 *   discovery-in-flight signal). A ref because they are created after this hook
 *   in App.jsx; the port reads `.current` at request time.
 * @param {{current: {fsManager?: object, createPieceFromFile?: (path: string) => Promise<object|null>}}} [owners.fileOwnersRef]
 *   The filesystem write manager and the canvas's createPieceFromFile, for an
 *   agent's new files (`files.create`, build plan W3b). A ref for the same
 *   reason.
 */
export function useProjectApiBridge({
  projectInstance,
  sessionReadyFor,
  selectedIds,
  piecesById,
  selectedGroupId,
  groups,
  languageSupportDomain,
  graphOwnersRef,
  fileOwnersRef
}) {
  const { tabsById, openTabIds, activeTabId, checkBufferEdit, applyBufferEdit } = useEditorSession();
  const fallbackGraphRef = useRef({});
  const fallbackFilesRef = useRef({});
  const ownersRef = useRef(null);
  ownersRef.current = {
    session: { tabsById, openTabIds },
    checkBufferEdit,
    applyBufferEdit,
    activeTabId,
    workspace: { selectedIds, piecesById, selectedGroupId, groups },
    languageSupportDomain,
    graph: graphOwnersRef ?? fallbackGraphRef,
    files: fileOwnersRef ?? fallbackFilesRef
  };
  const bridgeRef = useRef(null);

  useEffect(() => {
    if (!ENABLED) return undefined;
    const bridge = createProjectApiBridge({
      ports: {
        sessionDocuments: () => getSessionDocumentsByPath(ownersRef.current.session),
        selection: () => {
          const { session, activeTabId: active, workspace } = ownersRef.current;
          return selectionSnapshot(workspace, getActiveSessionDocument(session, active));
        },
        languageCapabilities: () => buildCapabilityMatrix(ownersRef.current.languageSupportDomain),
        // Proposed changes, checked against the session's latest text (W2a).
        checkBufferEdit: (request) => ownersRef.current.checkBufferEdit(request),
        // An approved plan, applied through W1's compare-and-apply (W2b).
        applyBufferEdit: (request) => ownersRef.current.applyBufferEdit(request),
        // An approved plan's new files (W3b), taken once per request so the
        // whole batch goes to that request's project: the manager's
        // create-if-absent, the session's names, the canvas.
        fileOwners: () => {
          const { files, session } = ownersRef.current;
          const { fsManager, createPieceFromFile } = files.current ?? {};
          const held = getSessionDocumentsByPath(session);
          return {
            createFile: fsManager ? (path, text) => fsManager.createFile(path, text) : null,
            holds: (path) => held.has(path),
            showOnCanvas: createPieceFromFile ? (path) => createPieceFromFile(path) : null
          };
        },
        graph: () => {
          const { workspace, graph } = ownersRef.current;
          const owners = graph.current ?? {};
          const syntax = owners.syntaxDomain?.selectors ?? null;
          return graphSnapshot({
            piecesById: workspace.piecesById,
            groups: workspace.groups,
            edgeProvenance: syntax?.getAllEdgeProvenance?.() ?? [],
            pendingEdges: owners.getPendingEdges?.() ?? [],
            // Canvas connections, so a wire with no syntax edge surfaces as a
            // `manual` edge through the production snapshot (P4c task 10).
            connections: owners.connectionDomain?.selectors?.getAllConnections?.() ?? [],
            // The absolute project root, so SyntaxDomain's absolute keys meet the
            // project-relative paths pieces and requests use (P4c task 9).
            projectRoot: owners.projectRoot ?? '',
            parsedRevision: (path) => syntax?.getParsedRevision?.(path) ?? null,
            discoverable: isDiscoverableFilename,
            discoveryInFlight: owners.isDiscoveryInFlight?.() === true,
            // Distinct from in-flight: armed on an empty canvas, waiting for
            // pieces, so the graph reports its own reason (P4c live pass 1).
            awaitingCanvasPieces: owners.isDiscoveryAwaitingCanvasPieces?.() === true
          });
        }
      },
      transport,
      getWorkspaceEpoch
    });
    bridgeRef.current = bridge;
    let unlisten = null;
    let disposed = false;
    listen(BRIDGE_REQUEST_EVENT, (event) => {
      bridge.handleRequest(event.payload);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      if (unlisten) unlisten();
      bridgeRef.current = null;
      void bridge.dispose();
    };
  }, []);

  const readyEpoch = deriveReadyEpoch(projectInstance, sessionReadyFor);
  useEffect(() => {
    void bridgeRef.current?.setReadyEpoch(readyEpoch);
  }, [readyEpoch]);
}
