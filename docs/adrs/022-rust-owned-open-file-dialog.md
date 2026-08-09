# ADR-022: Rust-owned open-file dialog

## Status

Accepted (2026-07-17 — security remediation build-plan S6, closes security-audit
ISSUE 1)

## Date

2026-07-17

## Context

The launcher's "Open File" flow was two IPC steps:

1. Frontend opens the OS file picker via `@tauri-apps/plugin-dialog` `open()`,
   which returns an absolute path string.
2. Frontend passes that string to the `read_external_file` Tauri command, which
   canonicalizes **any** absolute path and returns its contents — with no
   project-root boundary (every other filesystem command is root-scoped).

The security audit flagged `read_external_file` (ISSUE 1, Moderate): in the
normal flow the path is user-consented via the OS picker, but the command is a
general **arbitrary-file-read primitive**. If a webview XSS ever occurred
(elevated by the currently-disabled CSP, ISSUE 10), it becomes an information-
disclosure primitive — read SSH keys, `.env`, etc. — bypassing the picker
entirely by calling `read_external_file('C:\\Users\\…\\.ssh\\id_rsa')`.

The consented path round-trips through JS, so the backend cannot distinguish a
picker result from an attacker-supplied string.

## Decision

**Rust owns the open-file dialog.** A single command opens the OS picker and
returns the contents of the file the user just picked — the path never
round-trips through JS, and there is no command that reads an arbitrary
frontend-supplied path.

1. New command `open_file_dialog(app) -> Option<OpenedFile>`: opens the native
   file picker on a blocking thread (`spawn_blocking` + the dialog plugin's
   `blocking_pick_file`), reads the picked file, and returns
   `{ path, contents }` (or `null` when the user cancels). The read is bound to
   the path the OS picker just returned.
2. `read_external_file` (command, `project_ops` impl, registration, adapters,
   and the `storage`/`projectDomain` wrappers) is **removed** — no caller
   remains.
3. The launcher "Open File" button calls the new command directly; the frontend
   no longer opens the picker itself for this flow.

## Consequences

Positive:

- The arbitrary-absolute-path read primitive no longer exists on the IPC
  surface. A webview compromise can no longer read files the user did not pick.
- One IPC round-trip instead of two; the consented path stays backend-side.

Costs / trade-offs:

- First Rust-side dialog usage in the codebase. `blocking_pick_file` must run
  off the main thread (it deadlocks on the main thread); `spawn_blocking`
  satisfies this and the plugin marshals the native dialog to the main thread
  internally. Verified on Windows; **macOS/Linux picker behavior needs a
  real-build confirmation on those platforms** (macOS is tester-blocked — this
  is the standing platform caveat, not new to this change).
- `dialog:default` is retained (the New-Project folder picker and untitled
  Save-As still use the JS dialog plugin; only Open File moved to Rust).

## Alternatives Considered

- **(B) Session allowlist** — Rust remembers picker-returned paths and
  `read_external_file` only serves those. More moving parts (state, expiry) for
  the same guarantee; rejected in favor of removing the primitive outright.
- **(C) Accept + document** — keep the command, lean on CSP (ISSUE 10) to
  prevent the XSS that would abuse it. Cheapest, but leaves a powerful primitive
  in place as defense-in-depth against CSP alone. Rejected: Open File has a
  single caller, so Option A removes the primitive at low cost.

## Scope Notes

Only the launcher Open File flow used `read_external_file` (verified by grep).
The New-Project folder picker (`useProjectLaunch.handleMenuOpenProject`,
`LaunchScreen`) and untitled Save-As keep using the JS dialog plugin — those
return a path used to *write* or to open a *project root*, not to read an
arbitrary file, and are out of scope here.
