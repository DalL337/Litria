// Python project creation (ADR-020 Slice 3) — the offline blueprint executor.
//
// Deliberately NOT part of scaffold_runner.rs: that module translates wizard
// choices into npm `create-*` CLI invocations; this one executes declarative
// blueprints. Creation is offline by design (ADR-020 §1): every file is
// written by Litria from the blueprints below, and the only subprocess is
// LOCAL environment creation (`<interpreter> -m venv` — stdlib — or
// `uv venv`). Zero network, zero third-party code execution, zero installs.
// Declared dependencies are exactly that — declared in pyproject.toml; the
// install happens later in the visible terminal, user-initiated (class 3).
//
// Environment-step failure is non-fatal (ADR-020 §4): the project opens
// files-only and first-open offers to finish the environment. File-write
// failure is fatal (the wizard offers its create-as-blank fallback).
//
// Progress streams over the same `Channel<ScaffoldEvent>` the npm scaffolds
// use, so the wizard's Capstone progress UI needs no new event plumbing.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::blank_project::validate_project_name;
use crate::errors::{CommandError, CommandResult};
use crate::scaffold_types::ScaffoldEvent;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------------------
// Config / result (camelCase over IPC)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PythonScaffoldConfig {
    pub project_name: String,
    pub project_location: String,
    /// 'py-script' | 'py-cli' | 'py-lib' | 'py-fastapi'
    pub archetype: String,
    /// PEP 503-normalized distribution name (frontend-derived, validated here).
    pub dist_name: String,
    /// PEP 8 module name (frontend-derived, validated here — becomes paths).
    pub module_name: String,
    /// 'pytest' | 'ruff'
    pub addons: Vec<String>,
    /// requires-python floor, e.g. "3.13" (editable Capstone row). None = omit.
    pub requires_floor: Option<String>,
    /// 'venv' | 'direct' | 'existing'
    pub env_mode: String,
    /// Resolved engine — 'uv' | 'venv'. The frontend resolves 'auto' before
    /// invoking so the plan preview and execution can never disagree.
    pub env_engine: String,
    pub interpreter_path: Option<String>,
    pub existing_env: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PythonScaffoldResult {
    pub success: bool,
    pub project_path: String,
    /// Relative paths written, in creation order — seeded onto the canvas
    /// exactly like the Blank substrate.
    pub created_files: Vec<String>,
    /// False when the venv step was skipped (deferred) or failed (non-fatal).
    pub env_created: bool,
    pub errors: Vec<String>,
}

// ---------------------------------------------------------------------------
// Name validation — these become directory/file names and pyproject values
// ---------------------------------------------------------------------------

fn is_valid_dist_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

fn is_valid_module_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn is_valid_floor(floor: &str) -> bool {
    !floor.is_empty()
        && floor.chars().all(|c| c.is_ascii_digit() || c == '.')
        && floor.chars().next().is_some_and(|c| c.is_ascii_digit())
        && !floor.ends_with('.')
        && !floor.contains("..")
}

/// Guard the frontend-supplied interpreter before it is spawned (stdlib venv)
/// or handed to uv via `--python` (audit #11). The normal flow supplies a path
/// from `detect_python_interpreters`; this rejects an arbitrary program a
/// compromised frontend might inject. Defense-in-depth, not a probe re-run: the
/// path must resolve to an existing file whose basename names a Python
/// interpreter (`python`, `python3`, `python3.13`, `pythonw`, `.exe` variants).
fn is_allowed_interpreter(path: &str) -> bool {
    let Ok(canonical) = std::fs::canonicalize(Path::new(path.trim())) else {
        return false;
    };
    if !canonical.is_file() {
        return false;
    }
    let Some(file_name) = canonical.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = file_name.to_ascii_lowercase();
    let base = lower.strip_suffix(".exe").unwrap_or(&lower);
    base == "python"
        || base == "pythonw"
        || base.strip_prefix("python").is_some_and(|rest| {
            !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit() || c == '.')
        })
}

// ---------------------------------------------------------------------------
// Blueprint content builders — pure, unit-tested
// ---------------------------------------------------------------------------

