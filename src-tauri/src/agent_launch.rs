//! Starting the person's own agent as a terminal session (track T, slice
//! T2b-1; plan `docs/plans/agent-integration/track-t-build-plan.md` §T2b).
//!
//! Litria runs the Claude Code or Codex the person installed, as a terminal
//! session's own process, with Litria's MCP server added for that session
//! only. Everything else is theirs: their sign-in, settings, skills and their
//! own MCP servers load as usual, and nothing of theirs is edited.
//!
//! - **Finding it.** The PATH a Litria terminal sees (on Windows the
//!   registry's, merged as portable-pty merges it, so an install made after
//!   Litria started is found). Litria never installs an agent.
//! - **Running it.** On Windows an npm install is a `.cmd` shim, and `cmd.exe`
//!   parses its arguments again, which would break or reinterpret the ones
//!   Litria passes. Litria reads the shim and runs the real program behind it
//!   (`claude.exe`, or Node with `codex.js`); a shim it cannot read is refused.
//! - **Connecting it.** The command line is built here, never from the
//!   webview. The token travels in the agent's environment and the
//!   configuration only refers to it (`${…}` for Claude Code, `env_vars` for
//!   Codex), so it is never written to a file or a command line (owner ruling
//!   2026-10-24).
//! - **Ending it.** The session's MCP connection ends with the terminal
//!   session, whichever way that ends.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::errors::{CommandError, CommandResult};
use crate::mcp_connection::{ENDPOINT_VAR, TOKEN_VAR};
use crate::terminal_pty::{AgentProgram, SessionProgram, TerminalEvent};
use crate::terminal_types::TerminalSessionStartedPayload;

/// An agent Litria can start: the person's own installed program.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Agent {
    Claude,
    Codex,
}

impl Agent {
    /// The command the person would type.
    fn program(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
        }
    }

    /// How messages name it (plan §3: the plain name of the person's program).
    fn display(self) -> &'static str {
        match self {
            Agent::Claude => "Claude Code",
            Agent::Codex => "Codex",
        }
    }

    /// Its maker's own installation page (checked 2026-10-24). Litria points
    /// there and never installs an agent itself.
    pub(crate) fn install_guide(self) -> &'static str {
        match self {
            Agent::Claude => "https://code.claude.com/docs/en/setup",
            Agent::Codex => "https://github.com/openai/codex",
        }
    }
}

/// The name Litria's server has among the agent's MCP servers.
const SERVER_NAME: &str = "litria";

/// Largest `.cmd` shim read; npm's are under 1 KiB.
const MAX_SHIM_BYTES: u64 = 16 * 1024;

/// Which agents are installed, for the terminal's start menu.
#[derive(Debug, Serialize)]
pub(crate) struct AgentAvailability {
    pub claude: bool,
    pub codex: bool,
}

/// Finds each agent without running anything.
pub(crate) fn detect() -> AgentAvailability {
    let search = SearchEnv::fresh();
    AgentAvailability {
        claude: search.find(Agent::Claude.program()).is_some(),
        codex: search.find(Agent::Codex.program()).is_some(),
    }
}

