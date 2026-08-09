// extract-sourcemaps.mjs — move hidden sourcemaps out of dist/ after a
// release build, so they are archived per version instead of shipped in the
// installer. Crash stacks pasted into issues get symbolicated against these
// (e.g. with `npx stacktracify release-sourcemaps/<version>/<chunk>.js.map`).
//
// Usage: node scripts/extract-sourcemaps.mjs   (runs as part of build:release)

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const OUT = path.join(ROOT, 'release-sourcemaps', version);

function collectMaps(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectMaps(full));
    } else if (entry.name.endsWith('.map')) {
      found.push(full);
    }
  }
  return found;
}

const maps = collectMaps(DIST);
if (maps.length === 0) {
  console.log('[sourcemaps] no .map files found in dist/ (nothing to extract).');
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
for (const mapPath of maps) {
  const dest = path.join(OUT, path.basename(mapPath));
  fs.copyFileSync(mapPath, dest);
  fs.unlinkSync(mapPath);
}
console.log(`[sourcemaps] moved ${maps.length} map(s) out of dist/ -> ${path.relative(ROOT, OUT)}`);
