use serde_json::json;

use super::{versions, CwdPolicy, LanguagePack, Prerequisite, SyncKind};

/// Return the TypeScript / JavaScript language pack.
///
/// A single `typescript-language-server` session handles both `.ts` and `.js`
/// files within a project — tsserver is designed this way.  The LSP session
/// language ID is always `"typescript"`.  Individual `textDocument/didOpen`
/// notifications carry the per-file language ID (`typescript` or `javascript`).
pub(crate) fn pack() -> LanguagePack {
    LanguagePack {
        language_id: "typescript",
        prerequisites: vec![
            Prerequisite {
                display_name: "Node.js runtime",
                command: "node",
                version_arg: "--version",
                min_version: "18",
                satisfied_by_bundle: true, // shipped in resources/node/
            },
            Prerequisite {
                display_name: "typescript-language-server",
                command: "typescript-language-server",
                version_arg: "--version",
                min_version: "",
                satisfied_by_bundle: true, // shipped in resources/servers/typescript/
            },
            Prerequisite {
                display_name: "TypeScript compiler (tsc)",
                command: "tsc",
                version_arg: "--version",
                min_version: "",
                satisfied_by_bundle: true, // shipped in resources/servers/typescript/
            },
        ],
        command: "typescript-language-server",
        args: vec!["--stdio"],
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
            // NODE_ENV (a mode flag, not a path) is safe to forward. NODE_PATH
            // is deliberately NOT forwarded (audit #8): typescript-language-server
            // resolves modules via tsconfig/node_modules, not node's global
            // NODE_PATH, so passing the parent's value only adds an injection
            // vector for a compromised parent environment.
            "NODE_ENV",
        ],
        client_capabilities: tsserver_client_capabilities(),
        initialization_options: json!({
            "preferences": {
                "includeInlayParameterNameHints": "none",
                "includeInlayParameterNameHintsWhenArgumentMatchesName": false,
                "includeInlayFunctionParameterTypeHints": false,
                "includeInlayVariableTypeHints": false,
                "includeInlayPropertyDeclarationTypeHints": false,
                "includeInlayFunctionLikeReturnTypeHints": false,
                "includeInlayEnumMemberValueHints": false,
                "importModuleSpecifierPreference": "auto",
                "quotePreference": "auto",
                "allowIncompleteCompletions": true,
                "allowRenameOfImportPath": true
            },
            "tsserver": {
                "logVerbosity": "off"
            }
        }),
        // typescript-language-server spawns tsserver as a child process;
        // allow extra time for the tsserver handshake on first start.
        startup_timeout_ms: 15_000,
        document_sync_kind: SyncKind::Full,
        error_prefix: "typescript_lsp",
    }
}

/// Minimal client capabilities for typescript-language-server.
///
/// Mirrors the Python pack, extended with TypeScript-specific features:
/// rich completions with label details, active-parameter signatureHelp,
/// and codeAction support (organise imports, quickfix).
fn tsserver_client_capabilities() -> serde_json::Value {
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
                    "preselectSupport": true,
                    "labelDetailsSupport": true
                },
                "completionItemKind": {
                    "valueSet": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25]
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
                },
                "contextSupport": false
            },
            "definition": {
                "dynamicRegistration": false,
                "linkSupport": false
            },
            "documentSymbol": {
                "dynamicRegistration": false,
                "hierarchicalDocumentSymbolSupport": false
            },
            "codeAction": {
                "dynamicRegistration": false,
                "codeActionLiteralSupport": {
                    "codeActionKind": {
                        "valueSet": [
                            "quickfix",
                            "refactor",
                            "refactor.extract",
                            "refactor.inline",
                            "refactor.rewrite",
                            "source",
                            "source.organizeImports"
                        ]
                    }
                }
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Auto-install hint (used by the prerequisites UI)
// ---------------------------------------------------------------------------

/// The npm command a user should run to install typescript-language-server
/// and the TypeScript compiler at pinned versions.
// Not yet called — the consumer is ADR-005's missing-server hint surface
// (pill→card consent, slices 3-7 pending).
#[allow(dead_code)]
pub(crate) fn install_hint() -> String {
    format!(
        "npm install -g typescript@{} typescript-language-server@{}",
        versions::TYPESCRIPT_VERSION,
        versions::TSSERVER_VERSION,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_allowlist_omits_node_path() {
        let p = pack();
        // NODE_PATH is an injection vector and not tsserver's module-resolution
        // mechanism (audit #8) — it must not be forwarded.
        assert!(!p.env_allowlist.contains(&"NODE_PATH"));
        // The mode flag and base vars are retained.
        assert!(p.env_allowlist.contains(&"NODE_ENV"));
        assert!(p.env_allowlist.contains(&"PATH"));
    }
}
