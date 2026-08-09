//! Curated language-server registry (ADR-005 §3-§4, Slice 3).
//!
//! The registry is BAKED IN at compile time (`include_str!`) — zero network
//! in v1; update checks are local diffs between `installed.json` receipts and
//! this shipped registry. The JSON lives at
//! `resources/language-server-registry.json` (flat schema per
//! `docs/plans/lsp/registry-schema-draft.md`, normative) so registry bumps
//! are reviewable data changes, not code changes.
//!
//! v1 catalog note: gopls has NO prebuilt release assets on golang/tools
//! (verified 2026-07-13 — every gopls/v* tag ships zero assets), so Go is
//! absent here. Go support arrives as a toolchain-honest visible-terminal
//! hint (`go install golang.org/x/tools/gopls@latest`), not a managed
//! artifact — see the ADR erratum in the Slice 3 PR.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::errors::{CommandError, CommandResult};

const REGISTRY_JSON: &str = include_str!("../../resources/language-server-registry.json");

// ---------------------------------------------------------------------------
// Schema (flat, registry-schema-draft.md is normative)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Registry {
    /// Schema version — bumped only on breaking shape changes.
    pub version: u32,
    /// language_id → server definition.
    pub servers: HashMap<String, ServerEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ServerEntry {
    /// Human-readable name for the consent surface and settings.
    pub name: String,
    /// File extensions that make this language "desired" (reconciler input).
    pub extensions: Vec<String>,
    /// Server identifier — names the managed install dir.
    pub server: String,
    /// Upstream version string (formats vary; names the version-stamped dir,
    /// drives receipt-vs-registry update detection).
    pub version: String,
    /// Binary name to execute after install.
    pub command: String,
    /// Launch args (per-server data, pinned to what we conformance-test).
    pub args: Vec<String>,
    /// platform key → artifact. Only listed platforms are supported.
    pub artifacts: HashMap<String, Artifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Artifact {
    /// Direct HTTPS download URL from the official distributor.
    pub url: String,
    /// SHA-256 of the downloaded file — verified BEFORE extraction (§2).
    pub sha256: String,
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

static REGISTRY: OnceLock<Result<Registry, String>> = OnceLock::new();

/// Parse-once accessor. A malformed baked registry is a build defect, not a
/// user-state problem — it surfaces as a graceful command error (and the
/// parse round-trip test below makes shipping one effectively impossible).
pub(crate) fn load_registry() -> Result<&'static Registry, String> {
    REGISTRY
        .get_or_init(|| parse_registry(REGISTRY_JSON))
        .as_ref()
        .map_err(|e| e.clone())
}

fn parse_registry(json: &str) -> Result<Registry, String> {
    let registry: Registry = serde_json::from_str(json)
        .map_err(|e| format!("language-server-registry.json is malformed: {e}"))?;
    for (language_id, entry) in &registry.servers {
        if entry.version.trim().is_empty() {
            return Err(format!(
                "registry entry '{language_id}' is missing its required version string"
            ));
        }
        for (platform, artifact) in &entry.artifacts {
            if !artifact.url.starts_with("https://") {
                return Err(format!(
                    "registry entry '{language_id}' ({platform}) has a non-HTTPS url"
                ));
            }
            if artifact.sha256.len() != 64
                || !artifact.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(format!(
                    "registry entry '{language_id}' ({platform}) has an invalid sha256"
                ));
            }
        }
    }
    Ok(registry)
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/// Registry entry for a language, if curated.
pub(crate) fn get_language_entry(language_id: &str) -> Option<&'static ServerEntry> {
    load_registry().ok()?.servers.get(language_id)
}

/// Map a file extension (with leading dot, case-insensitive) to the
/// registry language that wants it.
// Consumed by Slice 5 (file-open reconciler trigger) — arc-internal allow.
#[allow(dead_code)]
pub(crate) fn match_extension_to_language(ext: &str) -> Option<String> {
    let registry = load_registry().ok()?;
    let needle = ext.to_ascii_lowercase();
    registry
        .servers
        .iter()
        .find(|(_, entry)| entry.extensions.iter().any(|e| e.eq_ignore_ascii_case(&needle)))
        .map(|(language_id, _)| language_id.clone())
}

// ---------------------------------------------------------------------------
// Platform resolution
// ---------------------------------------------------------------------------

/// The registry platform key for the running build.
pub(crate) fn get_platform_key() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x64"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-arm64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-arm64"
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64")
    )))]
    {
        // Unknown target: resolve_artifact reports "no build for this
        // platform" instead of the build breaking (§5.2 fallback behavior).
        "unsupported"
    }
}

