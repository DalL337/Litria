# Connection Persistence — Plan

## Problem

Connections (code wiring between pieces) exist only in React state via
`useConnections`. They are lost on every app restart. The syntax adapter writes
real import statements into source files, but the visual connection lines
disappear because the manifest never stores them.

### Current Flow

1. User Ctrl+LMB drags piece A to piece B
2. `connectionDomain.commands.createConnectionFromDrag` creates connection object
3. `useConnections` stores it in `useState([])` — memory only
4. `syntaxAdapter.handleConnect` writes an import stub into the target file
5. On restart, import stub remains in source code but connection array is empty

### Connection Shape

```js
{
  id: "conn_1",          // auto-incrementing string "conn_N"
  sourceId: 3,           // piece id (number)
  targetId: 7,           // piece id (number)
  sourceSide: "right",   // "top" | "right" | "bottom" | "left"
  targetSide: "left",    // "top" | "right" | "bottom" | "left"
  type: "reference"      // currently always "reference"
}
```

### Size Impact

~100-150 bytes per connection in JSON. Scaling estimate:

| Codebase | Connections | Added Size |
|----------|------------|------------|
| Small (20 files) | 10-30 | ~3 KB |
| Medium (100 files) | 50-150 | ~15 KB |
| Large (500 files) | 200-500 | ~50-60 KB |
| Very large (1000+ files) | 500-1500 | ~120-180 KB |

Negligible relative to existing pieces array. Entire manifest stays well under 1 MB.

## Affected Files

| File | Role |
|------|------|
| `src/behaviors/useConnections.js` | In-memory connection state (useState) |
| `src/app/connectionDomain.js` | Domain wrapper — create/insert/remove with history |
| `src/project/projectDomain.js` | `loadWorkspaceState` / `persistWorkspaceState` |
| `src/project/useProjectPersistence.js` | Debounced persist effects, restore effects |
| `src/App.jsx` | Wires connections into persistence, passes to connectionDomain |

## Strategy — Option A: Manifest Persistence

Persist connections directly in `litria.project.json` alongside pieces and groups.
This is the simplest path — same pattern used for groups already.

### 1. Add `setConnections` to useConnections

**Where**: `src/behaviors/useConnections.js`

**What**: Expose the raw `setConnections` setter and a `getNextConnectionId` /
`setNextConnectionId` pair so the persistence layer can bulk-load connections
on restore and resume ID generation without collisions.

```js
// New exports from useConnections:
setConnections,          // raw setter for bulk restore
nextConnectionId,        // current counter value (for persist)
setNextConnectionId      // restore counter on load
```

### 2. Serialize connections in persistWorkspaceState

**Where**: `src/project/projectDomain.js`, `persistWorkspaceState`

**What**: Add a `connections` array to the manifest updater, serialized from
`connections.getAllConnections()`. Also persist `nextConnectionId` to avoid
ID collisions after restore.

```js
// In the manifest updater:
connections: serializedConnections,
nextConnectionId: nextConnectionId
```

Serialization shape per connection:
```js
{
  id: conn.id,
  sourceId: conn.sourceId,
  targetId: conn.targetId,
  sourceSide: conn.sourceSide,
  targetSide: conn.targetSide,
  type: conn.type
}
```

### 3. Deserialize connections in loadWorkspaceState

**Where**: `src/project/projectDomain.js`, `loadWorkspaceState`

**What**: Read `manifest.connections` array, normalize each entry (validate
sourceId/targetId exist in loaded pieces, default missing fields), and return
alongside pieces/groups.

```js
// Added to loadWorkspaceState return:
{
  ...existing,
  connections: normalizedConnections,
  nextConnectionId: manifest.nextConnectionId ?? nextIdFromConnections
}
```

Validation rules:
- Skip connections where sourceId or targetId is missing from loaded pieces
- Skip duplicate connections (same sourceId + targetId direction)
- Skip self-connections (sourceId === targetId)
- Default `type` to `"reference"` if missing
- Default `sourceSide`/`targetSide` to `"right"`/`"left"` if missing

