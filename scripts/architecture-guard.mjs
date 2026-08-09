import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');
const APP_FILE = normalize(path.join(SRC_DIR, 'App.jsx'));

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const UI_PREFIXES = ['src/components/', 'src/drawers/'];
const PROJECT_FORBIDDEN_PREFIXES = [
  'src/components/',
  'src/drawers/',
  'src/behaviors/',
  'src/history/',
  'src/editor/',
  'src/App.jsx'
];
const DOMAIN_PREFIXES = ['src/behaviors/', 'src/history/', 'src/project/', 'src/editor/', 'src/app/', 'src/terminal/', 'src/preferences/'];
const APP_SHELL_IMPORT_ALLOWLIST = new Set(['src/main.jsx']);
const TEMP_ALLOWED_UI_IMPORTS = new Set([
  'src/behaviors/useAdjacency.js->src/components/PuzzlePiece.jsx',
  'src/behaviors/useConnectionDrag.js->src/components/PuzzlePiece.jsx',
  'src/behaviors/useLassoSelection.js->src/components/PuzzlePiece.jsx'
]);

function normalize(filePath) {
  return filePath.replaceAll('\\', '/');
}

function walkFiles(dirPath, collector) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, collector);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    collector.push(normalize(fullPath));
  }
}

function parseImports(sourceText) {
  const importRegex = /^\s*import(?:[\s\w{},*]+\s+from\s+)?['"]([^'"]+)['"]/gm;
  const imports = [];
  let match = importRegex.exec(sourceText);
  while (match) {
    imports.push(match[1]);
    match = importRegex.exec(sourceText);
  }
  return imports;
}

function resolveImport(sourceFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const baseDir = path.dirname(sourceFile);
  const target = path.resolve(baseDir, specifier);

  const candidates = [
    target,
    `${target}.js`,
    `${target}.jsx`,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.mjs`,
    `${target}.cjs`,
    path.join(target, 'index.js'),
    path.join(target, 'index.jsx'),
    path.join(target, 'index.ts'),
    path.join(target, 'index.tsx')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return normalize(candidate);
  }
  return normalize(target);
}

function toRepoRelative(absPath) {
  return normalize(path.relative(ROOT, absPath));
}

function startsWithAny(value, prefixes) {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function isDomainFile(repoPath) {
  return startsWithAny(repoPath, DOMAIN_PREFIXES) && repoPath !== 'src/App.jsx';
}

function isProjectFile(repoPath) {
  return repoPath.startsWith('src/project/');
}

function run() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error('Architecture guard: src directory not found.');
    process.exit(1);
  }

  const files = [];
  walkFiles(SRC_DIR, files);

  const violations = [];

  for (const absFile of files) {
    const repoFile = toRepoRelative(absFile);
    const content = fs.readFileSync(absFile, 'utf8');
    const imports = parseImports(content);

    for (const specifier of imports) {
      const resolvedAbs = resolveImport(absFile, specifier);
      const resolvedRepo = resolvedAbs ? toRepoRelative(resolvedAbs) : null;

      if (
        resolvedAbs &&
        normalize(resolvedAbs) === APP_FILE &&
        repoFile !== 'src/App.jsx' &&
        !APP_SHELL_IMPORT_ALLOWLIST.has(repoFile)
      ) {
        violations.push(`${repoFile}: forbidden import of App shell (${specifier})`);
      }

      if (!resolvedRepo) continue;

      if (isDomainFile(repoFile) && startsWithAny(resolvedRepo, UI_PREFIXES)) {
        const allowanceKey = `${repoFile}->${resolvedRepo}`;
        if (!TEMP_ALLOWED_UI_IMPORTS.has(allowanceKey)) {
          violations.push(`${repoFile}: domain file cannot import UI layer (${specifier} -> ${resolvedRepo})`);
        }
      }

      if (isProjectFile(repoFile) && startsWithAny(resolvedRepo, PROJECT_FORBIDDEN_PREFIXES)) {
        violations.push(`${repoFile}: project domain import forbidden (${specifier} -> ${resolvedRepo})`);
      }
    }
  }

  if (violations.length > 0) {
    console.error('Architecture guard failed.');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log('Architecture guard passed.');
}

run();
