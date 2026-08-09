//! 3-tier server resolution: global PATH → managed directory → bundled resources.
//!
//! The resolver sits between pack lookup and process spawn.  It turns the static
//! `pack.command` string into a concrete `ResolvedCommand` with an absolute
//! executable path and resolution tier.
//!
//! Global tier probes PATH.  Managed tier resolves receipts under
//! `app_data_dir()/servers/` (live since the ADR-005 download-manager arc).
//! Bundled tier checks Tauri's resource directory for pre-packaged JS servers.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Suppress console window flash on Windows probe subprocesses.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Hard cap for probe subprocesses — a hung binary (wedged shim, broken
/// network-drive PATH entry) must never hang session start or prerequisite
/// detection. Same ceiling as python_probe.rs.
const PROBE_TIMEOUT_MS: u64 = 4_000;

use tauri::{AppHandle, Manager};

use crate::lsp::packs::{LanguagePack, ResolvedCommand, ResolutionTier};

// ---------------------------------------------------------------------------
// Bundled server entry points (relative to resource_dir/servers/)
// ---------------------------------------------------------------------------

/// Map a language ID to the JS entry point within the bundled server tree.
///
/// These paths mirror the output of `scripts/bundle-servers.mjs`, which
/// installs each server via `npm install --prefix` into an isolated directory.
fn bundled_entry_point(language_id: &str) -> Option<&'static str> {
    match language_id {
        "python" => Some("servers/python/node_modules/pyright/langserver.index.js"),
        "typescript" => Some("servers/typescript/node_modules/typescript-language-server/lib/cli.mjs"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Resolve a language server executable through the 3-tier fallback chain.
///
/// Priority: Global PATH → Managed directory → Bundled resources.
///
/// Returns `None` if no tier can satisfy the server requirement.
pub(crate) fn resolve_server(
    pack: &LanguagePack,
    app: &AppHandle,
) -> Option<ResolvedCommand> {
    // Tier 1: Global PATH (current behaviour)
    if let Some(resolved) = probe_global(pack) {
        return Some(resolved);
    }

    // Tier 2: Managed directory (app_data_dir()/servers/ — ADR-005 §1)
    if let Some(resolved) = probe_managed(pack) {
        return Some(resolved);
    }

    // Tier 3: Bundled resources
    if let Some(resolved) = probe_bundled(pack, app) {
        return Some(resolved);
    }

    None
}

/// Resolve Node.js through the same tier chain.
///
/// Used when spawning JS-based language servers from managed/bundled tiers.
/// For global-tier servers the existing Windows .cmd resolution in transport.rs
/// handles node discovery, so this is primarily needed by the bundled path.
///
/// Also verifies that the global Node.js version meets the minimum (≥18).
/// If a global node exists but is too old, falls through to the bundled tier.
pub(crate) fn resolve_node(app: &AppHandle) -> Option<PathBuf> {
    // Tier 1: System PATH — with version check
    if probe_command_exists("node") {
        if probe_node_version_ok() {
            return Some(PathBuf::from("node"));
        }
        // Global node exists but version too old — try bundled.
    }

    // Tier 2: Extracted bundled node
    if let Some(path) = crate::bundled_runtime::extracted_node_binary(app) {
        if path.exists() {
            return Some(path);
        }
    }

    None
}

/// Check that the global `node --version` reports major version ≥ 18.
fn probe_node_version_ok() -> bool {
    let output = if cfg!(windows) {
        Command::new("cmd")
            .args(["/C", "node", "--version"])
            .output()
    } else {
        Command::new("node").arg("--version").output()
    };

    match output {
        Ok(out) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout);
            let version_str = raw.trim().trim_start_matches('v');
            version_str
                .split('.')
                .next()
                .and_then(|major| major.parse::<u32>().ok())
                .map(|major| major >= 18)
                .unwrap_or(false)
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Tier 1: Global PATH
// ---------------------------------------------------------------------------

/// Check if the pack's command is available on the system PATH — and
/// actually runs.
///
/// Hollow-shim hardening (2026-07-16): PATH existence is not evidence of a
/// working binary. Rustup pre-creates proxy shims for components that were
/// never installed (`where rust-analyzer` succeeds; executing it fails with
/// "Unknown binary in official toolchain"), and stale npm .cmd shims survive
/// global uninstalls the same way. Because Global outranks Managed, a shim
/// that merely *exists* would permanently mask a working managed install —
/// so the probe now requires the version command to execute and exit 0;
/// anything else falls through to the managed tier, where the install pill
/// can genuinely fix the machine.
fn probe_global(pack: &LanguagePack) -> Option<ResolvedCommand> {
    let command = pack.command;

    // Servers with no clean-exit argv declare a companion probe command
    // (python: `pyright` for `pyright-langserver` — same npm package). The
    // companion proves the package RUNS; `where` on the real command closes
    // the partial-install gap (companion present, server entry missing).
    let probe_target = pack.version_probe_command.unwrap_or(command);
    if pack.version_probe_command.is_some() && !probe_command_exists(command) {
        return None;
    }

    if !probe_command_runs(probe_target, pack.version_probe_arg) {
        // Toolchain-adjacent fallback (ADR-005 Slice 6.5): `go install`
        // places gopls in `go env GOPATH`/bin, which is frequently NOT on
        // PATH. Ask the toolchain where that is rather than guessing — if
        // `go` itself is missing, gopls in an unknown GOPATH would be
        // useless anyway (it shells out to `go`).
        if pack.language_id == "go" {
            if let Some(executable) = probe_gopath_bin(command, pack.version_probe_arg) {
                return Some(ResolvedCommand {
                    executable,
                    prefix_args: vec![],
                    tier: ResolutionTier::Global,
                });
            }
        }
        return None;
    }

    // For global-tier resolution, the executable is just the command name.
    // The transport layer's existing Windows .cmd→node resolution and Unix
    // direct-exec logic handles the rest.
    Some(ResolvedCommand {
        executable: PathBuf::from(command),
        prefix_args: vec![],
        tier: ResolutionTier::Global,
    })
}

/// Locate `<binary>` inside `go env GOPATH`/bin — and require that it runs
/// (a truncated `go install` leaves a file that exists but cannot execute;
/// same hollow-shim rule as the PATH probe).
fn probe_gopath_bin(binary: &str, version_arg: &str) -> Option<PathBuf> {
    // Same cmd /C shape as probe_prerequisite for shim safety on Windows.
    let output = if cfg!(windows) {
        Command::new("cmd")
            .args(["/C", "go", "env", "GOPATH"])
            .output()
    } else {
        Command::new("go").args(["env", "GOPATH"]).output()
    }
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let gopath = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if gopath.is_empty() {
        return None;
    }
    let candidate = gopath_bin_candidate(&gopath, binary);
    if candidate.exists() && probe_binary_runs(&candidate, version_arg) {
        Some(candidate)
    } else {
        None
    }
}

/// `<command> <version_arg>` spawns via PATH lookup and exits 0. Runs under
/// `cmd /C` on Windows so both native .exe and npm .cmd shims resolve
/// (windows_lsp_gotchas: Command::new alone only finds .exe).
fn probe_command_runs(command: &str, version_arg: &str) -> bool {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", command, version_arg]);
        c
    } else {
        let mut c = Command::new(command);
        c.arg(version_arg);
        c
    };
    probe_exits_zero_within(&mut cmd, PROBE_TIMEOUT_MS)
}

/// Same execution requirement for a fully-resolved path (no PATH lookup,
/// no cmd /C — the file is spawned directly).
fn probe_binary_runs(path: &std::path::Path, version_arg: &str) -> bool {
    let mut cmd = Command::new(path);
    cmd.arg(version_arg);
    probe_exits_zero_within(&mut cmd, PROBE_TIMEOUT_MS)
}

/// Spawn the probe and require exit-0 within the timeout. Stdout is piped so
/// its EOF doubles as the completion signal (python_probe.rs pattern); on
/// timeout the direct child is killed — under `cmd /C` a grandchild the shell
/// spawned can survive as an orphan, the same trade python_probe accepts:
/// unblocking the caller is the point, a hung probe is a failed probe.
fn probe_exits_zero_within(command: &mut Command, timeout_ms: u64) -> bool {
    use std::io::Read;

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return false;
    };

    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = stdout.read_to_end(&mut sink);
        let _ = tx.send(());
    });

    match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
        Ok(()) => {
            let _ = reader.join();
            child.wait().map(|s| s.success()).unwrap_or(false)
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            false
        }
    }
}

