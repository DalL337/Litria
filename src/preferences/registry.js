/**
 * registry.js — the ADR-019 preference registry.
 *
 * Every preference Litria has is declared here, once: its scope, propagation
 * mode, type, always-visible caption, and the places it surfaces. Surfaces
 * (Launcher panel, Settings drawer, wizard) render registry queries — a
 * setting is never "placed" in a surface by hand, so no surface can sprawl.
 *
 * Field contract:
 * - key          identity, unique
 * - room         which room of the Preferences panel the entry lives in — a
 *                PREFERENCE_ROOMS id. Rooms give the panel its flow
 *                (brief-preferences-panel-v2.md); the panel renders
 *                entriesByRoom(), never a hand-placed list.
 * - scope        'global' | 'project'  (which preferences file owns it)
 * - propagation  'inherit' (live-follow; change ripples to projects unless
 *                overridden) | 'seed' (copied at project creation, never
 *                retro-mutated)
 * - type         'enum' (values + defaultValue) | 'boolean' (on/off, rendered
 *                as a slide toggle — ADR-024) | 'json' (plain object) |
 *                'text' (string; empty allowed and usually means "use the
 *                built-in default") | 'number' (finite, min..max, rendered as
 *                a slider with `step` and an optional `unit`)
 * - label        short display name
 * - caption      one plain-English line, ALWAYS visible in UI (not a tooltip)
 * - place        context keys where this entry surfaces
 *                ('preferences.global' = the global scope on any Preferences
 *                surface; 'preferences.project' = the project-override scope;
 *                'hud.grid' = the canvas HUD's Grid widget, a window onto the
 *                same values — ADR-030 playground-review ruling)
 * - when         optional state predicate — the node-vs-group HUD pattern
 * - projectOverridable  whether a project file may override the global value
 * - comingSoon   entry renders disabled with this reason; setValue refuses it
 * - placeholder  optional hint shown in an empty 'text' input
 */

import { BUILTIN_THEME_IDS } from '../theme/themeDefaults.js';

export const PREFERENCE_SCOPES = ['global', 'project'];
export const PREFERENCE_PROPAGATIONS = ['inherit', 'seed'];

/**
 * The rooms of the Preferences panel, in display order. A room is a
 * heading with a one-line description; the entries below it come from the
 * registry, grouped by their `room`. Only preference rooms live here — the
 * Themes (library) and Language servers rooms hold definitions and machine
 * state, not preferences, and the panel renders them itself after these.
 * Behavior stays brutally small by ADR-019's admission bar: two reasonable
 * users differ AND Litria cannot infer.
 */
export const PREFERENCE_ROOMS = Object.freeze([
  { id: 'appearance', label: 'Appearance', description: 'How the canvas and chrome look.' },
  {
    id: 'projectCreation',
    label: 'Project creation',
    description: 'What the New Project wizard starts from and what happens when it finishes.'
  },
  {
    id: 'grid',
    label: 'Grid',
    description: 'How nodes land on the canvas grid and how the grid looks. The canvas HUD’s Grid widget shows the same settings.'
  },
  {
    id: 'behavior',
    label: 'Behavior',
    description: 'The few things reasonable people want differently and Litria cannot infer.'
  }
]);

export const PREFERENCE_ROOM_IDS = Object.freeze(PREFERENCE_ROOMS.map((room) => room.id));

