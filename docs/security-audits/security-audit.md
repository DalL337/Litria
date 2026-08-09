# Litria Security Audit

> **Type**: Living document — reviewed periodically and after significant changes
> **Last reviewed**: 2026-07-16
> **Scope**: Whole-repo pass — Tauri config/CSP, IPC command surface, ADR-005
> download manager (pins/SHA/extraction), ADR-021 scaffold runner, ADR-020
> Python creation, terminal/LSP spawn surfaces, frontend injection sinks, SQL,
> secrets, dependency supply chain. HEAD `72c18fe` (branch
> `fix/probe-global-hollow-shim`).

---

## Dependency Supply Chain

### npm (312 deps: 100 prod / 211 dev / 86 optional)
- [ ] **1 low** — last scanned 2026-07-16 (HEAD `72c18fe`). `@babel/core`
  `<=7.29.0` arbitrary file read via `sourceMappingURL` (GHSA-4x5r-pxfx-6jf8,
  CVSS 3.2, CWE-22/200). **Dev dependency**, `fixAvailable: true`. Non-material
  to the shipped app; clear with `npm audit fix` at convenience.
- History: 2026-03-28 scanned 0 vulns across 263 packages.

### Cargo (552 crate dependencies)
- [ ] **2 HIGH vulnerabilities (NEW 2026-07-16)** — `quick-xml 0.38.4`:
  - RUSTSEC-2026-0194 (7.5) — quadratic runtime on duplicate attribute names (DoS).
  - RUSTSEC-2026-0195 (7.5) — unbounded namespace-declaration allocation → memory
    exhaustion (DoS). Fix: quick-xml `>=0.41.0`.
  - **Blocked upstream.** Path: `quick-xml ← plist 1.8.0 ← tauri-plugin-{opener,
    fs,dialog} + tauri-codegen`. `cargo update -p quick-xml` locks 0 packages —
    `plist 1.8.0` constrains quick-xml to the 0.38.x line; unblocks when Tauri
    ships a plist bump. Runtime reachability is low (plist parses Apple XML plists,
    macOS-centric; the codegen path runs at build time), but advisory severity is
    High. **Unblocks on:** Tauri/plist upstream release. Re-check each Tauri bump.
- [ ] **21 upstream warnings** (was 18) — unmaintained/unsound transitive deps.
  Unchanged-and-blocked GTK3 (`atk/gdk/gtk*` RUSTSEC-2024-041x), `unic-*`,
  `glib 0.18.5` (RUSTSEC-2024-0429). **New since 2026-03-28:** `anyhow 1.0.100`
  unsound (RUSTSEC-2026-0190), `rand 0.7.3`+`0.8.5` unsound (RUSTSEC-2026-0097,
  transitive via html5ever/selectors — **not** Litria's own `rand = 0.9`). All
  blocked on Tauri upstream.
- [x] **0 vulnerabilities in first-party code / direct deps.** The download
  manager's own supply-chain crates (`zip 2.4.2`, `tar 0.4.46`, `ureq 3.3.0`,
  `flate2 1.1.5`, `sha2 0.10`) are clean and current.

---

## Master Remediation Checklist

Running tracker of every open finding across all audit passes. Check items off
here as they land; the numbered write-ups below own the detail (point to them,
don't restate the fix here). Ordered by leverage, then severity. `#N` is the
finding number; the parenthetical is the fix in a phrase, and the date is when
the finding was first raised.

### Do first (highest leverage)

- [x] **#10** — Enable a restrictive CSP (`csp: null` → `default-src 'self'`,
  no `unsafe-inline`/`eval` on scripts). Single change that contains #1/#11/#12
  if XSS ever lands. *(2026-07-16)* — ✅ **merged PR #151 (2026-07-17, S7, ADR-023; strict prod `csp` + dev-only `devCsp`, verified on a production build incl. Monaco under CSP).**
- [ ] **dep** — Track `quick-xml` 0.38.4 (2× RUSTSEC-2026-0194/0195, HIGH DoS)
  to the next Tauri/plist bump; blocked upstream today (`cargo update` locks 0).
  *(2026-07-16)* — **still blocked upstream; watch each Tauri bump.**

### Moderate

