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

use std::path::Path;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::Match;

use crate::contracts::project_api::project_context::DeniedClass;
use crate::project_tree;

/// The global preference holding the user's own withheld patterns (brief §6,
/// §15 Q1; owner ruling 2026-10-01). They can only ADD to what is denied.
pub(crate) const USER_EXCLUSIONS_KEY: &str = "apiWithheldPaths";

/// The user's withheld patterns, compiled: `.gitignore` syntax, separated by
/// commas or new lines, matched against the project-relative path and every
/// parent directory. ASCII case-insensitive on every platform, like the
/// built-in rules: this is a disclosure rule, so it errs toward withholding.
///
/// `Unavailable` (the preference exists but cannot be read, parsed or
/// compiled, including one invalid pattern) withholds EVERYTHING until it is
/// fixed. The user meant to withhold something; failing open would disclose
/// it (Codex review F1, 2026-10-01).
#[derive(Default)]
enum UserExclusions {
    #[default]
    Absent,
    Rules(Gitignore),
    Unavailable,
}

impl UserExclusions {
    /// Whether anything is withheld: the summary names the class then.
    fn active(&self) -> bool {
        !matches!(self, UserExclusions::Absent)
    }

    /// Judged by the names Windows would open (trailing dots and spaces
    /// removed), like the built-in rules. A path that cannot be judged is
    /// withheld.
    fn withholds(&self, segments: &[&str], is_dir: bool) -> bool {
        let rules = match self {
            UserExclusions::Absent => return false,
            UserExclusions::Unavailable => return true,
            UserExclusions::Rules(rules) => rules,
        };
        let path = segments.iter().map(|segment| effective_segment(segment)).collect::<Vec<_>>().join("/");
        if path.is_empty() || Path::new(&path).has_root() {
            return true;
        }
        matches!(rules.matched_path_or_any_parents(&path, is_dir), Match::Ignore(_))
    }
}

fn compile_user_exclusions(text: &str) -> UserExclusions {
    let mut builder = GitignoreBuilder::new("");
    if builder.case_insensitive(true).is_err() {
        return UserExclusions::Unavailable;
    }
    let mut any = false;
    for pattern in text.split([',', '\n']).map(str::trim).filter(|pattern| !pattern.is_empty()) {
        if builder.add_line(None, pattern).is_err() {
            return UserExclusions::Unavailable;
        }
        any = true;
    }
    if !any {
        return UserExclusions::Absent;
    }
    match builder.build() {
        Ok(rules) if rules.is_empty() => UserExclusions::Absent, // comments only
        Ok(rules) => UserExclusions::Rules(rules),
        Err(_) => UserExclusions::Unavailable,
    }
}

/// The preference as found in the preferences folder: absent (no file, no
/// key, or a null value) means no restriction; text compiles; anything else
/// (unreadable or unparseable file, a non-text value, no known folder) is
/// `Unavailable`.
fn load_user_exclusions(dir: Option<&Path>) -> UserExclusions {
    let Some(dir) = dir else {
        return UserExclusions::Unavailable;
    };
    match crate::preferences::global_text(dir, USER_EXCLUSIONS_KEY) {
        Ok(None) => UserExclusions::Absent,
        Ok(Some(text)) => compile_user_exclusions(&text),
        Err(_) => UserExclusions::Unavailable,
    }
}

/// Production: loaded from the preferences file on first use, then replaced
/// whenever Preferences saves the key (`preferences::prefs_save_global`). A
/// hand edit of the file while Litria runs applies on the next launch.
#[cfg(not(test))]
fn user_exclusions_cell() -> &'static std::sync::RwLock<UserExclusions> {
    static CELL: std::sync::OnceLock<std::sync::RwLock<UserExclusions>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        let dir = crate::preferences::preferences_dir().ok();
        std::sync::RwLock::new(load_user_exclusions(dir.as_deref()))
    })
}

// Tests: per thread, so tests running in parallel never see each other's
// patterns.
#[cfg(test)]
thread_local! {
    static TEST_USER_EXCLUSIONS: std::cell::RefCell<UserExclusions> = std::cell::RefCell::new(UserExclusions::default());
}

