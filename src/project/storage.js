import { crumb } from '../crash/breadcrumbs.js';

const ERROR_CATEGORIES = new Set(['AccessDenied', 'InvalidPath', 'Conflict', 'NotFound', 'Internal']);

// Commands too chatty (or too read-only) to be useful breadcrumbs — content
// loads flood the ring during hydration and evict actual user actions.
const CRUMB_SKIP = new Set(['read_project_file', 'list_project_tree']);

let lastProjectStorageError = null;

async function getInvoke() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke;
  } catch (error) {
    return null;
  }
}

function toInternalError({ code, message }) {
  return {
    category: 'Internal',
    code,
    message
  };
}

function setLastProjectStorageError(error) {
  lastProjectStorageError = error;
}

function clearLastProjectStorageError() {
  lastProjectStorageError = null;
}

function normalizeCommandError(error, fallbackCode, fallbackMessage) {
  if (error && typeof error === 'object') {
    const category = typeof error.category === 'string' && ERROR_CATEGORIES.has(error.category)
      ? error.category
      : 'Internal';
    const code = typeof error.code === 'string' && error.code.trim()
      ? error.code.trim()
      : fallbackCode;
    const message = typeof error.message === 'string' && error.message.trim()
      ? error.message.trim()
      : fallbackMessage;
    return { category, code, message };
  }

  if (typeof error === 'string' && error.trim()) {
    return toInternalError({ code: fallbackCode, message: error.trim() });
  }

  if (error instanceof Error) {
    return toInternalError({
      code: fallbackCode,
      message: error.message || fallbackMessage
    });
  }

  return toInternalError({ code: fallbackCode, message: fallbackMessage });
}

function createClientValidationError(code, message) {
  return {
    category: 'InvalidPath',
    code,
    message
  };
}

async function invokeWithTypedError(command, payload, { fallbackCode, fallbackMessage }) {
  const invoke = await getInvoke();
  if (!invoke) {
    const error = toInternalError({
      code: 'client.tauri_unavailable',
      message: 'Tauri invoke bridge is unavailable.'
    });
    setLastProjectStorageError(error);
    return { ok: false, error };
  }

  try {
    const data = await invoke(command, payload);
    clearLastProjectStorageError();
    if (!CRUMB_SKIP.has(command)) crumb('command', `${command}:ok`);
    return { ok: true, data };
  } catch (rawError) {
    const error = normalizeCommandError(rawError, fallbackCode, fallbackMessage);
    setLastProjectStorageError(error);
    if (!CRUMB_SKIP.has(command)) crumb('command', `${command}:err`);
    return { ok: false, error };
  }
}

export function getLastProjectStorageError() {
  return lastProjectStorageError;
}

export function clearProjectStorageError() {
  clearLastProjectStorageError();
}

export async function readProjectFile(rootPath, relativePath) {
  if (!rootPath || !relativePath) {
    setLastProjectStorageError(createClientValidationError('project_file.path.required', 'Project and file paths are required.'));
    return null;
  }
  const response = await invokeWithTypedError('read_project_file', { rootPath, relativePath }, {
    fallbackCode: 'project_file.read.failed',
    fallbackMessage: 'Unable to read project file.'
  });
  return response.ok ? response.data : null;
}

/**
 * Read a project file together with its disk revision (Project API brief §4.5:
 * Rust mints every disk revision). Returns `{ text, revision }` on success, or
 * null on error. The syntax registration paths use this so SyntaxDomain records
 * the revision of the disk text it parsed (P4c). Semantics match
 * `readProjectFile`: strict UTF-8, no BOM stripping.
 */
export async function readProjectFileWithRevision(rootPath, relativePath) {
  if (!rootPath || !relativePath) {
    setLastProjectStorageError(createClientValidationError('project_file.path.required', 'Project and file paths are required.'));
    return null;
  }
  const response = await invokeWithTypedError('read_project_file_with_revision', { rootPath, relativePath }, {
    fallbackCode: 'project_file.read.failed',
    fallbackMessage: 'Unable to read project file.'
  });
  return response.ok ? response.data : null;
}

export async function writeProjectFile(rootPath, relativePath, contents) {
  if (!rootPath || !relativePath) {
    setLastProjectStorageError(createClientValidationError('project_file.path.required', 'Project and file paths are required.'));
    return false;
  }
  const response = await invokeWithTypedError('write_project_file', {
    rootPath,
    relativePath,
    contents: contents ?? ''
  }, {
    fallbackCode: 'project_file.write.failed',
    fallbackMessage: 'Unable to write project file.'
  });
  return response.ok;
}

/**
 * Save a file only if the disk still holds the version the saved text was
 * based on (track T slice T3a): `base` is `{ kind: 'text', text }`, the exact
 * text that version had, or `{ kind: 'absent' }` when the file was deleted and
 * the person chose to keep theirs. Resolves `{ outcome: 'saved', revision,
 * stamp }` or `{ outcome: 'changed', disk }` (nothing written; `disk` is null
 * when nothing has the name), or null on failure (typed error recorded).
 */
