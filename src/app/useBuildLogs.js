// useBuildLogs — the IO half of the build-log feature.
//
// buildLogDomain.js holds state and stays pure; every `invoke` lives here,
// mirroring how the domain/hook split works elsewhere in src/app.
//
// Clipboard note: writing goes through the `copy_to_clipboard` Rust command,
// not navigator.clipboard. The webview is deliberately not granted clipboard
// IPC (capabilities/default.json, enforced by capabilityScope.test.mjs), and
// routing through Rust also avoids WebKitGTK's gesture/permission quirks on
// Linux.

import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { formatTraceText } from './buildLogDomain';

export function useBuildLogs(buildLogDomain) {
  /** Write text to the system clipboard. Resolves true on success. */
  const copyText = useCallback(async (text) => {
    if (!text) return false;
    try {
      await invoke('copy_to_clipboard', { text });
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Persist the current run to ~/.litria/logs/builds. Returns the path. */
  const sendCurrentRunToLogs = useCallback(async () => {
    if (!buildLogDomain) return null;
    const body = buildLogDomain.selectors.getTraceJsonl();
    const meta = buildLogDomain.selectors.getRunMeta();
    if (!body) return null;
    try {
      return await invoke('build_log_write', {
        slug: meta?.projectName || 'run',
        body,
      });
    } catch {
      return null;
    }
  }, [buildLogDomain]);

  /** Persist an arbitrary one-off record (used by pill "Send to logs"). */
  const sendRecordToLogs = useCallback(async ({ slug = 'notice', record }) => {
    if (!record) return null;
    try {
      return await invoke('build_log_write', {
        slug,
        body: JSON.stringify({ ts: Date.now(), ...record }),
      });
    } catch {
      return null;
    }
  }, []);

  /** Copy the current run's trace as human-readable text. */
  const copyCurrentRun = useCallback(async () => {
    if (!buildLogDomain) return false;
    const text = formatTraceText(
      buildLogDomain.selectors.getTrace(),
      buildLogDomain.selectors.getRunMeta(),
      buildLogDomain.selectors.isTruncated()
    );
    return copyText(text);
  }, [buildLogDomain, copyText]);

  /** Refresh both catalogs for the log viewer. */
  const refreshEntries = useCallback(async () => {
    if (!buildLogDomain) return;
    try {
      const [builds, crashes] = await Promise.all([
        invoke('build_log_list').catch(() => []),
        invoke('crash_log_list').catch(() => []),
      ]);
      buildLogDomain.commands.setEntries(builds ?? []);
      buildLogDomain.commands.setCrashEntries(crashes ?? []);
    } catch {
      // Listing is best-effort; an empty viewer beats a thrown error.
    }
  }, [buildLogDomain]);

  const readBuildLog = useCallback(async (name) => {
    try {
      return (await invoke('build_log_read', { name })) ?? '';
    } catch {
      return '';
    }
  }, []);

  const readCrashLog = useCallback(async (name) => {
    try {
      return (await invoke('crash_log_read', { name })) ?? '';
    } catch {
      return '';
    }
  }, []);

  return {
    copyText,
    copyCurrentRun,
    sendCurrentRunToLogs,
    sendRecordToLogs,
    refreshEntries,
    readBuildLog,
    readCrashLog,
  };
}
