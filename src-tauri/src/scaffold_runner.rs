//! Scaffold runner — translates a `ScaffoldConfig` into CLI commands and
//! executes them sequentially, streaming progress events back to the frontend.
//!
//! Every npm-kind wrapper is invoked through the recipe registry
//! (`src/scaffold/recipes.json`, read by `scaffold_recipes.rs` — ADR-028 §1):
//! the primary argv is DERIVED here from the same registry the wizard used
//! for its preview, and a payload whose plan differs is refused before
//! anything executes (ADR-028 §2; pins are exact per ADR-021 §1). The only
//! hard requirement is a working package manager: npm is always available
//! through the bundled Node.js runtime; pnpm and yarn must be installed
//! globally by the user.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;

// Every spawn goes through hidden_command: on Windows a release build has
// no console, and a bare `Command::new` would open one per process.
use crate::platform::hidden_command;
use std::sync::mpsc;

use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::bundled_runtime;
use crate::errors::{CommandError, CommandResult};
use crate::scaffold_recipes::{
    addon_cli_spec, coverage_status, current_platform, derive_primary, is_selectable_status,
    registry, shadcn_cli_for, DerivedPrimary,
};
use crate::scaffold_types::*;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Check whether the required CLI tools are available for a given wrapper +
/// package manager combination.  Always succeeds — the `ready` field in the
/// return value indicates whether all prerequisites are met.
pub(crate) fn check_prerequisites(
    wrapper: &ScaffoldWrapper,
    manager: &PackageManager,
    app: &AppHandle,
) -> PrerequisiteResult {
    let mut tools = Vec::new();

    // Node.js — required for all wrappers (bundled fallback available).
    tools.push(check_node(app));

    // Package manager.
    tools.push(check_package_manager(manager, app));

    // Tauri wrapper needs the Rust toolchain for building (not for scaffolding,
    // but the user won't be able to run the project without it).
    if matches!(wrapper, ScaffoldWrapper::Tauri) {
        tools.push(check_command_tool("cargo", "Rust Toolchain"));
    }

    let ready = tools.iter().all(|t| t.available);
    let message = if ready {
        None
    } else {
        let missing: Vec<&str> = tools
            .iter()
            .filter(|t| !t.available)
            .map(|t| t.name.as_str())
            .collect();
        Some(format!("Missing: {}", missing.join(", ")))
    };

    PrerequisiteResult {
        ready,
        tools,
        message,
    }
}

/// Run the full scaffold pipeline: primary scaffold command followed by
/// optional addon/backend installation steps.
///
/// Progress is streamed to the frontend via `channel`.  The primary scaffold
/// failure is fatal (returns `Err`); addon failures are non-fatal and recorded
/// in `ScaffoldResult.errors`.
pub(crate) fn run_scaffold(
    config: ScaffoldConfig,
    app: &AppHandle,
    channel: &Channel<ScaffoldEvent>,
) -> CommandResult<ScaffoldResult> {
    // Security (audit #12): the CLI-spawning creation path must validate the
    // project name to the same folder-segment contract Blank/Python already
    // enforce — it becomes a directory below AND a subprocess argument. Use the
    // trimmed result consistently for the dir and the arg. The shell
    // metacharacter half of that contract (audit #18) is now belt-and-braces:
    // the global tier spawns an absolute shim, so nothing re-parses the argv
    // (#18b, `absolute_pm_path`). Both layers stay — the validator is the
    // chokepoint (security-policy Rule 4) and covers the folder name too.
    let name = crate::blank_project::validate_project_name(&config.project_name)?;

    // ADR-028 §2: re-derive the plan from the registry with the validated name
    // and refuse the request if the wizard's payload differs in any field —
    // the frontend previews the plan, it does not choose it. Then ADR-028
    // §10: refuse combinations without execution evidence for this platform
    // and manager.
    let derived = validate_plan(&config, name)?;
    enforce_coverage(&config)?;

    // Shared destination chokepoint — see path_guard::resolve_project_destination.
    let location = crate::path_guard::resolve_project_destination(&config.project_location)
        .map_err(|message| CommandError::invalid_path("scaffold.location.invalid", message))?;
    let location = location.as_path();
    let project_dir = location.join(name);

    // Guard: target directory must not already exist.
    if project_dir.exists() {
        return Err(CommandError::conflict(
            "scaffold.target_exists",
            format!(
                "A folder named '{}' already exists at '{}'.",
                config.project_name, config.project_location
            ),
        ));
    }

    // Ensure the parent location exists.
    if !location.exists() {
        std::fs::create_dir_all(location).map_err(|e| {
            CommandError::invalid_path(
                "scaffold.location_create_failed",
                format!(
                    "Cannot create project location '{}': {e}",
                    config.project_location
                ),
            )
        })?;
    }

    // ADR-021 §2: release-age gate — refuse to run a pinned CLI younger than
    // 24 hours on the registry; unreachable registry metadata fails open with
    // a visible warning (the create itself needs the registry anyway).
    run_age_gate(&config, &derived, app, channel)?;

    // Resolve package manager executable.
    let pm = resolve_pm(&config.manager, app)
        .map_err(|e| CommandError::not_found("scaffold.pm_not_found", e))?;

    // ---- Build step list ----

    let mut steps: Vec<ScaffoldStep> = Vec::new();

    // Step 1: the primary route, exactly as derived from the registry (and
    // exactly as the wizard previewed it — validate_plan proved they match).
    // The manager's own verbs (`create --yes … --` for npm, `create` for
    // pnpm/yarn) are part of that derivation.
    let mut primary_args = pm.prefix_args.clone();
    primary_args.extend(derived.argv.iter().cloned());

    steps.push(ScaffoldStep {
        label: format!("Creating {} project", wrapper_label(&config.wrapper)),
        executable: pm.executable.clone(),
        args: primary_args,
        cwd: location.to_path_buf(),
        env: Vec::new(),
    });

    // Post-scaffold steps (framework install for Electron, addons, backend).
    steps.extend(build_post_steps(&config, &pm, &project_dir));

    // ADR-021 §3: scripts-off by default on the npm path.
    apply_scripts_off(&mut steps, &config.manager);

    // ---- Execute steps ----

    let total = steps.len() as u32;
    let mut completed = Vec::new();
    let mut errors = Vec::new();

    for (i, step) in steps.iter().enumerate() {
        let step_num = (i + 1) as u32;

        let _ = channel.send(ScaffoldEvent::StepStarted {
            label: step.label.clone(),
            step: step_num,
            total,
        });

        match run_step_command(step, channel) {
            Ok(()) => {
                completed.push(step.label.clone());
                let _ = channel.send(ScaffoldEvent::StepCompleted {
                    label: step.label.clone(),
                    step: step_num,
                });
            }
            Err(e) => {
                let _ = channel.send(ScaffoldEvent::StepFailed {
                    label: step.label.clone(),
                    step: step_num,
                    error: e.clone(),
                });

                if i == 0 {
                    // Primary scaffold failed — nothing to salvage.
                    let _ = channel.send(ScaffoldEvent::Done { success: false });
                    return Err(CommandError::internal(
                        "scaffold.primary_failed",
                        format!("Scaffold failed: {e}"),
                    ));
                }

                // Addon/post-scaffold failure is non-fatal.
                errors.push(format!("{}: {e}", step.label));
            }
        }
    }

    // ADR-021 §4: advisory check — non-blocking by design. Findings inform;
    // they never roll back the scaffold (the files are inert, no dependency
    // scripts have run). Reaching this point means the primary step succeeded.
    let audit_status = run_dependency_audit(&config, &pm, &project_dir, channel);

    // ADR-021 §2: pnpm projects get pnpm's native full-tree cooldown written
    // into their config (npm has no equivalent setting to write).
    if matches!(config.manager, PackageManager::Pnpm) {
        match write_pnpm_release_age(&project_dir) {
            Ok(Some(label)) => completed.push(label),
            Ok(None) => {} // scaffold already configured its own cooldown
            Err(e) => {
                let msg = format!("Writing pnpm minimumReleaseAge: {e}");
                let _ = channel.send(ScaffoldEvent::Warning { line: msg.clone() });
                errors.push(msg);
            }
        }
    }

    let success = errors.is_empty();
    let _ = channel.send(ScaffoldEvent::Done { success });

    Ok(ScaffoldResult {
        success,
        project_path: project_dir.to_string_lossy().to_string(),
        steps_completed: completed,
        errors,
        scripts_skipped: matches!(config.manager, PackageManager::Npm),
        audit_status,
    })
}