export const PREFERENCE_REGISTRY = [
  {
    key: 'appearance',
    room: 'appearance',
    scope: 'global',
    propagation: 'inherit',
    type: 'json',
    defaultValue: null,
    label: 'Theme',
    caption: 'The active theme for the canvas and chrome. Themes themselves are managed in the workspace Settings drawer.',
    place: ['preferences.global'],
    // Overriding the whole appearance blob would fork the theme library per
    // project; per-project theme waits on the choice/library split (post-beta
    // Theme & Material rework) — the drawer refit shipped without it.
    projectOverridable: false
  },
  {
    key: 'energyLevel',
    room: 'appearance',
    scope: 'global',
    propagation: 'inherit',
    type: 'enum',
    values: ['live', 'calm'],
    defaultValue: 'live',
    label: 'Energy',
    caption: 'Live keeps the canvas vivid. Calm softens colors and dims accents for low-stimulus work.',
    place: ['preferences.global', 'preferences.project'],
    projectOverridable: true
  },
  {
    key: 'wireDropOnCollapsedGroup',
    room: 'behavior',
    scope: 'global',
    propagation: 'inherit',
    type: 'enum',
    values: ['picker', 'open-group'],
    defaultValue: 'picker',
    label: 'Wire drop on collapsed group',
    caption: 'Dropping a wire on a collapsed group either opens a picker of its files or expands the group so you can aim at a piece.',
    place: ['preferences.global', 'preferences.project'],
    projectOverridable: true
  },
  {
    key: 'defaultProjectLocation',
    room: 'projectCreation',
    scope: 'global',
    propagation: 'seed',
    type: 'text',
    defaultValue: '',
    label: 'Default project location',
    caption: 'Where the New Project wizard starts. Leave empty to use the system default. New projects capture this at creation.',
    place: ['preferences.global'],
    projectOverridable: false
  },
  {
    key: 'defaultBaseTheme',
    room: 'projectCreation',
    scope: 'global',
    propagation: 'seed',
    type: 'enum',
    values: [...BUILTIN_THEME_IDS],
    defaultValue: 'glass',
    label: 'Default base theme',
    caption: 'The material preset new projects start from. Existing projects keep whatever they were created with.',
    place: ['preferences.global'],
    projectOverridable: false
  },
  {
    key: 'splashScreen',
    room: 'behavior',
    scope: 'global',
    propagation: 'inherit',
    type: 'boolean',
    defaultValue: true,
    label: 'Splash screen',
    caption: 'Play the Litria splash animation on launch. Off jumps straight to the launcher — takes effect next launch.',
    place: ['preferences.global'],
    // The splash plays before any project is open; project scope is meaningless.
    projectOverridable: false
  },
  {
    key: 'buildTracePause',
    room: 'projectCreation',
    scope: 'global',
    propagation: 'inherit',
    type: 'enum',
    values: ['always', 'warnings', 'never'],
    defaultValue: 'always',
    label: 'Keep the build trace on screen',
    caption: 'After a project is created, how long its build trace waits before the workspace opens. Always waits for you; Warnings waits only when the run warned or failed; Never opens immediately.',
    place: ['preferences.global'],
    // The trace belongs to project creation — there is no project yet to
    // override it.
    projectOverridable: false
  },
  {
    key: 'buildLogAutoSend',
    room: 'projectCreation',
    scope: 'global',
    propagation: 'inherit',
    type: 'boolean',
    defaultValue: false,
    label: 'Save build logs automatically',
    caption: 'Write every build trace to the build log without asking. Off keeps it manual — use “Send to logs” on the trace. Saved runs are under Actions ▸ Logs.',
    place: ['preferences.global'],
    projectOverridable: false
  },
  // ── Structural grid (ADR-030) ──────────────────────────────────────────
  // Owner ruling 2026-09-27 (playground review): the playground's panel ships
  // as the canvas HUD's Grid widget, every option included. Defaults are the
  // playground's starting state. Spacing is not here: it belongs to the
  // workspace (GridDomain), not to a person.
  {
    key: 'gridSnapMode',
    room: 'grid',
    scope: 'global',
    propagation: 'inherit',
    type: 'enum',
    values: ['flex', 'strict'],
    defaultValue: 'flex',
    label: 'Placement',
    caption: 'Flex docks against neighbors and otherwise lands on the finest grid point. Strict lands only on major intersections and never docks flush.',
    place: ['preferences.global', 'hud.grid'],
    projectOverridable: false
  },
  {
    key: 'gridSmartGuides',
    room: 'grid',
    scope: 'global',
    propagation: 'inherit',
    type: 'boolean',
    defaultValue: true,
    label: 'Smart guides',
    caption: 'While dragging, thin lines show when a node lines up with another node’s edge or center. In Flex a node pulls into line from 6 pixels away.',
    place: ['preferences.global', 'hud.grid'],
    projectOverridable: false
  },
  {
    key: 'gridSettleMs',
    room: 'grid',
    scope: 'global',
    propagation: 'inherit',
    type: 'number',
    min: 0,
    max: 400,
    step: 10,
    unit: 'ms',
    defaultValue: 150,
    label: 'Settle time',
    caption: 'How long a dropped node takes to slide onto its grid point. 0 places it instantly.',
    place: ['preferences.global', 'hud.grid'],
    projectOverridable: false
  },
  {
    key: 'gridSettleEasing',
    room: 'grid',
    scope: 'global',
    propagation: 'inherit',
    type: 'enum',
    values: ['cubic', 'quint', 'sine', 'linear'],
    defaultValue: 'cubic',
    label: 'Settle easing',
    caption: 'The shape of the slide: cubic eases out, quint is snappier, sine is softer, linear keeps one speed.',
    place: ['preferences.global', 'hud.grid'],
    projectOverridable: false
  },
  {
    key: 'gridReduceMotion',
    room: 'grid',
    scope: 'global',
    propagation: 'inherit',
    type: 'enum',
    values: ['system', 'always', 'never'],
    defaultValue: 'system',
    label: 'Reduce motion',
    caption: 'Skip the settle slide. System follows your operating system’s reduce-motion setting.',
    place: ['preferences.global', 'hud.grid'],
    projectOverridable: false
  },
  {
    key: 'gridInk',
    room: 'grid',
    scope: 'global',
    propagation: 'inherit',
    type: 'enum',
    values: ['theme', 'neutral'],
    defaultValue: 'theme',
    label: 'Grid line color',
    caption: 'Theme tints the lines with the theme’s wire color, just as visible as white. Neutral keeps them white.',
    place: ['preferences.global', 'hud.grid'],
    projectOverridable: false
  },
  {
    key: 'gridShowMajor',
    room: 'grid',
    scope: 'global',
    propagation: 'inherit',
    type: 'boolean',
    defaultValue: true,
    label: 'Major lines',
    caption: 'Show the major grid lines. Hidden lines still place nodes.',
    place: ['preferences.global', 'hud.grid'],
    projectOverridable: false
  },
  {
    key: 'gridShowMinor',
    room: 'grid',
    scope: 'global',
    propagation: 'inherit',
    type: 'boolean',
    defaultValue: true,
    label: 'Minor lines',
    caption: 'Show the minor grid lines. Hidden lines still place nodes.',
    place: ['preferences.global', 'hud.grid'],
    projectOverridable: false
  },
  {
    key: 'gridShowSub',
    room: 'grid',
    scope: 'global',
    propagation: 'inherit',
    type: 'boolean',
    defaultValue: true,
    label: 'Sub lines',
    caption: 'Show the finest grid lines. Hidden lines still place nodes.',
    place: ['preferences.global', 'hud.grid'],
    projectOverridable: false
  },
  {
    key: 'gridShowOrigin',
    room: 'grid',
    scope: 'global',
    propagation: 'inherit',
    type: 'boolean',
    defaultValue: true,
    label: 'Origin marker',
    caption: 'Mark the canvas origin (0, 0), where Home centers the view.',
    place: ['preferences.global', 'hud.grid'],
    projectOverridable: false
  },
  {
    key: 'gridPaintOverrides',
    room: 'grid',
    scope: 'global',
    propagation: 'inherit',
    type: 'json',
    defaultValue: {},
    label: 'Line opacity',
    caption: 'Your own line opacity per theme, set with the Grid widget’s sliders. Reset returns every theme to its own values.',
    place: ['preferences.global', 'hud.grid'],
    projectOverridable: false
  },
  {
    key: 'terminalDrawerClose',
    room: 'behavior',
    scope: 'global',
    propagation: 'inherit',
    type: 'enum',
    values: ['end', 'hide'],
    defaultValue: 'end',
    label: 'Terminal drawer close',
    caption: 'What closing the terminal drawer does to the running shell session. End stops the shell; Hide keeps it running for when you reopen the drawer.',
    place: ['preferences.global'],
    // Global by ADR-019's own classification ("Terminal drawer close: hide
    // vs. kill — global | inherit"); no project layer. Capability shipped
    // 2026-08-01 (hide-don't-kill in DrawerContentTerminal).
    projectOverridable: false
  },
  {
    key: 'apiWithheldPaths',
    room: 'behavior',
    scope: 'global',
    propagation: 'inherit',
    type: 'text',
    defaultValue: '',
    label: 'Withhold from AI agents',
    caption: 'Paths an AI agent connected to Litria may never read, search or list, on top of the built-in rules (environment files, keys, credentials). .gitignore patterns, separated by commas. Agent connections are still in development.',
    placeholder: 'e.g. secrets/, *.sqlite',
    place: ['preferences.global'],
    // Read by the Rust Project API policy (project_api/policy.rs,
    // USER_EXCLUSIONS_KEY); it can only ADD denials (brief §6, §15 Q1, owner
    // ruling 2026-10-01). Global only: a project file could otherwise relax
    // what the user withholds everywhere.
    projectOverridable: false
  }
];

