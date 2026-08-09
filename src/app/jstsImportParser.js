/**
 * jstsImportParser.js — Parse import statements from JS/TS source files.
 *
 * Handles:
 *   - Named imports:     import { A, B } from './mod';
 *   - Default imports:   import Foo from './mod';
 *   - Namespace imports: import * as Mod from './mod';
 *   - Type imports:      import type { T } from './mod';
 *   - Inline type:       import { type T, A } from './mod';
 *   - Default + named:   import Def, { A } from './mod';
 *   - Side-effect:       import './mod';
 *   - Multi-line imports
 *
 * Skips:
 *   - Dynamic import() expressions
 *   - Bare specifiers (node_modules — no leading '.' or '/')
 *   - Comments containing import-like text
 *
 * @module jstsImportParser
 */

/**
 * @typedef {object} ImportSymbol
 * @property {string} name      - Local binding name.
 * @property {string|null} alias - Original name if aliased, else null.
 * @property {'named'|'default'|'type'|'namespace'} kind
 */

/**
 * @typedef {object} ImportStatement
 * @property {string} moduleSpecifier  - The module specifier (e.g. './utils').
 * @property {ImportSymbol[]} symbols  - Imported bindings.
 * @property {number} line             - 0-indexed line of the import keyword.
 * @property {boolean} isTypeOnly      - True if `import type { ... }`.
 * @property {boolean} isSideEffect    - True if `import './mod'` (no bindings).
 */

/**
 * Parse all static import statements from JS/TS source text.
 * Only returns imports with relative specifiers (starting with '.' or '/').
 *
 * @param {string} text     - Full source file content.
 * @param {string} filePath - Absolute file path (for context, not used in parsing).
 * @returns {ImportStatement[]}
 */
export function parseJsTsImports(text, filePath) {
  const lines = text.split('\n');
  const results = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trimStart();

    // Skip single-line comments
    if (trimmed.startsWith('//')) { i++; continue; }

    // Skip block comments
    if (trimmed.startsWith('/*')) {
      while (i < lines.length && !lines[i].includes('*/')) i++;
      i++;
      continue;
    }

    // Match lines starting with 'import'
    if (/^import\s/.test(trimmed) || /^import['"`{]/.test(trimmed)) {
      const startLine = i;

      // Collect multi-line import (until we find the 'from' clause or semicolon)
      let full = lines[i];
      while (i < lines.length - 1 && !_isImportComplete(full)) {
        i++;
        full += '\n' + lines[i];
      }

      const parsed = _parseSingleImport(full, startLine);
      if (parsed && _isRelativeSpecifier(parsed.moduleSpecifier)) {
        results.push(parsed);
      }
    }

    i++;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check if an import statement is syntactically complete.
 * A complete import either has a `from '...'` clause followed by a semicolon
 * (or end of line), or is a side-effect import with just a specifier.
 */
function _isImportComplete(text) {
  // Side-effect: import 'specifier';
  if (/^import\s+['"`]/.test(text.trimStart()) && /['"`]\s*;?\s*$/.test(text)) return true;
  // Has `from '...'` ending
  if (/from\s+['"`][^'"`]*['"`]\s*;?\s*$/.test(text)) return true;
  return false;
}

/**
 * Parse a single (possibly multi-line) import statement.
 * @returns {ImportStatement|null}
 */
function _parseSingleImport(text, line) {
  const clean = text.replace(/\n/g, ' ').trim();

  // Skip dynamic import()
  if (/^import\s*\(/.test(clean)) return null;

  // Side-effect import: import './module';
  const sideEffectMatch = clean.match(/^import\s+(['"`])([^'"`]+)\1\s*;?$/);
  if (sideEffectMatch) {
    return {
      moduleSpecifier: sideEffectMatch[2],
      symbols: [],
      line,
      isTypeOnly: false,
      isSideEffect: true,
    };
  }

  // Extract the 'from' specifier
  const fromMatch = clean.match(/from\s+(['"`])([^'"`]+)\1\s*;?$/);
  if (!fromMatch) return null;

  const moduleSpecifier = fromMatch[2];
  const beforeFrom = clean.slice(0, clean.lastIndexOf('from')).trim();

  // Remove 'import' keyword
  let clause = beforeFrom.replace(/^import\s+/, '').trim();

  // Check for `import type { ... }` or `import type * as ...`
  const isTypeOnly = /^type\s+/.test(clause);
  if (isTypeOnly) {
    clause = clause.replace(/^type\s+/, '');
  }

  const symbols = _parseImportClause(clause, isTypeOnly);

  return {
    moduleSpecifier,
    symbols,
    line,
    isTypeOnly,
    isSideEffect: false,
  };
}

/**
 * Parse the import clause (everything between `import` and `from`).
 * @param {string} clause
 * @param {boolean} isTypeOnly
 * @returns {ImportSymbol[]}
 */
function _parseImportClause(clause, isTypeOnly) {
  const symbols = [];

  if (!clause) return symbols;

  // Namespace: * as Name
  const nsMatch = clause.match(/^\*\s+as\s+(\w+)$/);
  if (nsMatch) {
    symbols.push({ name: nsMatch[1], alias: null, kind: 'namespace' });
    return symbols;
  }

  // Default + named: DefaultName, { A, B }
  // Default + namespace: DefaultName, * as NS
  let defaultName = null;
  let namedPart = clause;

  const defaultCommaMatch = clause.match(/^(\w+)\s*,\s*(.+)$/s);
  if (defaultCommaMatch && !defaultCommaMatch[1].match(/^(type)$/)) {
    defaultName = defaultCommaMatch[1];
    namedPart = defaultCommaMatch[2].trim();
    symbols.push({ name: defaultName, alias: null, kind: 'default' });
  }

  // Namespace in named part: * as NS
  const nsPartMatch = namedPart.match(/^\*\s+as\s+(\w+)$/);
  if (nsPartMatch) {
    symbols.push({ name: nsPartMatch[1], alias: null, kind: 'namespace' });
    return symbols;
  }

  // Named: { A, B as C, type D }
  const bracedMatch = namedPart.match(/^\{([^}]*)\}$/s);
  if (bracedMatch) {
    const inner = bracedMatch[1];
    const entries = inner.split(',');
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (!trimmed) continue;

      // Check for inline `type` keyword: `type Foo` or `type Foo as Bar`
      const isInlineType = /^type\s+/.test(trimmed);
      const cleanEntry = isInlineType ? trimmed.replace(/^type\s+/, '') : trimmed;
      const kind = (isTypeOnly || isInlineType) ? 'type' : 'named';

      // Handle alias: `Original as Alias`
      const asMatch = cleanEntry.match(/^(\w+)\s+as\s+(\w+)$/);
      if (asMatch) {
        symbols.push({ name: asMatch[2], alias: asMatch[1], kind });
      } else if (/^\w+$/.test(cleanEntry)) {
        symbols.push({ name: cleanEntry, alias: null, kind });
      }
    }
    return symbols;
  }

  // Bare default: `import DefaultName from '...'`
  if (!defaultName && /^\w+$/.test(namedPart)) {
    symbols.push({ name: namedPart, alias: null, kind: 'default' });
  }

  return symbols;
}

/**
 * Check if a module specifier is relative (starts with . or /).
 * Bare specifiers (node_modules) are excluded.
 */
function _isRelativeSpecifier(spec) {
  return spec.startsWith('.') || spec.startsWith('/');
}
