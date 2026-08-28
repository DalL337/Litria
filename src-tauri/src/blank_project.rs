// Blank Project creation (New Project wizard, "Blank" template).
//
// Writes the stack-agnostic substrate every project needs regardless of
// language — README.md (stamped with one random quote from the pool),
// .gitignore, .editorconfig — into <location>/<name>. Deliberately NO
// starter code: Blank means the universal hygiene files, nothing to delete.
//
// The workspace bootstrap (.litria/, workspace.db, litria.toml) happens
// afterwards via db_bootstrap_project, which dedup-appends `.litria/` to
// .gitignore — already present in ours, so it no-ops.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::errors::{CommandError, CommandResult};
use crate::quote_pool;

const QUOTES_JSON: &str = include_str!("quotes.json");

/// The substrate, in creation order. README first — it's the canvas hero.
pub const SUBSTRATE_FILES: [&str; 3] = ["README.md", ".gitignore", ".editorconfig"];

/// Stack-agnostic ignore rules: OS junk, editor junk, logs, and Litria's
/// local workspace state — plus the Python canon (the one deliberate
/// language exception, ADR-020 Slice 0): a virtual environment created in a
/// blank-turned-Python project is the single worst thing to accidentally
/// commit, so its env/cache dirs are ignored everywhere.
pub const GITIGNORE_CONTENTS: &str = "\
# OS
.DS_Store
Thumbs.db
Desktop.ini

# Editors
.vscode/
.idea/
*.swp
*.swo

# Litria workspace (local state)
.litria/

# Logs
*.log

# Build output
dist/

# Python (ADR-020)
.venv/
venv/
__pycache__/
*.py[cod]
*.egg-info/
.pytest_cache/
.ruff_cache/
.mypy_cache/
.coverage

# Local secrets
.env
";

pub const EDITORCONFIG_CONTENTS: &str = "\
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlankProjectResult {
    pub project_path: String,
    /// Relative paths of the files written, in creation order. The frontend
    /// seeds these onto the canvas as the project's first nodes.
    pub created_files: Vec<String>,
}

/// `# name` heading plus one random quote as a blockquote.
pub fn readme_contents(name: &str) -> String {
    let quote = quote_pool::random_quote(QUOTES_JSON);
    format!("# {}\n\n{}", name, quote_pool::as_markdown(&quote))
}

/// A project name becomes a folder segment — reject anything that could
/// escape the chosen location or fail cross-platform. Shared with the
/// Python scaffold (python_scaffold.rs), which has the same folder-segment
/// contract.
pub(crate) fn validate_project_name(name: &str) -> Result<&str, CommandError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(CommandError::invalid_path(
            "blank_project.name.required",
            "Project name is required.",
        ));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(CommandError::invalid_path(
            "blank_project.name.invalid",
            "Project name cannot be a relative path segment.",
        ));
    }
    // Two classes here, both refused:
    //
    // * Path/Win32 illegal characters, which would escape the chosen location
    //   or fail outright as a folder segment.
    // * cmd.exe metacharacters. The name is not only a directory -- the
    //   scaffold runner passes it as an argument to `cmd /C <pm> create ...`
    //   on the Windows global package-manager path, and cmd re-parses the
    //   whole command line. Verified live 2026-08-27: `cmd /C show demo&marker`
    //   prints `ARG=[demo]` and then executes marker.bat, i.e. the name
    //   terminates the package-manager command and starts another program
    //   (CWE-78, external scan). `%` and `!` expand variables, `^` escapes,
    //   `()` group. Rust's own quoting does not save us here: it quotes an
    //   argument only when it contains whitespace or quotes, and cmd.exe does
    //   not follow MSVCRT parsing rules anyway.
    //
    // This is the blocklist half of the fix, and it is sufficient for the one
    // user-controlled value in that argv. The structural half -- resolving the
    // package-manager shim to an absolute path so cmd.exe never re-parses at
    // all, the way lsp/resolver.rs now does -- is the better long-term shape.
    const FORBIDDEN: &[char] = &[
        '/', '\\', ':', '*', '?', '"', '<', '>', '|', '&', '^', '(', ')', '%', '!',
    ];
    if trimmed.chars().any(|c| FORBIDDEN.contains(&c) || c.is_control()) {
        return Err(CommandError::invalid_path(
            "blank_project.name.invalid",
            "Project name contains characters that are not allowed in a folder name.",
        ));
    }
    // Win32 strips trailing dots, so "demo." would silently create/target
    // "demo" while every stored path (rootPath, recents) keeps the dotted
    // string — a phantom path that only works by normalization accident.
    if trimmed.ends_with('.') {
        return Err(CommandError::invalid_path(
            "blank_project.name.invalid",
            "Project name cannot end with a dot.",
        ));
    }
    // Windows reserves device basenames (even with an extension): CON.txt is
    // still the console. Compare the stem before the first dot.
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = trimmed.split('.').next().unwrap_or(trimmed).to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return Err(CommandError::invalid_path(
            "blank_project.name.reserved",
            "Project name is a reserved system name on Windows.",
        ));
    }
    Ok(trimmed)
}

