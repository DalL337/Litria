//! The disclosure policy (Project API contract brief §6).
//!
//! One place decides, for every project-relative path, whether the API may
//! disclose it. It is applied before any output is built, to the requested
//! path AND to its canonical target, so a link inside the project cannot
//! reach a denied file under an innocent name. Rust owns these rules alone;
//! the frontend bridge never sees them.
//!
//! Not a confidentiality guarantee: source files can hold secrets no rule
//! anticipates, and an agent runtime's native tools bypass this policy
//! entirely (ADR-031 decision 5).

use crate::project_tree;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Class {
    /// Never disclosed on any surface; an explicit read answers `denied`
    /// without touching the filesystem.
    Denied,
    /// Skipped by search and graph enumeration; readable by explicit path.
    #[cfg_attr(not(test), allow(dead_code))] // consumed by search (build plan P3)
    Unindexed,
    Allowed,
}

/// Exact segment names, in lower case. `.git` covers both the directory and
/// the file form a worktree or submodule uses.
const DENIED_NAMES: &[&str] = &[
    // Litria's own state.
    ".litria",
    "litria.toml",
    // Version-control internals.
    ".git",
    ".hg",
    ".svn",
    // Environment files; `.env.*` is a prefix below.
    ".env",
    // Credential files and directories.
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".git-credentials",
    ".ssh",
    ".aws",
    ".gnupg",
];

/// Segment prefixes: every `.env.*` (templates included in v1) and SSH keys.
const DENIED_PREFIXES: &[&str] = &[".env.", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];

/// Segment suffixes: key and certificate material.
const DENIED_SUFFIXES: &[&str] = &[".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];

/// ASCII case-insensitive on every platform: Windows and default macOS
/// volumes do not distinguish `.ENV` from `.env`.
fn is_denied_segment(segment: &str) -> bool {
    let lower = segment.to_ascii_lowercase();
    DENIED_NAMES.contains(&lower.as_str())
        || DENIED_PREFIXES.iter().any(|prefix| lower.starts_with(prefix))
        || DENIED_SUFFIXES.iter().any(|suffix| lower.ends_with(suffix))
}

/// Classify a forward-slash project-relative path. A pattern matches a
/// segment at any depth. Denied wins: `.git` and `.litria` are also in the
/// unindexed directory list, and must never become readable by explicit path.
pub(crate) fn classify(path: &str) -> Class {
    let segments: Vec<&str> = path.split('/').collect();
    if segments.iter().any(|segment| is_denied_segment(segment)) {
        return Class::Denied;
    }
    let directories = &segments[..segments.len().saturating_sub(1)];
    if directories.iter().any(|segment| project_tree::is_ignored_dir(segment)) {
        Class::Unindexed
    } else {
        Class::Allowed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denies_every_listed_pattern_at_the_root_and_in_depth() {
        for name in [
            ".litria/workspace.db",
            "litria.toml",
            ".git",
            ".git/config",
            ".hg/store",
            ".svn/entries",
            ".env",
            ".env.local",
            ".env.example",
            ".npmrc",
            ".pypirc",
            ".netrc",
            ".git-credentials",
            ".ssh/config",
            ".aws/credentials",
            ".gnupg/pubring.kbx",
            "certs/server.pem",
            "tls/private.key",
            "store.p12",
            "store.pfx",
            "release.jks",
            "android.keystore",
            "id_rsa",
            "id_rsa.pub",
            "id_dsa",
            "id_ecdsa",
            "id_ed25519",
        ] {
            assert_eq!(classify(name), Class::Denied, "{name} at the root");
            let nested = format!("services/api/{name}");
            assert_eq!(classify(&nested), Class::Denied, "{nested} in depth");
        }
    }

    #[test]
    fn matching_ignores_ascii_case() {
        for name in [".ENV", ".Env.Local", "ID_RSA", "Server.PEM", ".GIT/config", "LITRIA.TOML", ".Litria/x"] {
            assert_eq!(classify(name), Class::Denied, "{name}");
        }
    }

    /// Denied wins over unindexed: both lists hold `.git` and `.litria`.
    #[test]
    fn denied_wins_over_unindexed() {
        assert!(project_tree::is_ignored_dir(".git") && project_tree::is_ignored_dir(".litria"));
        assert_eq!(classify(".git/config"), Class::Denied);
        assert_eq!(classify(".litria/workspace.db"), Class::Denied);
        assert_eq!(classify("node_modules/pkg/.env"), Class::Denied);
    }

    #[test]
    fn dependency_and_build_trees_are_unindexed_not_denied() {
        for path in ["node_modules/pkg/index.d.ts", "target/debug/build.log", "a/dist/b.js", ".venv/lib/site.py"] {
            assert_eq!(classify(path), Class::Unindexed, "{path}");
        }
        // Only directory segments count: a FILE named like one is allowed.
        assert_eq!(classify("scripts/build"), Class::Allowed);
    }

    #[test]
    fn ordinary_files_are_allowed() {
        for path in [
            "README.md",
            "src/main.ts",
            ".gitignore",
            ".github/workflows/ci.yml",
            "environment.py",
            "docs/keys.md",
            "monkey.txt",
            "src/env/config.ts",
        ] {
            assert_eq!(classify(path), Class::Allowed, "{path}");
        }
    }
}
