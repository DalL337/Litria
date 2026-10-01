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

use crate::contracts::project_api::project_context::DeniedClass;
use crate::project_tree;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Class {
    /// Never disclosed on any surface; an explicit read answers `denied`
    /// without touching the filesystem.
    Denied,
    /// Skipped by search and graph enumeration; readable by explicit path.
    Unindexed,
    Allowed,
}

/// One class of withheld names. Patterns are lower case and match one path
/// segment: exactly, by prefix, or by suffix.
struct DeniedRule {
    class: DeniedClass,
    names: &'static [&'static str],
    prefixes: &'static [&'static str],
    suffixes: &'static [&'static str],
}

/// The denied classes and their patterns. `litria_project_context` names the
/// classes from this table, so the summary cannot drift from the rules.
const DENIED: &[DeniedRule] = &[
    DeniedRule {
        class: DeniedClass::LitriaState,
        names: &[".litria", "litria.toml"],
        prefixes: &[],
        suffixes: &[],
    },
    // `.git` covers both the directory and the file form a worktree or
    // submodule uses.
    DeniedRule {
        class: DeniedClass::VersionControl,
        names: &[".git", ".hg", ".svn"],
        prefixes: &[],
        suffixes: &[],
    },
    // Every `.env.*`, templates included in v1.
    DeniedRule {
        class: DeniedClass::EnvironmentFiles,
        names: &[".env"],
        prefixes: &[".env."],
        suffixes: &[],
    },
    DeniedRule {
        class: DeniedClass::KeyMaterial,
        names: &[],
        prefixes: &[],
        suffixes: &[".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"],
    },
    DeniedRule {
        class: DeniedClass::SshKeys,
        names: &[],
        prefixes: &["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"],
        suffixes: &[],
    },
    DeniedRule {
        class: DeniedClass::Credentials,
        names: &[".npmrc", ".pypirc", ".netrc", ".git-credentials", ".ssh", ".aws", ".gnupg"],
        prefixes: &[],
        suffixes: &[],
    },
];

/// The denied classes, in table order.
pub(crate) fn denied_classes() -> Vec<DeniedClass> {
    DENIED.iter().map(|rule| rule.class).collect()
}

/// The unindexed directory names, leaving out those the denied class already
/// withholds (`.git`, `.litria`): denied wins, so listing them as merely
/// unindexed would misdescribe them.
pub(crate) fn unindexed_directories() -> Vec<String> {
    project_tree::ignored_dirs()
        .iter()
        .filter(|name| !is_denied_segment(name))
        .map(|name| (*name).to_owned())
        .collect()
}

/// The name Windows opens for a segment: it strips trailing dots and spaces,
/// so `.env.` and `id_rsa ` are `.env` and `id_rsa`. API paths cannot carry
/// such names, but the search walker meets them on disk, and must judge them
/// by what they would open (P3 adversarial finding F3).
fn effective_segment(segment: &str) -> &str {
    segment.trim_end_matches(['.', ' '])
}

/// ASCII case-insensitive on every platform: Windows and default macOS
/// volumes do not distinguish `.ENV` from `.env`.
fn is_denied_segment(segment: &str) -> bool {
    let lower = effective_segment(segment).to_ascii_lowercase();
    DENIED.iter().any(|rule| {
        rule.names.contains(&lower.as_str())
            || rule.prefixes.iter().any(|prefix| lower.starts_with(prefix))
            || rule.suffixes.iter().any(|suffix| lower.ends_with(suffix))
    })
}

/// Classify a forward-slash project-relative FILE path. A pattern matches a
/// segment at any depth. Denied wins: `.git` and `.litria` are also in the
/// unindexed directory list, and must never become readable by explicit path.
pub(crate) fn classify(path: &str) -> Class {
    classify_segments(path, false)
}

/// Classify a path whose every segment is a directory, its last one
/// included: a directory the search walker meets, or a search prefix.
pub(crate) fn classify_directory(path: &str) -> Class {
    classify_segments(path, true)
}

fn classify_segments(path: &str, last_is_directory: bool) -> Class {
    let segments: Vec<&str> = path.split('/').collect();
    if segments.iter().any(|segment| is_denied_segment(segment)) {
        return Class::Denied;
    }
    let directories = if last_is_directory {
        &segments[..]
    } else {
        &segments[..segments.len().saturating_sub(1)]
    };
    if directories
        .iter()
        .any(|segment| project_tree::is_ignored_dir(effective_segment(segment)))
    {
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

    /// Trailing dots and spaces are what Windows strips: such a name is
    /// judged by the name it would open.
    #[test]
    fn names_are_judged_without_trailing_dots_and_spaces() {
        for name in [".env.", ".env ", "id_rsa.", "server.pem.", ".git./config", "a/.ssh /known_hosts"] {
            assert_eq!(classify(name), Class::Denied, "{name:?}");
        }
        assert_eq!(classify_directory("node_modules."), Class::Unindexed);
        assert_eq!(classify("notes."), Class::Allowed);
    }

    /// A directory is unindexed by its own name, not only by its parents'.
    #[test]
    fn directories_are_classified_by_every_segment() {
        assert_eq!(classify_directory("node_modules"), Class::Unindexed);
        assert_eq!(classify_directory("packages/app/dist"), Class::Unindexed);
        assert_eq!(classify_directory(".git"), Class::Denied, "denied still wins");
        assert_eq!(classify_directory("src/components"), Class::Allowed);
        // The same name as a FILE path's last segment stays allowed.
        assert_eq!(classify("scripts/build"), Class::Allowed);
    }

    /// Every class the context summary names has at least one pattern, and
    /// every pattern belongs to exactly one class.
    #[test]
    fn every_denied_class_is_named_once_and_has_patterns() {
        let classes = denied_classes();
        for (index, class) in classes.iter().enumerate() {
            assert!(!classes[index + 1..].contains(class), "{class:?} appears twice");
        }
        assert_eq!(classes.len(), 6);
        for rule in DENIED {
            assert!(
                !(rule.names.is_empty() && rule.prefixes.is_empty() && rule.suffixes.is_empty()),
                "{:?} has no patterns",
                rule.class
            );
        }
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
