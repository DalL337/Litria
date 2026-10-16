# Track T build plan: connecting the user's own agents

Status: **Ruled 2026-10-14: the owner took every recommendation in [§2](#2-owner-decisions), "for now". The terminal's mechanics may be rethought before T2 (rethought the same day: T2a).** *(Proposed the same day.)* **Progress:** T2a merged 2026-10-15 (#137); T1a merged 2026-10-15 (#138); gap G1 ruled the same day (D3 erratum). See the [slice map](#5-slice-map).

Parents: [ADR-031](031-agent-integration-and-lifecycle.md) (decisions), [agent integration brief](brief-agent-integration.md) (design and the §10 gates), [Project API build plan](project-api-build-plan.md) (the P and W tracks this plan builds on; its "Track T" section is the stub this plan replaces).
This document owns track T's sequencing and evidence. It owns no decisions: §2 lists what the owner rules on, and the brief stays the design authority.

## 1. What track T delivers

A person working in Litria starts **their own** Claude Code or Codex from Litria. The agent gets Litria's tools for the project that is open: the graph, files, diagnostics, and edits that land as unsaved, undoable changes. Everything else stays the agent's own: its sign-in, settings, instructions, skills, tools and permission prompts.

The P and W tracks built those tools (PRs #86–#136). Today they answer only a debug-only development call. Track T connects them to real agents.

**Owner rulings already given (2026-10-11):**
- Anthropic and OpenAI first.
- Litria starts the user's own Claude Code or Codex. Litria runs no agent loop of its own.
- Keys are the user's own provider keys, never keys Litria issues or pays for.
- Agents are not hijacked: Litria never turns off or restricts an agent's own tools. Litria's tools are an offer.
- The agent's own approval is enough. Litria does not stack a second prompt on it.
- Users bring their own setups. Litria is not opinionated about how they work.

**Deferred, not dropped:**
- The local-model route. ADR-031 keeps it a product requirement. It follows Anthropic and OpenAI.
- Sign in with ChatGPT (OpenAI allows it for open-source local apps), as a later, lower-friction option.
- Litria's own review screen. It stays in the code (`ReviewPolicy::PersonReview`) and stays off by default.
- Background or scheduled agent work (ADR-031 §4: off by default, separate design).
- Agents other than Claude Code and Codex.

## 2. Owner decisions

Recommendations are marked. Engineering choices that need evidence, not a ruling, are settled inside their slices and listed there.

> **Owner rulings (2026-10-14):** "the decisions are good for now. I will go with your recommendations. we might have to rethink the terminal and its mechanics."
> - D1–D6 are ruled as recommended below: the agent runs in Litria's terminal first, and the ACP panel follows track T.
> - "For now": any of these can be revisited when evidence arrives.
> - **The terminal's mechanics are open.** T2 starts by reviewing them with the owner. T1a, T1b and T3 do not depend on the terminal. *(Reviewed the same day: the rulings are in [T2a](#t2a-conversations-that-outlive-their-tab).)*

### D1. How Litria starts the agent

| | **A. In Litria's terminal** (recommended first) | **B. In a Litria conversation panel, through ACP** |
|---|---|---|
| What the person sees | The agent's own screen, in Litria's terminal drawer | A Litria chat panel; Litria draws the agent's messages and permission requests |
| How Litria's tools reach it | Added for that session only: `claude --mcp-config`, `codex -c mcp_servers…` | Passed in ACP's `session/new` |
| Sign-in and billing | Whatever the agent already uses. Litria never sees a key | Claude: the user's API key only, until Anthropic answers. Litria must store the key securely |
| What Litria must build | The MCP connection (T1), starting the CLI (T2b, on T2a's sessions), file-change handling (T3) | All of A, plus: a chat panel, an ACP client, a permission-request screen, installing and pinning the adapters, key storage, a "which billing is in use" display |
| Provider status | Research marks it allowed for both providers, subscriptions included (§3). One line goes to Anthropic to confirm | Claude's adapter is built on the Agent SDK, so subscription use is unclear. Codex's adapter is built on `app-server`, which OpenAI calls experimental |
| Fits "not hijacked" | Completely: nothing sits between the person and the agent | Litria redraws the agent's own requests, so it must do so faithfully |

**Why A first:** everything A needs, B needs too, so nothing is thrown away. A ships Litria's tools to the agents people already use, soonest, with no key handling.

**What A gives up:** Litria cannot show the agent's activity in its own UI, and Stop is the agent's own interrupt key. ADR-031's alternative 6 calls an outside-client-only connector "insufficient as the primary in-app conversation experience". So under A, the ACP panel stays the destination, as the next plan after track T. If the owner picks A, a dated note records the order in the brief's §10 and in ADR-031's follow-ups. The decisions themselves do not change.

### D2. Sign-in for the terminal route (if D1 = A)

- **Recommended:** the agent uses whatever sign-in the person already set up, subscription or API key. Litria never asks for, stores or passes a key.
- **Confirm with Anthropic:** add one line to the owner's open question to Anthropic: "Litria opens the user's own unmodified `claude` in Litria's built-in terminal, where they sign in through Anthropic's own flow." Research marks this allowed. The line removes any doubt about "running Claude Code in your products".
- **Until then:** track T's own checks never use a developer's subscription sign-in (T2b runs signed out; T4 uses an API key).

### D3. The agent's own environment variables (if D1 = A)

Litria's terminal passes only an allow-list of environment variables (`terminal_policy.rs`). So a person's `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR` or `CODEX_HOME` never reach an agent started there, and their setup silently changes.

- **Recommended:** for agent launches only, pass a short, named list of the agent's own variables through **unchanged**. Litria adds none and changes none. The ordinary terminal keeps its allow-list.
- **Alternative:** keep the allow-list. People who set up their agent through variables get a hint instead.

> **Erratum and owner ruling (2026-10-15):** the premise above is wrong. The terminal does not filter its environment: portable-pty starts from the whole process environment (plus, on Windows, the registry's), and Litria only overlays the allow-listed names (gap G1; security audit erratum of 2026-10-14). Litria sets no variable of its own. The owner ruled: **keep inheriting the user's environment**, as other IDE terminals do, and fix the docs and the tests that checked the overlay rather than the child. So an agent started in Litria's terminal sees exactly what it would see in the person's own terminal, and D3 needs no pass-through list. The fix (remove the overlay and its tests, keep `TERM`/`COLORTERM`/`TERM_PROGRAM`, strip only variables a launching program leaks in, such as `VSCODE_*`) is its own small change before T2b (board card `terminal-env-allowlist-not-enforced`).
>
> **Done (2026-10-15, branch `fix/g1-terminal-env`; decision record [ADR-034](../../adrs/034-terminal-inherits-the-user-environment.md)):** the overlay and its tests are gone; the terminal inherits, then drops what a launching program leaked in (`terminal_policy::launcher_leaks`), on a list the owner approved the same day: VS Code's own rule for its terminals (`ELECTRON_*`, `VSCODE_*` but its user settings, `SNAP*`, `GDK_PIXBUF_*`), VS Code's `GIT_ASKPASS` when its hook comes with it, and Claude Code's session variables by exact name. The last matters to T2b: an inherited `CLAUDE_CODE_CHILD_SESSION` makes a top-level `claude` count as nested, which turns off `--resume` and `--continue`. User settings pass, `CLAUDE_CODE_*` ones included. `TERM_PROGRAM_VERSION` is now Litria's version. A real-shell test checks what the child sees. The Linux AppImage launcher's own variables are a follow-up (card `appimage-launcher-env`).

### D4. What a started agent may do

- **Recommended:** the whole Project API catalog, for the project it was started in only (reads, `litria_changes_prepare`, `litria_changes_apply`, `litria_operations_get`). This matches "the agent's own approval is enough".
- **Alternative:** reads only by default, with edits switched on per project.

### D5. Which tools the agent is shown

MCP lets `tools/list` show every tool, or only those the grant allows (Project API build plan, P6 record).

- **Recommended:** only the allowed tools. A smaller list costs a small model less context, and the agent never tries a tool it will be refused.

### D6. Receipts after Litria restarts

W4 keeps operation receipts for 30 days. A reconnecting agent should see its own (T1b). After a restart, the agent session is new.

- **Recommended:** a new session does not inherit the old session's receipts. The reopen notice (W4b) already tells the person about interrupted work.

## 3. Provider rules this plan stays inside

Checked from primary sources on 2026-10-11, and every load-bearing quote re-fetched and matched. Re-check before T4, because these pages change.

- **Both providers** allow the user's own API key, billed to that user. Litria never pays for, resells or proxies usage.
- **Anthropic** ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), [authentication](https://code.claude.com/docs/en/authentication), [usage policy](https://www.anthropic.com/legal/aup) from 2026-11-12):
  - allowed: the user's own unmodified `claude`, signed in through Anthropic's flow, subscription included;
  - not allowed: a Litria "Log in with Claude"; handling claude.ai tokens; routing a subscription through Litria's own client; a modified binary; removing or restricting its sign-in methods;
  - unclear, asked of Anthropic: driving the Agent SDK or `claude -p` on a subscription;
  - naming: "Claude Agent" or the plain text "runs Claude Code", never "Claude Code" as a feature name;
  - a key in the agent's environment outranks its own sign-in (`-p`: "always used when present"). Litria never injects one.
- **OpenAI** ([app-server](https://learn.chatgpt.com/docs/app-server), [MCP server removal](https://learn.chatgpt.com/docs/mcp-server), [Sign in with ChatGPT terms](https://openai.com/policies/sign-in-with-chatgpt-terms/), [brand](https://openai.com/brand/)):
  - allowed: launching the user's installed Codex under its own sign-in and config, for local or open-source apps;
  - Codex reaches MCP servers over stdio or local HTTP, from its config or a per-run `-c` override;
  - `codex mcp-server` is removed; `app-server` is experimental;
  - naming: no "GPT" or OpenAI names in Litria's product names.

## 4. Delivery rules

- **Standard checks, evidence and live-pass rules:** as in the [Project API build plan §1](project-api-build-plan.md#1-delivery-rules-and-baseline). One slice, one branch, one pull request, in a worktree off a refreshed `main`.
- **Policies:** implementation and verification for every slice. Security (Rule 1: a new execution and IPC surface, or a changed process-spawn command) for T1, T2a and T2b. Adversarial check for T1 (authentication, bounds, principal binding) and T3 (check-then-write saving). Dependency change for any new crate or tool pin (an MCP SDK, a file watcher, agent version pins).
- **No paid generation before T4.** No check in T1–T3 sends a prompt to a model. Starting, reconnecting and restoring leave the agent idle (ADR-031 §4).
- **Agent processes are the person's, not Litria's dependencies.** Litria detects an installed `claude` or `codex` and hints when one is missing. It never installs one (security policy Rule 2, class 4).
- **Placement:** a new Rust module for agent sessions and the MCP connection is recorded in [`rust-module-ownership.md`](../../rust-module-ownership.md) before its code lands. Any new JavaScript domain gets its [Domain Register](../../Orchestration.md#2-domain-register) entry first. The existing `ConnectionDomain` means graph connections and does not take this on (brief §3).

## 5. Slice map

| Slice | Delivers | Depends on | Status |
|---|---|---|---|
| T1a | Litria's MCP connection: a stdio helper, authenticated local IPC bound to one project session, `initialize` and `tools/list` | D4, D5 | Merged 2026-10-15 (#138 → c786413; see [T1a record](#t1a-record)) |
| T1b | `tools/call` through the boundary with real principals and grants; receipts owned by the agent session; raw-message bounds | T1a, D6 | Not started |
| T2a | Conversations that outlive their tab: several terminal sessions per project, alive until ended or the project closes; the notice before a switch ends busy ones | — (alongside T1 and T3) | Merged 2026-10-15 (#137 → b70db3f; see [T2a record](#t2a-record)) |
| T2a-2 | "Needs you" on a tab: the bell and the Program Status Protocol (OSC 7501), and a hidden session waiting for an answer shown outside the drawer | T2a | Not started (split from T2a, 2026-10-14) |
| T2b | Starting the user's own agent from Litria; continuing its conversations when the project reopens; keyless qualification on Windows | T1b, T2a, D1–D3 | Not started |
| T3 | Files changed outside Litria: detect, reload, keep both on conflict, never overwrite on save | — (alongside T1 and T2a) | Not started |
| T4 | Real tasks on the owner's API key; first release | T2b, T3 | Not started |
| T5 | macOS and Linux qualification | T4 | Not started; needs macOS and Linux testers |

T2a and T3 depend on nothing in track T and can be built alongside T1. Both help people who never start an agent: T2a anyone running a shell, T3 anyone editing in another program. T3 must land before T4, because a real task will use the agent's own file tools.

## T1a. Litria's MCP connection

### Goal

A scripted MCP client (no agent) connects to the running app through Litria's helper, is authenticated, and receives `initialize` and `tools/list` answers built from the committed schemas.

### Tasks

- **The helper.** A small program the agent starts as a stdio MCP server. It relays messages between stdio and the running app's local IPC, and exits when either side closes.
  - Settle with evidence: a separate bundled binary (Tauri sidecar) or the app binary with a flag. Criteria: bundle size, code signing, start time, and no console window flashing on Windows (release builds flash one for any child started without `platform::hidden_command`).
- **The local IPC.** A named pipe on Windows, a Unix socket elsewhere, readable only by the current user. No network listener (brief §3).
  - Settle with evidence: the pipe or socket name and its permissions on each OS.
- **Authentication.** Litria mints a short-lived token per agent session. The token is bound to one project session: the workspace and its epoch, and the app run. Epochs restart every run, so an epoch alone is not an identity across restarts (adversarial-check Learned Flaw 12, found in W4a).
  - The token never lands in shell history or a file that outlives the session.
  - Revoked when the project closes or switches, when the session ends, and when the app exits.
  - A connection with a missing, wrong or revoked token is refused before any Project API code runs.
- **The MCP envelope.** Re-open the P6 decision, SDK or thin serializer, with the P6 record's criteria (revision 2026-07-28 support, stdio, schemas served verbatim, MSRV, licence, audit, maintenance). Record it.
- **`tools/list`** from the committed artifacts, filtered by the grant if D5 says so.

### Tests

- Handshake with a scripted client over the real pipe or socket: `initialize`, then `tools/list`, byte-identical to the committed artifacts.

  > **Erratum (2026-10-15, T1a):** "byte-identical" cannot hold over stdio, which forbids newlines inside a message, while the committed files are pretty-printed. The test checks each served schema equals its committed file as a JSON value (see the [T1a record](#t1a-record)).
- Refused: no token, a wrong token, a revoked token, a token from another project, a token from a previous app run.
- The helper exits when the app closes the channel and when the agent closes stdin. No helper process outlives either.
- The pipe or socket refuses another user (where the OS allows a test).

### Acceptance

Standard checks pass. The security review and the adversarial check are recorded. A live pass on Windows: a scripted client connects to a debug build on a scratch project and lists the tools.

### T1a record

> **Built 2026-10-15 on branch `feat/t1a-mcp-connection`; merged 2026-10-15** (#138 → c786413, all checks green on its head). Journal `.research/2026-10-15-track-t-next-slice.md`. Owner rulings the same day: the next slice is T1a; gap G1 is settled as "inherit the environment" (see the D3 erratum).
>
> **What the installed agents actually send** (captured 2026-10-15 with a logging stub server, scratch config folders, nothing signed in, no model call):
> - **Claude Code 2.1.185** (`claude mcp list`, which connects and lists tools): `initialize` with `protocolVersion: "2025-11-25"` and capabilities `roots` and `elicitation`, then `notifications/initialized`, then `tools/list`; it ends by closing stdin. It passes its whole environment to the server.
> - **Codex 0.162.0-alpha.17.2** (`codex debug prompt-input`, a local render; `codex mcp list` does not connect): `initialize` with `"2025-06-18"`, then `notifications/initialized`, then `tools/list` with a `_meta.progressToken`. It passes the server none of its own variables, only what its config names (`env`, `env_vars`).
>
> **Decisions settled with evidence:**
> - **The handshake revisions, not 2026-07-28.** MCP 2026-07-28 removed `initialize`; a server that speaks only 2026-07-28 fails both installed agents (the specification's compatibility table: "Legacy client, modern server: fails"). Litria serves `initialize` for 2025-11-25 and 2025-06-18 (a requested revision it serves is echoed, any other gets 2025-11-25, which Claude Code 2.1.185 accepts), `notifications/initialized`, `ping` (also before `initialize`) and `tools/list`. Not 2025-03-26: it has no `outputSchema` or `structuredContent`. `server/discover`, the 2026-07-28 probe, gets "method not found" at once; the specification makes such clients fall back to `initialize` on any error. Claude Code negotiates 2026-07-28 by default from 2.1.292 (changelog, 2026-10-06), so T2b's keyless pass checks that fallback with a current Claude Code. Serving 2026-07-28 itself is a follow-up. Results for these revisions carry no `resultType` (a 2026-07-28 field); the P6 tests keep the 2026-07-28 shape pinned.
> - **SDK or thin serializer: the thin serializer, again.** rmcp 3.5.1 (2026-10-05) is dual-era and accepts the committed schemas as raw JSON, but it needs tokio (the codebase uses none), about 50 crates with its server and stdio features, and schemars, which would go unused; it requires Rust 1.88 and edition 2024; its licence is moving from MIT to Apache-2.0; and its stdio reader has no size cap. The app never speaks stdio itself (it speaks the pipe), so the SDK's transport would go unused too. The envelope Litria needs is five methods.
> - **The helper is the app's own binary** (`litria --mcp-helper`), checked in `main` before anything else starts: no window, no crash marker, no database. No bundle growth and no second binary to sign. On Windows, release builds are GUI-subsystem, so the helper can never open a console window.
> - **The endpoint.** Windows: `\\.\pipe\litria-mcp-<128 random bits>`, DACL `D:P(A;;GA;;;<user SID>)`, `PIPE_REJECT_REMOTE_CLIENTS`, the first instance exclusive. Synchronous pipe handles serialize every operation, so the helper's two relay threads would deadlock; the pipe uses overlapped I/O, which also gives deadlines and cancellation. Unix: `<XDG_RUNTIME_DIR or temp>/litria-mcp-<random>/mcp.sock` in a directory created `0700` that `mkdir` refuses if it exists; a base too long for `sun_path` falls back to `/tmp` (macOS's `$TMPDIR` does).
> - **The token hello.** Before any MCP the helper sends `{"litria":"hello","v":1,"token":…}`; the app answers `ready` or one `refused` for every reason. The token comes from the helper's environment (`LITRIA_MCP_ENDPOINT`, `LITRIA_MCP_TOKEN`), never a command line or a file. Claude Code passes its environment through, and Codex needs `env` or `env_vars` naming them (T2b).
> - **Revocation without hooks.** A connection re-checks its session before every message and every second while idle: the session must not have ended and its epoch must still be the open project's. Epochs never repeat within a run, so a stale session is ended for good. Every path that changes the open project is covered, and nothing hooks the database commands. Ending a session cancels its connections at once; a page reload ends every session (as for terminals); exit ends them before the terminals.
> - **Lifetime.** A token lives as long as its session, not on a timer, and is never persisted. T2b ends the session with its terminal session.
>
> **What changed:** `src-tauri/src/mcp_connection/` (new: `endpoint/`, `sessions.rs`, `server.rs`, `protocol.rs`, `helper.rs`, `mod.rs`); `contracts/mcp.rs` compiles into the app, with `Revision` and the grant filter on `tools/list` (D5); `project_api::agent_grant()` (D4: the whole catalog); `main.rs` branches on `--mcp-helper`; `lib.rs` wires the page-load and exit hooks and two debug-only commands, `project_api_dev_agent_session_start` and `project_api_dev_agent_session_end`; the `windows` crate gains four features of the same version. `tools/call` answers "method not found" until T1b. Release builds start no session until T2b.
>
> **Tests:** 54 new unit tests (endpoint 13, including the waiting-read/write deadlock case, 1 MiB both ways at once, deadline, cancel, shutdown, the DACL read back from the live pipe, a taken name; sessions 7; protocol 11, with Claude Code's and Codex's captured `initialize` verbatim; server 14, with every bad hello, the silent client, session end, project switch, the size cap, the per-session cap; helper 6; service 3, with the connection cap counting connections still saying hello), plus, in `contracts::mcp`, two new tests (the grant filter; results without `resultType`) and one rewritten (the revisions' names). `src-tauri/tests/mcp_helper.rs` runs the built binary as a helper: started by hand, a full handshake and a quiet exit on stdin close, a wrong token, the session ended, the project closed, Litria quitting, and the app process killed.
>
> **Adversarial check** (journal): guarantees, nine attacks with verdicts. One finding: the full suite under load showed a client connecting during shutdown could still be accepted. Sessions had already ended, so its token would have been refused, but "nobody new gets in" did not hold. Reproduced once on Windows, not deterministically; fixed (the accept thread re-checks after waking, and shutdown waits for it, at most 2 s); verified by 15 runs of the module and 3 of the full suite on Windows. Residuals in the security audit entry of 2026-10-15.
>
> **Evidence** (Windows 10 19045 unless stated):
> - `cargo build` 0 warnings; `cargo test` 801 lib + 7 process tests pass, three full runs.
> - Linux: the endpoint's real files in a `rust:1-bookworm` container (Docker Desktop's WSL2 kernel 6.6): 14 pass, including the `0700` directory and the taken name.
> - Guards 7/7; `npm run test:domains` 1626/1626; `npm audit` 0; `cargo audit` unchanged (the four `rustls` advisories tracked separately, 9 allowed warnings).
> - `cargo build --release` 0 warnings. The release binary is GUI-subsystem (PE header read: subsystem 2; the debug binary is 3, console).
> - CI found one more defect, on macos-14: macOS refuses to set a socket's timeout once the socket can no longer receive (`setsockopt` → `EINVAL` after the peer closes or after `cancel`), while Linux allows it. The Unix endpoint set the timeout before every read, so a closed peer read as an error instead of the end, and seven tests failed. Fixed in the commit after the docs commit (the read goes ahead and returns at once); all `mcp_connection` tests then pass on macos-14 and ubuntu-22.04.
> - The one macOS failure left is not T1a's: T2a's `a_shell_exiting_by_itself_is_reported_with_its_code_after_its_output` ("timed out waiting for the exit watcher") fails on `main`'s own CI for the T2a merge too (board card `macos-terminal-exit-watcher-test`).
>
> **Live pass** (Windows, a `tauri dev` build of the branch, scratch app data, throwaway projects; a scripted client spawning the real helper binary, as an agent does):
> - The handshake: first answer in 23 ms; 2025-11-25 and 2025-06-18 each negotiated; the 8 tools in catalog order, with no `resultType`; `server/discover` and `tools/call` refused at once; the helper exits 0 when stdin closes; no helper process remains.
> - The schemas served are the committed files as JSON values, all 16 of them. Their key order is not kept: `serde_json` sorts keys, and Litria does not turn on its `preserve_order` (it would change every `Value` in the app). Byte-identical output was never possible: MCP's stdio transport forbids newlines inside a message, and the committed files are pretty-printed. So the plan's "byte-identical" test reads "equal as JSON".
> - The release helper: 459 ms to the first answer on the very first launch of the new binary, then 22–23 ms.
> - Refused, each with its own exit code and a plain message, and never the token: no session (2), a wrong token (4), no endpoint (3). An ended session's token, the previous project's token after a switch, and an earlier run's token after a restart: 4.
> - A connected helper exits (code 5) when its session ends (30 ms), when the project switches (1.0 s, the idle tick), when the page reloads (22 ms), when Litria quits normally (66 ms), and when Litria's process is killed (90 ms). No helper process outlived any of them.
> - **The real agents, keyless** (fresh config folders, nothing signed in, no prompt), through the real helper with a logging tee in front:
>   - Claude Code 2.1.185, `claude mcp list` and `claude mcp get`: **✔ Connected**. The tee shows its `initialize` (2025-11-25) answered in kind, then `tools/list` answered with the full catalog.
>   - Codex 0.162.0-alpha.17.2, `codex debug prompt-input`: its `initialize` (2025-06-18) answered in kind, then `tools/list` answered with the full catalog. Codex ends its servers without closing stdin; the helper still exits.
> - For T2b: `claude mcp get` prints a server's environment values, so a token written literally into a config would show there. T2b should pass it by reference (`${VAR}` expansion, documented for `.mcp.json`; whether `--mcp-config` honours it is unconfirmed and T2b checks it).

## T1b. Tool calls with real identities

### Goal

The scripted client calls every tool through the helper. Each call runs as the agent session's own principal, under its grant, against its own project.

### Tasks

- **A real principal** in `contracts/context.rs` (today: `Test` and `Dev` only): one per agent session, carried by its token.
- **Grants** from D4, recorded per project (brief §4).
- **Receipts** (W4): owned by the agent session. A reconnecting helper with the same token sees its own receipts. Another session's operation id answers `unknown`, as today. D6 sets the restart behaviour.
- **Carried from P6:**
  - bound the raw message before parsing (today the 64 KiB budget measures re-encoded `arguments`);
  - reject duplicate JSON keys, which collapse silently when parsed.
- **`Cancelled` and `ShuttingDown`** (`contracts/error.rs`, declared for track T): answered when a call is cancelled, and while Litria closes.
- **Release builds.** The Project API stops being debug-only: remove the dead-code allowances that name track T (`lib.rs`, `bridge.rs`, `commands.rs`, `useProjectApiBridge.js`). The development call stays debug-only.

### Tests

- Every committed request fixture through the real pipe, as P6 ran the read catalog's in process.
- Principal binding: a call under session A cannot read or apply session B's plan or operation.
- Project switch mid-call: the call answers `workspaceChanged` and nothing is applied.
- Oversized and padded messages are refused before parsing; duplicate keys are refused.
- Closing the app during a call answers `shuttingDown` or ends the helper; nothing is half-applied (W4 recovery holds).

### Acceptance

Standard checks pass. The adversarial check is recorded. A live pass: the scripted client reads a file, prepares an edit and applies it in a debug build, and the receipt belongs to its session.

## T2a. Conversations that outlive their tab

### Goal

In an open project, every terminal session (a shell now, an agent conversation after T2b) keeps running when its tab or the drawer closes. It stops only when the person ends it or the project closes. A project can hold several sessions, each in its own tab.

### What the terminal does today (checked 2026-10-14)

- One session per project (`terminal_session_manager.rs` keys sessions by project).
- The drawer's content component starts the session the first time it is shown and, under the default `terminalDrawerClose: end`, ends it whenever it stops being visible. The drawer passes `isVisible = isActive && isOpen` (`TopDrawerShell.jsx`), so the session also ends on:
  - the X button;
  - a click outside the drawer;
  - Escape while focus is outside the terminal (Escape typed into the terminal is consumed by xterm and does not close the drawer);
  - switching the drawer to Logs, Scaffold or Settings.

  > **Erratum (2026-10-14, the T2a mapping):** only Terminal and Logs are top drawers. Scaffold and Settings live in the left drawer; clicking them while the terminal is open lands on the top drawer's scrim, which closes it. The effect was the same: the session ended.
- `terminalDrawerClose: hide` (since 2026-08-01, off by default) keeps the session alive behind the closed drawer, with the renderer still mounted.
- Switching projects and quitting always end it.
- No other drawer reads its visibility. The terminal is the only view that owns a resource's lifetime.

### Owner rulings (2026-10-14)

> "keep it working. the drawers are context awareness for the user's focus 'I am here right now' … they have become sources of truth for the users focus … no sources of truth for the project but for the users focus."

- **A hidden session keeps working.** Closing its tab or the drawer hides it; nothing pauses or ends.
- **Drawers are the person's focus, not the project's truth.** A drawer answers "where am I looking right now". It never decides whether something exists or keeps running.
- **Several sessions per project.**
- **Switching projects still closes everything for that project** and loads the other.
- **Sessions stay as tabs.** The tabs are meant to become the framework for a later conversation panel.

### Tasks

- **Move the session's lifetime from the view to the terminal domain.** `TerminalDomain` (JavaScript) and `terminal_session_manager.rs` (Rust) own sessions, keyed by project and session. The drawer only attaches a view to a session and detaches it.
  - [Orchestration §1.2](../../Orchestration.md#12-runtime-lifecycle-principles) rule 1 makes "whoever calls spawn" the owner. That is how the drawer came to own the session. Amend §1.2 with the owner's ruling: views attach to resources, they never own their lifetime, and drawers are the person's focus. Settle whether a guard can enforce it (for example, no drawer content calls a session's start or end).
- **Several sessions per project**, one tab each: new, switch, rename, end. Ending is deliberate: an End action on the tab, or the session's own `exit`.
- **Hiding never ends.** Closing a tab, closing the drawer, switching drawer tabs, clicking outside, Escape: all hide.
- **Retire `terminalDrawerClose`.** Its `end` value contradicts the ruling. Add a dated note to ADR-019, which lists it, and remove it from the preferences registry (and from the settings-key guard, if it lists keys).
- **Each tab shows its session's state:** running, needs you, or ended. Sources, settled with evidence per program: the terminal attention signals a program sends (the bell, and the desktop-notification escape sequences), output since the tab was last viewed, and the exit status. A hidden session that is waiting for a permission answer must be visible from outside the drawer.
- **The screen while hidden.** The view stays mounted, as `hide` does today, so its screen is kept. If the window's web view reloads, the process survives in Rust but the screen does not. Settle with evidence: a repaint on reattach (a resize makes full-screen programs redraw), or a screen buffer kept in Rust.
- **Project switch and quit** end every session of the project in the existing order (`useTerminalLifecycle`'s teardown). Before a switch while sessions are running, an inline notice says so (never a modal).
- **Bounds:** a cap on sessions per project; the existing per-session flow-control watermarks.

### Tests

- Closing a tab, closing the drawer, switching drawer tabs and clicking outside each leave the session's process alive (the same process id), and reopening shows the same session.
- Two sessions in one project keep separate input, output and size.
- End stops the session's whole process tree (Job Object on Windows, process group on Unix), and only that session's.
- Switching projects ends every session of the old project; none survives into the new one.
- A bell from a hidden session marks its tab, and viewing the tab clears it.
- The retired preference: a stored `terminalDrawerClose` value is ignored without error.

### Acceptance

Standard checks pass. A live pass on Windows with shells only. T2a ships on its own; it needs nothing from T1.

### T2a record

> **Built 2026-10-14 on branch `feat/t2a-terminal-sessions`; merged 2026-10-15** (#137 → b70db3f, all checks green on its head). Journal `.research/2026-10-14-t2a-terminal-sessions.md`. The code was mapped by nine read-only agents, the design attacked by four critics before any code was written, and the branch reviewed by four lenses, each checked by a skeptic.
>
> **Decisions made while building** (the plan did not settle them; each is the smaller, safer reading of the owner's rulings, and is open to the owner):
> - **A running tab has no close.** It has End, the deliberate action. Hiding is selecting another tab, closing the drawer, switching drawers, clicking outside or Escape. The Tasks and Tests lines above that say "closing a tab hides it" read that way. An ended tab has an × that removes it.
> - **The first shell comes from a gesture**, never from the drawer becoming visible: opening the terminal from its rail on a project with no tab starts one (one start in flight per project). A project with no tab otherwise shows "New terminal". Ending the last tab never starts another.
> - **The notice before a switch is in this slice**, not later: without it, a switch would end hidden running work without a word. It appears only when a terminal is running a program (Windows: the session's Job holds more than the shell; Unix: the shell has child processes) or printed in the last 2 s (work inside the shell process itself, such as a PowerShell loop, has no child process; silent work of that kind is missed). Idle shells end without asking. It is an inline pill: its button switches (or closes the project), dismissing it stays. A newer pick (or Exit to Launcher) answers a pill still waiting with "stay" and then asks for itself. When the busy state is unknown, it counts as busy. It comes before the unsaved-changes prompt, whose Discard cannot be undone.
> - **End asks first only when the session is running a program**, inline on the tab. By the same 2 s rule, a shell that just printed (its first prompt, or a command that just finished) asks too.
> - **A page reload ends every session.** A reload lands on the launcher with no project open, so this is the project closing. It happens in Rust as the page starts to load, so nothing the new page starts can race it, and the launcher reports once how many sessions ended (the notice stays until dismissed). A start the old page asked for is refused. Reattaching after a reload is not built.
> - **Command pills (install offers) run in a shell tab of their own**, named after the command and typed after the shell's first output, never into an existing tab (which might be running a server, an editor or, after T2b, an agent). A pill raised in another project runs nothing.
> - **"Needs you" moves to T2a-2.** It needs per-program evidence (the research found Claude Code sends nothing by default in Litria's terminal; Codex sends a bell when it thinks it is unfocused; both support the Program Status Protocol, OSC 7501). This slice shows `starting`, `running` and `ended` (with the exit code).
>
> **What changed, Rust** (`terminal_session_manager.rs`, `terminal_pty.rs`, `commands.rs`, `lib.rs`):
> - One registry lock over live sessions, starts in flight, sessions still ending, and the quit flag. Caps: 8 per project, 24 in total counting starts and unfinished teardowns. One folder per project. A start whose project closed meanwhile is ended, never registered; so is a start asked for by a page that has since reloaded (the registry counts pages). Random 128-bit session ids, validated before lookup.
> - Spawn, end, end-project and end-all run off the UI thread; each teardown runs on its own thread within a 3 s budget (below the frontend's 5 s). Quit runs once and waits, bounded, for teardowns and starts in flight. Input, resize, pause and resume stay synchronous so their order holds.
> - A writer thread owns the PTY input; input still queued when a session ends is dropped, and the pipe stays open until End is done waiting. An exit watcher notices a shell that exits by itself (on Windows the output pipe never breaks while the console host holds its reference handle, so the reader could not see it); the reader then drains the pipe, which no pause can hold any more, and sends Exited last, with the code. Output is decoded as UTF-8 across reads. Nothing reaches the webview from a session being ended.
> - End's order: Ctrl+C; `exit` only once the shell is back at its prompt (no child processes within 1 s), so it is never typed into a program; a 2 s wait; then the process tree (Windows: the Job Object dropped; Unix: every process group it captured, the shell's, each child's and the foreground one, gets SIGHUP, then SIGKILL if still alive), and the Job dropped before the pseudoconsole closes. Closing first can wedge the in-box console host. A session dropped without End is ended on another thread.
> - Removed: `terminal_session_start` (no caller) and `terminal_ipc_bridge.rs` (no listener).
>
> **What changed, frontend:** `TerminalDomain` owns the sessions; `terminalStorage` gives each session a bounded, non-draining replay (StrictMode's double mount no longer loses the banner) and a tap the domain reads with no view attached; the drawer is a tab strip over kept-mounted screens, inactive ones hidden and moved out of the clipped stack so xterm stops rendering them; the renderer fits only a measured box, reports its real size once, lifts a pause it held when it unmounts, releases its WebGL context, and gives up focus when hidden; the switch coordinator clears the domain's current project before a teardown (starts are refused while a project closes) and sets it after every open, including a reopen of the same project; `useTerminalLifecycle` keeps it in step otherwise (single files) and its backstop ends only the previous project; the drawer offers New terminal only for the current project, and a closed top drawer is inert, so Tab cannot reach a hidden session; `terminalDrawerClose` is retired.
>
> **Docs:** Orchestration §1.2 rule 1 amended (views never own a resource's lifetime; drawers are focus) and the TerminalDomain entry rewritten; implementation policy Rule 1 amended; ADR-019 status; CAPABILITIES; README; the crash investigation's out-of-scope note; the PTY brief's invariant 1 and the terminal PRD's item 5 superseded; the Run brief's gaps G2/G5/G7; the multi-session brief; the Rust module and command inventories; the security audit (a dated entry, and an erratum: the terminal environment is not filtered to its allowlist, gap G1, for the owner before T2b).
>
> **Adversarial check** (journal): two findings, both fixed. A session lock was held through the pseudoconsole close, so a resize at that moment could block the UI thread (suspected, confirmed by inspection). An unknown busy state read as idle, so a switch could end a running program unasked (reproduced on Windows against the first commit; verified fixed on Windows).
>
> **Review** (four lenses, each finding checked by a skeptic; list in the journal): 29 confirmed findings, all fixed in the commits after the docs commit. The serious ones: Discard in the unsaved-changes prompt ran before the terminal notice, so staying still lost the edits, and edits made while the notice waited were never checked; a shell that exited by itself lost its last output when the reader was paused; End typed `exit` into whatever program held the terminal; reopening the open project left no terminal able to start; a closed drawer kept the hidden session reachable by Tab; a start sent just before a reload could register a shell nothing showed. Each test added for them was checked against a mutant of its fix.
>
> **Live pass 1** (Windows, before the review fixes; journal): every hide path kept the shell (same process id); two tabs isolated; End of a busy tab asked, then stopped the program and shell in 0.3 s; a self-exit showed its code; a busy switch asked, stayed when dismissed and switched in 0.4 s; a reload ended the sessions and said so; 20 tabs created and ended with no WebGL warnings. It found two defects, fixed since: eight tabs flooding output from inside PowerShell switched away without the notice, and a second pick queued behind a waiting notice.
>
> **Live pass 2** (Windows, a fresh `tauri dev` of the branch after the review fixes, throwaway projects and app data; journal): every pass 1 check again, and: eight flooding tabs (four PowerShell loops, four `cmd` children) now raise "8 terminals are still running commands", the switch ends them all in 2.2 s with the UI never stalled more than 94 ms, and a ninth start is refused; a second pick while the notice waits replaces it at once, and Switch lands on the newest pick without opening the first; reopening the open project and then New terminal starts a shell; the closed drawer is inert (neither `focus()` nor 40 presses of Tab reach the hidden screen); End of a busy tab asks, then the program and shell are gone in 1.2 s (Ctrl+C, then `exit` at the prompt); the reload notice is still up after the splash; an untitled file's drawer says it needs a folder; 20 tabs created and ended with no WebGL warnings. Console: after a reload, each ended session's channel logs one Tauri "Couldn't find callback id" warning (its closing message reaches the new page; harmless). The many other such warnings come from event listeners that earlier page loads registered (the same ids across reloads, none a terminal channel): pre-existing, outside this slice, on the board.
>
> **Evidence** (Windows 10 19045 unless stated):
> - `cargo build` 0 warnings; `cargo test` all pass, including 20 registry tests with fake sessions (concurrent caps, the total cap counting a teardown still running, a project closed, a page reloaded or Litria quitting during a start, a wedged teardown inside its budget, other sessions responsive while one ends) and five real-shell tests (isolation; a self-exit's last output, held by a pause, arriving before Exited with code 3; End stopping a program Ctrl+C cannot, and only in its own session; a background job counted busy and stopped; the drop backstop), run against both the in-box console host and the sideloaded 1.24 host.
> - `npm run test:domains` all pass, including the drawer driven in StrictMode through every hide path (nothing ends, the same screen stays mounted), the switch coordinator (terminals end before the database closes; a busy terminal asks; nothing starts while a project closes), the gate, the domain through the real event stream, the screen itself under StrictMode with an xterm recorder, and a contract test that fails on `main`'s drawer.
> - Guards 7/7; `npm run build`.
> - Linux: `cargo test --lib terminal` in a Debian bookworm container (Docker Desktop's WSL2 kernel), 44 pass, the five real-shell tests included. CI on the PR: `cargo test` passes on macos-14 and ubuntu-22.04.
> - CI found one more defect, fixed since: on ubuntu-22.04 a background job outlived End, twice. End let go of its input sender before stopping the process tree; with no sender left, the writer thread dropped the PTY writer, whose drop types newline + EOF on Unix, so the shell exited first and its job was no longer its child when End looked for it. Now only End's release closes a session's input, after the tree is stopped. A writer test fails on the old code; the real-shell test passes on the runner.
> - Live passes 1 and 2 on Windows (above).
>
> **Erratum (2026-10-15, macOS; branch `fix/macos-self-exit-test`):** "the reader then drains the pipe, which no pause can hold any more" holds on Windows and Linux only. On macOS the shell is its terminal's controlling process, and the kernel (XNU `proc_exit` → `ttywait`, no timeout unless the superuser sets one) drains that terminal's output before the process can finish exiting. While the view has paused the output, a shell that exits by itself waits mid-exit (`ps`: `E`, trying to exit) and is noticed only after the view resumes, then 245 ms later on the runner. Nothing is lost and the last output still comes before `Exited`; the notice is only later. This made the real-shell test "a shell exiting by itself" fail intermittently on macos-14 (on `main`'s CI for the T2a merge b70db3f and on PR #138), passing only when the read in progress at the pause happened to take all of the shell's last output. The test now parks the reader first, so the last output is surely queued, and expects the macOS behaviour there: the exit is held while paused and follows the resume. On Linux and Windows it now also checks that the shell really exited with its output still queued, which the old test could not tell. Evidence: a diagnostic run on macos-14 (run 38757505622), and XNU's `bsd/kern/kern_exit.c` and `bsd/kern/tty.c`.

## T2b. Starting the user's own agent

### Goal

From Litria, the person starts their installed Claude Code or Codex for the open project, as a T2a session. The agent connects to Litria's tools. Its own sign-in, settings and skills apply. When the project reopens, its conversations can be continued. Stop, closing and crashing leave nothing running. All of this is proven on Windows **without a single model call**.

### Tasks

The tasks follow D1. For route A:

- **Detection.** Find an installed `claude` and `codex` without starting a session or touching the network. Show a hint when one is missing; never install.
  - Windows: an npm `.cmd` shim needs `cmd /C`, and an emptied environment needs `SystemRoot` and `COMSPEC`. Language-server spawning hit both.
- **Start.** Run the agent as a T2a session for the project, as the session's own process, not typed into a shell (so the token never reaches shell history). Add Litria's MCP server for that session only: `claude --mcp-config`, and `codex -c mcp_servers.<name>…`. Never edit the person's own config files.
- **Environment** per D3.
- **Naming** per §3: "Claude Agent" or "runs Claude Code"; no "GPT" or OpenAI names in Litria's own labels.
- **Lifecycle** (brief §6, T2a): the session's Job Object (Windows) or process group (Unix) owns the agent and its descendants, including the helper and the person's other MCP servers. Closing its tab or the drawer hides it and it keeps working. Ending it, switching the project and closing the window end them. Never touch an agent session Litria did not start.
- **Continue after the project reopens.** Litria records, per project, each agent conversation it started: the agent, the conversation's id, a title and when it ran. Never its content: the conversation stays the agent's own.
  - Claude Code takes an id at start (`--session-id`). How Litria learns a Codex conversation's id is settled with evidence (Codex records its own; `codex resume` takes an id).
  - When the project opens, an inline notice offers to continue them (the W4b reopen notice is the model). Continuing runs the agent's own resume (`claude --resume <id>`, `codex resume <id>`) with Litria's tools added again, and leaves it idle.
  - Checked 2026-10-14 against the installed versions (Claude Code 2.1.185, Codex 0.162): both have the flags above, and Codex filters its resume list to the current folder.
  - Text typed but not sent when the project closed is not recoverable. The notice does not claim otherwise.
- **Version record.** The `claude` and `codex` versions qualified, written down (dependency change policy). Litria does not pin the person's install, but it states what was tested.

### Tests

**Keyless pass on Windows** (live, debug build, scratch project). Each agent gets an empty settings folder, a scratch `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, holding one test skill and **no sign-in**:

1. The agent starts from Litria and is idle: no prompt is sent.
2. Litria's side logs a real `initialize` and `tools/list` from the agent's helper.
3. The agent's own screen shows Litria's tools next to its own, if it has a local view that needs no model call (candidates: `/mcp`, `claude mcp list`). Each candidate is checked; one that needs a model call or a sign-in moves this check to T4.
4. The test skill is visible to the agent, by the same rule.
5. Signed out, the agent reports that sign-in is needed, and Litria's terminal shows it plainly.
6. Closing the agent's tab or the drawer leaves it running (T2a).
7. Ending the session, switching the project, closing the window, and killing the Litria process each leave no agent, helper or MCP child running (process list before and after). The agent's own interrupt stops its turn without ending it.
8. A `claude` session started outside Litria survives all of the above.
9. After the project reopens, the notice lists the conversations, and continuing one starts the agent's resume with Litria's tools listed. Whether resuming sends anything to the model is checked here if it can be seen without a sign-in, and in T4 otherwise.

### Acceptance

Standard checks pass. The keyless pass is recorded with the versions tested. Any check that could not run without a model call is listed and carried to T4, not marked passed.

## T3. Files changed outside Litria

### Goal

When another program changes a project file on disk, Litria notices. A file open with no unsaved changes reloads. A file with unsaved changes keeps both versions and asks. Saving never silently overwrites a newer version on disk.

### Why this is in track T

The agent's own file tools write straight to disk, and the owner ruled they are never turned off. On 2026-10-14 a search found that Litria watches no files and that saving checks nothing on disk:
- no file watcher, focus refresh or "changed on disk" handling in `src/` or `src-tauri/src/`;
- `saveCoordinator.saveOneTab` writes the tab's text without comparing the disk version.

So, untested so far: an agent edits a file that is open with unsaved changes, the person saves, and the agent's edit is gone. This affects any outside editor, not only agents. The brief (§8, §10 "native edit coexistence") makes this a gate before agents may edit natively.

### Tasks

- **Reproduce on `main` first**, with an outside write to an open clean file and to an open dirty file, then a save (as W1a reproduced its defects before fixing them).
- **Detect.** Settle with evidence: a file watcher (a new crate, so a dependency decision) or polling the open files. Focus-only checks are not enough: the person may be watching the agent inside Litria, so Litria never loses focus.
- **Clean tab:** reload from disk; the editor, syntax and graph follow (the existing re-index path).
- **Dirty tab:** keep both versions and offer a choice inline (a pill, never a modal). Neither version is lost.
- **Save:** check the disk version the tab was based on before writing. If it changed, do not overwrite; show the same choice. W3 deferred "replace if the disk revision matches" because nothing needed it yet. This save is the consumer it was waiting for.
- **Created, renamed and deleted files** reach the file tree and the graph.

### Tests

- The reproduction, now fixed.
- Outside writes during typing and during a save in flight.
- A rename and a delete by another program while the file is open.
- An outside write to a file the disclosure policy withholds (no content leaks into Litria's UI that the policy would deny an agent).

### Acceptance

Standard checks pass. The adversarial check (check-then-write saving) is recorded. A live pass with a script standing in for the agent's writes.

## T4. Real tasks, first release

### Goal

Short real tasks with each agent, on the owner's own API key, prove the whole path. Track T's first user-facing release follows.

### Tasks

- Re-check §3's provider pages. Record any change.
- Owner-run tasks, a handful per agent, on a scratch project:
  - reads through Litria's tools (`litria_project_context`, `litria_graph_query`, `litria_files_read`);
  - an edit through `litria_changes_prepare` and `litria_changes_apply`, approved in the agent's own prompt;
  - an edit through the agent's own file tool, with the file open and unsaved in Litria (T3);
  - the person's Stop during a streaming turn. The provider may still bill for the request already sent (ADR-031 §4); Litria never says otherwise;
  - closing Litria mid-apply, then reopening: the W4b notice names the files and nothing replays.
- Anything T2b carried here because it needed a model call.
- The posture note for users: what Litria's tools can and cannot guarantee next to the agent's own tools (brief §8: native edits do not get Litria's revision checks or receipts).

### Acceptance

Every task recorded with the agent versions and outcomes. Release per the [release policy](../../../Agents/docs/release-policy.md).

## T5. macOS and Linux

### Goal

T2a's sessions, T2b's keyless pass and T4's tasks on macOS and Linux.

### Tasks

- The socket's permissions, process-group cleanup and parent-death cleanup on each OS (brief §6: a frontend callback alone does not cover crashes).
- Windows-only results stated as such until this passes.

## 6. Carry-over ledger

Everything earlier work handed to track T, and where it lands:

| From | Item | Lands in |
|---|---|---|
| P6 | A real transport (the adapter is test-only) | T1a |
| P6 | SDK or thin serializer, re-opened with criteria | T1a |
| P6 | Bound the raw message before parsing | T1b |
| P6 | Duplicate JSON keys | T1b |
| P6 | `tools/list` filtered by grant | D5, T1a |
| P1/contracts | Real principals (`Principal` is `Test` or `Dev`) | T1b |
| Brief §4 | Grants from project grant records | D4, T1b |
| W4 | Re-binding a reconnecting agent to its receipts | T1b, D6 |
| W4a | Operation ownership is the in-process principal | T1b |
| W2 | Review surface; `PersonReview` off until one exists | Deferred (§1). The agent's own prompt is the review |
| contracts/error.rs | `Cancelled`, `ShuttingDown` | T1b |
| P3 | Small-context budget measurement | Deferred with the local-model route |
| Release builds | Project API code allowed as dead code until a transport exists | T1b |
| Brief §10 | Runtime and platform qualification | T2b, T5 |
| Brief §10 | Cloud and local routes | T4 (cloud); local deferred |
| Brief §10 | Authentication and persistence | T2b (the agent owns it, D2) |
| Brief §10 | Foreground lifecycle | T2a, T2b, T4, T5 |
| Brief §10 | Native edit coexistence | T3 |
| Brief §10 | Product usability | T2a, T2b, T4 |
| Owner, 2026-10-14 | A terminal session ends when its tab or the drawer closes, losing prompts and context | T2a |
| Owner, 2026-10-14 | Conversations must not be lost when the project closes | T2b (continue on reopen) |
| ADR-019 | `terminalDrawerClose` preference | T2a (retired) |

## 7. Residual risks

- **Same-user programs.** Another program running as the same user can read the token from the agent's process and connect. The brief (§9) puts same-user malware outside the guarantee. Short-lived tokens bound to one session limit the window.
- **The agent's own tools are not Litria's.** Native edits get no revision check, receipt or undo from Litria (ADR-031 §5). T3 protects the person's unsaved work and newer disk versions. It does not make native edits reviewable.
- **Providers move.** Claude Code and Codex change fast, and OpenAI calls `app-server` experimental. Qualification records versions, and §3 is re-checked before release.
- **In-flight billing.** Stopping cannot recall a request already sent to the provider.
