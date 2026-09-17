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

/// Python's hard keywords (`keyword.kwlist`, 3.13). A module named after one
/// cannot be imported (`from class import …` is a SyntaxError), so the name
/// is refused on both sides (ADR-028 §9, F33) — mirrored in
/// pythonWizardModel.js PYTHON_KEYWORDS.
const PYTHON_KEYWORDS: &[&str] = &[
    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
    "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
    "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return",
    "try", "while", "with", "yield",
];

fn is_python_keyword(name: &str) -> bool {
    PYTHON_KEYWORDS.contains(&name)
}

fn is_valid_module_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') && !is_python_keyword(name)
}

fn is_valid_floor(floor: &str) -> bool {
    !floor.is_empty()
        && floor.chars().all(|c| c.is_ascii_digit() || c == '.')
        && floor.chars().next().is_some_and(|c| c.is_ascii_digit())
        && !floor.ends_with('.')
        && !floor.contains("..")
}

/// Every refusal creation can make about its inputs, before anything touches
/// the disk. The interpreter guard (audit #11) is the probe's own predicate
/// (`python_probe::interpreter_eligibility`), so an offered entry is never
/// refused here, and it applies in EVERY mode that forwards an interpreter
/// (F35) — the wizard sends the pick regardless of the environment mode.
fn validate_config(config: &PythonScaffoldConfig) -> CommandResult<()> {
    if !is_valid_dist_name(&config.dist_name) {
        return Err(CommandError::invalid_path(
            "python_scaffold.dist_name.invalid",
            "Distribution name must be lowercase letters, digits, and hyphens.",
        ));
    }
    if !is_valid_module_name(&config.module_name) {
        let detail = if is_python_keyword(&config.module_name) {
            format!("\"{}\" is a Python keyword and cannot be imported — choose another project name.", config.module_name)
        } else {
            "Module name must be a valid Python identifier (lowercase).".to_string()
        };
        return Err(CommandError::invalid_path("python_scaffold.module_name.invalid", detail));
    }
    // ADR-028 §9 (F36): an invalid floor is an error, not a silent omission.
    if let Some(floor) = config.requires_floor.as_deref() {
        if !is_valid_floor(floor) {
            return Err(CommandError::invalid_path(
                "python_scaffold.floor.invalid",
                format!("requires-python must look like 3.13 (digits and dots), got \"{floor}\"."),
            ));
        }
    }
    if let Some(interpreter) = config.interpreter_path.as_deref() {
        if let Err(reason) = crate::python_probe::interpreter_eligibility(interpreter) {
            return Err(CommandError::invalid_path(
                "python_scaffold.interpreter.invalid",
                format!("The selected Python interpreter is not usable ({reason}): {interpreter}"),
            ));
        }
    }
    // ADR-028 §9 (F32): an existing environment must exist before pyright is
    // pointed at it.
    if config.env_mode == "existing" {
        let path = config.existing_env.as_deref().map(str::trim).unwrap_or("");
        if path.is_empty() {
            return Err(CommandError::invalid_path(
                "python_scaffold.existing_env.required",
                "Enter the path of the existing environment.",
            ));
        }
        if !Path::new(path).is_dir() {
            return Err(CommandError::invalid_path(
                "python_scaffold.existing_env.missing",
                format!("The existing environment folder was not found: {path}"),
            ));
        }
        if existing_env_binding(path).is_none() {
            return Err(CommandError::invalid_path(
                "python_scaffold.existing_env.invalid",
                format!("The existing environment must be a folder inside another folder: {path}"),
            ));
        }
    }
    Ok(())
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

// pyproject.toml is a serde model rendered by the `toml` crate (ADR-028 §9,
// F32): every string is quoted and escaped by the serializer, so a path with
// backslashes or quotes round-trips instead of corrupting the file. Field
// order is the written order.

#[derive(Serialize)]
struct PyProjectDoc {
    project: ProjectTable,
    #[serde(rename = "dependency-groups", skip_serializing_if = "Option::is_none")]
    dependency_groups: Option<DependencyGroups>,
    #[serde(rename = "build-system", skip_serializing_if = "Option::is_none")]
    build_system: Option<BuildSystem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<ToolTable>,
}

#[derive(Serialize)]
struct ProjectTable {
    name: String,
    version: &'static str,
    description: &'static str,
    readme: &'static str,
    #[serde(rename = "requires-python", skip_serializing_if = "Option::is_none")]
    requires_python: Option<String>,
    dependencies: Vec<&'static str>,
}

#[derive(Serialize)]
struct DependencyGroups {
    dev: Vec<&'static str>,
}

#[derive(Serialize)]
struct BuildSystem {
    requires: Vec<&'static str>,
    #[serde(rename = "build-backend")]
    build_backend: &'static str,
}

#[derive(Serialize)]
struct ToolTable {
    #[serde(skip_serializing_if = "Option::is_none")]
    pyright: Option<PyrightTable>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ruff: Option<RuffTable>,
}

/// The pyright binding (ADR-020 §5): file-based, discovered at rootUri —
/// zero LSP protocol changes. Only written when an environment exists to
/// point at.
#[derive(Serialize)]
struct PyrightTable {
    #[serde(rename = "venvPath")]
    venv_path: String,
    venv: String,
}

#[derive(Serialize)]
struct RuffTable {
    #[serde(rename = "line-length")]
    line_length: u32,
    lint: RuffLint,
}

#[derive(Serialize)]
struct RuffLint {
    #[serde(rename = "extend-select")]
    extend_select: Vec<&'static str>,
}

fn pyproject_model(config: &PythonScaffoldConfig) -> PyProjectDoc {
    let wants_pytest = config.archetype == "py-lib" || config.addons.iter().any(|a| a == "pytest");
    let pyright = match config.env_mode.as_str() {
        "venv" => Some(PyrightTable { venv_path: ".".into(), venv: ".venv".into() }),
        "existing" => config
            .existing_env
            .as_deref()
            .and_then(existing_env_binding)
            .map(|(parent, name)| PyrightTable { venv_path: parent, venv: name }),
        _ => None,
    };
    let ruff = config
        .addons
        .iter()
        .any(|a| a == "ruff")
        .then(|| RuffTable { line_length: 100, lint: RuffLint { extend_select: vec!["I"] } });
    PyProjectDoc {
        project: ProjectTable {
            name: config.dist_name.clone(),
            version: "0.1.0",
            description: archetype_description(&config.archetype),
            readme: "README.md",
            // Validated by `validate_config` before any write (F36).
            requires_python: config.requires_floor.as_deref().map(|floor| format!(">={floor}")),
            dependencies: if config.archetype == "py-fastapi" { vec!["fastapi", "uvicorn"] } else { vec![] },
        },
        dependency_groups: wants_pytest.then(|| DependencyGroups { dev: vec!["pytest"] }),
        // Library is the only archetype that builds/installs as a package.
        // hatchling over uv_build: the project must build regardless of engine.
        build_system: (config.archetype == "py-lib")
            .then(|| BuildSystem { requires: vec!["hatchling"], build_backend: "hatchling.build" }),
        tool: (pyright.is_some() || ruff.is_some()).then(|| ToolTable { pyright, ruff }),
    }
}

fn pyproject_contents(config: &PythonScaffoldConfig) -> Result<String, String> {
    toml::to_string(&pyproject_model(config)).map_err(|e| format!("pyproject.toml could not be serialized: {e}"))
}

/// Split an environment path into (parent, dirname) for pyright's
/// venvPath/venv pair. None when there is no usable parent. Both halves are
/// written verbatim — the TOML serializer does the quoting.
fn existing_env_binding(path: &str) -> Option<(String, String)> {
    let trimmed = path.trim().trim_end_matches(['/', '\\']);
    let idx = trimmed.rfind(['/', '\\'])?;
    let (parent, name) = (&trimmed[..idx], &trimmed[idx + 1..]);
    if parent.is_empty() || name.is_empty() {
        return None;
    }
    Some((parent.to_string(), name.to_string()))
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
fn blueprint_files(config: &PythonScaffoldConfig) -> Result<Vec<(String, String)>, String> {
    let mut files = vec![
        ("pyproject.toml".to_string(), pyproject_contents(config)?),
    ];
    // The floor was validated by `validate_config` (F36); no silent filter.
    if let Some(floor) = config.requires_floor.as_deref() {
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
    // ADR-028 §4 (F11): the pytest add-on promised "test scaffold + dev
    // dependency" but only Library shipped a test. Every archetype that
    // declares pytest now gets a smoke test that imports its entry module.
    let wants_pytest = config.archetype == "py-lib" || config.addons.iter().any(|a| a == "pytest");
    if wants_pytest && config.archetype != "py-lib" {
        files.push(("tests/test_main.py".to_string(), smoke_test_contents(config)));
    }
    Ok(files)
}

/// Smoke test for the flat archetypes (script / CLI / FastAPI): imports
/// main.py as a module and checks its public entry point exists.
fn smoke_test_contents(config: &PythonScaffoldConfig) -> String {
    match config.archetype.as_str() {
        "py-fastapi" => "import main


def test_app_exists() -> None:
    assert main.app.title
".to_string(),
        "py-cli" => "import main


def test_parser_defaults() -> None:
    args = main.build_parser().parse_args([])
    assert args.name == \"world\"
".to_string(),
        _ => "import main


def test_main_is_callable() -> None:
    assert callable(main.main)
".to_string(),
    }
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
            // ADR-028 §9 (F28): creation is offline by promise. Without this
            // flag uv fetches a managed interpreter when none matches; with
            // it, a missing interpreter is a visible step failure instead.
            let mut args = vec![
                "venv".to_string(),
                "--no-python-downloads".to_string(),
                ".venv".to_string(),
            ];
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
    validate_config(&config)?;

    let files = blueprint_files(&config)
        .map_err(|message| CommandError::internal("python_scaffold.blueprint.serialize", message))?;
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

    fn toml_of(cfg: &PythonScaffoldConfig) -> String {
        pyproject_contents(cfg).expect("pyproject serializes")
    }

    #[test]
    fn pyproject_script_has_floor_empty_deps_and_pyright_binding() {
        let toml_text = toml_of(&config("py-script"));
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
        let toml_text = toml_of(&config("py-fastapi"));
        assert!(toml_text.contains("\"fastapi\""));
        assert!(toml_text.contains("\"uvicorn\""));
        toml_text.parse::<toml::Table>().expect("valid toml");
    }

    #[test]
    fn pyproject_lib_gets_build_system_and_dev_pytest() {
        let toml_text = toml_of(&config("py-lib"));
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
        let toml_text = toml_of(&cfg);
        assert!(toml_text.contains("dev = [\"pytest\"]"));
        assert!(toml_text.contains("[tool.ruff]"));
        // Direct mode: no environment, no pyright binding to point anywhere.
        assert!(!toml_text.contains("[tool.pyright]"));
        toml_text.parse::<toml::Table>().expect("valid toml");
    }

    fn pyright_binding(toml_text: &str) -> (String, String) {
        let table: toml::Table = toml_text.parse().expect("valid toml");
        let pyright = &table["tool"]["pyright"];
        (
            pyright["venvPath"].as_str().unwrap().to_string(),
            pyright["venv"].as_str().unwrap().to_string(),
        )
    }

    #[test]
    fn pyproject_existing_env_binds_pyright_to_that_path() {
        // ADR-028 §9 (F32): the serializer escapes the backslashes; the
        // parsed value is the path the user typed.
        let mut cfg = config("py-script");
        cfg.env_mode = "existing".into();
        cfg.existing_env = Some("C:\\envs\\shared\\".into());
        let (venv_path, venv) = pyright_binding(&toml_of(&cfg));
        assert_eq!(venv_path, "C:\\envs");
        assert_eq!(venv, "shared");
    }

    #[test]
    fn pyproject_round_trips_a_quoted_posix_env_path() {
        // A quote in the path used to be stripped from the parent and passed
        // unescaped in the basename — now both halves round-trip verbatim.
        let mut cfg = config("py-script");
        cfg.env_mode = "existing".into();
        cfg.existing_env = Some("/home/o'brien/envs/it's \"shared\"".into());
        let (venv_path, venv) = pyright_binding(&toml_of(&cfg));
        assert_eq!(venv_path, "/home/o'brien/envs");
        assert_eq!(venv, "it's \"shared\"");
    }

    #[test]
    fn pyproject_keeps_the_written_section_order_and_skips_absent_tables() {
        let toml_text = toml_of(&config("py-script"));
        let project = toml_text.find("[project]").expect("[project]");
        let pyright = toml_text.find("[tool.pyright]").expect("[tool.pyright]");
        assert!(project < pyright, "project before tool tables:\n{toml_text}");
        assert!(toml_text.starts_with("[project]\nname = \"demo-app\"\n"), "name is the first key:\n{toml_text}");
        // The exact block pythonFirstOpenModel.js parses for `expectsVenv`.
        assert!(toml_text.contains("[tool.pyright]\nvenvPath = \".\"\nvenv = \".venv\"\n"), "{toml_text}");
        assert!(!toml_text.contains("[dependency-groups]"));
        assert!(!toml_text.contains("[tool.ruff]"));
    }

    #[test]
    fn blueprint_matches_wizard_display_lists() {
        // Mirror of pythonBlueprintFiles() in pythonWizardModel.js — keep in sync.
        let files: Vec<String> = blueprint_files(&config("py-script"))
            .unwrap()
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        assert_eq!(
            files,
            vec!["pyproject.toml", ".python-version", ".gitignore", "README.md", "main.py"]
        );
        let lib: Vec<String> = blueprint_files(&config("py-lib"))
            .unwrap()
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        assert!(lib.contains(&"src/demo_app/__init__.py".to_string()));
        assert!(lib.contains(&"src/demo_app/py.typed".to_string()));
        assert!(lib.contains(&"tests/test_demo_app.py".to_string()));
        assert!(!lib.contains(&"main.py".to_string()));
    }

    #[test]
    fn pytest_addon_ships_a_smoke_test_for_every_archetype() {
        // ADR-028 §4 (F11): the card promised "test scaffold"; only Library
        // delivered one. Now script / CLI / FastAPI get tests/test_main.py.
        for archetype in ["py-script", "py-cli", "py-fastapi"] {
            let without: Vec<String> = blueprint_files(&config(archetype)).unwrap().into_iter().map(|(p, _)| p).collect();
            assert!(!without.contains(&"tests/test_main.py".to_string()), "{archetype} without pytest");
            let mut cfg = config(archetype);
            cfg.addons = vec!["pytest".into()];
            let files = blueprint_files(&cfg).unwrap();
            let test = files.iter().find(|(p, _)| p == "tests/test_main.py").unwrap_or_else(|| panic!("{archetype} with pytest"));
            assert!(test.1.starts_with("import main\n"), "{archetype}: imports the entry module");
            assert!(test.1.contains("def test_"), "{archetype}: defines a test");
        }
        // Library is pytest-ready by definition and keeps its own test.
        let lib: Vec<String> = blueprint_files(&config("py-lib")).unwrap().into_iter().map(|(p, _)| p).collect();
        assert!(lib.contains(&"tests/test_demo_app.py".to_string()));
        assert!(!lib.contains(&"tests/test_main.py".to_string()));
    }

    #[test]
    fn floorless_config_omits_python_version_and_requires_line() {
        let mut cfg = config("py-script");
        cfg.requires_floor = None;
        let files: Vec<String> = blueprint_files(&cfg).unwrap().into_iter().map(|(p, _)| p).collect();
        assert!(!files.contains(&".python-version".to_string()));
        assert!(!toml_of(&cfg).contains("requires-python"));
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
        // ADR-028 §9 (F33): keywords cannot be imported, so they are refused.
        for keyword in ["class", "import", "for", "lambda", "yield", "async"] {
            assert!(!is_valid_module_name(keyword), "{keyword} is a keyword");
        }
        assert!(is_valid_module_name("class_"), "PEP 8 trailing underscore is fine");
        assert!(is_valid_module_name("classes"));
        assert!(is_valid_floor("3.13"));
        assert!(!is_valid_floor("3.13."));
        assert!(!is_valid_floor("3..13"));
        assert!(!is_valid_floor("abc"));
    }

    #[test]
    fn validate_refuses_keyword_modules_with_a_readable_message() {
        let mut cfg = config("py-lib");
        cfg.interpreter_path = None;
        cfg.dist_name = "class".into();
        cfg.module_name = "class".into();
        let err = validate_config(&cfg).expect_err("keyword refused");
        assert_eq!(err.code(), "python_scaffold.module_name.invalid");
        assert!(err.message().contains("\"class\" is a Python keyword"), "{}", err.message());
    }

    #[test]
    fn validate_refuses_an_invalid_floor_instead_of_dropping_it() {
        // ADR-028 §9 (F36): the wizard showed ">=3.13."; the runner must not
        // quietly write a floorless project.
        let mut cfg = config("py-script");
        cfg.interpreter_path = None;
        for bad in ["3.13.", "3..13", "abc", ""] {
            cfg.requires_floor = Some(bad.into());
            let err = validate_config(&cfg).expect_err(bad);
            assert_eq!(err.code(), "python_scaffold.floor.invalid", "{bad}");
        }
        cfg.requires_floor = Some("3.13".into());
        validate_config(&cfg).expect("valid floor");
        cfg.requires_floor = None;
        validate_config(&cfg).expect("no floor is fine");
    }

    #[test]
    fn validate_guards_the_interpreter_in_every_mode() {
        // ADR-028 §9 (F35): the wizard forwards the pick in direct and
        // existing modes too; the guard is the probe's predicate.
        let base = temp_root("interp");
        let good = base.0.join("python3.13t.exe");
        fs::write(&good, b"#!fake").unwrap();
        let evil = base.0.join("evil.exe");
        fs::write(&evil, b"x").unwrap();
        for mode in ["venv", "direct"] {
            let mut cfg = config("py-script");
            cfg.env_mode = mode.into();
            cfg.interpreter_path = Some(evil.to_str().unwrap().into());
            let err = validate_config(&cfg).expect_err(mode);
            assert_eq!(err.code(), "python_scaffold.interpreter.invalid", "{mode}");
            assert!(err.message().contains("file name is not a Python interpreter"), "{}", err.message());
            // A free-threaded build the probe offers is accepted (F31).
            cfg.interpreter_path = Some(good.to_str().unwrap().into());
            validate_config(&cfg).unwrap_or_else(|e| panic!("{mode}: {}", e.message()));
        }
        let mut cfg = config("py-script");
        cfg.env_mode = "existing".into();
        cfg.existing_env = Some(base.0.to_str().unwrap().into());
        cfg.interpreter_path = Some(evil.to_str().unwrap().into());
        assert_eq!(validate_config(&cfg).expect_err("existing").code(), "python_scaffold.interpreter.invalid");
    }

    #[test]
    fn validate_requires_the_existing_environment_to_exist() {
        // ADR-028 §9 (F32): pyright is never pointed at a folder that is not there.
        let base = temp_root("existing");
        let mut cfg = config("py-script");
        cfg.interpreter_path = None;
        cfg.env_mode = "existing".into();
        cfg.existing_env = None;
        assert_eq!(validate_config(&cfg).expect_err("none").code(), "python_scaffold.existing_env.required");
        cfg.existing_env = Some("   ".into());
        assert_eq!(validate_config(&cfg).expect_err("blank").code(), "python_scaffold.existing_env.required");
        cfg.existing_env = Some(base.0.join("missing").to_str().unwrap().into());
        assert_eq!(validate_config(&cfg).expect_err("missing").code(), "python_scaffold.existing_env.missing");
        let file = base.0.join("pyvenv.cfg");
        fs::write(&file, b"x").unwrap();
        cfg.existing_env = Some(file.to_str().unwrap().into());
        assert_eq!(validate_config(&cfg).expect_err("file").code(), "python_scaffold.existing_env.missing");
        cfg.existing_env = Some(base.0.to_str().unwrap().into());
        validate_config(&cfg).expect("an existing folder passes");
    }

    #[test]
    fn env_command_defers_stdlib_without_interpreter_and_uv_runs_without_one() {
        let mut cfg = config("py-script");
        cfg.interpreter_path = None;
        assert!(env_command(&cfg).is_none(), "stdlib venv needs an interpreter");
        cfg.env_engine = "uv".into();
        let (program, args) = env_command(&cfg).expect("uv can pick its own python");
        assert_eq!(program, "uv");
        // ADR-028 §9 (F28): never a download on the offline path.
        assert_eq!(args, vec!["venv", "--no-python-downloads", ".venv"]);
        cfg.interpreter_path = Some("C:\\Py\\python.exe".into());
        let (_, args) = env_command(&cfg).expect("uv with a pick");
        assert_eq!(args, vec!["venv", "--no-python-downloads", ".venv", "--python", "C:\\Py\\python.exe"]);
        cfg.env_mode = "direct".into();
        assert!(env_command(&cfg).is_none(), "direct mode never creates an env");
    }

    /// Acceptance for F28 (brief S6): with uv present and no matching
    /// interpreter, environment creation fails visibly and downloads nothing.
    /// Run: `cargo test python_scaffold::tests::live_uv_refuses -- --ignored --nocapture`
    #[test]
    #[ignore = "spawns the real uv binary"]
    fn live_uv_refuses_to_download_when_no_interpreter_matches() {
        let base = temp_root("uvdl");
        let channel = Channel::new(|_| Ok(()));
        let args: Vec<String> = ["venv", "--no-python-downloads", ".venv", "--python", "3.99"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let result = run_env_command("uv", &args, &base.0, &channel);
        match result {
            Err(message) => eprintln!("uv refused as expected: {message}"),
            Ok(()) => panic!("uv must not satisfy 3.99 without a download"),
        }
        assert!(!base.0.join(".venv").exists(), "no environment may be created");
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
        cfg.interpreter_path = None; // the guard runs in every mode (F35)

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
