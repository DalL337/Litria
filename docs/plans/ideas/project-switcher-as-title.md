# Capture: Project Switcher as Title (de-dupe the project name)

> **Status**: Captured — not scheduled. Build-ready mini-spec.
> **Date**: 2026-06-12
> **Origin**: Dual-listing of the current project name bugged the user during normal use.
> **Dependencies**: None. Tokens already exist ([tokens.css](src/styles/tokens.css)); no ADR gate.

---

## Problem

The current project name is listed in **two** places in the top bar:

1. **Banner name** — a static `<span className="project-bar-name">` on the left of [ProjectBar.jsx](src/components/ProjectBar.jsx), fed by `projectInstance.name`.
2. **Project switcher** — a dropdown on the right (`.project-bar-end`) in [ProjectSwitcher.jsx](src/components/ProjectSwitcher.jsx) that renders **only a chevron** (▾). The box itself shows nothing until clicked.

Two problems compound: the name is duplicated, and the switcher box is **undiscoverable** — there's nothing in it, so you have to already know to click the chevron.

> **Not a loop guard.** The empty box was a side effect of the name living in the banner (the switcher only needed to *switch*), not a safety measure. The project name is a display-only value read from `projectInstance.name`; rendering it inside the trigger cannot feed back into state. Putting the live name in the box is safe.

## Decision

Merge the two. The **switcher box becomes the title.** It shows the live current project, the chevron opens the dropdown to switch. Delete the standalone banner name. No function lost — function relocated.

---

## Behavior

- **Box shows the live current project** — driven by `projectInstance.name`.
- **Chevron opens the dropdown** to switch projects.
- **Empty state**: `Select A Project…` placeholder, trigger disabled / non-opening, **no seam** (see below).
- **Click target is the whole box** (name + chevron), not just the chevron — a real hit-area improvement over today's ~10px chevron.

### Data-source governance (the one gotcha)

The title and the list come from **different sources** and must stay that way:

- **Title** ← `projectInstance.name` (live, authoritative open-project state).
- **Dropdown list** ← `recents` (localStorage, via `useRecentProjects`).

**Do not drive the title off the top of `recents`.** They usually agree but can diverge (first-ever open, rename, cache lag). Title is always the live instance.

---

## Visual treatment

### Bottom-edge gradient seam

Reuse the drawers' "glowing seam" language ([drawers.css](src/styles/drawers.css)), rotated to the box's **bottom edge**:

```css
border-image: linear-gradient(to right, transparent 0%, var(--cm-electric-blue) 50%, transparent 100%) 1;
border-bottom-width: 1px;
border-bottom-style: solid;
```

`border-image` paints all four sides but only the side given a *width* renders — so width on `border-bottom` only yields a seam that's brightest in the center and fades out at both ends. Same mechanism the drawers use on their vertical edge.

**Why a seam, not a full box outline:** a full indigo border reads as "input field" and would visually duplicate the adjacent SearchPill (already a rounded indigo pill). A fading underline reads as "something lives here, come in" and keeps the switcher visually distinct from the pill. Bonus coherence: the dropdown opens *downward* out of the glowing seam, so the affordance and the result line up — same way a drawer's glowing edge belongs to the drawer behind it.

### State escalation — **seam only**

The seam must be visible **at idle** (discoverability is the whole point of the merge — calm, not hover-only):

| State | Seam |
|-------|------|
| Idle | `--cm-indigo` (calm, present) |
| Hover | `--cm-electric-blue` + `--cm-glow-hover` |
| Open | `--cm-electric-bright` + `--cm-glow-active` |

**The chevron does NOT escalate.** It stays a constant calm blue (`--cm-indigo`) through all states. The seam does the "come look" work; the chevron is a stable "opens downward" marker.

### Dropdown panel

- Keep the dark `#1e1e1e` body; add an `--cm-indigo` border to tie it to the trigger.
- Anchor `left: 0` (drops straight down under the left-aligned title — flip from today's `right: 0`).
- **Current project marked** in the list (checkmark / highlight, non-actionable) rather than filtered out — gives "you are here" orientation. (Mark-vs-filter was the open choice; leaning **mark**.)

### Truncation

Name ellipsis-truncates; chevron stays pinned (`flex-shrink: 0`); the seam lives on the box edge, independent of text, so truncation never disturbs it.

---

## Lift

**Low.** No new tokens, no ADR, no state restructure.

| Touch | Change |
|-------|--------|
| [ProjectSwitcher.jsx](src/components/ProjectSwitcher.jsx) | Accept `currentProjectName`; render name + chevron in trigger; empty/disabled state |
| [ProjectBar.jsx](src/components/ProjectBar.jsx) | Delete `.project-bar-name` span; move switcher into the left slot |
| [App.jsx](src/App.jsx) | Pass `projectInstance.name` to the switcher |
| [project-bar.css](src/styles/project-bar.css) | Seam (3 states, seam-only escalation), constant-blue chevron, dropdown border + `left:0` anchor, truncation flex |

---

## Open choices (small)

- [ ] Mark vs. filter the current project in the dropdown — leaning **mark**.
- [ ] Exact idle seam tone — `--cm-indigo` vs. low-opacity `--cm-electric-blue`. Decide on screen.