- [x] **#1** — Scope or remove `read_external_file`'s unrestricted absolute-path
  read (elevated by #10). *(2026-03-19)* — ✅ **merged PR #150 (2026-07-17, S6, ADR-022; `read_external_file` removed entirely, Rust owns the open-file picker + read).**
- [x] **#4** — Canonicalize + `..`-reject the `.cmd`→node script path in
  `resolve_cmd_to_node`. *(2026-03-28)* — ✅ **merged PR #146 (2026-07-17, S3).**
- [x] **#5** — Length-cap LSP `language_id`/`project_id`/`method`; cap
  `timeout_ms`. *(2026-03-28)* — ✅ **merged PR #146 (2026-07-17, S3).**
- [x] **#6** — Validate LSP `project_root` (exists, is dir) before
  `current_dir`. *(2026-03-28)* — ✅ **merged PR #146 (2026-07-17, S3).**

### Low / defense-in-depth (previous + new, interleaved)

- [x] **#2** — Tauri capability minimization (the literal "scope fs plugin" was
  inapplicable — no fs plugin enabled; custom path-guarded commands are the
  boundary). *(2026-03-19)* — ✅ **merged PR #149 (2026-07-17, S4; removed unused `opener:default`, documented the architecture, posture test enforces minimality).**
- [x] **#7** — Replace the `::` session-key concatenation with a structured
  tuple key. *(2026-03-28)* — ✅ **merged PR #146 (2026-07-17, S3).**
- [x] **#8** — Drop or document `PYTHONPATH`/`NODE_PATH` in the python /
  typescript pack env allowlists. *(2026-03-28)* — ✅ **merged PR #147 (2026-07-17, S5; both dropped).**
- [x] **#9** — Wrap backend IPC errors with a sanitized code + message in the
  adapters *(2026-03-28)*. — ✅ **merged PR #147 (2026-07-17, S5; `lspErrorSanitize.js`).**
- [x] **#11** — Validate Python `interpreter_path` against the probe set (or
  canonicalize + basename-allowlist) before spawn. *(2026-07-16)* — ✅ **merged PR #144 (2026-07-17, S1).**
- [x] **#12** — Route the npm scaffold path through the shared
  `validate_project_name` (Blank + Python already do). *(2026-07-16)* — ✅ **merged PR #144 (2026-07-17, S1).**
- [x] **#13** — Enforce a max-byte cap on the LSP artifact download stream.
  *(2026-07-16)* — ✅ **merged PR #145 (2026-07-17, S2).**
- [x] **#14** — Require `https://` on custom LSP install URLs (keep the no-SHA
  consent copy). *(2026-07-16)* — ✅ **merged PR #145 (2026-07-17, S2).**

### Accepted / not independently actionable

- [x] **#3** — Path-resolution TOCTOU — accepted (single-user desktop; revisit
  only if multi-user / server). *(2026-03-28)*
- [ ] **21 cargo warnings** — unmaintained / unsound transitive deps (GTK3,
  `unic-*`, `glib`, `anyhow`, `rand`) — blocked on Tauri upstream. *(tracking only)*
- [ ] **1 low npm** — `@babel/core` dev-dep advisory — `npm audit fix` at
  convenience. *(2026-07-16)*

---

## Verified Strengths

These areas have been audited and are well-defended. No action needed.

### Path traversal protection — EXCELLENT
`path_guard.rs` (`validate_relative_path`) decomposes every path into components and only allows `Component::Normal`. Mixed separator detection catches Windows tricks. Unit tested.

### Symlink escape protection — EXCELLENT
`resolve_relative_path_for_write` canonicalizes then verifies within project root. Delete operations use `symlink_metadata()` to detect without following. Unit tested.

### Write serialization — GOOD
All writes go through `write_ops::with_write_lock()`. Atomic write via temp-file-then-rename prevents partial writes on crash.

### JS-side path construction — SAFE
Frontend `normalizePath` is display-only, not a security boundary. All paths pass through Rust validation before filesystem ops.

### LSP environment isolation — GOOD
`env_clear()` + explicit allowlist pattern is fundamentally sound. Windows system vars (`SystemRoot`, `COMSPEC`, `PATHEXT`, `SystemDrive`) preserved for `cmd.exe`/`node` functionality.

### LSP JSON-RPC framing — GOOD
Content-Length parsing is robust with exact byte count validation. Read loop handles EOF and malformed headers correctly.

