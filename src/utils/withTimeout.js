/**
 * Race a promise against a timeout. If the promise doesn't resolve within
 * `ms` milliseconds, resolve with undefined and log a warning. Does NOT
 * reject on timeout — callers should proceed with degraded behavior rather
 * than blocking the UI indefinitely.
 *
 * Used by the project-switch coordinator to bound per-subsystem teardown
 * calls. See docs/plans/persistence/project-switch-crash-investigation.md.
 *
 * @param {Promise} promise  The async operation to race.
 * @param {number}  ms       Timeout in milliseconds.
 * @param {string}  label    Human-readable label for the warning message.
 * @returns {Promise<*>}     The promise's resolved value, or undefined on timeout.
 */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[project-switch] ${label} timed out after ${ms}ms, proceeding`);
      resolve(undefined);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
