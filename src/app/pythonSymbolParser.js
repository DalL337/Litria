/**
 * pythonSymbolParser.js — Line-based Python symbol extractor.
 *
 * Parses a module's text and returns top-level definitions in the SAME
 * Definition shape jstsSymbolParser produces, so the syntax domain's
 * indexes and the symbol picker consume both languages identically.
 *
 * Exported API:
 *   parsePythonDefinitions(text, filePath) → Definition[]
 *
 * Definition shape (mirrors jstsSymbolParser):
 *   {
 *     symbolId:       string,  // "${filePath}::${name}"
 *     filePath:       string,
 *     name:           string,
 *     definitionKind: 'function' | 'class' | 'variable',
 *     exported:       boolean,  // "public" in python terms — see below
 *     exportKind:     'named' | null,
 *     language:       'python',
 *     line:           number,  // 1-indexed
 *     meta:           {},
 *   }
 *
 * Python has no export keyword; "exported" here means PUBLIC by convention:
 *   - When a literal single-line `__all__ = [...]` is declared, it defines
 *     the public set exactly.
 *   - Otherwise every top-level name not starting with `_` is public.
 * All top-level definitions (public or not) are returned — the picker's
 * existing "exports first, all definitions available" behavior relies on
 * the exported flag, not on filtering here.
 *
 * Deliberate limitations (line-based, like the JS parser):
 *   - Only column-0 statements count — nested defs are not module symbols.
 *   - Multi-line `__all__` declarations are not parsed (single-line only).
 *   - Conditional/try-guarded definitions at column 0 still count.
 */

const RE_DEF = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const RE_CLASS = /^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(\s]/;
// Simple or annotated assignment: `NAME = …` / `NAME: T = …`.
// `(?![=])` rejects `==`; an augmented op (`+=` etc.) never matches because
// the operator character sits where the `:` or `=` is required.
const RE_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=(?!=)/;
const RE_ALL = /^__all__\s*(?::[^=]+)?=\s*[[(]([^\])]*)[\])]/;
const RE_ALL_NAME = /['"]([^'"]+)['"]/g;

/** Dunder names (`__x__`) that are metadata, not importable API surface. */
const EXCLUDED_NAMES = new Set(['__all__']);

/**
 * Advance the module-level string state across one line.
 * Tracks triple-quoted strings only — that is what hides column-0 text
 * (module docstrings, top-level string blocks). Single-quoted strings
 * cannot span lines in python without continuations we don't chase.
 *
 * @param {string} line
 * @param {string|null} openDelimiter - "'''" | '"""' | null
 * @returns {string|null} the delimiter still open after this line
 */
export function advanceTripleQuoteState(line, openDelimiter) {
  let open = openDelimiter;
  let i = 0;
  while (i < line.length) {
    const three = line.slice(i, i + 3);
    if (open) {
      if (three === open) {
        open = null;
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }
    if (three === "'''" || three === '"""') {
      open = three;
      i += 3;
      continue;
    }
    // Outside a triple-quote, a `#` comment hides the rest of the line.
    if (line[i] === '#') break;
    i += 1;
  }
  return open;
}

/**
 * Parse a python module's top-level definitions.
 *
 * @param {string} text
 * @param {string} filePath
 * @returns {Array<object>} Definition[]
 */
export function parsePythonDefinitions(text, filePath) {
  const lines = String(text ?? '').split('\n');
  const found = []; // { name, definitionKind, line }
  const seen = new Set();
  let allNames = null; // string[] when a literal __all__ is declared
  let openString = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInString = openString != null;
    openString = advanceTripleQuoteState(line, openString);
    if (wasInString) continue; // line STARTS inside a docstring/string block

    const allMatch = line.match(RE_ALL);
    if (allMatch) {
      allNames = [];
      let m;
      while ((m = RE_ALL_NAME.exec(allMatch[1])) !== null) {
        allNames.push(m[1]);
      }
      continue;
    }

    const def = line.match(RE_DEF) ?? line.match(RE_CLASS);
    const kind = def
      ? (RE_DEF.test(line) ? 'function' : 'class')
      : null;
    const assign = def ? null : line.match(RE_ASSIGN);

    const name = def?.[1] ?? assign?.[1] ?? null;
    if (!name || EXCLUDED_NAMES.has(name) || seen.has(name)) continue;
    seen.add(name);
    found.push({
      name,
      definitionKind: kind ?? 'variable',
      line: i + 1,
    });
  }

  return found.map((d) => {
    const isPublic = allNames != null
      ? allNames.includes(d.name)
      : !d.name.startsWith('_');
    return {
      symbolId: `${filePath}::${d.name}`,
      filePath,
      name: d.name,
      definitionKind: d.definitionKind,
      exported: isPublic,
      exportKind: isPublic ? 'named' : null,
      language: 'python',
      line: d.line,
      meta: {},
    };
  });
}
