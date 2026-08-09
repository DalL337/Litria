use serde_json::json;

use super::{rust_analyzer, CwdPolicy, LanguagePack, Prerequisite, SyncKind};

/// Go language pack (ADR-005 Slice 6.5 — "Go via toolchain").
///
/// gopls ships NO prebuilt binaries (ADR-005 erratum), so Go is
/// deliberately absent from the managed registry: acquisition is class-3 —
/// the consent pill types a pinned `go install golang.org/x/tools/gopls@vX`
/// into the visible terminal and the user executes it (integrity comes from
/// Go's sum.golang.org checksum database). The resolver finds the result on
/// PATH or in `go env GOPATH`/bin, where `go install` actually puts it.
pub(crate) fn pack() -> LanguagePack {
    LanguagePack {
        language_id: "go",
        prerequisites: vec![Prerequisite {
            // Toolchain honesty (ADR-005 Scope Notes): detected and hinted,
            // never installed. Unlike rust-analyzer, gopls genuinely cannot
            // function without the go toolchain — it shells out to `go` for
            // module loading — but the probe stays advisory like every other
            // prerequisite (session start does not enforce probes).
            display_name: "Go toolchain (go)",
            command: "go",
            version_arg: "version",
            min_version: "",
            satisfied_by_bundle: false,
        }],
        command: "gopls",
        args: vec![],
        version_probe_arg: "version",
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
            // Go-specific: gopls shells out to `go`, which needs its caches
            // and module locations to resolve the workspace.
            "GOPATH",
            "GOROOT",
            "GOCACHE",
            "GOMODCACHE",
        ],
        client_capabilities: rust_analyzer::native_server_client_capabilities(),
        initialization_options: json!({}),
        // First start loads the module graph via the go toolchain; allow the
        // same cold-cache headroom as rust-analyzer.
        startup_timeout_ms: 15_000,
        document_sync_kind: SyncKind::Full,
        error_prefix: "go_lsp",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn go_is_toolchain_tier_not_registry_tier() {
        // Class-3 by design (ADR-005 erratum: no gopls prebuilt binaries):
        // the pack exists so sessions and probes work, but the managed
        // registry must NOT claim the language — no verified-artifact
        // install path exists for it.
        let pack = pack();
        assert_eq!(pack.language_id, "go");
        assert_eq!(pack.command, "gopls");
        assert!(crate::lsp::registry::get_language_entry("go").is_none());
    }

    #[test]
    fn go_toolchain_is_probed_but_advisory() {
        let pack = pack();
        assert_eq!(pack.prerequisites.len(), 1);
        let prereq = &pack.prerequisites[0];
        assert_eq!(prereq.command, "go");
        assert_eq!(prereq.version_arg, "version");
        assert!(prereq.min_version.is_empty());
        assert!(!prereq.satisfied_by_bundle);
    }
}
