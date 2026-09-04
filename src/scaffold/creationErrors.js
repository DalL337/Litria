/**
 * creationErrors.js — classify a project-creation failure by PHASE.
 *
 * Why this exists (2026-08-31): a macOS tester hit
 * `Unable to create project directory: Read-only file system (os error 30)`
 * and the wizard offered **Create as Blank instead**. Blank writes to the same
 * destination, so the fallback could only fail identically — it fired without
 * knowing which phase had failed.
 *
 * Deliberately classifies on the error's structured `code`, not on its message
 * text and not on `category`:
 *  - `category` is too coarse — `InvalidPath` also covers project-name
 *    validation, and a "folder not empty" refusal is a `Conflict` while still
 *    being a destination problem.
 *  - `code` is emitted by Rust as stable, structured data
 *    (`CommandError::from_io(code, …)`), so this is not message-string
 *    sniffing.
 *
 * A phase discriminator was considered and rejected: the error type already
 * carries a code, so a new enum variant would add a parallel classification
 * with nothing extra to say.
 * (Journal: .research/2026-08-31-macos-tilde-default-path.md)
 */

/**
 * Codes whose failure is about WHERE the project goes, not HOW it is built.
 * Matched on the last two dot-segments so every command prefix
 * (`blank_project.`, `python_scaffold.`, `scaffold.`) is covered at once.
 */
const DESTINATION_SUFFIXES = [
  'location.invalid',
  'location.required',
  'root.mkdir',
  'root.not_dir',
  'root.not_empty',
  'root.read',
];

/** Whole codes that do not follow the `<command>.<area>.<detail>` shape. */
const DESTINATION_CODES = new Set([
  'scaffold.location_create_failed',
  'scaffold.target_exists',
]);

/**
 * Is this failure about the destination rather than the scaffold?
 *
 * Destination failures must NOT offer "Create as Blank" — Blank writes to the
 * same place and would fail the same way. They should offer a way to change
 * the location instead.
 *
 * Unknown or unstructured errors return `false`: the scaffold fallback is the
 * historical behavior, so an unrecognised code keeps it rather than silently
 * removing an escape hatch.
 *
 * @param {unknown} err - A rejected Tauri command error, or its `code`.
 * @returns {boolean}
 */
export function isDestinationError(err) {
  const code = typeof err === 'string'
    ? err
    : (typeof err === 'object' && err !== null && typeof err.code === 'string' ? err.code : '');
  if (!code) return false;
  if (DESTINATION_CODES.has(code)) return true;
  return DESTINATION_SUFFIXES.some((suffix) => code.endsWith(`.${suffix}`));
}
