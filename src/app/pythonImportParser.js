/**
 * pythonImportParser.js — Parse import statements from Python source files.
 *
 * The Python sibling of jstsImportParser.js (ADR-020 follow-up: import
 * discovery parity). Pure text → statements; no resolution here — the
 * discovery engine owns turning specifiers into project files.
 *
 * Handles:
 *   - Plain imports:        import a.b.c            (one entry per module)
 *   - Aliased:              import numpy as np, os
 *   - From imports:         from a.b import X, Y as Z
 *   - Relative:             from . import x / from ..pkg.mod import X
 *   - Parenthesized:        from mod import (A,\n  B,\n)
 *   - Star:                 from mod import *
 *   - Backslash continuation lines
 *   - Function/method-level (indented) imports
 *
 * Skips:
 *   - `#` comment lines and inline-comment tails
 *   - Lines inside triple-quoted strings (stateful line scan — a docstring
 *     containing `import x` must not fabricate an edge)
 *   - `__future__` imports (compiler directives, not dependencies)
 *
 * @module pythonImportParser
 */

/**
 * @typedef {object} PythonImportSymbol
 * @property {string} name       - Local binding name (alias when aliased).
 * @property {string|null} alias - Original name when aliased, else null.
 * @property {'named'|'module'|'star'} kind
 */

/**
 * @typedef {object} PythonImportStatement
 * @property {'import'|'from'} kind
 * @property {string} moduleSpecifier - Dotted module path WITHOUT leading dots
 *                                      ('' for pure-relative `from . import x`).
 * @property {number} relativeLevel   - Leading-dot count (0 = absolute).
 * @property {PythonImportSymbol[]} symbols
 * @property {number} line            - 0-indexed line of the statement start.
 */

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const DOTTED = `${IDENT}(?:\\.${IDENT})*`;

/**
 * Parse all import statements from Python source text.
 * @param {string} text
 * @returns {PythonImportStatement[]}
 */
export function parsePythonImports(text) {
  const rawLines = text.split('\n');
  const results = [];

  let inTripleQuote = false;
  let tripleQuoteDelim = null;

  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i];

    // ---- Triple-quoted string tracking (line-granular heuristic) ----------
    if (inTripleQuote) {
      if (line.includes(tripleQuoteDelim)) {
        inTripleQuote = false;
        tripleQuoteDelim = null;
      }
      i++;
      continue;
    }

    const stripped = _stripComment(line).trim();

    // A line that OPENS a triple-quoted string (odd number of delimiters
    // means it doesn't close on the same line). Checked before import
    // matching so a docstring line starting a block is honored.
    const openDelim = _unclosedTripleQuote(stripped);
    if (openDelim) {
      inTripleQuote = true;
      tripleQuoteDelim = openDelim;
      i++;
      continue;
    }

    if (!/^(import|from)\b/.test(stripped)) {
      i++;
      continue;
    }

    // ---- Collect the full (possibly continued) statement -------------------
    const startLine = i;
    let statement = stripped;
    // Backslash continuation.
    while (statement.endsWith('\\') && i < rawLines.length - 1) {
      i++;
      statement = statement.slice(0, -1).trim() + ' ' + _stripComment(rawLines[i]).trim();
    }
    // Parenthesized from-import spanning lines.
    if (statement.includes('(') && !statement.includes(')')) {
      while (i < rawLines.length - 1 && !statement.includes(')')) {
        i++;
        statement += ' ' + _stripComment(rawLines[i]).trim();
      }
    }

    const parsed = _parseStatement(statement, startLine);
    for (const stmt of parsed) results.push(stmt);
    i++;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Remove a `#` comment tail (string-literal `#` handling is best-effort:
 *  hashes inside quotes on import lines are rare enough to ignore). */
function _stripComment(line) {
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}

/** If the line opens a triple-quoted string it doesn't close, return the
 *  delimiter; else null. Counts occurrences of each delimiter. */
function _unclosedTripleQuote(line) {
  for (const delim of ['"""', "'''"]) {
    let count = 0;
    let idx = line.indexOf(delim);
    while (idx !== -1) {
      count++;
      idx = line.indexOf(delim, idx + delim.length);
    }
    if (count % 2 === 1) return delim;
  }
  return null;
}

/**
 * Parse one complete statement into zero or more PythonImportStatements.
 * `import a, b` yields one statement per module.
 * @returns {PythonImportStatement[]}
 */
function _parseStatement(statement, line) {
  // ---- from X import ... --------------------------------------------------
  const fromMatch = statement.match(
    new RegExp(`^from\\s+(\\.*)((?:${DOTTED})?)\\s+import\\s+(.+)$`)
  );
  if (fromMatch) {
    const relativeLevel = fromMatch[1].length;
    const moduleSpecifier = fromMatch[2] ?? '';
    if (relativeLevel === 0 && !moduleSpecifier) return [];
    if (moduleSpecifier === '__future__') return [];

    let clause = fromMatch[3].trim();
    // Unwrap parentheses; tolerate trailing comma.
    clause = clause.replace(/^\(/, '').replace(/\)\s*$/, '').trim();

    if (clause === '*') {
      return [{
        kind: 'from',
        moduleSpecifier,
        relativeLevel,
        symbols: [{ name: '*', alias: null, kind: 'star' }],
        line,
      }];
    }

    const symbols = [];
    for (const entry of clause.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const aliasMatch = trimmed.match(new RegExp(`^(${IDENT})\\s+as\\s+(${IDENT})$`));
      if (aliasMatch) {
        symbols.push({ name: aliasMatch[2], alias: aliasMatch[1], kind: 'named' });
      } else if (new RegExp(`^${IDENT}$`).test(trimmed)) {
        symbols.push({ name: trimmed, alias: null, kind: 'named' });
      }
      // Anything else (syntax we don't understand) is dropped, not guessed.
    }
    if (symbols.length === 0) return [];
    return [{ kind: 'from', moduleSpecifier, relativeLevel, symbols, line }];
  }

  // ---- import X[, Y as z, ...] --------------------------------------------
  const importMatch = statement.match(/^import\s+(.+)$/);
  if (importMatch) {
    const statements = [];
    for (const entry of importMatch[1].split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const aliasMatch = trimmed.match(new RegExp(`^(${DOTTED})\\s+as\\s+(${IDENT})$`));
      const plainMatch = trimmed.match(new RegExp(`^(${DOTTED})$`));
      const modulePath = aliasMatch ? aliasMatch[1] : plainMatch ? plainMatch[1] : null;
      if (!modulePath || modulePath === '__future__') continue;
      const localName = aliasMatch
        ? aliasMatch[2]
        : modulePath.split('.')[0]; // `import a.b` binds `a`
      statements.push({
        kind: 'import',
        moduleSpecifier: modulePath,
        relativeLevel: 0,
        symbols: [{ name: localName, alias: aliasMatch ? modulePath : null, kind: 'module' }],
        line,
      });
    }
    return statements;
  }

  return [];
}
