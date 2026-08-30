# Security Remediation Build Plan

> **Kind**: Build plan (documentation-policy Rule 3) — owns sequencing, not
> decisions. The findings and their detail live in
> `docs/security-audits/security-audit.md` (the living audit + Master
> Remediation Checklist); this plan says in what order and in what branches to
> close them. Cite the finding number (`#N`); do not restate the fix detail.
> **Created**: 2026-07-16 (owner-requested, after the whole-repo audit pass)
> **Status**: **COMPLETE (2026-08-30).** S1–S7 all shipped 2026-07-17, closing
> the 13 findings this plan was written for. The two tracking-only dependency
> items outlived it and were closed later: `quick-xml` on 2026-08-30 (PR #7 —
> it had quietly stopped being blocked upstream), the cargo warnings still open
> and still blocked on Tauri's GTK4 migration.
>
> **This plan is history, not a live queue.** Findings raised after it was
> written (issues 15–21, the 2026-08-27 external scan) were never in its scope
> and were sequenced directly from the audit; they closed on 2026-08-30 in
> PRs #4–#8. The Master Remediation Checklist in
> `docs/security-audits/security-audit.md` is the live tracker — start there.
> A future remediation arc large enough to need sequencing should get its own
> build plan rather than extending this one.

## Scope

The 13 open findings from the living audit, plus the two tracking-only
dependency items. Load `Agents/docs/security-policy.md` +
`Agents/docs/implementation-policy.md` + `Agents/docs/verification-policy.md`
when executing any slice (each is code + a PR).

## Sequencing principle

1. **One slice = one coherent unit = one branch off `main`** (AGENTS.md §7.1).
   The slices below are the branch boundaries.
