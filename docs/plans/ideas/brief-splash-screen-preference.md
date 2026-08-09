# Brief — Splash-screen preference (slide toggle, cm-token styled)

**Status:** Shipped — implemented and delivered by PR #171 (2026-07-19);
ADR-024 Accepted. The "candidate polish" section below remains unratified
and unbuilt. Companion ADR: `docs/adrs/024-splash-screen-preference.md`.

## Origin

Owner request (2026-07-19): the Litria splash animation is loved by the owner
but should be optional — a preference toggle that suppresses it and jumps
straight to the launcher. A second directive followed in the same discussion:
the control must not be a run-of-the-mill blue toggle; it must respect the
Litria palette.

## Current behavior (verified 2026-07-19, code read)

- `src/components/SplashScreen.jsx` is **pure theater**: a fixed-timer overlay
  (fade-in at 50ms, hold to 3.0s, unmounted at 3.6s). It masks no loading
  work — the screen beneath renders from the first frame.
- `App.jsx` hardcodes `useState(true)` for `showSplash` and renders the
  overlay in **both** branches: above the launcher and above an open project
  (so it also plays on project launches and single-file opens).
- There is no way to skip it: no preference, no click-through, no
  reduced-motion handling.

## Design

### 1. Registry entry (ADR-019 preferences)

One new entry in `src/preferences/registry.js`:

- `key: 'splashScreen'`, `scope: 'global'`, `propagation: 'inherit'`,
  `defaultValue: true`, `place: ['preferences.global']`,
  `projectOverridable: false` — the splash plays before any project is open,
  so project scope is meaningless.
- Caption (always visible, per registry contract) should say the plain thing
  and set the timing expectation, e.g.: *"Play the Litria splash animation on
  launch. Turning it off jumps straight to the launcher — takes effect next
  launch."*

### 2. A first-class `boolean` registry type

The registry's type contract is currently `enum | json | text`. This entry
introduces `boolean` rather than faking on/off with a two-value enum:

- Enum pills render as a choice-between-modes (`Live | Calm`); an on/off
  setting wants switch semantics, and more boolean preferences are inevitable.
- The generic write-through path (`handleSetGeneric` in
  `PreferencesPanel.jsx`) already handles arbitrary values; only the renderer
  switch needs a `boolean` branch.

### 3. The slide toggle — hand-rolled, cm tokens only

`PreferencesPanel.jsx` is hand-rolled BEM (`launch-toggle`, `prefs-*`); no
shadcn anywhere in it. A switch needs no focus trap or roving keyboard nav,
so per the ADR-008 rubric it stays hand-rolled: a `role="switch"` button with
`aria-checked`, styles next to its siblings in `src/styles/launch.css`.

Styling comes entirely from `src/styles/tokens.css` — no hardcoded hex, which
is what "respect the palette" means in practice, since Live/Calm and themes
work by re-mapping token values. Hardcoding Litria's colors would break the
theme system the palette lives in.

| Part | Token treatment |
|---|---|
| Track shape | `--cm-pill-radius` (a track is a pill — rhymes with existing controls) |
| Track off | `--cm-control-static` / `--cm-surface-card` with muted border — dark, unlit |
| Track on | `--cm-navy` fill, `--cm-indigo` border, `--cm-glow-active` halo — "on" reads as *lit*, the LED glow language from `docs/ui-governance.md` |
| Thumb | neutral off; white/`--cm-indigo-light` on; slides with `--cm-transition-fast` |
| Hover | `--cm-glow-hover` |

Contrast must hold WCAG AA per the ui-governance styling contract; the thumb
position carries the state for anyone who can't distinguish the fill.

### 4. Boot wiring — gate the mount, don't unmount

Global prefs load async (`prefsLoadGlobal`; `LaunchScreen` already self-loads
seed prefs this way). The splash decision must be known before the overlay
first paints, so:

- `showSplash` seeds from the resolved preference; the overlay **does not
  mount until prefs resolve**, and never mounts when disabled.
- The launcher renders beneath the overlay from frame one either way, so the
  few-ms mount delay when enabled is imperceptible.
- Rejected: optimistic mount + unmount-on-load — a visible splash flicker for
  exactly the users who turned it off.
- A pref-load failure falls back to the default (`true`): the splash is the
  shipped behavior, and an error should not change launch feel.

`SplashScreen.jsx` itself is unchanged.

### 5. Touchpoints

`registry.js` (type contract + entry) · `PreferencesPanel.jsx` (boolean
renderer) · `launch.css` (switch styles) · `App.jsx` (seed `showSplash` from
pref, gate mount) · tests: registry entry validation, renderer on/off +
aria-checked, mount gating.

## Candidate polish — raised, not ratified

Owner has not ruled on these; they are recorded so the ideas survive, and any
of them can ride along with implementation if ratified:

- **Click/keypress-to-skip** — any input dismisses the splash early,
  regardless of the setting. Zero-config escape hatch for the impatient;
  composes with the toggle ("never show me this" vs "not right now").
- **Auto-skip on fast paths** — the splash currently plays on single-file
  opens too; single-file speed is a confirmed delight, and 3.6s of brand
  moment sits on top of it. Auto-suppressing for file-association launches
  (independent of the toggle) may be the right default.
- **`prefers-reduced-motion`** — shorten or skip the animation for
  reduced-motion users.

## Open questions

- None blocking. The only design decision of substance (boolean type vs
  two-value enum) is resolved in ADR-024.
