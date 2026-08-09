# ADR-024: Splash-screen preference and the registry boolean type

## Status

Accepted (2026-07-19 — owner acceptance after implementation review;
delivered by PR #171 the same day)

Proposed (2026-07-19 — drafted at owner direction; design ratified in
discussion, formal acceptance on owner review of this document)

## Date

2026-07-19

## Context

The launch splash (`src/components/SplashScreen.jsx`) is a fixed 3.6-second
overlay that plays on every launch. It is pure presentation — the screen
beneath renders from the first frame — and there is currently no way to
suppress or skip it. The owner wants it optional: a toggle that turns the
animation off and lands the user straight on the launcher, with the control
itself styled in Litria's palette rather than as a stock switch.

The ADR-019 preference registry is the established home for exactly this kind
of setting, but its type contract (`enum | json | text`) has no boolean type
and its surfaces have no switch renderer.

Canonical detailed design:
`docs/plans/ideas/brief-splash-screen-preference.md` (the brief). This ADR
records the decisions only.

## Decision

1. **Splash visibility is an ADR-019 global preference.** New registry entry
   `splashScreen`: global scope, `inherit` propagation, default `true`, not
   project-overridable (the splash plays before any project is open). It
   surfaces wherever `preferences.global` renders; no hand-placement.

2. **The registry gains a first-class `boolean` type**, rendered as a slide
   toggle. On/off settings get switch semantics rather than a two-value enum
   dressed as one; this entry is the first user of the type.

3. **The toggle is hand-rolled and styled exclusively from cm design
   tokens.** No shadcn (a switch needs none of the focus-trap machinery that
   justifies it under the ADR-008 rubric; the Preferences surface is
   hand-rolled BEM throughout), and no hardcoded colors — tokens are how the
   control respects the palette *and* follows Live/Calm and user themes,
   which re-map token values. Active state uses the LED glow language
   (`docs/ui-governance.md`); the control is a `role="switch"` button meeting
   WCAG AA.

4. **Suppression means the overlay never mounts.** `App.jsx` seeds
   `showSplash` from the resolved preference and gates the splash mount on
   prefs resolution — no optimistic mount, no flash-then-remove. Pref-load
   failure falls back to the default (splash on). Changes take effect next
   launch, and the entry's caption says so.

## Consequences

Positive:

- The splash stays the default brand moment; people who want a faster launch
  turn it off once, discoverably, in the same Preferences surface as
  everything else.
- The registry can express on/off settings honestly from now on; future
  boolean preferences reuse the type and renderer for free.
- The toggle inherits every theme, including Calm dimming, with zero extra
  rules — a hardcoded-color control would have forked the theme system.

Costs / trade-offs:

- A new registry type means touching the contract, the renderer switch in
  `PreferencesPanel.jsx`, and its tests — slightly more than the one-line
  entry a faked enum would have needed. Accepted: the type was inevitable.
- When enabled, the splash mounts only after global prefs resolve — a
  few-millisecond start delay. Imperceptible in practice (the launcher
  renders beneath the overlay regardless).

## Alternatives Considered

- **Two-value enum (`show | skip`)** — works with today's renderer, no
  contract change. Rejected: enum pills read as a choice between modes, not a
  switch; every future boolean setting would face the same fork, and the
  owner asked for a slide toggle specifically.
- **shadcn Switch** — accessible out of the box. Rejected: the Preferences
  surface is hand-rolled BEM with no shadcn, a switch clears the ADR-008 bar
  for hand-rolling, and restyling a library switch to cm tokens is more work
  than owning twenty lines of CSS.
- **Skip-only affordance (click-to-dismiss), no preference** — zero settings
  surface. Rejected as the *whole* answer: it serves "not right now" but not
  "never show me this." Recorded in the brief as candidate polish that
  composes with the toggle.
- **Config-file / CLI flag** — no UI cost. Rejected: undiscoverable, and
  counter to the low-friction preference surface ADR-019 exists to provide.

## Scope Notes

- Click/keypress-to-skip, auto-skip for single-file (file-association)
  launches, and `prefers-reduced-motion` handling were raised in the same
  discussion but are **not decided here** — they live in the brief's
  "candidate polish" section pending owner ruling.
- `SplashScreen.jsx` itself is unchanged by this decision; only whether it
  mounts is governed.
