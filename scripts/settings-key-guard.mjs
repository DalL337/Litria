import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const REGISTRY_REL = 'src/preferences/registry.js';

// ADR-019: "No surface may hard-code a setting key. … This rule is guardable
// and should be guarded."
//
// Two checks:
//   1. Registry shape invariants — the registry is imported directly (it is
//      pure data), so drift between declaration and enforcement is impossible.
//   2. Key-literal scan — a registered preference key may appear as a string
//      literal ONLY inside the registry itself. Everyone else imports
//      PREF_KEYS. Dot-access reads of raw preference blobs (`prefs.foo`) are
//      also rejected for distinctive keys; 'appearance' and 'energyLevel' are
//      exempt from the dot check because they are legitimate field names of
//      theme-domain state objects. Like the app-shell guard, this checks the
//      mechanical floor only — per-key branching inside a surface is still a
//      review concern.

// file → key → reason. Additions require a rationale, same as the app-shell
// manifest. Keep this empty.
const ALLOWED = [];

const DOT_EXEMPT = new Set(['appearance', 'energyLevel']);

const registry = await import(pathToFileURL(path.join(ROOT, REGISTRY_REL)).href);
const { PREFERENCE_REGISTRY, PREF_KEYS, PREFERENCE_SCOPES, PREFERENCE_PROPAGATIONS } = registry;

const violations = [];

// ── Check 1: registry shape invariants ─────────────────────────────────────
if (!Array.isArray(PREFERENCE_REGISTRY) || PREFERENCE_REGISTRY.length === 0) {
  violations.push(`${REGISTRY_REL}: PREFERENCE_REGISTRY missing or empty`);
}

const keys = [];
for (const entry of PREFERENCE_REGISTRY ?? []) {
  const k = entry?.key;
  if (typeof k !== 'string' || !k) {
    violations.push(`${REGISTRY_REL}: entry with missing key`);
    continue;
  }
  if (keys.includes(k)) violations.push(`${REGISTRY_REL}: duplicate key '${k}'`);
  keys.push(k);

  if (!PREFERENCE_SCOPES.includes(entry.scope)) {
    violations.push(`${REGISTRY_REL}: ${k}: invalid scope '${entry.scope}'`);
  }
  if (!PREFERENCE_PROPAGATIONS.includes(entry.propagation)) {
    violations.push(`${REGISTRY_REL}: ${k}: invalid propagation '${entry.propagation}'`);
  }
  if (typeof entry.label !== 'string' || !entry.label) {
    violations.push(`${REGISTRY_REL}: ${k}: label required`);
  }
  if (typeof entry.caption !== 'string' || !entry.caption) {
    violations.push(`${REGISTRY_REL}: ${k}: caption required (always-visible, ADR-019)`);
  }
  if (!Array.isArray(entry.place) || entry.place.length === 0) {
    violations.push(`${REGISTRY_REL}: ${k}: place required`);
  }
  if (typeof entry.projectOverridable !== 'boolean') {
    violations.push(`${REGISTRY_REL}: ${k}: projectOverridable must be explicit`);
  }
  if (entry.projectOverridable === true && !entry.place?.includes('preferences.project')) {
    violations.push(
      `${REGISTRY_REL}: ${k}: projectOverridable but never surfaces in 'preferences.project' — the override UI could not render`
    );
  }
  if (entry.type === 'enum') {
    if (!Array.isArray(entry.values) || entry.values.length === 0) {
      violations.push(`${REGISTRY_REL}: ${k}: enum requires values`);
    } else if (!entry.values.includes(entry.defaultValue)) {
      violations.push(`${REGISTRY_REL}: ${k}: defaultValue '${entry.defaultValue}' not in values`);
    }
  }
  if (entry.type === 'boolean' && typeof entry.defaultValue !== 'boolean') {
    violations.push(`${REGISTRY_REL}: ${k}: boolean requires a boolean defaultValue`);
  }
}

if (!PREF_KEYS || Object.isFrozen(PREF_KEYS) !== true) {
  violations.push(`${REGISTRY_REL}: PREF_KEYS must be exported and frozen`);
} else {
  const mapped = Object.keys(PREF_KEYS);
  for (const k of keys) {
    if (PREF_KEYS[k] !== k) violations.push(`${REGISTRY_REL}: PREF_KEYS missing or mismapping '${k}'`);
  }
  for (const k of mapped) {
    if (!keys.includes(k)) violations.push(`${REGISTRY_REL}: PREF_KEYS has unregistered key '${k}'`);
  }
}

// ── Check 2: key-literal scan over src/ ────────────────────────────────────
function normalize(p) {
  return p.replaceAll('\\', '/');
}

function collectSourceFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(abs, files);
    } else if (/\.(js|jsx)$/.test(entry.name)) {
      files.push(abs);
    }
  }
  return files;
}

// Blank out comments while preserving line numbers, so doc mentions of a key
// never trip the scan. Guard-grade stripping: block comments first, then
// line-comment tails (a `//` inside a string, e.g. a URL, clips only that
// line's tail — acceptable, keys never follow a URL on the same line).
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function isAllowed(repoPath, key) {
  return ALLOWED.some((a) => a.file === repoPath && a.key === key);
}

const quotedPatterns = keys.map((k) => ({ key: k, re: new RegExp(`['"]${k}['"]`) }));
// `PREF_KEYS.<key>` is the sanctioned form — the lookbehind keeps the dot
// check from flagging its own remedy.
const dotPatterns = keys
  .filter((k) => !DOT_EXEMPT.has(k))
  .map((k) => ({ key: k, re: new RegExp(`(?<!PREF_KEYS)\\.${k}\\b`) }));

const sourceFiles = collectSourceFiles(path.join(ROOT, 'src'));
let scanned = 0;

for (const absPath of sourceFiles) {
  const repoPath = normalize(path.relative(ROOT, absPath));
  if (repoPath === REGISTRY_REL) continue;
  scanned += 1;

  const lines = stripComments(fs.readFileSync(absPath, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    for (const { key, re } of quotedPatterns) {
      if (re.test(line) && !isAllowed(repoPath, key)) {
        violations.push(`${repoPath}:${i + 1}: preference key '${key}' as a string literal — import PREF_KEYS`);
      }
    }
    for (const { key, re } of dotPatterns) {
      if (re.test(line) && !isAllowed(repoPath, key)) {
        violations.push(`${repoPath}:${i + 1}: dot-access read of preference key '${key}' — use [PREF_KEYS.${key}]`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error('Settings-key guard failed.');
  for (const v of violations) console.error(`- ${v}`);
  process.exit(1);
}

console.log(`Settings-key guard passed (${keys.length} keys, ${scanned} files scanned).`);
