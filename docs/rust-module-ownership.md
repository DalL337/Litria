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
- `contracts/` *(added 2026-09-30, Project API build plan P1)*
  - ADR-033 contract types and machinery: the three-layer inbound boundary, the
    typed operation catalog and dispatcher, call contexts, contract errors, and
    one submodule per contract family (`project_api/`; `project_api_bridge/`
    since P2, whose direction is reversed: Rust emits its requests and reads
    its replies through the same boundary).
  - Contract types derive `JsonSchema` only under `cfg(test)`; schema
    generation, drift, fixture and MCP-proof modules are test-only. Committed
    artifacts live in `src-tauri/contracts/<family>/v<N>/`.
- `project_api/` *(added 2026-09-30, Project API build plan P1)*
  - The ADR-031 Project API service behind the `project-api` contract family:
    the workspace fence, API path validation, the disclosure policy, bounded
    reads. Design: `docs/plans/agent-integration/brief-project-api-contract.md`.
  - Calls `path_guard` and `db` directly, never the Tauri command adapters.
    Its only command adapter today is the debug-only `project_api_dev_call`.
  - `bridge.rs` *(P2)*: the owner bridge client — attach generations, the
    pending-request map, deadlines and the reply hand-off. Its debug-only
    commands are `project_api_bridge_attach`, `project_api_bridge_detach` and
    `project_api_bridge_reply`; requests go to the main window as
    `project-api://bridge-request`.

> **Note (2026-09-30):** this document predates the `db`, `lsp`, `crash`,
> `preferences` and `platform` modules, which define their commands in their
> own files and are registered directly in `lib.rs`. Only the entries above
> were refreshed; a full refresh is outstanding.

## Extension Rules
1. Add new Tauri commands in `commands.rs` and keep wrappers thin.
2. Add behavior in `project_ops.rs` first, then expose via command adapter.
3. Reuse `path_guard` for any project-scoped path inputs.
4. Use `write_ops` for any write that changes on-disk project state.
5. Add/adjust typed error mapping in `errors.rs` when introducing new failure modes.
6. Add tests in the owning module (unit), and adapter tests when command mapping changes.