### LSP session lifecycle — GOOD
Proper mutex guards on session registry. Lock held only for Arc cloning, released before blocking `recv_timeout`. Crash handler drains pending requests immediately.

### Hardcoded pack registry — SAFE
Language packs are `&'static str` in Rust source. Not loaded from config files, user input, or network. Probe commands and launch commands cannot be injected via frontend.

### Archive extraction (ADR-005 download manager) — GOOD *(audited 2026-07-16)*
`download.rs` verifies SHA-256 **before** extraction for managed installs (mismatch discards, installs nothing); the registry parser enforces `https://` + exactly-64-hex-char pins (`registry.rs`, test-enforces `https://github.com/` prefix + safe version dir names). Extraction uses `zip 2.4.2` (past the CVE-2025-29787 arbitrary-file-write fix in 2.4.0; `enclosed_name()` sanitizes traversal names) and `tar 0.4.46`. No zip-slip. *Keep zip ≥ 2.4.0 on future bumps.*

### Scaffold command construction (ADR-021) — GOOD *(audited 2026-07-16)*
`scaffold_runner.rs` builds every subprocess as `Command::new(exe).args(vec![…])` — argument vectors, never a shell string — so shell injection is structurally absent. Third-party CLI specs are pin-enforced (`parse_exact_spec` refuses ranges/tags/`latest`), gated by a 24h release-age check, and run scripts-off by default on npm (`npm_config_ignore_scripts` env choke point covers nested installs).

### Terminal execution boundary — GOOD *(audited 2026-07-16)*
`terminal_policy.rs` allowlists the shell executable (`powershell.exe|pwsh.exe|cmd.exe` / `sh|bash|zsh`), validates `project_root` through `path_guard`, and filters the child environment to an allowlist that explicitly drops `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, `BASH_ENV`, `PROMPT_COMMAND`, `PYTHONPATH` (test-enforced). `terminal_spawn` is not an arbitrary-executable primitive.

### Project-name validation — GOOD (but see ISSUE 12) *(audited 2026-07-16)*
`blank_project::validate_project_name` rejects path separators, `.`/`..`, control chars, Win32 forbidden chars, trailing dots, and reserved device names (CON, NUL, COM1…) — test-covered. Used by the Blank and Python creation paths.

### Python creation (ADR-020) — SAFE by design *(audited 2026-07-16)*
`python_scaffold.rs` writes every file itself; the only subprocess is local env creation (`<interpreter> -m venv` / `uv venv`). Zero network, zero third-party code execution at create time. dist-name/module-name/floor validators enforced.

### Frontend HTML injection — NONE *(audited 2026-07-16)*
No `innerHTML` / `outerHTML` / `dangerouslySetInnerHTML` / `document.write` / `eval` / `new Function` anywhere in `src/`, and no markdown-to-HTML rendering library. React's default escaping is the only rendering path. (This is what makes the missing CSP — ISSUE 10 — a latent gap rather than an active hole.)

### SQL — parameterized *(audited 2026-07-16)*
All `db/` queries use `?` placeholders. The one dynamically-built statement (`db_update_group`, `commands.rs:415`) interpolates only **static** `"col = ?"` fragments; every value binds through `ToSql`. No SQL injection.

### No hardcoded secrets *(audited 2026-07-16)*
Repo scan (excluding `node_modules`) found no private keys, API tokens, or cloud provider credentials.

### `crash_open_report_url` — locked target *(audited 2026-07-16)*
Refuses any URL not prefixed `https://github.com/DalL337/litria/issues/new`, so it cannot be used as a generic open-anything primitive. Crash-record commands cap size (1 MiB record, 64 KiB breadcrumbs) and sanitize the `layer`/`phase` tags.

---

## Open Findings

### ISSUE 1: `read_external_file` has no project root boundary

| Field | Value |
|---|---|
| **Severity** | Moderate |
| **Location** | `src-tauri/src/project_ops.rs` — `read_external_file()` |
| **Type** | Information disclosure |
| **Status** | Open |
| **Found** | 2026-03-19 |

- [ ] **Not remediated**

Accepts any absolute file path and reads contents. No boundary check. Every other filesystem command validates project root — this is the exception. Read-only risk, but if a webview vulnerability allows arbitrary JS execution, this becomes an information disclosure primitive (SSH keys, .env files, etc.).

