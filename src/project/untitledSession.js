// untitledSession.js — pure helpers for the launcher "New File" flow.
//
// An untitled session is a single-file workspace (no workspace DB, like the
// "Open File" flow) whose project root has not materialized yet: the node
// exists only in memory until the first save picks a location on disk.
// Once that save lands, rootPath is set, isUntitled flips false, and the
// session is indistinguishable from the shipped "Open File" mode.
//
// The check requires the EXPLICIT isUntitled flag (set only by the launcher
// New File flow) rather than inferring from shape — other paths can produce
// manifestPath:null with an empty rootPath (e.g. Open File on a
// separator-less path) and must never be rerouted into the Save As gate.

export const UNTITLED_FILENAME = 'Untitled';

export function isUntitledSession(projectInstance) {
  return Boolean(projectInstance)
    && projectInstance.isUntitled === true
    && projectInstance.manifestPath === null
    && !projectInstance.rootPath;
}