/**
 * Registry-derived key constants — the only sanctioned way to name a
 * preference key outside this file. `scripts/settings-key-guard.mjs`
 * enforces it: a registered key as a string literal anywhere else in src/
 * fails the build. Keys stay declared once, above; this mapping just makes
 * them importable (`PREF_KEYS.appearance` === 'appearance').
 */
export const PREF_KEYS = Object.freeze(
  Object.fromEntries(PREFERENCE_REGISTRY.map((entry) => [entry.key, entry.key]))
);

export function findEntry(key, registry = PREFERENCE_REGISTRY) {
  return registry.find((entry) => entry.key === key) ?? null;
}

/**
 * The one query surfaces are allowed to render from: entries declaring this
 * place, filtered by their optional state predicate, in registry order.
 */
export function entriesForPlace(place, state = {}, registry = PREFERENCE_REGISTRY) {
  return registry.filter(
    (entry) => entry.place.includes(place) && (typeof entry.when !== 'function' || entry.when(state))
  );
}

/**
 * The same query, grouped for the panel: rooms in PREFERENCE_ROOMS order,
 * each with its entries in registry order. Rooms with nothing to show for
 * this place are omitted, so the project scope lists only the rooms that
 * hold an overridable entry.
 */
export function entriesByRoom(place, state = {}, registry = PREFERENCE_REGISTRY, rooms = PREFERENCE_ROOMS) {
  const entries = entriesForPlace(place, state, registry);
  return rooms
    .map((room) => ({ ...room, entries: entries.filter((entry) => entry.room === room.id) }))
    .filter((room) => room.entries.length > 0);
}
