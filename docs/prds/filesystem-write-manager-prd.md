# Product Requirements Document: Filesystem Write Manager

**PRD-FSM-001 | Version 1.1 | March 20, 2026**

| Field | Value |
|---|---|
| Document ID | PRD-FSM-001 |
| Version | 1.1 |
| Date | March 20, 2026 |
| Status | Implemented — see the 2026-07-25 status addendum below |
| Project | Litria |
| Component | Filesystem Write Manager (centralized mutation service) |
| Tech Stack | React (frontend service), Tauri invoke wrappers (Rust backend) |
| Prerequisites | ADR-010 (cross-platform constraints), RFC `docs/rfcs/filesystem-write-manager.md` |

---

> **Status addendum (2026-07-25):** Implemented. The manager was built
> 2026-03-20 (`3b997bc` — the same day as this PRD; the §1.2 trigger fired
> immediately when canvas piece-to-group drag landed as the 4th call site),
> and this document's "do not build" status went stale on day one. Call-site
> migration completed 2026-07-25: canvas nest/merge (PR #187, via
> `groupStructureOps`), the group-menu paths — create-folder-group,
> promote-to-folder, rename-group — via the new **`moveOrWriteFile`**
> move-or-materialize operation (PR #190; an addition beyond this spec for
> never-written canvas pieces), and §3.3 reconciliation delivered
> in-pipeline with an atomic `groupDomain.applyFsSyncPlan` command
> (PR #189 — also fixes mid-tick group-state staleness; the
> `useGroupFolderReconciliation` safety net is now the backstop, as
> designed). `remove_empty_directory` (§3.5) shipped with the nest/merge
> feature. Interaction-grammar changes on the nest/merge surface are
> recorded in ADR-013's 2026-07-25 addendum. **Still deferred:**
> ~~cross-device EXDEV fallback (ADR-010 owed)~~ (delivered 2026-07-28 —
> see the §3.5 delivery addendum), conflict resolution, filesystem-undo
> beyond delete (delete-journal restore shipped), trash (§9).