pub(crate) fn create_blank_project(
    project_name: &str,
    project_location: &str,
) -> CommandResult<BlankProjectResult> {
    let name = validate_project_name(project_name)?;
    let location = project_location.trim();
    if location.is_empty() {
        return Err(CommandError::invalid_path(
            "blank_project.location.required",
            "Project location is required.",
        ));
    }

    let root: PathBuf = Path::new(location).join(name);
    if root.exists() {
        if !root.is_dir() {
            return Err(CommandError::conflict(
                "blank_project.root.not_dir",
                format!("Path exists but is not a directory: {}", root.display()),
            ));
        }
        // Blank must start clean — refuse foreign content. An empty folder is
        // fine (users often make the folder first, unlike the CLI scaffolds
        // which own their target), and so is a folder holding ONLY our own
        // substrate files: that's a previous attempt whose downstream step
        // failed, and refusing it would make creation permanently
        // non-retryable without a manual delete.
        let entries = fs::read_dir(&root).map_err(|e| {
            CommandError::from_io("blank_project.root.read", &e, "Unable to inspect target folder")
        })?;
        for entry in entries {
            let entry = entry.map_err(|e| {
                CommandError::from_io("blank_project.root.read", &e, "Unable to inspect target folder")
            })?;
            let entry_name = entry.file_name();
            let is_substrate = SUBSTRATE_FILES
                .iter()
                .any(|f| entry_name.eq_ignore_ascii_case(f));
            if !is_substrate {
                return Err(CommandError::conflict(
                    "blank_project.root.not_empty",
                    format!("Folder already exists and is not empty: {}", root.display()),
                ));
            }
        }
    } else {
        fs::create_dir_all(&root).map_err(|e| {
            CommandError::from_io("blank_project.root.mkdir", &e, "Unable to create project directory")
        })?;
    }

    let readme = readme_contents(name);
    let files: [(&str, &str); 3] = [
        (SUBSTRATE_FILES[0], readme.as_str()),
        (SUBSTRATE_FILES[1], GITIGNORE_CONTENTS),
        (SUBSTRATE_FILES[2], EDITORCONFIG_CONTENTS),
    ];

    for (filename, contents) in files {
        fs::write(root.join(filename), contents).map_err(|e| {
            CommandError::from_io("blank_project.file.write", &e, "Unable to write project file")
        })?;
    }

    Ok(BlankProjectResult {
        project_path: root.to_string_lossy().into_owned(),
        created_files: SUBSTRATE_FILES.iter().map(|f| f.to_string()).collect(),
    })
}

