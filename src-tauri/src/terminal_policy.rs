use crate::errors::CommandResult;
use crate::execution_policy::{self, ValidatedExecutionBoundary};

// A terminal's environment is the user's own, as Litria inherited it, the way
// VS Code, JetBrains and Windows Terminal do it (owner ruling 2026-10-15, gap
// G1). Litria sets no variable of its own, and the shell runs as the same user
// who started Litria, so there is no boundary to filter at. Two exceptions:
// what a program that started Litria leaked into Litria's own environment
// (`launcher_leaks`), and the variables that say what the terminal is
// (`FORCED_ENV`).

/// Set for every terminal, over whatever was inherited.
pub(crate) const FORCED_ENV: &[(&str, &str)] = &[
    ("TERM", "xterm-256color"),
    ("COLORTERM", "truecolor"),
    ("TERM_PROGRAM", "litria"),
    ("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION")),
];

/// The `VSCODE_*` names VS Code itself reads as user settings, matched as
/// prefixes after `VSCODE_`, as VS Code's own rule does.
const VSCODE_SETTINGS: &[&str] = &["PORTABLE", "SHELL_LOGIN", "ENV_REPLACE", "ENV_APPEND", "ENV_PREPEND"];

/// Variables Claude Code sets for the programs it starts, which point at that
/// session: its inbox socket and token, its ids, its nesting markers. An
/// inherited `CLAUDE_CODE_CHILD_SESSION` makes a top-level `claude` count as
/// nested, which turns off `--resume`, `--continue` and its history. Exact
/// names only: many other `CLAUDE_CODE_*` names are the user's own settings.
const CLAUDE_CODE_SESSION: &[&str] = &[
    // Documented as set by Claude Code (code.claude.com/docs/en/env-vars).
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    // Undocumented; set when Claude Code's VS Code extension starts it.
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
    "CLAUDE_CODE_EMIT_STARTUP_TIMING",
    "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
    "CLAUDE_AGENT_SDK_VERSION",
];

/// The inherited names a terminal must not see: what a program that started
/// Litria (VS Code, Claude Code, a snap) leaked into Litria's environment.
/// They point at that program's own windows, sockets and sessions. Everything
/// else is the user's and passes through. Names compare case-insensitively on
/// Windows, where the environment does.
pub(crate) fn launcher_leaks<'a>(names: &[&'a str]) -> Vec<&'a str> {
    // VS Code's git sign-in hook: its GIT_ASKPASS script runs the program
    // named by VSCODE_GIT_ASKPASS_*, so without those it only prints an error.
    // A GIT_ASKPASS of the user's own stays.
    let vscode_askpass = names
        .iter()
        .any(|name| same_name(name, "VSCODE_GIT_ASKPASS_MAIN"));
    names
        .iter()
        .copied()
        .filter(|name| {
            let name = canonical(name);
            vscode_rule(&name)
                || CLAUDE_CODE_SESSION.contains(&name.as_str())
                || (vscode_askpass && name == "GIT_ASKPASS")
        })
        .collect()
}

/// VS Code's own rule for its terminals (`sanitizeProcessEnvironment`,
/// src/vs/base/common/processes.ts): `ELECTRON_*`, `VSCODE_*` but its user
/// settings, `SNAP` and `SNAP_*`, `GDK_PIXBUF_*`. VS Code keeps one more,
/// `VSCODE_IPC_HOOK_CLI`, for its own window; here it would be someone else's.
fn vscode_rule(name: &str) -> bool {
    if let Some(rest) = name.strip_prefix("ELECTRON_") {
        return !rest.is_empty();
    }
    if let Some(rest) = name.strip_prefix("VSCODE_") {
        return !rest.is_empty() && !VSCODE_SETTINGS.iter().any(|setting| rest.starts_with(setting));
    }
    if name == "SNAP" || name.starts_with("SNAP_") {
        return true;
    }
    name.strip_prefix("GDK_PIXBUF_").is_some_and(|rest| !rest.is_empty())
}