// ---------------------------------------------------------------------------
// Prerequisite checking
// ---------------------------------------------------------------------------

fn check_node(app: &AppHandle) -> ToolStatus {
    // Global Node.js on PATH.
    if probe_command_exists("node") {
        return ToolStatus {
            name: "Node.js".into(),
            available: true,
            version: get_command_version("node", "--version"),
            source: Some("global".into()),
        };
    }

    // Bundled Node.js.
    if let Some(path) = bundled_runtime::extracted_node_binary(app) {
        if path.exists() {
            return ToolStatus {
                name: "Node.js".into(),
                available: true,
                version: Some(crate::lsp::packs::versions::NODE_VERSION.to_string()),
                source: Some("bundled".into()),
            };
        }
    }

    ToolStatus {
        name: "Node.js".into(),
        available: false,
        version: None,
        source: None,
    }
}

fn check_package_manager(manager: &PackageManager, app: &AppHandle) -> ToolStatus {
    match manager {
        PackageManager::Npm => {
            // Bundled npm (always available when bundled Node.js is extracted).
            if let Some(npm_path) = bundled_runtime::extracted_npm_cli(app) {
                if npm_path.exists() {
                    return ToolStatus {
                        name: "npm".into(),
                        available: true,
                        version: None,
                        source: Some("bundled".into()),
                    };
                }
            }
            // Global npm.
            if probe_command_exists("npm") {
                return ToolStatus {
                    name: "npm".into(),
                    available: true,
                    version: get_command_version("npm", "--version"),
                    source: Some("global".into()),
                };
            }
            ToolStatus {
                name: "npm".into(),
                available: false,
                version: None,
                source: None,
            }
        }
        PackageManager::Pnpm => check_command_tool("pnpm", "pnpm"),
        PackageManager::Yarn => check_command_tool("yarn", "yarn"),
    }
}

fn check_command_tool(command: &str, display_name: &str) -> ToolStatus {
    let available = probe_command_exists(command);
    ToolStatus {
        name: display_name.into(),
        available,
        version: if available {
            get_command_version(command, "--version")
        } else {
            None
        },
        source: if available {
            Some("global".into())
        } else {
            None
        },
    }
}

/// Return true if the given command can be found by the OS.
fn probe_command_exists(command: &str) -> bool {
    let result = if cfg!(windows) {
        hidden_command("where")
            .arg(command)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    } else {
        hidden_command("which")
            .arg(command)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    };
    result.map(|s| s.success()).unwrap_or(false)
}

/// Read a tool's `--version` for the prerequisite report (display only).
///
/// Goes through `absolute_pm_path` rather than `cmd /C <command>` so this
/// module has no bare-name spawn left at all (audit #18b). `command` is always
/// a literal here, so this is hygiene rather than a live hole — but leaving one
/// `cmd /C` behind is how the next argument finds its way into a second parse.
fn get_command_version(command: &str, version_arg: &str) -> Option<String> {
    let exe = absolute_pm_path(command)?;
    let mut cmd = hidden_command(&exe);
    cmd.arg(version_arg);
    let output = cmd.output();
    output.ok().and_then(|o| {
        if o.status.success() {
            let raw = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if raw.is_empty() {
                None
            } else {
                Some(raw)
            }
        } else {
            None
        }
    })
}

// ---------------------------------------------------------------------------
// Package manager resolution
// ---------------------------------------------------------------------------

/// Resolved package manager ready for spawning.
struct ResolvedPM {
    /// Absolute path to the executable to invoke — `node.exe` for the bundled
    /// tier, the resolved shim (`…\pnpm.cmd`, `/usr/bin/pnpm`) for the global
    /// tier. Never a bare name: see `absolute_pm_path` (audit #18b).
    executable: String,
    /// Arguments inserted before the subcommand (`["<npm-cli.js>"]` for bundled
    /// npm; empty for the global tier).
    prefix_args: Vec<String>,
}

fn resolve_pm(manager: &PackageManager, app: &AppHandle) -> Result<ResolvedPM, String> {
    match manager {
        PackageManager::Npm => resolve_npm(app),
        PackageManager::Pnpm => resolve_global_pm("pnpm"),
        PackageManager::Yarn => resolve_global_pm("yarn"),
    }
}

fn resolve_npm(app: &AppHandle) -> Result<ResolvedPM, String> {
    // Prefer bundled npm for reliability — always available after extraction.
    let node_bin = bundled_runtime::extracted_node_binary(app);
    let npm_cli = bundled_runtime::extracted_npm_cli(app);

    if let (Some(node), Some(npm)) = (node_bin, npm_cli) {
        if node.exists() && npm.exists() {
            return Ok(ResolvedPM {
                executable: node.to_string_lossy().into_owned(),
                prefix_args: vec![npm.to_string_lossy().into_owned()],
            });
        }
    }

    // Fallback: global npm — resolved to an absolute shim, same as pnpm/yarn.
    if let Ok(pm) = resolve_global_pm("npm") {
        return Ok(pm);
    }

    Err("npm is not available. Install Node.js or wait for the bundled runtime to extract.".into())
}

fn resolve_global_pm(name: &str) -> Result<ResolvedPM, String> {
    let Some(path) = absolute_pm_path(name) else {
        return Err(format!(
            "{name} is not installed. Run: npm install -g {name}"
        ));
    };
    Ok(ResolvedPM {
        executable: path.to_string_lossy().into_owned(),
        prefix_args: vec![],
    })
}

/// Resolve a globally-installed package-manager name to the absolute file that
/// a launch from THIS process's working directory would pick.
///
/// Security (audit #18b — structural half of #18): the previous shape was
/// `cmd /C <name> …` on Windows, which hands the whole argument vector back to
/// cmd.exe for a second parse. A project name containing `&` was therefore a
/// command separator: `cmd /C show demo&marker` runs `show demo`, then
/// `marker.bat`. The blocklist half (`& ^ ( ) % !` in `validate_project_name`)
/// holds that line, but the structural fix is to never re-enter cmd.exe at all:
/// `Command::new(<abs>\pnpm.cmd)` passes the same argument as a single inert
/// token via Rust's post-CVE-2024-24576 batch escaping. It also removes the
/// bare-name lookup, so the child's own directory can no longer shadow the
/// shim (the audit #17 hazard, in the scaffold domain).
///
/// `where`/`which` list candidates in search order, but the first line is NOT
/// always the right one: `where npm` answers with the extension-less Unix shell
/// script (`…\nodejs\npm`) BEFORE `…\nodejs\npm.cmd`, and Windows cannot
/// execute the former at all. Prefer the first candidate carrying an executable
/// extension, and only fall back to the first line when none does (which is the
/// normal Unix answer).
///
/// Deliberately invoked from Litria's own cwd, never the project location.
fn absolute_pm_path(name: &str) -> Option<PathBuf> {
    let mut cmd = if cfg!(windows) {
        let mut c = hidden_command("where");
        c.arg(name);
        c
    } else {
        let mut c = hidden_command("which");
        c.arg(name);
        c
    };
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let candidates: Vec<&str> = stdout
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    let chosen = candidates
        .iter()
        .find(|c| has_executable_extension(c))
        .or_else(|| candidates.first())?;

    let path = PathBuf::from(chosen);
    // A PATH holding `.` or an empty entry makes `which` answer with a RELATIVE
    // path; POSIX defines both AS the cwd. Canonicalize while our own cwd is
    // still the frame of reference — the step is spawned with `cwd` set to the
    // project location, where a relative answer would re-resolve.
    let path = if path.is_absolute() {
        path
    } else {
        std::fs::canonicalize(&path).ok()?
    };
    path.is_file().then_some(path)
}