fn with_user_exclusions<R>(read: impl FnOnce(&UserExclusions) -> R) -> R {
    #[cfg(test)]
    {
        TEST_USER_EXCLUSIONS.with(|cell| read(&cell.borrow()))
    }
    #[cfg(not(test))]
    {
        let guard = user_exclusions_cell().read().unwrap_or_else(|poisoned| poisoned.into_inner());
        read(&guard)
    }
}

fn replace_user_exclusions(next: UserExclusions) {
    #[cfg(test)]
    TEST_USER_EXCLUSIONS.with(|cell| *cell.borrow_mut() = next);
    #[cfg(not(test))]
    {
        *user_exclusions_cell().write().unwrap_or_else(|poisoned| poisoned.into_inner()) = next;
    }
}

/// Replace the user's withheld patterns with a saved preference value: text
/// compiles, null clears, any other value is `Unavailable` (withholds all).
pub(crate) fn set_user_exclusions_value(value: &serde_json::Value) {
    replace_user_exclusions(match value {
        serde_json::Value::String(text) => compile_user_exclusions(text),
        serde_json::Value::Null => UserExclusions::Absent,
        _ => UserExclusions::Unavailable,
    });
}

/// Replace the user's withheld patterns with text (tests; production saves go
/// through `set_user_exclusions_value`).
#[cfg(test)]
pub(crate) fn set_user_exclusions(text: &str) {
    replace_user_exclusions(compile_user_exclusions(text));
}

fn is_user_excluded(segments: &[&str], is_dir: bool) -> bool {
    with_user_exclusions(|user| user.withholds(segments, is_dir))
}

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
    // Every `.env.*` except the template FILES in `ENV_TEMPLATES`.
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

/// Environment templates, readable by default (owner ruling 2026-10-01, brief
/// §15 Q3): they document which variables exist and normally hold no secrets.
/// Exact names only, and only as a file name: `.env.example.local`, a
/// directory named `.env.example`, and every other `.env.*` stay denied. A
/// link named like a template is still judged by its target.
const ENV_TEMPLATES: &[&str] = &[".env.example", ".env.sample", ".env.template", ".env.dist"];

