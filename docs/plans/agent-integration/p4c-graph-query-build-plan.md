# P4c graph query: build plan

Status: Proposed, 2026-10-03, as the arc for one unattended build-and-review run
([unattended arc policy](../../../Agents/docs/unattended-arc-policy.md)). One
agent builds the whole checklist, a second agent reviews the result once, and
nothing merges without the owner.

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

- [ ] Parsed revisions: SyntaxDomain records, for each registered file, the source (`editor` or `disk`) and revision of the text it parsed, exposed through a read-only selector; a registration without a revision records none.
- [ ] Every path that registers text in SyntaxDomain supplies its revision: editor open and change, discovery, the tab-close re-index, the filesystem write manager's re-index, and adapter writes; a rename carries the entry's parsed revision to the new path.
- [ ] Provenance per connection, the off-canvas pending-edge set and a discovery-in-flight signal are available to the owner bridge.
- [ ] Bridge operation `workspace.graph`: a frontier-scoped request answered with node facts and incident edges, bounded and refusing cleanly; JavaScript answer, Rust contract types, fixtures and regenerated artifacts.
- [ ] Tool `litria_graph_query` (capability `project.graph.read`): contract types, catalog entry, advertised limits and the Rust handler, with the policy applied before each expansion, ceilings with truncation flags, per-node freshness and the summary with its reasons.
- [ ] Tests: everything in the build plan's P4 Tests list and every sequence under "Sequences that must hold" below, in JavaScript and Rust.
- [ ] Docs: build-plan slice map (P3 row Done with PR #90; P4 row Done, PR pending), a P4c record in the build plan, the Domain Register entry in `docs/Orchestration.md`, and `docs/rust-command-contracts.md` for any command added.
- [ ] Record evidence under Evidence below; check:architecture, test:domains, build and cargo test pass, and `cargo build` has zero warnings.

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

(Filled in by the builder: decisions taken where the brief was silent, tests
added, failing-first results where a test proves a fix, and check results.)

## Blockers

None recorded.
