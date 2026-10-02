// useInstallProgress — the latest `lsp:download-progress` for one language
// server while it installs, for the Preferences ▸ Language servers room.
// Null when no server is given or no progress has arrived for it.

import { useEffect, useState } from 'react';
import { listenInstallProgress } from '../lsp/lspClient.js';

export function useInstallProgress(serverId) {
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    setProgress(null);
    if (!serverId) return undefined;
    let disposed = false;
    let unlisten = null;
    listenInstallProgress((payload) => {
      if (!disposed && payload?.serverId === serverId) setProgress(payload);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [serverId]);

  return serverId ? progress : null;
}
