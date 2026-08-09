// blankSeed.js — canvas layout for a blank project's substrate files.
//
// A blank project's first frame is the product pitch: the generated files
// arrive pre-placed as pieces instead of an empty desk. README (the
// quote-stamped hero) sits front-and-center; the support files stack in a
// column to its right.

export function buildBlankSeedRows(files, {
  originX = 240,
  originY = 220,
  columnGap = 360,
  rowGap = 180
} = {}) {
  const list = Array.isArray(files)
    ? files.filter((f) => typeof f === 'string' && f.trim())
    : [];
  if (!list.length) return [];

  // README leads regardless of the order the backend created files in.
  const sorted = [...list].sort((a, b) => {
    const heroA = a.toLowerCase() === 'readme.md' ? 0 : 1;
    const heroB = b.toLowerCase() === 'readme.md' ? 0 : 1;
    return heroA - heroB || a.localeCompare(b, undefined, { sensitivity: 'base' });
  });

  return sorted.map((filePath, index) => ({
    filePath,
    label: filePath,
    x: index === 0 ? originX : originX + columnGap,
    y: index === 0 ? originY : originY + (index - 1) * rowGap,
    color: null
  }));
}
