# Rust Module Ownership

First written 2026-02-21 (Phase 4). **Refreshed 2026-10-01 (P4 gate item 8):** every module in `src-tauri/src` is now listed. Scope: `src-tauri/src/*`.

The command inventory, with each command's frontend caller, is in [rust-command-contracts.md](rust-command-contracts.md). The frontend domains that own the callers are in [Orchestration.md](Orchestration.md) §2.

## Module Responsibilities

**Composition and command adapters**
- `lib.rs`
  - Composition only: plugin registration, the Tauri `setup` hook (bundled runtime extraction, crash hooks, window decorations), and the `invoke_handler` list.
  - Must not contain filesystem or path business logic.
- `main.rs`: the binary entry point. On Windows release builds it sets the GUI subsystem, so no console window opens.
- `commands.rs`
  - The Tauri command adapters for project files, the terminal, language servers, the New Project wizard, crash logs, build logs and the clipboard, plus the debug-only Project API commands.
  - Thin wrappers that delegate to the owning module.
  - Some modules register their own commands instead: `db/commands.rs`, `preferences.rs`, `platform.rs`.

**Errors and shared types**
- `errors.rs`
  - The typed command error (`CommandError`: `category`, `code`, `message`) and the helpers that classify raw errors.
  - The Project API's contract errors are separate: `contracts/error.rs`.
- `project_types.rs`: serializable payloads for the project-file commands.

**Project files**
- `project_ops.rs`
  - The project-file operations behind the file commands: read, write, list, move, create a directory, delete, remove an empty directory.
  - Converts failures into `CommandError`.
  - Uses `path_guard`, `write_ops` and `project_tree`.
  - Moves fall back to copy-then-delete when the destination is on another device (`io::ErrorKind::CrossesDevices`).
