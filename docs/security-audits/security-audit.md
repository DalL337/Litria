# Litria Security Audit

> **Type**: Living document — reviewed periodically and after significant changes
> **Last reviewed**: 2026-08-27 — external automated scan (CodeRabbit), issues
> 15–21. Sink-reachability pass, `src-tauri/` only; see that section's scope
> note for what it does not cover. HEAD `0210780`.
> **Last whole-repo pass**: 2026-07-16
> **Scope (whole-repo pass)**: Tauri config/CSP, IPC command surface, ADR-005
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

### External scan 2026-08-27 (issues 15–21)

- [x] **#15** — `https_only(true)` agent for artifact downloads, so a redirect
  cannot step down to cleartext. *(2026-08-27)* — ✅ **`f898055`, branch
  `security/scan-hardening-2026-08-27`, pending PR.**
- [x] **#17** — Global LSP tier resolves to an absolute path; both transport arms
  spawn it. *(2026-08-27)* — ✅ **`271139c` (+ `0fb6e80` diagnostic log), pending PR.**
- [x] **#18** — cmd metacharacters (`& ^ ( ) % !`) added to the shared
  `validate_project_name` blocklist. *(2026-08-27)* — ✅ **`f13ae4e`, pending PR.**
- [x] **#20** — Bound archive expansion (1 GiB / 50k entries), measured not
  declared. *(2026-08-27)* — ✅ **`630bba8`, pending PR.**
