// useGoToolchainOffer (ADR-005 Slice 6.5) — the file-open trigger for Go's
// class-3 acquisition path. Opening a .go file with no gopls resolved raises
// ONE pill per project per session: with a Go toolchain present, the pill
// carries the pinned `go install` line and clicking types it into the
// visible terminal (class-3 — the terminal is the consent and audit
// surface; contrast the class-1 registry pill whose click runs the verified
// installer). Without a toolchain, an info-only hint names the gap.
//
// The session lifecycle itself is useManagedLspLifecycle's job — once gopls
// exists (PATH or `go env GOPATH`/bin), the resolver reports a tier and
// this hook stays silent.

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  buildGoInstallOfferMessage,
  buildGoToolchainHintMessage,
  decideGoOffer,
  isGoFilename,
  GOPLS_INSTALL_COMMAND,
} from './goToolchainOfferModel';

export function useGoToolchainOffer({ projectInstance, activeFilenames = [], pillDomain }) {
  const offeredKeysRef = useRef(new Set());

  useEffect(() => {
    const projectId = projectInstance?.instanceId ?? null;
    if (!projectId || !pillDomain) return undefined;
    if (!activeFilenames.some(isGoFilename)) return undefined;
    // Checked before the detect round-trip so a settled project costs nothing.
    if (offeredKeysRef.current.has(`${projectId}::go`)) return undefined;

    let cancelled = false;
    (async () => {
      let prerequisites;
      try {
        prerequisites = await invoke('lsp_detect_prerequisites', { languageId: 'go' });
      } catch {
        return; // probe failure surfaces through its own command error path
      }
      if (cancelled) return;

      const offer = decideGoOffer({
        prerequisites,
        offeredKeys: offeredKeysRef.current,
        projectId,
      });
      if (!offer) return;
      offeredKeysRef.current.add(offer.key);

      if (offer.kind === 'install') {
        pillDomain.commands.addPill({
          projectId,
          message: buildGoInstallOfferMessage(),
          severity: 'info',
          command: GOPLS_INSTALL_COMMAND,
        });
      } else {
        pillDomain.commands.addPill({
          projectId,
          message: buildGoToolchainHintMessage(),
          severity: 'info',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectInstance?.instanceId, activeFilenames, pillDomain]);
}
