# Brief: Discovery ↔ Canvas Connection Sync

> **For:** Claude Code
> **Scope:** The sync between canvas connections (visual edges), syntax edges (semantic import relationships), discovery (import → edge inference), and connection persistence. Fixes the case where a reopened project's import relationships are *known to the domain* but not *drawn on the canvas* (or drawn but unanchored / not linked to their syntax edge).
> **Stack:** Rust, React 19 + react-konva, Tauri v2, SQLite.
> **Status:** Investigation complete; root causes confirmed; **source-of-truth decision made (2026-06-30) — imports authoritative.** Ready for implementation. This is a multi-subsystem fix — not a one-liner.
> **Related:** Builds on the merged syntax import-write fixes (commit `8196e9e`). Those made discovery's re-resolution of existing imports a clean no-op, so the *remaining* problem is purely the visual/link sync described here.

---

## Symptom

Open a saved project that already contains imports (e.g. `main.tsx` has `import App from "./App"`). The syntax domain re-learns the edge (node ports/status reflect it, the import is in the file), **but the visual connection is missing or wrong on the canvas.** Drawing what looks like a *new* edge then hits the domain's "edge already exists" path → the symbol picker doesn't open (no available symbols) and you get confusing no-op behavior. Earlier malformed-import residue compounds the confusion.

In short: the canvas (visual) and the syntax domain (semantic) drift apart across a reopen, and discovery — the glue meant to reconcile them — does so incorrectly.

---

## Architecture today (the two layers)

There are **two independent representations of a connection**, only loosely coupled:

1. **Canvas connection** — `useConnections` / `connectionDomain`. Drives the visual line (`ConnectionLine` in `WorkspaceStage`) and node tabs/slots. Has `{ id, sourceId, sourceSide, targetId, targetSide, type }`.
   - **Persisted** to SQLite as **only `(fromPieceId, toPieceId)`** — `dbCreateConnection` (`src/project/dbStorage.js:110`). No sides, no type, no link to a syntax edge.
   - **Restored** by hydrating those rows with **hardcoded `sourceSide:'right'`, `targetSide:'left'`** (`src/project/useProjectPersistence.js:180-187`).

2. **Syntax edge** — `syntaxDomain`. Semantic import relationship between a file pair, carrying the resolved symbols, status, and the managed import line. Keyed by `source→target` file pair.
   - **Not persisted at all.** `createSyntaxDomain()` holds it in memory; it is rebuilt from scratch every session by **discovery**.

**Discovery** (`useDiscoveryLifecycle.js`) is the bridge: it scans the project's imports once per session and, for each, creates *both* a canvas connection and a syntax edge.

---

## Root causes (confirmed)

1. **Discovery creates anchorless, unlinked canvas connections.**
   `useDiscoveryLifecycle.js:139-143` calls:
   ```js
   connectionDomain.commands.createConnectionFromDrag({ sourceId, targetId, connectionId });
   ```
   but `createConnectionFromDrag(result)` (`connectionDomain.js:65`) reads `result.sourceSide` / `result.targetSide` (→ **undefined**) and **ignores `connectionId`** — `createConnection` mints its own `conn_N`. So the discovered visual connection has **no anchor sides** and a **different id** than the syntax edge it represents (`handleConnect` is called with `connectionId: 'discovery-N'`). The two layers are not id-linked.

2. **Connection persistence is lossy and unlinked.** The DB stores only `(fromPieceId, toPieceId)`; sides are invented on restore (always right→left), and there is no column tying a connection to its syntax edge / symbols.

3. **Syntax edges are session-only.** They're rebuilt by discovery each open. So on reopen the canvas connections (from DB) and the syntax edges (from discovery) are produced by two different code paths with different ids and no reconciliation — they can duplicate, mismatch, or fail to render.

4. **No reconciliation/dedup between restored connections and discovery.** `connect()` is idempotent by `connectionId`, but restored connections (`conn_N`) and discovery connections (`discovery-N`) use different id spaces, so discovery can't tell that a restored connection already represents an edge it's about to recreate.

---

## Fix approach (phased)

> **Design frame (per Resolved decisions below):** imports are the source of truth for *which edges exist* and their *symbols/status* — syntax edges stay session-only and are re-derived by discovery each open. The SQLite `connections` row stops being a second edge-truth and becomes a store of **visual refinements only** (anchor sides + type). The edge key is **derived from the piece pair** `(sourceId, targetId)` → file pair, so there is no second id space to reconcile.

### Phase 1 — One identity across both layers (by piece-pair, not a minted id)
- Make the canvas connection and its syntax edge **key off the same piece pair** `(sourceId, targetId)` → file pair. Stop minting `discovery-N`: discovery (and the manual-draw path) derive/pass the pair-keyed identity so `createConnection` no longer invents a divergent `conn_N`. This collapses root causes #1 and #4 by construction — there are no longer two id spaces to match.
- `createConnectionFromDrag` must **stop dropping `sourceSide`/`targetSide`** — today it reads `result.sourceSide`/`result.targetSide` which discovery passes as `undefined` (anchorless). Thread real sides through (persisted or geometry-derived; see Phase 3).
- Persist enough to reconstruct the visual edge faithfully: **add nullable `source_side` / `target_side` (and `type`)** to the `connections` table (`ALTER TABLE`; legacy rows = null) + the hydrate mapping, so restored connections aren't all right→left.

