use serde_json::json;

use super::{rust_analyzer, CwdPolicy, LanguagePack, SyncKind};

/// C/C++ language pack (ADR-005 Slice 6).
///
/// clangd is a managed-tier server (registry language `cpp`) or global
/// PATH. No bundled tier, no runtime prerequisites: clangd itself needs
/// nothing to run — a compiler is the user's project concern (toolchain
/// honesty), and `compile_commands.json` quality is clangd's own
/// diagnostics story, not a probe.
pub(crate) fn pack() -> LanguagePack {
    LanguagePack {
        language_id: "cpp",
        prerequisites: vec![],
        command: "clangd",
        args: vec![],
        version_probe_arg: "--version",
        version_probe_command: None,
        cwd_policy: CwdPolicy::ProjectRoot,
        env_allowlist: vec![
            "PATH",
            "HOME",
            "USER",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "TEMP",
            "TMP",
        ],
        client_capabilities: rust_analyzer::native_server_client_capabilities(),
        initialization_options: json!({}),
        startup_timeout_ms: 10_000,
        document_sync_kind: SyncKind::Full,
        error_prefix: "cpp_lsp",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_aligns_with_registry_entry() {
        let pack = pack();
        let entry = crate::lsp::registry::get_language_entry("cpp").unwrap();
        assert_eq!(pack.language_id, "cpp");
        assert_eq!(pack.command, entry.command);
        assert_eq!(entry.server, "clangd");
    }
}