/// The artifact for this platform, or a clear unsupported-platform message
/// (never a crash — build plan 3c).
pub(crate) fn resolve_artifact(entry: &ServerEntry) -> Result<&Artifact, String> {
    let key = get_platform_key();
    entry.artifacts.get(key).ok_or_else(|| {
        format!(
            "{} {} has no build for this platform ({key}). Supported: {}.",
            entry.server,
            entry.version,
            {
                let mut platforms: Vec<&str> =
                    entry.artifacts.keys().map(String::as_str).collect();
                platforms.sort_unstable();
                platforms.join(", ")
            }
        )
    })
}

// ---------------------------------------------------------------------------
// Tauri command payload
// ---------------------------------------------------------------------------

/// Frontend-facing registry view: the full curated map plus this build's
/// platform key, so the UI can grey out unsupported entries honestly.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegistryPayload {
    pub registry: Registry,
    pub platform_key: String,
    /// server_id → installed (active) version, from managed receipts — lets
    /// the consent surface tell installed from available (Slice 5).
    pub installed: HashMap<String, String>,
}

pub(crate) fn registry_payload() -> CommandResult<RegistryPayload> {
    let registry = load_registry()
        .map_err(|e| CommandError::internal("lsp.registry.malformed", e))?;
    Ok(RegistryPayload {
        registry: registry.clone(),
        platform_key: get_platform_key().to_string(),
        installed: crate::lsp::download::installed_versions(),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baked_registry_parses_and_validates() {
        let registry = load_registry().expect("shipped registry must parse");
        assert_eq!(registry.version, 1);
        assert!(registry.servers.contains_key("rust"));
        assert!(registry.servers.contains_key("cpp"));
    }

    #[test]
    fn v1_catalog_reflects_reality_not_the_plan() {
        // gopls ships no prebuilt binaries (verified 2026-07-13) — if someone
        // adds a `go` entry, they found a real distributor: make them prove
        // it by updating this test alongside the ADR erratum.
        assert!(get_language_entry("go").is_none());
    }

    #[test]
    fn every_artifact_is_https_with_exact_sha256() {
        let registry = load_registry().unwrap();
        for entry in registry.servers.values() {
            assert!(!entry.artifacts.is_empty());
            for artifact in entry.artifacts.values() {
                assert!(artifact.url.starts_with("https://github.com/"));
                assert_eq!(artifact.sha256.len(), 64);
            }
        }
    }

    #[test]
    fn versions_are_safe_directory_names() {
        // The version string names the version-stamped install dir (ADR §1).
        let registry = load_registry().unwrap();
        for entry in registry.servers.values() {
            assert!(entry
                .version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-'));
        }
    }

    #[test]
    fn extension_matching_resolves_registry_languages() {
        assert_eq!(match_extension_to_language(".rs").as_deref(), Some("rust"));
        assert_eq!(match_extension_to_language(".RS").as_deref(), Some("rust"));
        assert_eq!(match_extension_to_language(".cpp").as_deref(), Some("cpp"));
        assert_eq!(match_extension_to_language(".hpp").as_deref(), Some("cpp"));
        assert_eq!(match_extension_to_language(".py"), None);
        assert_eq!(match_extension_to_language(".xyz"), None);
    }

    #[test]
    fn platform_key_is_a_known_registry_key() {
        assert!([
            "windows-x64",
            "darwin-x64",
            "darwin-arm64",
            "linux-x64",
            "linux-arm64"
        ]
        .contains(&get_platform_key()));
    }

    #[test]
    fn artifact_resolution_errors_clearly_on_missing_platform() {
        let entry = ServerEntry {
            name: "Test".into(),
            extensions: vec![".t".into()],
            server: "test-server".into(),
            version: "1.0.0".into(),
            command: "test-server".into(),
            args: vec![],
            artifacts: HashMap::new(),
        };
        let err = resolve_artifact(&entry).unwrap_err();
        assert!(err.contains("no build for this platform"));
        assert!(err.contains("test-server 1.0.0"));
    }

    #[test]
    fn malformed_registry_is_a_graceful_error() {
        assert!(parse_registry("not json").is_err());
        assert!(parse_registry(r#"{"version":1,"servers":{}}"#).is_ok());
        // Missing required version string on an entry.
        let missing_version = r#"{"version":1,"servers":{"x":{
            "name":"X","extensions":[".x"],"server":"x","version":"  ",
            "command":"x","args":[],"artifacts":{}}}}"#;
        assert!(parse_registry(missing_version).unwrap_err().contains("version"));
        // Non-HTTPS url refused.
        let http_url = r#"{"version":1,"servers":{"x":{
            "name":"X","extensions":[".x"],"server":"x","version":"1",
            "command":"x","args":[],
            "artifacts":{"linux-x64":{"url":"http://evil","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}}}}}"#;
        assert!(parse_registry(http_url).unwrap_err().contains("non-HTTPS"));
    }
}