/// Python-canon ignore rules plus the stack-agnostic substrate entries.
/// Self-contained (not shared with blank_project): this blueprint must stay
/// correct regardless of what the generic substrate evolves into.
const PYTHON_GITIGNORE: &str = "\
# Python
.venv/
venv/
__pycache__/
*.py[cod]
*.egg-info/
dist/
.pytest_cache/
.ruff_cache/
.mypy_cache/
.coverage

# Local secrets
.env

# OS
.DS_Store
Thumbs.db
Desktop.ini

# Editors
.vscode/
.idea/
*.swp

# Litria workspace (local state)
.litria/

# Logs
*.log
";

fn pyproject_contents(config: &PythonScaffoldConfig) -> String {
    let mut out = String::new();
    out.push_str("[project]\n");
    out.push_str(&format!("name = \"{}\"\n", config.dist_name));
    out.push_str("version = \"0.1.0\"\n");
    out.push_str(&format!("description = \"{}\"\n", archetype_description(&config.archetype)));
    out.push_str("readme = \"README.md\"\n");
    if let Some(floor) = config.requires_floor.as_deref().filter(|f| is_valid_floor(f)) {
        out.push_str(&format!("requires-python = \">={}\"\n", floor));
    }
    let deps: &[&str] = if config.archetype == "py-fastapi" {
        &["fastapi", "uvicorn"]
    } else {
        &[]
    };
    if deps.is_empty() {
        out.push_str("dependencies = []\n");
    } else {
        out.push_str("dependencies = [\n");
        for dep in deps {
            out.push_str(&format!("    \"{}\",\n", dep));
        }
        out.push_str("]\n");
    }

    let wants_pytest = config.archetype == "py-lib" || config.addons.iter().any(|a| a == "pytest");
    if wants_pytest {
        out.push_str("\n[dependency-groups]\ndev = [\"pytest\"]\n");
    }

    // Library is the only archetype that builds/installs as a package.
    // hatchling over uv_build: the project must build regardless of engine.
    if config.archetype == "py-lib" {
        out.push_str("\n[build-system]\nrequires = [\"hatchling\"]\nbuild-backend = \"hatchling.build\"\n");
    }

    // The pyright binding (ADR-020 §5): file-based, discovered at rootUri —
    // zero LSP protocol changes. Only written when an environment exists to
    // point at.
    match config.env_mode.as_str() {
        "venv" => {
            out.push_str("\n[tool.pyright]\nvenvPath = \".\"\nvenv = \".venv\"\n");
        }
        "existing" => {
            if let Some((parent, name)) = config
                .existing_env
                .as_deref()
                .filter(|p| !p.trim().is_empty())
                .and_then(split_env_path)
            {
                // TOML literal strings ('…') keep Windows backslashes intact.
                out.push_str(&format!(
                    "\n[tool.pyright]\nvenvPath = '{}'\nvenv = \"{}\"\n",
                    parent, name
                ));
            }
        }
        _ => {}
    }

    if config.addons.iter().any(|a| a == "ruff") {
        out.push_str("\n[tool.ruff]\nline-length = 100\n\n[tool.ruff.lint]\nextend-select = [\"I\"]\n");
    }

    out
}

/// Split an environment path into (parent, dirname) for pyright's
/// venvPath/venv pair. None when there is no usable parent.
fn split_env_path(path: &str) -> Option<(String, String)> {
    let trimmed = path.trim_end_matches(['/', '\\']);
    let idx = trimmed.rfind(['/', '\\'])?;
    let (parent, name) = (&trimmed[..idx], &trimmed[idx + 1..]);
    if parent.is_empty() || name.is_empty() || name.contains('\'') {
        return None;
    }
    Some((parent.replace('\'', ""), name.to_string()))
}

fn archetype_description(archetype: &str) -> &'static str {
    match archetype {
        "py-cli" => "A command-line tool",
        "py-lib" => "A Python library",
        "py-fastapi" => "A FastAPI service",
        _ => "A Python project",
    }
}

