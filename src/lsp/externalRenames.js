/**
 * Renames another program made (track T slice T3b).
 *
 * When Litria renames a file itself, the editor's rename of its open tab
 * re-points the importers and rewrites their import lines
 * (`syntaxAdapter.onFileRenamed`). When ANOTHER program renamed it, Litria
 * follows the rename but writes nothing: that program owns the files, import
 * lines included (owner ruling 2026-10-15). The write manager records the new
 * path here before the tab's name changes; the adapter takes it when the tab's
 * model follows, which can be much later (a tab renames when it is next shown).
 *
 * Keys are absolute paths, as the syntax domain's.
 */
const external = new Set();

export function markExternalRename(absPath) {
  if (absPath) external.add(absPath);
}

/** Whether the rename to `absPath` was another program's; it is taken once. */
export function takeExternalRename(absPath) {
  return external.delete(absPath);
}

/** A project closed: nothing of it applies to the next one. */
export function forgetExternalRenames() {
  external.clear();
}
