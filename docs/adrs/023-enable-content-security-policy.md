# ADR-023: Enable Content-Security-Policy

## Status

Accepted (2026-07-17 — security remediation build-plan S7, closes security-audit
ISSUE 10, the last open finding)

## Date

2026-07-17

## Context

`tauri.conf.json` shipped `app.security.csp: null`, which disables Tauri's
Content-Security-Policy entirely. For an app that renders code, markdown, and
hover cards in a webview, CSP is the primary defense-in-depth layer that
*contains* an XSS — and several IPC commands (before S1/S4/S6 hardening) were
strong escalation primitives if one landed. The audit flagged this as the
highest-leverage finding (ISSUE 10): the app has no HTML-injection sinks today
(verified), so CSP is a latent gap rather than an active hole, but it is the
backstop that makes the whole remediation set hold.

Tauri specifics that shape the policy:

- At **compile time** Tauri appends nonces/hashes to the CSP for the app's own
  bundled scripts and assets, so a strict `script-src 'self'` works without
  `'unsafe-inline'`/`'unsafe-eval'` for first-party code.
- IPC requires `connect-src ipc: http://ipc.localhost`.
- `tauri dev` serves the frontend from the Vite dev server, which needs
  `'unsafe-inline'`/`'unsafe-eval'` and a websocket for HMR. Tauri applies a
  separate `devCsp` there so the strict production policy does not break dev.

## Decision

Enable a restrictive production CSP and a dev-only permissive `devCsp`.

**Production `csp`:**

```
default-src 'self'
script-src  'self'                 (no unsafe-inline / unsafe-eval; Tauri nonces first-party scripts)
style-src   'self' 'unsafe-inline' (Monaco injects styles at runtime — inline styles, not scripts)
img-src     'self' data: blob:
font-src    'self' data:
connect-src 'self' ipc: http://ipc.localhost
worker-src  'self' blob:           (Monaco language workers)
object-src  'none'
frame-src   'none'
base-uri    'self'
```

**`devCsp`** mirrors it but adds `'unsafe-inline' 'unsafe-eval'` to `script-src`
and `ws://localhost:1420 http://localhost:1420` to `connect-src` so `tauri dev`
(Vite HMR) keeps working. The dev relaxation never ships — production uses the
strict policy above.

A posture test (`cspPosture.test.mjs`) asserts `csp` is non-null and that the
production `script-src` never permits `'unsafe-inline'`/`'unsafe-eval'`, so a
regression to `csp: null` (or a weakened script-src) fails CI.

## Consequences

Positive:

- A webview XSS is now contained: no inline/eval script execution, no framing,
  no object embeds, network limited to same-origin + IPC. This is the backstop
  under ISSUE 1 (`read_external_file`, now removed) and the other IPC surfaces.

Costs / trade-offs:

- `style-src 'unsafe-inline'` is retained — Monaco injects styles at runtime and
  cannot be nonced at build time. Inline *styles* are far lower risk than inline
  scripts (no code execution); this is the standard Monaco-under-CSP trade-off.
- The strict policy only takes effect in production builds, so it is verified by
  driving a release build (below), not `tauri dev`.

## Alternatives Considered

- **Keep `csp: null`, rely on the absence of injection sinks.** Rejected: the
  audit's top recommendation; a single future/dependency-introduced sink would
  have no containment.
- **Allow `script-src 'unsafe-eval'` for Monaco.** Rejected unless proven
  necessary — it re-opens the eval sink the policy exists to close. Verification
  (below) confirmed Monaco runs under strict `script-src 'self'`.

## Scope Notes

Verified against a **production build** (`tauri build --no-bundle`) — the strict
`csp` only applies to production, not `tauri dev` (which uses `devCsp`):

- **CDP-driven, zero CSP violations:** boot + React render, IPC
  (`detect_python_interpreters`), the launcher, opening a recent project (canvas,
  workspace, discovery), the settings drawer, and the terminal (xterm).
- **Owner-driven + live CDP capture, zero CSP violations:** opening a code file
  in the running CSP build — the Monaco editor **mounted and rendered** (`.monaco-editor`
  present, 9 view-lines) and **hover worked**, with the console captured live
  throughout. (The canvas file-open interaction resisted CDP automation, so the
  owner performed it while capture ran.)
- **Baseline attribution:** a csp:null production build behaves identically re:
  Monaco mount, confirming the CSP is not a differentiator for the editor.

macOS/Linux need the same driven check on a real build (macOS tester-blocked —
the standing caveat).
