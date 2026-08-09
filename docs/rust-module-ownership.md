# Rust Module Ownership (Phase 4)

Date: 2026-02-21
Scope: `src-tauri/src/*`

## Module Responsibilities
- `lib.rs`
  - Composition only: plugin registration + `invoke_handler` wiring.
  - Must not contain filesystem/path business logic.
- `commands.rs`
  - Tauri command adapter boundary (`#[tauri::command]` functions).
  - Must be thin wrappers that delegate to `project_ops`.
- `project_ops.rs`
  - IO/process operation orchestration for project commands.
  - Converts internal failures into typed `CommandError`.
  - Uses `path_guard`, `write_ops`, and `project_tree`.
- `errors.rs`
  - Typed command error contract (`category`, `code`, `message`).
  - Central classification helpers and conversion from raw errors.
- `path_guard.rs`
  - Root/path validation and symlink-safe boundary checks.
- `write_ops.rs`
  - Atomic write behavior, manifest backup, and single-writer lock policy.
- `project_tree.rs`
  - Project tree traversal and relative path normalization.
- `project_types.rs`
  - Shared serializable payload structs for command responses.

## Extension Rules
1. Add new Tauri commands in `commands.rs` and keep wrappers thin.
2. Add behavior in `project_ops.rs` first, then expose via command adapter.
3. Reuse `path_guard` for any project-scoped path inputs.
4. Use `write_ops` for any write that changes on-disk project state.
5. Add/adjust typed error mapping in `errors.rs` when introducing new failure modes.
6. Add tests in the owning module (unit), and adapter tests when command mapping changes.
