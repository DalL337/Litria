use serde_json::json;

use super::{versions, CwdPolicy, LanguagePack, Prerequisite, SyncKind};

/// Return the Python language pack (pyright-langserver reference implementation).
pub(crate) fn pack() -> LanguagePack {
    LanguagePack {
        language_id: "python",
        prerequisites: vec![
            Prerequisite {
                display_name: "Python runtime",
                command: "python",
                version_arg: "--version",
                min_version: "3.8",
                satisfied_by_bundle: false, // user's project dependency
            },
            Prerequisite {
                display_name: "Node.js runtime",
                command: "node",
                version_arg: "--version",
                min_version: "18",
                satisfied_by_bundle: true, // shipped in resources/node/
            },
            Prerequisite {
                display_name: "pyright-langserver",
                command: "pyright",
                version_arg: "--version",
                min_version: "",
                satisfied_by_bundle: true, // shipped in resources/servers/python/
            },
        ],
        command: "pyright-langserver",
        args: vec!["--stdio"],
        version_probe_arg: "--version",
        // pyright-langserver has NO version/help argv — it exits 1 trying to
        // open an LSP connection ("Connection input stream is not set"), so
        // probing it directly rejects every healthy install (2026-07-17 dev
        // crash-loop). The sibling CLI proves the package runs.
        version_probe_command: Some("pyright"),
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
            // Python venv discovery — pyright reads these to find the active
            // environment. PYTHONPATH is deliberately NOT forwarded (audit #8):
            // pyright resolves imports via venvPath/extraPaths config, not the
            // parent's PYTHONPATH, so passing it through only adds an injection
            // vector for a compromised parent environment.
            "VIRTUAL_ENV",
            "CONDA_PREFIX",
        ],
        client_capabilities: pyright_client_capabilities(),
        initialization_options: json!({}),
        startup_timeout_ms: 10_000,
        document_sync_kind: SyncKind::Full,
        error_prefix: "python_lsp",
    }
}

/// Minimal client capabilities accepted by pyright-langserver.
///
/// Pyright validates the initialize request and silently misbehaves if the
/// capabilities object is malformed.  Declare only what CM actually uses so
/// the server does not try to send features we haven't wired up yet.
fn pyright_client_capabilities() -> serde_json::Value {
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
                    "preselectSupport": false
                },
                "contextSupport": false
            },
            "signatureHelp": {
                "dynamicRegistration": false,
                "signatureInformation": {
                    "documentationFormat": ["markdown", "plaintext"],
                    "parameterInformation": {
                        "labelOffsetSupport": false
                    }
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

// ---------------------------------------------------------------------------
// Auto-install hint (used by the prerequisites UI)
// ---------------------------------------------------------------------------

/// The npm command a user should run to install pyright at the pinned version.
// Not yet called — the consumer is ADR-005's missing-server hint surface
// (pill→card consent, slices 3-7 pending).
#[allow(dead_code)]
pub(crate) fn install_hint() -> String {
    format!(
        "npm install -g pyright@{}",
        versions::PYRIGHT_VERSION
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_allowlist_omits_pythonpath_but_keeps_venv_discovery() {
        let p = pack();
        // PYTHONPATH is an injection vector and not pyright's resolution
        // mechanism (audit #8) — it must not be forwarded.
        assert!(!p.env_allowlist.contains(&"PYTHONPATH"));
        // Legitimate venv-discovery + base vars are retained.
        assert!(p.env_allowlist.contains(&"VIRTUAL_ENV"));
        assert!(p.env_allowlist.contains(&"CONDA_PREFIX"));
        assert!(p.env_allowlist.contains(&"PATH"));
    }
}
