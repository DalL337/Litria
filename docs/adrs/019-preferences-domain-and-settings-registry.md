# ADR-019: Preferences Domain & Context-Aware Settings Registry

## Status
- Amended (2026-08-01 — later-phase ledger, owner rulings: **terminal-hide capability
  shipped** — the `terminalDrawerClose` preference is live, its `comingSoon` gate removed;
  the unit was kept deliberately narrow of any future console work, which needs its own
  planning first. **Per-project theme**: the choice/library split is ratified as the
  direction; delivery stays with the post-beta Theme & Material rework. **ADR-005
  consent-review rows**: re-gated on the ADR-005 v2 capability reconciler — remembered
  consents do not exist yet by design (consent is per-event at the pill), so there is
  nothing to review until that work begins; the slice-7 server inventory in Preferences
  already covers install review/revoke. The promised settings-key guard shipped
  2026-08-01 as the fifth guard (`scripts/settings-key-guard.mjs`, PR #234). Also noted:
  the Library room partially arrived early — theme create/rename/delete lives in the
  Preferences panel; the materials parameter contract shipped with Slice 3
  (`src/theme/materialParams.js`).)
- Accepted — design settled 2026-07-10; delivery slices 1–4 shipped 2026-07-11 (PRs #117–#120). Later-phase items (Library growth with the Theme & Material rework, per-project theme via choice/library split, ADR-005 consent-review rows, terminal hide capability) remain open in their owning tracks.

## Date
- 2026-07-10

## Context

The Launcher's Preferences button has been a disabled stub since the launch screen shipped (`src/components/LaunchScreen.jsx`, "Settings" group). Meanwhile the substrate it needs already exists on both sides of the scope divide, unnamed and un-unified:

- **Global**: app-level SQLite preferences (`db_save_preference` / `db_load_preferences`) already persist `appearance`, `energyLevel`, and HUD layout state — written directly by `useThemeActions` and `useCanvasHud`.
- **Per-project**: two stores with different meanings. `litria.toml` is git-tracked, shared project truth (its `[environment]` table is the declared desired-state input to the ADR-005 reconciler). `.litria/workspace.db` is this-machine-only.

Three pressures converged:

1. **Ownership is inverted.** The New Project wizard and the in-app Settings drawer are where choices get *made*, which quietly makes them the owners. Wizard-seeded choices (energy level, node material preset) are effectively one-shot — findable nowhere afterward — violating the low-friction principle.
2. **The Settings drawer sprawls** (`src/drawers/DrawerContentSettings.jsx`). Fine for internal testing, but it stacks three altitudes in one scroll: *selection* (active theme), *management* (create/rename/delete themes), and *editing* (five glass-token sliders that render unconditionally, even though PR #89's material presets make them meaningful only for glass-family materials). Every entry in it is placed by hand in JSX — the sprawl mechanism itself.
3. **Real settings have no home.** Terminal drawer close-kills-the-shell is an accepted-for-now wart wanting a toggle; crash-log consent (B5) wants a revisitable surface; ADR-005 remembered consents want a review/revoke home.

The pattern that resolves all three is already proven at the action level: **ADR-018's HUD and the node/group action pill work because applicability lives with the action, not the surface.** An action declares what it applies to; surfaces query "what applies here?" and render the answer. Neither surface can accumulate junk because nothing is ever *placed* in a surface. This ADR promotes that pattern from actions to configuration.

## Decision

A **`src/preferences/` domain** (self-contained, `src/crash/` precedent) owns a declarative settings registry, a single resolution path, and adapters over the three existing stores. Every settings surface in the app — Launcher panel, in-app Settings drawer, wizard — becomes a dumb renderer of a registry query.

### Ownership rule (the foundation)

**Surfaces select and preview; only Preferences defines and defaults.** The wizard *seeds*, Preferences *owns*: every wizard-seeded value must be findable and changeable in Preferences afterward. Any "customize" affordance on a surface is a door into Preferences, never a fork of it.

The domain owns **choices and scalars, not library content**: `src/theme/` keeps owning what a theme or material *is*; preferences owns *which one* is the default ("default material = `frosted`"). The domain stores references and never needs to understand rendering — the boundary the architecture guard can hold.

### The registry (one entry per setting)

Central, declarative, presence-only — the tag-capability-registry shape. Each entry declares:

| Field | Values | Meaning |
|---|---|---|
| `key` | string | Identity |
| `scope` | `global` \| `project` | Which preferences file owns it |
| `propagation` | `inherit` \| `seed` | Live-follow vs copied-at-creation |
| `type` + `default` | — | Value contract |
| `label` + `caption` | — | Caption is **always visible**, one plain-English line — not a hover tooltip |
| `place` | context key(s) | Which surfaces/sections it appears in (`settings.material`, `launcher.preferences`, …) |
| `state` | optional predicate | Dynamic gate (active material is glass-family; a project is open; remembered consents exist) |

**No surface may hard-code a setting key.** Sections of the Settings tab are named contexts asking "entries for this place, given this state." Misfiling a setting is a one-line registry diff a reviewer sees, not a JSX layout change. This rule is guardable and should be guarded.

### One preferences folder, one resolution path

All preferences — global and per-project — live as human-readable toml files in a **dedicated `preferences/` folder in the app config dir**, created on install:

| File | Scope | Nature |
|---|---|---|
| `preferences/global.litria.toml` | `global` | "How Litria is for me" — created on install |
| `preferences/<name>-<shorthash>.litria.toml` | `project` | This project's refinements — created at project creation |

Deliberate properties of this shape:

- **The repo's `litria.toml` is NOT a preferences store.** It stays sparse and focused: project identity and declarations (ADR-005 `[environment]` etc.). The boundary test: *if teammates must agree on a value, it is not a preference — it is a project declaration*, it lives in `litria.toml`, and it is owned by its governing domain, not this one.
- **Preferences are personal by definition.** Per-project preference files live in the app config dir, not the repo — they never enter git, so "my behavior in this project" can't leak into team truth by accident.
- **The state/preference boundary is physical.** Preferences are toml files; persisted UI state (HUD layout, drawer state, remembered consents) stays in the databases. "Is it a preference?" is answered by where it lives.
- **One-folder portability**: copying `preferences/` copies how Litria behaves for you — backup, sync, dotfiles, hand-editing all fall out for free.
- **Filenames are readable, not authoritative.** Project names collide, contain filename-illegal characters, and change; sanitization manufactures further collisions. The `<shorthash>` suffix is **minted once at project creation and stored** — a birth certificate, not a fingerprint recomputed from name or path — so it survives renames and moves. The name half is cosmetic (opportunistically renamed to match, never load-bearing).
- **Files are self-describing; the DB mapping is a rebuildable index.** Each per-project file carries a `[meta]` block (owning project path + name). The app DB's project registry (`db_register_project`) holds the project → file mapping as the fast path, but the mapping can be reconstructed by scanning the folder — so a DB reset doesn't orphan the files, `preferences/` backup/restore works standalone, and a hand-editor can see whose file it is.
- **Cleanup is conservative.** Removing a project from the recents list is *not* deleting the project — the file outlives the recents entry, and reopening re-links via `[meta]`. Actual tidying is explicit (a "clean up unused preference files" affordance in Preferences proper) or gated on the project path no longer existing on disk. Preference files are cheap; wrongly deleted ones are not.

One resolver — *effective value of `key` in this project context* — with **two precedence layers only**: global default → project override. No VS Code-style layer stack. In project scope, every setting visibly shows *inheriting* vs *overridden here*, with one-click **reset to global**. `usePreference(key)` wraps the resolver; after Slice 1's migration, `dbSavePreference` serves persisted UI state only (current preference-writing callers `useThemeActions` / `useCanvasHud` reroute through the domain).

### Two propagation modes, stated in the UI

- **Live-inherit**: change the ground, every project follows unless overridden ("all projects use this unless overridden"). Appearance, energy level, terminal drawer behavior, crash consent.
- **Seed-copy**: written at project creation, then the project owns it outright ("new projects will start with this"). Default project location, default material preset, the `[environment]` template. Changing the global later must **not** retroactively mutate existing projects — anything else fights the ADR-005 declared-desired-state premise.

Users will not intuit which is which; the registry marks it and every rendering states it.

### Two rooms

- **Behavior** — toggles and values. Brutally small, forever. Admission bar: *two reasonable users genuinely want different behavior AND Litria can't infer the right answer.* Everything else is a design decision, not a setting.
- **Library** — things with identity: themes, materials, environment templates. Named, duplicated, eventually shared. Allowed to grow, because each entry is a thing the user made, not a knob we added. Surfaced *from* owning domains, and the future front door for the post-beta Theme & Material rework and the Rung-2 modding ceiling.

**Exclusion:** persisted UI state (HUD position/visibility, drawer layout) is *not* a preference and stays out of the registry, even though it shares the SQLite table. "Everything persisted is a preference" is how panels bloat.

### Completeness invariant (the anti-hiding rule)

Fully contextual surfaces create a hunting problem. Therefore: **Preferences proper is the one exhaustive, browsable, searchable home where every setting appears regardless of context.** Settings-tab sections, pills, and the wizard are curated windows onto it. Curation at the point of use, completeness at the source of truth.

### Surface placement

- **Launcher → Preferences**: global scope only (no project is open) — the button finally goes live.
- **In-app (File menu)**: same surface, plus this project's overrides.
- No modal in the IDE window (standing feedback); the Launcher panel and in-app surface are full panels.
- Naming: the domain and feature are **preferences**; "Settings" remains the Launcher group *container* label.

### Settings drawer refit (first full consumer)

The drawer collapses to **three pills — `Theme ▾` `Accent ▾` `Material ▾` — plus one contextual parameter area**:

- Pills show current value at rest; dropdowns do selection (the frequent operation is the only thing at the surface). Same pill vocabulary as ADR-018 and the ADR-005 pill→card consent.
- Theme create/rename/delete moves out entirely — definition work, Library room. The dropdown keeps an "edit in Preferences…" door. The drawer sheds its management chrome because it genuinely lives elsewhere, not behind a disclosure triangle.
- Each material **declares its editable parameters**; the area below the pills renders whatever the active selection exposes. Glass materials bring blur/rim/alpha; a flat material brings none of them; future materials bring their own knobs with zero drawer edits. This is the `state` predicate earning its keep.

### Initial classification (settings that exist today)

| Setting | Scope | Propagation |
|---|---|---|
| Appearance / energy level | global (project override) | inherit |
| Terminal drawer close: hide vs. kill | global | inherit |
| Crash log consent / verbosity | global | inherit |
| Default new-project location | global | seed |
| Default node material preset | global | seed |
| Default environment template | global | seed — wizard writes the *result* into the new project's `litria.toml` `[environment]`; the declaration itself is project truth, not a preference |
| ADR-005 remembered consents | *not a preference* | db-held state; Preferences UI is its review/revoke surface only; consent itself stays per-event at the pill→card |

Classification test for every future entry: (1) must teammates agree on it? → **not a preference** — it's a project declaration for `litria.toml`, owned by its governing domain; (2) is it about me/this machine? → global, with project override; (3) at creation, does the project capture it or follow it? → seed vs inherit.

### Delivery slices

- **Slice 1 — make the button real**: domain + registry + resolver; `preferences/` folder + `global.litria.toml` on boot; migrate `appearance`/`energyLevel` out of SQLite prefs and reroute their callers; Launcher panel with appearance, energy, and the terminal-drawer toggle.
- **Slice 2 — project scope**: per-project preference files (creation hook + DB mapping + orphan cleanup), precedence UI (inherit/override badge + reset-to-global), in-app surface via File menu.
- **Slice 3 — drawer refit**: three pills + material-declared parameter area; theme management migrates to the Library room.
- **Slice 4 — wizard rewiring**: wizard reads seed-type entries from the ground; its job shrinks to "pick from your ground and go."
- **Later**: Library room grows with the Theme & Material rework (post-beta); consent-review rows appear when ADR-005 remembered consents exist.

## Consequences

- **One read/write path.** `useThemeActions` and `useCanvasHud` stop calling `dbSavePreference` directly; precedence, override display, and reset-to-global become mechanical rather than hand-wired per setting.
- **A one-time migration in Slice 1**: `appearance` and `energyLevel` move from app SQLite prefs into `global.litria.toml`. After it, `dbSavePreference` holds persisted UI state only — the state/preference boundary is enforced by storage, not convention.
- **Per-project preference files need lifecycle plumbing**: created at project creation with a minted-once id suffix and `[meta]` self-description; DB mapping maintained as the fast-path index; conservative cleanup (explicit affordance or path-gone-from-disk, never on recents-removal). Opening a pre-ADR project lazily creates its file.
- **A new guard**: no settings surface hard-codes a setting key. Surfaces render registry queries — the enforcement that makes "curated context" a floor instead of a plan.
- **The terminal-drawer toggle presumes the capability.** Hide-don't-kill (session survives drawer collapse, killed on project switch/app exit) is separate terminal work; the preference is its steering wheel, not its engine. Slice 1 can ship the toggle disabled-with-caption or the terminal work lands first.
- **`litria.toml` stays sparse by rule.** It never gains preferences sections; team-agreed values are project declarations owned by their governing domains (ADR-005's `[environment]` is the model). The preferences domain has no reader or writer on the repo file at all.
- **The wizard simplifies over time** rather than fattening — it becomes a thin surface over seed-type registry entries.
- **Materials need a parameter-declaration contract** (which tokens they expose) before the drawer refit — a small extension to the PR #89 preset shape, owned by `src/theme/`.
- **Seed-copy semantics are load-bearing**: global changes never rewrite existing projects' captured values. Getting this wrong makes Preferences feel haunted — ripples where there shouldn't be, none where there should.
- Library room becomes the scheduled home for two currently-floating futures: materials-as-unit-of-theme (post-beta rework) and Rung-2 modding's front door.

## Alternatives Considered

- **VS Code-style settings** (thousands of keys, 3+ precedence layers, JSON escape hatch) — rejected; the sprawl anti-pattern for an IDE built on curated defaults, guards, and discoverability. Two layers, curated set, admission bar.
- **Hand-composed sections per surface** (status quo) — rejected; it *is* the sprawl mechanism. Placement-by-declaration replaces placement-by-layout.
- **Preferences domain absorbs theme/material definitions** — rejected; boundary violation. Theme owns definitions, preferences owns choices; keeps the domain guard-friendly and the Library room a window, not a move.
- **Project preferences inside the repo's `litria.toml`** — rejected (was this ADR's original draft). It bloats the project file, leaks personal behavior into git, and blurs the preference/declaration boundary. The dedicated `preferences/` folder keeps `litria.toml` sparse and makes the boundary physical.
- **Project preferences in `.litria/workspace.db` / globals in app SQLite** — rejected; database rows lose the human-readable, hand-editable, one-folder-backup properties, and sharing a store with persisted UI state erodes the state/preference line the registry needs.
- **`projectname.litria.toml` as identity** — rejected; names collide and change. Readable filenames, DB-owned mapping.
- **Hover tooltips for descriptions** — rejected; hover-hidden explanation fails the discoverability bar. Always-visible one-line captions; tooltips may carry the second paragraph.
- **Everything persisted is a preference** — rejected; HUD/layout state stays out of the registry (see exclusion).
- **Refit the Settings drawer first, standalone** — rejected as the default path; it would hand-build a layout the registry then re-derives (IA done twice). A cosmetic pill re-layout remains available as an independent quick win if wanted before Slice 3.
- **Per-project settings editable from the Launcher** (pick a recent project, edit its overrides) — rejected for v1; project scope requires project context. Launcher is global-only, which is also the cleaner story.

## References

- Precedent pattern: ADR-018 (registry-driven HUD, context-aware surfacing), action pill / menubar node-vs-group context awareness (ADR-013, PR #93)
- Registry shape precedent: tag capability framing (presence-only, central registry)
- Store: dedicated `preferences/` folder in the app config dir (`global.litria.toml` + per-project files, DB-mapped). Adjacent stores it deliberately does NOT use: app SQLite prefs (`src/project/dbStorage.js` — persisted UI state after Slice 1), repo `litria.toml` (project declarations; ADR-005 `[environment]`), `.litria/workspace.db` (ADR-015)
- Domain precedent: `src/crash/` (fully self-contained since PR #112)
- Current surfaces: `src/components/LaunchScreen.jsx` (stub button), `src/drawers/DrawerContentSettings.jsx` (drawer to refit), New Project wizard (seed consumers)
- Material presets: PR #89 (`nodeMaterial` dispatch + 4 builtin presets)
- Futures that plug in: Theme & Material rework (`docs/plans/ideas/theme-material-system.md`), extension sandbox rungs (`docs/plans/ideas/extension-sandbox-design.md`)
