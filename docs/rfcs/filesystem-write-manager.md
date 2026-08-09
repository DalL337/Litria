# RFC: Filesystem Write Manager (Future Extraction)

## Status
- Implemented (2026-07-25 note — built 2026-03-20, the trigger fired the day
  this design was ratified into PRD-FSM-001; every call site migrated by
  PRs #187–#190. Delivery ledger: PRD-FSM-001 status addendum.)
- Deferred — design now, build when 3-4 call sites exist

## Date
- 2026-03-19

## Owner
- Litria (solo)

## Summary
A centralized service that owns all filesystem mutations (move, rename, create,
delete). Canvas, scaffold, and any future surface route through the same manager
rather than calling `moveProjectPath` / `writeProjectFile` directly.

This RFC captures the design intent so the interface is ready when extraction
is warranted. **Do not build this yet.**

## Motivation
Today, filesystem operations happen in multiple places:

| Call site | Operations | Post-op sync |
|---|---|---|
| `useScaffoldOperations.js` | moveProjectPath, rename | collectAffectedPieces → syncGroupMembership → updatePieceFilenames → bumpScaffoldRefresh |
| `useGroupMenuActions.js` | moveProjectPath, writeProjectFile | updatePieceFilenames → updateTabFilename → updatePieceFileMap → bumpScaffoldRefresh |
| `handleResolveGroupDrop` (new) | moveProjectPath, remove_empty_directory | updatePieceFilenames → updateTabFilename → updatePieceFileMap → bumpScaffoldRefresh |
| Piece creation flow | writeProjectFile | updatePieceFileMap → bumpScaffoldRefresh |

Each call site independently handles:
- Error handling and user notification
- Piece filename sync
- Tab filename sync
- Manifest updates
- Scaffold refresh

This is manageable at 2-3 call sites. At 4+, the duplication becomes a maintenance
risk — a new sync step added in one place is easily forgotten in another.

## Proposed interface (draft)

```js
const fsManager = createFilesystemWriteManager({
  rootPath,
  moveProjectPath,         // Tauri invoke wrapper
  writeProjectFile,        // Tauri invoke wrapper
  removeEmptyDirectory,    // Tauri invoke wrapper (new)
  pieceDomain,
  groupDomain,
  projectDomain,
  piecesById,
  piecesByFilename,
  groups,
  groupByPieceId,
  normalizePath,
  getBasename,
  updateTabFilename,
  queueManifestCommand,
  bumpScaffoldRefresh,
  notify                   // PillNotification trigger
});

// Single operation
await fsManager.moveFile(sourcePath, destPath);
await fsManager.moveFolder(sourcePath, destPath);
await fsManager.deleteEmptyFolder(folderPath);
await fsManager.writeFile(filePath, contents);

// Batch operation (atomic intent)
await fsManager.batch([
  { op: 'moveFile', from: 'random/daddy.py', to: 'src/daddy.py' },
  { op: 'moveFile', from: 'random/urmom.py', to: 'src/urmom.py' },
  { op: 'deleteEmptyFolder', path: 'random' }
]);
```

Each method:
1. Performs the filesystem operation via Tauri
2. Identifies affected pieces
3. Updates piece filenames
4. Updates tab filenames
5. Syncs group membership
6. Queues manifest update
7. Refreshes scaffold
8. Returns success/failure with details

### Batch semantics
- Operations execute sequentially within a batch
- Each operation that succeeds is committed (state updated)
- Failures are collected and reported at the end
- State is consistent after batch — only successful ops are reflected
- Future: true rollback (undo successful ops on failure) when needed

## When to build

**Trigger**: When a 4th distinct call site needs filesystem operations with the
same post-op sync pattern. At that point, extract the manager and migrate all
existing call sites.

**Current count**: 3 (scaffold, group menu, canvas nest/merge). One more triggers
extraction.

**2026-03-19 update**: The canvas nest/merge implementation surfaced a concrete
reconciliation gap — after merge deletes a group, recreating the folder via
scaffold or OS does not recreate the group in state. This is the pain point
predicted in the original RFC. The manager (or a lighter reconciliation layer in
`syncGroupMembership`) would resolve this. The nest/merge feature is implemented
but not shipped, blocked on this gap.

## What NOT to include (yet)

- File watching / filesystem event subscription (separate concern)
- Cross-filesystem moves (copy + delete — not needed for project-local ops)
- Conflict resolution (file already exists at destination)
- Full undo/rollback of filesystem operations

These can be added incrementally if the need arises.

## References
- `src/app/useScaffoldOperations.js` — current filesystem move pattern
- `src/app/useGroupMenuActions.js` — current group creation filesystem pattern
- `docs/plans/group-nest-merge-implementation.md` — 3rd call site (canvas nest/merge)
- `src-tauri/src/project_ops.rs` — Rust filesystem commands
