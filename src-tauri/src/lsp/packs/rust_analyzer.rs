use serde_json::json;

use super::{CwdPolicy, LanguagePack, Prerequisite, SyncKind};

/// Rust language pack (ADR-005 Slice 6).
///
/// rust-analyzer is a managed-tier server: it arrives through the verified
/// download manager (registry language `rust`), or via global PATH for
/// users who already have it. There is no bundled tier — the resolver's
/// not-resolved error is the honest "not installed yet" state that feeds
/// the file-open consent pill.
pub(crate) fn pack() -> LanguagePack {
    LanguagePack {
        language_id: "rust",
        prerequisites: vec![Prerequisite {
            // Toolchain honesty (ADR-005 Scope Notes): detected and hinted,
            // never installed. rust-analyzer runs without cargo but is
            // near-useless on a machine that cannot build the project.
            display_name: "Rust toolchain (cargo)",
            command: "cargo",
            version_arg: "--version",
            min_version: "",
            satisfied_by_bundle: false,
        }],
        command: "rust-analyzer",
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
            // Rust-specific
            "CARGO_HOME",
            "RUSTUP_HOME",
        ],
        client_capabilities: native_server_client_capabilities(),
        initialization_options: json!({}),
        // First start indexes the crate graph; initialize itself answers
        // quickly but allow headroom on cold caches.
        startup_timeout_ms: 15_000,
        document_sync_kind: SyncKind::Full,
        error_prefix: "rust_lsp",
    }
}

/// Minimal client capabilities — the same conservative surface the Python
/// pack declares: only what Litria actually wires up.
pub(super) fn native_server_client_capabilities() -> serde_json::Value {
    json!({
        "workspace": {
            "configuration": true,
            "didChangeConfiguration": {
                "dynamicRegistration": false
            },
            "workspaceFolders": true
        },
        "textDocument": {
            "synchronization": {
                "dynamicRegistration": false,
                "willSave": false,
                "willSaveWaitUntil": false,
                "didSave": false
            },
            "publishDiagnostics": {
                "relatedInformation": true,
                "versionSupport": false,
                "tagSupport": {
                    "valueSet": [1, 2]
                }
            },
            "hover": {
                "dynamicRegistration": false,
                "contentFormat": ["markdown", "plaintext"]
            },
            "completion": {
                "dynamicRegistration": false,
                "completionItem": {
                    "snippetSupport": false,
                    "commitCharactersSupport": false,
                    "documentationFormat": ["markdown", "plaintext"],
                    "deprecatedSupport": true,
                    "preselectSupport": true
                },
                "contextSupport": true
            },
            "signatureHelp": {
                "dynamicRegistration": false,
                "signatureInformation": {
                    "documentationFormat": ["markdown", "plaintext"],
                    "parameterInformation": {
                        "labelOffsetSupport": true
                    },
                    "activeParameterSupport": true
                }
            },
            "definition": {
                "dynamicRegistration": false,
                "linkSupport": false
            },
            "documentSymbol": {
                "dynamicRegistration": false,
                "hierarchicalDocumentSymbolSupport": false
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_aligns_with_registry_entry() {
        // probe_managed maps pack.language_id -> registry entry -> receipt;
        // this contract holds the whole managed tier together.
        let pack = pack();
        let entry = crate::lsp::registry::get_language_entry("rust").unwrap();
        assert_eq!(pack.language_id, "rust");
        assert_eq!(pack.command, entry.command);
        assert_eq!(entry.server, "rust-analyzer");
    }
}
