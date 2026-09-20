import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CHOKEPOINT_REL = 'src/project/dbStorage.js';

// ADR-032 decision 7 — the workspace epoch is stamped in ONE place.
//
// Decision 1 gives the workspace database an identity; decision 2 stamps it in
// `invokeDb`, the single funnel every `db_*` command passes through. That is
// what fences the ~53 unawaited `db*(...).catch(() => {})` persistence writes
// without editing a call site — and what would fence the 54th for free.
//
// A direct `invoke('db_…')` anywhere else bypasses the stamp, so its request
// carries no workspace identity and Rust refuses it. The failure mode is a
// command that simply stops working, which is exactly the kind of thing a
// reviewer waves through. Guards are the enforcement of record, so this is a
// guard rather than a sentence in a document.
//
// Scope note: this checks the mechanical floor. It cannot tell whether a
// DEFERRED caller presented the epoch its work was queued for (the correction
// S1 made to decision 2 after the regression test caught the outbox stamping
// the incoming workspace's epoch). That remains a review concern.

const SCAN_DIRS = ['src', 'test'];
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs']);

// `invoke('db_x')`, `invoke("db_x")`, `invoke(\`db_x\`)`, with optional await.
const DIRECT_INVOKE = /\binvoke\s*\(\s*(['"`])(db_[A-Za-z0-9_]+)\1/;

const violations = [];
let scanned = 0;

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full);
      continue;
    }
    if (!EXTENSIONS.has(path.extname(entry.name))) continue;

    const repoPath = path.relative(ROOT, full).replace(/\\/g, '/');
    if (repoPath === CHOKEPOINT_REL) continue; // the chokepoint itself

    scanned += 1;
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const match = DIRECT_INVOKE.exec(line);
      if (!match) return;
      violations.push(
        `${repoPath}:${i + 1}: direct invoke of '${match[2]}' — route it through `
        + `${CHOKEPOINT_REL} so it carries the workspace epoch (ADR-032 decision 7)`,
      );
    });
  }
}

const chokepoint = fs.readFileSync(path.join(ROOT, CHOKEPOINT_REL), 'utf8');
if (!/workspaceEpoch/.test(chokepoint)) {
  violations.push(
    `${CHOKEPOINT_REL}: the chokepoint no longer stamps a workspace epoch — `
    + 'ADR-032 decisions 1-2 are unenforced',
  );
}

for (const dir of SCAN_DIRS) walk(path.join(ROOT, dir));

if (violations.length > 0) {
  console.error('DB chokepoint guard failed.');
  for (const v of violations) console.error(`- ${v}`);
  process.exit(1);
}

console.log(`DB chokepoint guard passed (${scanned} files scanned).`);
