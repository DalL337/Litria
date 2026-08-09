# ADR-005: Managed Language Server Directory and Download Flow

## Status
- Implemented (2026-07-13→17 — all build-plan slices 1–7 merged: PRs #135–#141 registry/download/consent/packs/frontend/go, #142 settings surface, #143 probe hardening; owner-verified install loop)
- Accepted (2026-07-07 — revised; not yet implemented, delivered by build plan slices 3–7)
- Extended (2026-07-10 — addendum: acquisition-class taxonomy, capability reconciler,
  consent surface revised from modal to pill/card; v1 scope unchanged)
- Proposed (original 2026-03-06)

## Date
- 2026-03-06 (original proposal)
- 2026-07-07 (revised after investigation — see `docs/plans/lsp/download-manager-adr-prep.md` for the full evidence trail: doc-contradiction register, code-reality audit, and field research on mason.nvim / Zed / VS Code / Helix)

## Context
Beyond the bundled core servers (ADR-004, implemented), Litria needs a mechanism for users to add language support for Go, Rust, C/C++, and other languages without manual global installs.

Since the original proposal, facts on the ground changed:
- The 3-tier resolver (Global PATH > Managed > Bundled) shipped with ADR-004; `probe_managed` is a deliberate stub (`resolver.rs:160`) reserving the slot this ADR fills.
- The bundled-Node work established the managed-install precedent: per-user app data (`app_data_dir()/runtimes/node/`), version-marker idempotency, background-thread installs, non-fatal fallback. `~/.litria/` (this ADR's original directory) exists only in comments — no code creates or reads it.
- The LSP stack is deliberately synchronous (`std::thread` + `sync_channel`, no tokio).
- The registry schema was redrafted flat (`docs/plans/lsp/registry-schema-draft.md`), diverging from the nested RFC/PRD schema.
- Field research: the ecosystem converged on declarative registries (mason.nvim) married to staged, verified, version-stamped installer mechanics (Zed). Windows file locking makes in-place updates a known failure mode (rust-analyzer's VS Code extension abandoned runtime downloads over it). GitHub now publishes SHA-256 digests for all release assets; silent auto-downloads (Zed's private Node) draw real community backlash.

The design must balance opinionated defaults, user autonomy, security (no execution of unverified binaries), and disk control — unchanged from the original.

## Decision

Build the download manager as a **generic verified-artifact installer** whose first client is language servers. Payload-type-specific logic stays thin; future capability packs (project templates, extension payloads) reuse the same staging, verification, receipts, and lifecycle.

1. **Managed directory**: `app_data_dir()/servers/<server_id>/<version>/` (Windows: `%LOCALAPPDATA%/com.litria.app/servers/...`), consistent with the existing `runtimes/` root. Version-stamped directories are mandatory: a new version installs beside — never over — a possibly-running one (Windows lock safety). Each install writes an `installed.json` receipt (kind, source URL, sha256, version, timestamp); the receipt's `current` pointer selects the active version. Old versions are garbage-collected once a newer one is confirmed working.

2. **Download stack**: `ureq` (synchronous, fits the tokio-free LSP stack) + `sha2` + archive crates per pinned artifact needs (`zip`, `flate2`/`tar`; add `xz2` only if a registry artifact requires it). Flow: download to `servers/.staging/` → **verify SHA-256 before extraction** → extract → write receipt → activate. Failure at any step deletes staging and leaves the previous version untouched and running.

3. **Curated registry**: the flat schema of `registry-schema-draft.md` — one recommended server per language, HTTPS-only direct artifact URLs from official distributors, per-platform `artifacts` map (`windows-x64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`), pinned `sha256` per artifact — **plus a required per-server `version` string** (needed by version-stamped dirs, update detection, and the UI; upstream version formats vary, hence string). Schema `version` stays an integer. The schema must remain extensible so `detect` and `scaffold` blocks can be added to entries later without a break (reconciler/template-pack direction — see Scope Notes).

4. **Registry distribution**: baked into the app, updated with Litria releases. Litria never hosts binaries. Update checks are therefore local diffs (receipt vs shipped registry) — no network calls, no GitHub API usage, no rate-limit exposure in v1. Remote registry snapshot fetch (mason-style checksummed artifact with cache TTL) is the designed v2 extension.

5. **v1 scope**: prebuilt-single-binary servers only — gopls, rust-analyzer, clangd. No npm-source managed installs in v1 (sidesteps the private-runtime consent problem; bundled Node remains dedicated to bundled core servers). Ecosystem source types (npm/pip/cargo) are a registry extension later.

   > **Erratum (2026-07-13, Slice 3 implementation):** gopls publishes **no
   > prebuilt release assets** — every `gopls/v*` tag on golang/tools ships
   > zero binaries; the official distribution is `go install
   > golang.org/x/tools/gopls@latest`, executed by the user's Go toolchain.
   > That makes gopls a **class-3-shaped acquisition** (the user's own
   > toolchain runs it, visible terminal), not a class-1 managed artifact.
   > v1 registry therefore ships **rust-analyzer + clangd**; Go support
   > arrives as a toolchain-honest visible-terminal hint alongside the
   > consent surface (Slice 5), consistent with A1. The registry test
   > `v1_catalog_reflects_reality_not_the_plan` pins this until someone
   > finds an official binary distributor.

6. **Install triggers**: two front doors, one flow.
   - **Contextual**: opening a file for a registry-known, uninstalled language prompts an install modal.
   - **New Project wizard**: selecting a language whose server is not installed offers the install as part of project creation (acceptance criterion — this is the highest-traffic "trying a new language" moment).
   The modal shows exactly what will happen: server name, resolved URL, size when known, pinned sha256, install location. **No silent downloads, ever.** Toolchain honesty is required: the modal must clearly separate "server installed" from "toolchain missing" with install hints (the existing prerequisite system detects; Litria does not install toolchains — see Scope Notes).

7. **Updates**: the registry pins the tested-good version (curation is a feature; "latest" breaks people). When a receipt version differs from the shipped registry, set the language-support domain's `Update Available` status (already defined, currently unwired). Updates are user-initiated, run the same staged install, and never interrupt a running server — the new version activates on next server start. Server startup is never blocked on network or install activity.

8. **Precedence and escape hatches** (unchanged, now concrete): Global PATH > Managed > Bundled. A user-provided binary always wins — power users and locked-down corporate environments are never overridden. Custom local path registers a `source: custom-path` receipt with no verification; custom URL is allowed behind an explicit "Litria cannot verify this artifact" warning.

9. **Frontend wiring**: extend `languageSupportDomain.js` (install state is language-support state — no new domain); consume the backend's already-emitted `resolution_tier` to surface install source; wire the `Update Available` status; progress events via Tauri events per the established IPC bridge pattern. Preferences gains a minimal "Installed language servers" management list (version, source tier, on-disk size, uninstall) — disk control is a stated goal, and receipts make it cheap.

## Consequences
Positive:
- One-click language expansion from the two places users actually are (file open, project wizard), with the bundled-core precedent of "just works" extended to the long tail.
- The installer is generic: template packs and extension payloads later reuse staging/verification/receipts instead of growing parallel machinery.
- Zero network calls except the user-consented artifact download itself; no rate limits, no registry-fetch failure modes in v1.
- Version-stamped dirs + staged installs make failed downloads and Windows file locking non-events: the previous version keeps running.
- User autonomy preserved at three levels: PATH override, custom path/URL, uninstall with visible disk usage.

Costs:
- New Rust infrastructure: HTTP client, checksum, archive extraction (`ureq`, `sha2`, `zip`/`flate2`/`tar`) — currently zero such crates; the porting template is the build-time Node scripts (`bundle-node.mjs`).
- Registry maintenance: each Litria release re-verifies three servers × five platforms of pinned URLs + hashes; stale pins ship stale servers (mitigated by the version-drift dev tooling, see follow-ups).
- Registry updates arrive only with app releases in v1 — a newly released server version is invisible until Litria ships (accepted: curation over freshness; remote snapshot is v2).
- Custom URLs bypass integrity guarantees (mitigated by warning UI, unchanged from original).

## Alternatives Considered
- **reqwest** (original choice): rejected — drags an async runtime into a deliberately synchronous stack for one feature. `ureq` covers streaming download + proxy env vars.
- **`~/.litria/servers/` directory** (original choice): rejected — no code precedent; `app_data_dir()` is established by the bundled runtime, per-user, and elevation-free on all three platforms.
- **Nested registry schema with alternatives + stability/performance scores** (RFC/PRD): rejected as YAGNI for a three-language catalog. The flat schema's `server` field widens to `servers[]` when alternatives are actually curated; user autonomy is preserved today by PATH precedence and custom path/URL. (This revises the original ADR's rejection of "single recommended server with no alternatives" — the modal's alternatives tier is deferred, not the autonomy.)
- **Code-as-registry per-language adapters** (Zed's model): rejected — a data-driven registry scales to community contribution without app releases per server; Zed's *installer mechanics* are adopted, its registry model is not.
- **VS Code extension marketplace model**: rejected as before — Litria is not an extension platform (and VS Code's signing demonstrably does not cover runtime-downloaded servers anyway).
- **Remote registry fetch in v1**: deferred — baked-in registry eliminates network/rate-limit/cache machinery while the catalog is three entries.
- **Settings-only configuration (no contextual prompt)**: rejected as before — discoverability.

## Scope Notes
- **Registry manifest schema** is normative in `docs/plans/lsp/registry-schema-draft.md` (flat + required `version` string per this ADR). The RFC's nested schema and the PRD's slice structure are superseded on those points; `installed.json` receipt shape follows the RFC with an added `kind` field.
- **Toolchains are out of scope.** LSP servers are critics, not workshops: gopls/rust-analyzer/clangd are near-useless without the Go/Rust/C++ toolchains, which Litria detects (prerequisite system) and hints at, but never installs (multi-GB downloads, licensing, PATH mutation). Debugging (DAP) is a separate protocol and also out of scope.
- **Uninstalling Litria leaves the managed directory in place** (field norm — Zed/Mason do the same); documented rather than NSIS-scripted. Revisit at B0 uninstall verification.
- **Proxies**: ureq's `HTTP(S)_PROXY` env-var support is v1-sufficient; distinguishable TLS-interception error messaging is deferred.
- **Future direction (non-normative)**: registry entries later grow `detect` (guest-list discovery probes) and `scaffold` (wizard card + deps matrix) blocks, feeding a reconciler that projects "what's installed on this machine" into wizard cards; template packs distribute scaffold content through this same installer. See the direction notes in `docs/plans/lsp/download-manager-adr-prep.md`.
- The managed directory remains per-user, not per-project. Server updates are user-initiated, never silent (unchanged).

## Implementation Follow-ups (not blocking acceptance)
- Correct `~/.litria/` doc comments (`resolver.rs:52,156`, `packs/mod.rs:35`) to the decided path when `probe_managed` is implemented. *Resolved with the slice implementation — no stale `~/.litria` comments remain (verified 2026-07-22).*
- Update build plan slices 3–5 to reference this ADR's decisions instead of the RFC schema; the PRD's ≤70 MB installer criteria are stale (ADR-004 set ≤120 MB). *Resolved 2026-07-22 — supersession note added to the build plan's Status; PRD size criteria corrected to ≤120 MB.*
- Repoint the dev-time version-drift hook (`.claude/hooks/check-lsp-versions.sh`) at `versions.rs` + registry pins — it currently measures the dev machine's global npm installs, which tracks none of the versions Litria actually ships. *Resolved 2026-07-22 — hook rewritten to read `versions.rs` pins (npm-latest drift) and registry pins (report-only; local dev tooling, gitignored).*

---

## Addendum (2026-07-10): Acquisition-Class Taxonomy and the Capability Reconciler

Extends the accepted decision without changing v1 scope (slices 3–7 build exactly
what §1–§9 describe). This addendum makes normative two things the Scope Notes
gestured at, so future clients of the installer don't re-litigate them: what
*kinds* of things the manager may acquire (and under which trust model), and
where the "you are missing X" signal comes from.

### A1. Acquisition classes

"Missing items" is not one class. Four classes exist, distinguished by trust
model, mutability, and — critically — **who executes what**:

| # | Class | Examples | Trust model | Mutability | Acquired by |
|---|-------|----------|-------------|------------|-------------|
| 1 | **Managed artifacts** | LSP servers (v1); template packs, extension payloads (later) | Baked registry: pinned version + SHA-256, staged install, receipts (§1–§4) | Immutable, version-stamped | The download manager, into `app_data_dir()` |
| 2 | **Reference data** | JSON schemas (`brief-json-schema-service.md`) | TLS + size caps + inert-content (no checksum possible — mutable upstream) | Cache with TTL/ETag revalidation | The download manager's *cache* path — explicitly not a verified install |
| 3 | **Project dependencies** | npm/pip/cargo packages a project's manifest declares | The project's own toolchain and lockfile — **not Litria's to vouch for** | Project-owned | **Never the download manager.** Installing deps executes arbitrary code (postinstall scripts); the only acceptable surface is the project's package manager run **in the visible terminal**, user-initiated. Litria offers the command; the terminal is the consent and the audit trail. |
| 4 | **Toolchains / runtimes** | Go, Rust toolchain, Python, Node | System-owned | System-owned | **Never Litria** (unchanged from Scope Notes: detect + hint, deep-link to official installers). |

Classes 1–2 share the manager's machinery (staging dir, receipts/cache dir,
consent surface, progress events). Classes 3–4 share only the *signal and
offer* surface — the manager surfaces them but never acquires them. Any future
"should Litria download/install Z?" question starts by classifying Z.

### A2. The capability reconciler (signal side)

The offer pipeline is a reconciler, not a diagnostics parser:

- **Desired capabilities** derive from project contents: file extensions
  present, project manifest(s), wizard selections, and later the
  `[environment]` block in `litria.toml` (environment-bootstrap direction).
- **Installed capabilities** derive from structured probes: PATH resolution
  (existing 3-tier resolver), `installed.json` receipts, the schema cache,
  lockfile-vs-installed state reported by the project's own package manager.
- The **delta** is the offer list.

**Diagnostics are a re-run trigger, not a source of truth.** An LSP diagnostic
("cannot find module …") or a schema-load warning may prompt the reconciler to
re-probe, but offers are generated from probes — never from string-matching
diagnostic text (fragile, unlocalizable). `languageSupportDomain` already owns
prerequisite detection and install-status state and is the natural aggregation
point; the wizard's guest-list probes (Scope Notes "future direction") are this
same reconciler run at project-creation time. Contextual file-open prompts (§6)
and wizard cards (§6) are two triggers of one pipeline; project-*open* is the
third and highest-traffic trigger for existing codebases.

### A3. Consent surface (revises §6's "modal" wording)

One surface for all four classes, per the no-modal rule: a **pill** (existing
`pillDomain`), batched — one pill per project-open moment summarizing the full
delta ("Go support: gopls + 2 schemas — set up?"), expanding to a **card list**
with per-item accept and per-item provenance (name, resolved URL, size,
pinned sha256 for class 1; source URL for class 2; the exact command for
class 3; the official installer link for class 4). Decisions are remembered
per scope (never re-prompt the same project per session; class-2 auto-fetch is
a global preference). §6's content requirements (show exactly what will
happen; no silent downloads, ever; toolchain honesty) are unchanged — only the
form factor moves from modal to pill/card.

### A4. Strategic note (non-normative)

This is the anti-JetBrains capability-pack thesis made ambient: the user never
picks "the Go IDE" — they open a folder, the reconciler computes what the
project needs, and Litria offers to become that IDE, one consented pill at a
time, with provenance visible.

Cross-references: `docs/plans/ideas/brief-json-schema-service.md` (class-2
client, PR #114), `docs/plans/lsp/download-manager-adr-prep.md` (evidence
trail), environment-bootstrap idea (`[environment]` as declared desired state).
