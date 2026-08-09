# Collapsed Group — Hide Internal Connections

**Status: COMPLETE** -- Fixed. Closed 2026-03-07.

## Problem

When a folder group is collapsed, its pieces are hidden via `hiddenPieceIds` /
`buildVisiblePieces`, but connections between those hidden pieces remain visible
on the canvas. The lines hang in space with no visible endpoints.

## Root Cause

Connections are rendered from `connectionsByPiece.all` (App.jsx line 786) which
is the full unfiltered list from `connectionDomain`. The render loop in
WorkspaceStage.jsx (line 113) passes each connection to `ConnectionLine`, which
looks up source/target from `piecesById`.

`piecesById` is built from ALL pieces (App.jsx line 277), not just visible ones.
So `ConnectionLine` receives valid piece objects for hidden pieces and renders
the line. The early-return guard at ConnectionLine.jsx line 40
(`if (!sourcePiece || !targetPiece) return null`) never fires because the pieces
exist in state — they're just not rendered.

There is no connection visibility filter that accounts for collapsed groups.

## Connection Categories When a Group is Collapsed

| Category | Source | Target | Should display? |
|----------|--------|--------|-----------------|
| Internal | in group | in group | No — both endpoints hidden |
| Outgoing | in group | outside group | Yes — reroute to squircle edge |
| Incoming | outside group | in group | Yes — reroute to squircle edge |
| External | outside group | outside group | Yes — unchanged |

## Fix Strategy

### Step 1: Filter internal connections from render list

**Where**: App.jsx, between `connectionsByPiece.all` (line 786) and the
`WorkspaceStage` prop pass (line 1028)

**What**: Derive a `visibleConnections` list that excludes connections where
BOTH source and target are in `hiddenPieceIds`.

```
visibleConnections = allConnections.filter(conn =>
  !(hiddenPieceIds.has(conn.sourceId) && hiddenPieceIds.has(conn.targetId))
)
```

This is the minimal fix. Internal connections disappear. External connections
are untouched. Cross-boundary connections (one end in the group, one outside)
remain visible — which is correct for now and becomes the foundation for
squircle edge routing later.

**Dependencies**: `hiddenPieceIds` (already computed at line 286)

### Step 2: Handle cross-boundary connections (deferred — ties into squircle plan)

Connections where one end is inside the collapsed group and the other is outside
currently point to a hidden piece position (the line renders but one endpoint is
invisible). Once the squircle is implemented, these connections should reroute
to the squircle's nearest edge.

This is documented in `collapsed-group-squircle.md` step 5 and should be
implemented together with the squircle shape.

**Interim behavior after step 1**: Cross-boundary connections still render with
one endpoint at the hidden piece's position. This is imperfect but no worse
than current state and is a temporary condition until squircle routing lands.

Alternatively, step 1 could hide ALL connections involving any hidden piece:

```
visibleConnections = allConnections.filter(conn =>
  !hiddenPieceIds.has(conn.sourceId) && !hiddenPieceIds.has(conn.targetId)
)
```

This is cleaner visually (no dangling lines) but means cross-boundary
connections vanish entirely until squircle routing is ready. This is the
recommended approach — simpler, no visual artifacts, and the squircle plan
will restore them properly.

## Affected Files

| File | Change |
|------|--------|
| `src/App.jsx` | Add `visibleConnections` memo, pass to WorkspaceStage instead of `allConnections` |
| `src/components/WorkspaceStage.jsx` | Rename prop from `allConnections` to `visibleConnections` (or keep name, just receives filtered list) |
| `src/app/selectors/workspaceSelectors.js` | Optional: add `buildVisibleConnections(allConnections, hiddenPieceIds)` selector |

## Implementation

Single step. One new `useMemo` in App.jsx + update the prop passed to
WorkspaceStage. No changes to ConnectionLine, groupDomain, or persistence.

Estimated scope: ~5 lines of logic.

## Relationship to Other Plans

- **collapsed-group-squircle.md**: Step 5 (connection routing to squircle edges)
  builds on this by restoring cross-boundary connections with proper endpoints.
  This fix is a prerequisite — filter first, then reroute.
- **single-file-open-fix.md**: Independent, no overlap.

## Validation

- Collapse a folder group with internal connections — lines disappear
- Expand the group — lines reappear
- Connections between non-grouped pieces — unaffected
- Collapse group A, verify connections between group B pieces still show
- Cross-boundary connections: hidden (recommended) until squircle routing lands
