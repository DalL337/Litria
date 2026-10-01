// useProjectApiBridge — wires the Project API owner bridge
// (src/app/projectApiBridge.js) to Tauri and to the editor session.
//
// The bridge answers only for a fully hydrated project instance: the ready
// epoch comes from the instance's own load (`_dbState.workspaceEpoch`), and
// only once useProjectPersistence reports that load hydrated
// (`sessionReadyFor`). Owner ports read the latest session state through a
// ref, at request time.
//
// Debug builds only, like the Rust commands it calls: until the Project API's
// external transport exists (build plan track T), its only consumer is the
// debug-only `project_api_dev_call`. In a release build this hook does nothing.

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEditorSession } from '../editor/EditorSessionContext';
import { getSessionDocumentsByPath } from '../editor/editorSessionDomain.js';
import { getWorkspaceEpoch } from '../project/dbStorage.js';
import {
  BRIDGE_REQUEST_EVENT,
  createProjectApiBridge,
  deriveReadyEpoch,
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

export function useProjectApiBridge({ projectInstance, sessionReadyFor }) {
  const { tabsById, openTabIds } = useEditorSession();
  const sessionRef = useRef({ tabsById, openTabIds });
  sessionRef.current = { tabsById, openTabIds };
  const bridgeRef = useRef(null);

  useEffect(() => {
    if (!ENABLED) return undefined;
    const bridge = createProjectApiBridge({
      ports: { sessionDocuments: () => getSessionDocumentsByPath(sessionRef.current) },
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
