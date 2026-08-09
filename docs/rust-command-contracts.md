# Rust Command Contracts (Phase 0-3)

Date: 2026-02-21
Source: `src-tauri/src/lib.rs`, `src/project/storage.js`, `src/app/useProjectLaunch.js`

## Domain Ownership
- Owning JS domain: `ProjectDomain` via `src/project/storage.js`
- Launch bootstrap ownership: `src/app/useProjectLaunch.js` (`create_project_instance`)
- Unowned commands: none

## Command Inventory
| Command | Rust Signature | JS Caller | Risk | Notes |
|---|---|---|---|---|
| `greet` | `fn greet(name: &str) -> String` | none (debug/sample) | read | Not part of project IO flow. |
| `create_project_instance` | `fn create_project_instance(name, root_path, instance_id) -> CommandResult<ProjectInstancePayload>` | `src/app/useProjectLaunch.js` | write | Creates root dir and manifest. |
| `read_project_manifest` | `fn read_project_manifest(root_path) -> CommandResult<String>` | `src/project/storage.js` | read | Reads `litria.project.json`. |
| `write_project_manifest` | `fn write_project_manifest(root_path, manifest_json) -> CommandResult<()>` | `src/project/storage.js` | write | Writes `litria.project.json`. |
| `read_project_file` | `fn read_project_file(root_path, relative_path) -> CommandResult<String>` | `src/project/storage.js` | read | Reads file under project root. |
| `write_project_file` | `fn write_project_file(root_path, relative_path, contents) -> CommandResult<()>` | `src/project/storage.js` | write | Writes file under project root. |
| `list_project_tree` | `fn list_project_tree(root_path) -> CommandResult<Vec<ProjectTreeEntry>>` | `src/project/storage.js` | read | Lists project tree entries. |
| `move_project_path` | `fn move_project_path(root_path, from_relative, to_relative) -> CommandResult<()>` | `src/project/storage.js` | mixed | Rename/move path under root. |
| `delete_project_path` | `fn delete_project_path(root_path, relative_path) -> CommandResult<()>` | `src/project/storage.js` | delete | Deletes file or directory under root. |
| `read_external_file` | `fn read_external_file(file_path) -> CommandResult<String>` | `src/project/storage.js` | read | Reads user-selected external file path. |

## Contract Notes
- Rust commands now emit typed errors via `CommandError`:
  - `category`: `AccessDenied | InvalidPath | Conflict | NotFound | Internal`
  - `code`: stable diagnostic code string (safe to log/filter)
  - `message`: safe user-facing text
- Storage adapter preserves return-shape compatibility (`null`/`false`) while retaining the latest typed error for UI/domain handling.
- Write behavior policy: mutating commands execute under a single-process write mutex and use atomic file replacement for manifest/project file writes.
- Critical manifest writes maintain a rollback copy at `litria.project.json.bak`.
- Command adapter and module boundaries:
  - Adapter layer: `src-tauri/src/commands.rs`
  - Operation layer: `src-tauri/src/project_ops.rs`
  - Entry composition: `src-tauri/src/lib.rs`
- Any future request/response/error shape changes must update:
  - Rust command
  - `src/project/storage.js`
  - `src/project/projectDomain.js` consumers
  - tests under `test/domains`