/// Pure path-join half of the GOPATH probe (unit-testable without a toolchain).
fn gopath_bin_candidate(gopath: &str, binary: &str) -> PathBuf {
    let exe = if cfg!(windows) {
        format!("{binary}.exe")
    } else {
        binary.to_string()
    };
    PathBuf::from(gopath).join("bin").join(exe)
}

// ---------------------------------------------------------------------------
// Tier 2: Managed directory (ADR-005 Slice 4)
// ---------------------------------------------------------------------------

/// Check the managed server directory (`app_data_dir()/servers/<server>/`).
///
/// Resolution follows the receipt: the registry maps the pack's language to
/// its server id, the receipt's `current` pointer selects the active
/// version-stamped dir, and the recorded binary must still exist on disk —
/// a stale receipt is not a resolution.
fn probe_managed(pack: &LanguagePack) -> Option<ResolvedCommand> {
    let root = crate::lsp::download::servers_root().ok()?;
    let binary = crate::lsp::download::managed_binary_for_language(&root, pack.language_id)?;
    Some(ResolvedCommand {
        executable: binary,
        prefix_args: vec![],
        tier: ResolutionTier::Managed,
    })
}

// ---------------------------------------------------------------------------
// Tier 3: Bundled resources
// ---------------------------------------------------------------------------