fn canonical(name: &str) -> String {
    if cfg!(windows) {
        name.to_ascii_uppercase()
    } else {
        name.to_string()
    }
}

fn same_name(a: &str, b: &str) -> bool {
    canonical(a) == canonical(b)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    // What a real shell sees is checked end to end in terminal_pty's
    // real-shell tests; these pin each rule.

    fn leaks<'a>(names: &[&'a str]) -> Vec<&'a str> {
        launcher_leaks(names)
    }

    #[test]
    fn the_users_own_variables_pass_through() {
        let own = [
            "PATH",
            "HOME",
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "CLAUDE_CONFIG_DIR",
            "CODEX_HOME",
            "SSH_AUTH_SOCK",
            "JAVA_HOME",
            "HTTPS_PROXY",
            "LD_PRELOAD",
            "NODE_OPTIONS",
            // Documented Claude Code settings, even when its extension set them.
            "CLAUDE_CODE_ENABLE_TASKS",
            "CLAUDE_CODE_USE_BEDROCK",
            "MCP_CONNECTION_NONBLOCKING",
            // VS Code's own user settings.
            "VSCODE_PORTABLE",
            "VSCODE_SHELL_LOGIN",
            "VSCODE_ENV_REPLACE",
            "VSCODE_ENV_APPEND",
            "VSCODE_ENV_PREPEND",
            // Windows Terminal: VS Code keeps these too.
            "WT_SESSION",
            "WT_PROFILE_ID",
            // A GIT_ASKPASS of the user's own, with no VS Code hook beside it.
            "GIT_ASKPASS",
            // Near misses of the patterns.
            "SNAPSHOT_DIR",
            "ELECTRON_",
            "VSCODE_",
            "GDK_PIXBUF_",
            "MY_VSCODE_PID",
        ];
        assert_eq!(leaks(&own), Vec::<&str>::new());
    }

    #[test]
    fn vs_code_and_electron_leaks_are_dropped() {
        let leaked = [
            "ELECTRON_RUN_AS_NODE",
            "ELECTRON_NO_ATTACH_CONSOLE",
            "VSCODE_PID",
            "VSCODE_IPC_HOOK",
            "VSCODE_IPC_HOOK_CLI",
            "VSCODE_CWD",
            "VSCODE_NLS_CONFIG",
            "VSCODE_GIT_IPC_HANDLE",
            "SNAP",
            "SNAP_NAME",
            "GDK_PIXBUF_MODULE_FILE",
        ];
        assert_eq!(leaks(&leaked), leaked.to_vec());
    }

    #[test]
    fn vs_codes_git_askpass_goes_with_its_hook() {
        let names = ["PATH", "GIT_ASKPASS", "VSCODE_GIT_ASKPASS_MAIN", "VSCODE_GIT_ASKPASS_NODE"];
        assert_eq!(leaks(&names), vec!["GIT_ASKPASS", "VSCODE_GIT_ASKPASS_MAIN", "VSCODE_GIT_ASKPASS_NODE"]);
    }

    #[test]
    fn claude_codes_session_variables_are_dropped() {
        assert_eq!(leaks(CLAUDE_CODE_SESSION), CLAUDE_CODE_SESSION.to_vec());
    }

    #[test]
    fn names_compare_as_the_platform_compares_them() {
        let names = ["Vscode_Pid", "claudecode", "git_askpass", "vscode_git_askpass_main"];
        if cfg!(windows) {
            assert_eq!(leaks(&names), names.to_vec());
        } else {
            assert_eq!(leaks(&names), Vec::<&str>::new());
        }
    }


    #[test]
    fn validate_executable_entry_rejects_non_allowlisted_values() {
        let root = std::env::temp_dir().to_string_lossy().to_string();
        let result = validate_terminal_execution_boundary("project-a", &root, Some("python.exe"));
        assert!(result.is_err());
    }
}
