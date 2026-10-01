# Rust Command Contracts

First written 2026-02-21 (Phase 0-3). **Refreshed 2026-10-01 (P4 gate item 8):** the inventory below was generated from the `invoke_handler` list in `src-tauri/src/lib.rs`, and each frontend caller was found by searching `src/` for the command's name.

The 2026-02-21 inventory listed commands removed since: `create_project_instance`, `read_project_manifest`, `write_project_manifest` and `read_external_file`. The manifest tier closed when the workspace moved to SQLite (ADR-015 erratum, 2026-08-01). Module responsibilities are in [rust-module-ownership.md](rust-module-ownership.md).

## Command inventory

88 commands are registered; 5 of them exist only in debug builds.

**No frontend caller.** Every registered command can be invoked from the webview, so these are surface with no current purpose. Whether to wire or remove each one is an open product question; they are recorded here, not changed:
- `greet`: the Tauri template's sample command.
- `lsp_cancel_install`: nothing in `src/` calls it.
- `check_scaffold_prerequisites`: nothing in `src/` calls it.
- `build_log_dir`: nothing in `src/` calls it (the log viewer uses `build_log_list` and `build_log_read`).

The debug-only `crash_test_panic` and `project_api_dev_call` are driven by hand, from devtools or CDP.

### Project files and dialogs

| Command | Defined in | Frontend caller | Notes |
|---|---|---|---|
| `greet` | `src-tauri/src/commands.rs` | — | **no frontend caller** |
| `read_project_file` | `src-tauri/src/commands.rs` | `src/project/storage.js` |  |
| `open_file_dialog` | `src-tauri/src/commands.rs` | `src/project/storage.js` |  |
| `write_project_file` | `src-tauri/src/commands.rs` | `src/project/storage.js` |  |
| `list_project_tree` | `src-tauri/src/commands.rs` | `src/project/storage.js` |  |
| `move_project_path` | `src-tauri/src/commands.rs` | `src/project/storage.js` |  |
| `create_project_directory` | `src-tauri/src/commands.rs` | `src/project/storage.js` |  |
| `delete_project_path` | `src-tauri/src/commands.rs` | `src/project/storage.js` |  |
| `remove_empty_directory` | `src-tauri/src/commands.rs` | `src/project/storage.js` |  |

### Terminal

| Command | Defined in | Frontend caller | Notes |
|---|---|---|---|
| `terminal_session_start` | `src-tauri/src/commands.rs` | `src/terminal/terminalStorage.js` |  |
| `terminal_spawn` | `src-tauri/src/commands.rs` | `src/terminal/terminalStorage.js` |  |
| `terminal_input` | `src-tauri/src/commands.rs` | `src/terminal/terminalStorage.js` |  |
| `terminal_resize` | `src-tauri/src/commands.rs` | `src/terminal/terminalStorage.js` |  |
| `terminal_session_end` | `src-tauri/src/commands.rs` | `src/terminal/terminalStorage.js` |  |
| `terminal_pause` | `src-tauri/src/commands.rs` | `src/terminal/terminalStorage.js` |  |
| `terminal_resume` | `src-tauri/src/commands.rs` | `src/terminal/terminalStorage.js` |  |
| `terminal_teardown_all` | `src-tauri/src/commands.rs` | `src/terminal/terminalStorage.js` |  |

### Language servers

| Command | Defined in | Frontend caller | Notes |
|---|---|---|---|
| `lsp_get_registry` | `src-tauri/src/commands.rs` | `src/app/useManagedServerOffers.js` |  |
| `lsp_install_server` | `src-tauri/src/commands.rs` | `src/app/useManagedServerOffers.js`, `src/lsp/lspClient.js` |  |
| `lsp_cancel_install` | `src-tauri/src/commands.rs` | — | **no frontend caller** |
| `lsp_server_inventory` | `src-tauri/src/commands.rs` | `src/lsp/lspClient.js` |  |
| `lsp_uninstall_server` | `src-tauri/src/commands.rs` | `src/lsp/lspClient.js` |  |
| `lsp_reverify_server` | `src-tauri/src/commands.rs` | `src/lsp/lspClient.js` |  |
| `lsp_detect_prerequisites` | `src-tauri/src/commands.rs` | `src/app/useGoToolchainOffer.js`, `src/lsp/lspClient.js` |  |
| `lsp_start_session` | `src-tauri/src/commands.rs` | `src/lsp/lspClient.js` |  |
| `lsp_stop_session` | `src-tauri/src/commands.rs` | `src/lsp/lspClient.js` |  |
| `lsp_request` | `src-tauri/src/commands.rs` | `src/lsp/lspClient.js` |  |
| `lsp_notify` | `src-tauri/src/commands.rs` | `src/lsp/lspClient.js` |  |
| `detect_python_interpreters` | `src-tauri/src/commands.rs` | `src/lsp/lspClient.js` |  |

