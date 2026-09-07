# Brief — New Project Wizard robustness (v2 layout)

Status: Draft 2026-09-07 — prototype published for owner review; no ADR yet.
Origin: external macOS canary feedback (`Litria-macOS-initial-feedback.md`,
items 1 and 2). Item 3 (`~` path / EROFS classification) shipped in 1.0.2 and
is out of scope here.

## 1. Why the wizard, not Preferences

The owner asked for one of the two surfaces to be picked. The wizard wins:

- Both remaining feedback items live entirely in the wizard (emoji icons,
  footer truncation). The truncation is a functional blocker at some window
  heights — the Create button is unreachable without resizing the window.
- Preferences already has the structure the owner described: Global and
  This-project scope tabs in-app (launcher shows Global only because there
  is no project to override), a bounded modal, and a scrolling body with the
  title and Done row pinned (`.prefs-modal` / `.prefs-body`, launch.css).
- ADR-019's ownership rule ("wizard seeds, Preferences owns") means the
  wizard redesign has to name its Preferences touchpoints anyway; those are
  listed in §5 so the follow-up on the Preferences side is small and bounded.

## 2. Findings (evidence, 2026-09-07)

Root cause of the overflow (feedback #2), `src/styles/new-project-wizard.css`:

- `.npw-modal` declares no `max-height`. `.npw-body` is `flex: 1;
  overflow-y: auto` but can never shrink because its parent is unbounded.
- `.npw-overlay` centres the modal (`align-items: center`), so a modal
  taller than the viewport is clipped at **both** ends — the header and the
  footer disappear together. That is exactly the tester's report.
- The Stack page is the tallest: five runtime cards, framework, language,
  backend, add-ons, the Python environment strip, package manager, command
  preview and the posture note. It exceeds 800px with everything revealed.
- Second latent truncation: cascade subsections animate with a fixed
  `max-height` (220px, 420px for the environment strip) and
  `overflow: hidden`. Any content past the cap is silently clipped.

Icons (feedback #1), `src/components/NewProjectWizard.jsx`:

- Every runtime, framework, language, backend and add-on card uses an emoji
  string; colour-mode cards use loose unicode glyphs; the nav buttons are
  bare arrows and the primary buttons carry `✦`, `📁`, `🌱`.
- `lucide-react` is already a dependency and is already imported by the
  wizard (`MoreHorizontal`, `Copy`, `FileDown`). Lucide is ISC-licensed:
  commercial use permitted, no in-product attribution required. Lucide 1.0
  removed brand logos on purpose (trademark exposure) and points to Simple
  Icons for logos; Simple Icons is CC0 but each mark still carries the
  brand owner's trademark guidelines.

Navigation and accessibility:

- Cards are `<div onClick>` — no focus, no keyboard activation, no ARIA
  state. Step dots carry no labels and are not interactive. Nav buttons have
  no accessible name. Enter does not advance; Escape does not cancel.
- "Advanced" content exists but is scattered: package manager (row),
  backend (web only), Python environment engine (a `<details>`), and the
  editable `requires-python` floor (Capstone).

## 3. Good-practice inputs

- Wizards (NN/g): label every step, show the current step and the total,
  enforce forward order but let users return to earlier steps without losing
  work, set expectations about length up front.
- Progressive disclosure: keep the primary path short; group edge-case
  settings behind a clearly labelled, collapsed "Advanced" section that
  shows when something inside it is non-default.
- Long modals: bound the dialog to the viewport, scroll only the body, pin
  header and actions, and hint at hidden content with a fade at the scroll
  edges.

## 4. Proposed design

Layout contract (the fix for #2):

- `.npw-modal { max-height: min(820px, calc(100dvh - 48px)); }` — same
  shape as `.prefs-modal`.
- `.npw-body { flex: 1; min-height: 0; overflow-y: auto; }` and drop the
  `min-height: 400px` floor that fights small windows.
- Header (stepper + title) and footer (Cancel · step counter · Back/Next)
  are pinned; the body shows top/bottom scroll fades when content is hidden.
- Cascade subsections stop using fixed `max-height` caps; they mount and
  unmount (or use `grid-template-rows: 0fr → 1fr`) so nothing is clipped.
- Small heights: the title drops one size step and header/footer padding
  tightens below 640px of available height. Verify on macOS 13" with menu
  bar, Windows 125–150% scaling, Linux at 1366×768.

Navigation:

- Labelled stepper: Identity → Stack → Workspace → Create. Completed steps
  are buttons (jump back, state preserved); future steps are disabled.
- Footer buttons carry text plus a chevron ("Back", "Next", "Create
  project"), a live "Step n of 4" counter sits between them.
- Enter advances when the step is valid; Escape cancels (disabled while
  creating). Focus moves to the step heading on change. Cards become
  `<button aria-pressed>` inside `role="group"` / `role="radiogroup"`.
- The Create step's review rows get an Edit affordance that jumps to the
  owning step.

Progressive disclosure (the "advanced settings / separators" ask):

- Stack step: primary path is Runtime → Framework/Type → Language →
  Add-ons, separated by labelled section rules. An **Advanced** fold holds
  Package manager, Backend (web only) and the Python environment engine +
  existing-env path. The fold header shows a count chip when anything inside
  is non-default so a collapsed fold never hides a surprise.
- Workspace step: Base theme + live preview stay primary; **Advanced ·
  Colors** folds the folder-group and single-piece colour modes and swatch
  grids. A footer caption states the ADR-019 truth: seeded from
  Preferences, changeable there later.

Icons (the fix for #1):

- Replace all emoji with Lucide glyphs rendered through `lucide-react`,
  16–18px, `stroke-width: 1.75`, tinted per tier through the existing tier
  background classes. One consistent icon size, radius and alignment across
  every card kind.
- No brand logos. Frameworks and languages get abstract category glyphs
  (React → atom, Svelte → flame, Vue → layers, Angular → shield,
  Solid → gem, TypeScript → braces, JavaScript → code). This avoids a
  trademark review per logo and keeps every card the same visual weight.
  If the owner wants logos later, Simple Icons is the sanctioned source and
  each mark needs its brand-guideline check.
- Nav and primary buttons use Lucide chevrons / sparkles / folder — no
  emoji anywhere in the wizard.

## 5. Preferences touchpoints (ADR-019)

- No new registry entries. The wizard keeps reading its seeds
  (`defaultProjectLocation`, `defaultBaseTheme`, `energyLevel`,
  `buildTracePause`, `buildLogAutoSend`) exactly as today.
- The Workspace step caption points at Preferences as the owner of those
  defaults. No "open Preferences" button inside the wizard — surfaces
  select and preview; only Preferences defines and defaults.
- Optional follow-up (separate brief): registry `room` field so the
  Preferences panel can render labelled groups (Appearance · Behavior ·
  Project creation · Library · Language servers) instead of a flat list.

## 6. Slices

1. **Layout contract** — bounded modal, pinned header/footer, scroll fades,
   cascade without `max-height` caps. Tests: a jsdom render asserting the
   modal class contract; a Playwright/CDP check at 560px height that the
   Create button is visible on every step. Acceptance: feedback #2 criteria.
2. **Stepper + keyboard + card semantics** — labelled steps, jump-back,
   Enter/Escape, buttons with `aria-pressed`, focus management.
   Tests: keyboard traversal in jsdom; axe pass on each step.
3. **Advanced folds** — Stack and Workspace folds with non-default count
   chips; move package manager / backend / env engine / colour modes into
   them; review-row Edit jumps.
4. **Icon sweep** — emoji → Lucide, one `WIZARD_ICONS` map, guard-friendly
   (no emoji code points in NewProjectWizard.jsx; a test greps for them).
5. **Small-height verification** — macOS + Windows scaling + Linux pass with
   screenshots (implementation-policy Rule 6).

## 7. Owner decisions (2026-09-07, from prototype review)

- **Icons:** Lucide category glyphs, no brand logos. Owner approved the
  prototype's icon set as-is.
- **Workspace stays a full step.** The wizard remains four steps:
  Identity → Stack → Workspace → Create.
- **Live/Calm writes back to the global preference on create**, as it does
  today. The toggle is a preview lens while the wizard is open and becomes
  the user's energy level when the project is created.
- **Review-row Edit jumps** (Create step, pencil per row → owning step)
  confirmed; they ship in slice 3.

## 8. Prototype

Interactive HTML/CSS prototype (no framework) published as an artifact on
2026-09-07. It uses the real preset tokens from
`src/theme/themeDefaults.js` (Glass / Obsidian / Parchment / Terminal), the
Live/Calm axis, a window-height simulator, and a "legacy layout" toggle
that reproduces the clipping bug for comparison. Research journal:
`.research/2026-09-07-wizard-prefs-robustness.md`.
