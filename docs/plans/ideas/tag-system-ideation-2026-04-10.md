# Tag System — Ideation & Design Discussion

**Status:** Ideation only — not committed, not built, no implementation in flight
**Date:** 2026-04-10
**Origin session:** Folder-spawn grid fix (PR #39, feedback log item #21)
**Related memory:** `design_tag_capability_framing.md`
**Related code:** `src/utils/gridLayout.js`, `src/app/useScaffoldActions.js`, `src-tauri/src/db/schema.rs` (`hidden_paths`)

---

## Why this came up

While fixing feedback log item #21 (folder spawn stacking all pieces at one point), we dug into the folder-to-canvas workflow and discovered that the tier chevron UX (`<` / `>` buttons that grow/shrink the visible grid inside an expanded folder group) was never fully implemented the way the PRD described. The chevrons moved pieces but never actually **hid** overflow pieces — the old stacking bug was masking the missing feature, because "too many files" just meant "they all stack invisibly at viewport-center."

PR #39 ships a pragmatic fix (pieces land in a real grid instead of stacking), but explicitly defers the proper tier-reveal UX as a "for-now" implementation. The tag system explored below is one candidate design for finishing that work properly.

**Everything below is pre-commitment ideation.** No decision has been made to build it. The purpose of this doc is to preserve the thinking so future-us can pick it up with context intact.

---

## The problem being solved

The current folder-group code tangles three concerns together:

1. **Position** (`x`, `y` on each piece) — where the piece physically lives on the canvas
2. **Tier state** (`gridTier` integer on each group) — how many pieces should be visible at the current tier
3. **Visibility** (emergent from `isCollapsed` + position) — what the user actually sees

When the user clicks `>` or `<`, all three have to be updated in lockstep: tier increments, positions recompute via `batchMovePieces`, and visibility shifts because repositioned pieces now occupy different cells. Any one of them drifting creates silent bugs. Also, `batchMovePieces` only writes in-memory — none of the tier state persists to SQLite — so closing and reopening the project loses it entirely.

The question: is there a cleaner model that separates these concerns cleanly and makes tier state durable?

---

## Core concept: tags as declarative state

The ideation converged on the idea of a **tag table** — a normalized SQL table (`piece_tags` or similar) that attaches named markers to pieces. Code reads the tag state to decide what to render and what gestures/commands are applicable. The tags themselves are simple: a name and a presence/absence on each piece.

**The key property:** tags are *declarative state*, not imperative logic. You ask "does this piece have tag X?" and the code reads the answer. You don't say "when condition Y, set tier and recompute positions and update the display flag" — you just swap tags, and rendering picks up the change.

**The user's framing of the principle:**

> "a word to describe a state. the logic and heavy lifting reads that state and executes based on that state. can the user see this thing, yes/no based on its tag. does the column and rows inside the folder when its expanded grow or shrink yes/no based on how many are tagged with that state."

---

## Design decisions reached during the discussion

### 1. Dual-tag swap model for tier visibility

Every piece belonging to a folder group has exactly one of two mutually exclusive tags:

- `inGrid` — the piece is currently in the visible tier layout
- `overflow` — the piece is in the waiting room, hidden but ready to be promoted

Clicking `>` (More) **updates** tags in a batch: the next N alphabetical `overflow` pieces become `inGrid`. Clicking `<` (Less) does the reverse. Every state transition is a single atomic `UPDATE` in SQL, not a `DELETE` + `INSERT` dance.

```sql
-- More: promote next 3 alphabetical
UPDATE piece_tags SET tag_name = 'inGrid'
WHERE tag_name = 'overflow' AND piece_id IN (... next 3 alphabetical ...);

-- Less: demote last 3 alphabetical
UPDATE piece_tags SET tag_name = 'overflow'
WHERE tag_name = 'inGrid' AND piece_id IN (... last 3 alphabetical ...);
```

**Mutual exclusivity can be enforced at the DB level** via a UNIQUE constraint on `(piece_id, tier_dimension)` or a CHECK constraint — meaning the database itself refuses to let a piece have both tags at once. Desync becomes physically impossible.

### 2. Dual framing — state internally, capability externally

This was a late refinement and it's important. Tags have **two correct descriptions depending on audience**:

- **Internally** (code, tests, variable names, dev docs): tags are **state**. Code reads the tag state to dispatch gestures and commands. Power users and devs understand state machines; that's the accurate technical word.
- **Externally** (user guides, UI copy, explanations to non-devs): tags are **capabilities**. "This file is capable of being shown in the grid" is more accessible than "this file's render state is `inGrid`." New users grok capabilities; state sounds like jargon.

Same mechanism, different narrative. The implementation discipline is unchanged regardless of which word is being used in a given document.

**Example translations:**

| Tag | State framing | Capability framing |
|---|---|---|
| `inGrid` | piece is currently in the grid layout | piece can be demoted out of the visible tier |
| `overflow` | piece is in the waiting room | piece can be promoted into the visible tier |
| `pinned` | piece is locked into the grid | piece resists demotion regardless of tier |
| `scaffoldHidden` | piece is filtered from render | piece is excluded from render pipelines |
| `modified` | file is dirty | file can display dirty-state badges |

### 3. Closed tag set with a contract schema

Tags are a **controlled vocabulary** — a finite, documented, enforceable set. Not free-form strings that any code can invent ad-hoc. Each tag has a declared contract:

- **Name** — canonical identifier used in SQL and code
- **Scope** — which entity type can carry it (piece, group, connection, etc.)
- **Effect** — the single behavior that reads it (render filter, gesture eligibility, badge display, etc.)
- **Lifecycle** — who writes it, who clears it, when
- **Mutual exclusion** — is this tag part of a group where only one can be present
- **Invariants** — what must always be true (enforceable as DB constraints)

**Rule: each tag grants ONE capability / represents ONE state.** If a tag starts meaning two things, it gets split.

**Enforcement:** a tag registry file plus a `tag-contract-guard.mjs` script modeled on the existing `domain-contract-guard.mjs` pattern. The guard would verify:

- Every tag string used in SQL queries is declared in the registry
- Every tag in the registry has at least one documented consumer (no dead tags)
- No file imports or writes a tag outside its declared scope
- No raw string tag literals in application code — all go through typed constants

### 4. Tags are presence-only, no payloads

Tags don't carry data. They don't reference other entities. They answer "is this tag on this piece?" and nothing else. If a proposed tag wants to carry a payload or point at another row, it's a **relationship, not a tag** — and relationships belong in foreign key columns, not in the tag table.

The load-bearing distinction: **tags for state, foreign keys for structure.** Mixing them in one table loses relational integrity (foreign keys have cascade, CHECK constraints, referential enforcement; tag payloads are just opaque strings) and muddies the contract schema.

### 5. Tag presence decouples state from geometry

This is the subtler architectural win. The current code has position (`x`, `y`), tier state (`gridTier`), and visibility (implicit) all tangled. With the tag model:

- **Membership** (`pieces.group_id`) — which group am I in?
- **State** (tag presence) — am I visible, pinned, modified, in overflow?
- **Geometry** (`pieces.x`, `pieces.y`) — where am I on the canvas?

These three axes become independent. Merging two groups becomes an atomic SQL operation on state — no re-layout required. Re-layout becomes an explicit action (drag, "tidy grid" button, group-on-spawn), not a side effect of every tier change.

### 6. Storage shape: join table, not a column

Two options were weighed:

- **Column on `pieces`**: add a `tier_state TEXT CHECK (tier_state IN ('inGrid', 'overflow'))` column. Simpler. Zero additional tables. No joins at query time.
- **Join table `piece_tags(piece_id, tag_name)`**: composite primary key. More extensible for future tags.

**Conclusion: join table wins the moment you want a second tag.** The user's instinct was "I'll want more of these eventually" (overflow/inGrid now, pinned later, scaffoldHidden, modified, focus-mode, etc.). Column approach is a dead end if more tags are plausible. Join table costs ~10% more complexity now and pays off every time a new tag gets added.

Migrating column → join table later is straightforward. Migrating join table → column would be backwards. So the join table is the cheaper one-way door.

### 7. Alphabetical sort is the default, extensible later

Reveal order for the chevron operations is "next N in alphabetical order" by default. A future `groups.sort_order` column could support other orderings (modified date, size, manual pin order, etc.) — the chevron SQL just changes which `ORDER BY` clause it uses. The rest of the mechanism stays identical.

### 8. Chevron visibility becomes derived, not stored

The existing code has `showMore` / `showLess` boolean flags computed inside `computeGridLayout` every render. With tags, these become derived from tag counts:

- Show `>` chevron if `count(tag_name = 'overflow' WHERE group_id = X) > 0`
- Show `<` chevron if `count(tag_name = 'inGrid' WHERE group_id = X) > 9`

Both are `SELECT COUNT(*)` queries, cheap, and they literally cannot drift from actual state because they **are** the state. The `groups.gridTier` integer column becomes unnecessary — tier is emergent from how many `inGrid` tags a group currently has.

### 9. Initial state at folder spawn is deterministic

When a folder is dragged/double-clicked to spawn on the canvas:

```
if fileCount <= 9:
    tag all pieces 'inGrid'
else:
    tag first 9 (alphabetical) 'inGrid'
    tag the rest 'overflow'
```

Two batch inserts in a single transaction, fully deterministic, no simulation of clicks required. The folder-to-canvas PRD's "spawn as collapsed pill, expand to 3×3 grid" flow falls out naturally because the chevron visibility derives from the same tag counts.

---

## Stress tests applied during discussion

- **Nested folder groups:** each nested group has its own `inGrid`/`overflow` tag set scoped by `group_id`. No coordination between levels. Nesting falls out for free because tags are per-(piece, group) scoped.
- **Interaction with scaffold-level hide:** `hidden_paths` (the existing table driving scaffold visibility) and the tag table compose through `buildHiddenPieceIds`. A piece can be hidden by either mechanism; union wins. If scaffold-hidden, overflow state doesn't matter — scaffold hide takes precedence.
- **File added/removed on disk:** scan detects new file → append to group membership + tag as `overflow` (or `inGrid` if tier has room) → piece domain gets notified → render updates. Alphabetical re-sort happens at query time, no explicit re-partition.
- **Piece dragged out of group on canvas:** remove from group, clear any tier-state tag. Clean up in a single transaction.
- **Click `<` at minimum tier (3×3):** no-op. Either enforce via query (`LIMIT 0` when visible count would drop below 9) or hide the chevron entirely when count is at minimum.
- **Collision with currently-rendered chevron position bug:** pre-existing issue in `computeGridLayout` (chevron `X` computed as `originX + 0` when no subfolders present). Out of scope for the tag work, but the tag model makes the fix easier because chevron position can derive from the tag-based visible count rather than recomputing from layout geometry.

---

## Things considered and rejected

### Discord roles as the explaining analogy

**Rejected per user preference.** The underlying mechanism is essentially identical to Discord's role-based permission system (presence-only, central registry, cheap checks, composable, no payloads), and that analogy is a powerful shorthand for anyone who's used Discord. But Discord carries cultural baggage right now, and referencing it in docs or conversations could distract from the technical point. Use "capability-based permission model" or just "capability framing." The concept stands on its own without needing the analogy.

### Tags with payloads (e.g., a `Nested` tag pointing at a parent group)

**Rejected.** A tag that carries data is really a relationship, and relationships belong in foreign key columns, not in tag tables. The specific proposal that came up was a `Nested → parent_group_id` payload for the drag-folder-onto-folder UX. The UX is good and worth keeping; the storage should be a `groups.parent_group_id` foreign key with proper referential integrity, and the drag UX just modifies that column. Tags stay presence-only.

### A negative-tag single model (`overflow` tag hides, absence means visible)

**Rejected in favor of dual-tag swap.** With a single `overflow` tag that hides pieces, every state transition is either INSERT or DELETE — asymmetric, and "untagged = default visible" is implicit logic that the database can't enforce. The dual tag model makes every piece's state explicit and every transition a symmetric UPDATE, which is cleaner to reason about and easier to constrain at the DB level.

### A single `tier_state` column on `pieces` instead of a join table

**Rejected for extensibility.** Column is simpler for exactly one tag type. The moment you want two (overflow + pinned, or overflow + scaffoldHidden), the column approach starts bolting on more columns or overloading the single one. Join table costs one extra table and one extra index now, and adding the second/third/fourth tag is zero-schema-change.

### Manual staging folder for prototype→main migration

**Rejected.** Came up during the prototype-environment discussion. User proposed tracking every edited file in a parallel staging folder for eventual migration. But git already does this job via branches, commits, diffs, cherry-picks, and patches — the staging folder would be a worse manual reinvention. Let git handle it; I drive git during migration.

---

## Risks named by the user

- **"What if we both love an idea that's actually bad?"** — legitimate concern about shared enthusiasm masking a flaw neither of us notices. Mitigation: capture-then-wait habit, explicit disconfirming questions, prototype-with-cheap-exit before committing, outside perspective from cold rereads of captured docs.
- **Unfamiliar territory (database work)** — user named "I'm deeply uneducated in DB context" as a real anxiety. Mitigation: SQLite is forgiving, migrations are cheap, tables are easy to add/remove, the prototype-with-exit approach means the downside is bounded to "spent a weekend on a branch that got deleted."
- **Big-lift concern** — this is a real refactor if pursued. Mitigation: the incremental path is "add the `piece_tags` table lazily without touching any existing code paths, cut over exactly ONE feature (overflow/inGrid) first, keep the old paths alive behind a flag, use it for a week, then decide." Worst case: delete the branch, no harm done.
- **Loss of Litria history on migration** — earlier idea of nuking the old repo and replacing with the prototype was named as risky (would lose months of commit history, PR references, tags). Mitigation: if the prototype proves out, re-apply the changes to the real Litria repo via a feature branch + PR through the normal workflow. The prototype is a learning environment, not a replacement codebase.

---

## Path forward — if this is pursued

**No commitment yet.** If and when the decision is made to build this, the recommended approach is:

1. **Sit with the idea.** Re-read this doc cold in a week or two. If it still feels right with fresh eyes, that's a stronger signal than "liked it during the ideation session."
2. **Prototype in physical isolation.** Either a local repo copy with `git remote remove origin`, or a backup-then-work-in-place with branch discipline. The conversation landed on "backup-then-work-in-place" as the simplest option given the user's existing PR workflow, but clone-with-remote-removed is also valid for stricter isolation.
3. **Add the `piece_tags` table without using it.** New SQLite migration, new table, populated lazily. Existing code continues untouched.
4. **Cut over exactly ONE feature.** The folder-spawn overflow/inGrid flow. Just that. Everything else (scaffold hide, group collapse, etc.) keeps using the current model.
5. **Keep the old code paths alive behind a flag or config** so rollback is an `if` statement flip, not a revert.
6. **Use it yourself for a week** before touching any other state. If it feels cleaner and nothing desyncs, migrate additional state. If it feels worse, delete the branch and walk away.
7. **Only after validation**, migrate back to the real Litria repo via a normal feature branch + PR flow. Preserve git history; don't nuke and replace.

---

## Open questions worth answering before building

- **Exact scope of `piece_tags`**: just pieces, or should it handle groups too (e.g., a `nested` boolean tag on groups as a denormalized convenience alongside the real `parent_group_id` foreign key)?
- **Tag registry file location**: `src/domain/tags.js` for code constants, `docs/architecture/tag-registry.md` for human-facing semantics, both?
- **DB-level mutual exclusion enforcement**: UNIQUE index on `(piece_id, tier_dimension)` or CHECK constraint? Both work; CHECK is slightly more explicit.
- **Migration of existing data**: when the table ships, do existing pieces in existing groups get their `inGrid`/`overflow` tags populated lazily on first expand, or backfilled in a migration? Lazy is simpler; backfill is more predictable.
- **Interaction with undo/redo**: should tag state changes be undoable? Probably yes (undoing a `>` click should restore the previous tier), which means tag transitions need to emit history actions like other domain commands.
- **Interaction with `hidden_paths`**: two hide systems now — the existing path-based cascade and the new piece-id-based tag. They should compose cleanly through `buildHiddenPieceIds`, but the composition rules need to be explicit so precedence is clear.

---

## Reference

- **Memory entry:** `design_tag_capability_framing` (agent memory) — captures the dual framing principle (state internally, capability externally) for future sessions
- **Related PR:** #39 `fix(canvas): folder-spawn pieces lay out in a 3-col grid instead of stacking` — the pragmatic fix that deferred the tier reveal
- **Related PRD:** `docs/prds/folder-to-canvas-prd.md` — the original spec for progressive tier reveal that was never fully implemented
- **Related feedback:** `docs/feedback/macos-feedback.md` item #21 (folder spawn grid), item #23 (scaffold drawer hide button broken)
- **Related existing code:** `src/utils/gridLayout.js` (`computeGridLayout`, tier definitions), `src/app/selectors/workspaceSelectors.js` (`buildHiddenPieceIds`), `src-tauri/src/db/schema.rs` (`hidden_paths` table — the existing cascade-hide mechanism)
- **Architecture guard precedent:** `scripts/domain-contract-guard.mjs` — the existing pattern a future `tag-contract-guard.mjs` would follow

---

## Meta: how this doc should be used

This is a **capture doc**, not a spec. Its job is to preserve the thinking from a long ideation session so future-us can pick it up without having to re-derive every conclusion. It deliberately includes both the decisions and the reasoning behind them, including things considered and rejected, so the rationale is recoverable.

If the tag system is eventually built, this doc should inform an ADR (for the decision to build it) and a build plan (for how to build it incrementally). This doc itself stays in `docs/ideas/` and gets marked historical at that point — its purpose was to capture the pre-commitment thinking, not to serve as the implementation reference.

If the tag system is **not** built, this doc still has value as a record of the tradeoffs considered, so a future decision not to pursue it can be made with full context rather than having to re-derive everything.
