# ADR-034: The Terminal Inherits the User's Environment

## Status

Accepted (2026-10-15 — owner rulings during track T: "inherit, fix docs" for gap G1, then the list of launcher leaks approved as proposed. Delivered by PR #140.)

Proposed (2026-10-15 — gap G1 put to the owner with three options: inherit as other IDE terminals do, a strict allowlist, or something between.)

## Date

2026-10-15

## Context

The terminal was designed to pass only an allowlist of environment variables (the phase 5 terminal brief, 2026-07), and the security audit recorded it that way on 2026-07-16.

It never did. portable-pty's `CommandBuilder::new` starts from the whole process environment, and on Windows it also reloads the user's and the system's environment from the registry. Litria only overlaid the allowlisted keys on top. The tests checked the map Litria computed, not what the shell received. This was found on 2026-10-14 while mapping the code for track T slice T2a, and recorded as gap G1 in the [Run brief](../plans/ideas/brief-run-application.md) and as an erratum in the [security audit](../security-audits/security-audit.md).

Track T's decision D3 ([build plan](../plans/agent-integration/track-t-build-plan.md)) assumed the filter worked: it proposed a pass-through list so that an agent started in the terminal would keep the person's own `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR` or `CODEX_HOME`.

What bears on the choice:

- Litria sets no environment variable of its own.
- The shell runs as the same user who started Litria. Everything in Litria's environment came from that user, or from the program they started Litria with. A filter between the two guards no boundary.
- VS Code, JetBrains and Windows Terminal all give their terminals the user's environment.
- A strict allowlist breaks ordinary setups (`JAVA_HOME`, proxies, `SSH_AUTH_SOCK`, `DISPLAY`) and the agents' own sign-in and config variables. That runs against the owner's rule that users bring their own setups.
- Something does leak when Litria is started from inside another program, such as a VS Code terminal, a Claude Code session or a snap. That program's session state sits in Litria's environment and reaches every shell:
  - `ELECTRON_RUN_AS_NODE` makes any Electron app started from the terminal run as plain Node;
  - VS Code's IPC handles point at a VS Code window;
  - Claude Code's inbox socket and token let any program post into the launching session;
  - an inherited `CLAUDE_CODE_CHILD_SESSION` makes a top-level `claude` count as nested, which turns off `--resume` and `--continue`. Track T relies on those.

## Decision

### 1. Inherit

A terminal's environment is the user's own, as Litria inherited it, including what portable-pty reloads from the Windows registry. There is no allowlist.

### 2. Remove what a launcher leaked

Before the shell starts, Litria removes the variables that a program that started it leaked into its process: names that point at that program's own windows, sockets and sessions. The list of record is `terminal_policy::launcher_leaks` in `src-tauri/src/terminal_policy.rs`. It rests on three sources:

- VS Code's own rule for its terminals (`sanitizeProcessEnvironment` in VS Code's source), plus the window handle VS Code keeps for itself;
- VS Code's git sign-in hook, removed only when its pair is present, so a `GIT_ASKPASS` of the user's own stays;
- Claude Code's session variables, **by exact name, never by prefix**: many `CLAUDE_CODE_*` names are the user's own settings.

Names compare the way the platform compares them: without case on Windows, exactly elsewhere.

### 3. Say what the terminal is

`TERM`, `COLORTERM`, `TERM_PROGRAM` and `TERM_PROGRAM_VERSION` are set over whatever was inherited. `terminal_policy::FORCED_ENV` is the record.

### 4. A name joins the list only with evidence

Adding a name needs a primary source, meaning the launcher's own code or documentation, showing two things: the launcher sets the name for the programs it starts, and the name is not a user setting. Users' setups are at stake, so the owner rules on each addition.

### 5. Tests check the child

Tests check what a real shell receives, not a map Litria computed.

### 6. Scope: the interactive terminal

Run ([ADR-029](029-managed-project-runs.md)) builds each child's environment itself, from an explicit platform base (Run brief §7), and does not reuse the terminal's. Language servers keep their cleared environment.

## Consequences

**Positive**

- An agent started in Litria's terminal sees what it would see in the person's own terminal: their keys, config folders and proxies. Track T's D3 needs no pass-through list.
- Programs started from the terminal no longer pick up another program's session. Electron apps run as apps, and `claude` started there is a top-level session that can resume.
- The security audit's claim matches the code, and a test enforces it on the child.

**Costs**

- Programs in the terminal see every credential in the user's environment, as in any terminal. That is the same user, so it is outside the guarantee.
- `LD_PRELOAD`, `NODE_OPTIONS`, `BASH_ENV` and the like reach the shell when the user set them. The 2026-07-16 claim that they were dropped was never true.
- The list holds exact names, and it drifts. A new session variable from Claude Code, or a launcher not on the list, passes until it is added.
- The Linux AppImage launcher's own variables are not verified yet (Implementation Follow-ups).

## Alternatives Considered

- **A strict allowlist** (clear the environment, then add the platform's essentials). This is what the 2026-07 design intended. Rejected: it guards no boundary, it breaks ordinary setups and the agents' own config, and it needs an ever-growing pass-through list (D3).
- **Inherit everything, remove nothing.** Rejected: a leaked session breaks programs started from the terminal (`ELECTRON_RUN_AS_NODE`), hands another session's inbox token to every program there, and turns off `claude`'s resume.
- **Remove by prefix** (`VSCODE_*`, `CLAUDE_CODE_*`). Rejected: it removes the user's own settings, documented Claude Code settings and VS Code's own among them.
- **Rebuild a login environment** (from the Windows registry, or a login shell elsewhere) instead of inheriting. Rejected: it drops what the user set in the shell they started Litria from, which other IDEs keep, and macOS and Linux have no single reliable source for it.

## Scope Notes

- The evidence for each name, and the adversarial check, are in the security audit's 2026-10-15 entry. The ruling and its delivery are recorded under D3 in the [track T build plan](../plans/agent-integration/track-t-build-plan.md).
- The terminal's executable allowlist and its `path_guard` check on the project root are unchanged.

## Implementation Follow-ups

- **The Linux AppImage.** Its launcher probably sets GTK and GIO variables, plus `APPIMAGE`, `APPDIR`, `ARGV0` and `OWD`, for every shell. Check the real AppImage on Linux, then propose any additions under decision 4. `XDG_DATA_DIRS` cannot simply be removed, because the user's own value would go with it.
- **Re-check Claude Code's session variables when T2b starts the agent.** The names change between versions.
