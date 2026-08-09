# Brief: JSON Schema Service — Download + Cache for the Long Tail

> **Status**: Design brief / not yet planned for implementation
> **Author**: DalL337 + Claude
> **Date**: 2026-07-10
> **Layer 1 shipped separately**: bundled tsconfig/package schemas + schemastore
> URL aliases in `src/editor/monacoSetup.js` (same-day PR).

## Problem

Monaco's JSON worker validates against schemas but never fetches them
(`enableSchemaRequest` deliberately off). Any JSON file declaring a
`"$schema": "https://…"` we haven't bundled gets a warning marker on line 1:
*"Unable to load schema from …"*. Layer 1 bundles the two schemas every
project hits (package.json, tsconfig.json + variants) and aliases their
schemastore URLs to the bundled copies. The long tail — `.eslintrc`,
`renovate.json`, `turbo.json`, tool configs users bring with real projects —
still warns, and bundling more is the wrong shape: the tsconfig schema alone
is 433 KB, and schemastore hosts ~1,000 schemas that update continuously.

## Non-goals / rejected

- **`enableSchemaRequest: true`** (worker fetches directly): silent network
  from the webview, no consent, no cache, no offline story. CSP is currently
  `null` so it would *work* — the rejection is posture, not capability
  (see the ADR-005 consent lesson).
- **Bundling the long tail**: bloat, staleness, and schemastore churn.

## Design: consent-gated download-through cache

Second client of the ADR-005 download-manager stack (LSP servers were the
first), with one deliberate difference: schemas are **mutable upstream**, so
this is a *cache with revalidation*, not a versioned verified-artifact
install. No checksums; freshness via TTL + ETag.

**Flow:**

1. JSON model opens (or content changes) → extract its `$schema` URL, if any.
   (Alternative trigger: listen for the worker's "Unable to load schema"
   marker — catches `$ref` chains too. v1 uses the direct `$schema` scan;
   marker-driven is the fallback if coverage disappoints.)
2. Already registered (bundled or session-loaded)? Done.
3. Cache hit at `app_data_dir()/schemas/<sha256(url)>.json`? Load, register
   dynamically, done. Stale-past-TTL still registers (stale-is-fine offline);
   revalidation happens in the background.
4. Cache miss → **consent gate**. First occurrence per install prompts via
   pill/status-line (inline per the no-modal rule): "Litria can download JSON
   schemas your files reference." Remembered globally (`schemas.autoFetch`:
   on / off / ask). Off = the warning marker stays, exactly as today.
5. Download on the Rust side (`ureq`, same crate posture as ADR-005 —
   the LSP stack is deliberately tokio-free), staged write → atomic rename
   into the cache dir. Webview never talks to the network.
6. Register into `jsonDefaults` and the worker revalidates open models.

**Dynamic registration mechanics:** `jsonDefaults.setDiagnosticsOptions`
replaces the whole options object — keep a session registry in JS
(bundled entries + fetched entries), re-set on every addition.

**Guardrails (v1):**
- `https://` URLs only; response must parse as JSON; size cap 2 MB.
- No recursive fetching of external `$ref`s in v1 (depth 0). The overwhelming
  majority of schemastore schemas are self-contained (tsconfig verified so).
- Per-session dedupe: a failing URL is attempted once, not per keystroke.
- TTL 7 days; ETag/If-None-Match revalidation when online.

**Rust surface:** one command (`schema_fetch(url) -> CachedSchema`) plus a
cache-dir sweep on startup (drop entries unused > 90 days). Lives beside the
future download manager; if ADR-005 slices 3-7 land first, reuse its staged
HTTP helper rather than duplicating.

## Why this shape

- Zero network until a user's file actually references an unknown schema,
  and zero without consent — matches the ADR-005 v1 zero-network posture and
  the wizard-consent lesson.
- Offline-first: bundled schemas cover the scaffold-generated files; the
  cache covers everything previously seen; only novel URLs need the network.
- The warning marker remains an honest signal when auto-fetch is off — we
  suppress it by *resolving* the schema, never by hiding the diagnostic.

## Slices

1. **S1 — session registry + dynamic registration** (JS only): registry
   module wrapping `jsonDefaults`, `$schema` scan on model open, register
   from an in-memory map. Node-testable.
2. **S2 — Rust cache + fetch command**: `schema_fetch`, staged writes,
   TTL/ETag. Wire S1's miss path to it behind a hardcoded-off flag.
3. **S3 — consent surface**: pill prompt + `schemas.autoFetch` preference,
   flag removed.
4. **S4 (optional) — marker-driven fallback + depth-1 `$ref`.**

## Cross-references

- ADR-005 (managed language-server directory) — shared download posture,
  `app_data_dir()` layout precedent, ureq choice, consent lesson.
- `docs/plans/lsp/download-manager-adr-prep.md` — the staged-install
  mechanics this deliberately simplifies (cache, not install).
- Monaco protected zone (ADR-008): all Monaco-side changes stay in
  `monacoSetup.js` / editor domain; no UI-tech implications.