fn main_py_contents(config: &PythonScaffoldConfig) -> String {
    match config.archetype.as_str() {
        "py-cli" => format!(
            "import argparse\n\n\n\
             def build_parser() -> argparse.ArgumentParser:\n    \
                 parser = argparse.ArgumentParser(prog=\"{dist}\", description=\"{dist} command-line tool\")\n    \
                 parser.add_argument(\"name\", nargs=\"?\", default=\"world\", help=\"who to greet\")\n    \
                 return parser\n\n\n\
             def main() -> None:\n    \
                 args = build_parser().parse_args()\n    \
                 print(f\"Hello, {{args.name}}!\")\n\n\n\
             if __name__ == \"__main__\":\n    \
                 main()\n",
            dist = config.dist_name
        ),
        "py-fastapi" => format!(
            "from fastapi import FastAPI\n\n\
             app = FastAPI(title=\"{dist}\")\n\n\n\
             @app.get(\"/\")\n\
             def read_root() -> dict[str, str]:\n    \
                 return {{\"message\": \"Hello from {dist}!\"}}\n",
            dist = config.dist_name
        ),
        _ => format!(
            "def main() -> None:\n    \
                 print(\"Hello from {dist}!\")\n\n\n\
             if __name__ == \"__main__\":\n    \
                 main()\n",
            dist = config.dist_name
        ),
    }
}

fn readme_contents(config: &PythonScaffoldConfig) -> String {
    let name = config.project_name.trim();
    let run_section = match config.archetype.as_str() {
        "py-lib" => format!(
            "## Develop\n\n\
             Install the package (editable) plus dev tools into the environment, then test:\n\n\
             ```\nuv sync            # or: .venv/bin/pip install -e . pytest\npytest\n```\n\n\
             The src layout means tests import the *installed* package — install first.\n"
        ),
        "py-fastapi" => format!(
            "## Run\n\n\
             Install the declared dependencies (Litria offers this in the terminal on first open), then:\n\n\
             ```\nuvicorn main:app --reload\n```\n"
        ),
        _ => format!(
            "## Run\n\n```\npython main.py     # or: uv run main.py\n```\n"
        ),
    };
    format!("# {}\n\n{}\n\n{}", name, archetype_description(&config.archetype), run_section)
}

fn lib_init_contents(config: &PythonScaffoldConfig) -> String {
    format!(
        "\"\"\"{dist} — a Python library.\"\"\"\n\n__version__ = \"0.1.0\"\n",
        dist = config.dist_name
    )
}

fn lib_test_contents(config: &PythonScaffoldConfig) -> String {
    format!(
        "from {module} import __version__\n\n\n\
         def test_version() -> None:\n    \
             assert __version__ == \"0.1.0\"\n",
        module = config.module_name
    )
}

/// (relative_path, contents) in creation order. Mirrors
/// pythonBlueprintFiles() in src/scaffold/pythonWizardModel.js — the wizard
/// displays this list; drift between them breaks the honest-preview contract.
fn blueprint_files(config: &PythonScaffoldConfig) -> Vec<(String, String)> {
    let mut files = vec![
        ("pyproject.toml".to_string(), pyproject_contents(config)),
    ];
    if let Some(floor) = config.requires_floor.as_deref().filter(|f| is_valid_floor(f)) {
        files.push((".python-version".to_string(), format!("{}\n", floor)));
    }
    files.push((".gitignore".to_string(), PYTHON_GITIGNORE.to_string()));
    files.push(("README.md".to_string(), readme_contents(config)));
    if config.archetype == "py-lib" {
        files.push((
            format!("src/{}/__init__.py", config.module_name),
            lib_init_contents(config),
        ));
        files.push((format!("src/{}/py.typed", config.module_name), String::new()));
        files.push((
            format!("tests/test_{}.py", config.module_name),
            lib_test_contents(config),
        ));
    } else {
        files.push(("main.py".to_string(), main_py_contents(config)));
    }
    files
}

// ---------------------------------------------------------------------------
// Environment step
// ---------------------------------------------------------------------------