export async function saveProjectFile(rootPath, relativePath, contents, base) {
  if (!rootPath || !relativePath) {
    setLastProjectStorageError(createClientValidationError('project_file.path.required', 'Project and file paths are required.'));
    return null;
  }
  const response = await invokeWithTypedError('save_project_file', {
    rootPath,
    relativePath,
    contents: contents ?? '',
    base
  }, {
    fallbackCode: 'project_file.write.failed',
    fallbackMessage: 'Unable to write project file.'
  });
  return response.ok ? response.data : null;
}

/**
 * The stamps (size and modification time, opaque tokens) of `paths` in the
 * project, for noticing changes made outside Litria (track T slice T3a).
 * Resolves `[{ path, stamp }]` (stamp null when nothing readable has the
 * name), or null on failure.
 */
export async function projectFilesStamps(rootPath, paths) {
  if (!rootPath || !Array.isArray(paths)) return null;
  const response = await invokeWithTypedError('project_files_stamps', { rootPath, paths }, {
    fallbackCode: 'project_file.stat.failed',
    fallbackMessage: 'Unable to check project files.'
  });
  return response.ok ? response.data : null;
}

/**
 * The project's folder-tree stamp (track T slice T3b): `{ stamp, folders,
 * truncated }`. A different stamp means a file was created, deleted, renamed
 * or moved since the last one. Metadata only. Null on failure.
 */
export async function projectTreeStamp(rootPath) {
  if (!rootPath) return null;
  const response = await invokeWithTypedError('project_tree_stamp', { rootPath }, {
    fallbackCode: 'project_tree.stamp.failed',
    fallbackMessage: 'Unable to check the project tree.'
  });
  return response.ok ? response.data : null;
}

/**
 * Create a file only if nothing has its name: never an overwrite (Project
 * API build plan W3a). The path is taken exactly. Resolves 'created' or
 * 'exists', or null on failure (with the typed error recorded).
 */
export async function createProjectFile(rootPath, relativePath, contents) {
  if (!rootPath || !relativePath) {
    setLastProjectStorageError(createClientValidationError('project_file.path.required', 'Project and file paths are required.'));
    return null;
  }
  const response = await invokeWithTypedError('create_project_file', {
    rootPath,
    relativePath,
    contents: contents ?? ''
  }, {
    fallbackCode: 'project_file.create.failed',
    fallbackMessage: 'Unable to create project file.'
  });
  return response.ok ? response.data : null;
}

export async function listProjectTree(rootPath) {
  if (!rootPath) {
    setLastProjectStorageError(createClientValidationError('project_tree.path.required', 'Project path is required.'));
    return null;
  }
  const response = await invokeWithTypedError('list_project_tree', { rootPath }, {
    fallbackCode: 'project_tree.list.failed',
    fallbackMessage: 'Unable to list project tree.'
  });
  return response.ok ? response.data : null;
}

export async function moveProjectPath(rootPath, fromRelative, toRelative) {
  if (!rootPath || !fromRelative || !toRelative) {
    setLastProjectStorageError(createClientValidationError('project_path.move.required', 'Project and source/target paths are required.'));
    return false;
  }
  const response = await invokeWithTypedError('move_project_path', {
    rootPath,
    fromRelative,
    toRelative
  }, {
    fallbackCode: 'project_path.move.failed',
    fallbackMessage: 'Unable to move project path.'
  });
  return response.ok;
}

export async function createProjectDirectory(rootPath, relativePath) {
  if (!rootPath || !relativePath) {
    setLastProjectStorageError(createClientValidationError('project_dir.path.required', 'Project and directory paths are required.'));
    return false;
  }
  const response = await invokeWithTypedError('create_project_directory', {
    rootPath,
    relativePath
  }, {
    fallbackCode: 'project_dir.create.failed',
    fallbackMessage: 'Unable to create project directory.'
  });
  return response.ok;
}

export async function deleteProjectPath(rootPath, relativePath) {
  if (!rootPath || !relativePath) {
    setLastProjectStorageError(createClientValidationError('project_path.delete.required', 'Project and target path are required.'));
    return false;
  }
  const response = await invokeWithTypedError('delete_project_path', {
    rootPath,
    relativePath
  }, {
    fallbackCode: 'project_path.delete.failed',
    fallbackMessage: 'Unable to delete project path.'
  });
  return response.ok;
}

export async function removeEmptyDirectory(rootPath, relativePath) {
  if (!rootPath || !relativePath) {
    setLastProjectStorageError(createClientValidationError('project_dir.path.required', 'Project and directory paths are required.'));
    return false;
  }
  const response = await invokeWithTypedError('remove_empty_directory', {
    rootPath,
    relativePath
  }, {
    fallbackCode: 'project_dir.remove_empty.failed',
    fallbackMessage: 'Unable to remove empty directory.'
  });
  return response.ok;
}

// ADR-022 (audit #1): Rust owns the open-file picker AND the read, so no
// command reads an arbitrary frontend-supplied path. Returns { path, contents }
// on success, { cancelled: true } when the user cancels the picker, or null on
// error (recorded via the storage error state, surfaced by the caller).
export async function openFileDialog() {
  const response = await invokeWithTypedError('open_file_dialog', {}, {
    fallbackCode: 'external_file.read.failed',
    fallbackMessage: 'Unable to open the selected file.'
  });
  if (!response.ok) return null;
  return response.data ?? { cancelled: true };
}
