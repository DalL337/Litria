// ---------------------------------------------------------------------------
// Pinned version constants for bundled LSP dependencies.
//
// These constants are the SINGLE SOURCE OF TRUTH for bundled versions.
// The bundle scripts (scripts/bundle-servers.mjs, scripts/bundle-node.mjs)
// parse this file directly to determine what to download/install.
//
// When bumping a version:
//   1. Update the constant here.
//   2. Run `npm run bundle` to re-stage the new version.
//   3. If bumping NODE_VERSION: update scripts/node-hashes.json with new
//      SHA256 hashes (first download on each platform records automatically;
//      verify they match nodejs.org/dist SHASUMS256.txt).
//   4. Update docs/plans/lsp/lsp-client-architecture.md Section 14.
//   5. Verify behaviour with a manual parity pass before shipping.
// ---------------------------------------------------------------------------

// The three server versions below are extracted TEXTUALLY by
// scripts/bundle-servers.mjs (and surfaced by the session version-drift
// hook) — rustc never reads them, hence allow(dead_code). Do not delete.

// Python LSP server (pyright-langserver, bundled in resources/servers/python/)
#[allow(dead_code)]
pub(crate) const PYRIGHT_VERSION: &str = "1.1.411";

// TypeScript language server (bundled in resources/servers/typescript/)
#[allow(dead_code)]
pub(crate) const TSSERVER_VERSION: &str = "5.3.0";

// TypeScript compiler itself (bundled alongside typescript-language-server)
// Pinned to the 5.x line deliberately: the 7.x native-port major is a
// separate integration decision, not a routine pin refresh.
#[allow(dead_code)]
pub(crate) const TYPESCRIPT_VERSION: &str = "5.9.3";

// Node.js runtime (bundled in resources/node/ for LSP servers + scaffold runner)
// Pin to active LTS line — must match the version CM is developed/tested against.
pub(crate) const NODE_VERSION: &str = "24.14.0";