/// Starts `agent` as a terminal session of the project, connected to Litria's
/// tools for that session only.
pub(crate) fn start(
    page: u64,
    project_id: &str,
    project_root: &str,
    agent: Agent,
    cols: u16,
    rows: u16,
    channel: Channel<TerminalEvent>,
) -> CommandResult<TerminalSessionStartedPayload> {
    let project_id = crate::terminal_session_manager::validate_project_id(project_id)?;
    let validated =
        crate::terminal_policy::validate_terminal_execution_boundary(project_id, project_root, None)?;
    let epoch = open_epoch_for(&validated.project_root)?;

    let search = SearchEnv::fresh();
    let found = search.find(agent.program()).ok_or_else(|| {
        CommandError::not_found(
            "agent.not_installed",
            format!("{} is not installed, or not on the PATH.", agent.display()),
        )
    })?;
    let launch = launch_for(&found, &search)
        .map_err(|reason| CommandError::invalid_path("agent.unreadable_launcher", reason))?;
    let helper = std::env::current_exe().map_err(|e| {
        CommandError::internal("agent.no_helper", format!("Litria could not find its own program: {e}"))
    })?;
    let mut args = launch.prefix;
    args.extend(agent_args(agent, &helper).map_err(|reason| CommandError::internal("agent.no_helper", reason))?);

    let connection = crate::mcp_connection::start_session(&epoch, crate::project_api::agent_grant())
        .map_err(|reason| CommandError::internal("agent.connection_failed", reason))?;
    let mcp_session = connection.session_id.clone();
    let ended_session = mcp_session.clone();
    let program = SessionProgram::Agent(AgentProgram {
        executable: launch.executable,
        args,
        env: vec![(ENDPOINT_VAR, connection.endpoint), (TOKEN_VAR, connection.token)],
        on_end: Box::new(move || {
            crate::mcp_connection::end_session(&ended_session);
        }),
    });
    crate::terminal_session_manager::start_program_session(page, validated, program, cols, rows, channel)
        .inspect_err(|_| {
            // The program never ran (or its session never registered, which
            // ended it): its connection goes too. Ending twice is harmless.
            crate::mcp_connection::end_session(&mcp_session);
        })
}

