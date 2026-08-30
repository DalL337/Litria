import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const STYLE_EXTENSIONS = new Set(['.css']);

// ============================================================================
// Editor engine containment.
//
// Litria's text editor is Monaco, but Monaco is meant to be ONE implementation
// of an editor engine -- not the app's vocabulary. This guard keeps the engine
// sealed inside a named set of files so that "what would it take to swap the
// editor?" stays a question with a printed answer instead of an archaeology
// dig. (Investigation: .research/2026-08-30-editor-adapter-pluggability.md)
//
// It enforces four rules and REPORTS a fifth category:
//   1. Only ENGINE_FILES may import the engine's npm packages.
//   2. Only ENGINE_FILES may import the engine facades (monacoSetup /
//      monacoWorkspace).
//   3. Engine-specific vocabulary (type names, Monaco-only method names, the
//      cm:// model URI scheme) may not appear in code outside ENGINE_FILES.
//   4. The engine's own DOM class names may not be queried outside
//      ENGINE_FILES -- this is the rule that catches coupling carrying no
//      import at all, which the architecture guard structurally cannot see.
//   5. INJECTED coupling -- modules that receive engine objects as arguments
//      and duck-type them. These are ALLOWED (that is the portable shape) but
//      are printed on every run, because their union IS the editor-engine
//      contract. The printed list is the spec a second engine would implement.
//
// Adding an ENGINE_FILES entry means "this file is part of the engine
// package." That list is expected to stay small and to shrink toward a single
// directory. Adding a TEMP_ALLOWED_* entry means "this is debt, with a note
// saying what the fix is." Those two lists mean opposite things -- do not
// confuse them.
// ============================================================================

// The engine package: the only files permitted to name Monaco.
const ENGINE_FILES = new Set([
  'src/editor/monacoSetup.js',
  'src/editor/monacoWorkspace.js',
  'src/components/EditorMonaco.jsx',
  'src/components/EditorMonacoPane.jsx',
  // Overrides for Monaco's own widget CSS. Legitimately engine-owned; belongs
  // beside the engine rather than imported from App.jsx (tracked debt).
  'src/styles/monaco-overrides.css'
]);

// npm packages that ARE the engine.
const ENGINE_PACKAGE_PATTERNS = [
  /^monaco-editor(\/|$)/,
  /^@monaco-editor(\/|$)/
];

// Local modules that re-export or wrap the engine. Importing these is the same
// commitment as importing the package itself.
const ENGINE_FACADE_SUFFIXES = ['/editor/monacoSetup', '/editor/monacoWorkspace'];

// Rule 3: identifiers that exist only in Monaco's vocabulary.
const ENGINE_VOCABULARY = [
  'ITextModel',
  'IStandaloneCodeEditor',
  'IMarkerData',
  'MarkerSeverity',
  'deltaDecorations',
  'setModelMarkers',
  'getModelMarkers',
  'onDidChangeModelContent',
  'onDidType',
  'KeyMod.',
  'KeyCode.',
  'editor.action.',
  'cm://'
];

// Rule 4: DOM class names owned by the engine, not by Litria.
const ENGINE_DOM_CLASS_PATTERN = /\.monaco-[a-z][a-z0-9-]*/g;

// Rule 5: modules that receive engine objects as parameters and duck-type
// them. Allowed by design -- reported, never a violation. The methods they
// call are the discovered contract.
const INJECTED_COUPLING_FILES = new Set([
  'src/lsp/syntaxAdapter.js',
  'src/lsp/pythonLspProviders.js',
  'src/lsp/typescriptLspProviders.js',
  'src/lsp/managedLspProviders.js',
  'src/editor/pythonLocalIntelligence.js'
]);

// Debt, not grants. Each entry names its fix. Shrink this list.
const TEMP_ALLOWED_DOM_COUPLING = new Map([
  [
    'src/app/interactionDomain.js',
    "isEditableTarget() tests closest('.monaco-editor') to decide whether a " +
    'bare-letter shortcut should fire. The fix is NOT a swap to ' +
    "'.editor-monaco-shell': that shell wraps the whole pane including the " +
    'hover card and its buttons, so it would broaden what counts as ' +
    'editable. Needs an engine-provided containsTextFocus(el) capability.'
  ],
  [
    'src/app/useGlobalShortcuts.js',
    'Same predicate, second copy (isInMonaco). Should consume the same ' +
    'engine capability as interactionDomain once it exists.'
  ]
]);

// Members observed on injected engine objects -- collected for the report.
const INJECTED_MEMBER_PATTERN = /\b(?:model|monaco|position)\.[A-Za-z][A-Za-z0-9_.]*/g;

function normalize(filePath) {
  return filePath.replaceAll('\\', '/');
}

function toRepoRelative(absPath) {
  return normalize(path.relative(ROOT, absPath));
}

function walkFiles(dirPath, collector) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, collector);
      continue;
    }
    const ext = path.extname(entry.name);
    if (!SOURCE_EXTENSIONS.has(ext) && !STYLE_EXTENSIONS.has(ext)) continue;
    collector.push(normalize(fullPath));
  }
}

function parseImports(sourceText) {
  const results = [];
  const staticImport = /^\s*import(?:[\s\w{},*]+\s+from\s+)?['"]([^'"]+)['"]/gm;
  const dynamicImport = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [staticImport, dynamicImport]) {
    let match = re.exec(sourceText);
    while (match) {
      results.push(match[1]);
      match = re.exec(sourceText);
    }
  }
  return results;
}

