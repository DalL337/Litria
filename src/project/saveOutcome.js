export const FILE_SAVE_COMMAND = 'file.save';
export const FILE_SAVE_NO_TARGET = 'file.save.no_target';

const fallbackError = (code, message, relativePath) => ({
  category: 'Internal',
  code,
  message,
  relativePath: relativePath ?? null
});

function normalizeFailureError(error, relativePath, fallbackCode, fallbackMessage) {
  if (error && typeof error === 'object') {
    return {
      category: typeof error.category === 'string' ? error.category : 'Internal',
      code: typeof error.code === 'string' && error.code ? error.code : fallbackCode,
      message: typeof error.message === 'string' && error.message
        ? error.message
        : fallbackMessage,
      relativePath: relativePath ?? error.relativePath ?? null
    };
  }
  if (typeof error === 'string' && error) {
    return fallbackError(fallbackCode, error, relativePath);
  }
  return fallbackError(fallbackCode, fallbackMessage, relativePath);
}

/**
 * Convert a manager/storage result into the one save contract consumed by the
 * editor: only an explicit manager success may advance the baseline.
 */
export function resolveSaveOutcome({
  managerResult,
  relativePath,
  storageError = null,
  thrownError = null
} = {}) {
  if (managerResult === true || managerResult?.success === true) {
    return { saved: true, failure: null };
  }

  let error;
  if (thrownError) {
    error = normalizeFailureError(
      thrownError,
      relativePath,
      'file.save.failed',
      'Unable to save the file.'
    );
  } else if (
    managerResult
    && typeof managerResult === 'object'
    && managerResult.success === false
    && managerResult.code !== 'fs.write_failed'
  ) {
    error = normalizeFailureError(
      {
        category: 'InvalidPath',
        code: managerResult.code,
        message: managerResult.error
      },
      relativePath,
      'file.save.failed',
      'Unable to save the file.'
    );
  } else {
    error = normalizeFailureError(
      storageError,
      relativePath,
      managerResult?.code ?? 'file.save.failed',
      managerResult?.error ?? 'Unable to save the file.'
    );
  }

  return {
    saved: false,
    failure: { command: FILE_SAVE_COMMAND, error }
  };
}

export function noSaveTargetOutcome(relativePath = null) {
  return {
    saved: false,
    failure: {
      command: FILE_SAVE_COMMAND,
      error: fallbackError(
        FILE_SAVE_NO_TARGET,
        'No project or file path is available.',
        relativePath
      )
    }
  };
}

/**
 * Advance only the saved baseline; never overwrite a newer live buffer.
 * `disk` (T3a) is what the save left on disk: its stamp, so the check of open
 * files does not take this write for another program's.
 */
export function applySavedPieceBaseline(pieces, pieceId, savedCode, sameId = Object.is, disk = null) {
  return (pieces ?? []).map((piece) => {
    if (!sameId(piece.id, pieceId)) return piece;
    if (!disk) return { ...piece, code: savedCode };
    return { ...piece, code: savedCode, diskStamp: disk.stamp ?? null };
  });
}

/**
 * What a save of `piece` expects on disk (track T slice T3a): the exact text
 * its saved state was read from disk as (a piece keeps it, line endings
 * included). Null without a piece: the save then writes as before. A save
 * that recreates a file another program deleted passes `{ kind: 'absent' }`
 * itself, for that one save (the person's choice).
 */
export function diskBaseOf(piece) {
  if (!piece) return null;
  return { kind: 'text', text: typeof piece.code === 'string' ? piece.code : '' };
}
