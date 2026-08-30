# Litria Security Audit

> **Type**: Living document — reviewed periodically and after significant changes
> **Last reviewed**: 2026-08-30 — **checklist close-out (PRs #4–#8)**: every
> remaining actionable finding closed (#17b, #18b, #19, #21) and the `quick-xml`
> HIGH advisory cleared, which turned out not to be blocked upstream any more.
> **The Master Remediation Checklist now has no open code findings.** Preceded
> by 2026-08-28 (external-scan remediation round 2, PR #3: corrections to issues
> 17 and 20) and the 2026-08-27 external automated scan (CodeRabbit), issues
> 15–21 — a sink-reachability pass over `src-tauri/` only; see that section's
> scope note for what it does not cover.
> **Last whole-repo pass**: 2026-07-16
> **Scope (whole-repo pass)**: Tauri config/CSP, IPC command surface, ADR-005
> download manager (pins/SHA/extraction), ADR-021 scaffold runner, ADR-020
> Python creation, terminal/LSP spawn surfaces, frontend injection sinks, SQL,
> secrets, dependency supply chain. HEAD `72c18fe` (branch
> `fix/probe-global-hollow-shim`).

---

## Dependency Supply Chain

### npm (234 packages audited)
- [x] **0 vulnerabilities — rescanned 2026-08-28.** Production-only
  (`npm audit --omit=dev`) was already 0; the full tree carried **1 high**,
  `nanoid <3.3.18` (GHSA-2v37-7h3g-55p8 — custom generators loop indefinitely
  when size is zero). Dev-only and non-material to the shipped app, but High and
  a one-line lockfile fix, so it was cleared rather than tracked: `npm audit fix`
  moved nanoid to 3.3.18 (3 lines of `package-lock.json`, `package.json`
  untouched; 1037 JS tests + 5 guards re-run green). **npm audit = 0.**
- History: 2026-07-16 carried 1 low (`@babel/core` GHSA-4x5r-pxfx-6jf8), cleared
  by `npm audit fix` in PR #152. 2026-03-28 scanned 0 vulns across 263 packages.

### Cargo (586 crate dependencies)
- [x] **0 vulnerabilities — cleared 2026-08-30.** `cargo audit` reports no
  advisories. The two HIGH `quick-xml 0.38.4` findings below are retired.
- [x] **2 HIGH vulnerabilities (raised 2026-07-16, CLEARED 2026-08-30)** —
  `quick-xml 0.38.4`:
  - RUSTSEC-2026-0194 (7.5) — quadratic runtime on duplicate attribute names (DoS).
  - RUSTSEC-2026-0195 (7.5) — unbounded namespace-declaration allocation → memory
    exhaustion (DoS). Fix: quick-xml `>=0.41.0`.
  - Path was `quick-xml ← plist 1.8.0 ← tauri-plugin-{opener,fs,dialog} +
    tauri-codegen`, and it was carried as blocked-upstream for six weeks because
    `plist 1.8.0` pinned the 0.38.x line.
  - **Not blocked any more.** `cargo update -p plist` moves plist 1.8.0 → 1.10.0
    and removes quick-xml 0.38.4 from the tree entirely; the remaining
    quick-xml 0.41.0 is the copy `wayland-scanner` already pulled, so one now
    serves both. Lockfile only — Tauri's own requirement always permitted the
    newer plist. ✅ **merged PR #7 (2026-08-30).**
  - **Method note worth keeping:** the "blocked upstream, `cargo update` locks 0
    packages" line was accurate when written and was re-read rather than re-run
    at the 2026-08-28 rescan. A blocked-upstream item has to be **re-probed** on
    each pass, not re-read — the probe is one command and the note has no way to
    tell you it went stale.
  - **Rescanned 2026-08-28: unchanged** (the last pass at which this was true).
- [ ] **22 upstream warnings** (was 21 at 2026-07-16, 18 before that) —
  unmaintained/unsound transitive deps. **New at the 2026-08-28 rescan:**
  `fxhash` unmaintained (RUSTSEC-2025-0057), transitive via the Tauri/GTK tree.
  All still blocked upstream; the list below is the 2026-07-16 breakdown.
- [ ] *(2026-07-16 breakdown)* 21 upstream warnings — unmaintained/unsound deps.
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

> **Status 2026-08-30 — no open code findings.** Every finding raised across the
> 2026-03-19, 2026-03-28, 2026-07-16 and 2026-08-27 passes is now fixed, or
> accepted with a recorded reason (#3, #16). The only unchecked line left is the
> 22 unmaintained-transitive cargo warnings, which are blocked on Tauri's GTK4
> migration and are tracking-only. `cargo audit` = 0 vulnerabilities;
> `npm audit` = 0.
>
> This is a snapshot of *findings raised*, not a claim of absence. The last
> whole-repo pass was 2026-07-16; the 2026-08-27 external scan covered
> `src-tauri/` sinks only, and found three things that whole-repo pass had
> missed. An empty checklist is due for the next pass, not proof there is
> nothing to find.

### Do first (highest leverage)

- [x] **#10** — Enable a restrictive CSP (`csp: null` → `default-src 'self'`,
  no `unsafe-inline`/`eval` on scripts). Single change that contains #1/#11/#12
  if XSS ever lands. *(2026-07-16)* — ✅ **merged PR #151 (2026-07-17, S7, ADR-023; strict prod `csp` + dev-only `devCsp`, verified on a production build incl. Monaco under CSP).**
- [x] **dep** — `quick-xml` 0.38.4 (2× RUSTSEC-2026-0194/0195, HIGH DoS).
  *(2026-07-16)* — ✅ **merged PR #7 (2026-08-30); `cargo update -p plist`
  (1.8.0 → 1.10.0) drops quick-xml 0.38.4 from the tree. `cargo audit` = 0.
  It had stopped being blocked upstream some time before anyone re-probed —
  see the Cargo section's method note.**

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
  `security/scan-hardening-2026-08-27`, merged PR #1.**
- [x] **#17** — Global LSP tier resolves to an absolute path; both transport arms
  spawn it. *(2026-08-27)* — ✅ **`271139c` (+ `0fb6e80` log), merged PR #1; scope
  corrected to Unix in PR #3 — see the ISSUE 17 erratum.**
- [x] **#18** — cmd metacharacters (`& ^ ( ) % !`) added to the shared
  `validate_project_name` blocklist. *(2026-08-27)* — ✅ **`f13ae4e`, merged PR #1.**
- [x] **#20** — Bound archive expansion to 1 GiB of real (measured, not
  declared) output. Entry count capped at 50k for BOTH zip and tar.gz — the tar
  count pass was added in PR #3 after review flagged that the original fix left
  it documented-but-unenforced. *(2026-08-27)* — ✅ **`630bba8` + PR #3.**
- [x] **#18b** — *Structural half of #18*: resolve the package-manager shim to an
  absolute path so cmd.exe never re-parses the argv (mirrors #17). *(2026-08-27)*
  — ✅ **merged PR #4 (2026-08-30); `absolute_pm_path`, global tier spawns the
  absolute shim with no prefix args. Blocklist retained at the chokepoint.**
- [x] **#19** — Byte + count budget for renderer-originated crash records only;
  preserve the deliberate startup-only prune for the panic path. *(2026-08-27)*
  — ✅ **merged PR #5 (2026-08-30); session-scoped 16 records / 4 MiB,
  `write_js_value`. Panic hook and once-per-event synthesizers untouched.**
- [x] **#21** — Bind the LSP session key to a backend-registered canonical project
  root; add global/per-root/concurrent-start caps. *(2026-08-27)* — ✅ **merged
  PR #6 (2026-08-30); validates rather than re-keys (no IPC-surface change),
  caps 8/root · 24 global · 4 concurrent starts.**
- [x] **#17b** — Set `NoDefaultCurrentDirectoryInExePath=1` on the LSP child as
  defence in depth. *(2026-08-27)* — ✅ **owner-ruled ship, 2026-08-30; merged
  PR #8. Held for a ruling because it changes resolution for the language
  server's own shell-outs — which is also precisely why it is worth having.**

### Accepted / not independently actionable

- [x] **#3** — Path-resolution TOCTOU — accepted (single-user desktop; revisit
  only if multi-user / server). *(2026-03-28)*
- [ ] **22 cargo warnings** — unmaintained / unsound transitive deps (GTK3,
  `unic-*`, `glib`, `anyhow`, `rand`, `fxhash`) — blocked on Tauri upstream.
  *(tracking only — **re-probe, don't re-read**: `cargo audit` each pass, per the
  quick-xml lesson)*
- [x] **1 low npm** — `@babel/core` dev-dep advisory. *(2026-07-16)* — ✅
  **cleared by PR #152; re-verified 2026-08-30, `npm audit` = 0 across every
  severity. This line had outlived its finding.**

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

## Finding Register

Every finding ever raised, in the order it was numbered — fixed, accepted, and
open alike. The Master Remediation Checklist above is the working view; this is
the detail each entry points at.

> **Renamed from "Open Findings" 2026-08-30.** The heading had outlived its
> contents: issues 1–14 all shipped in the S1–S7 arc on 2026-07-17, but each
> write-up still carried `Status: Open` / `Not remediated` because only the
> checklist and the summary table were updated at merge time. A reader landing
> in this section would have counted thirteen open findings that were closed six
> weeks earlier. Per-issue Status fields are now synced with the checklist —
> **when a finding lands, update both.**

### ISSUE 1: `read_external_file` has no project root boundary

| Field | Value |
|---|---|
| **Severity** | Moderate |
| **Location** | `src-tauri/src/project_ops.rs` — `read_external_file()` |
| **Type** | Information disclosure |
| **Status** | Fixed — PR #150 (S6, ADR-022) |
| **Found** | 2026-03-19 |

- [x] **Remediated — PR #150 (S6, ADR-022)**

Accepts any absolute file path and reads contents. No boundary check. Every other filesystem command validates project root — this is the exception. Read-only risk, but if a webview vulnerability allows arbitrary JS execution, this becomes an information disclosure primitive (SSH keys, .env files, etc.).

**Recommendation**: Scope to file-picker-consented paths (Option A), or audit and document all call sites (Option B), or remove if unused (Option C).

---

### ISSUE 2: Tauri capabilities config has no filesystem scope

| Field | Value |
|---|---|
| **Severity** | Low |
| **Location** | `src-tauri/capabilities/default.json` |
| **Type** | Missing defense-in-depth |
| **Status** | Fixed — PR #149 (S4) |
| **Found** | 2026-03-19 |

- [x] **Remediated — PR #149 (S4)**

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
| **Status** | Fixed — PR #146 (S3) |
| **Found** | 2026-03-28 |

- [x] **Remediated — PR #146 (S3)**

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
| **Status** | Fixed — PR #146 (S3) |
| **Found** | 2026-03-28 |

- [x] **Remediated — PR #146 (S3)**

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
| **Status** | Fixed — PR #146 (S3) |
| **Found** | 2026-03-28 |

- [x] **Remediated — PR #146 (S3)**

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
| **Status** | Fixed — PR #146 (S3) |
| **Found** | 2026-03-28 |

- [x] **Remediated — PR #146 (S3)**

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
| **Status** | Fixed — PR #147 (S5) |
| **Found** | 2026-03-28 |

- [x] **Remediated — PR #147 (S5)**

`PYTHONPATH` and `NODE_PATH` in env allowlists could inject code paths into language servers if the parent process has malicious values. Desktop context makes this low risk — the parent is the OS shell.

**Recommendation**: Consider removing `PYTHONPATH` and `NODE_PATH` unless needed for virtual environment support. If kept, document the trust assumption.

---

### ISSUE 9: Backend error objects passed unsanitized to frontend

| Field | Value |
|---|---|
| **Severity** | Low |
| **Location** | `src/lsp/createLspAdapters.js` — catch blocks |
| **Type** | Information disclosure |
| **Status** | Fixed — PR #147 (S5) |
| **Found** | 2026-03-28 |

- [x] **Remediated — PR #147 (S5)**

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
| **Status** | Fixed — PR #151 (S7, ADR-023) |
| **Found** | 2026-07-16 |

- [x] **Remediated — PR #151 (S7, ADR-023)**

Tauri injects no `Content-Security-Policy` when `csp` is `null`. The app has no HTML-injection sinks today (verified — see Verified Strengths), so this is not an active XSS. But CSP is the layer that would *contain* any XSS introduced later (a new feature, a compromised frontend dependency, unsanitized markdown), and several IPC commands (ISSUE 1 `read_external_file`, ISSUE 11 interpreter spawn, ISSUE 12 scaffold name) would become escalation primitives if one landed. This single change raises the floor under most Moderate findings.

**Recommendation**: Set a restrictive CSP — `default-src 'self'`, `object-src 'none'`, `frame-src 'none'`, tight `connect-src`, `script-src 'self'` (no `unsafe-inline`/`unsafe-eval`). Monaco typically needs `style-src 'self' 'unsafe-inline'`; verify the editor and the `lsp:*`/`tauri://` IPC transport still function, then tighten. Consider test-enforcing that `csp` is non-null (ADR-021 §5 posture-note test is the model).

---

### ISSUE 11: Python `interpreter_path` spawned without validation against the probe

| Field | Value |
|---|---|
| **Severity** | Low → Moderate (defense-in-depth) |
| **Location** | `src-tauri/src/python_scaffold.rs` — `env_command()` l.345-356, `run_env_command()` l.534 |
| **Type** | Arbitrary process spawn |
| **Status** | Fixed — PR #144 (S1) |
| **Found** | 2026-07-16 |

- [x] **Remediated — PR #144 (S1)**

`config.interpreter_path` (frontend-supplied) flows into `Command::new(interpreter)` with fixed `-m venv .venv` args. It is never checked against the `detect_python_interpreters` results, nor verified to exist / be a Python executable. Under a webview compromise this becomes an arbitrary-program spawn (args are benign, but the *program* is attacker-chosen). Normal flow has the user pick a detected interpreter, so real-world risk is low.

**Recommendation**: Validate `interpreter_path` against the probe's returned set (or at minimum canonicalize + existence-check + allowlist the basename to `python`/`python3`/`pythonN(.exe)`) before spawning.

---

### ISSUE 12: npm scaffold path skips `validate_project_name`

| Field | Value |
|---|---|
| **Severity** | Low (defense-in-depth) |
| **Location** | `src-tauri/src/scaffold_runner.rs` — `run_scaffold()` l.83, l.132 |
| **Type** | Path traversal / argument-injection surface |
| **Status** | Fixed — PR #144 (S1) |
| **Found** | 2026-07-16 |

- [x] **Remediated — PR #144 (S1)**

The shared `validate_project_name` guards the Blank and Python creation paths, but the npm/CLI scaffold path uses `config.project_name` raw: `project_dir = location.join(&project_name)` (a `..`-laden name escapes the chosen location; only an `exists()` check follows), and the name is pushed as a subprocess argument. On the Windows **global-npm fallback** (executable `cmd`, prefix `["/C","npm"]`) that argument reaches `cmd.exe` — the BatBadBut (CVE-2024-24576) zone (the default bundled-npm path uses `node npm-cli.js`, no cmd.exe). Rust ≥1.77 mitigates batch-arg escaping, but this is the one creation path that actually spawns external commands and it is the unprotected one.

**Recommendation**: Route `run_scaffold` through the existing `validate_project_name` (consistency fix — the validator and two of three call sites already exist).

---

### ISSUE 13: Download stream has no size cap

| Field | Value |
|---|---|
| **Severity** | Low |
| **Location** | `src-tauri/src/lsp/download.rs` — `download_to()` l.163-218 |
| **Type** | Resource exhaustion (DoS) |
| **Status** | Fixed — PR #145 (S2) |
| **Found** | 2026-07-16 |

- [x] **Remediated — PR #145 (S2)**

The streamed download reads to EOF with no maximum-byte cap; `content-length` is read but used only for progress. Since the SHA is verified *after* the full download, a compromised/redirected endpoint (or a custom URL — ISSUE 14) can stream unbounded bytes and fill the disk before verification rejects them.

**Recommendation**: Enforce a hard cap (e.g. reject once `received` exceeds a sane ceiling, or a small multiple of `content-length`), returning a clear error and cleaning staging.

---

### ISSUE 14: Custom LSP install URL bypasses the https + SHA contract

| Field | Value |
|---|---|
| **Severity** | Low (by-design, consent-gated) |
| **Location** | `src-tauri/src/lsp/download.rs` — `install_server(custom_url)` l.363-370 |
| **Type** | Integrity / transport downgrade |
| **Status** | Fixed — PR #145 (S2) |
| **Found** | 2026-07-16 |

- [x] **Remediated — PR #145 (S2)**

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

**Fixed** — `probe_global` resolves to the absolute file `where`/`which` reports
and both transport arms spawn `resolved.executable`; resolution failure falls
through to the managed tier (an install pill is the safe failure) and is logged.

> **Erratum (2026-08-28 — corrected scope).** The first fix was Windows-only, on
> the stated grounds that "Unix `execvp` searches PATH only and never the working
> directory." That was **wrong**, and the external review caught it. PATH is
> forwarded to the child, and a PATH containing `.` or an empty entry — which
> POSIX defines *as* the current directory — is consulted after the child has
> chdir'd into the project root. A misconfigured PATH reproduces the entire bug
> on Unix. Resolution is now absolute on **both** platforms, `which`'s answer is
> canonicalized when relative (a `.` in PATH makes `which` reply with a relative
> path, which would otherwise be re-resolved against the project root and defeat
> the fix), and `resolve_node` — which the bundled tier spawns with the same cwd
> — got the same treatment. Exploitability remains Difficult: it needs a
> user-misconfigured PATH.
>
> **Verified negative, recorded so nobody hardens it speculatively:** Rust's
> `Command::new(<bare name>)` does **not** search the child's `current_dir` on
> Windows (tested 2026-08-28 with the parent cwd held separate — the naive test
> that keeps them together gives a false positive). Only cmd.exe searches its
> cwd. That is precisely why the defect required the `cmd /C` shape, and why the
> bundled tier's bare `node` was never a Windows exposure.

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

**Fixed (structural half — ISSUE 18b, 2026-08-30, PR #4)**: `absolute_pm_path`
resolves the shim from Litria's own cwd and the global tier spawns it directly
with no prefix args, so nothing re-parses the argv and the child's own directory
can no longer shadow it (the ISSUE 17 hazard, in the scaffold domain). Both
halves of the probe were re-run before the change rather than taken from this
write-up: `cmd /C show demo&marker` yields `ARG=[demo]` followed by `marker.bat`
executing; `Command::new(<abs>\show.cmd)` with the identical argument yields
`ARG=["demo&marker"]`, inert, via Rust's post-CVE-2024-24576 batch escaping. The
blocklist stays — it is the chokepoint, and it also covers the folder name.

> **Trap found while fixing, worth carrying to any future `where`-based
> resolver:** the first line of `where` output is not necessarily executable.
> `where npm` answers with the extension-less Unix shell script
> (`…\nodejs\npm`) *before* `…\nodejs\npm.cmd`, and `Command::new` on the former
> fails outright (os error 2) — so the naive "take the first line" resolver
> would have broken the global-npm path while looking correct. The scaffold
> resolver prefers the first candidate carrying an executable extension.
> `lsp/resolver.rs::absolute_path_on_path` has the same `.lines().next()` shape;
> it is **not** live there (`where node` returns only `node.exe`, and the other
> global-tier commands are real `.exe` files), but it is one PATH layout away
> from mattering.

### ISSUE 19: Renderer crash records are unbounded

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

**Fixed (2026-08-30, PR #5)** — `write_js_value`, a budgeted writer used by the
renderer command alone. The budget is **session-scoped**, which is what lets it
add no directory I/O at all: counters start at zero each process start, and a
process start is exactly when `prune` already runs, so total disk cost is one
session's allowance plus the pruned carry-over. 16 records / 4 MiB, with count
and bytes reserved together under one lock so two concurrent commands cannot
both pass the check and both spend; a failed write refunds. Exhaustion returns
`None` — the shape the caller already used for an over-size record — and logs
the reason rather than refusing silently.

The startup-only prune is preserved exactly as designed, and so are the paths a
caller cannot drive in a loop: the panic hook, the webview watcher, and the
unclean-shutdown synthesizer all still go through the unbudgeted `write_json` /
`write_value`.

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

> **Addendum (2026-08-28 — the "known gap" is closed).** The original fix left
> tar byte-bounded only and *documented* the missing entry cap, reasoning that
> `unpack()` offers no entry hook and no current artifact uses tar. External
> review pushed back, correctly: documenting is not fixing, and the cap is
> cheap. `ensure_tar_entries_are_bounded` now walks `entries()` in a counting
> pass before `unpack()` — the same measure-then-extract shape as zip, so
> `unpack`'s traversal safety is untouched — and the stream stays wrapped in
> `BoundedRead` so a bomb aborts during counting rather than being tallied
> patiently to completion. **50k entries now applies to zip and tar alike.**
>
> **Residual, accepted with evidence:** `ZipArchive::new` pre-allocates central-
> directory storage before any of our limits can run, so a crafted archive could
> in principle force a large allocation. Rated Low, not Major, on inspection of
> zip 2.4.2: it distrusts a declared count exceeding `directory_start` and
> allocates zero instead (`read.rs:692-696`), and separately rejects an oversized
> central directory against `isize::MAX`. Reaching a damaging allocation needs an
> actual ~512 MiB archive (the download cap) declaring a matching entry count,
> via the consent-gated custom-URL path, and the outcome is an allocation failure
> rather than code execution. The reviewer's suggested fix — cap entries *before*
> parser allocation — is not implementable through the crate's public API: the
> entry count is not knowable without parsing the central directory, which is
> exactly what `ZipArchive::new` does. Revisit if zip exposes a pre-parse limit.

### ISSUE 21: LSP session key is not bound to the canonical project root

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

**Fixed (2026-08-30, PR #6)** — took the *validate* branch of that
recommendation, not the *re-key* branch: re-keying `SessionKey` would change
`stop_session` / `session_request` / `session_notify` and every JS adapter, which
is more surface than a defence-in-depth finding earns. The root is canonicalized
once at start and stored on `LspSession`, and the bindings are **derived** from a
scan of the registry rather than kept in a second index that could drift out of
step with the sessions it describes.

Canonicalization is comparison only — the original `project_root` string still
reaches `current_dir` and `rootUri`, so servers see no change. (On Windows
`canonicalize` yields a `\\?\` verbatim path, which some servers dislike as a
root; that is why it is not substituted.)

Four refusals, each with its own error code so a refusal is diagnosable:
same root + language under a different `project_id` (the finding);
one `project_id` claiming two roots (the inverse confusion — checking it is what
makes the first check trustworthy); per-root cap 8; global cap 24.

The **concurrent-start cap (4)** is the one that actually bounds a burst: a start
holds a spawned child through the ~1–2s handshake before it is ever registered,
so the registry caps are blind to it. `STARTING` therefore carries the canonical
root alongside the key.

Also closed here, and worth noting as a pattern: the quota *policy* is a pure
function over a slice of `(project_id, language_id, canonical_root)` identities,
so all seven cases are unit-tested without spawning a language server.

### ISSUE 17b: LSP child does not suppress the current-directory executable search

| | |
|---|---|
| **Severity** | Low (defence in depth) |
| **Location** | `src-tauri/src/lsp/transport.rs` — `spawn_server` env build |
| **CWE** | 427 |

Split out of ISSUE 17 as an owner decision. cmd.exe and `SearchPath` consult the
current directory before PATH for a bare command name, and the LSP child's
current directory is the project root. ISSUE 17 closed that at the resolver by
committing to absolute paths; what the resolver cannot reach is the language
server's **own** shell-outs.

Held rather than shipped with #17 because it changes resolution for those
shell-outs — a genuine behaviour change, and the kind that belongs to the owner
rather than to the agent that noticed it.

**Fixed (2026-08-30, owner-ruled ship; PR #8)** —
`apply_windows_system_env` sets `NoDefaultCurrentDirectoryInExePath=1` on every
LSP child. This **restores** a mitigation rather than inventing one: some shells
set the variable, `env_clear()` strips it, and the ISSUE 17 erratum already
records that the clean-environment hardening was withholding it from exactly the
child that needed it. Every server Litria packs resolves its toolchain on PATH
(rust-analyzer → `cargo`, gopls → `go`) or by absolute path (pyright → the
interpreter), and a project directory answering a bare name is the attack being
closed. Tested at both levels: the mechanism (with the variable set, even the
vulnerable bare-name shape stops finding the project's file — guarded by a
precondition that it *does* find it without) and the wiring (the child
environment actually carries it).

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
| 17b | LSP child allows cwd executable search | Low | **Fixed — PR #8** |
| 18 | Project name reaches cmd.exe as separator | Moderate | **Fixed (blocklist) — `f13ae4e`** ‡ |
| 18b | Package-manager shim spawned as a bare name | Moderate | **Fixed — PR #4** |
| 19 | Renderer crash records unbounded | Low–Mod | **Fixed — PR #5** |
| 20 | Archive extraction unbounded (bomb) | Moderate | **Fixed — `630bba8`** ‡ |
| 21 | LSP session key not bound to canonical root | Low | **Fixed — PR #6** |
| dep | quick-xml 0.38.4 — 2× RUSTSEC (7.5) | High (advisory) | **Fixed — PR #7** |

‡ Merged to `main` via **PR #1** (2026-08-28). Follow-up corrections to #17
(Unix scope) and #20 (tar entry cap) landed in **PR #3**; see the ISSUE 17
erratum and the #20 checklist line.

**Fixed & merged to `main`**: **ALL 13** (issues 1, 2, 4–14) via PRs #144 (S1),
#145 (S2), #146 (S3), #147 (S5), #149 (S4), #150 (S6, ADR-022), #151 (S7,
ADR-023). **Critical / High (first-party code)**: 0 · **Accepted**: #3.
**Remediation build-plan S1–S7 COMPLETE.**

**External scan, 2026-08-27 (issues 15–21):** 7 findings, **0 false positives**,
all in `src-tauri/`. 4 fixed on branch `security/scan-hardening-2026-08-27`
(15, 17, 18, 20 — every finding the tool rated High, plus the substantive
Medium); 1 re-affirmed as accepted by design (16). **The remaining four —
19, 21, and the 18b / 17b follow-ups — closed 2026-08-30 in PRs #4–#8.**

Severity re-rated against the threat model in three places — see the section for
each. The scan found three issues (15, 17, 20) that the 2026-07-16 whole-repo
pass missed; #17 in particular was exploitable by opening an untrusted project.

**Only residual — tracking, not code (2026-08-30):** the 22 unmaintained/unsound
cargo warnings (GTK3, `unic-*`, `glib`, `anyhow`, `rand`, `fxhash`), all
transitive and blocked on Tauri's GTK4 migration. `cargo audit` = 0
vulnerabilities and `npm audit` = 0; the `quick-xml` HIGH advisory and the low
`@babel/core` advisory that used to live in this paragraph are both cleared.

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
| 2026-08-28 | External review of the remediation itself (CodeRabbit on PR #1, posted post-merge) + refreshed dependency scans | LSP resolution across platforms, archive entry limits, npm + cargo advisories | Review raised 3 Major code findings; 2 valid and fixed in PR #3. **#17 scope was wrong** — the claim "Unix execvp never searches the cwd" ignored that PATH may hold `.` or an empty entry, which POSIX defines as the cwd and which is consulted after the child chdir's into the project root; resolution is now absolute on both platforms (plus canonicalization of a relative `which` answer, and the same fix for `resolve_node`, which the bundled tier spawns with the same cwd). **#20's documented tar entry-count gap closed** with a counting pass. Third finding (zip pre-parse allocation) verified against zip 2.4.2 and recorded as an accepted Low with evidence — its suggested fix is not implementable via the crate's public API. Verified negative also recorded: Rust's `Command::new(<bare name>)` does NOT search the child's `current_dir` on Windows, so the bundled `node` spawn was never exposed there. Scans: npm 1 high (`nanoid`) found and cleared to **0**; cargo unchanged at 2 blocked-upstream HIGH, warnings 21 → 22 (`fxhash` newly unmaintained). |
| 2026-08-30 | Owner-requested close-out of the Master Remediation Checklist | The four remaining actionable findings (#18b, #19, #21, #17b) plus a re-probe of every dependency line | **Checklist closed: no open code findings.** #18b (PR #4) — package-manager shim resolved to an absolute path; both halves of the cmd.exe probe re-run rather than trusted, and a trap surfaced: `where npm` answers with the non-executable extension-less script first, so a naive first-line resolver would have broken the global-npm path (the same `.lines().next()` shape sits in `lsp/resolver.rs`, latent). #19 (PR #5) — session-scoped 16-record / 4 MiB budget on the renderer path alone, adding no directory I/O, panic hook untouched. #21 (PR #6) — validated against a canonical root rather than re-keyed, so the IPC surface is unchanged; caps 8/root, 24 global, 4 concurrent starts; quota policy extracted as a pure function so all seven cases test without spawning a server. #17b (PR #8) — owner ruled ship; `NoDefaultCurrentDirectoryInExePath=1` on the LSP child, restoring what `env_clear()` had been stripping. **quick-xml (PR #7) — the six-week-old "blocked upstream" line was stale**: plist 1.10.0 had shipped, `cargo update -p plist` removes quick-xml 0.38.4 outright, and `cargo audit` went 2 → **0**. Method lesson recorded: re-probe blocked-upstream items, never re-read them. `npm audit` re-verified 0, retiring the stale `@babel/core` line. Integrated `main`: 257 Rust tests, 1037 JS tests, 5 guards, 0 build warnings. Owner acceptance step outstanding: a live LSP session pass (start / hover / diagnostics / stop) covering #21 + #17b. Full journal: `.research/2026-08-30-master-remediation-finish.md`. |