/// The denied classes, in table order.
/// The user's own class comes last, and only while they withhold anything:
/// the summary names it, never the patterns themselves.
pub(crate) fn denied_classes() -> Vec<DeniedClass> {
    let mut classes: Vec<DeniedClass> = DENIED.iter().map(|rule| rule.class).collect();
    if with_user_exclusions(UserExclusions::active) {
        classes.push(DeniedClass::UserExclusions);
    }
    classes
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

/// Whether a FILE name is one of the readable environment templates.
fn is_env_template(segment: &str) -> bool {
    let lower = effective_segment(segment).to_ascii_lowercase();
    ENV_TEMPLATES.contains(&lower.as_str())
}

fn classify_segments(path: &str, last_is_directory: bool) -> Class {
    let segments: Vec<&str> = path.split('/').collect();
    let last = segments.len() - 1;
    let denied = segments.iter().enumerate().any(|(index, segment)| {
        is_denied_segment(segment) && !(index == last && !last_is_directory && is_env_template(segment))
    });
    if denied || is_user_excluded(&segments, last_is_directory) {
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
pub(crate) mod tests {
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
            ".env.example.local",
            ".env.production",
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

    /// Sets the user's patterns for one test and clears them when dropped,
    /// even if the test fails.
    pub(crate) struct Withholding;

    impl Withholding {
        pub(crate) fn patterns(text: &str) -> Self {
            set_user_exclusions(text);
            Withholding
        }
    }

    impl Drop for Withholding {
        fn drop(&mut self) {
            set_user_exclusions("");
        }
    }

    /// Brief §15 Q1 (owner ruling 2026-10-01): the user's own patterns add
    /// to what is denied, at any depth and in any case.
    #[test]
    fn user_patterns_withhold_more() {
        let _user = Withholding::patterns("secrets/, *.sqlite\nnotes/private.md");
        for path in ["secrets/a.txt", "deep/secrets/b.json", "data/app.SQLITE", "notes/private.md", "Secrets./x"] {
            assert_eq!(classify(path), Class::Denied, "{path:?}");
        }
        assert_eq!(classify_directory("secrets"), Class::Denied);
        assert_eq!(classify("notes/public.md"), Class::Allowed);
        assert_eq!(classify("src/secrets.ts"), Class::Allowed, "`secrets/` names a directory");
        assert_eq!(denied_classes().last(), Some(&DeniedClass::UserExclusions));
    }

    /// Restrict-only: a negation re-includes nothing the built-in rules deny.
    #[test]
    fn user_patterns_never_widen_access() {
        let _user = Withholding::patterns("!.env, !id_rsa, !.git/config");
        for path in [".env", "id_rsa", ".git/config"] {
            assert_eq!(classify(path), Class::Denied, "{path}");
        }
    }

    /// Codex review F1 (2026-10-01): a withheld-paths preference that exists
    /// but cannot be read must withhold everything, not nothing.
    #[test]
    fn a_user_preference_that_cannot_be_read_withholds_everything() {
        let dir = std::env::temp_dir().join(format!("litria-policy-prefs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let anything = ["src", "a.ts"];

        assert!(!load_user_exclusions(Some(&dir)).withholds(&anything, false), "no file: no restriction");
        assert!(load_user_exclusions(None).withholds(&anything, false), "no known folder: withhold");

        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(crate::preferences::GLOBAL_FILE);
        for (content, what) in [
            ("[preferences]\napiWithheldPaths = \"private/\"\nunrelated = [\n", "unparseable file"),
            ("[preferences]\napiWithheldPaths = [\"private/\"]\n", "a value that is not text"),
            ("[preferences]\napiWithheldPaths = \"private/, {unclosed\"\n", "an invalid pattern"),
        ] {
            std::fs::write(&file, content).unwrap();
            let loaded = load_user_exclusions(Some(&dir));
            assert!(loaded.withholds(&anything, false), "{what}: must withhold everything");
            assert!(loaded.active(), "{what}: the summary must name the class");
        }

        std::fs::write(&file, "[preferences]\napiWithheldPaths = \"private/\"\n").unwrap();
        let loaded = load_user_exclusions(Some(&dir));
        assert!(loaded.withholds(&["private"], true));
        assert!(!loaded.withholds(&anything, false));

        std::fs::write(&file, "[preferences]\nsplashScreen = false\n").unwrap();
        assert!(!load_user_exclusions(Some(&dir)).active(), "key absent: no restriction");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The save hook: text compiles, null clears, anything else withholds all.
    #[test]
    fn a_saved_value_that_is_not_text_withholds_everything() {
        let _clear = Withholding::patterns("");
        set_user_exclusions_value(&serde_json::json!(["private/"]));
        assert_eq!(classify("src/a.ts"), Class::Denied);
        set_user_exclusions_value(&serde_json::Value::Null);
        assert_eq!(classify("src/a.ts"), Class::Allowed);
        set_user_exclusions_value(&serde_json::json!("private/"));
        assert_eq!(classify_directory("private"), Class::Denied);
        assert_eq!(classify("src/a.ts"), Class::Allowed);
    }

    #[test]
    fn without_user_patterns_the_class_is_not_listed() {
        let _user = Withholding::patterns(" , \n ");
        assert!(!denied_classes().contains(&DeniedClass::UserExclusions));
        assert_eq!(classify("anything/at/all.txt"), Class::Allowed);
    }

    /// Brief §15 Q3 (owner ruling 2026-10-01): environment templates are
    /// readable — as a file, by exact name, at any depth and in any case.
    /// Everything near them stays denied.
    #[test]
    fn environment_templates_are_readable_and_nothing_else_is() {
        for path in [
            ".env.example",
            ".env.sample",
            ".env.template",
            ".env.dist",
            "services/api/.env.example",
            ".ENV.EXAMPLE",
            ".env.example.",
        ] {
            assert_eq!(classify(path), Class::Allowed, "{path:?}");
        }
        for path in [
            ".env",
            ".env.examples",
            ".env.example.local",
            ".env.example.bak",
            "env.example/../.env",
            ".env.example/secrets.txt",
            ".env.local.example",
        ] {
            assert_eq!(classify(path), Class::Denied, "{path:?}");
        }
        assert_eq!(classify_directory(".env.example"), Class::Denied, "a directory, not a template file");
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