### New Project wizard (scaffold)

| Command | Defined in | Frontend caller | Notes |
|---|---|---|---|
| `check_scaffold_prerequisites` | `src-tauri/src/commands.rs` | — | **no frontend caller** |
| `scaffold_project` | `src-tauri/src/commands.rs` | `src/components/NewProjectWizard.jsx` |  |
| `create_blank_project` | `src-tauri/src/commands.rs` | `src/components/NewProjectWizard.jsx` |  |
| `scaffold_python_project` | `src-tauri/src/commands.rs` | `src/components/NewProjectWizard.jsx` |  |
| `cancel_scaffold` | `src-tauri/src/commands.rs` | `src/components/NewProjectWizard.jsx` |  |

### Platform

| Command | Defined in | Frontend caller | Notes |
|---|---|---|---|
| `get_platform_config` | `src-tauri/src/platform.rs` | `src/platform/usePlatformConfig.jsx` |  |

### Workspace lifecycle (opens or closes the workspace; mints or ends the epoch; takes none)

| Command | Defined in | Frontend caller | Notes |
|---|---|---|---|
| `db_bootstrap_project` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_check_project_path` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_open_project` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_close_project` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |

### Workspace database (each call carries the workspace epoch and is refused for any other)

| Command | Defined in | Frontend caller | Notes |
|---|---|---|---|
| `db_create_piece` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_create_pieces_batch` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_batch_move_pieces` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_update_piece` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_delete_piece` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_create_group` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_update_group` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_delete_group` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_add_piece_to_group` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_remove_piece_from_group` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_create_connection` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_save_editor_state` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_load_editor_state` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_save_viewport` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_save_workspace_grid` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_add_hidden_path` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_remove_hidden_path` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |

### App database (app-scoped; no workspace epoch)

| Command | Defined in | Frontend caller | Notes |
|---|---|---|---|
| `db_list_recent_projects` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_register_project` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_remove_project` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_pin_project` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_save_preference` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |
| `db_load_preferences` | `src-tauri/src/db/commands.rs` | `src/project/dbStorage.js` |  |

### Preferences

| Command | Defined in | Frontend caller | Notes |
|---|---|---|---|
| `prefs_load_global` | `src-tauri/src/preferences.rs` | `src/preferences/preferencesStore.js` |  |
| `prefs_save_global` | `src-tauri/src/preferences.rs` | `src/preferences/preferencesStore.js` |  |
| `prefs_load_project` | `src-tauri/src/preferences.rs` | `src/preferences/preferencesStore.js` |  |
| `prefs_save_project` | `src-tauri/src/preferences.rs` | `src/preferences/preferencesStore.js` |  |
| `prefs_clear_project` | `src-tauri/src/preferences.rs` | `src/preferences/preferencesStore.js` |  |

### Crash logs

| Command | Defined in | Frontend caller | Notes |
|---|---|---|---|
| `crash_startup_scan` | `src-tauri/src/commands.rs` | `src/crash/useCrashBoot.js` |  |
| `crash_write_js_record` | `src-tauri/src/commands.rs` | `src/crash/errorCapture.js` |  |
| `crash_append_breadcrumbs` | `src-tauri/src/commands.rs` | `src/crash/breadcrumbs.js` |  |
| `crash_mark_phase` | `src-tauri/src/commands.rs` | `src/crash/useCrashBoot.js` |  |
| `crash_mark_clean` | `src-tauri/src/commands.rs` | `src/crash/shutdown.js` |  |
| `crash_mark_seen` | `src-tauri/src/commands.rs` | `src/crash/CrashNoticeBanner.jsx` |  |
| `crash_open_logs_dir` | `src-tauri/src/commands.rs` | `src/crash/CrashBoundary.jsx`, `src/crash/CrashNoticeBanner.jsx` |  |
| `crash_open_report_url` | `src-tauri/src/commands.rs` | `src/crash/CrashBoundary.jsx`, `src/crash/CrashNoticeBanner.jsx` |  |
| `crash_home_dir` | `src-tauri/src/commands.rs` | `src/crash/CrashBoundary.jsx`, `src/crash/CrashNoticeBanner.jsx` |  |
| `crash_test_panic` | `src-tauri/src/commands.rs` | — | `#[cfg(debug_assertions)]`; **no frontend caller** |
| `crash_log_list` | `src-tauri/src/commands.rs` | `src/app/useBuildLogs.js` |  |
| `crash_log_read` | `src-tauri/src/commands.rs` | `src/app/useBuildLogs.js` |  |

