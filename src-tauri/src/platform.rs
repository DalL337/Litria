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
