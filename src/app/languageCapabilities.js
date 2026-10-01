// Language capability matrix — what Litria can do for each kind of file in
// this session. Read by the Project API owner bridge (`languages.capabilities`,
// contract brief §7.1, §8); a read model over LanguageSupportDomain and
// SyntaxDomain facts, holding no state of its own.
//
// Rows are capability classes: a language plus the exact extensions its flags
// hold for, because flags differ within one language (relationship discovery
// covers `.ts` but not `.mts`, `.py` but not `.pyi`).
//
// Each fact comes from its owner where the owner exports it:
//   - extension → language: editorLanguage.js `LANGUAGE_EXTENSIONS`
//   - relationship discovery: useDiscoveryLifecycle.js `isDiscoverableFilename`
//   - source transformations: syntaxDomain.js `writesImportsForTarget`
//   - language-server state: LanguageSupportDomain's selectors
// Editor features implemented inside the editor engine (Monaco's language
// workers, the local Python providers) have no exported predicate;
// EDITOR_FEATURES records them, with where each comes from.

import { LANGUAGE_EXTENSIONS } from '../editor/editorLanguage.js';
import { isDiscoverableFilename } from './useDiscoveryLifecycle.js';
import { writesImportsForTarget } from './syntaxDomain.js';
import { MANAGED_LANGUAGE_IDS } from './useManagedLspLifecycle.js';

/**
 * Per editor language id:
 * - `diagnostics`: `server` (only while its language server is installed),
 *   `editor` (Monaco's worker, always on) or `none`;
 * - `navigation`: go to definition or references;
 * - `symbols`: the outline of a file's symbols;
 * - `server`: the language pack that serves it, or null.
 *
 * TS/JS: diagnostics from the TypeScript language server (Monaco's own TS
 * diagnostics are switched off in monacoSetup.js); definition, references
 * and symbols from Monaco's TS worker. Python: pyright diagnostics;
 * same-file definition and symbols from pythonLocalIntelligence.js. Rust,
 * C/C++, Go: their managed servers give diagnostics, hover and completion,
 * nothing that navigates or lists symbols (managedLspProviders.js). JSON and
 * CSS: Monaco workers validate; HTML's worker in this Monaco has no
 * diagnostics.
 */
export const EDITOR_FEATURES = Object.freeze({
  typescript: Object.freeze({ diagnostics: 'server', navigation: true, symbols: true, server: 'typescript' }),
  javascript: Object.freeze({ diagnostics: 'server', navigation: true, symbols: true, server: 'typescript' }),
  python: Object.freeze({ diagnostics: 'server', navigation: true, symbols: true, server: 'python' }),
  rust: Object.freeze({ diagnostics: 'server', navigation: false, symbols: false, server: 'rust' }),
  c: Object.freeze({ diagnostics: 'server', navigation: false, symbols: false, server: 'cpp' }),
  cpp: Object.freeze({ diagnostics: 'server', navigation: false, symbols: false, server: 'cpp' }),
  go: Object.freeze({ diagnostics: 'server', navigation: false, symbols: false, server: 'go' }),
  json: Object.freeze({ diagnostics: 'editor', navigation: false, symbols: true, server: null }),
  css: Object.freeze({ diagnostics: 'editor', navigation: true, symbols: true, server: null }),
  html: Object.freeze({ diagnostics: 'none', navigation: false, symbols: true, server: null }),
  markdown: Object.freeze({ diagnostics: 'none', navigation: false, symbols: false, server: null })
});

const MANAGED = new Set(MANAGED_LANGUAGE_IDS);

/**
 * `installed | notInstalled | error | unknown | none` for a language pack, as
 * LanguageSupportDomain knows it. A pack is only checked when a file of its
 * language is first shown, so before that it is `unknown`, not missing.
 * Managed packs (rust, cpp, go) are created on first touch.
 */
export function languageServerState(languageSupport, packId) {
  if (!packId) return 'none';
  const selectors = languageSupport?.selectors;
  const pack = MANAGED.has(packId)
    ? selectors?.getManagedPackState?.(packId)
    : selectors?.getPackState?.(packId);
  if (!pack || pack.lastCheckedAt == null) return 'unknown';
  switch (pack.status) {
    case 'Installed':
    case 'Update Available':
      return 'installed';
    case 'Not Installed':
      return 'notInstalled';
    case 'Error':
      return 'error';
    default:
      return 'unknown'; // 'Installing': a check is running
  }
}

/** The capability rows, in the editor's language order. */
export function buildCapabilityMatrix(languageSupport) {
  const rows = [];
  for (const [language, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
    const features = EDITOR_FEATURES[language];
    if (!features) continue;
    const languageServer = languageServerState(languageSupport, features.server);
    const diagnostics = features.diagnostics === 'editor'
      || (features.diagnostics === 'server' && languageServer === 'installed');
    // Extensions sharing the per-file flags share a row.
    const groups = new Map();
    for (const extension of extensions) {
      const sample = `file.${extension}`;
      const relationshipDiscovery = isDiscoverableFilename(sample);
      const sourceTransformations = writesImportsForTarget(sample);
      const key = `${relationshipDiscovery}|${sourceTransformations}`;
      if (!groups.has(key)) {
        groups.set(key, { relationshipDiscovery, sourceTransformations, extensions: [] });
      }
      groups.get(key).extensions.push(`.${extension}`);
    }
    for (const group of groups.values()) {
      rows.push({
        language,
        extensions: group.extensions,
        languageServer,
        documentAccess: true,
        diagnostics,
        navigation: features.navigation,
        symbols: features.symbols,
        relationshipDiscovery: group.relationshipDiscovery,
        sourceTransformations: group.sourceTransformations
      });
    }
  }
  return rows;
}