// ---------------------------------------------------------------------------
// Tests: run with `cargo test blank_project`
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readme_has_heading_and_quote_blockquote() {
        let md = readme_contents("my-project");
        assert!(md.starts_with("# my-project\n\n"));
        assert!(md.contains("> *\""));
        assert!(md.ends_with('\n'));
    }

    #[test]
    fn gitignore_covers_litria_workspace_state() {
        // db_bootstrap_project dedup-appends `.litria/` only when missing —
        // it must already be here so the generated file stays canonical.
        assert!(GITIGNORE_CONTENTS.lines().any(|l| l.trim() == ".litria/"));
    }

    #[test]
    fn gitignore_covers_python_canon() {
        // ADR-020 Slice 0: a venv committed from a blank-turned-Python project
        // is the failure this canon exists to prevent. Keep in sync with the
        // scan ignores in project_tree.rs.
        for entry in [
            ".venv/",
            "venv/",
            "__pycache__/",
            "*.py[cod]",
            "*.egg-info/",
            ".pytest_cache/",
            ".ruff_cache/",
            ".mypy_cache/",
            ".coverage",
            ".env",
        ] {
            assert!(
                GITIGNORE_CONTENTS.lines().any(|l| l.trim() == entry),
                "missing gitignore entry: {entry}"
            );
        }
    }

    #[test]
    fn editorconfig_declares_root() {
        assert!(EDITORCONFIG_CONTENTS.starts_with("root = true"));
    }

    #[test]
    fn name_validation_rejects_separators_and_traversal() {
        assert!(validate_project_name("../evil").is_err());
        assert!(validate_project_name("a/b").is_err());
        assert!(validate_project_name("a\\b").is_err());
        assert!(validate_project_name("..").is_err());
        assert!(validate_project_name("  ").is_err());
        assert!(validate_project_name("con:sole").is_err());
        assert_eq!(validate_project_name(" my-app ").unwrap(), "my-app");
    }

    #[test]
    fn name_validation_rejects_windows_traps() {
        // Trailing dot: Win32 strips it, creating a folder whose real name
        // differs from every stored path string.
        assert!(validate_project_name("demo.").is_err());
        // Reserved device names, bare and with extension.
        assert!(validate_project_name("CON").is_err());
        assert!(validate_project_name("con").is_err());
        assert!(validate_project_name("Nul.txt").is_err());
        assert!(validate_project_name("com3").is_err());
        assert!(validate_project_name("lpt9.md").is_err());
        // Names that merely CONTAIN a reserved word are fine.
        assert!(validate_project_name("console").is_ok());
        assert!(validate_project_name("communal").is_ok());
    }

    #[test]
    fn name_validation_rejects_cmd_metacharacters() {
        // The name reaches `cmd /C <pm> create ...` as an argument on the
        // Windows global package-manager path, and cmd re-parses the line.
        // `demo&calc` is the report's own proof-of-concept (CWE-78).
        assert!(validate_project_name("demo&calc").is_err());
        assert!(validate_project_name("demo&calc&").is_err());
        // Every other cmd construct that can alter parsing.
        for name in [
            "a^b",      // escape
            "a(b)",     // grouping
            "a%PATH%b", // variable expansion
            "a!DELAYED!b",
        ] {
            assert!(
                validate_project_name(name).is_err(),
                "{name} must be refused as a cmd metacharacter carrier"
            );
        }
        // Ordinary names stay valid — the tightening must not eat real ones.
        for name in ["my-app", "my_app", "My App 2", "app.v2", "café", "проект"] {
            assert!(
                validate_project_name(name).is_ok(),
                "{name} is an ordinary folder name and must remain valid"
            );
        }
    }

    /// Unconditional temp-dir cleanup — assert failures must not leak
    /// litria-blank-test-* directories into %TEMP% across red-green loops.
    struct TempRoot(std::path::PathBuf);
    impl Drop for TempRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }
    fn temp_root(tag: &str) -> TempRoot {
        let base = std::env::temp_dir().join(format!(
            "litria-blank-test-{}-{}-{}",
            tag,
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        fs::create_dir_all(&base).expect("create temp base");
        TempRoot(base)
    }

    #[test]
    fn creates_substrate_in_fresh_directory_and_refuses_foreign_content() {
        let base = temp_root("fresh");
        let location = base.0.to_str().unwrap();

        let result = create_blank_project("demo", location).expect("create ok");
        assert_eq!(result.created_files, SUBSTRATE_FILES.to_vec());
        let root = Path::new(&result.project_path);
        assert!(root.join("README.md").exists());
        assert!(root.join(".gitignore").exists());
        assert!(root.join(".editorconfig").exists());
        let readme = fs::read_to_string(root.join("README.md")).unwrap();
        assert!(readme.starts_with("# demo"));

        // Substrate-only folder = failed previous attempt → retry is allowed.
        let retry = create_blank_project("demo", location);
        assert!(retry.is_ok(), "retry over substrate-only folder must succeed");

        // Foreign content → refuse.
        fs::write(root.join("user-data.txt"), "precious").unwrap();
        let refused = create_blank_project("demo", location);
        assert!(refused.is_err(), "foreign content must refuse creation");
    }

    #[test]
    fn accepts_a_pre_existing_empty_folder() {
        let base = temp_root("empty");
        let location = base.0.to_str().unwrap();
        fs::create_dir_all(base.0.join("made-first")).unwrap();

        let result = create_blank_project("made-first", location);
        assert!(result.is_ok(), "empty pre-made folder is a valid target");
    }
}
