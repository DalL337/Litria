# Download Manager — ADR Prep Brief

## Status
- Investigation complete (2026-07-07). Input for finalizing the language-server download manager ADR.

## Purpose
ADR-005 (Managed Language Server Directory and Download Flow) has sat at **Proposed** since 2026-03-06. Since then, four other documents grew around it (RFC, two PRDs, the 7-slice build plan, the registry schema draft), slices 1–2 shipped, and the documents now contradict each other in six places. This brief reconciles all of it against (a) what the code actually does today and (b) how the field (mason.nvim, Zed, VS Code, Helix) solved the same problem, and lists the decisions the finalized ADR must lock.

Recommendation on form: **revise ADR-005 in place and move it to Accepted** (it was never accepted, so it can be freely amended), with this brief as the evidence trail. A fresh ADR-019 is only warranted if the revision would gut ADR-005's decision section entirely — it doesn't; the shape survives, the details change.

---

## 1. State of play

### Documents (all in-repo)
| Doc | Status | Owns |
|---|---|---|
| `docs/adrs/004-bundled-core-language-servers.md` | **Accepted, implemented** (2026-06-13) | Bundled Pyright/tsls/Node tier |
| `docs/adrs/005-managed-language-server-directory.md` | Proposed | Managed dir, contextual install, precedence |
| `docs/rfcs/language-server-management.md` | Proposed | Nested registry schema, installed.json, events |
| `docs/prds/language-server-management-prd.md` | Proposed | 8-slice plan, reqwest+sha2+zip stack, commands |
| `docs/prds/language-support-manager-prd.md` | Superseded by the above (says so explicitly) | — |
| `docs/plans/lsp/language-server-management-build-plan.md` | Slices 1–2 DONE (2026-04-03) | 7-slice delivery, decisions D1–D5 |
| `docs/plans/lsp/registry-schema-draft.md` | Proposed (2026-03-25, newest schema) | Flat minimal registry schema |

### Code reality (verified 2026-07-07)
- **The resolver already reserves the managed slot.** 3-tier precedence (Global PATH > Managed > Bundled) is shipped (`resolver.rs:42`); `probe_managed` (`resolver.rs:160`) is a hard-coded `None` stub. The download manager fills a designed seam — no rewrite.
- **The real managed-location precedent is app-data, not `~/.litria/`.** Bundled Node extracts to `app_data_dir()/runtimes/node/` (`bundled_runtime.rs:29`). `~/.litria/servers/` exists only in doc comments; no code creates or reads it.
- **Zero download infrastructure in Rust.** No HTTP, archive, or checksum crates in `Cargo.toml`. All download/SHA256/extract logic lives in build-time Node scripts (`scripts/bundle-node.mjs`, `bundle-conpty.mjs`) — a porting template, not reusable at runtime.
- **The extraction/idempotency pattern to mirror exists**: `ensure_node_extracted` (version-marker check → wipe → copy → chmod → marker write, background thread at setup, non-fatal fallback to PATH).
- **Frontend has two ready-but-unwired seams**: backend payload includes `resolution_tier` (frontend never reads it), and `languageSupportDomain.js` defines an `Update Available` status nothing sets. Today's "install" UX is copy-paste shell command guidance only.
- **Three version realities coexist**: `versions.rs` pins (authoritative for bundled), the dev-machine globals the session-start hook tracks, and npm-latest. No runtime drift detection exists for bundled/managed servers.

---

## 2. Contradiction register (the ADR must resolve every row)

| # | Contradiction | Recommended resolution |
|---|---|---|
| C1 | HTTP client: reqwest (ADR-005/RFC/PRD) vs **ureq** (build plan D5) | **ureq.** The LSP stack deliberately avoids tokio (`std::thread` + `sync_channel` throughout); ureq is sync and fits. reqwest drags an async runtime in for one feature. |
| C2 | Registry schema: nested-with-options/scores (RFC, PRD) vs **flat one-server-per-language** (registry-schema-draft.md) | **Flat draft wins, plus one field: `version` (string) per server** (see D3 below). The RFC's stability/performance scoring and multi-option modal are YAGNI for 3 target languages; the draft's own text reserves `servers[]` as the future widening. RFC-era modal mockups must be simplified to match. |
| C3 | `version` field type: int vs string | Schema version stays **integer**; the new per-server `version` field is a **string** (upstream formats vary: dates, semver, `v`-prefixed). |
| C4 | Slice structure: 8 (PRD) vs 7 (build plan) | **Build plan (7) is authoritative** — it's newer and partially executed. Mark the PRD's slice section as superseded by the build plan. |
| C5 | Installer size target: ≤70 MB (PRD, parent plan) vs ≤120 MB (ADR-004, bundled-runtime plan) | **120 MB** — the 70 MB criteria predate bundling Node. Stale numbers should be edited when the ADR lands. |
| C6 | Draft's internal args mismatch: generic block says `["--stdio"]`, Go example says `["serve"]` | Non-issue to flag in schema docs: `args` is per-server data, not a convention. (For the record: modern gopls speaks stdio by default; the registry entry should pin whatever launch args we conformance-test.) |
| C7 | Managed dir: `~/.litria/servers/<language>/` (ADR-005 + all doc comments) vs `app_data_dir()` precedent (code) | **`app_data_dir()/servers/<server_id>/<version>/`** (Windows: `%LOCALAPPDATA%/com.litria.app/servers/...`). Consistent with `runtimes/`, avoids a second config root, and per-user/no-elevation either way. Doc comments in `resolver.rs`/`packs/mod.rs` updated when implemented. |