/// Extensions Windows will actually execute as a program. Kept to the subset
/// a package-manager shim ever uses; a `.js`/`.vbs` PATHEXT hit is not
/// something the scaffold runner should launch directly.
fn has_executable_extension(candidate: &str) -> bool {
    Path::new(candidate)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            e == "exe" || e == "cmd" || e == "bat" || e == "com"
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Plan validation (ADR-028 §2) and coverage enforcement (ADR-028 §10)
// ---------------------------------------------------------------------------

/// Re-derive the primary route from the registry and require the wizard's
/// payload to match it field for field. A mismatch is a broken
/// frontend/registry contract (or a tampered payload), never a user error.
fn validate_plan(config: &ScaffoldConfig, name: &str) -> Result<DerivedPrimary, CommandError> {
    let derived = derive_primary(
        config.wrapper.id(),
        config.framework.id(),
        config.language.id(),
        config.manager.id(),
        name,
    )
    .map_err(|reason| {
        CommandError::conflict(
            "scaffold.recipe_unsupported",
            format!("This combination cannot be scaffolded: {reason}"),
        )
    })?;

    let plan = &config.plan;
    let mismatch = |field: &str, sent: String, expected: String| {
        CommandError::internal(
            "scaffold.plan_mismatch",
            format!(
                "The previewed plan does not match the recipe registry ({field}: sent '{sent}', \
                 expected '{expected}'). Refusing to run a command that was not shown."
            ),
        )
    };
    let schema_version = registry().schema_version;
    if plan.schema_version != schema_version {
        return Err(mismatch(
            "schemaVersion",
            plan.schema_version.to_string(),
            schema_version.to_string(),
        ));
    }
    if plan.route_kind != derived.route_kind {
        return Err(mismatch("routeKind", plan.route_kind.clone(), derived.route_kind.clone()));
    }
    if plan.package != derived.package {
        return Err(mismatch("package", plan.package.clone(), derived.package.clone()));
    }
    if plan.version != derived.version {
        return Err(mismatch("version", plan.version.clone(), derived.version.clone()));
    }
    if plan.template != derived.template {
        return Err(mismatch("template", plan.template.clone(), derived.template.clone()));
    }
    if plan.argv != derived.argv {
        return Err(mismatch("argv", plan.argv.join(" "), derived.argv.join(" ")));
    }
    let platform = current_platform();
    if plan.platform != platform {
        return Err(mismatch("platform", plan.platform.clone(), platform.to_string()));
    }
    Ok(derived)
}

/// ADR-028 §10: only combinations with execution evidence for this platform
/// and manager may run. The wizard disables the same combinations with the
/// same reason; this is the enforcement the UI cannot bypass.
fn enforce_coverage(config: &ScaffoldConfig) -> Result<(), CommandError> {
    let platform = current_platform();
    let (status, reason) = coverage_status(
        config.wrapper.id(),
        config.framework.id(),
        config.language.id(),
        config.manager.id(),
        platform,
    );
    if is_selectable_status(&status) {
        return Ok(());
    }
    let label = format!(
        "{} + {} ({}) with {} on {}",
        config.wrapper.id(),
        config.framework.id(),
        config.language.id(),
        config.manager.id(),
        platform
    );
    let detail = match (status.as_str(), reason) {
        ("failing", Some(r)) => format!("failed verification: {r}"),
        ("failing", None) => "failed verification".to_string(),
        _ => "has no execution evidence yet (ADR-028 §10) and is not offered".to_string(),
    };
    Err(CommandError::conflict(
        "scaffold.recipe_unverified",
        format!("{label} {detail}."),
    ))
}

/// Split `name@version`, requiring an exact version (`X.Y.Z`, optional
/// prerelease). Ranges, tags (`latest`, `next`), wildcards, and bare names
/// are refused: the registry is the only source of versions and this is
/// the enforced floor beneath it.
fn parse_exact_spec(spec: &str) -> Result<(&str, &str), String> {
    // Split at the last '@' so scoped names (`@scope/pkg@1.2.3`) stay intact.
    let at = spec
        .rfind('@')
        .filter(|&i| i > 0)
        .ok_or_else(|| format!("'{spec}' has no pinned version"))?;
    let (name, version) = (&spec[..at], &spec[at + 1..]);
    if !is_exact_version(version) {
        return Err(format!(
            "'{spec}' is not pinned to an exact version — ranges, tags, and 'latest' are refused"
        ));
    }
    Ok((name, version))
}

fn is_exact_version(version: &str) -> bool {
    let (core, prerelease) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    let segments: Vec<&str> = core.split('.').collect();
    if segments.len() != 3 {
        return false;
    }
    if !segments
        .iter()
        .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
    {
        return false;
    }
    match prerelease {
        None => true,
        Some(pre) => {
            !pre.is_empty()
                && pre
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        }
    }
}

// ---------------------------------------------------------------------------
// Release-age gate (ADR-021 §2)
// ---------------------------------------------------------------------------

/// Minimum registry age before a pinned CLI version may execute.
const AGE_GATE_HOURS: i64 = 24;

/// Every third-party CLI spec this config will execute, with whether it is
/// an `npm create` initializer (queried under its `create-` name) or a real
/// package run through exec/dlx (queried verbatim): the primary route, plus
/// the shadcn variant when that addon is selected. All come from the
/// registry, which the JS suite holds to exact versions.
fn specs_to_execute(config: &ScaffoldConfig, derived: &DerivedPrimary) -> Vec<(String, bool)> {
    let mut specs = vec![(derived.spec(), derived.route_kind == "initializer")];
    let wants_shadcn = config
        .addons
        .iter()
        .any(|a| matches!(a, ScaffoldAddon::ShadCN));
    if wants_shadcn {
        if let Some(pkg) = shadcn_cli_for(config.framework.id()) {
            if let Some(spec) = addon_cli_spec(&pkg) {
                specs.push((spec, false));
            }
        }
    }
    specs
}

/// Registry package behind an `npm create <key>` initializer.
///
/// `npm create foo` executes package `create-foo` (scoped: `@s/foo` →
/// `@s/create-foo`) — npm expands the name itself, which is why the trace
/// shows `create-tauri-app` while the pin registry stores `tauri-app`
/// (create-cli-versions.js keys are the SHORT invocation names).
///
/// The age gate must expand the same way or it queries a package that is not
/// the one we execute. It previously did not, so it asked the registry about
/// `tauri-app` (unpublished since 2023), `vite` (a real but unrelated
/// package), and `electron-app` (likewise) — meaning ADR-021 §2 never
/// verified the age of anything it actually runs.
fn initializer_package(name: &str) -> String {
    if let Some(rest) = name.strip_prefix('@') {
        // Scoped: the prefix goes on the package part, not the scope.
        return match rest.split_once('/') {
            Some((scope, pkg)) if !pkg.starts_with("create-") => {
                format!("@{scope}/create-{pkg}")
            }
            _ => name.to_string(),
        };
    }
    if name.starts_with("create-") {
        return name.to_string();
    }
    format!("create-{name}")
}

enum AgeGateFetch {
    Published(chrono::DateTime<chrono::FixedOffset>),
    /// Registry answered but the pinned version does not exist.
    VersionMissing,
    /// Metadata could not be obtained or understood — fail open (ADR-021 §2).
    Unreachable(String),
}

/// Interpret `npm view <name> time --json` output for one pinned version.
/// Only a well-formed time map that lacks the version is a hard miss;
/// malformed output is treated as unreachable so the gate fails open.
fn publish_time_from_view_json(json: &str, version: &str) -> AgeGateFetch {
    let value: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(e) => return AgeGateFetch::Unreachable(format!("unexpected npm output: {e}")),
    };
    let Some(map) = value.as_object() else {
        return AgeGateFetch::Unreachable("unexpected npm output shape".into());
    };
    match map.get(version).and_then(|v| v.as_str()) {
        None => AgeGateFetch::VersionMissing,
        Some(ts) => match chrono::DateTime::parse_from_rfc3339(ts) {
            Ok(dt) => AgeGateFetch::Published(dt),
            Err(e) => {
                AgeGateFetch::Unreachable(format!("unparseable publish time '{ts}': {e}"))
            }
        },
    }
}

