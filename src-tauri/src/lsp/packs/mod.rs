pub(crate) mod versions;
mod clangd;
mod go;
mod python;
mod rust_analyzer;
mod typescript;

use std::fmt;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

// ---------------------------------------------------------------------------
// Pack registry
// ---------------------------------------------------------------------------

/// Every registered pack language, in settings display order (bundled
/// first, then registry, then toolchain-tier). Keep in sync with
/// `get_pack`'s match — the pairing test enforces it.
pub(crate) fn all_language_ids() -> &'static [&'static str] {
    &["python", "typescript", "rust", "cpp", "go"]
}

/// Return the pack for the given language ID, or None if not registered.
pub(crate) fn get_pack(language_id: &str) -> Option<LanguagePack> {
    match language_id {
        "python" => Some(python::pack()),
        "typescript" => Some(typescript::pack()),
        // Registry languages (ADR-005): registered unconditionally — the
        // resolver decides availability (PATH or managed receipt), and its
        // not-resolved error is the honest pre-install state that drives
        // the consent pill. No bundled tier exists for these.
        "rust" => Some(rust_analyzer::pack()),
        "cpp" => Some(clangd::pack()),
        // Toolchain-tier (ADR-005 Slice 6.5): gopls has no prebuilt
        // binaries, so Go has NO registry entry — acquisition is a class-3
        // `go install` typed into the visible terminal. The pack exists so
        // resolution and sessions work once gopls lands on PATH/GOPATH.
        "go" => Some(go::pack()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Server resolution types
// ---------------------------------------------------------------------------

/// How a language server executable was located.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ResolutionTier {
    /// Found on system PATH (current behavior).
    Global,
    /// Found in the managed directory (`app_data_dir()/servers/`, ADR-005).
    Managed,
    /// Found in Tauri resource directory (shipped with CM).
    Bundled,
}

impl fmt::Display for ResolutionTier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Global => write!(f, "global"),
            Self::Managed => write!(f, "managed"),
            Self::Bundled => write!(f, "bundled"),
        }
    }
}

/// A fully resolved command ready for spawn.
///
/// Produced by the resolver after probing the 3-tier fallback chain
/// (global → managed → bundled).  Passed to `spawn_server()` instead
/// of using `pack.command` directly.
#[derive(Debug, Clone)]
pub(crate) struct ResolvedCommand {
    /// The executable to run (node path for JS servers, binary path for native).
    pub executable: PathBuf,
    /// Additional args prepended before `pack.args` (e.g. the JS entry script path).
    pub prefix_args: Vec<String>,
    /// How it was found.
    pub tier: ResolutionTier,
}

// ---------------------------------------------------------------------------
// Core pack types
// ---------------------------------------------------------------------------

/// Where the server process should be launched from.
#[derive(Debug, Clone)]
pub(crate) enum CwdPolicy {
    /// Use the project root directory.
    ProjectRoot,
}

/// Text document synchronisation granularity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SyncKind {
    /// Send the full file content on every change.
    Full,
}

impl SyncKind {
    /// LSP numeric value as defined in the spec.
    // Consumer is the deferred capability-negotiation slice — packs already
    // declare their sync kind (document_sync_kind) ahead of it.
    #[allow(dead_code)]
    pub(crate) fn as_u8(self) -> u8 {
        match self {
            SyncKind::Full => 1,
        }
    }
}

/// A single prerequisite command that must be available before the pack can activate.
#[derive(Debug, Clone)]
pub(crate) struct Prerequisite {
    /// Human-readable label shown in the prerequisites UI.
    pub display_name: &'static str,
    /// The executable to probe (looked up on PATH).
    pub command: &'static str,
    /// Argument to pass to get a version string (e.g. `--version`).
    pub version_arg: &'static str,
    /// Minimum version string required (checked as a naive prefix, e.g. "3.8").
    /// Empty string means "any version is acceptable".
    pub min_version: &'static str,
    /// When true, this prerequisite is satisfied by a bundled or managed server
    /// resolution and does not need to be found on PATH.  Runtime dependencies
    /// like `python` and `node` should set this to `false`.
    pub satisfied_by_bundle: bool,
}

/// All the information the transport layer needs to spawn and handshake with a
/// specific language server.  Language packs contain no transport logic.
#[derive(Debug, Clone)]
pub(crate) struct LanguagePack {
    // --- Identity ---
    /// LSP language identifier (e.g. "python", "typescript").
    pub language_id: &'static str,

    // --- Prerequisites ---
    /// Probes run before activation.  All must pass for the session to start.
    pub prerequisites: Vec<Prerequisite>,

    // --- Launch ---
    /// Executable name looked up on PATH for global resolution.
    /// For managed/bundled tiers, the resolver locates the actual path.
    pub command: &'static str,
    /// Command-line arguments (e.g. `["--stdio"]`).
    pub args: Vec<&'static str>,
    /// Argument that makes the probe target print its version and exit 0 —
    /// the resolver's global probe RUNS this instead of trusting PATH
    /// existence (hollow-shim hardening: rustup proxies and stale npm .cmd
    /// shims pass `where` but fail to execute). `--version` for most
    /// servers; gopls uses the `version` subcommand.
    pub version_probe_arg: &'static str,
    /// Optional companion command the global probe runs INSTEAD of `command`
    /// — for servers with no clean-exit argv. `pyright-langserver` speaks
    /// only LSP (any argv without --stdio exits 1 trying to open a
    /// connection), so python probes the sibling `pyright` CLI, which ships
    /// in the same npm package. When set, the probe additionally requires
    /// `command` itself to exist on PATH so a partial install can't pass.
    pub version_probe_command: Option<&'static str>,
    /// Where to launch the server process.
    pub cwd_policy: CwdPolicy,
    /// Environment variable keys to forward from the current process.
    pub env_allowlist: Vec<&'static str>,

    // --- LSP handshake ---
    /// Client capability object sent in the `initialize` request.
    pub client_capabilities: Value,
    /// Server-specific options sent as `initializationOptions` in `initialize`.
    pub initialization_options: Value,

    // --- Timing / behaviour ---
    /// How long to wait for the `initialize` response before timing out (ms).
    pub startup_timeout_ms: u64,
    /// Document sync granularity (Full in MVP).
    // Declared by every pack; read when the deferred incremental-sync /
    // capability-negotiation slice lands.
    #[allow(dead_code)]
    pub document_sync_kind: SyncKind,

    // --- Error reporting ---
    /// Prefix for error codes emitted by this pack (e.g. "python_lsp").
    pub error_prefix: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_language_ids_pairs_with_get_pack() {
        for language_id in all_language_ids() {
            let pack = get_pack(language_id)
                .unwrap_or_else(|| panic!("all_language_ids lists '{language_id}' but get_pack has no arm for it"));
            assert_eq!(&pack.language_id, language_id);
        }
    }
}
