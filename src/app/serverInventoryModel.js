// ---------------------------------------------------------------------------
// Server-inventory model (ADR-005 Slice 7) — pure presentation logic for the
// preferences "Language servers" section. No React, no IPC: the panel feeds
// it the lsp_server_inventory payload and renders what it returns.
//
// Receipts and resolver tiers are the source of truth (A2 — probes, never
// diagnostics); this layer only shapes them for display and gates which
// actions each row honestly supports.
// ---------------------------------------------------------------------------

/** "1.4 MB" — settings-grade rounding, not scientific. */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

/** Resolver tier → user-facing badge. */
export function tierBadge(row) {
  switch (row?.tier) {
    case 'bundled': return 'Bundled';
    case 'managed': return 'Managed';
    case 'global': return 'On PATH';
    default: return 'Not installed';
  }
}

/**
 * One human line of provenance per row: what is running (or would run) and
 * where it came from.
 */
export function rowStatusLine(row) {
  if (!row) return '';
  const parts = [];
  if (row.installedVersion) {
    parts.push(`${row.server} ${row.installedVersion} (managed)`);
    if (row.installedAt) {
      const day = String(row.installedAt).slice(0, 10);
      if (day) parts.push(`installed ${day}`);
    }
    if (row.installKind === 'custom') {
      parts.push('custom URL — integrity not verifiable');
    }
  } else if (row.tier === 'bundled') {
    parts.push(`${row.server} ships with Litria`);
  } else if (row.tier === 'global') {
    parts.push(`${row.server} found on your system`);
  } else if (row.registryVersion) {
    parts.push(`${row.server} ${row.registryVersion} available (verified download)`);
  } else if (row.languageId === 'go') {
    parts.push('installed through the Go toolchain — open a .go file for the prompt');
  } else {
    parts.push(`${row.server} not available`);
  }
  const size = formatBytes(row.sizeBytes);
  if (size) parts.push(size);
  return parts.join(' · ');
}

/**
 * Actions a row honestly supports:
 * - install: registry language, nothing resolved yet (class-1 verified path).
 * - update: managed install older than the registry pin.
 * - uninstall/reverify: a managed dir + receipt exist.
 * Never for go (class-3: the terminal is the install surface) and never for
 * bundled/global-only rows (not ours to remove — build plan 7c).
 */
export function rowActions(row) {
  if (!row) return [];
  const actions = [];
  if (row.registryVersion && !row.tier) actions.push('install');
  if (row.updateAvailable) actions.push('update');
  if (row.canUninstall) actions.push('reverify', 'uninstall');
  return actions;
}

/** Installed group = anything the resolver can find; the rest is available. */
export function groupInventoryRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    installed: list.filter((row) => row?.tier),
    available: list.filter((row) => !row?.tier),
  };
}

/** Re-verify payload → one honest line. */
export function reverifyMessage(payload) {
  switch (payload?.status) {
    case 'verified':
      return 'Verified — binary matches its install-time checksum.';
    case 'mismatch':
      return 'MISMATCH — binary differs from what was installed. Uninstall and reinstall it.';
    case 'unrecorded':
      return 'No baseline recorded (installed before re-verify existed). Reinstall to record one.';
    case 'binary_missing':
      return 'Binary missing on disk — the receipt is stale. Reinstall or uninstall.';
    default:
      return 'Verification did not complete.';
  }
}

export function uninstallSummary(payload) {
  const freed = formatBytes(payload?.freedBytes);
  return freed
    ? `${payload.server} removed — ${freed} freed.`
    : `${payload?.server ?? 'Server'} removed.`;
}
