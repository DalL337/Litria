// useNpmScriptsFirstOpen (ADR-021 §3) — the scripts-off consent pill for
// npm-scaffolded projects. Installs ran with dependency lifecycle scripts
// disabled; this offers the deferred half (`npm rebuild`) as one visible
// click in the terminal drawer.
//
// Same composition shape as usePythonFirstOpen: runs once per project load
// (the `_dbState` token idiom), decision logic lives in the pure model, the
// pill carries exact shell input, and "actioned" persists to editor_state
// while a dismissed pill returns next open.

import { useEffect, useRef } from 'react';
import { dbSaveEditorState } from '../project/dbStorage';
import {
  decideNpmScriptsFirstOpen,
  buildNpmScriptsOffer,
  buildNpmScriptsOfferMessage,
  NPM_SCRIPTS_FLAGS,
  NPM_SCRIPTS_PENDING_KEY,
} from '../scaffold/npmScriptsFirstOpenModel';

export function useNpmScriptsFirstOpen({ projectInstance, pillDomain }) {
  const ranForTokenRef = useRef(null);

  useEffect(() => {
    const token = projectInstance?._dbState;
    if (!token || !projectInstance?.rootPath || !pillDomain) return undefined;
    if (ranForTokenRef.current === token) return undefined;
    ranForTokenRef.current = token;

    const editorState = token.editorState ?? {};
    const kind = decideNpmScriptsFirstOpen({
      scriptsPending: editorState[NPM_SCRIPTS_PENDING_KEY] === '1',
      flags: {
        'enable-scripts': editorState[NPM_SCRIPTS_FLAGS['enable-scripts']] === '1',
      },
    });
    if (!kind) return undefined;

    const offer = buildNpmScriptsOffer();
    pillDomain.commands.addPill({
      projectId: projectInstance.instanceId,
      message: buildNpmScriptsOfferMessage(offer.display),
      severity: 'info',
      command: offer.command,
      onActivated: () => {
        // Actioned: never offer again, and clear the pending marker — the
        // rebuild ran where the user could watch it. Fire-and-forget: a
        // failed write only means one extra offer on the next open.
        dbSaveEditorState(NPM_SCRIPTS_FLAGS[kind], '1').catch(() => {});
        dbSaveEditorState(NPM_SCRIPTS_PENDING_KEY, '0').catch(() => {});
      },
    });
    return undefined;
  }, [projectInstance, pillDomain]);
}
