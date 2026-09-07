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
 *                built-in default")
 * - label        short display name
 * - caption      one plain-English line, ALWAYS visible in UI (not a tooltip)
 * - place        context keys where this entry surfaces
 *                ('preferences.global' = the global scope on any Preferences
 *                surface; 'preferences.project' = the project-override scope)
 * - when         optional state predicate — the node-vs-group HUD pattern
 * - projectOverridable  whether a project file may override the global value
 * - comingSoon   entry renders disabled with this reason; setValue refuses it
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