### 4. Thread connections through useProjectPersistence

**Where**: `src/project/useProjectPersistence.js`

**What**: Accept `connections` (the hook return) as a new parameter. On load,
call `setConnections(loaded.connections)` and
`setNextConnectionId(loaded.nextConnectionId)`. The existing debounced persist
effect already watches `pieces` — add `connections.connections` to its
dependency array so connection changes trigger manifest writes.

### 5. Wire into App.jsx

**Where**: `src/App.jsx`

**What**: Pass `connections` hook to `useProjectPersistence`. The connections
hook is already instantiated at line 254. Threading is minimal — just add it
to the persistence call and ensure the persist effect's serialization includes
connection state.

### 6. Handle connection ID resume

**Where**: `src/behaviors/useConnections.js`

**What**: On restore, `nextConnectionIdRef.current` must be set to
`nextConnectionId` from the manifest (or computed as max existing ID + 1).
This prevents `conn_1` collisions after restart.

## Sequence

| Step | Scope | Risk | Notes |
|------|-------|------|-------|
| 1 | useConnections API | Low | Additive — no behavior change |
| 2 | Persist write | Low | New field in manifest, backwards compatible |
| 3 | Persist read | Low | Missing `connections` key returns empty array |
| 4 | Thread persistence | Low | Same pattern as groups |
| 5 | App.jsx wiring | Low | Minimal prop threading |
| 6 | ID resume | Low | Prevents collision after restore |

## Validation

- Create connections between pieces, close and reopen project — connections restore
- Delete a piece — its connections are removed from state AND manifest on next persist
- Open a project with no `connections` key in manifest — loads cleanly with empty array
- Connection IDs don't collide after restore (create new connections post-load)
- File-mode sessions (manifestPath === null) don't attempt to persist connections
- Undo/redo still works after connections are restored from manifest
- `visibleConnections` filtering still hides collapsed group internals after restore

## Backwards Compatibility

- Old manifests without `connections` key load fine — defaults to empty array
- No migration needed — additive schema change
- `nextConnectionId` missing from old manifests — computed from max existing ID

## Future: Option B — Import-Derived Connections

After Option A ships, a future enhancement could derive connections from actual
import statements in source files at load time. This would:

- Auto-discover connections the user never manually drew
- Detect broken connections when imports are removed outside Litria
- Sync visual wiring with actual code dependencies

This requires the syntax domain's symbol parser to be mature enough to reliably
extract import/export relationships across JS/TS/Python files. Option A provides
the persistence foundation that Option B would build on top of.

## Staged Rollout

### Stage 1 — Manual Persistence (Option A, this plan)

User draws connections manually via Ctrl+LMB drag. Connections persist across
restarts in `litria.project.json`. Opening a non-Litria project gives pieces on the
canvas but zero connections until the user wires them.

### Stage 2 — Auto-Discovery (Option B, future)

On project open, the syntax domain scans each file's import statements, resolves
them against pieces on the canvas, and auto-generates connections. This is the
"open any project and the wiring is already there" experience.

Prerequisites before Stage 2 can ship:

- **Import path resolution**: Relative paths, aliases (`@/`), index files, barrel re-exports
- **Piece matching**: Resolved absolute paths mapped to pieces already on the canvas
- **Multi-language**: JS/TS (`import`/`require`) and Python (`import`/`from...import`) minimum
- **Edge cases**: Dynamic imports, re-exports, circular dependencies, monorepo paths

### Stage 2 reconciliation with Stage 1

When Option B discovers connections at load time, it must reconcile against
manually-drawn connections already stored in the manifest:

- If a manifest connection matches a discovered import, keep the manifest version
  (preserves user's chosen sourceSide/targetSide routing)
- If a discovered import has no manifest match, create a new connection with
  default side assignment (closest-edge)
- If a manifest connection has no matching import (user deleted the import
  outside Litria), mark it as `status: "broken"` rather than silently removing it
- User can manually dismiss broken connections or re-draw them

This ensures Option A users never lose their work when Option B activates.