- [ ] **#18b** — *Structural half of #18*: resolve the package-manager shim to an
  absolute path so cmd.exe never re-parses the argv (mirrors #17). Proven to work;
  blocklist holds the line until then. *(2026-08-27)*
- [ ] **#19** — Byte + count budget for renderer-originated crash records only;
  preserve the deliberate startup-only prune for the panic path. *(2026-08-27)*
- [ ] **#21** — Bind the LSP session key to a backend-registered canonical project
  root; add global/per-root/concurrent-start caps. *(2026-08-27)*
- [ ] **#17b** — *Owner decision, not started*: set
  `NoDefaultCurrentDirectoryInExePath=1` on the LSP child as defence in depth. Cheap
  and on-point, but it changes resolution for the language server's own shell-outs,
  so it was deliberately not shipped unilaterally. *(2026-08-27)*

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

> **Erratum (2026-08-27, issue 17):** still sound, but "clean environment" is not
> unconditionally safer. cmd.exe skips its current-directory search when
> `NoDefaultCurrentDirectoryInExePath` is set; some shells set it, and
> `env_clear()` removed it from the child — so this hardening was *withholding* a
> mitigation while `spawn_server` still passed a bare command name into an
> untrusted cwd. Fixed at the resolver (absolute paths) rather than by leaning on
> the variable. General lesson for future allowlist review: ask what each removed
> variable was *protecting*, not only what it was exposing.

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

## External Scan — CodeRabbit, 2026-08-27 (issues 15–21)

First third-party automated review of the repository. 7 findings (4 High, 3
Medium, 0 Critical, 0 Low by the tool's rating), **all in `src-tauri/`** — zero
in the 42.6k lines of frontend JS. Every mechanism was verified against HEAD
`0210780` before any code was written: **0 false positives**, though severity
needed re-rating against Litria's threat model, which the scanner cannot see.

Full triage, evidence, and rejected designs: `.research/2026-08-27-coderabbit-security-scan-triage.md`.

**Scope note — what this scan does NOT cover**, so its size is not misread as a
clean posture: renderer-side issues (CSP, XSS, untrusted project content
rendered by Monaco/markdown), dependency and supply-chain state, and
logic/authorization flaws. It is a sink-reachability pass. Its concentration in
`src-tauri/` reflects the IPC architecture — every dangerous sink lives behind
the command boundary — rather than a gap in the walk.

Three findings (15, 17, 20) are ground the 2026-07-16 whole-repo pass missed.

### ISSUE 15: Artifact download follows redirects to cleartext

| | |
|---|---|
| **Severity** | High — it erodes an *already accepted* mitigation |
| **Location** | `src-tauri/src/lsp/download.rs` — `download_to` |
| **CWE** | 319 |

`require_https_custom_url` checks only the URL the user typed; the download then
ran through a bare `ureq::get`. ureq 3.3.0 defaults to `https_only: false` with
10 redirects (`config.rs:868`/`874`), so an https endpoint could bounce the
download to cleartext http. This is the load-bearing half of why **ISSUE 14** was
accepted at Low: the missing SHA pin was tolerable *because* the transport was
guaranteed encrypted.

**Fixed** — all downloads run through an agent with `https_only(true)`. ureq
re-tests the scheme at the top of `call_run` (`run.rs:149`), which the redirect
loop re-enters per hop, so downgrade is refused anywhere in the chain.

### ISSUE 16: Custom install URL has no integrity pin — RE-AFFIRMED AS ACCEPTED

| | |
|---|---|
| **Severity** | Low (tool rated High) |
| **Location** | `src-tauri/src/lsp/download.rs` — `install_server(custom_url)` |
| **CWE** | 494 |

The same surface as **ISSUE 14**. ADR-005 §8: a custom URL is a deliberate,
consent-gated escape hatch whose integrity is explicitly unverifiable, and the
consent UI carries that warning. The scanner rates it High because it can see
neither the ADR nor the consent surface.

**Accepted, unchanged.** Recorded here so the decision is visible to the next
scan rather than re-litigated. The correct response was to repair what made the
accepted risk worse than accepted — issues 15 and 20 — both now fixed.

### ISSUE 17: Global LSP tier spawns a name the project can shadow

| | |
|---|---|
| **Severity** | **High — the most serious of the set** |
| **Location** | `src-tauri/src/lsp/resolver.rs` `probe_global` + `transport.rs` `spawn_server` |
| **CWE** | 426 |

`probe_global` returned the bare command name; the transport ran
`cmd /C <name>` with the child's cwd set to the user's project root. Windows
resolves a bare command against the working directory **before** PATH, so a
`rust-analyzer.bat` / `clangd.exe` / `gopls.cmd` committed to a repository ran
instead of the probed binary. **Precondition is only "open an untrusted
project"** — no hostile renderer, no other user action. This is the
trust-the-workspace class that has produced repeated CVEs in other IDEs.

Confirmed by live demonstration, not inference (journal has the transcript).

**Fixed** — `probe_global` resolves to the absolute file `where` reports and both
transport arms spawn `resolved.executable`; resolution failure falls through to
the managed tier (an install pill is the safe failure) and is logged.

Two things the fix surfaced, both worth keeping:

1. **`env_clear()` was removing a mitigation.** cmd.exe skips the cwd search when
   `NoDefaultCurrentDirectoryInExePath` is set, and some shells set it — but
   `spawn_server` clears the environment and re-adds four variables, so the LSP
   child never inherited it. The clean-environment hardening was itself stripping
   the protection. The regression test does the same `env_remove` so it
   reproduces the app rather than the developer's shell.
2. **The Unix arm ignored `resolved.executable`** and hardcoded `pack.command`,
   discarding the absolute path from the GOPATH fallback — `probe_gopath_bin`
   could never have worked. Latent pre-existing bug, unrelated to security,
   fixed by the same unification.

*Capability note (owner question, 2026-08-27):* this does not constrain language
capability or future diagnostics — resolution only decides which file is exec'd.
Toolchain managers (rustup/asdf/mise/volta/pyenv) are unaffected because an
absolute path resolves **to** the shim, not **through** it; the shim still runs
with cwd = project root and still reads `rust-toolchain.toml`/`.tool-versions`.
What changes: a project supplying its own server binary in its root used to work
by accident, and that accident was the vulnerability. "Use the workspace's own
server version" remains a good future feature but should be an explicit fourth
tier with a consent surface (VS Code gates its TypeScript equivalent behind
workspace trust for this exact reason).

### ISSUE 18: Project name reaches cmd.exe as a command separator

| | |
|---|---|
| **Severity** | Moderate as a defect; Low as an attack (tool rated High) |
| **Location** | `src-tauri/src/blank_project.rs` `validate_project_name` → `scaffold_runner.rs` |
| **CWE** | 78 |

The name becomes a directory **and** an argument to `cmd /C <pm> create ...` on
the Windows global package-manager path (pnpm/yarn always; npm when the bundled
runtime is absent). The validator was written as a folder-segment contract and
allowed `&`. Note **ISSUE 12** already fixed the *absence* of validation here and
its code comment names the cmd.exe hazard explicitly — the gap was between the
identified risk and what the shared validator actually enforced.

Verified live rather than reasoned about: `cmd /C show demo&marker` yields
`ARG=[demo]` followed by `marker.bat` executing.

Severity re-rated because the attacker is the user typing their own project
name; the realistic vector is social engineering. It is also a plain
**correctness** bug — a project named "Rock & Roll" misbehaved on that path.

**Fixed (blocklist half)** — `& ^ ( ) % !` added to `FORBIDDEN`, covering command
separation, escaping, grouping, and variable/delayed expansion. Placed at the
shared validator per security-policy Rule 4 (a chokepoint rule belongs at the
chokepoint); all three callers were swept first and all produce folder names.

**Open follow-up (structural half)**: resolve the package-manager shim to an
absolute path so cmd.exe never re-parses, mirroring the ISSUE 17 fix. Proven to
work by the same probe — `Command::new(<abs>\show.bat)` with the identical
argument yields `ARG=["demo&marker"]`, inert, via Rust's post-CVE-2024-24576
batch escaping.

### ISSUE 19: Renderer crash records are unbounded — OPEN

| | |
|---|---|
| **Severity** | Low–Moderate (defense in depth) |
| **Location** | `src-tauri/src/crash/record.rs` — `write_json` |
| **CWE** | 400 |

One fresh file per record with no count or byte budget; `prune` runs at startup
only. The startup-only choice is deliberate and documented (no directory I/O at
crash time) and should be preserved.

**Recommendation**: a counter + byte budget for **renderer-originated** records
(`crash_write_js_record`) only, leaving the panic hook's allocation-light path
untouched. Requires a hostile renderer to exploit.

### ISSUE 20: Archive extraction is unbounded (decompression bomb)

| | |
|---|---|
| **Severity** | Moderate |
| **Location** | `src-tauri/src/lsp/download.rs` — `extract_archive` |
| **CWE** | 409 |

`MAX_ARTIFACT_BYTES` (ISSUE 13) caps the *compressed* download and bounds
nothing about disk. The 2026-07-16 extraction review covered zip-slip but not
expansion ratio. Reachable via the custom-URL path, so it inherits ISSUE 16's
consent gate.

**Design finding worth recording**: the obvious guard — pre-flighting each
entry's declared uncompressed size — is **unsound**. zip 2.4.2 bounds an entry
reader with `.take(compressed_size)` (`read.rs:347`), so the declared
uncompressed size is never enforced during extraction and a crafted archive can
under-report it freely. It would have reviewed as correct.

**Fixed** — `MAX_EXPANDED_BYTES` (1 GiB) + `MAX_ARCHIVE_ENTRIES` (50k).
Streaming formats (`.gz`, `.tar.gz`) wrap the decompressed reader in a
`BoundedRead` that **errors** rather than reporting EOF at the limit (a clean
EOF would look to gzip/tar like truncation and install a half-extracted server
as a success). `.zip` decompresses every entry to a sink — no disk writes — to
measure real expansion, then calls `zip.extract()` unchanged, deliberately
keeping zip-slip protection, symlink handling, and the unix-mode pass as
audited rather than re-implementing them around a byte counter.

**Known gap**: the tar path is byte-bounded only; entry-count would require
hand-rolled per-entry unpacking. No current artifact uses tar.

### ISSUE 21: LSP session key is not bound to the canonical project root — OPEN

| | |
|---|---|
| **Severity** | Low (defense in depth) |
| **Location** | `src-tauri/src/lsp/session.rs` — `session_key` / `start_session` |
| **CWE** | 770 |

Dedupe is on the caller-supplied `(project_id, language_id)` tuple. Both ids are
length-capped (ISSUE 5) and duplicates rejected (ISSUE 7), but `project_root` is
validated and then never used to derive or check the key, so varying
`project_id` spawns N servers for one directory. No global or per-root quota.

**Recommendation**: key or validate against a backend-registered canonical root,
plus small global/per-root/concurrent-start caps. Requires a hostile renderer —
which in a local IDE means an XSS in Litria's own UI first.

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
| 15 | Download follows redirects to cleartext | High | **Fixed — `f898055`** ‡ |
| 16 | Custom install URL has no integrity pin | Low | Accepted (ADR-005 §8; re-affirms #14) |
| 17 | Global LSP tier spawns a shadowable name | High | **Fixed — `271139c`** ‡ |
| 18 | Project name reaches cmd.exe as separator | Moderate | **Fixed (blocklist) — `f13ae4e`** ‡ |
| 19 | Renderer crash records unbounded | Low–Mod | Open |
| 20 | Archive extraction unbounded (bomb) | Moderate | **Fixed — `630bba8`** ‡ |
| 21 | LSP session key not bound to canonical root | Low | Open |
| dep | quick-xml 0.38.4 — 2× RUSTSEC (7.5) | High (advisory) | Blocked upstream |

‡ On branch `security/scan-hardening-2026-08-27`, **pending PR** — not yet on
`main`. Update these to PR numbers on merge.

**Fixed & merged to `main`**: **ALL 13** (issues 1, 2, 4–14) via PRs #144 (S1),
#145 (S2), #146 (S3), #147 (S5), #149 (S4), #150 (S6, ADR-022), #151 (S7,
ADR-023). **Critical / High (first-party code)**: 0 · **Accepted**: #3.
**Remediation build-plan S1–S7 COMPLETE.**

**External scan, 2026-08-27 (issues 15–21):** 7 findings, **0 false positives**,
all in `src-tauri/`. 4 fixed on branch `security/scan-hardening-2026-08-27`
(15, 17, 18, 20 — every finding the tool rated High, plus the substantive
Medium); 1 re-affirmed as accepted by design (16); **2 open** (19, 21), both
requiring a hostile renderer. One follow-up outstanding: the structural half of
18 (resolve the package-manager shim so cmd.exe never re-parses).

Severity re-rated against the threat model in three places — see the section for
each. The scan found three issues (15, 17, 20) that the 2026-07-16 whole-repo
pass missed; #17 in particular was exploitable by opening an untrusted project.

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
| 2026-08-27 | External automated scan (CodeRabbit) + same-session remediation | Sink-reachability pass over `src-tauri/`; renderer, dependencies, and logic flaws NOT covered | 7 new issues (15-21), 0 false positives, 0 in 42.6k lines of frontend JS. 3 were ground the whole-repo pass missed (15, 17, 20). **#17 was the significant one** - opening an untrusted repo containing `rust-analyzer.bat` executed it (Windows cwd-before-PATH); confirmed by live demonstration, and the fix surfaced that `env_clear()` had been stripping `NoDefaultCurrentDirectoryInExePath`, plus a latent bug where the Unix arm discarded the GOPATH fallback's absolute path. 4 fixed on branch (15/17/18/20), 1 re-affirmed accepted (16), 2 open (19/21, both hostile-renderer-gated). Design finding recorded under #20: zip's declared uncompressed size is unusable as a bomb guard (`.take(compressed_size)`), so the guard measures real expansion. Full triage: `.research/2026-08-27-coderabbit-security-scan-triage.md`. |