// Strip block comments and whole-line comments so documentation prose does not
// register as coupling. Deliberately leaves trailing comments in place: the
// guard errs toward flagging, and naive '//' stripping would also eat the
// 'cm://' scheme inside string literals, which is exactly what rule 3 hunts.
function stripComments(sourceText) {
  const withoutBlocks = sourceText.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, ' ')
  );
  return withoutBlocks
    .split('\n')
    .map((line) => (line.trim().startsWith('//') ? '' : line))
    .join('\n');
}

function lineNumberOf(sourceText, index) {
  return sourceText.slice(0, index).split('\n').length;
}

function run() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error('Editor engine guard: src directory not found.');
    process.exit(1);
  }

  const files = [];
  walkFiles(SRC_DIR, files);

  const violations = [];
  const injectedReport = new Map();
  const debtReport = [];

  // A stale allowlist is a silently rotting allowlist.
  const manifestEntries = [
    ['ENGINE_FILES', [...ENGINE_FILES]],
    ['INJECTED_COUPLING_FILES', [...INJECTED_COUPLING_FILES]],
    ['TEMP_ALLOWED_DOM_COUPLING', [...TEMP_ALLOWED_DOM_COUPLING.keys()]]
  ];
  for (const [listName, entries] of manifestEntries) {
    for (const entry of entries) {
      if (!fs.existsSync(path.join(ROOT, entry))) {
        violations.push(`${listName} lists a file that does not exist: ${entry}`);
      }
    }
  }

  for (const absFile of files) {
    const repoFile = toRepoRelative(absFile);
    const raw = fs.readFileSync(absFile, 'utf8');
    const isStyle = STYLE_EXTENSIONS.has(path.extname(absFile));
    const code = isStyle ? raw : stripComments(raw);
    const engineOwned = ENGINE_FILES.has(repoFile);

    if (!isStyle) {
      for (const specifier of parseImports(raw)) {
        // Rule 1 -- engine packages.
        if (ENGINE_PACKAGE_PATTERNS.some((re) => re.test(specifier)) && !engineOwned) {
          violations.push(
            `${repoFile}: forbidden engine package import '${specifier}' ` +
            '(only ENGINE_FILES may import the editor engine)'
          );
        }
        // Rule 2 -- engine facades.
        const resolved = specifier.startsWith('.')
          ? normalize(path.resolve(path.dirname(absFile), specifier))
          : specifier;
        if (!engineOwned && ENGINE_FACADE_SUFFIXES.some((suffix) => resolved.endsWith(suffix))) {
          violations.push(
            `${repoFile}: forbidden engine facade import '${specifier}' ` +
            '(monacoSetup/monacoWorkspace are engine-internal)'
          );
        }
      }

      // Rule 3 -- vocabulary.
      if (!engineOwned) {
        for (const token of ENGINE_VOCABULARY) {
          let from = code.indexOf(token);
          while (from !== -1) {
            violations.push(
              `${repoFile}:${lineNumberOf(code, from)}: engine vocabulary '${token}' ` +
              'outside the engine package'
            );
            from = code.indexOf(token, from + token.length);
          }
        }
      }
    }

    // Rule 4 -- engine DOM classes (JS and CSS alike).
    if (!engineOwned) {
      const seen = new Set();
      let match = ENGINE_DOM_CLASS_PATTERN.exec(code);
      while (match) {
        const line = lineNumberOf(code, match.index);
        const note = TEMP_ALLOWED_DOM_COUPLING.get(repoFile);
        if (note) {
          const key = `${repoFile}:${line}`;
          if (!seen.has(key)) {
            seen.add(key);
            debtReport.push(`${key} uses '${match[0]}' -- ${note}`);
          }
        } else {
          violations.push(
            `${repoFile}:${line}: engine DOM class '${match[0]}' outside the ` +
            'engine package (this coupling carries no import; see rule 4)'
          );
        }
        match = ENGINE_DOM_CLASS_PATTERN.exec(code);
      }
      ENGINE_DOM_CLASS_PATTERN.lastIndex = 0;
    }

    // Rule 5 -- injected coupling: report, never fail.
    if (INJECTED_COUPLING_FILES.has(repoFile)) {
      const members = new Set();
      let match = INJECTED_MEMBER_PATTERN.exec(code);
      while (match) {
        members.add(match[0]);
        match = INJECTED_MEMBER_PATTERN.exec(code);
      }
      INJECTED_MEMBER_PATTERN.lastIndex = 0;
      if (members.size > 0) {
        injectedReport.set(repoFile, [...members].sort());
      }
    }
  }

  if (violations.length > 0) {
    console.error('Editor engine guard failed.');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log('Editor engine guard passed.');
  console.log(`  Engine package: ${ENGINE_FILES.size} files.`);

  if (injectedReport.size > 0) {
    console.log('');
    console.log('  Injected coupling (allowed) -- the editor-engine contract:');
    for (const [file, members] of [...injectedReport].sort()) {
      console.log(`    ${file}`);
      console.log(`      ${members.join(', ')}`);
    }
  }

  if (debtReport.length > 0) {
    console.log('');
    console.log(`  TEMP debt (${debtReport.length}) -- engine DOM coupling awaiting a capability:`);
    for (const entry of debtReport) {
      console.log(`    ${entry}`);
    }
  }
}

run();
