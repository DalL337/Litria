# Piece and connection identity: the pre-sync migration

**Status:** Idea / design capture. **Not scheduled, no ADR, no slice.**
**Date:** 2026-09-19 (owner design conversation).
**Owns:** the shape of the eventual identity migration that
[implementation-policy Rule 9](../../../Agents/docs/implementation-policy.md) defers.

This exists so the conclusion is not lost. Rule 9 records the debt but its only pointer
was `.research/2026-08-01-team-sync-architecture.md`, and `.research/` is **gitignored** —
a repository policy citing a file the repository does not contain. This brief is that
pointer's durable replacement; the journal remains the origin record where it survives.

## 1. The defect in the current scheme

`pieces.id` and `connections.id` are `INTEGER PRIMARY KEY AUTOINCREMENT`
([`schema.rs`](../../../src-tauri/src/db/schema.rs)), and every project is its own
`.litria/workspace.db`. The counter is therefore **per file**, so every project starts at 1:

```
projA/.litria/workspace.db  →  pieces: 1, 2, 3, …
projB/.litria/workspace.db  →  pieces: 1, 2, 3, …
```

Two unrelated projects both have a piece 1, and it is a real row in each.

This is what made [ADR-032](../../adrs/032-workspace-epoch-fencing-and-write-truthfulness.md)
D1 **corruption rather than a no-op**: a write issued for project A carried no statement of
which project it meant, so `UPDATE pieces … WHERE id = 1` arriving after project B opened
matched a real row in B. It did not error and it did not miss — it succeeded against the
wrong project's data, which is precisely why ADR-026's failure observer could not catch it.

Scaffold group ids have the same class of problem by a different route: `Date.now()` plus a
process-local counter, unique per machine only.

## 2. Why it will stop being deferrable

Nothing about single-user, single-machine use forces this. Two things do:

- **Team/School sync** — merging replicas means merging id spaces.
- **Imported canvases and cross-machine copies** — the same collision without a server.

Both break on colliding integer ids the moment they exist. Rule 9 anticipated exactly this.

ADR-032's workspace epoch makes the acute problem **unreachable**, which is why this is not
urgent. It does not make it **absent**.

## 3. The landing point

Owner's starting instinct was a readable id — a prefix taken from the filename plus a stable
tail, with the path kept in its own column (`authlogin_001526`). Working it through arrived
somewhere more precise:

> **The tail is the identity, so the tail is the key. The prefix is a rendering concern.**

```
id        = a3f2c9e1d4            opaque, minted at creation, never recomputed
file_path = src/auth/session.js   already exists, already current
label     = session.js            already exists, already current
```

A reader that wants `session_a3f2c9e1` composes it at **read time** from `label` and `id`.

This keeps everything the readable-id idea was for — a row, a log line or a diagnostics
panel says what it is at a glance, instead of showing a bare opaque token — while the key
itself never moves. `groups.id` is already `TEXT PRIMARY KEY`, so the schema has precedent.

### Why the prefix is not stored

The alternative considered was storing `authlogin_a3f2c9e1` and recomputing the prefix on
rename (truncated to a fixed length so the recalculation is deterministic). Rejected:

- **Determinism is not stability.** A deterministic function of a *mutable* input is itself
  mutable, and the filename is among the most mutable things about a piece.
- **A primary-key update is refused today.** `PRAGMA foreign_keys=ON`
  ([`db/mod.rs`](../../../src-tauri/src/db/mod.rs)) and the foreign keys declare
  `ON DELETE CASCADE` only. Changing `pieces.id` while any `group_pieces` or `connections`
  row references it violates the constraint; making it work means adding `ON UPDATE CASCADE`
  — a schema migration on top of the schema migration.
- **Cascades would not reach far enough anyway.** Piece ids are also serialized inside
  `editor_state` values (`open_tab_piece_ids`, `active_tab_piece_id`, `tab_pane_ids`), which
  are opaque text to SQLite; and into the undo stack, and into unawaited writes already in
  flight.
- **Renaming is a core gesture.** Folder groups are real folders, so dragging a piece into a
  group renames it on disk. This would mutate primary keys during ordinary canvas use, not
  rarely.
- **Entropy.** A short numeric tail is roughly one-in-a-million *per identical basename* —
  acceptable inside one project, thin for merging id spaces across machines, which is the
  case that motivates the change. Prefer a longer random tail.
- If a prefix is ever composed into an id, a log line or a URL, it must be a **sanitized
  slug** — basenames carry spaces, unicode and platform-hostile characters.

The stored-prefix scheme is strictly worse on both axes: the rendered name is *more* current
than a stored one (it cannot go stale between a rename and its recalculation), and the key
stays immutable.

## 4. Relationship to the ADR-032 epoch

Complementary, not alternative. **Unique ids contain; the epoch detects.**

| | stray cross-project write today | with unique ids | with the epoch (shipped) |
|---|---|---|---|
| Outcome | corrupts a real row | matches zero rows | refused |
| Reported? | no | **no** — silent no-op | `db.workspace_changed` |

Unique ids downgrade the failure from corruption to silent loss. Only the epoch turns it
into a refusal. A future reader must not treat this migration as grounds to remove the
fence.

## 5. Migration surface (sizing, not a plan)

- `pieces.id`, `connections.id` — the key columns.
- `group_pieces.piece_id`, `connections.from_piece_id`, `connections.to_piece_id` — FKs.
- **Piece ids serialized inside `editor_state` values** — parse-and-rewrite, not a column
  remap. This is the part that makes the migration more than mechanical.
- Scaffold group id minting (`Date.now()` + counter) belongs in the same pass.
- Every existing user's workspace needs it, at a version where the project is public and
  people have real canvases. A migration that cannot be reverted must be able to prove
  itself before it is trusted.

## 6. What is not decided

The tail's format and length; whether to migrate in place or qualify existing integer ids
with `project.instance_id` at the sync boundary (Rule 9 leaves both open); whether
connections migrate in the same pass; how a partially migrated workspace behaves if the app
is interrupted. None of this is settled and none of it needs to be until a sync or import
feature makes identity load-bearing.

No schema was changed and no migration was written. This is a recorded design direction.
