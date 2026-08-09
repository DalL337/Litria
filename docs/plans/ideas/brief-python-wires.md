# Brief: Python Wires — Discovery Parity, Symbol Picker, Import Writing

> **For:** Claude Code
> **Scope:** Make python wires behave like JS wires end-to-end: sibling-module
> imports discovered reliably, the symbol picker opens on a py→py wire draw
> listing real python symbols, and picking writes a real python import. Closes
> the "python symbol layer" follow-up from the ADR-020 arc.
> **Stack:** JS (syntax domain, discovery engine); no Rust.
> **Status:** Investigated + drafted 2026-07-17 (journal:
> `.research/2026-07-17-python-wires-symbol-layer.md`). S1 is ready to build.
> S2 has one style decision and one hard sequencing constraint. S3 needs the
> owner's existing deletion-semantics design note.

---

## Context — what python wires do today

- **Discovery (read path, PR #127):** imports that already exist in code are
  parsed and wired on project open — but absolute imports resolve only
  against the source roots (`src/` when present, then project root)
  (`discoveryEngine._pythonSourceRoots`). Script semantics are missing: when
  you run `python main/main.py`, the script's own directory is on `sys.path`,
  so `from tool import shout` beside it is legal — and our engine fails to
  resolve it (verified against the pytest1 layout: `main/main.py` +
  `main/tool.py` → no edge, silently). **This is the "discovery for python is
  broken" the owner hit.**
- **Picker (interactive path):** none for python. `syntaxDomain._refreshFile`
  parses definitions only for JS/TS, so python files have empty symbol
  indexes and `onSyntaxPendingCreated` deliberately skips the picker
  (`supportsSymbols` false — #127's decision, correct while there was
  nothing to list).
- **Import writing:** JS-only. PR #153 (pending merge) hard-gates every
  import-line write site to JS targets after the 2026-07-17 corruption
  (JS stub written over a python file's first import). Python edges exist as
  metadata only.

## Safety constraint that shapes the slicing

On current main, `computeResolveEdits` — the command that writes import
lines when picked symbols resolve — has **no non-JS guard** (verified:
`_isJsTs` gates only the connect-stub and disconnect compute commands). It
is safe today *only because python files have no symbols to pick*. The
moment a python symbol layer exists, a picker pick would route a JS-syntax
import line into a `.py` file — the same corruption class #153 just closed.

**Therefore: the symbol layer and the python import writer are ONE slice.**
Shipping the parser without the writer (or without extending #153's guard
into `computeResolveEdits`) reopens the corruption hole.

Sequencing: merge #153 first — S2 converts its `_canWriteImportLine`
(JS-only boolean) into a per-language writer dispatch, keeping fail-closed
behavior for languages with no writer.

## Design

### S1 — Discovery: importer-directory base for absolute imports

Absolute python imports resolve against, in order:
1. the **importer's own directory** (script/sibling semantics — new),
2. `<root>/src` when a src layout exists (unchanged),
3. the project root (unchanged).

First base that resolves wins (existing `_resolvePyAgainstBases` mechanism —
this is a one-array change plus tests). A wire to a real file is the right
wire visually even when the runtime's actual `sys.path` differs; pyright and
the LED remain the arbiter of whether the import truly resolves at runtime
(established wire-shows-intent / LED-shows-truth division).

### S2 — Python symbol layer + import writer + picker enable (one slice)

**Symbol parser** (`pythonSymbolParser.js`, pure, mirrors jstsSymbolParser):
- Definitions: top-level `def`, `async def`, `class`, and simple module-level
  assignments (`NAME = …`). Nested/indented definitions are not symbols.
- Public vs private: underscore-prefixed names are non-public; when
  `__all__` is literally declared, it defines the public set. Public names
  populate the exports index (`symbolIndex`); ALL top-level definitions
  populate `definitionIndex` — same two-tier shape the JS side uses, so the
  picker's existing "exports first, all defs available" behavior carries
  over unchanged.

**Syntax domain wiring:**
- `_refreshFile` dispatches by extension: JS/TS → jsts parser (unchanged),
  `.py` → python parser. `.pyi` stays excluded (types, not structure —
  consistent with discovery).
- `supportsSymbols` becomes js || py → the picker opens for py→py wires
  through the existing `onSyntaxPendingCreated` path with zero picker-side
  changes.
- Discovered python edges gain pre-resolved symbol chips for free
  (`createConnectionsForEdges` already looks up definitions).

**Import writer** (python-aware composition):
- #153's `_canWriteImportLine(edge)` generalizes to a writer dispatch:
  `js` writer (existing, unchanged), `python` writer (new), no writer →
  fail closed exactly as today.
- Python composition: `from <module> import <a, b>` — module spec derived
  by the SAME base order as S1 discovery (importer-dir sibling → bare
  module; src-root package → dotted path). Absolute imports only in v1
  (no relative dots) — **open owner decision below**.
- Merging: if the target already has `from <module> import …`, union the
  names into that line (mirror of the JS clause-union path). Insertion
  point: after the last top-level `import`/`from` line (python-aware
  finder — the current one only recognizes JS `import` and returns line 0
  for python files, which is exactly what made the #153 corruption
  destructive).
- **No TODO stub for python.** There is no valid empty python import, so a
  py edge stays *lineless* until the first symbol is picked; the writer
  locates/creates the line from authoritative text at write time.
  `importLine` stays null (already the #153 contract for non-JS). This also
  sidesteps the stale-stored-line fragility noted in #153 for the python
  path entirely.

### S3 — Wire deletion semantics (DECIDED + built, owner decision 2026-07-17)

**Edge deletion is state-only for EVERY language** — "deletion of an edge
should not touch a file either way" (owner, 2026-07-17; ratified for all
wires, not just python). Deleting a wire removes it from canvas/domain
state and never edits code. Consequences, accepted explicitly:

- Because imports are authoritative, discovery re-derives the wire on the
  next project open as long as the import exists — wire deletion is
  session-scoped decluttering. Permanently removing the relationship means
  removing the import in the editor; the code is the source of truth.
- This CHANGED the JS path: it previously deleted the generated import
  line on disconnect. `handleDisconnect` is now state-only;
  `computeDisconnectEdit` remains as a tested pure command with no live
  caller (kept in case a future "delete wire AND import" affordance wants
  it).
- Symbol-level add remains a code-writing affordance (the picker); python
  symbol-level REMOVE stays fail-closed without edge mutation.
- The "All wires + remember" variant (persisted dismissed-pairs so deleted
  wires don't resurrect) was considered and NOT chosen; revisit only if
  resurrection-on-reopen proves annoying in practice.

## Out of scope

- Relative-dot import composition (`from .sibling import x`) — v1 writes
  absolute specs; revisit with S3 or on pyright feedback.
- Conda/venv-aware resolution breadth, python symbol *renames*, export-block
  equivalents (python has none).
- LSP lifecycle linger policy (raised same session; separate preference).

## Proposed slices

1. **S1 — discovery importer-dir base**: engine array change + tests
   (pytest1-shaped fixture: `main/main.py` importing sibling `main/tool.py`).
   Independent; can ship immediately.
2. **S2 — symbol layer + writer + picker** (after #153 merges): parser +
   tests, domain dispatch, writer dispatch replacing the JS-only guard,
   python composition + merge + insertion tests, picker-flow test (py→py
   connect → symbols listed → pick → `from oAuth import make_pkce_pair`
   written, file remains valid python).
3. **S3 — deletion semantics**: DECIDED + built 2026-07-17 (state-only for
   all languages, same branch as S2 — see decision section above).

## Acceptance (arc)

- pytest1 layout: `from tool import shout` produces a wire on open (S1).
- Drawing oAuth.py → main.py opens the picker listing `TOKEN_TTL_SECONDS`,
  `generate_state`, `make_pkce_pair`, `TokenStore`; picking one writes a
  correct `from oAuth import …` line after existing imports; pyright stays
  green; no JS syntax ever lands in a `.py` file (S2).
- All #153 regression tests still pass; fail-closed preserved for languages
  without a writer (S2).