/// The venv command for the resolved engine, or None when the step must be
/// deferred (stdlib venv without an interpreter to run it).
fn env_command(config: &PythonScaffoldConfig) -> Option<(String, Vec<String>)> {
    if config.env_mode != "venv" {
        return None;
    }
    match config.env_engine.as_str() {
        "uv" => {
            let mut args = vec!["venv".to_string(), ".venv".to_string()];
            if let Some(interpreter) = config.interpreter_path.as_deref() {
                args.push("--python".to_string());
                args.push(interpreter.to_string());
            }
            Some(("uv".to_string(), args))
        }
        _ => config.interpreter_path.as_deref().map(|interpreter| {
            (
                interpreter.to_string(),
                vec!["-m".to_string(), "venv".to_string(), ".venv".to_string()],
            )
        }),
    }
}

/// Run the environment command in the project root, streaming merged
/// stdout/stderr lines over the channel. Errors are returned, not panicked —
/// the caller records them as non-fatal.
fn run_env_command(
    program: &str,
    args: &[String],
    cwd: &Path,
    on_event: &Channel<ScaffoldEvent>,
) -> Result<(), String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start `{program}`: {e}"))?;

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        }));
    }
    if let Some(stderr) = child.stderr.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        }));
    }
    drop(tx);
    for line in rx {
        let _ = on_event.send(ScaffoldEvent::StepOutput { line });
    }
    for reader in readers {
        let _ = reader.join();
    }

    let status = child
        .wait()
        .map_err(|e| format!("Failed to wait for `{program}`: {e}"))?;
    if !status.success() {
        return Err(format!(
            "`{program}` exited with {}",
            status.code().map_or("signal".to_string(), |c| c.to_string())
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub(crate) fn run_python_scaffold(
    config: PythonScaffoldConfig,
    on_event: &Channel<ScaffoldEvent>,
) -> CommandResult<PythonScaffoldResult> {
    let name = validate_project_name(&config.project_name)?;
    let location = config.project_location.trim();
    if location.is_empty() {
        return Err(CommandError::invalid_path(
            "python_scaffold.location.required",
            "Project location is required.",
        ));
    }
    if !is_valid_dist_name(&config.dist_name) {
        return Err(CommandError::invalid_path(
            "python_scaffold.dist_name.invalid",
            "Distribution name must be lowercase letters, digits, and hyphens.",
        ));
    }
    if !is_valid_module_name(&config.module_name) {
        return Err(CommandError::invalid_path(
            "python_scaffold.module_name.invalid",
            "Module name must be a valid Python identifier (lowercase).",
        ));
    }
    // Security (audit #11): validate a frontend-supplied interpreter before it
    // can name a spawned program (stdlib venv) or a uv `--python` target. Only
    // an env-creating run spawns it; consistent with the sibling name checks,
    // a malformed request is refused rather than executed.
    if config.env_mode == "venv" {
        if let Some(interpreter) = config.interpreter_path.as_deref() {
            if !is_allowed_interpreter(interpreter) {
                return Err(CommandError::invalid_path(
                    "python_scaffold.interpreter.invalid",
                    "The selected Python interpreter path is not a valid interpreter.",
                ));
            }
        }
    }

    let files = blueprint_files(&config);
    // Shared destination chokepoint — see path_guard::resolve_project_destination.
    let base = crate::path_guard::resolve_project_destination(location).map_err(|message| {
        CommandError::invalid_path("python_scaffold.location.invalid", message)
    })?;
    let root: PathBuf = base.join(name);

    // Same target-folder policy as Blank: nonexistent or empty is fine, and a
    // folder holding only OUR blueprint files is a retryable previous attempt.
    // Anything else refuses — creation never eats foreign content.
    if root.exists() {
        if !root.is_dir() {
            return Err(CommandError::conflict(
                "python_scaffold.root.not_dir",
                format!("Path exists but is not a directory: {}", root.display()),
            ));
        }
        let own_top_level: Vec<&str> = files
            .iter()
            .map(|(path, _)| path.split(['/', '\\']).next().unwrap_or(path.as_str()))
            .chain([".venv"])
            .collect();
        let entries = fs::read_dir(&root).map_err(|e| {
            CommandError::from_io("python_scaffold.root.read", &e, "Unable to inspect target folder")
        })?;
        for entry in entries {
            let entry = entry.map_err(|e| {
                CommandError::from_io("python_scaffold.root.read", &e, "Unable to inspect target folder")
            })?;
            let entry_name = entry.file_name();
            let is_own = own_top_level
                .iter()
                .any(|own| entry_name.eq_ignore_ascii_case(own));
            if !is_own {
                return Err(CommandError::conflict(
                    "python_scaffold.root.not_empty",
                    format!("Folder already exists and is not empty: {}", root.display()),
                ));
            }
        }
    } else {
        fs::create_dir_all(&root).map_err(|e| {
            CommandError::from_io("python_scaffold.root.mkdir", &e, "Unable to create project directory")
        })?;
    }

    let env_step = env_command(&config);
    let total: u32 = if env_step.is_some() { 2 } else { 1 };
    let mut errors: Vec<String> = Vec::new();

    // ── Step 1: write the blueprint ────────────────────────────────────────
    let _ = on_event.send(ScaffoldEvent::StepStarted {
        label: "Writing project files".into(),
        step: 1,
        total,
    });
    for (relative, contents) in &files {
        let target = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                CommandError::from_io("python_scaffold.file.mkdir", &e, "Unable to create project subdirectory")
            })?;
        }
        fs::write(&target, contents).map_err(|e| {
            CommandError::from_io("python_scaffold.file.write", &e, "Unable to write project file")
        })?;
        let _ = on_event.send(ScaffoldEvent::StepOutput {
            line: format!("wrote {relative}"),
        });
    }
    let _ = on_event.send(ScaffoldEvent::StepCompleted {
        label: "Writing project files".into(),
        step: 1,
    });

    // ── Step 2: create the environment (non-fatal, ADR-020 §4) ────────────
    let mut env_created = false;
    if let Some((program, args)) = env_step {
        let label = if program == "uv" {
            "Creating environment (.venv via uv)".to_string()
        } else {
            "Creating environment (.venv)".to_string()
        };
        let _ = on_event.send(ScaffoldEvent::StepStarted {
            label: label.clone(),
            step: 2,
            total,
        });
        match run_env_command(&program, &args, &root, on_event) {
            Ok(()) => {
                env_created = true;
                let _ = on_event.send(ScaffoldEvent::StepCompleted { label, step: 2 });
            }
            Err(error) => {
                errors.push(error.clone());
                let _ = on_event.send(ScaffoldEvent::StepFailed { label, step: 2, error });
                let _ = on_event.send(ScaffoldEvent::StepOutput {
                    line: "Environment deferred — Litria will offer to finish it on first open.".into(),
                });
            }
        }
    }

    let _ = on_event.send(ScaffoldEvent::Done { success: true });

    Ok(PythonScaffoldResult {
        success: true,
        project_path: root.to_string_lossy().into_owned(),
        created_files: files.into_iter().map(|(path, _)| path).collect(),
        env_created,
        errors,
    })
}