### Phase 2 — Deterministic reconciliation on reopen
- **Imports are authoritative.** Reopen flow: restore visual rows → run discovery → **match by piece-pair** → link existing / create missing (import added outside the app) / mark orphaned (restored row with no matching import). Produce exactly one canvas connection + one syntax edge per real import, no duplicates.
- Discovery **skips pairs already represented** by a restored connection (dedup by piece-pair — automatic now that both layers key off the pair); a restored connection gets its syntax edge re-derived and linked the same way.

### Phase 3 — Anchoring
- **Persist the sides the user chose** (write the deliberately-picked source/target edges on create); **compute from relative piece geometry** (nearest facing edges) only when a row has no sides — discovered or legacy — instead of hardcoding right→left. Persisting respects user intent (which the bezier-wire work honors per chosen edge); geometry is the self-healing fallback.

**Out of scope:** changing the import-write path (done), the symbol picker UI, or the bezier render work.

---

## Resolved decisions (2026-06-30)

1. **Source of truth for edges on reopen → (a) imports authoritative.** Re-derive syntax edges from imports every session (as today; post-`8196e9e` it's a clean no-op). Do **not** persist syntax edges — the import statements already are that store, and a second persisted copy drifts the moment imports are edited outside the app. The DB `connections` row persists **only visual refinements** (sides/type), not edge truth. *Rationale:* smaller change, self-correcting against out-of-app edits, avoids duplicate state. The "user-drew-a-connection-with-no-import" case is handled by Phase 2 reconciliation (restored row with no matching import → kept and marked orphaned/pending, not silently vanished).

2. **Connection ↔ syntax-edge identity → derive from the piece pair.** The edge key is `(sourceId, targetId)` → file pair; no shared opaque id is stored. *Rationale:* eliminates the `discovery-N` vs `conn_N` two-id-space mismatch by construction (root causes #1/#4), and makes reopen dedup automatic (same pair = same edge). Couples the key to piece identity — acceptable, since cascade-delete already drops connections when a piece is removed.

3. **Anchor sides → persist chosen, geometry-fallback when absent.** Persist the sides the user deliberately picked; compute from relative piece geometry (nearest facing edges) only for rows with no sides (discovery-created or legacy). *Rationale:* respects user intent on the wires the bezier work anchors per chosen edge, while self-healing discovered/legacy rows instead of hardcoding right→left.

---

## Acceptance

- Reopen a project with existing imports → every import relationship between two on-canvas files shows **exactly one** visual connection, correctly anchored, with no duplicates.
- The visual connection and its syntax edge share one identity (deleting the line cascades correctly; hovering shows the right symbols/status).
- Drawing a connection that already exists is recognized as such and gives the "Already connected" feedback (already implemented) — and the user can see the existing edge that caused it.
- No malformed or duplicate imports are produced on reopen (already true post-`8196e9e`; keep it true).
- `npm run check:architecture` and `npm run test:domains` pass; add tests for: persistence round-trip of sides, discovery/restore reconciliation (no duplicate connections), and id linkage.

---

## Related design gaps (surfaced 2026-06-27 in-app testing)

These share the root cause — the symbol / syntax-edge / canvas-connection / import-statement layers aren't unified at a consistent granularity. Fold into the rework, not piecemeal:

- **Auto-resolve fires without a choice.** When exactly one symbol is available, `onSyntaxPendingCreated` (`src/App.jsx`, ~line 514) skips the picker and resolves immediately. The user can't confirm, decline, or pick add-vs-remove. Should at least surface the picker (or a confirm) rather than silently acting.
- **Granularity mismatch.** The picker presents symbol-level choices, but the edge/import model and the dedup ("already imported") check operate at module/file level. Picking a specific symbol maps to a broad import; "already imported" is judged at the module altitude. A default export has no sub-granularity, so for default-only files every pick is the whole default.
- **No add-vs-remove affordance on an existing edge.** Re-resolving an edge that already carries a symbol just no-ops; there's no UI to *add another* symbol or *remove* one from an existing connection. (This overlaps with the bezier-wire brief's Phase 3 "modeless add-symbol / delete on existing wires.") Explicitly deferred — do not build reactively.

## Summary for the agent

1. The bug: canvas connections and syntax edges are two loosely-coupled layers; discovery (the glue) creates anchorless, id-mismatched connections, and persistence stores connections lossily (no sides, no edge link) while syntax edges aren't persisted at all. On reopen they drift.
2. Fix: one identity across both layers **keyed off the piece pair** (no minted second id); persist sides (geometry fallback); deterministic reopen reconciliation by piece-pair (no duplicates).
3. **Source-of-truth decided (2026-06-30): imports authoritative** — re-derive syntax edges each session, DB persists only visual refinements. See Resolved decisions. Ready to build.
