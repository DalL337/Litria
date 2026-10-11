// What the reopen pill says about an interrupted agent change (Project API
// build plan W4b; owner ruling 2026-10-11: a pill on reopen, never a replay).
//
// Rust settles each operation an earlier run left half-applied and reports it
// once: the new files it created or may have created (still on disk), and how
// many unsaved edits the restart took (the editor keeps no unsaved text
// across a restart). Pure, so the wording is node-tested.

const SHOWN_FILES = 3;

function listFiles(files) {
  const shown = files.slice(0, SHOWN_FILES);
  const more = files.length - shown.length;
  const head = shown.length > 1
    ? `${shown.slice(0, -1).join(', ')}${more > 0 ? ', ' : ' and '}${shown[shown.length - 1]}`
    : shown[0];
  return more > 0 ? `${head} and ${more} more` : head;
}

/**
 * @param {{files?: string[], unsavedEdits?: number}} report
 * @returns {string|null} the pill's text, or null when there is nothing to say
 */
export function describeInterruptedOperation(report) {
  const files = Array.isArray(report?.files) ? report.files.filter((file) => typeof file === 'string' && file) : [];
  const edits = Number.isInteger(report?.unsavedEdits) && report.unsavedEdits > 0 ? report.unsavedEdits : 0;
  if (files.length === 0 && edits === 0) return null;
  const parts = ["An agent's change was interrupted when Litria closed, and was not run again."];
  if (files.length > 0) {
    parts.push(`Check ${listFiles(files)}: ${files.length === 1 ? 'it' : 'they'} may have been created.`);
  }
  if (edits > 0) {
    const what = `Its unsaved edits to ${edits === 1 ? '1 file were' : `${edits} files were`} lost`;
    parts.push(files.length > 0 ? `${what}.` : `${what}; nothing on disk changed.`);
  }
  return parts.join(' ');
}
