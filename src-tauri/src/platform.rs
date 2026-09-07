use serde::Serialize;

/// Reported to the frontend so it can pick the right platform presentation
/// (paths, modifier labels, hidden-file patterns, window-control visibility) —
/// see `src/platform/platformDefaults.js`, keyed by `os`.
///
/// Only `os` is consumed. Window decorations are applied per-OS in the Tauri
/// `setup` hook (macOS gets `set_decorations(true)` for native traffic lights);
/// the terminal shell is chosen in `terminal_policy::preferred_shell` ($SHELL).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformConfig {
    pub os: String,
}

pub fn detect_platform() -> PlatformConfig {
    PlatformConfig {
        os: std::env::consts::OS.to_string(),
    }
}

#[tauri::command]
pub fn get_platform_config() -> PlatformConfig {
    detect_platform()
}

/// `CREATE_NO_WINDOW` — the Windows process-creation flag that stops a
/// console child from opening its own console window.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A `std::process::Command` that never shows a console window.
///
/// A release build of Litria is a GUI-subsystem process with no console of
/// its own, so on Windows every console child it spawns (`cmd /C ...`,
/// `where`, `node`, `go`, a language server) gets a brand-new console window
/// unless the spawn carries `CREATE_NO_WINDOW`. Under `tauri dev` the parent
/// HAS a console, children inherit it, and nothing flashes — which is how the
/// Preferences panel's server probes shipped in 1.0.3 "running a script
/// window" on every open (first-run Windows report, 2026-09-07).
///
/// Build every spawn through this. `test/domains/windowsHiddenSpawns.test.mjs`
/// fails on a bare `Command::new` in non-test code.
pub fn hidden_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    #[allow(unused_mut)]
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}
