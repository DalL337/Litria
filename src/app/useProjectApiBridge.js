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
import {
  BRIDGE_REQUEST_EVENT,
  createProjectApiBridge,
  deriveReadyEpoch,
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
 */
export function useProjectApiBridge({
  projectInstance,
  sessionReadyFor,
  selectedIds,
  piecesById,
  selectedGroupId,
  groups,
  languageSupportDomain
}) {
  const { tabsById, openTabIds, activeTabId } = useEditorSession();
  const ownersRef = useRef(null);
  ownersRef.current = {
    session: { tabsById, openTabIds },
    activeTabId,
    workspace: { selectedIds, piecesById, selectedGroupId, groups },
    languageSupportDomain
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
        languageCapabilities: () => buildCapabilityMatrix(ownersRef.current.languageSupportDomain)
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