- `path_guard.rs`
  - Root and path validation, and symlink-safe boundary checks.
  - `resolve_entry_for_mutation` makes delete and move act on a link, never on its target (PR #88).
  - The typed resolvers are used by the Project API.
- `write_ops.rs`: atomic writes (temp file, then rename) under the single-writer lock.
- `project_tree.rs`: the project tree listing (`list_project_tree`), relative-path normalization, and the `IGNORED_DIRS` list that the Project API reuses as its unindexed class.

**Terminal**
- `terminal_session_manager.rs`: session lifecycle per project (start, spawn, input, resize, end, teardown).
- `terminal_pty.rs`: the PTY read loop, the ConPTY startup handshake, and teardown with timeouts.
- `terminal_policy.rs`: the execution boundary for terminals (the allowed shells and the preferred one), and the environment allowlist and forced variables.
- `terminal_ipc_bridge.rs`: the terminal events emitted to the frontend.
- `terminal_types.rs`: terminal payload types.
- `process_control.rs`: deadlines and cancellation for scaffold subprocesses (ADR-028 §8). Every scaffold subprocess runs under one.

**New Project wizard**
- `scaffold_types.rs`: the wizard's configuration and event types.
- `scaffold_recipes.rs`: the Rust read side of `src/scaffold/recipes.json`, compiled in with `include_str!` (ADR-028 §1).
- `scaffold_runner.rs`: translates a scaffold configuration into CLI commands, runs them in sequence, and streams progress events.
- `python_scaffold.rs`: the offline Python project blueprint (ADR-020 Slice 3).
- `python_probe.rs`: Python interpreter discovery (ADR-020 Slice 1).
- `blank_project.rs`: the stack-agnostic files every new project gets (the Blank template).
- `creation_ownership.rs`: creation markers and the verified manifest (ADR-028 §7). A new-project write proves ownership before it tolerates existing content.
- `execution_policy.rs`: validates the project id, root and executable before a scaffold runs anything.
- `build_log.rs`: build log files (one JSONL per scaffold run) and their retention.

**Persistence**
- `db/`
  - The SQLite adapter (ADR-026): `mod.rs` holds the open flags, integrity and writability probes, and result-code mapping.
  - `schema.rs`: the workspace and app schemas.
  - `app_db.rs`: the app database (recent projects, project names, per-project preference file names, and the legacy preference rows).
  - `grid.rs`: the workspace grid.
  - `types.rs`: database types.
  - `commands.rs`: the `db_*` commands.
  - Every workspace command is fenced by the workspace epoch (ADR-032). `db_check_project_path` is the read-only preflight that opening a project runs before teardown (PR #94).
- `preferences.rs`
  - The preferences store (ADR-019): global and per-project TOML files, and the commands that load and save them.
  - `global_text` reads one key without side effects. The Project API policy uses it for `apiWithheldPaths`.

**Language servers**
- `lsp/`
  - The language-server host:
    - `registry.rs`: the curated server registry;
    - `download.rs`: verified downloads (ADR-005);
    - `resolver.rs`: bundled, managed and system resolution;
    - `session.rs` and `transport.rs`: sessions and JSON-RPC over stdio;
    - `ipc_bridge.rs`: events to the frontend;
    - `packs/`: per-language packs;
    - `types.rs`: shared types.
- `bundled_runtime.rs`: extracts the bundled Node.js runtime on first run.

**Crash logs**
- `crash/`: the local crash-log system (B5).
  - `hook.rs`: the hardened panic hook.
  - `webview_watch.rs`: the WebView2 process-failure watcher (Windows).
  - `marker.rs`: the per-instance dirty marker.
  - `record.rs`: the record writer.
  - `scan.rs`: the startup scan.

**Platform**
- `platform.rs`: reports the OS to the frontend (`get_platform_config`), and provides `hidden_command`. Every spawned process uses it so no console window flashes on Windows; a guard enforces this.

**Project API and contracts**
- `contracts/` *(added 2026-09-30, Project API build plan P1)*
  - ADR-033 contract types and machinery:
    - the three-layer inbound boundary;
    - the typed operation catalog and dispatcher;
    - call contexts and contract errors;
    - one submodule per contract family (`project_api/`, and `project_api_bridge/` since P2, whose direction is reversed: Rust emits its requests and reads its replies through the same boundary).
  - Contract types derive `JsonSchema` only under `cfg(test)`. The schema generation, drift, fixture and MCP-proof modules are test-only.
  - Committed artifacts live in `src-tauri/contracts/<family>/v<N>/`.
- `project_api/` *(added 2026-09-30, Project API build plan P1)*
  - The ADR-031 Project API service behind the `project-api` contract family. Design: `docs/plans/agent-integration/brief-project-api-contract.md`.
  - It calls `path_guard` and `db` directly, never the Tauri command adapters. Its only command adapter today is the debug-only `project_api_dev_call`.
  - `policy.rs`: the disclosure policy (denied and unindexed classes, environment templates, and the user's withheld paths from the `apiWithheldPaths` preference).
  - `paths.rs`: API path syntax.
  - `reader.rs`: bounded reads that check the opened handle.
  - `workspace.rs`: the workspace fence.
  - `files_read.rs`: `litria_files_read`.
  - `bridge.rs` *(P2)*: the owner bridge client (attach generations, the pending-request map, deadlines and the reply hand-off). Its debug-only commands are `project_api_bridge_attach`, `project_api_bridge_detach` and `project_api_bridge_reply`; requests go to the main window as `project-api://bridge-request`.
  - *(P3)* `context.rs`: `litria_project_context`.
  - *(P3)* `search.rs`: `litria_files_search` (buffer coverage, path-ordered merge, bounds, and the concurrent-search ceiling).
  - *(P3)* `walk.rs`: the search walker. It walks in path order, never follows links, applies the policy by name, and bounds the entries it examines. *(Since P4 gate item 1)* it also honours `.gitignore` files through the `ignore` crate's matcher.

**Other**
- `quote_pool.rs`: picks one quote from `quotes.json` for a blank project's generated README.

## Extension Rules
1. Add a new Tauri command to the module that owns its behaviour. Use `commands.rs` for command families without their own module; database, preferences and platform commands live in their modules. Keep the adapter thin.
2. Put behaviour in the owning module first (`project_ops.rs` for project files), then expose it through the adapter.
3. Reuse `path_guard` for any project-scoped path input. For delete or move, use `resolve_entry_for_mutation`, so a link is acted on, never its target.
4. Use `write_ops` for any write that changes on-disk project state.
5. Add or adjust the typed error mapping in `errors.rs` when introducing a new failure mode. Project API failures use `contracts/error.rs`.
6. A command touching a workspace database takes the workspace epoch (ADR-032). The frontend calls it through `dbStorage.invokeDb`, which the db-chokepoint guard enforces.
7. Spawn processes only through `platform::hidden_command` (a guard enforces this).
8. Register every new command in [rust-command-contracts.md](rust-command-contracts.md). A new command that touches the filesystem, a process or the network needs a security review (security policy Rule 1).
9. Add tests in the owning module, and adapter tests when command mapping changes.