/// The epoch of the project open now, which must be the one at `root`: an
/// agent is connected only to the project its terminal belongs to.
fn open_epoch_for(root: &Path) -> CommandResult<String> {
    let not_open = || {
        CommandError::conflict(
            "agent.project_not_open",
            "An agent can start only in the project that is open.",
        )
    };
    let (epoch, open_root) = crate::db::workspace_binding().ok_or_else(not_open)?;
    let open_root = open_root.ok_or_else(not_open)?;
    let same = match (std::fs::canonicalize(&open_root), std::fs::canonicalize(root)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if same {
        Ok(epoch)
    } else {
        Err(not_open())
    }
}

/// The search path a Litria terminal sees.
struct SearchEnv {
    path: OsString,
    pathext: Option<OsString>,
}

impl SearchEnv {
    /// portable-pty builds a session's environment from Litria's own and, on
    /// Windows, the registry's: the same values a shell in Litria starts with.
    fn fresh() -> Self {
        let builder = portable_pty::CommandBuilder::new("litria-agent-lookup");
        SearchEnv {
            path: builder.get_env("PATH").map(OsStr::to_os_string).unwrap_or_default(),
            pathext: builder.get_env("PATHEXT").map(OsStr::to_os_string),
        }
    }

    fn find(&self, program: &str) -> Option<PathBuf> {
        find_on_path(program, &self.path, self.pathext.as_deref())
    }
}

/// The first `program` on `path`. On Windows, in `pathext` order, among the
/// extensions Windows runs as a program (a `.js` or `.ps1` hit is not one).
fn find_on_path(program: &str, path: &OsStr, pathext: Option<&OsStr>) -> Option<PathBuf> {
    let extensions = launchable_extensions(pathext);
    for dir in std::env::split_paths(path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        if cfg!(windows) {
            for extension in &extensions {
                let candidate = dir.join(format!("{program}{extension}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        } else {
            let candidate = dir.join(program);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn launchable_extensions(pathext: Option<&OsStr>) -> Vec<String> {
    const LAUNCHABLE: [&str; 4] = [".com", ".exe", ".bat", ".cmd"];
    let listed = pathext.and_then(OsStr::to_str).unwrap_or(".COM;.EXE;.BAT;.CMD");
    let mut extensions: Vec<String> = Vec::new();
    for entry in listed.split(';') {
        let entry = entry.trim().to_ascii_lowercase();
        if LAUNCHABLE.contains(&entry.as_str()) && !extensions.contains(&entry) {
            extensions.push(entry);
        }
    }
    extensions
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

/// What to run for a program found on the PATH.
#[derive(Debug, PartialEq, Eq)]
struct Launch {
    executable: PathBuf,
    /// Arguments before the agent's own (the script, when Node runs it).
    prefix: Vec<OsString>,
}

/// The program itself; on Windows, for an npm `.cmd` shim, the real program
/// behind it.
fn launch_for(found: &Path, search: &SearchEnv) -> Result<Launch, String> {
    let extension = found
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if extension != "cmd" && extension != "bat" {
        return Ok(Launch { executable: found.to_path_buf(), prefix: Vec::new() });
    }
    let unreadable = || {
        format!(
            "{} is a launcher script Litria cannot read. Reinstall it with its official installer or with npm.",
            found.display()
        )
    };
    let size = std::fs::metadata(found).map_err(|_| unreadable())?.len();
    if size > MAX_SHIM_BYTES {
        return Err(unreadable());
    }
    let text = std::fs::read_to_string(found).map_err(|_| unreadable())?;
    let relative = npm_shim_target(&text).ok_or_else(unreadable)?;
    let folder = found.parent().ok_or_else(unreadable)?;
    let target = folder.join(relative);
    if !target.is_file() {
        return Err(unreadable());
    }
    match target.extension().and_then(OsStr::to_str).map(str::to_ascii_lowercase).as_deref() {
        Some("exe") => Ok(Launch { executable: target, prefix: Vec::new() }),
        Some("js" | "cjs" | "mjs") => {
            // As the shim does: the node.exe beside it, else the one on PATH.
            let beside = folder.join("node.exe");
            let node = if beside.is_file() { Some(beside) } else { search.find("node") };
            let node = node.ok_or_else(|| {
                format!("{} needs Node.js, which is not on the PATH.", found.display())
            })?;
            Ok(Launch { executable: node, prefix: vec![target.into_os_string()] })
        }
        _ => Err(unreadable()),
    }
}

/// The program an npm `cmd-shim` runs, relative to the shim's folder: the
/// last quoted `%dp0%\…` (or `%~dp0\…`) path on the line that passes the
/// arguments on (`%*`). Anything else is not read as a shim.
fn npm_shim_target(text: &str) -> Option<PathBuf> {
    let line = text
        .lines()
        .map(str::trim)
        .filter(|line| line.ends_with("%*"))
        .last()?;
    let quoted: Vec<&str> = line.split('"').skip(1).step_by(2).collect();
    let raw = quoted.into_iter().rev().find_map(|part| {
        part.strip_prefix("%dp0%\\").or_else(|| part.strip_prefix("%~dp0\\"))
    })?;
    // A plain relative path into the shim's folder: no variables, no
    // parent steps, no drive or root.
    if raw.is_empty() || raw.contains('%') || raw.contains(':') || raw.starts_with('\\') {
        return None;
    }
    let mut relative = PathBuf::new();
    for part in raw.split('\\') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        relative.push(part);
    }
    Some(relative)
}

/// The agent's own arguments: Litria's MCP server for this session only. The
/// person's own servers stay (no `--strict-mcp-config`).
fn agent_args(agent: Agent, helper: &Path) -> Result<Vec<OsString>, String> {
    let helper = helper
        .to_str()
        .ok_or_else(|| format!("Litria's own path is not valid Unicode: {}", helper.display()))?;
    let flag = crate::mcp_connection::helper::FLAG;
    Ok(match agent {
        Agent::Claude => {
            let config = serde_json::json!({
                "mcpServers": {
                    SERVER_NAME: {
                        "type": "stdio",
                        "command": helper,
                        "args": [flag],
                        "env": {
                            ENDPOINT_VAR: format!("${{{ENDPOINT_VAR}}}"),
                            TOKEN_VAR: format!("${{{TOKEN_VAR}}}"),
                        }
                    }
                }
            });
            vec!["--mcp-config".into(), config.to_string().into()]
        }
        Agent::Codex => vec![
            "-c".into(),
            format!("mcp_servers.{SERVER_NAME}.command={}", toml_string(helper)).into(),
            "-c".into(),
            format!("mcp_servers.{SERVER_NAME}.args=[{}]", toml_string(flag)).into(),
            "-c".into(),
            format!(
                "mcp_servers.{SERVER_NAME}.env_vars=[{}, {}]",
                toml_string(ENDPOINT_VAR),
                toml_string(TOKEN_VAR)
            )
            .into(),
        ],
    })
}

/// A TOML basic string.
fn toml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            c if (c as u32) < 0x20 || c == '\u{7f}' => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("litria-agent-launch-{name}-{}", rand::random::<u32>()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // npm's cmd-shim output, as installed by `npm install -g` (2026-10-24).
    const CLAUDE_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n";
    const CODEX_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";

    #[test]
    fn npm_shims_name_the_real_program() {
        assert_eq!(
            npm_shim_target(CLAUDE_SHIM),
            Some(PathBuf::from("node_modules").join("@anthropic-ai").join("claude-code").join("bin").join("claude.exe"))
        );
        assert_eq!(
            npm_shim_target(CODEX_SHIM),
            Some(PathBuf::from("node_modules").join("@openai").join("codex").join("bin").join("codex.js"))
        );
    }

    #[test]
    fn a_shim_that_leaves_its_folder_or_uses_variables_is_not_read() {
        for line in [
            "\"%dp0%\\..\\evil.exe\" %*",
            "\"%dp0%\\node_modules\\..\\..\\x.exe\" %*",
            "\"%dp0%\\%USERPROFILE%\\x.exe\" %*",
            "\"%dp0%\\C:\\x.exe\" %*",
            "\"%dp0%\\\\x.exe\" %*",
            "\"C:\\tools\\x.exe\" %*",
            "\"%dp0%\\x.exe\"",
            "",
        ] {
            assert_eq!(npm_shim_target(line), None, "{line:?}");
        }
    }

    #[test]
    fn launchable_extensions_follow_pathext_and_skip_scripts() {
        assert_eq!(
            launchable_extensions(Some(OsStr::new(".COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1"))),
            vec![".com", ".exe", ".bat", ".cmd"]
        );
        assert_eq!(launchable_extensions(Some(OsStr::new(".cmd;.EXE"))), vec![".cmd", ".exe"]);
        assert_eq!(launchable_extensions(None), vec![".com", ".exe", ".bat", ".cmd"]);
    }

    #[cfg(windows)]
    #[test]
    fn the_first_launchable_hit_on_the_path_wins() {
        let first = scratch("first");
        let second = scratch("second");
        // npm also writes an extensionless sh shim and a .ps1 one.
        fs::write(first.join("claude"), "sh").unwrap();
        fs::write(first.join("claude.ps1"), "ps").unwrap();
        fs::write(second.join("claude.exe"), "exe").unwrap();
        fs::write(second.join("claude.cmd"), "cmd").unwrap();
        let path = std::env::join_paths([&first, &second]).unwrap();
        let pathext = OsStr::new(".COM;.EXE;.BAT;.CMD;.PS1");
        assert_eq!(find_on_path("claude", &path, Some(pathext)), Some(second.join("claude.exe")));
        assert_eq!(find_on_path("codex", &path, Some(pathext)), None);
    }

    #[cfg(windows)]
    #[test]
    fn a_cmd_shim_runs_its_real_program() {
        let dir = scratch("shim");
        let exe = dir.join("node_modules").join("@anthropic-ai").join("claude-code").join("bin");
        fs::create_dir_all(&exe).unwrap();
        fs::write(exe.join("claude.exe"), "exe").unwrap();
        fs::write(dir.join("claude.cmd"), CLAUDE_SHIM).unwrap();
        let search = SearchEnv { path: OsString::new(), pathext: None };
        assert_eq!(
            launch_for(&dir.join("claude.cmd"), &search),
            Ok(Launch { executable: exe.join("claude.exe"), prefix: Vec::new() })
        );

        // A Node script runs under the node.exe beside the shim, as the shim does.
        let js = dir.join("node_modules").join("@openai").join("codex").join("bin");
        fs::create_dir_all(&js).unwrap();
        fs::write(js.join("codex.js"), "js").unwrap();
        fs::write(dir.join("node.exe"), "node").unwrap();
        fs::write(dir.join("codex.cmd"), CODEX_SHIM).unwrap();
        assert_eq!(
            launch_for(&dir.join("codex.cmd"), &search),
            Ok(Launch { executable: dir.join("node.exe"), prefix: vec![js.join("codex.js").into_os_string()] })
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_shim_whose_program_is_missing_or_unknown_is_refused() {
        let dir = scratch("refused");
        fs::write(dir.join("claude.cmd"), CLAUDE_SHIM).unwrap();
        let search = SearchEnv { path: OsString::new(), pathext: None };
        let missing = launch_for(&dir.join("claude.cmd"), &search).unwrap_err();
        assert!(missing.contains("cannot read"), "{missing}");

        fs::write(dir.join("other.cmd"), "@echo off\r\ncall something.bat %*\r\n").unwrap();
        assert!(launch_for(&dir.join("other.cmd"), &search).is_err());

        fs::write(dir.join("huge.cmd"), "x".repeat(MAX_SHIM_BYTES as usize + 1)).unwrap();
        assert!(launch_for(&dir.join("huge.cmd"), &search).is_err());
    }

    #[test]
    fn a_program_that_is_not_a_shim_runs_as_it_is() {
        let search = SearchEnv { path: OsString::new(), pathext: None };
        let found = Path::new("/opt/bin/claude");
        assert_eq!(
            launch_for(found, &search),
            Ok(Launch { executable: found.to_path_buf(), prefix: Vec::new() })
        );
    }

    #[test]
    fn claude_gets_litria_for_this_session_only_and_the_token_by_reference() {
        let args = agent_args(Agent::Claude, Path::new("C:\\Program Files\\Litria\\litria.exe")).unwrap();
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], "--mcp-config");
        let config: serde_json::Value = serde_json::from_str(args[1].to_str().unwrap()).unwrap();
        let server = &config["mcpServers"]["litria"];
        assert_eq!(server["command"], "C:\\Program Files\\Litria\\litria.exe");
        assert_eq!(server["args"], serde_json::json!(["--mcp-helper"]));
        assert_eq!(server["env"]["LITRIA_MCP_TOKEN"], "${LITRIA_MCP_TOKEN}");
        assert_eq!(server["env"]["LITRIA_MCP_ENDPOINT"], "${LITRIA_MCP_ENDPOINT}");
        // The person's own servers stay.
        assert!(!args.iter().any(|a| a == "--strict-mcp-config"));
    }

    #[test]
    fn codex_gets_litria_for_this_session_only_and_the_token_by_name() {
        let args = agent_args(Agent::Codex, Path::new("C:\\Users\\O'Brien \"x\"\\litria.exe")).unwrap();
        let args: Vec<String> = args.into_iter().map(|a| a.into_string().unwrap()).collect();
        assert_eq!(
            args,
            vec![
                "-c",
                "mcp_servers.litria.command=\"C:\\\\Users\\\\O'Brien \\\"x\\\"\\\\litria.exe\"",
                "-c",
                "mcp_servers.litria.args=[\"--mcp-helper\"]",
                "-c",
                "mcp_servers.litria.env_vars=[\"LITRIA_MCP_ENDPOINT\", \"LITRIA_MCP_TOKEN\"]",
            ]
        );
    }

    #[test]
    fn toml_strings_escape_what_toml_requires() {
        assert_eq!(toml_string("a\\b\"c\u{1}"), "\"a\\\\b\\\"c\\u0001\"");
        assert_eq!(toml_string("plain"), "\"plain\"");
    }
}
