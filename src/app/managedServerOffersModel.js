// ---------------------------------------------------------------------------
// Managed-server offers model (ADR-005 A2/A3, Slice 5) — pure decision logic
// for the file-open install offer. No React, no IPC: the hook feeds it the
// registry payload (desired = registry extensions present in open files;
// installed = receipt map — probes, never diagnostics) and the pill carries
// what it returns.
//
// Class-1 consent (verified managed artifact): the pill's click runs the
// staged installer via a callback `action`, NOT a terminal command — the
// provenance (server, pinned version, SHA-256 verification, source host)
// is named in the pill copy per A3's "show exactly what will happen".
// ---------------------------------------------------------------------------

function extensionOf(filename) {
  if (typeof filename !== 'string') return null;
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return null;
  return filename.slice(dot).toLowerCase();
}

/**
 * Match an open filename to a registry language. Returns
 * { languageId, entry } or null.
 */
export function matchRegistryLanguage(registryPayload, filename) {
  const servers = registryPayload?.registry?.servers;
  if (!servers) return null;
  const ext = extensionOf(filename);
  if (!ext) return null;
  for (const [languageId, entry] of Object.entries(servers)) {
    if (entry.extensions.some((e) => e.toLowerCase() === ext)) {
      return { languageId, entry };
    }
  }
  return null;
}

/**
 * Which install offer (if any) this file-open deserves. Skips when the
 * server is already installed (receipt map), when this platform has no
 * artifact (honesty: never offer what cannot install), or when the offer
 * was already raised this session for the project (A3: never re-prompt the
 * same project per session; a fresh session re-offers).
 */
export function decideServerOffer({ match, registryPayload, offeredKeys, projectId }) {
  if (!match || !projectId) return null;
  const { languageId, entry } = match;
  const installed = registryPayload?.installed ?? {};
  if (installed[entry.server]) return null;
  const platformKey = registryPayload?.platformKey;
  if (!platformKey || !entry.artifacts[platformKey]) return null;
  const key = offerKey(projectId, languageId);
  if (offeredKeys?.has(key)) return null;
  return { languageId, entry, key };
}

export function offerKey(projectId, languageId) {
  return `${projectId}::${languageId}`;
}

/**
 * Drop every project's offered-key for a language. A settings-side uninstall
 * (Slice 7) must be able to re-offer on the next matching file-open in the
 * SAME session — without this, the A3 never-re-prompt guard would suppress
 * the offer until the next project open.
 */
export function clearOfferedKeysForLanguage(offeredKeys, languageId) {
  if (!offeredKeys || !languageId) return;
  const suffix = `::${languageId}`;
  for (const key of [...offeredKeys]) {
    if (key.endsWith(suffix)) offeredKeys.delete(key);
  }
}

/** Pill copy — provenance up front, per A3. */
export function buildServerOfferMessage(entry, platformKey) {
  const artifact = entry.artifacts[platformKey];
  const host = artifact ? new URL(artifact.url).host : 'unknown host';
  return (
    `${entry.name} support available — install ${entry.server} ${entry.version} `
    + `from ${host} (pinned version, SHA-256 verified before it touches disk)`
  );
}

export function buildInstallProgressMessage(entry) {
  return `Installing ${entry.server} ${entry.version} — verified download in progress…`;
}

export function buildInstallSuccessMessage(entry, { autoStart = false } = {}) {
  return autoStart
    ? `${entry.name} support installed (${entry.server} ${entry.version}) — starting the language server`
    : `${entry.name} support installed (${entry.server} ${entry.version}) — reopen the file to start it`;
}

export function buildInstallFailureMessage(entry, errorMessage) {
  return `${entry.server} install failed: ${errorMessage}`;
}