**Recommendation**: Scope to file-picker-consented paths (Option A), or audit and document all call sites (Option B), or remove if unused (Option C).

---

### ISSUE 2: Tauri capabilities config has no filesystem scope

| Field | Value |
|---|---|
| **Severity** | Low |
| **Location** | `src-tauri/capabilities/default.json` |
| **Type** | Missing defense-in-depth |
| **Status** | Open |
| **Found** | 2026-03-19 |

- [ ] **Not remediated**

No filesystem scope restrictions defined. Rust `path_guard` is the only defense layer. Litria uses custom Tauri commands (not the `fs` plugin), so standard scopes don't apply directly. Document this architectural decision.

**Recommendation**: Add capability scoping for project root + app data directories as defense-in-depth.

---

### ISSUE 3: TOCTOU race condition in path resolution

| Field | Value |
|---|---|
| **Severity** | Very low |
| **Location** | `src-tauri/src/path_guard.rs` — `resolve_relative_path_for_write()` |
| **Type** | Race condition |
| **Status** | Accepted risk |
| **Found** | 2026-03-19 |

- [x] **Accepted** — not exploitable in desktop context

Between existence check and canonicalization, a symlink swap is theoretically possible. Mitigated by `ensure_within_root()` always checking canonical path. Single-user desktop app = attacker is already the OS user. Revisit only if Litria moves to multi-user/server context.

---

### ISSUE 4: Path traversal in `.cmd` script resolver

| Field | Value |
|---|---|
| **Severity** | Moderate |
| **Location** | `src-tauri/src/lsp/transport.rs` — `resolve_cmd_to_node()` |
| **Type** | Path traversal |
| **Status** | Open |
| **Found** | 2026-03-28 |

- [ ] **Not remediated**

The `.cmd` file parser extracts `%dp0%\<path>` and constructs a script path without validating for `..` segments. A malicious `.cmd` file (e.g., compromised npm package) could reference `%dp0%\..\..\..\..\evil.js`.

**Mitigating factors**: Requires a supply chain attack (malicious npm package installed globally). The `.exists()` check limits to paths that actually exist. This is a defense-in-depth gap, not a direct exploit.

**Recommendation**: Canonicalize the resolved script path and verify it's under the same directory as the `.cmd` file. ~5 lines of code.

---

### ISSUE 5: Missing input validation on LSP Tauri commands

| Field | Value |
|---|---|
| **Severity** | Moderate |
| **Location** | `src-tauri/src/commands.rs` — all `lsp_*` commands |
| **Type** | Input validation / DoS |
| **Status** | Open |
| **Found** | 2026-03-28 |

- [ ] **Not remediated**

`language_id`, `project_id`, `method` strings have no length limits. A malicious frontend call with megabyte-sized strings could cause memory pressure. `timeout_ms` has no upper bound cap.

**Mitigating factors**: Desktop app — the "attacker" is the local user or a webview compromise. `get_pack()` rejects unknown `language_id` values immediately. Session registry limits concurrent sessions naturally.

**Recommendation**: Add length limits (`language_id` max 50, `project_id` max 256, `method` max 100) and cap `timeout_ms` at 30,000ms.

---

### ISSUE 6: Missing `project_root` validation in LSP session start

| Field | Value |
|---|---|
| **Severity** | Moderate |
| **Location** | `src-tauri/src/lsp/session.rs` — `start_session()` |
| **Type** | Insufficient validation |
| **Status** | Open |
| **Found** | 2026-03-28 |

- [ ] **Not remediated**

`project_root` is passed directly to `Command::current_dir()` without checking it exists, is a directory, or is under an expected project path. The LSP server would run with an attacker-controlled working directory.

**Mitigating factors**: `project_root` originates from `projectInstance.rootPath` in the React lifecycle hook, which comes from the project domain (user-selected via file picker). Not directly controllable from arbitrary frontend code without project domain cooperation.

**Recommendation**: Validate `project_root` is an existing directory. Optionally verify it matches a known project root from the project registry.

---

### ISSUE 7: Session key collision via delimiter injection

| Field | Value |
|---|---|
| **Severity** | Low |
| **Location** | `src-tauri/src/lsp/session.rs` — `session_key()` |
| **Type** | Key collision |
| **Status** | Open |
| **Found** | 2026-03-28 |

