// shutdown.js — the frontend clean-shutdown ritual (hook #5's clean signal).
//
// Marker removal is driven by THIS ritual, never by Rust process exit: a
// session whose webview died must be unable to look clean. Bounded by a
// short timeout so a hung IPC can't block the window from closing.
//
// The ritual is deliberately ONE invoke: crash_mark_clean. No breadcrumb
// flush — mark_clean deletes the mirror file anyway, so a flush here would
// spend the timeout budget writing a file the very next call removes (and
// under a disk stall, could starve the essential mark-clean entirely).

import { invokeSafe } from './invoke.js';

const RITUAL_TIMEOUT_MS = 800;

export async function performCleanShutdown() {
  const ritual = invokeSafe('crash_mark_clean');
  const timeout = new Promise((resolve) => globalThis.setTimeout(resolve, RITUAL_TIMEOUT_MS));
  // invokeSafe never rejects; a timeout leaves the marker dirty — the next
  // launch then reports an unclean shutdown, which is the honest outcome.
  await Promise.race([ritual, timeout]);
}
