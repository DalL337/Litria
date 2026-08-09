import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

// --- Tier 1: Essential editor contributions ---
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController.js';
import 'monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/esm/vs/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2.js';
import 'monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/gotoError/browser/gotoError.js';

// --- Tier 1: Language intelligence ---
import 'monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/esm/vs/editor/contrib/parameterHints/browser/parameterHints.js';
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/goToCommands.js';
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js';
import 'monaco-editor/esm/vs/editor/contrib/documentSymbols/browser/documentSymbols.js';
import 'monaco-editor/esm/vs/editor/contrib/semanticTokens/browser/documentSemanticTokens.js';
import 'monaco-editor/esm/vs/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js';

// --- Tier 2: Strong IDE features ---
import 'monaco-editor/esm/vs/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/esm/vs/editor/contrib/format/browser/formatActions.js';
import 'monaco-editor/esm/vs/editor/contrib/smartSelect/browser/smartSelect.js';
import 'monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/stickyScroll/browser/stickyScrollContribution.js';
import 'monaco-editor/esm/vs/editor/contrib/links/browser/links.js';
import 'monaco-editor/esm/vs/editor/contrib/codeAction/browser/codeActionContributions.js';
import 'monaco-editor/esm/vs/editor/contrib/rename/browser/rename.js';
import 'monaco-editor/esm/vs/editor/contrib/dnd/browser/dnd.js';

// --- Tier 3: Language-specific (CSS, HTML) ---
import 'monaco-editor/esm/vs/editor/contrib/colorPicker/browser/colorContributions.js';
import 'monaco-editor/esm/vs/editor/contrib/colorPicker/browser/standaloneColorPickerActions.js';
import 'monaco-editor/esm/vs/editor/contrib/linkedEditing/browser/linkedEditing.js';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
// ADR-005 Slice 6 managed languages. The cpp contribution registers BOTH the
// 'c' and 'cpp' Monaco language ids.
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
// ADR-005 Slice 6.5: Go (toolchain-tier gopls).
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution';
import 'monaco-editor/esm/vs/language/css/monaco.contribution';
import 'monaco-editor/esm/vs/language/html/monaco.contribution';
import { loader } from '@monaco-editor/react';
import packageSchema from './schemas/package.schema.json';
import tsconfigSchema from './schemas/tsconfig.schema.json';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { registerPythonLocalIntelligence } from './pythonLocalIntelligence';

if (typeof self !== 'undefined' && !self.MonacoEnvironment) {
  self.MonacoEnvironment = {
    getWorker(_, label) {
      switch (label) {
        case 'json':
          return new JsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new CssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new HtmlWorker();
        case 'typescript':
        case 'javascript':
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    }
  };
}

loader.config({ monaco });

// Silence Monaco's built-in TypeScript/JavaScript worker DIAGNOSTICS at
// setup, before any model can exist. The LSP (bundled tsserver) is the
// diagnostics source; the built-in worker validates with zero project
// context (no tsconfig, no node_modules), so its output on real projects
// is noise — error 17004 on every JSX node, 2307 on every import. When it
// was only silenced at LSP-session start, models attached during the async
// spawn window collected stale 'typescript'-owner markers that flashed for
// 1–2s on every tab reactivation (deferred item, diagnosed 2026-05-06).
// Built-in completions/hover are unaffected — this touches diagnostics only.
if (monaco?.languages?.typescript) {
  const silenced = {
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true
  };
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(silenced);
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(silenced);
}

// Bundled JSON schemas (offline-first — enableSchemaRequest stays default-off,
// so the worker never fetches). Two registration forms per schema:
//   1. A fileMatch entry so the common files validate with zero configuration.
//   2. Alias entries under the canonical schemastore URLs, so a user file that
//      declares `"$schema": "https://json.schemastore.org/..."` resolves to
//      the bundled copy instead of a blocked network fetch (which surfaced as
//      the "Unable to load schema" warning marker on line 1).
// Unknown remote $schema URLs still warn — the long tail is the download+cache
// service designed in docs/plans/ideas/brief-json-schema-service.md.
if (monaco?.languages?.json?.jsonDefaults) {
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    // All .json files share Monaco's single 'json' language (editorLanguage.js),
    // so comment strictness is global. tsconfig.json is legally jsonc and
    // create-vite emits comments in it — tolerate comments everywhere rather
    // than flag valid tsconfig files. Strict-JSON violations in package.json
    // are npm's job to report, not the editor's.
    allowComments: true,
    trailingCommas: 'ignore',
    schemas: [
      {
        uri: 'cm://schemas/package.json',
        fileMatch: ['package.json', '**/package.json'],
        schema: packageSchema
      },
      { uri: 'https://json.schemastore.org/package.json', schema: packageSchema },
      { uri: 'https://json.schemastore.org/package', schema: packageSchema },
      {
        // tsconfig.json plus variants — create-vite scaffolds emit
        // tsconfig.node.json / tsconfig.app.json alongside the root file.
        uri: 'cm://schemas/tsconfig.json',
        fileMatch: ['tsconfig.json', 'tsconfig.*.json', '**/tsconfig.json', '**/tsconfig.*.json'],
        schema: tsconfigSchema
      },
      { uri: 'https://json.schemastore.org/tsconfig.json', schema: tsconfigSchema },
      { uri: 'https://json.schemastore.org/tsconfig', schema: tsconfigSchema }
    ]
  });
}

if (monaco?.editor?.defineTheme) {
  monaco.editor.defineTheme('cm-vs-dark', {
    base: 'vs-dark',
    inherit: true,
    semanticHighlighting: true,
    colors: {},
    rules: [
      { token: 'class', foreground: '7eb6ff' },
      { token: 'class.declaration', foreground: '8ec2ff' },
      { token: 'function', foreground: 'd7ba7d' },
      { token: 'function.declaration', foreground: 'e8c98e' },
      { token: 'method', foreground: 'd19a66' },
      { token: 'method.declaration', foreground: 'dfad79' },
      { token: 'variable', foreground: '9cdcfe' },
      { token: 'parameter', foreground: '4ec9b0' },
      { token: 'parameter.declaration', foreground: '4ec9b0' },
      { token: 'keyword', foreground: 'c586c0' },
      { token: 'namespace', foreground: '56b6c2' },
    ],
    semanticTokenColors: {
      class: '#7eb6ff',
      'class.declaration': '#8ec2ff',
      function: '#d7ba7d',
      'function.declaration': '#e8c98e',
      method: '#d19a66',
      'method.declaration': '#dfad79',
      variable: '#9cdcfe',
      parameter: '#4ec9b0',
      keyword: '#c586c0',
      namespace: '#56b6c2'
    }
  });
}

registerPythonLocalIntelligence(monaco);

export default monaco;