- [ ] **Not remediated**

Session key uses `format!("{project_id}::{language_id}")`. If `project_id` contains `::`, keys can collide across different sessions.

**Mitigating factors**: `project_id` is generated internally (`projectInstance.instanceId`), not user-supplied free text. Collision is theoretical only with current code paths.

**Recommendation**: Use null byte separator or structured tuple key instead of string concatenation.

---

### ISSUE 8: Env var passthrough risks (`PYTHONPATH`, `NODE_PATH`)

| Field | Value |
|---|---|
| **Severity** | Low |
| **Location** | `src-tauri/src/lsp/packs/python.rs`, `typescript.rs` |
| **Type** | Environment injection |
| **Status** | Open |
| **Found** | 2026-03-28 |

- [ ] **Not remediated**

`PYTHONPATH` and `NODE_PATH` in env allowlists could inject code paths into language servers if the parent process has malicious values. Desktop context makes this low risk — the parent is the OS shell.

**Recommendation**: Consider removing `PYTHONPATH` and `NODE_PATH` unless needed for virtual environment support. If kept, document the trust assumption.

---

### ISSUE 9: Backend error objects passed unsanitized to frontend

| Field | Value |
|---|---|
| **Severity** | Low |
| **Location** | `src/lsp/createLspAdapters.js` — catch blocks |
| **Type** | Information disclosure |
| **Status** | Open |
| **Found** | 2026-03-28 |

- [ ] **Not remediated**

Error objects from Tauri IPC (including file paths, spawn details) are passed directly to the domain layer. Could expose internal paths in UI error messages.

**Mitigating factors**: Desktop app — user already has filesystem access. Errors are consumed by the domain layer, not directly rendered to UI without processing.

**Recommendation**: Wrap backend errors with sanitized code + message before returning from adapters.

---

### Re-verification of issues 1–9 (2026-07-16)

All nine findings from the 2026-03-19 / 2026-03-28 passes were re-checked at
HEAD `72c18fe`. **Issues 1, 2, 4, 5, 6, 7, 8 remain open and unchanged** at the
cited locations (issue 3 stays Accepted). Issue 9 (unsanitized error passthrough)
was not re-verified in depth this pass — carried forward as-is. Note: **ISSUE 1
(`read_external_file`) is effectively elevated** by ISSUE 10 — with no CSP, an
XSS would turn it into an arbitrary-file-read exfiltration primitive.

---

### ISSUE 10: Content-Security-Policy is disabled (`csp: null`)

| Field | Value |
|---|---|
| **Severity** | Moderate (defense-in-depth multiplier) |
| **Location** | `src-tauri/tauri.conf.json` — `app.security.csp = null` |
| **Type** | Missing defense-in-depth (XSS containment) |
| **Status** | Open |
| **Found** | 2026-07-16 |

- [ ] **Not remediated**

Tauri injects no `Content-Security-Policy` when `csp` is `null`. The app has no HTML-injection sinks today (verified — see Verified Strengths), so this is not an active XSS. But CSP is the layer that would *contain* any XSS introduced later (a new feature, a compromised frontend dependency, unsanitized markdown), and several IPC commands (ISSUE 1 `read_external_file`, ISSUE 11 interpreter spawn, ISSUE 12 scaffold name) would become escalation primitives if one landed. This single change raises the floor under most Moderate findings.

**Recommendation**: Set a restrictive CSP — `default-src 'self'`, `object-src 'none'`, `frame-src 'none'`, tight `connect-src`, `script-src 'self'` (no `unsafe-inline`/`unsafe-eval`). Monaco typically needs `style-src 'self' 'unsafe-inline'`; verify the editor and the `lsp:*`/`tauri://` IPC transport still function, then tighten. Consider test-enforcing that `csp` is non-null (ADR-021 §5 posture-note test is the model).

---

### ISSUE 11: Python `interpreter_path` spawned without validation against the probe

| Field | Value |
|---|---|
| **Severity** | Low → Moderate (defense-in-depth) |
| **Location** | `src-tauri/src/python_scaffold.rs` — `env_command()` l.345-356, `run_env_command()` l.534 |
| **Type** | Arbitrary process spawn |
| **Status** | Open |
| **Found** | 2026-07-16 |