### Project API (debug builds only until track T)

| Command | Defined in | Frontend caller | Notes |
|---|---|---|---|
| `project_api_dev_call` | `src-tauri/src/commands.rs` | — | `#[cfg(debug_assertions)]`; **no frontend caller** |
| `project_api_bridge_attach` | `src-tauri/src/commands.rs` | `src/app/useProjectApiBridge.js` | `#[cfg(debug_assertions)]` |
| `project_api_bridge_detach` | `src-tauri/src/commands.rs` | `src/app/useProjectApiBridge.js` | `#[cfg(debug_assertions)]` |
| `project_api_bridge_reply` | `src-tauri/src/commands.rs` | `src/app/useProjectApiBridge.js` | `#[cfg(debug_assertions)]` |

### Build logs and clipboard

| Command | Defined in | Frontend caller | Notes |
|---|---|---|---|
| `build_log_write` | `src-tauri/src/commands.rs` | `src/app/useBuildLogs.js` |  |
| `build_log_list` | `src-tauri/src/commands.rs` | `src/app/useBuildLogs.js` |  |
| `build_log_read` | `src-tauri/src/commands.rs` | `src/app/useBuildLogs.js` |  |
| `build_log_dir` | `src-tauri/src/commands.rs` | — | **no frontend caller** |
| `copy_to_clipboard` | `src-tauri/src/commands.rs` | `src/app/useBuildLogs.js` |  |

## Contract notes

**Errors.** Tauri commands return the typed `CommandError` (`src-tauri/src/errors.rs`):
- `category`: `AccessDenied | InvalidPath | Conflict | NotFound | Internal`;
- `code`: a stable diagnostic string, safe to log and filter;
- `message`: safe user-facing text.

The Project API's operations use their own contract errors (`src-tauri/src/contracts/error.rs`, ADR-033), not `CommandError`.

**Storage adapters.** `src/project/storage.js` keeps its return shapes (`null` / `false` on failure) and records the latest typed error for the UI. Every `db_*` command goes through `src/project/dbStorage.js` `invokeDb`, which stamps the workspace epoch (ADR-032). The db-chokepoint guard enforces that.

**Writes.** Mutating project-file commands run under the single-writer lock and replace files atomically (`write_ops.rs`).
- Delete and move act on a link itself, never on its target (`path_guard::resolve_entry_for_mutation`, PR #88).
- A move across devices falls back to copy-then-delete.
- *(Obsolete since 2026-08-01: the manifest backup `litria.project.json.bak` went with the manifest tier.)*

**Changing a command.** A change to a command's request, response or error shape updates:
- the Rust command;
- its frontend adapter (`storage.js`, `dbStorage.js`, `terminalStorage.js`, `lspClient.js`, `preferencesStore.js`, …);
- the owning domain's consumers;
- the tests under `test/domains`;
- this inventory.

A new command that touches the filesystem, a process or the network needs a security review (security policy Rule 1).
