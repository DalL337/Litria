const registrations = [];

function hasPortableTextFocus(element) {
  if (!element) return false;
  if (element.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName || '');
}

/**
 * Register the mounted editor engine's portable capabilities. The returned
 * cleanup is idempotent and removes only its own registration, which keeps
 * React StrictMode setup/cleanup cycles and overlapping mounts safe.
 */
export function registerEngineCapabilities({ containsTextFocus: predicate } = {}) {
  if (typeof predicate !== 'function') return () => {};
  const registration = { predicate };
  registrations.push(registration);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const index = registrations.indexOf(registration);
    if (index >= 0) registrations.splice(index, 1);
  };
}

/** True for portable text controls or an element owned by the active engine. */
export function containsTextFocus(element) {
  if (hasPortableTextFocus(element)) return true;
  const registration = registrations.at(-1);
  return registration ? Boolean(registration.predicate(element)) : false;
}