- [ ] **Not remediated**

`config.interpreter_path` (frontend-supplied) flows into `Command::new(interpreter)` with fixed `-m venv .venv` args. It is never checked against the `detect_python_interpreters` results, nor verified to exist / be a Python executable. Under a webview compromise this becomes an arbitrary-program spawn (args are benign, but the *program* is attacker-chosen). Normal flow has the user pick a detected interpreter, so real-world risk is low.

**Recommendation**: Validate `interpreter_path` against the probe's returned set (or at minimum canonicalize + existence-check + allowlist the basename to `python`/`python3`/`pythonN(.exe)`) before spawning.

---

### ISSUE 12: npm scaffold path skips `validate_project_name`

| Field | Value |
|---|---|
| **Severity** | Low (defense-in-depth) |
| **Location** | `src-tauri/src/scaffold_runner.rs` — `run_scaffold()` l.83, l.132 |
| **Type** | Path traversal / argument-injection surface |
| **Status** | Open |
| **Found** | 2026-07-16 |

- [ ] **Not remediated**

The shared `validate_project_name` guards the Blank and Python creation paths, but the npm/CLI scaffold path uses `config.project_name` raw: `project_dir = location.join(&project_name)` (a `..`-laden name escapes the chosen location; only an `exists()` check follows), and the name is pushed as a subprocess argument. On the Windows **global-npm fallback** (executable `cmd`, prefix `["/C","npm"]`) that argument reaches `cmd.exe` — the BatBadBut (CVE-2024-24576) zone (the default bundled-npm path uses `node npm-cli.js`, no cmd.exe). Rust ≥1.77 mitigates batch-arg escaping, but this is the one creation path that actually spawns external commands and it is the unprotected one.

**Recommendation**: Route `run_scaffold` through the existing `validate_project_name` (consistency fix — the validator and two of three call sites already exist).

---

### ISSUE 13: Download stream has no size cap

| Field | Value |
|---|---|
| **Severity** | Low |
| **Location** | `src-tauri/src/lsp/download.rs` — `download_to()` l.163-218 |
| **Type** | Resource exhaustion (DoS) |
| **Status** | Open |
| **Found** | 2026-07-16 |

- [ ] **Not remediated**

The streamed download reads to EOF with no maximum-byte cap; `content-length` is read but used only for progress. Since the SHA is verified *after* the full download, a compromised/redirected endpoint (or a custom URL — ISSUE 14) can stream unbounded bytes and fill the disk before verification rejects them.

**Recommendation**: Enforce a hard cap (e.g. reject once `received` exceeds a sane ceiling, or a small multiple of `content-length`), returning a clear error and cleaning staging.

---

### ISSUE 14: Custom LSP install URL bypasses the https + SHA contract

| Field | Value |
|---|---|
| **Severity** | Low (by-design, consent-gated) |
| **Location** | `src-tauri/src/lsp/download.rs` — `install_server(custom_url)` l.363-370 |
| **Type** | Integrity / transport downgrade |
| **Status** | Open (accept-with-hardening) |
| **Found** | 2026-07-16 |

- [ ] **Not remediated**

A `custom_url` install (ADR §8, recorded as kind `custom`) skips the registry's https-and-64-hex-SHA validation entirely — no integrity pin (by design; the consent UI carries the warning) and **no scheme check**, so a custom URL may be plain `http://` (MITM-able). `ureq` is http(s)-only, so `file://` is not a vector.

**Recommendation**: Even for unverified custom installs, enforce `https://` on the URL. Keep the "integrity unverifiable" consent copy for the missing SHA.

---

## Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | `read_external_file` unrestricted | Moderate (↑ w/ #10) | **Fixed — PR #150** |
| 2 | Missing Tauri capability scopes | Low | **Fixed — PR #149** |
| 3 | TOCTOU race condition | Very low | Accepted |
| 4 | `.cmd` resolver path traversal | Moderate | **Fixed — PR #146** |
| 5 | Missing LSP command input validation | Moderate | **Fixed — PR #146** |
| 6 | Missing `project_root` validation | Moderate | **Fixed — PR #146** |
| 7 | Session key collision | Low | **Fixed — PR #146** |
| 8 | Env var passthrough risks | Low | **Fixed — PR #147** |
| 9 | Unsanitized error passthrough | Low | **Fixed — PR #147** |
| 10 | CSP disabled (`csp: null`) | Moderate | **Fixed — PR #151** |
| 11 | `interpreter_path` spawn unvalidated | Low→Mod | **Fixed — PR #144** |
| 12 | npm scaffold skips name validation | Low | **Fixed — PR #144** |
| 13 | Download stream has no size cap | Low | **Fixed — PR #145** |
| 14 | Custom install URL bypasses https+SHA | Low | **Fixed — PR #145** |
| dep | quick-xml 0.38.4 — 2× RUSTSEC (7.5) | High (advisory) | Blocked upstream |

**Fixed & merged to `main`**: **ALL 13** (issues 1, 2, 4–14) via PRs #144 (S1),
#145 (S2), #146 (S3), #147 (S5), #149 (S4), #150 (S6, ADR-022), #151 (S7,
ADR-023). **Critical / High (first-party code)**: 0 · **Accepted**: #3.
**Remediation build-plan S1–S7 COMPLETE.**

**Only residual — tracking, not code:** the `quick-xml` HIGH cargo advisory is
transitive via Tauri's `plist` and blocked upstream (`cargo update` can't move
it) — re-check on each Tauri bump. The 21 unmaintained/unsound cargo warnings and
the low `@babel/core` dev-dep advisory remain (npm `audit fix` clears babel).

---

## Audit History

| Date | Trigger | Scope | Findings |
|------|---------|-------|----------|
| 2026-03-19 | Pre-implementation review (group nest/merge) | Filesystem ops, path guard, Tauri config | 3 issues found |
| 2026-03-28 | LSP spawn pipeline fixes + periodic review | LSP transport, commands, dependencies | 6 new issues found, deps clean |
| 2026-07-16 | Owner-requested whole-repo audit (post ADR-005/020/021 arcs) | Tauri config/CSP, full IPC surface, download manager, scaffold + python creation, terminal/LSP spawn, frontend injection, SQL, secrets, deps | 5 new issues (10–14) + 2 HIGH cargo advisories (quick-xml, blocked upstream) + 1 low npm; issues 1–8 re-verified still open; 10 new Verified Strengths recorded |
| 2026-07-17 | Remediation execution (build-plan S1–S3) | Creation-path input validation, download manager, LSP command/spawn boundary | 8 findings fixed + merged to `main`: #11/#12 (PR #144), #13/#14 (PR #145), #4/#5/#6/#7 (PR #146). Each verified via cargo build/test + 4 guards + live CDP drive at the real IPC boundary. Observation: bundled pyright exits on startup under `tauri dev` (reproduces on `main` — pre-existing, not a remediation regression). |
| 2026-07-17 | Remediation execution (build-plan S4–S6) | LSP domain hygiene, Tauri capability surface, open-file boundary | 4 more findings fixed + merged: #8/#9 (PR #147, S5 — env allowlist + adapter error sanitization), #2 (PR #149, S4 — removed unused `opener:default` + posture test), #1 (PR #150, S6, ADR-022 — Rust-owned open-file dialog, `read_external_file` removed). **12 of 13 findings fixed; only #10 (CSP, S7) remains** + the blocked-upstream quick-xml dep. Merge-integration note: #142 (Slice-7, old branch) merged textually clean but needed a tuple-session-key fix on `main` (`db5c521`) to compile. |
| 2026-07-17 | Remediation execution (build-plan S7 — final) | Content-Security-Policy | #10 fixed + merged (PR #151, ADR-023): `csp: null` → strict production CSP (`script-src 'self'`, no unsafe-inline/eval — Tauri auto-nonces first-party; `object-src`/`frame-src 'none'`; `worker-src 'self' blob'` for Monaco; `connect-src ipc:`) + dev-only permissive `devCsp` for Vite HMR. Posture test blocks regression to null / unsafe script-src. Verified on a **production build** (`--no-bundle`; strict csp is prod-only): 0 CSP violations across boot/React/IPC/launcher/canvas/discovery/terminal (CDP), and Monaco editor mounted + rendered + hover with 0 violations on an owner-driven file open (live CDP capture). **ALL 13 findings now fixed + merged; only the blocked-upstream quick-xml dep remains.** |
