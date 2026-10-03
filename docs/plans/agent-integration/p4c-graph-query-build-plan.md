# P4c graph query: build plan

Status: Proposed, 2026-10-03, as the arc for one unattended build-and-review run
([unattended arc policy](../../../Agents/docs/unattended-arc-policy.md)). One
agent builds the whole checklist, a second agent reviews the result once, and
nothing merges without the owner.
Revised 2026-10-03 after the first review: the reviewer's provider stopped
that review partway with a content-safety refusal while it probed the
disclosure policy, but not before it found the defects listed under
"First review" below. Each was reproduced against `e6e0285` and became one of
tasks 9–17. The next review is done by a Claude reviewer (owner decision).

Authority: [Project API contract brief](brief-project-api-contract.md) §4.5
(revisions), §5 (effective reads), §6 (disclosure policy), §7.4 (graph query)
and §10 (budgets). Sequencing and tests: the
[Project API build plan](project-api-build-plan.md), section "P4. Graph query".
This document owns the delivery checklist and the decisions recorded below; it
does not override the brief. Where the brief is silent and you must choose,
choose the narrowest reading and record it under Evidence.

## Goal

`litria_graph_query` returns a bounded, path-identified neighbourhood of import
relationships, with derived provenance and honest per-node freshness (brief
§7.4). With it, P4 is complete.

## Owner decisions (2026-10-03)

1. **Rust mints every disk revision.** Text that reaches `SyntaxDomain` from
   disk carries the revision Rust computed for the bytes it read
   (`reader::disk_revision`); a write through Litria reports the revision of the
   bytes it wrote. JavaScript never re-implements the disk hash. Editor text
   carries the JavaScript buffer revision (`bufferRevision` in
   `src/app/projectApiBridge.js`).
2. **One arc, one run.** Everything below is built in this run.

## Tasks