---

## 3. What the field converged on (research synthesis)

Full report retained in session research; the load-bearing findings:

- **mason.nvim** = declarative registry (YAML → compiled JSON snapshot, checksummed, 24h cache; purl-with-mandatory-version package ids; explicit platform-target tables incl. glibc/musl split). Weakness: verifies the registry, **not** the artifacts.
- **Zed** = code-as-registry (per-language Rust adapters) but the best installer mechanics in the field: version-stamped dirs, stage → SHA-256-verify-before-extract → atomic rename, sidecar receipt metadata, cached-version offline fallback, user-installed binary always wins. Took real community backlash for downloading its private Node runtime **silently** — consent matters.
- **VS Code** = per-extension chaos; its marketplace signing covers the VSIX only, not anything extensions download at runtime. rust-analyzer migrated runtime-download → bundled-in-VSIX partly because of **Windows locked-binary update failures** — the canonical warning for in-place updates.
- **Helix** = PATH-only null hypothesis; defines the mandatory escape hatch every managed system keeps (user binary overrides managed — which our tier-1 Global already provides).
- **GitHub asset digests (June 2025)**: GitHub now computes SHA-256 for every release asset (`assets[].digest` in the REST API). Checksums no longer require upstream cooperation. Caveat: proves current-state integrity, not immutability — **pinning the sha256 in our registry is stronger** and is what the draft schema already does.
- **Rate limits**: unauthenticated GitHub API = 60 req/hr/IP. Mason's registry-snapshot model avoids per-package API calls entirely. Our baked-in registry (build plan D4) makes this moot for v1 — zero GitHub API calls, direct `releases/download/<tag>/<asset>` URLs only.
- **2026 verification posture**: TLS + pinned SHA-256 verified before extraction is the realistic baseline. Sigstore/artifact-attestation verification is not yet universal among language-server upstreams; treat as optional future per-package field, not a requirement.

---

## 4. Draft decisions for the finalized ADR

