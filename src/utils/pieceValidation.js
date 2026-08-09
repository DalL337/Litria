import { findReservedDeviceSegment } from './path.js';

export function validateFilename(filename, existingPieces = []) {
  if (typeof filename !== 'string') return 'Filename is required.';
  const normalizedFilename = filename.trim();
  if (!normalizedFilename) return 'Filename is required.';

  const candidateBasename = normalizedFilename.replace(/\\/g, '/').split('/').pop()?.trim().toLowerCase();
  if (!candidateBasename) return 'Filename is required.';

  const dotIndex = candidateBasename.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === candidateBasename.length - 1) {
    return 'File extension is required (e.g. .py, .js).';
  }

  const reserved = findReservedDeviceSegment(normalizedFilename);
  if (reserved) {
    return `"${reserved}" is a reserved name on Windows.`;
  }

  const hasDuplicate = existingPieces.some((piece) => {
    if (typeof piece?.filename !== 'string') return false;
    const existingBasename = piece.filename
      .trim()
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      ?.trim()
      .toLowerCase();
    return existingBasename === candidateBasename;
  });

  if (hasDuplicate) return 'Filename already exists in this project.';
  return '';
}