- [x] Parsed revisions: SyntaxDomain records, for each registered file, the source (`editor` or `disk`) and revision of the text it parsed, exposed through a read-only selector; a registration without a revision records none.
- [x] Every path that registers text in SyntaxDomain supplies its revision: editor open and change, discovery, the tab-close re-index, the filesystem write manager's re-index, and adapter writes; a rename carries the entry's parsed revision to the new path.
- [x] Provenance per connection, the off-canvas pending-edge set and a discovery-in-flight signal are available to the owner bridge.
- [x] Bridge operation `workspace.graph`: a frontier-scoped request answered with node facts and incident edges, bounded and refusing cleanly; JavaScript answer, Rust contract types, fixtures and regenerated artifacts.
- [x] Tool `litria_graph_query` (capability `project.graph.read`): contract types, catalog entry, advertised limits and the Rust handler, with the policy applied before each expansion, ceilings with truncation flags, per-node freshness and the summary with its reasons.
- [x] Tests: everything in the build plan's P4 Tests list and every sequence under "Sequences that must hold" below, in JavaScript and Rust.
- [x] Docs: build-plan slice map (P3 row Done with PR #90; P4 row Done, PR pending), a P4c record in the build plan, the Domain Register entry in `docs/Orchestration.md`, and `docs/rust-command-contracts.md` for any command added.
- [x] Record evidence under Evidence below; check:architecture, test:domains, build and cargo test pass, and `cargo build` has zero warnings.
- [ ] Bridge paths: the graph snapshot converts absolute SyntaxDomain keys (edges and parsed revisions) to the project-relative paths that pieces and requests use, proven by a test that drives the real SyntaxDomain and adapter with an absolute project root (first review 1).
- [ ] Manual wires: the production graph port reads canvas connections, so a wire with no syntax edge appears as a `manual` edge through the production snapshot, not an injected one (first review 2).
- [ ] Policy at every step: every frontier path, every edge endpoint and every folder is resolved with `identity` before it becomes a node, a folder, an edge endpoint or the next frontier; a path whose identity is `Denied` (for example reached through a junction or link into `.git`) never appears and is never walked through (first review 3 and 8).
- [ ] Closed neighbourhood: every returned edge's endpoints are returned nodes; at the outer boundary of the requested depth an endpoint is policy-checked and returned as a node, or the edge is dropped (first review 4).
- [ ] `maxNodes` limits the walk: expansion stops when the node budget is reached, no edge reaches past the returned nodes, and the truncation is flagged (first review 5).
- [ ] The encoded response never exceeds the dispatcher's response ceiling, including the truncation fields themselves (first review 6).
- [ ] Symbol truncation at 50 per edge is flagged in the response (first review 7).
- [ ] Discovery-in-flight signal: true while a refresh is armed but not started, and a previous project's run finishing never clears the current project's signal (first review 9 and 10).
- [ ] Off-canvas files get the same node facts as on-canvas ones, including `discoverable` from the file name, proven by a test (first review 11).

## Requirements

### Parsed revisions (tasks 1–2)

- Store `{ source: 'editor' | 'disk', revision }` per file next to the text, and
  carry it through every place the text cache changes (register, write, rename,
  unregister, forget, reset). `getFileRevision` (the entry counter from PR #107)
  is an identity, not a content revision: do not use it for freshness, and do
  not remove it (the tab-close fence depends on it).
- SyntaxDomain stays dependency-free: callers pass revisions in; the domain
  never computes one. Respect the architecture guard about where shared helpers
  may live.
- **Disk text:** add a Rust read that returns `{ text, revision }`, the revision
  from `disk_revision` over the exact bytes read (today's `read_project_file`
  uses `fs::read_to_string`: strict UTF-8, no BOM stripping). Do not change the
  return type that existing `readProjectFile` callers rely on; add a variant and
  use it on the syntax registration paths. Discovery registers through it
  (`useDiscoveryLifecycle.js`), and so do the tab-close re-index and
  `getAuthoritativeText` callers in `src/lsp/syntaxAdapter.js`, and the
  filesystem write manager's re-index.
- **Writes:** a write through Litria (the adapter's `writeResultText` path)
  records the disk revision of the bytes written, reported by Rust. Callers that
  treat the writer's result as success or failure must keep working (ADR-032 D3:
  the writer resolves true on success, false on failure).
- **Editor text:** the revision is `bufferRevision` of the text registered,
  which must equal what the bridge reports for that session document.
- Any path you cannot give a revision records none, so its node reads
  `unknown`, never `current`.

### Bridge inputs (task 3)

- Provenance: a read-only SyntaxDomain selector, or derivation inside the bridge
  from `getEdgeIdForConnection`, whichever keeps SyntaxDomain dependency-free.
- The pending-edge set is local state in `src/app/useOffCanvasImports.js`
  today and is not returned. Expose it read-only to the bridge's ports.
- `useDiscoveryLifecycle` exposes no "run in flight" signal. Add one that is
  true while an initial run or a refresh is reading files or armed but not yet
  started.
- `useProjectApiBridge` is called in `src/App.jsx` before
  `useSyntaxDomainLifecycle`, `useOffCanvasImports` and `useDiscoveryLifecycle`.
  Pass refs or move the call; either way the app-shell guard decides what
  App.jsx may contain.

### Bridge operation `workspace.graph` (task 4)

- A whole-project snapshot could exceed the 512 KiB bridge reply ceiling, so the
  operation is **frontier-scoped**: the request names a set of project-relative
  paths and a direction; the reply carries, for each requested path, its node
  facts, and the edges incident to it in that direction, each naming its other
  endpoint by path. Rust drives the walk one level at a time and calls the
  operation once per level (depth is at most 2).
- Node facts: whether a piece for the file is on the canvas, the folder group
  containing that piece (its `folderPath`, or an opaque group id for a legacy
  group without one), the parsed `{ source, revision }` if recorded, and whether
  the file's language has relationship discovery (`isDiscoverableFilename`).
  The reply also carries the discovery-in-flight signal.
- Edge facts: importer path, exporter path, symbols (name and kind), provenance
  (`sourceDerived` with the SyntaxDomain status, or `manual`), and whether it is
  drawn on the canvas. Off-canvas discovered edges come from the pending-edge
  set (build plan rule: the graph is built from pieces, wires and pending
  edges, never from raw registrations, and an edge's paths may be stale).
- Bound it like the other operations (`MAX_REPLY_BYTES`, per-request counts,
  an `omitted` count when something does not fit), map absolute SyntaxDomain
  keys to project-relative paths with the bridge's existing helpers, and refuse
  with the existing refusal codes. Add the operation to `BRIDGE_OPS`, the Rust
  bridge catalog, samples, fixtures and the fixture manifest.

### Tool `litria_graph_query` (task 5)

- **Request:** a focus (a path, or the current selection via the existing
  `workspace.selection` operation), `depth` 1–2, `direction` `imports`,
  `importedBy` or `both`, and `maxNodes` (default 50, server ceiling 100).
  Edges ceiling 500, symbols per edge 50 (brief §10). Advertise the limits in
  `ServerLimits` alongside `files_read`, `files_search` and `project_context`.
- **Policy first:** classify every path with the same calls search uses
  (`identity` then `classify`); only `Allowed` paths become nodes. `Denied` and
  `Unindexed` paths are dropped before the next expansion, so a walk never
  passes through them, and every edge touching a dropped path is dropped. A
  focus that is not disclosed is answered exactly as `litria_files_read`
  answers that path, revealing nothing more.
- **Nodes and edges:** file nodes carry their folder and on-canvas flag; folder
  nodes stand for the folder groups the returned file nodes belong to (legacy
  groups by opaque id). Edges run from importer to exporter.
- **Ceilings:** stop at `maxNodes`, 500 edges and 50 symbols per edge, and say
  so with truncation flags. The encoded response must stay under the
  dispatcher's response ceiling by construction, never by error.
- **Freshness, per node** (brief §7.4): the effective source is the editor when
  the session document is open or dirty (the existing buffer index), otherwise
  disk (`read_disk`, minting `disk_revision`). `current` when the parsed
  revision equals the effective revision from the same source; `stale` when
  both are known and differ, including a different source; `unknown` when no
  parsed revision is recorded, the effective revision cannot be observed, or
  the buffer index omitted the document.
- **Summary:** `current` only when every returned node is. Otherwise `partial`
  or `unavailable`, with reasons: files without a parsed revision, a discovery
  run in flight, stale or unknown nodes, a language without relationship
  discovery (`unavailable` when the focus itself has none).
- Run inside `workspace::fenced` like the P3 handlers, with a testable twin over
  a scripted owner, and register the operation in the dispatcher. Add it to the
  operation list hard-coded in `src-tauri/src/project_api/context.rs` tests (in
  name order).

## Sequences that must hold

Each needs a test. An arc that names only the goal gets exactly the goal.

- **Direction:** SyntaxDomain stores edges as `sourceFilePath` = exporter,
  `targetFilePath` = importer, and discovered wires run exporter piece to
  importer piece. The contract wants importer to exporter. Test that
  `imports` from a file returns what it imports, not what imports it.
- **Status values:** the domain has `orphaned` in addition to the brief's
  `pending`, `resolved`, `broken`, `drifted` and `unused`. Decide how it is
  reported and record it.
- **Policy:** a denied file between two allowed files at depth 2 never appears,
  and the walk does not continue through it; an `Unindexed` file is not
  enumerated; a denied endpoint removes the edge; a denied focus reveals
  nothing a read would not.
- **Freshness:** disk text changed after parsing with no open buffer is
  `stale`; a buffer edited after parsing is `stale` until it is re-registered;
  no recorded revision is `unknown`; a document the buffer index omitted is
  `unknown`; a file parsed from disk and then opened and re-registered from the
  editor is `current` again, and so is a closed tab re-indexed from disk.
- **Lifecycle:** a project switch or reset during the query ends in
  `workspaceChanged` (the epoch fence), never another project's nodes; a rename
  carries the parsed revision to the new path; a delete or reset drops it; a
  write records the revision Rust reports for the bytes written.
- **Index state:** `partial` while discovery is in flight; `unavailable` for a
  focus language without relationship discovery.
- **Bounds:** truncation at `maxNodes`, at 500 edges and at 50 symbols per edge;
  a reply that would exceed the bridge ceiling is bounded with `omitted`, not
  refused as internal.
- **Canvas shapes:** an off-canvas discovered edge (from the pending-edge set),
  a manual wire with no syntax edge, a file in a folder group and one in a
  legacy group.

## First review (2026-10-03)

The reviewer worked against `e6e0285` and was stopped by its provider before it
wrote a report. These findings come from its notes and reproduction scripts,
and were re-run against the same commit before being written here. All are
reproduced unless marked suspected.

1. **Paths never meet.** The bridge snapshot keeps SyntaxDomain's absolute keys
   (`C:/…/src/app.js`) while pieces and requests use project-relative paths, so
   a query for `src/app.js` returned no edges and `parsed: null`. In production
   the graph is empty.
2. **Manual wires are never read.** The production graph port is never given the
   canvas connections; the manual-wire test inserts an edge directly. A wire
   with no syntax edge produced no edge.
3. **Policy bypass through a link.** The walk resolved identity only for the
   seed paths. With `alias` a junction to the denied `.git` directory,
   `identity("alias/secret.ts")` returned `Denied`, yet `alias/secret.ts` was
   returned as a node and the walk continued through it to `c.ts`.
4. **Dangling edges.** At depth 1 the result listed only the focus as a node
   while returning an edge to its neighbour; at depth 2 an edge reached a file
   that was not returned or checked.
5. **`maxNodes` applied late.** With `maxNodes: 1` the walk still expanded twice
   and returned two edges.
6. **Response ceiling overrun.** A response truncated for size was still over its
   ceiling (210 bytes against 197 in a scaled test; 393 221 against the
   production 393 216).
7. **Symbols cut silently** at 50 per edge, with no flag (suspected; confirm with
   a test).
8. **Denied folder disclosed.** A node in a folder group at `.git` returned
   `folder: ".git"` and a `.git` folder node.
9. **Discovery signal false while a refresh is armed** (`signal: false` after a
   refresh was scheduled and before it read anything).
10. **Discovery signal cleared by the previous project.** With runs for project A
    and project B both reading, A's run finishing set the signal to false while
    B's run was still reading.
11. **Off-canvas facts.** An off-canvas `.js` focus reported `discoverable: false`
    (suspected; confirm with a test, and record it if it is intended).

The review never reached freshness or lifecycle in depth. The next reviewer
should cover them as well as tasks 9–17.

**For tasks 9–17,** write each test first, run it against `e6e0285` (it must
fail, except the two suspected items, which may turn out correct), and record
the result under Evidence. Rust link tests: `src-tauri/src/project_api/reader.rs`
has `a_junction_into_a_denied_directory_is_denied` and a `junction` helper
(Windows `mklink /J`, no privilege needed; remove the junction before the tree).

**Reviewer:** put any scratch reproduction files in the operating system's temp
directory, never inside the repository copy; files created in the copy mark the
review as modified.

## Models and commands

- P3 is the model for a new tool end to end (merge commit `97ce1f5`):
  `src-tauri/src/contracts/project_api/files_search.rs` (operation, request,
  result, `Validate`), `contracts/project_api/mod.rs` (catalog, test
  dispatcher, samples), `contracts/project_api_bridge/workspace.rs` (a bridge
  operation), `contracts/fixtures.rs` and the manifests,
  `src-tauri/src/project_api/search.rs` and `context.rs` (handlers, scripted
  owners, end-to-end tests over a real bridge in `project_api/bridge.rs`
  `testing`), and `test/domains/projectApiBridge.test.mjs`.
- Regenerate contract artifacts and fixtures with
  `LITRIA_UPDATE_CONTRACTS=1 cargo test --manifest-path src-tauri/Cargo.toml contracts:: -- --test-threads=1`,
  then run `cargo test --manifest-path src-tauri/Cargo.toml contracts::`
  without the variable to prove there is no drift.
- Use `npm run test:domains` for the JavaScript suite; single files may be run
  with `node --test <file>`.

## Out of scope

P5 diagnostics, P6 MCP conformance, the W track, track T, and the live pass on
a JS/TS scratch project (the owner runs it after the review).

## Evidence

### Build pass 1 (2026-10-03) — the parsed-revision foundation (tasks 1–2)

This run built the freshness foundation the graph query reads from, end to end,
and left the bridge op and the Rust tool for the following passes. Journal:
`.research/2026-10-03-p4c-graph-query-build.md`.

**Task 1 — parsed revisions in SyntaxDomain.** `src/app/syntaxDomain.js` now
stores a `parsedRevisionIndex` entry `{ source: 'editor'|'disk', revision }` per
file, set through the single `_putText` chokepoint and cleared through
`_dropText` (so register/notify/rename/unregister/forget/reset all stay
consistent), and exposes it read-only through `selectors.getParsedRevision`. The
domain never computes a revision: callers pass one in, and a malformed or absent
argument records none (the node then reads `unknown`, never `current`). This is
kept distinct from the identity counter `getFileRevision` (PR #107), which the
tab-close fence still depends on.

**Task 2 — every registration path supplies its revision.**
- Editor open/change and editor-backed writes: `src/lsp/syntaxAdapter.js`
  imports `bufferRevision` from `src/app/projectApiBridge.js` (the same function
  the owner bridge reports for a session document) and registers editor text as
  `{ source: 'editor', revision }`. `src/lsp` is not a domain prefix, so the
  architecture guard permits the import; the guard passes.
- Disk reads mint their revision in Rust (owner decision 1). New command
  `read_project_file_with_revision` (`src-tauri/src/commands.rs`,
  `src-tauri/src/project_ops.rs`) returns `{ text, revision }`, the revision
  being `project_api::reader::disk_revision` over the exact bytes read; the
  legacy `read_project_file` is unchanged. JS wrapper
  `readProjectFileWithRevision` (`src/project/storage.js`), surfaced through
  `projectDomain` and threaded by `App.jsx` into the syntax lifecycle, the
  discovery lifecycle and the filesystem write manager.
- Discovery (`useDiscoveryLifecycle.js`), the tab-close re-index
  (`syntaxAdapter.onFileClosed`), the write manager's re-index
  (`filesystemWriteManager.js` `readForReindex`) and adapter disk writes
  (`writeResultText` re-reads the written bytes' revision) all register disk
  text as `{ source: 'disk', revision }`. A rename carries the entry's parsed
  revision to the new path (`syntaxDomain.renameFile`).

**Task 3 (partial).** The three bridge inputs are each exposed read-only from
their owners: `getProvenanceForConnection` / `getAllEdgeProvenance` on
SyntaxDomain (derived from the edge, so the domain stays dependency-free);
`getPendingEdges` on `useOffCanvasImports` (live via a ref); `isDiscoveryInFlight`
on `useDiscoveryLifecycle` (true while an initial run or refresh is reading, or
armed but not yet started). They are not yet injected into
`useProjectApiBridge`'s ports — that wiring is defined by the `workspace.graph`
op (task 4) and lands with it.

**Decisions where the brief was silent.**
- A write through Litria records its disk revision by re-reading the written
  bytes through `read_project_file_with_revision` (Rust mints it, per §4.5). The
  writer's success/failure boolean is unchanged (ADR-032 D3). If the re-read
  cannot run, the file records no revision (reads `unknown`, never a wrong
  `current`).
- `orphaned` (a SyntaxDomain status not in the brief's `pending`/`resolved`/
  `broken`/`drifted`/`unused`) will be reported as its own string inside the
  `sourceDerived` provenance when the graph query is built; a reader that does
  not know it treats it as a non-`current` reason. Recorded here for task 5.

**Tests added (all pass).**
- `test/domains/syntaxParsedRevisions.test.mjs` (13 tests): records/clears
  per-source revisions through every mutation, rename carry-over, distinctness
  from the identity counter, and the provenance selectors.
- `test/domains/syntaxAdapterRevisions.test.mjs` (5 tests): editor open/change
  register the buffer revision; tab-close re-indexes with the disk revision; a
  closed-file write and an editor-backed write record the right source/revision.
- Existing suites updated for the new read path:
  `test/domains/discoveryProjectSwitch.test.mjs` stub answers
  `read_project_file_with_revision`.

**Check results (2026-10-03, Windows).**
- `npm run check:architecture` — all seven guards pass.
- `npm run test:domains` — 1462 passed, 0 failed.
- `npm run build` — built (the usual chunk-size advisory only).
- `cargo test --manifest-path src-tauri/Cargo.toml` — 525 passed, 0 failed.
- `cargo build --manifest-path src-tauri/Cargo.toml` — finished with zero
  warnings.

### Build pass 2 (2026-10-03) — bridge inputs and the `workspace.graph` op (tasks 3–4)

This run wired the three bridge inputs and built the `workspace.graph` bridge
operation end to end (both sides of the contract), leaving the `litria_graph_query`
tool and its tests/docs for pass 3.

**Task 3 — bridge inputs available to the owner bridge.** `src/app/useProjectApiBridge.js`
gained a `graph` port that reads a `graphOwnersRef` populated in `src/App.jsx`
after the syntax, off-canvas and discovery hooks run (the bridge call precedes
them, so a ref carries the later owners; the app-shell guard passes). The port
builds its snapshot through `graphSnapshot(...)` from: SyntaxDomain
`getAllEdgeProvenance()` and `getParsedRevision()`, `useOffCanvasImports`'
`getPendingEdges()`, `useDiscoveryLifecycle`'s `isDiscoveryInFlight()`, and
`PieceDomain`/`GroupDomain` for on-canvas and folder-group facts. The ref is
re-pointed every render, so the port reads the latest state at request time.

**Task 4 — `workspace.graph`, both sides.**
- JavaScript answer: `graphSnapshot(...)` and `answerGraph(request, snapshot, ceiling)`
  in `src/app/projectApiBridge.js`, dispatched for the new `BRIDGE_OPS.graph`.
  Frontier-scoped: the request names `paths`, a `direction`
  (`imports`/`importedBy`/`both`) and `maxEdgesPerNode`; the reply carries per
  path its node facts and incident edges (importer→exporter, flipping
  SyntaxDomain's exporter=source/importer=target), the discovery-in-flight
  signal, and an `omitted` count. Bounded by `MAX_REPLY_BYTES`, the per-node
  edge ceiling and 50 symbols per edge; a malformed request refuses
  `invalidRequest`. The graph is built from pieces, wires and pending edges,
  never raw registrations.
- Rust contract types: `GraphOp` and its request/result types in
  `src-tauri/src/contracts/project_api_bridge/workspace.rs` (frontier, direction,
  node facts, edges, `parsed {source,revision}`, provenance incl. the domain-only
  `orphaned` status, bounds and `Validate`). Registered in the bridge `catalog()`
  and `samples` (`graph_event`), with the fixture matcher wired in `fixtures.rs`.
- Fixtures and artifacts: `workspace.graph.request.json` (what Rust emits),
  `workspace.graph.reply.json` (an on-canvas folder-group file, an off-canvas
  exporter, a `sourceDerived` edge with a status and a `manual` wire) and
  `workspace.graph.reply.unknown-field.json` (strictly rejected), listed in the
  bridge fixture manifest; artifacts regenerated with `LITRIA_UPDATE_CONTRACTS=1`
  and verified drift-free.

**Decision where the brief was silent.** The bridge op reply carries both
`folder` and an opaque `groupId` as mutually exclusive node fields: a piece in a
folder group reports `folder`; a legacy group without a `folderPath` reports a
stringified group id as `groupId`. The JS answer omits whichever is absent.

**Tests added (all pass).** `test/domains/projectApiBridgeGraph.test.mjs` (15
tests): direction (imports vs importedBy vs both), node facts (folder, on-canvas,
parsed revision, discoverability), legacy group id, absent parsed revision,
off-canvas pending edges, a manual wire, the discovery-in-flight signal, the
`orphaned` status, per-node and per-edge-symbol ceilings, a reply bounded by the
byte ceiling (never refused), clean refusal of malformed requests, and a lone
frontier node. The Rust contract tests cover the new op's schemas, fixtures and
reply boundary.

**Check results (2026-10-03, Windows).**
- `npm run check:architecture` — all seven guards pass (incl. app-shell).
- `npm run test:domains` — 1477 passed, 0 failed.
- `npm run build` — built (usual chunk-size advisory only).
- `cargo test --manifest-path src-tauri/Cargo.toml` — 525 passed, 0 failed.
- `cargo build --manifest-path src-tauri/Cargo.toml` — zero warnings (the
  `workspace.graph` contract family is `allow(dead_code)` until its Rust
  consumer, the `litria_graph_query` handler, lands in pass 3).

### Build pass 3 (2026-10-03) — the `litria_graph_query` tool (tasks 5–8)

This run built the tool end to end, its tests and the docs, completing the arc.

**Task 5 — `litria_graph_query` (capability `project.graph.read`).**
- Contract types: `src-tauri/src/contracts/project_api/graph_query.rs` — the
  request (focus/depth/direction/maxNodes with `Validate`), the result
  (`focus` outcome, file and folder `nodes`, importer→exporter `edges` with
  symbols and provenance, `summary` index state, `reasons`, truncation flags),
  and the enums (`Freshness`, `IndexState`, `IndexReason`, `TruncationReason`,
  `EdgeProvenance`). Registered in the family catalog, test dispatcher and
  `samples::graph_query_result()` in `contracts/project_api/mod.rs`.
- Advertised limits: a `graph` block in `ServerLimits`
  (`contracts/project_api/project_context.rs`), filled from the tool's constants
  in `project_api/context.rs` `limits()`, and in the sample.
- Handler: `src-tauri/src/project_api/graph_query.rs`, run inside
  `workspace::fenced`. It resolves the focus with the same policy a read applies
  (a denied or invalid focus reveals nothing; absent focus uses the disclosed
  selection), then walks breadth-first one level per `workspace.graph` call up to
  `depth`. Only allowed paths are ever requested, so a denied or unindexed file
  is never enumerated and the walk cannot pass through it; every edge touching a
  non-allowed endpoint is dropped. It bounds nodes at `maxNodes`, edges at 500
  and symbols at 50 per edge with truncation flags, folds the bridge op's
  `omitted`, computes per-node freshness against the effective revision (the
  buffer when open or dirty, else disk via `read_disk`), builds folder nodes for
  the groups the file nodes belong to, and summarises the index state with its
  reasons (`current` only when every node is; `unavailable` when no seed is
  discoverable; otherwise `partial`). Registered in the dispatcher
  (`project_api/mod.rs`) and in the name-ordered operation-list test in
  `project_api/context.rs`. Building the handler retired the `allow(dead_code)`
  on the `workspace.graph` contract family.

**Task 6 — tests.** 21 Rust handler tests in
`project_api/graph_query/tests.rs` over a scripted, adjacency-driven owner: the
direction rule (`imports` returns what a file imports, not what imports it);
policy (a denied endpoint removes the edge and the node, a denied file between
two allowed files is never traversed at depth 2, an unindexed endpoint is not
enumerated, a denied/invalid focus and an empty selection, the selection as
focus); freshness (disk changed after parsing is stale, a buffer edited after
parsing is stale until re-registered, no recorded revision and an omitted index
are unknown, re-registered from the editor is current again); index state (the
summary is current only when every node is, discovery in flight is partial, a
focus without relationship discovery is unavailable); canvas shapes (an
off-canvas discovered edge, a manual wire, a folder group and a legacy group,
and the `orphaned` status reported as itself); bounds (truncation at maxNodes,
at the symbol ceiling, and a reply bounded by the encoded ceiling, not refused);
and lifecycle (a bridge `workspaceChanged` propagates), plus an end-to-end pass
over the real bridge with the epoch fence. The JavaScript owner's sequences
(direction, bounds, canvas shapes, `orphaned`, freshness inputs) remain covered
by `projectApiBridgeGraph.test.mjs` from pass 2.

**Decisions where the brief was silent.**
- The `focus` result field mirrors `litria_files_read`'s disclosure outcomes
  (`denied`, `invalidPath`, `unindexed`) so a refused focus reveals nothing more
  than a read would; an allowed focus is `resolved` even when it has no
  neighbourhood, and an absent focus with no disclosable selection is
  `noSelection`.
- Folder nodes are derived from the returned file nodes and do not count toward
  `maxNodes` (that ceiling bounds file nodes, the walk's real cost).
- `orphaned` (and any other domain-only status) is carried verbatim inside
  `sourceDerived`'s `status`; a reader that does not know it treats the node's
  freshness, not the status, as the signal.
- When the buffer index reports `omitted > 0`, a file not in the listed entries
  is `unknown`: the index may have dropped a differing buffer for it, so its
  effective revision cannot be observed.

**Check results (2026-10-03, Windows).**
- `npm run check:architecture` — all seven guards pass (incl. app-shell).
- `npm run test:domains` — 1477 passed, 0 failed.
- `npm run build` — built (usual chunk-size advisory only).
- `cargo test --manifest-path src-tauri/Cargo.toml` — 546 passed, 0 failed.
- `cargo build --manifest-path src-tauri/Cargo.toml` — zero warnings. Contract
  artifacts and fixtures regenerated with `LITRIA_UPDATE_CONTRACTS=1` and
  verified drift-free.

## Blockers

None. All eight tasks are built and all four configured checks pass. The owner's
live pass on a JS/TS scratch project (out of scope, run after the review)
remains the only outstanding acceptance step.