/// True when the version is too young to execute. A publish time ahead of
/// the local clock also counts as too young — a future timestamp is exactly
/// the kind of oddity the gate exists to pause on.
fn younger_than_gate(
    published: chrono::DateTime<chrono::FixedOffset>,
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    now.signed_duration_since(published) < chrono::Duration::hours(AGE_GATE_HOURS)
}

enum AgeGateFetchError {
    /// Registry reachable, package absent (npm E404).
    PackageMissing,
    Unreachable(String),
}

/// Query the registry for a package's publish-time map through bundled npm —
/// metadata only, no third-party code runs. Fetch timeouts are bounded so a
/// dead network fails open promptly instead of hanging the wizard.
fn fetch_view_time_json(app: &AppHandle, name: &str) -> Result<String, AgeGateFetchError> {
    let pm = resolve_npm(app)
        .map_err(|e| AgeGateFetchError::Unreachable(format!("npm unavailable: {e}")))?;
    let mut cmd = hidden_command(&pm.executable);
    cmd.args(&pm.prefix_args);
    cmd.args([
        "view",
        name,
        "time",
        "--json",
        "--fetch-retries=1",
        "--fetch-timeout=10000",
        // mintimeout MUST be set alongside maxtimeout. npm's default
        // fetch-retry-mintimeout is 10000, so lowering only maxtimeout leaves
        // min > max and npm aborts with "minTimeout is greater than
        // maxTimeout" the moment a request becomes retryable — replacing the
        // real network reason with a config error, and hiding E404 from the
        // check below (which is how a wrong package name went unnoticed).
        "--fetch-retry-mintimeout=1000",
        "--fetch-retry-maxtimeout=5000",
    ]);
    match cmd.output() {
        Err(e) => Err(AgeGateFetchError::Unreachable(format!(
            "could not run npm: {e}"
        ))),
        Ok(out) if out.status.success() => {
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            if stderr.contains("E404") || stdout.contains("E404") {
                Err(AgeGateFetchError::PackageMissing)
            } else {
                let reason = stderr.lines().next().unwrap_or("npm view failed").trim();
                Err(AgeGateFetchError::Unreachable(reason.to_string()))
            }
        }
    }
}

/// ADR-021 §2 — refuse to execute any pinned CLI younger than the gate;
/// fail open (with a visible warning) when registry metadata is unreachable.
fn run_age_gate(
    config: &ScaffoldConfig,
    derived: &DerivedPrimary,
    app: &AppHandle,
    channel: &Channel<ScaffoldEvent>,
) -> Result<(), CommandError> {
    for (spec, is_initializer) in specs_to_execute(config, derived) {
        // Registry specs are exact by construction; skip defensively.
        let Ok((name, version)) = parse_exact_spec(&spec) else {
            continue;
        };
        // Only an `npm create` initializer needs the `create-` prefix. Exec
        // routes and addon CLIs run under their real package names
        // (shadcn, shadcn-vue, @angular/cli, …), so they are queried verbatim.
        let package = if is_initializer {
            initializer_package(name)
        } else {
            name.to_string()
        };
        let fetch = match fetch_view_time_json(app, &package) {
            Ok(json) => publish_time_from_view_json(&json, version),
            Err(AgeGateFetchError::PackageMissing) => AgeGateFetch::VersionMissing,
            Err(AgeGateFetchError::Unreachable(reason)) => AgeGateFetch::Unreachable(reason),
        };
        match fetch {
            AgeGateFetch::Published(published) => {
                let now = chrono::Utc::now();
                if younger_than_gate(published, now) {
                    let age_hours = now.signed_duration_since(published).num_hours().max(0);
                    return Err(CommandError::conflict(
                        "scaffold.age_gate",
                        format!(
                            "{package}@{version} was published {age_hours} hour(s) ago. Litria \
                             waits {AGE_GATE_HOURS} hours before running a newly released tool \
                             so the ecosystem's scanners get there first. Try again later."
                        ),
                    ));
                }
            }
            AgeGateFetch::VersionMissing => {
                return Err(CommandError::not_found(
                    "scaffold.pinned_version_missing",
                    format!(
                        "{package}@{version} does not exist on the npm registry — the recipe \
                         registry (src/scaffold/recipes.json) needs a corrected version."
                    ),
                ));
            }
            AgeGateFetch::Unreachable(reason) => {
                let _ = channel.send(ScaffoldEvent::Warning {
                    line: format!(
                        "Couldn't verify the release age of {package}@{version} ({reason}). \
                         Continuing — the scaffold itself will fail if the registry is truly \
                         unreachable."
                    ),
                });
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Dependency audit (ADR-021 §4)
// ---------------------------------------------------------------------------

/// Classify an `npm audit` run for the capstone summary. npm exits nonzero
/// both for findings and for outages; the "vulnerabilit" marker in its
/// output separates them. Either way the result is advisory — the
/// classification only changes the message, never the scaffold outcome.
fn classify_audit_output(exit_ok: bool, output: &str) -> &'static str {
    if exit_ok {
        return "clean";
    }
    if output.to_lowercase().contains("vulnerabilit") {
        "findings"
    } else {
        "unavailable"
    }
}

/// Run one short-lived command of the audit pair, captured (output is
/// replayed into the progress feed after completion).
fn run_captured(
    pm: &ResolvedPM,
    extra_args: &[&str],
    cwd: &Path,
) -> Result<(bool, String), String> {
    let mut cmd = hidden_command(&pm.executable);
    cmd.args(&pm.prefix_args);
    cmd.args(extra_args);
    cmd.current_dir(cwd);
    cmd.env("CI", "true");
    match cmd.output() {
        Err(e) => Err(format!("could not run {}: {e}", pm.executable)),
        Ok(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr);
            if !stderr.trim().is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(stderr.trim_end());
            }
            Ok((out.status.success(), text))
        }
    }
}

fn send_output_lines(channel: &Channel<ScaffoldEvent>, text: &str, max_lines: usize) {
    for line in text.lines().filter(|l| !l.trim().is_empty()).take(max_lines) {
        let _ = channel.send(ScaffoldEvent::StepOutput {
            line: line.to_string(),
        });
    }
}

/// ADR-021 §4 — `npm audit` at scaffold time, non-blocking, fail-open.
///
/// Plain create-CLI scaffolds leave no lockfile (they do not install), and
/// `npm audit` requires one — so the audit runs as a pair: a
/// `--package-lock-only` resolve (writes package-lock.json, installs
/// nothing; also snapshots resolution for the user's later `npm install`)
/// followed by the audit itself. Findings and outages both surface as
/// Warning events; only the recorded status differs.
fn run_dependency_audit(
    config: &ScaffoldConfig,
    pm: &ResolvedPM,
    project_dir: &Path,
    channel: &Channel<ScaffoldEvent>,
) -> String {
    if !matches!(config.manager, PackageManager::Npm) {
        // pnpm carries its own scripts-off default + minimumReleaseAge
        // cooldown; yarn is a user-chosen global. Per-manager coverage is
        // stated by the posture note (§5).
        return "skipped".into();
    }

    let _ = channel.send(ScaffoldEvent::StepOutput {
        line: "Auditing dependencies (advisory — findings never roll back the scaffold)...".into(),
    });

    let resolved = match run_captured(
        pm,
        &[
            "install",
            "--package-lock-only",
            "--ignore-scripts",
            "--fetch-retries=1",
            "--fetch-timeout=30000",
        ],
        project_dir,
    ) {
        Ok((true, _)) => true,
        Ok((false, out)) => {
            let first = out
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("lockfile resolve failed");
            let _ = channel.send(ScaffoldEvent::Warning {
                line: format!(
                    "Couldn't resolve a lockfile for auditing ({first}) — skipping the \
                     dependency audit; the scaffold is otherwise complete."
                ),
            });
            false
        }
        Err(reason) => {
            let _ = channel.send(ScaffoldEvent::Warning {
                line: format!(
                    "Couldn't resolve a lockfile for auditing ({reason}) — skipping the \
                     dependency audit; the scaffold is otherwise complete."
                ),
            });
            false
        }
    };
    if !resolved {
        return "unavailable".into();
    }

    match run_captured(pm, &["audit"], project_dir) {
        Err(reason) => {
            let _ = channel.send(ScaffoldEvent::Warning {
                line: format!("npm audit could not run ({reason}) — audit unavailable."),
            });
            "unavailable".into()
        }
        Ok((ok, output)) => {
            send_output_lines(channel, &output, 30);
            let status = classify_audit_output(ok, &output);
            match status {
                "findings" => {
                    let _ = channel.send(ScaffoldEvent::Warning {
                        line: "npm audit reported findings — review the lines above. \
                               Dependencies are resolved but nothing has executed; adjust \
                               versions before enabling scripts."
                            .into(),
                    });
                }
                "unavailable" => {
                    let _ = channel.send(ScaffoldEvent::Warning {
                        line: "npm audit could not reach the advisory service — audit \
                               unavailable; the scaffold is otherwise complete."
                            .into(),
                    });
                }
                _ => {}
            }
            status.into()
        }
    }
}

/// Write pnpm's `minimumReleaseAge` cooldown (24h, in minutes) into the
/// scaffolded project. Returns the step label on write, `None` when the
/// scaffold already configured its own cooldown.
fn write_pnpm_release_age(project_dir: &Path) -> Result<Option<String>, String> {
    let path = project_dir.join("pnpm-workspace.yaml");
    let existing = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("reading {}: {e}", path.display())),
    };
    if existing.contains("minimumReleaseAge") {
        return Ok(None);
    }
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(
        "# Litria (ADR-021): wait 24h after a version is published before installing it.\n\
         minimumReleaseAge: 1440\n",
    );
    std::fs::write(&path, content).map_err(|e| format!("writing {}: {e}", path.display()))?;
    Ok(Some("Enabled pnpm 24h release-age cooldown".into()))
}

