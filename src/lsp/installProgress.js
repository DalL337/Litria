/**
 * installProgress.js — pure helpers shared by the two places a managed
 * language-server install runs (the file-open consent pill and the
 * Preferences ▸ Language servers room).
 *
 * Rust emits `lsp:download-progress` ({ serverId, receivedBytes, totalBytes })
 * while an install downloads, and rejects a cancelled install with its own
 * code (`lsp.install.cancelled`, src-tauri/src/lsp/download.rs) so a cancel is
 * never reported as a failure.
 */

export const INSTALL_CANCELLED_CODE = 'lsp.install.cancelled';

/** True when an install error is the user's cancel, not a failure. */
export function isInstallCancelled(error) {
  return error?.code === INSTALL_CANCELLED_CODE;
}

const MB = 1024 * 1024;

/**
 * "33% (15.0 of 45.0 MB)", or "15.0 MB" when the server sent no size.
 * Null when there is no progress to show yet.
 */
export function formatInstallProgress(progress) {
  if (!progress || typeof progress.receivedBytes !== 'number') return null;
  const received = (progress.receivedBytes / MB).toFixed(1);
  const total = progress.totalBytes;
  if (typeof total !== 'number' || total <= 0) return `${received} MB`;
  const percent = Math.min(100, Math.floor((progress.receivedBytes / total) * 100));
  return `${percent}% (${received} of ${(total / MB).toFixed(1)} MB)`;
}