> **Status addendum (2026-07-28 — write-pipeline compliance pass):** the
> remaining raw `writeProjectFile` call sites now route through the manager's
> `writeFile` (which gained `{ notify, skipScaffold }` opts so content-owning
> callers keep their exact prior semantics): scaffold new-file/new-folder
> (`useScaffoldOperations`), piece creation (`usePieceUiActions` — which also
> stops creating a SQLite row + canvas piece when the disk write fails, a
> defect the fire-and-forget call hid), editor tab saves
> (`useProjectPersistence`), and the syntax adapter's closed-file writes
> (injected via the identity-stable `useManagerFileWriter`). One **ratified
> exception**: `useUntitledSaveAs` writes through the raw storage wrapper by
> design — it bootstraps the project root itself, so no root-scoped manager
> can serve it (rationale in that hook's header). The compliance register
> lives in the manager's file header.

## 1. Purpose and Scope

### 1.1 Purpose

Define a centralized service that owns all filesystem mutations (move, rename, create, delete) within a Litria project. Every surface that modifies files on disk — canvas, scaffold, future node system — routes through this single manager rather than independently calling Tauri invoke wrappers and duplicating post-operation sync logic.

### 1.2 Trigger Condition

**Do not build until a 4th distinct call site needs filesystem operations with the same post-op sync pattern.** As of 2026-03-20, there are 3 move call sites and 2 delete call sites:

| # | Call Site | Move Ops | Delete Ops |
|---|---|---|---|
| 1 | `useScaffoldOperations.js` | moveProjectPath, rename | deleteProjectPath |
| 2 | `useGroupMenuActions.js` | moveProjectPath, writeProjectFile | deleteProjectPath |
| 3 | `handleResolveGroupDrop` (canvas nest/merge) | moveProjectPath, remove_empty_directory | — |
| 4? | Canvas piece-to-group drag (node move) | moveProjectPath | — |

When a 4th move call site or 3rd delete call site is introduced, extract the manager and migrate all existing call sites. The anticipated trigger is canvas piece-to-group drag (single piece moved between groups on the canvas), which would use `fsManager.moveFile()`.

### 1.3 Scope

- Single-project filesystem mutations (move, rename, create, delete, write)
- Post-operation sync pipelines (two distinct chains):
  - **Move pipeline**: piece filename updates, tab filename updates, group membership sync, syntax domain path updates, connection path updates, manifest persistence, scaffold refresh
  - **Delete pipeline**: piece removal from state, tab closure, connection removal, syntax domain unregistration, group membership removal, manifest persistence, scaffold refresh
- Batch operations with sequential execution and partial-failure reporting
- Platform-aware error handling (cross-device rename, file locking, permission errors)
- Future call site support: canvas piece-to-group drag (node move)

### 1.4 Out of Scope

- File watching / filesystem event subscription (separate concern)
- Cross-project file operations
- Full undo/rollback of filesystem operations (future enhancement)
- Conflict resolution (file already exists at destination)
- Binary file operations (images, compiled assets)

---

## 2. Background

### 2.1 Current State

Each call site independently performs a subset of post-operation sync steps. No single call site does all of them, and the gaps vary:

#### Move call sites

| Step | Scaffold (`handleScaffoldDrop`) | Group Menu (create group) | Canvas (nest/merge) |
|---|---|---|---|
| 1. Filesystem move | `moveProjectPath` | `moveProjectPath` | `moveProjectPath` |
| 2. Affected piece identification | `collectAffectedPieces` | manual per-piece | manual per-piece |
| 3. Piece filename update | `updatePieceFilenames` | `updatePieceFilenames` | `updatePieceFilenames` |
| 4. Tab filename update | -- missing -- | `updateTabFilename` | `updateTabFilename` |
| 5. Group membership sync | `syncGroupMembership` | -- implicit (new group) -- | `setParentGroup` / `mergeIntoGroup` |
| 6. Connection path update | -- missing -- | -- missing -- | -- missing -- |
| 7. Syntax domain update | -- missing -- | -- missing -- | -- missing -- |
| 8. Manifest persistence | -- missing -- | `updatePieceFileMap` | `updatePieceFileMap` |
| 9. Scaffold refresh | `bumpScaffoldRefresh` | `bumpScaffoldRefresh` | `bumpScaffoldRefresh` |
| 10. Error notification | -- missing -- | -- partial -- | pill notification |

#### Delete call sites

| Step | Scaffold (`handleContextDelete`) | Group Menu (`handleDeleteSelected`) |
|---|---|---|
| 1. Filesystem delete | `deleteProjectPath` (first) | `deleteProjectPath` (after state) |
| 2. Piece removal from state | `deletePieces` | `deletePieces` |
| 3. Connection removal | -- missing -- | `removeConnectionsForPieces` |
| 4. Group membership removal | `removePieces` | `removePieces` |
| 5. Tab closure | -- missing -- | -- missing -- |
| 6. Syntax domain cleanup | -- missing -- | -- missing -- |
| 7. Manifest persistence | -- missing -- | `updatePieceFileMap` |
| 8. Scaffold refresh | `bumpScaffoldRefresh` | `bumpScaffoldRefresh` |
| 9. Scaffold focus cleanup | -- missing -- | clears if focused path deleted |

**Key observations**:
- No call site performs all sync steps. The manager must be the first implementation that does.
- Delete ordering is inconsistent: scaffold deletes filesystem-first, group menu deletes state-first. The manager standardizes on filesystem-first (consistent with move pipeline).
- Connection cleanup and syntax domain unregistration are missing from every move path and most delete paths. These are latent bugs — moved/deleted files leave stale connection references and orphaned syntax entries.
- Tab closure on delete is missing everywhere. Deleting a file while it's open in the editor leaves a tab pointing to a non-existent file.

This is manageable at the current call site count, but the gaps compound with each new call site. The manager resolves all of them.

### 2.2 Known Gap: Group Reconciliation

After a merge operation deletes a group and its folder, recreating that folder (via scaffold or OS file explorer) does not recreate the group in state. `syncGroupMembership` can move pieces between existing groups but cannot create new groups from folders. The manager's reconciliation layer resolves this.

### 2.3 Cross-Platform Constraints (ADR-010)

| Constraint | Platform | Impact |
|---|---|---|
| `fs::rename` fails across mount points (`EXDEV`) | Linux | Move operations on split-partition layouts fail |
| File locking by other processes | Windows | Move/delete may fail if a file is held by another application |
| Resource forks / extended attributes | macOS | `fs::rename` preserves these; copy-then-delete may not |
| Case sensitivity | Linux (case-sensitive) vs Windows/macOS (case-insensitive) | Rename `Foo.py` → `foo.py` is a no-op on Windows/macOS but a real rename on Linux |
| Path length limits | Windows (260 char default) | Deep nesting may exceed MAX_PATH |

---

## 3. Product Requirements

### 3.1 Manager Interface

The manager is a plain JavaScript closure (not a React hook) following the domain pattern established by `createPieceDomain`, `createGroupDomain`, etc.

```js
const fsManager = createFilesystemWriteManager({
  // Tauri invoke wrappers
  moveProjectPath,
  writeProjectFile,
  removeEmptyDirectory,
  createProjectDirectory,
  deleteProjectPath,

  // Project context
  rootPath,

  // Domain accessors (read-only)
  getPiecesById,
  getPiecesByFilename,
  getPieces,
  getGroups,
  getGroupByPieceId,

  // Piece state mutations
  updatePieceFilenames,
  deletePieces,

  // Tab mutations
  updateTabFilename,
  closeTab,

  // Group mutations
  syncGroupMembership,
  removePiecesFromGroups,

  // Connection mutations
  removeConnectionsForPieces,

  // Syntax domain mutations
  syntaxDomainUnregisterFile,    // syntaxDomain.commands.unregisterFile
  syntaxDomainNotifyFileChanged, // syntaxDomain.commands.notifyFileChanged (for moved files)

  // Manifest and scaffold
  queueManifestCommand,
  bumpScaffoldRefresh,

  // Path utilities
  normalizePath,
  getBasename,

  // User notification
  notify
});
```

### 3.2 Operations

#### 3.2.1 Method Summary

| Method | Signature | Pipeline |
|---|---|---|
| `moveFile` | `(sourcePath, destPath) => Promise<Result>` | Move pipeline |
| `moveFolder` | `(sourcePath, destPath) => Promise<Result>` | Move pipeline (all contents) |
| `deleteFile` | `(filePath) => Promise<Result>` | Delete pipeline |
| `deleteFolder` | `(folderPath) => Promise<Result>` | Delete pipeline (recursive) |
| `deleteEmptyFolder` | `(folderPath) => Promise<Result>` | Safe delete (fails if not empty) |
| `writeFile` | `(filePath, contents) => Promise<Result>` | Write pipeline |
| `createDirectory` | `(dirPath) => Promise<Result>` | No piece sync needed |

All methods return `{ success: true }` or `{ success: false, error: string, code: string }`.

#### 3.2.2 Move Pipeline

Used by `moveFile` and `moveFolder`. Order matters — filesystem first, state after.

```
1. moveProjectPath(rootPath, sourcePath, destPath)     — Rust fs::rename
   If fails → return error, no state changes
   ↓
2. Identify affected pieces                            — scan piecesById for filename prefix match
   ↓
3. updatePieceFilenames(updates)                       — rewrite piece.filename to new path
   ↓
4. updateTabFilename(oldPath, newPath) per piece       — update open editor tab titles/paths
   ↓
5. syncGroupMembership(...)                            — move pieces to correct group based on new path
   ↓
6. syntaxDomainUnregisterFile(oldPath)                 — remove old file from syntax index
   syntaxDomainNotifyFileChanged(newPath, text)        — re-register at new path (if file open)
   ↓
7. Update connections                                  — any connection whose source/target piece
                                                         was moved has stale path refs. The syntax
                                                         domain marks these edges as needing re-resolve
                                                         via the unregister/re-register cycle above.
   ↓
8. queueManifestCommand → updatePieceFileMap           — persist filename changes
   ↓
9. bumpScaffoldRefresh()                               — re-read filesystem tree
```

**For `moveFolder`**: Step 2 finds all pieces under the folder prefix. Steps 3-7 apply to every affected piece. Steps 8-9 run once at the end.

#### 3.2.3 Delete Pipeline

Used by `deleteFile` and `deleteFolder`. Filesystem first, then full state cleanup.

```
1. deleteProjectPath(rootPath, path)                   — Rust fs::remove_file or fs::remove_dir_all
   If fails → return error, no state changes
   ↓
2. Identify affected pieces                            — scan piecesById for filename prefix match
   Collect pieceIds for all affected pieces
   ↓
3. closeTab(pieceId) per affected piece                — close any open editor tabs showing deleted files
   ↓
4. removeConnectionsForPieces(pieceIds)                — remove all canvas connections involving deleted pieces
   ↓
5. syntaxDomainUnregisterFile(filePath) per piece      — remove from syntax index, marks dependent edges broken
   ↓
6. deletePieces({ ids, piecesById, pieces })           — remove pieces from pieceDomain state
   ↓
7. removePiecesFromGroups(pieceIds)                     — remove pieces from their groups
   If group is now empty → delete group (optional, see 3.6)
   ↓
8. queueManifestCommand → updatePieceFileMap           — persist removal (removePieceIds)
   ↓
9. bumpScaffoldRefresh()                               — re-read filesystem tree
```

**Critical ordering**: Filesystem delete happens first (step 1). If it fails, no state changes occur. This is the opposite of what `handleDeleteSelected` does today (state first, filesystem second) — the manager standardizes on filesystem-first to prevent state/disk divergence.

**Tab closure** (step 3): This is missing from every existing call site. Today, deleting a piece file while it's open in the editor leaves an orphaned tab pointing to a non-existent file. The manager closes these tabs before removing the piece from state.

#### 3.2.4 Write Pipeline

Used by `writeFile`. Simpler chain — no piece removal or connection cleanup.

```
1. writeProjectFile(rootPath, filePath, contents)      — Rust atomic write
   If fails → return error
   ↓
2. If filePath maps to an existing piece:
   syntaxDomainNotifyFileChanged(filePath, contents)   — refresh syntax index
   ↓
3. queueManifestCommand (if piece mapping changed)     — persist
   ↓
4. bumpScaffoldRefresh()                               — re-read filesystem tree
```

#### 3.2.5 Canvas Piece-to-Group Move (Future Call Site)

When the node system or canvas interaction controller supports dragging a single piece from one group into another, the call site is:

```js
await fsManager.moveFile(piece.filename, targetGroup.folderPath + '/' + basename(piece.filename));
```

This is expected to be call site #4 or #5 and is a primary trigger candidate for building the manager. The caller doesn't need to know about sync steps — `moveFile` handles the entire pipeline.

#### 3.2.6 Batch Operations

```js
// Merge example: move files, delete source folder
await fsManager.batch([
  { op: 'moveFile', from: 'random/daddy.py', to: 'src/daddy.py' },
  { op: 'moveFile', from: 'random/urmom.py', to: 'src/urmom.py' },
  { op: 'deleteEmptyFolder', path: 'random' }
]);

// Delete example: delete multiple pieces and their files
await fsManager.batch([
  { op: 'deleteFile', path: 'src/deprecated_util.py' },
  { op: 'deleteFile', path: 'src/old_helper.py' },
]);
```

**Supported batch operations**: `moveFile`, `moveFolder`, `deleteFile`, `deleteFolder`, `deleteEmptyFolder`, `writeFile`, `createDirectory`.

**Batch semantics**:
- Operations execute sequentially within a batch (order matters — move before delete)
- Each operation runs its full pipeline (move pipeline or delete pipeline)
- Each operation that succeeds is committed (state updated immediately)
- Failures are collected but do not abort remaining operations
- State is consistent after batch — only successful ops are reflected
- Returns `{ results: Result[], successCount: number, failureCount: number }`
- Manifest update and scaffold refresh happen once at the end (not per-operation), even when mixing move and delete ops in the same batch

### 3.3 Reconciliation Layer

When a filesystem operation results in a piece's parent directory matching no existing group's `folderPath`, the manager should:

1. Check if the directory contains pieces that belong to a group
2. If all pieces in the directory were previously in the same group (now deleted), auto-create a folder group for that directory
3. Assign the pieces to the new group
4. This resolves the "merge then recreate folder" gap documented in the nest/merge implementation brief

**Guard**: Only auto-create groups for directories that contain Litria pieces. Random new folders in the project root do not trigger group creation.

### 3.4 Empty Group Cleanup After Delete

When all pieces in a group are deleted, the group becomes empty. The manager's delete pipeline (step 7) must decide what to do:

**Policy**: If a folder-backed group has zero pieces after deletion, **keep the group** but mark it visually empty. The folder still exists on disk (piece files were deleted, but the folder itself was not). Deleting the group automatically would surprise users who still see the folder in the scaffold.

**Exception**: If the caller explicitly deletes the folder itself (via `deleteFolder`), the group is removed because its backing folder is gone.

**Rationale**: Groups are user-created organizational structures. The manager should not silently destroy them. If the user wants to delete an empty group, they can do so explicitly via the group context menu.

> **Ruling (2026-07-28):** the owner re-affirmed this policy as written —
> and extended it: it applies to move-emptied groups as well, and every
> folder on disk gets a canvas presence (full scaffold parity). The shipped
> dissolve behavior (`keepGroup` cull + reconciler removal + row deletion)
> is the part that changes. Design and slicing:
> `docs/plans/ideas/brief-nested-group-containment.md` (D1/D2).

### 3.5 New Rust Backend Command

#### `remove_empty_directory`

```rust
pub(crate) fn remove_empty_directory(
    root_path: &str,
    relative_path: &str,
) -> CommandResult<()>
```

- Uses `std::fs::remove_dir` (not `remove_dir_all`) — fails if directory is not empty
- Path validation via `path_guard` (same as all other project ops)
- Write lock via `write_ops::with_write_lock`
- Returns success if directory was already absent (idempotent)

This command is needed by the nest/merge feature (canvas merge deletes source folder after moving files) and should be added to `project_ops.rs` alongside existing commands.

### 3.5 Cross-Device Move Fallback

When `moveProjectPath` fails with a cross-device error (Linux `EXDEV`):

1. Copy the file/folder to the destination using `std::fs::copy` (files) or recursive copy (folders)
2. Verify the copy succeeded (compare file sizes or checksums)
3. Delete the source
4. If delete fails after successful copy, report partial success — file exists in both locations

This fallback lives in the Rust backend (`project_ops.rs`), not in the frontend manager. The manager calls the same `moveProjectPath` invoke — the backend handles the fallback transparently.

**Implementation**: Add a `move_with_fallback` helper in `project_ops.rs`:

```rust
fn move_with_fallback(from: &Path, to: &Path) -> std::io::Result<()> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            // Cross-device: copy then delete
            if from.is_dir() {
                copy_dir_recursive(from, to)?;
            } else {
                fs::copy(from, to)?;
            }
            if from.is_dir() {
                fs::remove_dir_all(from)?;
            } else {
                fs::remove_file(from)?;
            }
            Ok(())
        }
        Err(e) => Err(e),
    }
}
```

**Platform note**: `EXDEV` is a Unix-only error. Windows `MoveFileEx` handles cross-volume moves transparently. The fallback code should be gated with `#[cfg(unix)]` per ADR-010 abstraction rules.

> **Delivery addendum (2026-07-28):** shipped in `project_ops.rs` as
> `move_with_cross_device_fallback`, with two deliberate deviations from
> the spec above:
>
> 1. **Not `#[cfg(unix)]`-gated — the platform note is wrong for Rust
>    std.** `MoveFileEx` only copies across volumes when passed
>    `MOVEFILE_COPY_ALLOWED`, which `std::fs::rename` does not pass, so a
>    Windows cross-drive move fails exactly like Unix `EXDEV`. The
>    implementation keys on `io::ErrorKind::CrossesDevices`, which maps
>    both `EXDEV` and `ERROR_NOT_SAME_DEVICE`.
> 2. **Failure rolls back instead of "partial success".** Step 4 above
>    asked for a partial-success report when the source delete fails after
>    a good copy; `CommandResult<()>` has no partial-success channel, and
>    a both-locations limbo leaves app state inconsistent. Instead the
>    destination copy is removed on any failure: the reported error always
>    matches disk state (source intact, pieces still valid). An existing
>    destination is refused up front (`AlreadyExists`) so the rollback can
>    never delete a file the fallback didn't create.
>
> Copy verification is byte-length per file (step 2's cheap option), and
> the whole fallback runs inside the same `with_write_lock` closure as the
> rename. Unit tests in `project_ops.rs` cover: rename-preferred, file and
> recursive-directory fallback, foreign-error propagation, existing-dest
> refusal, and delete-failure rollback (injected errors — real cross-device
> moves need two filesystems).

---

## 4. Error Handling

### 4.1 Error Categories

#### Move errors

| Category | Platform | User Message | Recovery |
|---|---|---|---|
| Permission denied | All | "Cannot move {filename} — permission denied" | User fixes permissions manually |
| File locked | Windows | "Cannot move {filename} — file is in use by another application" | User closes the locking application |
| Cross-device link | Linux | Transparent fallback (copy + delete). If fallback fails: "Cannot move {filename} across filesystems" | User moves files manually |
| Path too long | Windows | "Path too long — try a shorter project folder name" | User restructures directories |
| Destination exists | All | "A file named {filename} already exists in {destination}" | Future: conflict resolution UI. v1: abort operation |

#### Delete errors

| Category | Platform | User Message | Recovery |
|---|---|---|---|
| Permission denied | All | "Cannot delete {filename} — permission denied" | User fixes permissions manually |
| File locked | Windows | "Cannot delete {filename} — file is in use by another application" | User closes the locking application |
| Directory not empty | All | "Cannot delete folder — it still contains files" | Expected for `deleteEmptyFolder`. User cleans up manually |
| File not found | All | No error — idempotent. Return success | N/A |
| `.DS_Store` blocking folder delete | macOS | "Folder not empty — contains hidden system files" | User deletes `.DS_Store` manually or uses `deleteFolder` (recursive) |

### 4.2 Error Reporting

Single operations return `{ success: false, error: string, code: string }`.

Batch operations collect all errors and return them in the results array. A notification summarizes: "Moved 3/5 files. 2 failed: {reasons}."

### 4.3 Never Fail Silently

Every filesystem error must result in either:
- A user-visible notification (PillNotification)
- A returned error in the result object

No swallowed errors. No silent partial state updates.

---

## 5. Migration Plan

When the trigger condition is met (4th call site), migrate in this order:

### Phase 1: Extract and validate
1. Create `src/app/filesystemWriteManager.js` with the interface from 3.1
2. Add `remove_empty_directory` to `project_ops.rs`
3. Add cross-device move fallback to `project_ops.rs` (Linux only)
4. Write unit tests for the manager (mock Tauri invokes, verify sync sequence)

### Phase 2: Migrate move call sites (one at a time)
1. `useScaffoldOperations.js` `handleScaffoldDrop` — highest traffic, best test coverage
2. `useGroupMenuActions.js` group creation — move files into new group folder
3. `handleResolveGroupDrop` — canvas nest/merge
4. New call site (whatever triggered the extraction)

### Phase 3: Migrate delete call sites
1. `useScaffoldOperations.js` `handleContextDelete` — scaffold right-click delete
2. `useGroupMenuActions.js` `handleDeleteSelected` — group menu delete pieces

**Migration note**: Both existing delete paths are incomplete (see 2.1). Migration is not just a mechanical replacement — the manager adds tab closure, connection cleanup, and syntax domain unregistration that these paths are currently missing. This means migrated behavior will be **better** than pre-migration behavior, which changes the validation approach: verify that the new sync steps work correctly, not that behavior is identical to before.

### Phase 4: Validate
1. Manual QA: scaffold drag, scaffold delete, group creation, group delete, canvas nest/merge, new call site
2. Verify manifest consistency after each operation type
3. Verify no orphaned tabs after file deletion
4. Verify no stale connections after file deletion or move
5. Verify syntax domain consistency after move and delete
6. Test partial failure scenarios (lock a file, attempt batch move/delete)
7. Cross-platform validation when macOS/Linux builds are available

---

## 6. Acceptance Criteria

### 6.1 Functional — Move Pipeline

| # | Criterion | Validation |
|---|---|---|
| F1 | Single file move updates piece filename, tab filename, group membership, connections, syntax domain, manifest, and scaffold | Move a piece file via manager, verify all 9 sync steps completed |
| F2 | Folder move updates all pieces within the folder | Move a group folder containing 3 pieces, verify all 3 piece filenames updated |
| F3 | Move updates syntax domain — old path unregistered, new path registered | Move a file with exported symbols. Verify syntax index reflects new path. Verify ports reference new path |
| F4 | Move updates connection references — edges re-resolve to new path | Two pieces connected via syntax edge. Move source piece. Verify edge's `sourceFilePath` reflects new path |
| F5 | Move updates open editor tab title and path | Move a file that is open in the editor. Verify tab shows new filename, editor continues working |
| F6 | Reconciliation auto-creates group when pieces' parent dir matches no group | Delete a group (merge), recreate folder, move pieces back. Verify group auto-created |

### 6.2 Functional — Delete Pipeline

| # | Criterion | Validation |
|---|---|---|
| F7 | File delete removes file from disk, then removes piece from state | Delete a piece file via manager. Verify file gone from disk, piece gone from state |
| F8 | File delete closes open editor tabs | Delete a file that is open in the editor. Verify tab is closed, no orphaned tab remains |
| F9 | File delete removes all connections involving the piece | Delete a piece that has 2 connections. Verify both connections removed from connectionDomain |
| F10 | File delete unregisters from syntax domain | Delete a file with exported symbols. Verify syntax index no longer contains the file. Verify dependent edges marked broken |
| F11 | File delete removes piece from its group | Delete a piece in a group. Verify group's `pieceIds` no longer contains the piece |
| F12 | File delete on non-existent file returns success (idempotent) | Delete a path that doesn't exist. Verify no error, no state changes |
| F13 | Folder delete removes all contained pieces and their connections | Delete a folder containing 3 pieces. Verify all 3 pieces removed, all connections removed, all tabs closed |
| F14 | Folder delete removes the group backed by that folder | Delete a folder that is a group's `folderPath`. Verify group removed from state |
| F15 | File delete does NOT auto-delete an empty group | Delete the last piece in a group. Verify group still exists with empty `pieceIds` |
| F16 | `deleteEmptyFolder` fails safely on non-empty directory | Attempt to delete a folder with files. Verify error returned, folder untouched |

### 6.3 Functional — Batch & General

| # | Criterion | Validation |
|---|---|---|
| F17 | Batch operations execute sequentially | Batch move 3 files then delete folder. Verify folder delete runs after moves |
| F18 | Batch partial failure reports individual results | Lock 1 of 3 files, batch move all 3. Verify 2 succeed, 1 fails, state reflects only successes |
| F19 | Batch with mixed move and delete operations | Batch: move 2 files, delete 1 file. Verify all three pipelines run correctly, manifest/scaffold refresh once |
| F20 | All existing call sites produce identical behavior after migration | Side-by-side comparison of scaffold drag, scaffold delete, group creation, group delete, canvas nest/merge before and after migration |
| F21 | Delete pipeline runs filesystem-first, not state-first | Simulate filesystem delete failure (e.g., permission denied). Verify no state changes occurred |

### 6.4 Cross-Platform

| # | Criterion | Platform | Validation |
|---|---|---|---|
| P1 | Cross-device move falls back to copy+delete | Linux | Move a file from a project on one mount point where dest is on another (simulated via tmpfs) |
| P2 | File locked during move produces user-friendly error | Windows | Open a file in Notepad, attempt to move it via manager |
| P3 | Case-only rename works correctly | Linux | Rename `Foo.py` to `foo.py`, verify piece filename updated |
| P4 | Case-only rename is a no-op without error | Windows/macOS | Rename `Foo.py` to `foo.py`, verify no error and filename reflects preferred casing |
| P5 | Path with spaces handled correctly | All | Move a file from `"my folder/file.py"` to `"other folder/file.py"` |
| P6 | Delete file locked by external process | Windows | Open file in Notepad, attempt delete. Verify error, file untouched |
| P7 | Delete folder containing `.DS_Store` only | macOS | Delete all pieces from group. Attempt `deleteEmptyFolder`. Verify error with "hidden system files" message |

### 6.5 Performance

| # | Criterion | Target |
|---|---|---|
| R1 | Single file move (including all sync steps) | < 100ms |
| R2 | Batch of 10 file moves | < 500ms |
| R3 | Scaffold refresh after batch | < 200ms |
| R4 | No UI freeze during filesystem operations | All operations are async (Tauri invokes are non-blocking) |
| R5 | Single file delete (including tab close, connection cleanup, all sync) | < 100ms |
| R6 | Folder delete with 10 pieces (including all cleanup) | < 500ms |

---

## 7. Dependencies

| Dependency | Type | Status |
|---|---|---|
| ADR-010 | Architectural decision | Proposed |
| `project_ops.rs` — `remove_empty_directory` | New Rust command | Not implemented |
| `project_ops.rs` — cross-device fallback | Rust enhancement | Not implemented |
| `pieceDomain`, `groupDomain`, `projectDomain` | Existing domains | Stable |
| `useScaffoldOperations.js` | Migration target | Stable |
| `useGroupMenuActions.js` | Migration target | Stable |
| `handleResolveGroupDrop` | Migration target | Implemented, not shipped |

---

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Migration introduces regression in scaffold drag-and-drop | Medium | High | Migrate scaffold first. Extensive manual QA. Side-by-side behavior comparison. |
| Delete migration changes behavior (adds tab close, connection cleanup) | Medium | Low | These are bug fixes, not regressions. Validate that new cleanup steps work correctly. |
| Cross-device copy+delete is non-atomic — crash during copy leaves duplicate | Low | Medium | Verify copy before deleting source. Accept duplicate as recoverable state. |
| Reconciliation auto-creates unwanted groups | Low | Medium | Guard: only auto-create for directories containing Litria pieces. No empty-folder groups. |
| Batch operation ordering incorrect | Low | High | Operations execute in array order. Document that callers are responsible for ordering. |
| Performance regression from centralized sync | Low | Low | Each sync step is already fast (< 10ms). Centralization adds function call overhead only. |
| Syntax domain unregister during delete breaks active editor | Low | Medium | Close tab (step 3) before unregistering file (step 5). Editor is no longer using the model. |
| Connection removal during delete triggers unexpected UI updates | Low | Low | Connections are removed after tab close. Canvas re-render is expected and correct. |

---

## 9. Future Enhancements (Not in v1)

- **Filesystem undo**: Record operations in a journal, support Ctrl+Z rollback of filesystem moves and deletes
- **Conflict resolution**: When destination file exists, offer rename/overwrite/skip
- **File watching integration**: Manager subscribes to filesystem events, auto-syncs state on external changes (covers the reconciliation gap more broadly)
- **Bulk rename**: Regex-based rename across multiple pieces
- **Dry run mode**: Preview what a batch operation would do before executing
- **Recycle bin / trash**: Instead of permanent deletion, move files to OS trash (Tauri supports `trash` crate). Would make delete operations recoverable outside of Litria
- **Canvas piece-to-group drag**: When node system supports dragging a piece into a different group on the canvas, this becomes a `moveFile` call through the manager

---

## References
- RFC: `docs/rfcs/filesystem-write-manager.md` — design intent and proposed interface
- ADR-010: Cross-Platform Build, Distribution & Platform Abstraction
- `src/app/useScaffoldOperations.js` — existing filesystem move pattern (reference implementation)
- `src/app/useGroupMenuActions.js` — existing group creation filesystem pattern
- `docs/plans/group-nest-merge-implementation.md` — 3rd call site (canvas nest/merge)
- `src-tauri/src/project_ops.rs` — Rust filesystem commands