2. **Harden the primitives, then add the containment layer.** The cheap
   input-validation fixes (#11, #12, #6, and the boundary decision on #1)
   shrink what a future XSS could reach. CSP (#10) is the containment layer;
   landing it after the primitives are narrowed means a smaller blast radius if
   the CSP itself needs iteration. (See Decision 1 — this ordering is a
   recommendation, not a constraint.)
3. **Blocked-upstream items are tracking-only** — no branch until upstream
   moves (quick-xml, the 21 cargo warnings).
4. **Behaviour-changing security decisions get a decision record.** #1 and #10
   change observable behaviour; capture the decision as an ADR (or a dated
   decision note cross-linked from the audit) when the slice starts
   (security-policy Rule 3: the audit records state, the ADR records the
   decision).

## Decisions (confirmed — owner, 2026-07-16)

**Decision 1 — CSP timing (#10): land it as S7, after the primitive-narrowing
slices.** (Owner accepted the recommendation.) Rationale: CSP is the
highest-leverage *and* highest-breakage-risk change (Monaco, hover cards, the
`tauri://`/IPC transport, `connect-src` for any network the app makes); doing
the cheap hardening first means that if CSP rollout takes iteration, the
escalation primitives it backs are already smaller.

**Decision 2 — `read_external_file` boundary (#1): Option A — Rust owns the
dialog.** (Owner accepted the recommendation.) Move the open-file picker into a
Rust command that returns contents for the path *it* just prompted for, so a
consented path never round-trips through JS; the standalone unrestricted-read
primitive is removed. The command backs only the launcher "Open File" flow
(`useProjectLaunch.js:436`), so a single caller migrates. S6 is scoped to this
option; capture the decision as an ADR (or dated decision note) when S6 starts.

---

## Slices

### S1 — Creation-path input validation  ·  covers #12, #11
- **Branch**: `fix/creation-input-validation`
- **Goal**: Every project-creation path validates frontend input before it
  becomes a filesystem path or a spawned program.
- **Tasks**:
  - Route `scaffold_runner::run_scaffold` through the shared
    `blank_project::validate_project_name` before `location.join` / arg build
    (#12 — the validator and two of three call sites already exist).
  - Validate `python_scaffold` `interpreter_path` against the
    `detect_python_interpreters` result set (or, minimum, canonicalize +
    existence-check + basename-allowlist `python`/`python3`/`pythonN`) before
    spawn (#11).
- **Tests**: unit — npm scaffold rejects `..`/separator/reserved names;
  python scaffold rejects an interpreter not in the probe set.
- **Acceptance**: both creation paths reject a hostile name/interpreter with a
  clear error; the happy path (wizard-supplied values) is unchanged.
- **Risk**: Low. Isolated, unit-testable. **Verify**: New Project wizard still
  creates a Tauri/Vite project and a Python project end-to-end.

### S2 — Download-manager hardening  ·  covers #13, #14
- **Branch**: `fix/lsp-download-hardening`
- **Goal**: The artifact download can't fill the disk or run over cleartext.
- **Tasks**:
  - Cap the download stream in `download_to`: abort once received bytes exceed a
    hard ceiling (or a small multiple of `content-length`), clean staging,
    clear error (#13).
  - Enforce `https://` on custom install URLs in `install_server`, keeping the
    existing "integrity unverifiable / no SHA" consent copy (#14).
- **Tests**: unit — oversized stream aborts + cleans staging; `http://` custom
  URL is refused; `https://` custom URL still allowed and recorded kind
  `custom`.
- **Acceptance**: a managed install (rust-analyzer/clangd) still succeeds;
  oversize and cleartext are refused.
- **Risk**: Low. **Verify**: install one managed server against the test bed.

### S3 — LSP boundary hardening  ·  covers #4, #5, #6, #7
- **Branch**: `fix/lsp-boundary-hardening`
- **Goal**: The LSP command + spawn surface validates its inputs and can't be
  steered by malformed identifiers.
- **Tasks**:
  - Canonicalize the `.cmd`→node script path in `resolve_cmd_to_node` and
    reject anything not under the `.cmd`'s own directory (#4).
  - Length-cap `language_id`/`project_id`/`method`; clamp `timeout_ms` to a
    sane maximum in `session_request`/`lsp_request` (#5).
  - Validate `project_root` (exists, is a directory, ideally matches a known
    project root) before `Command::current_dir` in `start_session` (#6).
  - Replace the `format!("{project_id}::{language_id}")` session key with a
    structured/null-delimited key (#7).
- **Tests**: unit — traversal `.cmd` refused; over-length identifiers refused;
  non-existent `project_root` refused; key builder is collision-safe.
- **Acceptance**: a live LSP session (rust or python) still starts, serves
  hover/diagnostics, and stops cleanly.
- **Risk**: Low–Moderate (touches the live session path). **Verify**: open a
  file, confirm diagnostics + hover, then stop the session — no regressions.

### S4 — Tauri capability fs scoping  ·  covers #2
- **Branch**: `fix/tauri-capability-scope`
- **Goal**: Add fs capability scoping as defense-in-depth and document that
  Litria's custom commands (not the fs plugin) are the real boundary.
- **Tasks**: scope capabilities to project root + app-data where the plugin
  surface allows; add the architectural note the prior audit asked for.
- **Tests**: existing command set still authorized (no capability regressions).
- **Acceptance**: app boots; all IPC commands still callable; dialog/opener
  unaffected.
- **Risk**: Low, but capability misconfig can silently break commands.
  **Verify**: smoke the file tree, terminal, LSP, scaffold once.

### S5 — LSP domain hygiene  ·  covers #8, #9
- **Branch**: `fix/lsp-domain-hygiene`
- **#9 folded in here (2026-07-17):** both findings are LSP-domain
  defense-in-depth — the env allowlist (backend, `packs/*.rs`) and adapter error
  sanitization (frontend, `src/lsp/createLspAdapters.js`) — one coherent LSP
  hygiene unit.
- **Goal (#8)**: Decide whether `PYTHONPATH` (python.rs) / `NODE_PATH`
  (typescript.rs) are needed for the bundled venv/tsserver flows; drop them if
  not, document the trust assumption if kept. (Bundled pyright discovers the env
  via `[tool.pyright] venvPath` in pyproject.toml — file-based, ADR-020 §5 — so
  `PYTHONPATH` is likely redundant.)
- **Goal (#9)**: Wrap backend IPC errors with a sanitized `{code, message}`
  before they leave the LSP adapters, so internal paths / spawn details don't
  reach UI error text.
- **Tests**: unit — allowlists no longer carry the dropped vars; adapter maps a
  raw backend error to a sanitized shape (no absolute paths leak).
- **Acceptance**: language servers resolve project imports as before; adapter
  errors carry a code + safe message.
- **Risk**: Low. **Verify**: #9 is live-drivable (an erroring LSP command → the
  sanitized message). #8 conformance (import resolution) can't be live-exercised
  in `tauri dev` while bundled pyright fails to start (pre-existing, see S3
  observation) — cover it by unit test + the file-based-venv reasoning, and flag
  that a real-build conformance pass is the owner's confirmation.

### S6 — `read_external_file` → Rust-owned open dialog  ·  covers #1  ·  Decision 2 = Option A
- **Branch**: `fix/read-external-file-boundary`
- **Goal**: Remove the unrestricted absolute-path read primitive by having Rust
  own the open-file dialog (Option A).
- **Tasks**: add a Rust command that opens the OS file picker (dialog plugin)
  and returns the picked file's contents for the path it just prompted for;
  migrate the launcher "Open File" caller (`useProjectLaunch.js:436`) to it;
  remove `read_external_file` (and its JS adapter) once no caller remains;
  capture the decision as an ADR or dated decision note.
- **Tests**: launcher "Open File" opens a picked file via the new command; the
  old unrestricted-read command is gone (no caller, no registration).
- **Acceptance**: Open File flow is unchanged for the user; the arbitrary-path
  read primitive no longer exists.
- **Risk**: Moderate (touches a user-facing flow + removes a command).
  **Verify**: drive Open File from the launcher end-to-end.

### S7 — CSP enablement  ·  covers #10  ·  needs Decision 1
- **Branch**: `fix/enable-csp`
- **Goal**: Replace `csp: null` with a restrictive policy; contain any future
  XSS.
- **Tasks**: set `default-src 'self'`, `object-src 'none'`, `frame-src 'none'`,
  tight `connect-src`, `script-src 'self'` (no `unsafe-inline`/`unsafe-eval`);
  add `style-src`/`font-src`/`img-src` as Monaco requires; capture the decision
  as an ADR; add a test asserting `csp` is non-null (ADR-021 §5 posture-note
  test is the model).
- **Tests**: config test — `csp` non-null; the full app-driving verification
  below is the real gate.
- **Acceptance**: editor loads and edits; syntax highlighting, hover cards,
  completions work; LSP transport + all IPC work; terminal streams; New Project
  wizard runs; no CSP violations in the devtools console.
- **Risk**: Moderate–High (most likely to break something). **Verify**:
  `/run` the app and exercise every major surface; watch the console for CSP
  reports. Budget the most verification time here.

### Optional trivial chore — npm dev-dep advisory  ·  covers the low npm finding
- **Branch**: `chore/npm-audit-fix-babel` (or fold into any docs/chore PR)
- **Tasks**: `npm audit fix` for `@babel/core` (dev-dep, fix available); confirm
  the build + tests still pass.
- **Risk**: Very low. Do whenever convenient.

---

## Tracking-only (no branch until upstream moves)

- ✅ **quick-xml 0.38.4 (2× HIGH DoS) — CLOSED 2026-08-30, PR #7.** Was
  transitive via Tauri `plist`; the note said `cargo update -p quick-xml` locks
  0 because plist 1.8.0 pinned the 0.38.x line. That stopped being true when
  plist 1.10.0 shipped, and nobody noticed because the line was **re-read
  instead of re-run** at two later scans. `cargo update -p plist` removes
  quick-xml 0.38.4 outright; `cargo audit` went 2 → 0.
  **Generalize the correction, not just the fix: "blocked upstream" is a claim
  with an expiry date and no way to announce it. Re-probe every such item on
  every pass — the probe is one command.**
- **22 cargo warnings** (GTK3, `unic-*`, `glib`, `anyhow`, `rand`, `fxhash`) —
  all transitive, blocked on Tauri's GTK4 migration. Tracking only, and subject
  to the same re-probe rule.

---

## Rough effort + suggested order

| Order | Slice | Findings | Size | Risk |
|---|---|---|---|---|
| 1 | S1 creation-path validation | #12, #11 | ~½ day | Low | ✅ merged PR #144 |
| 2 | S2 download hardening | #13, #14 | ~½ day | Low | ✅ merged PR #145 |
| 3 | S3 LSP boundary hardening | #4, #5, #6, #7 | ~1 day | Low–Mod | ✅ merged PR #146 |
| 4 | S5 LSP domain hygiene | #8, #9 | ~½ day | Low | ✅ merged PR #147 |
| 5 | S4 capability scoping | #2 | ~½ day | Low | ✅ merged PR #149 |
| 6 | S6 read_external_file (Decision 2) | #1 | ~½–1 day | Mod | ✅ merged PR #150 (ADR-022) |
| 7 | S7 CSP (Decision 1) | #10 | ~1 day (mostly verify) | Mod–High | ✅ merged PR #151 (ADR-023) |
| — | chore npm audit fix | (npm low) | ~10 min | V.low | ✅ merged PR #152 |

(Table gained a Status column 2026-07-17. #9 folded into S5. S5 promoted ahead of
S4 to sweep up #9 with the other LSP-domain finding; S4/S5 are independent so
order between them is free.)

**Final (2026-07-17): S1–S7 all merged — 13 of 13 findings closed.** S5 → PR
#147, S4 → PR #149, S6 → PR #150 (ADR-022), S7 → PR #151 (ADR-023). The npm
`@babel/core` chore went with PR #152.

**Postscript (2026-08-30):** the last tracking-only dependency item closed too
(PR #7), leaving only the cargo warnings. The plan's own scope is finished; see
the Status banner at the top for where live work lives now.
