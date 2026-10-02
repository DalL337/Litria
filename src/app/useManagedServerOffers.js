// useManagedServerOffers (ADR-005 A2/A3, Slice 5) — the file-open trigger of
// the capability reconciler for managed language servers. Opening a file
// whose extension a registry language claims raises ONE consent pill per
// project per session: provenance-first copy, click = staged verified
// install (class-1 — a callback, never a terminal command; contrast the
// class-3 npm/python pills whose consent surface IS the terminal).
//
// Installed-state comes from receipts via the registry payload (probes are
// the source of truth — A2); diagnostics are never parsed. The wizard
// trigger from ADR §6 is N/A while no registry language has a wizard
// runtime; project-open batching arrives with the fuller reconciler.

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  buildInstallCancelledMessage,
  buildInstallCancellingMessage,
  buildInstallFailureMessage,
  buildInstallProgressMessage,
  buildInstallSuccessMessage,
  buildServerOfferMessage,
  clearOfferedKeysForLanguage,
  decideServerOffer,
  matchRegistryLanguage,
} from './managedServerOffersModel';
import { formatInstallProgress, isInstallCancelled } from '../lsp/installProgress.js';

export function useManagedServerOffers({
  projectInstance,
  activeFilenames = [],
  pillDomain,
  languageSupportDomain = null
}) {
  const payloadRef = useRef(null);
  const offeredKeysRef = useRef(new Set());
  const payloadProjectRef = useRef(null);
  // Bumped when a settings-side uninstall lands so the offer effect re-runs
  // against fresh receipts even while the matching file stays open.
  const [uninstallTick, setUninstallTick] = useState(0);

  // A Slice 7 uninstall must be seen THIS session, not just at the next
  // project open (the "acceptable staleness" the S7 journal noted): drop the
  // cached registry payload (its installed map is stale) and the language's
  // offered keys, then re-run the offer pass.
  useEffect(() => {
    let disposed = false;
    let unlisten = null;
    (async () => {
      unlisten = await listen('lsp:server-uninstalled', (event) => {
        payloadRef.current = null;
        clearOfferedKeysForLanguage(offeredKeysRef.current, event?.payload?.languageId);
        setUninstallTick((tick) => tick + 1);
      });
      if (disposed) unlisten();
    })();
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    const projectId = projectInstance?.instanceId ?? null;
    const projectRoot = projectInstance?.rootPath ?? null;
    if (!projectId || !pillDomain || activeFilenames.length === 0) return undefined;

    // Registry pins are baked, but the installed map is receipts — refetch
    // per project so a settings-side uninstall (Slice 7) is seen no later
    // than the next project open. (Same project, same session stays cached;
    // acceptable staleness, noted in the S7 journal.)
    if (payloadProjectRef.current !== projectId) {
      payloadProjectRef.current = projectId;
      payloadRef.current = null;
    }

    let cancelled = false;
    (async () => {
      if (!payloadRef.current) {
        try {
          payloadRef.current = await invoke('lsp_get_registry');
        } catch {
          return; // malformed registry — surfaced by its own command error path
        }
      }
      const payload = payloadRef.current;
      if (cancelled || !payload) return;

      for (const filename of activeFilenames) {
        const match = matchRegistryLanguage(payload, filename);
        const offer = decideServerOffer({
          match,
          registryPayload: payload,
          offeredKeys: offeredKeysRef.current,
          projectId,
        });
        if (!offer) continue;
        offeredKeysRef.current.add(offer.key);

        const { entry, languageId } = offer;
        pillDomain.commands.addPill({
          projectId,
          message: buildServerOfferMessage(entry, payload.platformKey),
          severity: 'info',
          action: async () => {
            // The progress pill shows the download as it arrives and offers
            // Cancel (lsp_cancel_install takes the SERVER id). A cancel is
            // honoured until extraction starts; after that the install
            // completes and reports success as usual.
            const serverId = entry.server;
            let cancelling = false;
            const progressId = pillDomain.commands.addPill({
              projectId,
              message: buildInstallProgressMessage(entry),
              severity: 'info',
              secondary: {
                label: 'Cancel',
                run: () => {
                  cancelling = true;
                  pillDomain.commands.updatePill(progressId, {
                    message: buildInstallCancellingMessage(entry),
                    secondary: null,
                  });
                  invoke('lsp_cancel_install', { serverId }).catch(() => {});
                },
              },
            });
            let finished = false;
            let stopProgress = null;
            listen('lsp:download-progress', (event) => {
              const progress = event?.payload;
              if (finished || cancelling || progress?.serverId !== serverId) return;
              pillDomain.commands.updatePill(progressId, {
                message: buildInstallProgressMessage(entry, formatInstallProgress(progress)),
              });
            }).then((stop) => {
              if (finished) stop();
              else stopProgress = stop;
            }).catch(() => {});
            try {
              await invoke('lsp_install_server', { languageId, customUrl: null });
              pillDomain.commands.dismissPill(progressId);
              const autoStart = Boolean(languageSupportDomain && projectRoot);
              pillDomain.commands.addPill({
                projectId,
                message: buildInstallSuccessMessage(entry, { autoStart }),
                severity: 'success',
              });
              // Receipts changed — refresh the cached payload so this
              // session stops offering what it just installed.
              payloadRef.current = null;
              // Slice 6: turn the fresh install straight into a running
              // session (detect → gate → activate). Fire-and-forget — a
              // start failure surfaces through the domain's activation
              // events, not this pill.
              if (autoStart) {
                languageSupportDomain.commands
                  .ensureManagedActiveForProject(languageId, { projectId, projectRoot })
                  .catch(() => {});
              }
            } catch (e) {
              pillDomain.commands.dismissPill(progressId);
              if (isInstallCancelled(e)) {
                pillDomain.commands.addPill({
                  projectId,
                  message: buildInstallCancelledMessage(entry),
                  severity: 'info',
                });
              } else {
                const message = typeof e?.message === 'string' && e.message
                  ? e.message
                  : 'download or verification failed';
                pillDomain.commands.addPill({
                  projectId,
                  message: buildInstallFailureMessage(entry, message),
                  severity: 'error',
                });
              }
              // Allow a retry offer on the next file-open this session.
              offeredKeysRef.current.delete(offer.key);
            } finally {
              finished = true;
              stopProgress?.();
            }
          },
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectInstance?.instanceId, activeFilenames, pillDomain, uninstallTick]);
}