fn wrapper_label(wrapper: &ScaffoldWrapper) -> &'static str {
    match wrapper {
        ScaffoldWrapper::Tauri => "Tauri",
        ScaffoldWrapper::Electron => "Electron",
        ScaffoldWrapper::Web => "Vite",
    }
}

// ---------------------------------------------------------------------------
// Post-scaffold steps
// ---------------------------------------------------------------------------

/// Internal step descriptor.
struct ScaffoldStep {
    label: String,
    executable: String,
    args: Vec<String>,
    cwd: PathBuf,
    /// Extra environment for the step; inherited by every child process the
    /// step spawns (which is how nested installs get covered — ADR-021 §3).
    env: Vec<(String, String)>,
}

fn build_post_steps(
    config: &ScaffoldConfig,
    pm: &ResolvedPM,
    project_dir: &Path,
) -> Vec<ScaffoldStep> {
    let mut steps = Vec::new();

    // Electron: framework is a post-scaffold install (Forge templates are
    // bundler-only; the framework is added separately).
    if matches!(config.wrapper, ScaffoldWrapper::Electron) {
        if let Some(step) = build_electron_framework_step(&config.framework, pm, project_dir) {
            steps.push(step);
        }
    }

    // Addons.
    for addon in &config.addons {
        if let Some(step) = build_addon_step(addon, config, pm, project_dir) {
            steps.push(step);
        }
    }

    // Backend (Web Only wrapper).
    if let Some(ref backend) = config.backend {
        if let Some(step) = build_backend_step(backend, pm, project_dir) {
            steps.push(step);
        }
    }

    steps
}

fn build_electron_framework_step(
    framework: &ScaffoldFramework,
    pm: &ResolvedPM,
    project_dir: &Path,
) -> Option<ScaffoldStep> {
    let (deps, label) = match framework {
        ScaffoldFramework::React => (
            vec!["react", "react-dom", "@vitejs/plugin-react"],
            "Installing React",
        ),
        ScaffoldFramework::Svelte => (
            vec!["svelte", "@sveltejs/vite-plugin-svelte"],
            "Installing Svelte",
        ),
        ScaffoldFramework::Vue => (vec!["vue", "@vitejs/plugin-vue"], "Installing Vue"),
        ScaffoldFramework::Solid => (
            vec!["solid-js", "vite-plugin-solid"],
            "Installing Solid",
        ),
        // Angular + Electron is a complex setup — skip in MVP.
        ScaffoldFramework::Angular => return None,
    };

    if deps.is_empty() {
        return None;
    }

    Some(make_install_step(label, &deps, false, pm, project_dir))
}

fn build_addon_step(
    addon: &ScaffoldAddon,
    config: &ScaffoldConfig,
    pm: &ResolvedPM,
    project_dir: &Path,
) -> Option<ScaffoldStep> {
    let framework = &config.framework;
    match addon {
        ScaffoldAddon::Tailwind => Some(make_install_step(
            "Installing Tailwind CSS",
            &["tailwindcss", "@tailwindcss/vite"],
            true, // dev dependency
            pm,
            project_dir,
        )),
        ScaffoldAddon::ShadCN => {
            // Each framework has its own shadcn variant with a dedicated CLI,
            // pinned in the recipe registry. Absence there means the registry
            // is incomplete, and skipping the step beats executing an
            // unpinned CLI (ADR-021 §1).
            let pkg = shadcn_cli_for(framework.id())?;
            let init_pkg = addon_cli_spec(&pkg)?;
            let label = match framework {
                ScaffoldFramework::React => "Installing shadcn/ui",
                ScaffoldFramework::Svelte => "Installing shadcn-svelte",
                ScaffoldFramework::Vue => "Installing shadcn-vue",
                _ => return None,
            };
            let mut args = pm.prefix_args.clone();
            // Manager-specific "run a package binary" form: npm has no dlx
            // (that is pnpm/yarn-berry vocabulary) — its equivalent is
            // `exec --yes`. Yarn keeps dlx: correct on Yarn 2+; classic
            // Yarn 1 has no equivalent and fails visibly in the step rather
            // than silently skipping the selected addon.
            match config.manager {
                PackageManager::Npm => {
                    args.extend([
                        "exec".into(),
                        "--yes".into(),
                        "--".into(),
                        init_pkg,
                        "init".into(),
                        "-y".into(),
                    ]);
                }
                PackageManager::Pnpm | PackageManager::Yarn => {
                    args.extend(["dlx".into(), init_pkg, "init".into(), "-y".into()]);
                }
            }
            Some(ScaffoldStep {
                label: label.into(),
                executable: pm.executable.clone(),
                args,
                cwd: project_dir.to_path_buf(),
                env: Vec::new(),
            })
        }
        ScaffoldAddon::Router => {
            // Each framework has its own router package.
            let deps: &[&str] = match framework {
                ScaffoldFramework::React => &["react-router-dom"],
                ScaffoldFramework::Vue => &["vue-router"],
                ScaffoldFramework::Solid => &["@solidjs/router"],
                // Angular has built-in routing; Svelte uses SvelteKit routing.
                _ => return None,
            };
            Some(make_install_step("Installing Router", deps, false, pm, project_dir))
        }
    }
}

fn build_backend_step(
    backend: &ScaffoldBackend,
    pm: &ResolvedPM,
    project_dir: &Path,
) -> Option<ScaffoldStep> {
    match backend {
        ScaffoldBackend::Express => Some(make_install_step(
            "Installing Express",
            &["express"],
            false,
            pm,
            project_dir,
        )),
        ScaffoldBackend::Fastify => Some(make_install_step(
            "Installing Fastify",
            &["fastify"],
            false,
            pm,
            project_dir,
        )),
        // Axum needs a separate Cargo project — out of scope for the npm-based runner.
        ScaffoldBackend::Axum => None,
    }
}

/// Helper: build an `<pm> install [-D] <deps...>` step.
fn make_install_step(
    label: &str,
    deps: &[&str],
    dev: bool,
    pm: &ResolvedPM,
    project_dir: &Path,
) -> ScaffoldStep {
    let mut args = pm.prefix_args.clone();
    args.push("install".into());
    if dev {
        args.push("-D".into());
    }
    args.extend(deps.iter().map(|d| String::from(*d)));

    ScaffoldStep {
        label: label.into(),
        executable: pm.executable.clone(),
        args,
        cwd: project_dir.to_path_buf(),
        env: Vec::new(),
    }
}

