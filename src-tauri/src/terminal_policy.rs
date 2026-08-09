use crate::errors::CommandResult;
use crate::execution_policy::{self, ValidatedExecutionBoundary};
use std::collections::HashMap;

#[cfg(target_os = "windows")]
const ALLOWED_ENV_KEYS: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "TMP",
    "TEMP",
    "USERPROFILE",
    "USERNAME",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMDATA",
];

#[cfg(not(target_os = "windows"))]
const ALLOWED_ENV_KEYS: &[&str] = &[
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "EDITOR",
    "VISUAL",
];

const FORCED_ENV: &[(&str, &str)] = &[
    ("TERM", "xterm-256color"),
    ("COLORTERM", "truecolor"),
    ("TERM_PROGRAM", "litria"),
];

#[cfg(target_os = "windows")]
const ALLOWED_EXECUTABLES: &[&str] = &["powershell.exe", "pwsh.exe", "cmd.exe"];
#[cfg(not(target_os = "windows"))]
const ALLOWED_EXECUTABLES: &[&str] = &["sh", "bash", "zsh"];

pub(crate) fn validate_terminal_execution_boundary(
    project_id: &str,
    root_path: &str,
    executable: Option<&str>,
) -> CommandResult<ValidatedExecutionBoundary> {
    let default_shell = preferred_shell();
    execution_policy::validate_execution_boundary(
        project_id,
        root_path,
        executable,
        default_shell,
        ALLOWED_EXECUTABLES,
        "terminal",
    )
}

/// Returns the user's preferred shell if it is in the allowlist, otherwise the platform default.
fn preferred_shell() -> &'static str {
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            // $SHELL may be a full path like /bin/zsh — match against the basename
            let basename = shell.rsplit('/').next().unwrap_or(&shell);
            if let Some(allowed) = ALLOWED_EXECUTABLES.iter().find(|e| **e == basename) {
                return allowed;
            }
        }
    }
    ALLOWED_EXECUTABLES[0]
}

pub(crate) fn filter_environment(input: &HashMap<String, String>) -> HashMap<String, String> {
    ALLOWED_ENV_KEYS
        .iter()
        .filter_map(|key| input.get(*key).map(|value| ((*key).to_string(), value.clone())))
        .collect()
}

/// Build a filtered environment for PTY child processes.
/// Inherits allowlisted keys from the current process, then applies forced overrides.
pub(crate) fn build_pty_environment() -> HashMap<String, String> {
    let current: HashMap<String, String> = std::env::vars().collect();
    let mut filtered = filter_environment(&current);
    for (key, value) in FORCED_ENV {
        filtered.insert((*key).to_string(), (*value).to_string());
    }
    filtered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_environment_keeps_only_allowlisted_keys() {
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "x".to_string());
        env.insert("SECRET_TOKEN".to_string(), "hidden".to_string());
        env.insert("LD_PRELOAD".to_string(), "/tmp/evil.so".to_string());
        env.insert("NODE_OPTIONS".to_string(), "--require=./exploit".to_string());
        let filtered = filter_environment(&env);
        assert_eq!(filtered.get("PATH").map(String::as_str), Some("x"));
        assert!(!filtered.contains_key("SECRET_TOKEN"));
        assert!(!filtered.contains_key("LD_PRELOAD"));
        assert!(!filtered.contains_key("NODE_OPTIONS"));
    }

    #[test]
    fn build_pty_environment_includes_forced_overrides() {
        let env = build_pty_environment();
        assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
        assert_eq!(env.get("TERM_PROGRAM").map(String::as_str), Some("litria"));
    }

    #[test]
    fn build_pty_environment_blocks_injection_vectors() {
        let env = build_pty_environment();
        assert!(!env.contains_key("LD_PRELOAD"));
        assert!(!env.contains_key("DYLD_INSERT_LIBRARIES"));
        assert!(!env.contains_key("NODE_OPTIONS"));
        assert!(!env.contains_key("BASH_ENV"));
        assert!(!env.contains_key("PROMPT_COMMAND"));
        assert!(!env.contains_key("PYTHONPATH"));
    }

    #[test]
    fn validate_executable_entry_rejects_non_allowlisted_values() {
        let root = std::env::temp_dir().to_string_lossy().to_string();
        let result = validate_terminal_execution_boundary("project-a", &root, Some("python.exe"));
        assert!(result.is_err());
    }
}
