import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

// ADR-008 Protected Zones — these files must never import from src/components/ui/ or radix-ui.
// Each entry maps to the rationale in docs/adrs/008-protected-zones-shadcn-exclusions.md.
const PROTECTED_FILES = new Set([
  // Monaco editor zone
  'src/styles/monaco-overrides.css',
  'src/components/EditorMonaco.jsx',
  'src/editor/monacoSetup.js',
  'src/editor/editorHeaders.js',
  'src/editor/editorLanguage.js',
  'src/editor/pythonLocalIntelligence.js',
  'src/editor/EditorSessionContext.jsx',

  // CM hover card (logic lives in EditorMonaco.jsx, already listed above)
  'src/styles/hover-card.css',

  // Canvas interaction
  'src/styles/canvas.css',
  'src/components/PuzzlePiece.jsx',
  'src/components/ConnectionLine.jsx',
  'src/components/LassoBox.jsx',
  'src/components/EdgeGlow.jsx',

  // Minimap
  'src/components/Minimap.jsx',

  // Drawer system
  'src/styles/drawers.css',
  'src/drawers/DrawerShell.jsx',
  'src/drawers/DrawerContext.jsx',
  'src/drawers/DrawerContentSettings.jsx',
  'src/drawers/DrawerContentTerminal.jsx',
  'src/drawers/DrawerContentScaffold.jsx',
  'src/drawers/TopDrawerShell.jsx',
  'src/drawers/TopDrawerContext.jsx',

  // Pill notifications
  'src/styles/pill-notification.css',
  'src/components/PillNotification.jsx',

  // Status bar
  'src/styles/status-bar.css',
  'src/components/StatusBar.jsx',

  // Scaffold tree internals
  'src/styles/scaffold.css',
  'src/components/ScaffoldContextMenu.jsx',

  // Launch screen
  'src/styles/launch.css',
  'src/components/LaunchScreen.jsx',
  'src/components/PreferencesPanel.jsx'
]);

// Forbidden import patterns for protected zones
const FORBIDDEN_SPECIFIERS = [
  /components\/ui\//,   // shadcn components (e.g. @/components/ui/button)
  /radix-ui/            // direct radix imports (e.g. radix-ui, @radix-ui/*)
];

// Transition allowlist: known violations awaiting extraction into child components.
// Each entry is "repoPath->specifier". Do not add new entries — fix the violation instead.
// (Emptied 2026-08-01: StatusBar's popover chrome extracted to StatusBarPopover.jsx.)
const TEMP_ALLOWED_IMPORTS = new Set([]);

function normalize(filePath) {
  return filePath.replaceAll('\\', '/');
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

function toRepoRelative(absPath) {
  return normalize(path.relative(ROOT, absPath));
}

function isForbiddenImport(specifier) {
  return FORBIDDEN_SPECIFIERS.some((pattern) => pattern.test(specifier));
}

function run() {
  const violations = [];

  for (const repoPath of PROTECTED_FILES) {
    const absPath = path.join(ROOT, repoPath);

    if (!fs.existsSync(absPath)) continue; // file may not exist yet
    if (path.extname(absPath) === '.css') continue; // CSS files don't have JS imports

    const content = fs.readFileSync(absPath, 'utf8');
    const imports = parseImports(content);

    for (const specifier of imports) {
      if (isForbiddenImport(specifier)) {
        const allowanceKey = `${repoPath}->${specifier}`;
        if (!TEMP_ALLOWED_IMPORTS.has(allowanceKey)) {
          violations.push(`${repoPath}: protected zone cannot import shadcn/Radix (${specifier})`);
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error('Protected zone guard failed (ADR-008).');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log('Protected zone guard passed.');
}

run();
