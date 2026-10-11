const registrations = [];

function hasPortableTextFocus(element) {
  if (!element) return false;
  if (element.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName || '');
}

/**
 * Register the mounted editor engine's portable capabilities. The returned
 * cleanup is idempotent and removes only its own registration, which keeps
 * React StrictMode setup/cleanup cycles and overlapping mounts safe. Each
 * capability is served by the latest registration that provides it.
 *
 * - `containsTextFocus(element)`: whether the engine owns a focused element.
 * - `applyBufferText(tabId, text)`: put the session's text into the engine's
 *   live document for a tab, in the same turn (Project API build plan W1b).
 */
export function registerEngineCapabilities({ containsTextFocus: predicate, applyBufferText: apply } = {}) {
  const registration = {
    predicate: typeof predicate === 'function' ? predicate : null,
    apply: typeof apply === 'function' ? apply : null,
  };
  if (!registration.predicate && !registration.apply) return () => {};
  registrations.push(registration);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const index = registrations.indexOf(registration);
    if (index >= 0) registrations.splice(index, 1);
  };
}

function latest(capability) {
  for (let index = registrations.length - 1; index >= 0; index -= 1) {
    if (registrations[index][capability]) return registrations[index];
  }
  return null;
}

/** True for portable text controls or an element owned by the active engine. */
export function containsTextFocus(element) {
  if (hasPortableTextFocus(element)) return true;
  const registration = latest('predicate');
  return registration ? Boolean(registration.predicate(element)) : false;
}

/**
 * Put the session's text for a tab into the engine's live document, in this
 * turn. True when the engine holds a live document for the tab (it now holds
 * `text`); false when it holds none, or no engine is mounted — a document
 * opened later starts from the session's text anyway.
 */
export function applyBufferText(tabId, text) {
  const registration = latest('apply');
  return registration ? Boolean(registration.apply(tabId, text)) : false;
}