/// ADR-021 §3 — scripts-off by default on the npm path, one choke point:
///
/// * Every step gets `npm_config_ignore_scripts=true` in its environment.
///   npm reads `npm_config_*` from env and child processes inherit it, so
///   installs a create CLI runs *internally* (e.g. Electron Forge's) are
///   covered too — not just the steps Litria builds itself.
/// * Steps that are literal `install` commands additionally get the explicit
///   `--ignore-scripts` flag and a "(scripts off)" label suffix, so the
///   progress feed states what actually ran.
///
/// pnpm ships scripts-off as its own default (v10+) and is left native;
/// yarn is a user-chosen global and is untouched (the posture note states
/// coverage per manager).
fn apply_scripts_off(steps: &mut [ScaffoldStep], manager: &PackageManager) {
    if !matches!(manager, PackageManager::Npm) {
        return;
    }
    for step in steps.iter_mut() {
        step.env
            .push(("npm_config_ignore_scripts".into(), "true".into()));
        if let Some(pos) = step.args.iter().position(|a| a == "install") {
            step.args.insert(pos + 1, "--ignore-scripts".into());
            step.label.push_str(" (scripts off)");
        }
    }
}

// ---------------------------------------------------------------------------
// Command execution with streaming
// ---------------------------------------------------------------------------

