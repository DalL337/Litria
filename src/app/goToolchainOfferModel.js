// ---------------------------------------------------------------------------
// Go toolchain-offer model (ADR-005 Slice 6.5) — pure decision logic for the
// class-3 gopls offer. gopls ships no prebuilt binaries, so unlike the
// class-1 registry languages the consent surface IS the visible terminal:
// the pill carries the exact pinned `go install` line, the user executes it,
// and integrity comes from Go's sum.golang.org checksum database — Litria
// never runs the install itself.
//
// The other half of the honesty contract: when even the Go toolchain is
// missing, say SO instead of going quiet — a hint pill names the gap and
// what fills it (detect + hint, never install; ADR-005 Scope Notes).
// ---------------------------------------------------------------------------

// Pinned gopls version (latest gopls/v* tag at pin time, 2026-07-09).
// Bump deliberately, like a registry pin — never @latest.
export const GOPLS_VERSION = 'v0.23.0';

export const GOPLS_INSTALL_COMMAND = `go install golang.org/x/tools/gopls@${GOPLS_VERSION}`;

export function isGoFilename(filename) {
  return typeof filename === 'string' && filename.trim().toLowerCase().endsWith('.go');
}

export function goOfferKey(projectId) {
  return `${projectId}::go`;
}

/**
 * Which Go offer (if any) this file-open deserves, from the prerequisites
 * payload of `lsp_detect_prerequisites('go')`:
 *  - gopls resolved (any tier) → null: the lifecycle hook owns the session.
 *  - go toolchain present, gopls missing → 'install' (class-3 pill).
 *  - go toolchain missing → 'toolchain-hint' (info-only pill).
 */
export function decideGoOffer({ prerequisites, offeredKeys, projectId }) {
  if (!projectId || !prerequisites) return null;
  const key = goOfferKey(projectId);
  if (offeredKeys?.has(key)) return null;
  const tier = typeof prerequisites.resolutionTier === 'string' && prerequisites.resolutionTier.trim()
    ? prerequisites.resolutionTier.trim()
    : null;
  if (tier) return null;
  const probes = Array.isArray(prerequisites.probes) ? prerequisites.probes : [];
  const goToolchain = probes.find((p) => p?.command === 'go');
  const kind = goToolchain?.available === true ? 'install' : 'toolchain-hint';
  return { kind, key };
}

/** Class-3 offer copy — the exact command is the message (A3 honesty). */
export function buildGoInstallOfferMessage() {
  return (
    `Go support available — click to run \`${GOPLS_INSTALL_COMMAND}\` in the terminal `
    + '(pinned version, verified by Go\'s checksum database). '
    + 'Reopen the Go file when it finishes.'
  );
}

/** Toolchain honesty: name the missing piece, never install it. */
export function buildGoToolchainHintMessage() {
  return (
    'Go file detected, but no Go toolchain was found — install Go from go.dev '
    + 'to enable gopls language support.'
  );
}
