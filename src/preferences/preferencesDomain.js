/**
 * preferencesDomain.js — pure resolution + mutation over registry-declared
 * preferences (ADR-019).
 *
 * Holds snapshots of the stored layers and answers "what is the effective
 * value of X?" against the registry. Resolution order (Slice 2):
 * valid project override (if the entry allows one) -> valid global value ->
 * registry default. Exactly two precedence layers, by design.
 *
 * Commands are pure: they return the next values object for their layer;
 * persistence is the caller's job (preferencesStore).
 */

import { PREFERENCE_REGISTRY, findEntry, entriesForPlace } from './registry.js';

function requireEntry(key) {
  const entry = findEntry(key);
  if (!entry) throw new Error(`Unknown preference: ${key}`);
  return entry;
}

function isValid(entry, value) {
  if (entry.type === 'enum') return entry.values.includes(value);
  if (entry.type === 'boolean') return typeof value === 'boolean';
  if (entry.type === 'json') {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  if (entry.type === 'text') return typeof value === 'string';
  return false;
}

export function createPreferencesDomain({ values = {}, projectValues = null } = {}) {
  const projectLayerHolds = (entry) => {
    if (!projectValues || !entry.projectOverridable) return false;
    const stored = projectValues[entry.key];
    return stored !== undefined && isValid(entry, stored);
  };

  const validateForSet = (entry, value) => {
    if (entry.comingSoon) {
      throw new Error(`Preference "${entry.key}" is not yet available: ${entry.comingSoon}`);
    }
    if (!isValid(entry, value)) {
      if (entry.type === 'json') {
        throw new Error(`Preference "${entry.key}" requires a plain object value.`);
      }
      throw new Error(`Invalid value for preference "${entry.key}": ${value}`);
    }
  };

  const selectors = {
    listEntries: () => PREFERENCE_REGISTRY,

    entriesForPlace: (place, state = {}) => entriesForPlace(place, state),

    /** Effective value: project override -> global -> registry default. */
    getEffective: (key) => {
      const entry = requireEntry(key);
      if (projectLayerHolds(entry)) return projectValues[key];
      const stored = values[key];
      if (stored !== undefined && isValid(entry, stored)) return stored;
      return entry.defaultValue;
    },

    /** Which layer supplies the effective value — drives the override badge. */
    getLayer: (key) => {
      const entry = requireEntry(key);
      if (projectLayerHolds(entry)) return 'project';
      const stored = values[key];
      if (stored !== undefined && isValid(entry, stored)) return 'global';
      return 'default';
    }
  };

  const commands = {
    /** Validate and set one global preference. Pure — returns next values. */
    setValue: ({ key, value }) => {
      const entry = requireEntry(key);
      validateForSet(entry, value);
      return { ...values, [key]: value };
    },

    /** Set a project-layer override. Pure — returns next projectValues. */
    setProjectValue: ({ key, value }) => {
      const entry = requireEntry(key);
      if (!entry.projectOverridable) {
        throw new Error(`Preference "${key}" is not project-overridable.`);
      }
      validateForSet(entry, value);
      return { ...(projectValues ?? {}), [key]: value };
    },

    /** Remove a project-layer override (reset to global). Pure. */
    clearProjectValue: ({ key }) => {
      requireEntry(key);
      const next = { ...(projectValues ?? {}) };
      delete next[key];
      return next;
    }
  };

  return { selectors, commands };
}