/// Spawn a process, stream its stdout/stderr line-by-line through the Tauri
/// `Channel`, and return `Ok(())` on success or `Err(message)` on non-zero exit.
fn run_step_command(step: &ScaffoldStep, channel: &Channel<ScaffoldEvent>) -> Result<(), String> {
    let mut cmd = hidden_command(&step.executable);
    cmd.args(&step.args)
        .current_dir(&step.cwd)
        .stdin(Stdio::null())    // No interactive prompts — EOF on stdin
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("CI", "true")       // Node.js tools skip prompts when CI=true
        .envs(step.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));


    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start '{}': {e}", step.executable))?;

    // Stream stdout + stderr through an mpsc channel so we don't need
    // Channel<ScaffoldEvent> to be Clone.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (tx, rx) = mpsc::channel::<String>();
    let tx_err = tx.clone();

    let out_thread = std::thread::spawn(move || {
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().flatten() {
                let _ = tx.send(line);
            }
        }
    });

    let err_thread = std::thread::spawn(move || {
        if let Some(err) = stderr {
            for line in BufReader::new(err).lines().flatten() {
                let _ = tx_err.send(line);
            }
        }
    });

    // Forward merged output to the Tauri Channel.
    for line in rx {
        let _ = channel.send(ScaffoldEvent::StepOutput { line });
    }

    // Reader threads are done — pipes closed, process exited.
    let _ = out_thread.join();
    let _ = err_thread.join();

    let status = child
        .wait()
        .map_err(|e| format!("Wait failed for '{}': {e}", step.executable))?;

    if status.success() {
        Ok(())
    } else {
        let code = status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "unknown".into());
        Err(format!("Process exited with code {code}"))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Config builder mirroring what the wizard sends: the plan block is the
    /// registry derivation for the selection (ADR-028 §2).
    fn planned_config(
        wrapper: ScaffoldWrapper,
        framework: ScaffoldFramework,
        language: ScaffoldLanguage,
        manager: PackageManager,
    ) -> ScaffoldConfig {
        let derived = derive_primary(wrapper.id(), framework.id(), language.id(), manager.id(), "test")
            .expect("test selections have a route");
        ScaffoldConfig {
            project_name: "test".into(),
            project_location: "/tmp".into(),
            wrapper,
            framework,
            language,
            backend: None,
            addons: vec![],
            manager,
            theme: "glass".into(),
            plan: ScaffoldPlanPayload {
                schema_version: registry().schema_version,
                route_kind: derived.route_kind.clone(),
                package: derived.package.clone(),
                version: derived.version.clone(),
                template: derived.template.clone(),
                argv: derived.argv.clone(),
                platform: current_platform().to_string(),
            },
        }
    }

    fn web_react_ts_npm() -> ScaffoldConfig {
        planned_config(
            ScaffoldWrapper::Web,
            ScaffoldFramework::React,
            ScaffoldLanguage::TypeScript,
            PackageManager::Npm,
        )
    }

    // ---- Plan validation (ADR-028 §2) ----

    #[test]
    fn validate_plan_accepts_the_registry_derivation() {
        let config = web_react_ts_npm();
        let derived = validate_plan(&config, "test").expect("matching plan passes");
        assert_eq!(derived.argv, config.plan.argv);
        assert_eq!(
            derived.argv,
            vec!["create", "--yes", "vite@9.1.1", "test", "--", "--template", "react-ts"]
        );
    }

    #[test]
    fn validate_plan_refuses_a_different_version() {
        // The webview may describe the plan, never choose it (F34).
        let mut config = web_react_ts_npm();
        config.plan.version = "0.0.1".into();
        let err = validate_plan(&config, "test").unwrap_err();
        assert_eq!(err.code(), "scaffold.plan_mismatch");
    }

    #[test]
    fn validate_plan_refuses_a_different_argv() {
        // A preview that shows one command and sends another is refused (F14).
        let mut config = web_react_ts_npm();
        config.plan.argv.push("--manager".into());
        config.plan.argv.push("npm".into());
        let err = validate_plan(&config, "test").unwrap_err();
        assert_eq!(err.code(), "scaffold.plan_mismatch");
    }

    #[test]
    fn validate_plan_refuses_a_different_template_or_package() {
        let mut config = web_react_ts_npm();
        config.plan.template = "vanilla-ts".into();
        assert_eq!(validate_plan(&config, "test").unwrap_err().code(), "scaffold.plan_mismatch");
        let mut config = web_react_ts_npm();
        config.plan.package = "create-tauri-app".into();
        assert_eq!(validate_plan(&config, "test").unwrap_err().code(), "scaffold.plan_mismatch");
    }

    #[test]
    fn validate_plan_derives_with_the_validated_name() {
        // The wizard sends the trimmed name in argv; the runner derives with
        // the validated (trimmed) name and they must agree.
        let mut config = web_react_ts_npm();
        config.project_name = "  test  ".into();
        assert!(validate_plan(&config, "test").is_ok());
        assert_eq!(validate_plan(&config, "other").unwrap_err().code(), "scaffold.plan_mismatch");
    }

    #[test]
    fn validate_plan_accepts_web_angular_as_an_exec_route() {
        // F1 closed (ADR-028 §3): the runner derives an Angular CLI exec
        // argv, never `create vite … --template angular`.
        let config = planned_config(
            ScaffoldWrapper::Web,
            ScaffoldFramework::Angular,
            ScaffoldLanguage::TypeScript,
            PackageManager::Npm,
        );
        let derived = validate_plan(&config, "test").expect("angular exec plan passes");
        assert_eq!(derived.route_kind, "exec");
        assert_eq!(derived.argv[..3], ["exec".to_string(), "--yes".to_string(), "--".to_string()]);
        assert!(derived.argv.contains(&"--defaults".to_string()));
        assert!(!derived.argv.iter().any(|a| a == "--template"));
        // The age gate queries an exec package verbatim, not as create-*.
        let specs = specs_to_execute(&config, &derived);
        assert_eq!(specs, vec![(derived.spec(), false)]);
    }

    #[test]
    fn validate_plan_refuses_electron_angular_with_a_reason() {
        let mut config = web_react_ts_npm();
        config.wrapper = ScaffoldWrapper::Electron;
        config.framework = ScaffoldFramework::Angular;
        let err = validate_plan(&config, "test").unwrap_err();
        assert_eq!(err.code(), "scaffold.recipe_unsupported");
    }

    #[test]
    fn validate_plan_refuses_a_foreign_platform() {
        let mut config = web_react_ts_npm();
        config.plan.platform = "plan9".into();
        assert_eq!(validate_plan(&config, "test").unwrap_err().code(), "scaffold.plan_mismatch");
    }

    #[test]
    fn primary_args_come_from_the_registry_per_manager() {
        let tauri = planned_config(
            ScaffoldWrapper::Tauri,
            ScaffoldFramework::React,
            ScaffoldLanguage::TypeScript,
            PackageManager::Npm,
        );
        assert_eq!(
            tauri.plan.argv,
            vec!["create", "--yes", "tauri-app@4.6.2", "test", "--", "--yes", "--template", "react-ts", "--manager", "npm"]
        );
        let vite_pnpm = planned_config(
            ScaffoldWrapper::Web,
            ScaffoldFramework::Vue,
            ScaffoldLanguage::JavaScript,
            PackageManager::Pnpm,
        );
        // pnpm forwards flags without `--` and needs no `--yes`.
        assert_eq!(vite_pnpm.plan.argv, vec!["create", "vite@9.1.1", "test", "--template", "vue"]);
        assert!(!vite_pnpm.plan.argv.contains(&"--manager".to_string()));
        let electron_yarn = planned_config(
            ScaffoldWrapper::Electron,
            ScaffoldFramework::React,
            ScaffoldLanguage::TypeScript,
            PackageManager::Yarn,
        );
        assert_eq!(
            electron_yarn.plan.argv,
            vec!["create", "electron-app@7.11.2", "test", "--template=vite-typescript"]
        );
    }

    // ---- Coverage enforcement (ADR-028 §10) ----

    #[test]
    fn enforce_coverage_refuses_combinations_without_evidence() {
        // Yarn has no evidence anywhere yet (no yarn on the evidence machine).
        let config = planned_config(
            ScaffoldWrapper::Web,
            ScaffoldFramework::React,
            ScaffoldLanguage::TypeScript,
            PackageManager::Yarn,
        );
        let err = enforce_coverage(&config).unwrap_err();
        assert_eq!(err.code(), "scaffold.recipe_unverified");
        assert!(err.message().contains("no execution evidence"), "{}", err.message());
    }

    #[test]
    fn enforce_coverage_agrees_with_the_registry_for_this_platform() {
        let config = web_react_ts_npm();
        let (status, _) = coverage_status("web", "react", "ts", "npm", current_platform());
        assert_eq!(enforce_coverage(&config).is_ok(), is_selectable_status(&status));
    }

    #[test]
    fn exact_spec_accepts_pinned_versions() {
        assert!(parse_exact_spec("vite@9.1.1").is_ok());
        assert!(parse_exact_spec("tauri-app@4.6.2").is_ok());
        assert!(parse_exact_spec("shadcn@4.13.0-beta.1").is_ok());
        // Scoped names split at the last '@'.
        let (name, version) = parse_exact_spec("@scope/tool@1.2.3").unwrap();
        assert_eq!(name, "@scope/tool");
        assert_eq!(version, "1.2.3");
    }

    #[test]
    fn exact_spec_refuses_unpinned_forms() {
        for bad in [
            "vite@latest",
            "vite@next",
            "vite",
            "vite@^9.1.1",
            "vite@~9.1.1",
            "vite@9.1",
            "vite@9",
            "vite@*",
            "vite@9.x.1",
            "vite@",
            "@9.1.1",
            "",
        ] {
            assert!(parse_exact_spec(bad).is_err(), "'{bad}' must be refused");
        }
    }

    #[test]
    fn shadcn_step_uses_the_registry_pin() {
        let mut config = web_react_ts_npm();
        config.addons = vec![ScaffoldAddon::ShadCN];
        let pm = ResolvedPM {
            executable: "npm".into(),
            prefix_args: vec![],
        };
        let step =
            build_addon_step(&ScaffoldAddon::ShadCN, &config, &pm, Path::new("/tmp/test"))
                .expect("shadcn step builds from the registry pin");
        let spec = addon_cli_spec("shadcn").unwrap();
        assert!(step.args.contains(&spec));
        assert!(!step.args.iter().any(|a| a.contains("@latest")));
        // npm has no dlx — the npm path must use the `exec --yes` form.
        assert_eq!(step.args[..3], ["exec".to_string(), "--yes".to_string(), "--".to_string()]);
        assert!(!step.args.contains(&"dlx".to_string()));
    }

    #[test]
    fn shadcn_step_keeps_dlx_on_pnpm() {
        let mut config = planned_config(
            ScaffoldWrapper::Web,
            ScaffoldFramework::React,
            ScaffoldLanguage::TypeScript,
            PackageManager::Pnpm,
        );
        config.addons = vec![ScaffoldAddon::ShadCN];
        let pm = ResolvedPM {
            executable: "pnpm".into(),
            prefix_args: vec![],
        };
        let step =
            build_addon_step(&ScaffoldAddon::ShadCN, &config, &pm, Path::new("/tmp/test"))
                .expect("shadcn step builds from the registry pin");
        assert_eq!(step.args[0], "dlx");
        assert!(step.args.contains(&addon_cli_spec("shadcn").unwrap()));
    }

    #[test]
    fn shadcn_step_is_skipped_for_frameworks_without_a_variant() {
        let mut config = planned_config(
            ScaffoldWrapper::Web,
            ScaffoldFramework::Solid,
            ScaffoldLanguage::TypeScript,
            PackageManager::Npm,
        );
        config.addons = vec![ScaffoldAddon::ShadCN];
        let pm = ResolvedPM {
            executable: "npm".into(),
            prefix_args: vec![],
        };
        assert!(build_addon_step(&ScaffoldAddon::ShadCN, &config, &pm, Path::new("/tmp/test")).is_none());
    }

    // ---- Release-age gate (ADR-021 §2) ----

    fn time_json(version: &str, ts: &str) -> String {
        format!(
            r#"{{"created":"2020-01-01T00:00:00.000Z","modified":"2026-01-01T00:00:00.000Z","{version}":"{ts}"}}"#
        )
    }

    #[test]
    fn publish_time_parses_valid_map() {
        let json = time_json("9.1.1", "2026-06-30T10:33:37.488Z");
        match publish_time_from_view_json(&json, "9.1.1") {
            AgeGateFetch::Published(dt) => {
                assert_eq!(dt.timestamp(), 1_782_815_617);
            }
            _ => panic!("expected Published"),
        }
    }

    #[test]
    fn publish_time_missing_version_is_hard_miss() {
        let json = time_json("9.1.1", "2026-06-30T10:33:37.488Z");
        assert!(matches!(
            publish_time_from_view_json(&json, "9.9.9"),
            AgeGateFetch::VersionMissing
        ));
    }

    #[test]
    fn publish_time_malformed_output_fails_open() {
        assert!(matches!(
            publish_time_from_view_json("not json at all", "1.0.0"),
            AgeGateFetch::Unreachable(_)
        ));
        assert!(matches!(
            publish_time_from_view_json("[1,2,3]", "1.0.0"),
            AgeGateFetch::Unreachable(_)
        ));
        let bad_ts = time_json("1.0.0", "yesterday-ish");
        assert!(matches!(
            publish_time_from_view_json(&bad_ts, "1.0.0"),
            AgeGateFetch::Unreachable(_)
        ));
    }

    #[test]
    fn age_gate_boundary() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-07-13T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let young = chrono::DateTime::parse_from_rfc3339("2026-07-12T13:00:00Z").unwrap();
        let old = chrono::DateTime::parse_from_rfc3339("2026-07-12T11:00:00Z").unwrap();
        let future = chrono::DateTime::parse_from_rfc3339("2026-07-14T12:00:00Z").unwrap();
        assert!(younger_than_gate(young, now), "23h old is gated");
        assert!(!younger_than_gate(old, now), "25h old passes");
        assert!(younger_than_gate(future, now), "future timestamps are gated");
    }

    // ---- Initializer package resolution (ADR-021 §2) ----
    //
    // Regression: the age gate queried the pin registry's short invocation
    // key instead of the package npm actually runs, so it verified the age of
    // `tauri-app` (unpublished since 2023), `vite`, and `electron-app` —
    // none of which are the CLIs we execute.

    #[test]
    fn initializer_package_expands_the_short_create_key() {
        assert_eq!(initializer_package("tauri-app"), "create-tauri-app");
        assert_eq!(initializer_package("vite"), "create-vite");
        assert_eq!(initializer_package("electron-app"), "create-electron-app");
    }

    #[test]
    fn initializer_package_is_idempotent() {
        assert_eq!(initializer_package("create-vite"), "create-vite");
    }

    #[test]
    fn initializer_package_prefixes_inside_the_scope() {
        // npm resolves `npm create @scope/foo` to `@scope/create-foo` — the
        // prefix belongs to the package, never the scope.
        assert_eq!(initializer_package("@acme/app"), "@acme/create-app");
        assert_eq!(initializer_package("@acme/create-app"), "@acme/create-app");
    }

    #[test]
    fn specs_to_execute_includes_shadcn_when_selected() {
        let mut config = web_react_ts_npm();
        let derived = validate_plan(&config, "test").unwrap();
        assert_eq!(
            specs_to_execute(&config, &derived),
            vec![("vite@9.1.1".to_string(), true)]
        );
        config.addons = vec![ScaffoldAddon::ShadCN];
        assert_eq!(
            specs_to_execute(&config, &derived),
            vec![("vite@9.1.1".to_string(), true), (addon_cli_spec("shadcn").unwrap(), false)]
        );
    }

    // ---- Dependency audit classification (ADR-021 §4) ----

    #[test]
    fn audit_clean_when_exit_ok() {
        assert_eq!(classify_audit_output(true, "found 0 vulnerabilities"), "clean");
        // Exit status wins — a clean exit is clean even with odd output.
        assert_eq!(classify_audit_output(true, ""), "clean");
    }

    #[test]
    fn audit_findings_when_npm_reports_vulnerabilities() {
        assert_eq!(
            classify_audit_output(false, "found 3 vulnerabilities (1 moderate, 2 high)"),
            "findings"
        );
        assert_eq!(
            classify_audit_output(false, "# npm audit report\n\n1 Vulnerability found"),
            "findings"
        );
    }

    #[test]
    fn audit_unavailable_on_network_style_failures() {
        assert_eq!(
            classify_audit_output(false, "npm error code ENOTFOUND\nregistry unreachable"),
            "unavailable"
        );
        assert_eq!(classify_audit_output(false, ""), "unavailable");
    }

    // ---- pnpm cooldown write-through (ADR-021 §2) ----

    fn temp_project_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "litria_age_gate_{tag}_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn pnpm_cooldown_creates_workspace_yaml() {
        let dir = temp_project_dir("create");
        let label = write_pnpm_release_age(&dir).unwrap();
        assert!(label.is_some());
        let content = std::fs::read_to_string(dir.join("pnpm-workspace.yaml")).unwrap();
        assert!(content.contains("minimumReleaseAge: 1440"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pnpm_cooldown_appends_to_existing_yaml() {
        let dir = temp_project_dir("append");
        std::fs::write(dir.join("pnpm-workspace.yaml"), "packages:\n  - '.'\n").unwrap();
        write_pnpm_release_age(&dir).unwrap();
        let content = std::fs::read_to_string(dir.join("pnpm-workspace.yaml")).unwrap();
        assert!(content.starts_with("packages:"), "existing content preserved");
        assert!(content.contains("minimumReleaseAge: 1440"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- Scripts-off choke point (ADR-021 §3) ----

    fn fake_step(args: &[&str]) -> ScaffoldStep {
        ScaffoldStep {
            label: "Test step".into(),
            executable: "npm".into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            cwd: PathBuf::from("/tmp"),
            env: Vec::new(),
        }
    }

    #[test]
    fn scripts_off_covers_every_npm_step_and_flags_installs() {
        let mut steps = vec![
            fake_step(&["create", "--yes", "vite@9.1.1", "app"]),
            fake_step(&["install", "-D", "tailwindcss"]),
        ];
        apply_scripts_off(&mut steps, &PackageManager::Npm);

        // Env choke point covers every step (nested installs inherit it).
        for step in &steps {
            assert!(step
                .env
                .contains(&("npm_config_ignore_scripts".into(), "true".into())));
        }
        // The explicit flag + honest label land only on install commands.
        assert!(!steps[0].args.contains(&"--ignore-scripts".to_string()));
        assert!(!steps[0].label.contains("(scripts off)"));
        assert_eq!(steps[1].args[..2], ["install".to_string(), "--ignore-scripts".to_string()]);
        assert!(steps[1].label.ends_with("(scripts off)"));
    }

    #[test]
    fn scripts_off_leaves_pnpm_and_yarn_native() {
        for manager in [PackageManager::Pnpm, PackageManager::Yarn] {
            let mut steps = vec![fake_step(&["install", "-D", "tailwindcss"])];
            apply_scripts_off(&mut steps, &manager);
            assert!(steps[0].env.is_empty());
            assert!(!steps[0].args.contains(&"--ignore-scripts".to_string()));
        }
    }

    #[test]
    fn pnpm_cooldown_respects_existing_setting() {
        let dir = temp_project_dir("respect");
        std::fs::write(dir.join("pnpm-workspace.yaml"), "minimumReleaseAge: 4320\n").unwrap();
        assert!(write_pnpm_release_age(&dir).unwrap().is_none());
        let content = std::fs::read_to_string(dir.join("pnpm-workspace.yaml")).unwrap();
        assert!(!content.contains("1440"), "existing cooldown left untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_command_exists_finds_node() {
        // Node.js is a dev prerequisite.
        assert!(probe_command_exists("node"));
    }

    #[test]
    fn probe_command_exists_returns_false_for_nonexistent() {
        assert!(!probe_command_exists(
            "__litria_scaffold_nonexistent_42__"
        ));
    }

    // -- audit #18b: the global tier must commit to an absolute executable ---

    #[test]
    fn absolute_pm_path_resolves_node_to_an_absolute_file() {
        // Node.js is a dev prerequisite, so this arm is always exercisable.
        let resolved = absolute_pm_path("node").expect("node must be on PATH");
        assert!(resolved.is_absolute(), "got {resolved:?}");
        assert!(resolved.is_file(), "got {resolved:?}");
    }

    #[test]
    fn absolute_pm_path_returns_none_for_nonexistent() {
        assert!(absolute_pm_path("__litria_scaffold_nonexistent_42__").is_none());
    }

    #[test]
    fn resolved_global_pm_is_an_absolute_path_with_no_prefix_args() {
        // npm is present wherever Node.js is, so this covers the real shape.
        let pm = resolve_global_pm("npm").expect("npm must be on PATH");
        assert!(
            Path::new(&pm.executable).is_absolute(),
            "global tier must spawn an absolute path, got {:?}",
            pm.executable
        );
        // The `cmd /C <name>` shape is what let a project name re-enter
        // cmd.exe's parser (audit #18/#18b). No prefix args means no second
        // parse: the name reaches the shim as one argument.
        assert!(
            pm.prefix_args.is_empty(),
            "global tier must not wrap in a shell, got {:?}",
            pm.prefix_args
        );
        assert_ne!(pm.executable.to_ascii_lowercase(), "cmd");
    }

    #[cfg(windows)]
    #[test]
    fn resolved_global_npm_picks_an_executable_extension() {
        // `where npm` answers with the extension-less Unix shell script
        // (`…\nodejs\npm`) BEFORE `…\nodejs\npm.cmd`. Taking the first line
        // would hand Command::new a file Windows cannot execute at all.
        let pm = resolve_global_pm("npm").expect("npm must be on PATH");
        assert!(
            has_executable_extension(&pm.executable),
            "resolved shim must be directly executable, got {:?}",
            pm.executable
        );
    }

    #[test]
    fn executable_extension_allowlist_is_narrow() {
        assert!(has_executable_extension("C:\\x\\npm.cmd"));
        assert!(has_executable_extension("C:\\x\\npm.CMD"));
        assert!(has_executable_extension("C:\\x\\pnpm.bat"));
        assert!(has_executable_extension("C:\\x\\node.exe"));
        assert!(has_executable_extension("C:\\x\\tool.com"));
        // On PATHEXT but not something the scaffold runner should launch.
        assert!(!has_executable_extension("C:\\x\\npm.js"));
        assert!(!has_executable_extension("C:\\x\\npm.vbs"));
        // The extension-less Unix shell script `where npm` reports first.
        assert!(!has_executable_extension("C:\\Program Files\\nodejs\\npm"));
        assert!(!has_executable_extension("/usr/bin/pnpm"));
    }
}