// ---------------------------------------------------------------------------
// Tests: run with `cargo test python_scaffold`
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn config(archetype: &str) -> PythonScaffoldConfig {
        PythonScaffoldConfig {
            project_name: "Demo App".into(),
            project_location: String::new(),
            archetype: archetype.into(),
            dist_name: "demo-app".into(),
            module_name: "demo_app".into(),
            addons: vec![],
            requires_floor: Some("3.13".into()),
            env_mode: "venv".into(),
            env_engine: "venv".into(),
            interpreter_path: Some("C:\\Py\\python.exe".into()),
            existing_env: None,
        }
    }

    #[test]
    fn pyproject_script_has_floor_empty_deps_and_pyright_binding() {
        let toml_text = pyproject_contents(&config("py-script"));
        assert!(toml_text.contains("name = \"demo-app\""));
        assert!(toml_text.contains("requires-python = \">=3.13\""));
        assert!(toml_text.contains("dependencies = []"));
        assert!(toml_text.contains("[tool.pyright]"));
        assert!(toml_text.contains("venvPath = \".\""));
        assert!(toml_text.contains("venv = \".venv\""));
        assert!(!toml_text.contains("[build-system]"));
        assert!(!toml_text.contains("[tool.ruff]"));
        // Must parse as valid TOML.
        toml_text.parse::<toml::Table>().expect("valid toml");
    }

    #[test]
    fn pyproject_fastapi_declares_deps_but_never_installs_flag() {
        let toml_text = pyproject_contents(&config("py-fastapi"));
        assert!(toml_text.contains("\"fastapi\""));
        assert!(toml_text.contains("\"uvicorn\""));
        toml_text.parse::<toml::Table>().expect("valid toml");
    }

    #[test]
    fn pyproject_lib_gets_build_system_and_dev_pytest() {
        let toml_text = pyproject_contents(&config("py-lib"));
        assert!(toml_text.contains("[build-system]"));
        assert!(toml_text.contains("hatchling"));
        assert!(toml_text.contains("[dependency-groups]"));
        assert!(toml_text.contains("dev = [\"pytest\"]"));
        toml_text.parse::<toml::Table>().expect("valid toml");
    }

    #[test]
    fn pyproject_addons_and_modes_compose() {
        let mut cfg = config("py-cli");
        cfg.addons = vec!["pytest".into(), "ruff".into()];
        cfg.env_mode = "direct".into();
        let toml_text = pyproject_contents(&cfg);
        assert!(toml_text.contains("dev = [\"pytest\"]"));
        assert!(toml_text.contains("[tool.ruff]"));
        // Direct mode: no environment, no pyright binding to point anywhere.
        assert!(!toml_text.contains("[tool.pyright]"));
        toml_text.parse::<toml::Table>().expect("valid toml");
    }

    #[test]
    fn pyproject_existing_env_binds_pyright_to_that_path() {
        let mut cfg = config("py-script");
        cfg.env_mode = "existing".into();
        cfg.existing_env = Some("C:\\envs\\shared".into());
        let toml_text = pyproject_contents(&cfg);
        assert!(toml_text.contains("venvPath = 'C:\\envs'"));
        assert!(toml_text.contains("venv = \"shared\""));
        toml_text.parse::<toml::Table>().expect("valid toml");
    }

    #[test]
    fn blueprint_matches_wizard_display_lists() {
        // Mirror of pythonBlueprintFiles() in pythonWizardModel.js — keep in sync.
        let files: Vec<String> = blueprint_files(&config("py-script"))
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        assert_eq!(
            files,
            vec!["pyproject.toml", ".python-version", ".gitignore", "README.md", "main.py"]
        );
        let lib: Vec<String> = blueprint_files(&config("py-lib"))
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        assert!(lib.contains(&"src/demo_app/__init__.py".to_string()));
        assert!(lib.contains(&"src/demo_app/py.typed".to_string()));
        assert!(lib.contains(&"tests/test_demo_app.py".to_string()));
        assert!(!lib.contains(&"main.py".to_string()));
    }

    #[test]
    fn floorless_config_omits_python_version_and_requires_line() {
        let mut cfg = config("py-script");
        cfg.requires_floor = None;
        let files: Vec<String> = blueprint_files(&cfg).into_iter().map(|(p, _)| p).collect();
        assert!(!files.contains(&".python-version".to_string()));
        assert!(!pyproject_contents(&cfg).contains("requires-python"));
    }

    #[test]
    fn name_validators_hold_the_line() {
        assert!(is_valid_dist_name("my-app"));
        assert!(!is_valid_dist_name("My-App"));
        assert!(!is_valid_dist_name("-app"));
        assert!(is_valid_module_name("my_app"));
        assert!(is_valid_module_name("_3d"));
        assert!(!is_valid_module_name("3d"));
        assert!(!is_valid_module_name("my-app"));
        assert!(!is_valid_module_name("my app"));
        assert!(is_valid_floor("3.13"));
        assert!(!is_valid_floor("3.13."));
        assert!(!is_valid_floor("3..13"));
        assert!(!is_valid_floor("abc"));
    }

    #[test]
    fn interpreter_guard_accepts_python_names_and_rejects_others() {
        let base = temp_root("interp");
        let dir = base.0.as_path();
        // Files named like a Python interpreter are accepted (existence + name
        // only — this is a spawn guard, not an execution check).
        for good in ["python.exe", "python", "python3", "python3.13", "pythonw.exe"] {
            let p = dir.join(good);
            fs::write(&p, b"#!fake").unwrap();
            assert!(is_allowed_interpreter(p.to_str().unwrap()), "{good} should pass");
        }
        // A real file with a non-interpreter name is rejected.
        let evil = dir.join("evil.exe");
        fs::write(&evil, b"x").unwrap();
        assert!(!is_allowed_interpreter(evil.to_str().unwrap()));
        // Non-existent path and a directory are rejected.
        assert!(!is_allowed_interpreter(dir.join("python-nope.exe").to_str().unwrap()));
        assert!(!is_allowed_interpreter(dir.to_str().unwrap()));
    }

    #[test]
    fn env_command_defers_stdlib_without_interpreter_and_uv_runs_without_one() {
        let mut cfg = config("py-script");
        cfg.interpreter_path = None;
        assert!(env_command(&cfg).is_none(), "stdlib venv needs an interpreter");
        cfg.env_engine = "uv".into();
        let (program, args) = env_command(&cfg).expect("uv can pick its own python");
        assert_eq!(program, "uv");
        assert_eq!(args, vec!["venv", ".venv"]);
        cfg.env_mode = "direct".into();
        assert!(env_command(&cfg).is_none(), "direct mode never creates an env");
    }

    struct TempRoot(PathBuf);
    impl Drop for TempRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }
    fn temp_root(tag: &str) -> TempRoot {
        let base = std::env::temp_dir().join(format!(
            "litria-pyscaffold-{}-{}-{}",
            tag,
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        fs::create_dir_all(&base).expect("create temp base");
        TempRoot(base)
    }

    #[test]
    fn writes_blueprint_refuses_foreign_content_and_allows_retry() {
        let base = temp_root("write");
        let location = base.0.to_str().unwrap().to_string();
        let mut cfg = config("py-lib");
        cfg.project_location = location.clone();
        cfg.env_mode = "direct".into(); // no subprocess in unit tests

        let channel = Channel::new(|_| Ok(()));
        let result = run_python_scaffold(cfg.clone(), &channel).expect("create ok");
        assert!(result.success);
        assert!(!result.env_created);
        let root = Path::new(&result.project_path);
        assert!(root.join("pyproject.toml").exists());
        assert!(root.join("src").join("demo_app").join("__init__.py").exists());
        assert!(root.join("tests").join("test_demo_app.py").exists());
        let gitignore = fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(gitignore.lines().any(|l| l.trim() == ".venv/"));
        assert!(gitignore.lines().any(|l| l.trim() == ".litria/"));

        // Retry over our own files must succeed (failed-downstream recovery).
        let retry = run_python_scaffold(cfg.clone(), &channel);
        assert!(retry.is_ok(), "retry over own blueprint must succeed");

        // Foreign content refuses.
        fs::write(root.join("precious.txt"), "user data").unwrap();
        let refused = run_python_scaffold(cfg, &channel);
        assert!(refused.is_err(), "foreign content must refuse creation");
    }

    /// Live venv creation — spawns a real interpreter, ignored by default.
    /// Run: `cargo test python_scaffold -- --ignored --nocapture`
    #[test]
    #[ignore = "spawns a real python to create a venv (~10s)"]
    fn live_venv_creation_smoke() {
        let probe = crate::python_probe::detect_python_interpreters();
        let Some(interpreter) = probe.interpreters.first() else {
            eprintln!("no python on this machine — skipping");
            return;
        };
        let base = temp_root("venv");
        let mut cfg = config("py-script");
        cfg.project_location = base.0.to_str().unwrap().to_string();
        cfg.interpreter_path = Some(interpreter.path.clone());
        let channel = Channel::new(|_| Ok(()));
        let result = run_python_scaffold(cfg, &channel).expect("create ok");
        assert!(result.env_created, "venv step should succeed: {:?}", result.errors);
        let root = Path::new(&result.project_path);
        assert!(root.join(".venv").join("pyvenv.cfg").exists());
    }
}