/// Check the Tauri resource directory for a bundled server.
///
/// Bundled servers are pure JavaScript — they need Node.js to run.  If the
/// entry point JS file exists in the resource dir but Node.js is not
/// available (neither on PATH nor bundled), this returns None and the
/// prerequisite detection layer surfaces the "install Node.js" message.
fn probe_bundled(pack: &LanguagePack, app: &AppHandle) -> Option<ResolvedCommand> {
    let entry_rel = bundled_entry_point(pack.language_id)?;

    let resource_dir = app.path().resource_dir().ok()?;
    // Tauri places array-style resources under a `resources/` subdirectory.
    let entry_point = resource_dir.join("resources").join(entry_rel);

    if !entry_point.exists() {
        return None;
    }

    // The JS entry point exists — now we need Node.js to run it.
    let node = resolve_node(app)?;

    Some(ResolvedCommand {
        executable: node,
        prefix_args: vec![entry_point.to_string_lossy().into_owned()],
        tier: ResolutionTier::Bundled,
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Return true if the given command name can be found by the OS.
///
/// On Windows: `where <command>` (exits 0 if found).
/// On Unix: `which <command>` (exits 0 if found).
fn probe_command_exists(command: &str) -> bool {
    let result = if cfg!(windows) {
        Command::new("where")
            .arg(command)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
    } else {
        Command::new("which")
            .arg(command)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
    };

    result.map(|s| s.success()).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_command_exists_finds_node() {
        // Node.js is a dev prerequisite — it must be on PATH in the dev environment.
        assert!(
            probe_command_exists("node"),
            "node must be on PATH for development"
        );
    }

    #[test]
    fn probe_command_exists_returns_false_for_nonexistent() {
        assert!(!probe_command_exists("__litria_nonexistent_command_42__"));
    }

    #[test]
    fn gopath_bin_candidate_joins_platform_binary_name() {
        let candidate = gopath_bin_candidate("/home/dev/go", "gopls");
        let s = candidate.to_string_lossy().replace('\\', "/");
        if cfg!(windows) {
            assert_eq!(s, "/home/dev/go/bin/gopls.exe");
        } else {
            assert_eq!(s, "/home/dev/go/bin/gopls");
        }
    }

    #[test]
    fn probe_managed_returns_none_for_bundled_languages() {
        // python/typescript ship bundled (ADR-004) and have no registry
        // entry — the managed tier never claims them.
        let pack = crate::lsp::packs::get_pack("python").unwrap();
        assert!(probe_managed(&pack).is_none());
    }

    #[test]
    fn probe_global_finds_node_based_server() {
        // This test only passes when the dev has a WORKING tsserver install.
        // It validates the probe logic rather than asserting installation
        // state — the gate uses the same run-check as the probe itself, so
        // an exists-but-broken shim correctly skips rather than fails.
        let pack = crate::lsp::packs::get_pack("typescript").unwrap();
        if probe_command_runs(pack.command, pack.version_probe_arg) {
            let resolved = probe_global(&pack);
            assert!(resolved.is_some());
            let resolved = resolved.unwrap();
            assert_eq!(resolved.tier, ResolutionTier::Global);
            assert!(resolved.prefix_args.is_empty());
        }
        // If not installed, that's fine — the test validates logic, not dev env.
    }

    #[test]
    fn probe_command_runs_accepts_a_working_binary() {
        // Node is a dev prerequisite — it must be on PATH and executable.
        assert!(probe_command_runs("node", "--version"));
    }

    #[test]
    fn probe_command_runs_rejects_exists_but_fails() {
        // The hollow-shim shape: the command spawns but exits non-zero
        // (rustup proxy without its component, stale npm shim). Node with a
        // bogus flag reproduces exactly that exit path.
        assert!(!probe_command_runs("node", "--litria-bogus-flag"));
    }

    #[test]
    fn probe_command_runs_rejects_nonexistent_command() {
        assert!(!probe_command_runs("__litria_nonexistent_command_42__", "--version"));
    }

    #[test]
    fn probe_kills_a_hanging_binary_at_the_timeout() {
        // The hung-probe shape (#143 residual): a binary that spawns fine but
        // never exits must fail the probe within the cap, not hang the
        // resolver. node with an idle interval never exits on its own.
        let mut cmd = Command::new("node");
        cmd.args(["-e", "setInterval(() => {}, 1000)"]);
        let started = std::time::Instant::now();
        assert!(!probe_exits_zero_within(&mut cmd, 500));
        assert!(
            started.elapsed() < Duration::from_millis(4_000),
            "probe must return promptly after the timeout, not wait for the child"
        );
    }

    #[test]
    fn probe_exits_zero_within_accepts_a_fast_clean_exit() {
        let mut cmd = Command::new("node");
        cmd.arg("--version");
        assert!(probe_exits_zero_within(&mut cmd, PROBE_TIMEOUT_MS));
    }

    #[test]
    fn probe_binary_runs_requires_execution_not_existence() {
        // A file that exists but is not an executable must be rejected —
        // the truncated-`go install` shape for the GOPATH candidate.
        let dir = std::env::temp_dir().join(format!("litria_probe_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let fake = dir.join(if cfg!(windows) { "fake.exe" } else { "fake" });
        std::fs::write(&fake, b"not a real binary").unwrap();
        assert!(fake.exists());
        assert!(!probe_binary_runs(&fake, "--version"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn python_probes_the_pyright_cli_not_the_langserver() {
        // pyright-langserver exits 1 on ANY argv without --stdio (it tries to
        // open an LSP connection immediately), so probing it directly rejects
        // every healthy install and forces the bundled tier (2026-07-17 dev
        // crash-loop). The pack must declare the sibling CLI as probe target.
        let pack = crate::lsp::packs::get_pack("python").unwrap();
        assert_eq!(pack.version_probe_command, Some("pyright"));
        assert_eq!(pack.command, "pyright-langserver");
    }

    #[test]
    fn probe_override_packs_still_require_the_real_command_on_path() {
        // With an override, probe_global must not resolve when the actual
        // server command is absent — the companion CLI alone is not enough.
        let mut pack = crate::lsp::packs::get_pack("python").unwrap();
        pack.command = "__litria_nonexistent_command_42__";
        assert!(probe_global(&pack).is_none());
    }

    #[test]
    fn every_pack_declares_a_version_probe_arg() {
        // The global probe RUNS the server's version command; a pack with an
        // empty arg would probe `<command>` bare, which for LSP servers
        // typically blocks on stdio — never allow it.
        for language_id in ["python", "typescript", "rust", "cpp", "go"] {
            let pack = crate::lsp::packs::get_pack(language_id).unwrap();
            assert!(
                !pack.version_probe_arg.trim().is_empty(),
                "pack '{language_id}' has an empty version_probe_arg"
            );
        }
    }

    #[test]
    fn bundled_entry_point_returns_correct_paths() {
        let py = bundled_entry_point("python").unwrap();
        assert!(py.contains("pyright/langserver.index.js"));

        let ts = bundled_entry_point("typescript").unwrap();
        assert!(ts.contains("typescript-language-server/lib/cli.mjs"));
    }

    #[test]
    fn bundled_entry_point_returns_none_for_unknown_language() {
        assert!(bundled_entry_point("rust").is_none());
        assert!(bundled_entry_point("go").is_none());
    }
}