- **D1 — Managed directory**: `app_data_dir()/servers/<server_id>/<version>/` with version-stamped directories and an `installed.json` receipt (source url, sha256, version, timestamp) per install. A "current version" pointer lives in the receipt, **never** implemented by renaming live directories (Windows lock safety). Old versions garbage-collected after a newer one is confirmed working.
- **D2 — Download stack**: `ureq` + `sha2` + `zip`/`flate2`+`tar` (gopls/rust-analyzer/clangd ship as zip/gz/xz across platforms — verify per-artifact and add `xz2` only if a pinned artifact needs it). Stage into `servers/.staging/`, hash-verify **before** extraction, extract, write receipt, then activate. Failure at any step = delete staging, previous version untouched.
- **D3 — Registry schema**: the flat draft (`registry-schema-draft.md`) **plus a required per-server `version` string**. Rationale: version-stamped install dirs (D1), update detection (receipt vs registry compare), and the UI's "installed version" display all need it; the draft's exclusion of it conflicts with its own consumers. Everything else stays deferred exactly as the draft argues (no scores, no alternatives, no extractPath).
- **D4 — Registry distribution**: baked into the app, updated with Litria releases (build plan D4 stands). Update checks are therefore local diffs (receipt vs shipped registry) — no network, no rate limits, no cache TTL machinery in v1. Remote snapshot fetch is the designed v2 extension.
- **D5 — Scope of v1**: prebuilt-single-binary servers only (gopls, rust-analyzer, clangd — the draft's three targets). **No npm-source managed installs in v1**, which sidesteps the private-runtime consent problem entirely (our bundled Node stays dedicated to bundled core servers). Ecosystem sources (npm/pip/cargo) are a registry `source-type` extension later, mason-style.
- **D6 — Consent & transparency**: keep ADR-005's contextual install modal, simplified to the flat schema (one recommended server + custom path/URL — drop the alternatives tier until the schema grows `servers[]`). The modal shows exactly what will be downloaded: resolved URL, size if known, pinned sha256. No silent downloads, ever (Zed's lesson).
- **D7 — Updates**: registry pins the tested-good version (curation is a feature). On session start, if receipt version ≠ registry version → set the already-defined-but-unwired `Update Available` domain status; user-initiated update runs the same staged install; the running server keeps its old version until restart. Never block server startup on install/update.
- **D8 — Custom escape hatches**: tier-1 Global PATH already wins by design (Helix case covered). Custom local path: registers a receipt with `source: custom-path`, no verification. Custom URL: allowed with an explicit "Litria cannot verify this artifact" warning (ADR-005's mitigation stands).
- **D9 — Frontend wiring**: consume the existing `resolution_tier` payload field (surface install source in status/settings), wire `Update Available`, and extend `languageSupportDomain.js` rather than a new domain — install state is language-support state (the PRD's `LanguageSupportDomain` proposal is effectively already built under that name).

## 5. Open questions the ADR should answer (carried from RFC + new)
1. Uninstall behavior when Litria itself is uninstalled — leave managed servers (NSIS custom step complexity) or document the leftover? (Interacts with B0 uninstall verification.)
2. Managed-directory size surfacing — a "Manage installed servers" settings row with per-server size + uninstall covers the RFC's disk-space question; is that v1 or v2?
3. Where does the install UI live besides the contextual modal — Preferences page section, or contextual-only for v1?
4. Does the dev-time version-drift hook (`check-lsp-versions.sh`) get repointed at `versions.rs` + registry pins as part of this work, or stay dev-tooling-only? (Currently it measures the dev machine's globals — three-way version divergence documented.)
5. Proxy handling: ureq honors `HTTP(S)_PROXY` env vars — is that sufficient for v1, with distinguishable TLS error messaging deferred?
6. **Wizard coupling** (owner, 2026-07-07): the target flow is "decide to try language → download LSP → open blank project → get going" — which starts in the New Project wizard, not at file-open. Today the scaffold wizard's language matrix is static and fully decoupled from language support. Should the wizard offer/trigger the LSP install for the chosen language at project creation (contextual modal remains the fallback for opened files)? Recommended: yes, as a v1 acceptance criterion — it is the highest-traffic "new language" moment.
7. **Toolchain honesty**: LSP servers for the v1 targets are critics, not workshops — gopls/rust-analyzer/clangd are near-useless without the Go/Rust/C++ toolchains, which the download manager must NOT install (tarpit: multi-GB, licensing, PATH mutation). The existing prerequisite system covers detection; the install modal must clearly separate "server installed" from "toolchain missing + install hint." ADR scope notes should also expectation-set that debugging (DAP) is a separate protocol, out of scope.

## 6. Direction note: generic artifact installer (owner vision, 2026-07-07)
The long-term product shape is "one shell that acquires capabilities" (explicit anti-JetBrains-fragmentation stance): after LSP servers, the same download/verify/install machinery should serve **shareable project templates** (languages + deps packs, community-distributable) and potentially extension-sandbox payloads. Therefore the ADR should frame the downloader as a **generic verified-artifact installer** (staging, sha256 receipts, version-stamped dirs, atomic activation, uninstall) with LSP servers as its first client — payload-type-specific logic stays thin and separate. This changes no v1 scope; it changes naming, module boundaries, and the receipt schema (a `kind` field). Template packs themselves are a separate future ADR that reuses this infrastructure; converges with extension-sandbox Rung-1 declarative packaging and knownIds install/uninstall semantics.

**Discovery reconciler (owner vision, 2026-07-07 discussion)**: the end-state UX is "install a language by any means → its wizard card appears" — a reconciler loop, not an agent: registry = known catalog of language *shapes* (probe commands, toolchain paths, LSP artifact, scaffold card + deps matrix), observer = registry-driven probes (generalizing today's hardcoded `detect_prerequisites`), control loop diffs catalog vs machine at natural checkpoints (app start, project open, **wizard open** — the reward moment, after managed install; NOT filesystem watching) and projects the diff into `languageSupportDomain` state → wizard cards. Constraint locked in discussion: **guest-list discovery only** (probe for registry-known shapes), never stranger identification (sniffing unknown binaries — security surface + false-positive machine). Honest-cost note: the card is plumbing, the scaffold content behind it is authored — per-language scaffold templates (the `go mod init` analog of scaffold_runner's create-vite flow) gate which recognized languages get cards; community template packs (v2) are the long-term matrix-content answer. Phasing: v1 = managed installs update state directly (no discovery); v1.5 = registry-driven probes + checkpoint reconcile; v2 = template packs feed the matrix. ADR impact: registry schema should be designed so `detect`/`scaffold` blocks can be ADDED to entries later without a schema break (the flat draft's future-extensible-fields stance already permits this — name it explicitly).

## 7. Housekeeping when the ADR lands
- ADR-005 → Accepted (revised); RFC + PRD marked "superseded by ADR-005 (revised) + build plan" for schema/slice authority; stale ≤70 MB criteria edited; `~/.litria/` doc comments in `resolver.rs:52,156` / `packs/mod.rs:35` corrected to the decided path.
- Build plan slices 3–5 updated to reference the locked decisions (D1–D9) instead of the RFC schema.
