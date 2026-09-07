# Brief — Preferences panel v2

Status: Draft 2026-09-07 — prototype published for owner review; no code
changed. Companion to `brief-wizard-robustness.md` (the wizard v2 arc,
PRs #21–#24) and a refinement of ADR-019, not a replacement.

Origin: owner review of the launcher Preferences panel after the wizard
arc shipped: "nothing close to the other modals. there is no real flow, the
text is small and cramped, there is no global or project separation."

## 1. Findings (evidence, 2026-09-07)

`src/components/PreferencesPanel.jsx` + `src/styles/launch.css` (prefs block):

- The bones are right. The modal is bounded (`max-height: min(760px,
  calc(100vh - 64px))`), only `.prefs-body` scrolls, rows render from
  `entriesForPlace()` (no hard-coded keys — the settings-key guard holds),
  captions are always visible, in-app callers get Global / This-project
  tabs, project rows carry an inherit/override badge and a reset.
- There is no room structure. `PREFERENCE_REGISTRY` entries have no
  `room`; the nine registry rows render as one flat list, and the Library
  and Language servers rooms are hand-placed after them in the same row
  style. Nothing tells the eye where Appearance ends and Project creation
  begins.
- Rows are cramped: 8–9px vertical padding, 12px labels, 11px captions at
  1.4 line-height, 4px between label and caption. The wizard v2 rows use
  13px labels and 12px captions at 1.5.
- The control column is not a column. Selects, pill groups, switches and
  a text input each take their own width (`min-width: 168px` only), so
  controls stagger down the right edge.
- Scope is a single grey 11px line ("Global — how Litria behaves…"). The
  launcher shows no tab row at all, so a first-time user has no way to
  learn that per-project overrides exist until they open a project.
- Language servers: `.prefs-library-line:has(> :only-child)` stretches a
  lone Install button to the full row width (visible in the owner's
  screenshot). Row status lines are the same muted 11px as captions, so
  provenance and description blur together.
- The footer is a lone Done. Nothing says that changes save as you go,
  which they do (write-through on every control).

## 2. Design

Same chrome as wizard v2, so the two surfaces read as one family:

- **Shell.** 760px wide, bounded to the window, pinned header and footer,
  scrolling body with edge shadows. Same border radius, stepper-style
  pills, key chips and focus rings as the wizard.
- **Header.** Title, then the scope row: `Global` and `This project ·
  <name>` as pills in the stepper idiom. The launcher shows the project
  pill disabled with the always-visible caption "Open a project to set
  per-project overrides" — the concept is discoverable before it is
  usable. A search field ("Find a setting…", `/` focuses it) sits at the
  right of the same row, honouring the completeness invariant: this is
  the exhaustive, searchable home.
- **Rooms.** A left rail lists the rooms; the body renders them in order
  with a section rule and a one-line description each. The rail tracks
  the room in view and clicking it scrolls there. Rooms:
  1. Appearance — theme, energy.
  2. Project creation — default location, default base theme, build
     trace pause, build log auto-send.
  3. Behavior — wire drop on collapsed group, terminal drawer close,
     splash screen. (Stays brutally small by ADR-019's admission bar.)
  4. Themes — the Library room (in-app only; the launcher shows one line
     saying the library is managed inside a workspace).
  5. Language servers — inventory rows.
- **Rows.** 14px vertical padding, 13px label, 12px caption at 1.5, a
  fixed 240px control column right-aligned so every control kind lines
  up. Enum pills, boolean switch, select and text input keep their
  existing renderers.
- **Project scope.** Only the overridable rows render, each with its
  layer badge (Inheriting global / Overridden here) and a reset. Under
  them a quiet line: "n more settings are global only — switch to
  Global", so the exhaustive home still feels exhaustive from the
  project tab.
- **Language servers.** Name + tier chip + status line on the left,
  actions on the right in their own column. Uninstall keeps its inline
  second-click confirm. No `:only-child` stretching.
- **Footer.** "Changes save as you go" on the left, Done with an `Esc`
  chip on the right.
- **Keyboard.** Esc = Done; `/` or Ctrl+F focuses search; Left/Right rove
  inside a pill group; Tab order is rail → rows → footer.
- **Search.** Filters rows by label and caption; a room with no match
  collapses to its header with "no matches"; the rail dims empty rooms.

## 3. Registry change (the one ADR-019 touch)

Add `room` to every registry entry: `'appearance' | 'projectCreation' |
'behavior'`. `entriesForPlace()` gains a companion `entriesByRoom(place,
state)` that returns rooms in declaration order with their entries. The
Library and Language servers rooms are not registry rooms (they hold
definitions and machine state, not preferences) and stay hand-rendered,
but through the same room header component. The settings-key guard's
registry-shape check should require `room` so a new entry cannot land
roomless.

## 4. Slices

1. **Registry rooms** — `room` field, `entriesByRoom`, guard shape check,
   contract test. No UI change.
2. **Shell + rows** — new `preferences.css` (own file, like the wizard),
   header with scope pills + search, rail, room sections, row typography
   and control column, footer. Launcher and in-app share it.
3. **Project scope + rooms polish** — layer badges/reset in the new row
   style, the "n more are global only" line, Themes and Language servers
   rooms in the new row style, Install-button fix.
4. **Search + keyboard** — filter, `/` focus, Esc, roving pills, tests on
   the pure filter/room model.
5. **Live pass** — launcher and in-app on Windows scaling and macOS; a
   screen-reader walk of the tabs and rail.

## 5. Open questions for the owner

- Rail on the left (prototype) or a room pill row under the header? The
  rail costs 150px of width but gives the "flow" at a glance.
- In the project tab, list global-only rows dimmed with a "Global" chip
  (fully exhaustive) or hide them behind the "n more" line (prototype)?
- Should the launcher's disabled "This project" pill be there at all, or
  is the caption enough?

## 6. Prototype

Published as an artifact on 2026-09-07 with the same harness as the
wizard prototype: four presets from `themeDefaults.js`, Live/Calm, a
window-height simulator, and a Launcher / In-app mode switch. Research
journal: `.research/2026-09-07-preferences-panel-v2.md`.
