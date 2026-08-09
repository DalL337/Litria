/**
 * jstsSymbolParser.js — Regex-based JS/TS symbol extractor.
 *
 * Parses a source file's text and returns symbols (definitions and/or exports).
 * Editor-agnostic: no Monaco or LSP dependencies.
 *
 * Exported API:
 *   parseJsTsDefinitions(text, filePath) → Definition[]
 *   parseJsTsExports(text, filePath)     → Symbol[]  (backward-compatible)
 *
 * Definition shape (new — N1):
 *   {
 *     symbolId:       string,  // "${filePath}::${name}"
 *     filePath:       string,
 *     name:           string,
 *     definitionKind: 'function' | 'class' | 'const' | 'let' | 'var' | 'type' | 'interface' | 'enum',
 *     exported:       boolean,
 *     exportKind:     'named' | 'default' | 'type' | null,
 *     language:       'typescript',
 *     line:           number,  // 1-indexed
 *     meta:           {},
 *   }
 *
 * Symbol shape (legacy — preserved for backward compatibility):
 *   {
 *     symbolId:   string,
 *     filePath:   string,
 *     name:       string,
 *     exportKind: 'named' | 'default' | 'type',
 *     language:   'typescript',
 *     line:       number,
 *     meta:       {},
 *   }
 */

// ---------------------------------------------------------------------------
// Patterns — exported definitions (inline export keyword)
// ---------------------------------------------------------------------------

const RE_EXPORT_DEFAULT_NAMED = /^export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const RE_EXPORT_DEFAULT_BARE = /^export\s+default\b/;
// `export default App;` — a bare identifier (not a function/class/expression).
// The default export IS that local binding; it must not become a phantom
// `default`-named symbol.
const RE_EXPORT_DEFAULT_IDENT = /^export\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;?\s*$/;
const RE_EXPORT_FUNCTION = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const RE_EXPORT_CLASS = /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const RE_EXPORT_VAR = /^export\s+(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const RE_EXPORT_TYPE_ALIAS = /^export\s+type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=<]/;
const RE_EXPORT_INTERFACE = /^export\s+(?:abstract\s+)?(?:interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const RE_EXPORT_NAMED_BLOCK_START = /^export\s+(?:type\s+)?\{/;
const RE_REEXPORT = /\}\s*from\s*['"`]/;

// ---------------------------------------------------------------------------
// Patterns — non-exported definitions (top-level only)
// ---------------------------------------------------------------------------

const RE_DEF_FUNCTION = /^(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const RE_DEF_CLASS = /^(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const RE_DEF_VAR = /^(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const RE_DEF_TYPE = /^type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=<]/;
const RE_DEF_INTERFACE = /^(?:abstract\s+)?(?:interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

// ---------------------------------------------------------------------------
// Brace-depth tracker (string/comment aware)
// ---------------------------------------------------------------------------

/**
 * Update brace depth for a single line, skipping content inside strings,
 * template literals, and comments.
 *
 * @param {string} line          - Raw source line.
 * @param {number} currentDepth  - Brace depth before this line.
 * @param {boolean} inBlock      - Whether we're inside a block comment.
 * @returns {{ depth: number, inComment: boolean }}
 */
function _updateBraceDepth(line, currentDepth, inBlock) {
  let depth = currentDepth;
  let inB = inBlock;
  let inStr = false;
  let strCh = '';

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';

    // Inside block comment — look for */
    if (inB) {
      if (ch === '*' && next === '/') { inB = false; i++; }
      continue;
    }

    // Inside string/template literal — look for closing quote
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === strCh) inStr = false;
      continue;
    }

    // Line comment — skip rest of line
    if (ch === '/' && next === '/') break;

    // Block comment start
    if (ch === '/' && next === '*') { inB = true; i++; continue; }

    // String/template literal start
    if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; continue; }

    // Brace tracking
    if (ch === '{') depth++;
    if (ch === '}') depth = Math.max(0, depth - 1);
  }

  return { depth, inComment: inB };
}

// ---------------------------------------------------------------------------
// Public API — parseJsTsDefinitions (N1: all definitions)
// ---------------------------------------------------------------------------

/**
 * Parse ALL top-level definitions from JS/TS source text.
 * Returns both exported and non-exported symbols.
 *
 * Two-pass approach:
 *   Pass 1 — Scan lines at brace-depth 0 for definition patterns.
 *   Pass 2 — Cross-reference `export { ... }` block entries to mark
 *            matching definitions as exported.
 *
 * @param {string} text     - Full source file content.
 * @param {string} filePath - Absolute file path (used to build symbolId).
 * @returns {Array<Definition>}
 */
export function parseJsTsDefinitions(text, filePath) {
  const lines = text.split('\n');
  const defs = [];
  const exportBlockEntries = []; // { localName, exportedName, exportKind, line }
  const defaultExportEntries = []; // { localName, line } — `export default <ident>`

  let braceDepth = 0;
  let inBlockComment = false;

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const lineNumber = i + 1; // 1-indexed

    // Record depth BEFORE processing this line (for top-level detection)
    const lineDepth = braceDepth;

    // Update brace depth through this line
    const tracked = _updateBraceDepth(raw, braceDepth, inBlockComment);
    braceDepth = tracked.depth;
    inBlockComment = tracked.inComment;

    // Skip lines inside block comments or not at module level
    if (lineDepth > 0) { i++; continue; }

    const line = raw.trimStart();

    // Skip empty, comment-only, and pure-comment lines
    if (!line || line.startsWith('//') || line.startsWith('*')) { i++; continue; }

    let m;

    // ---- Exported definitions (inline export keyword) ---------------------

    // export default function/class Name
    m = line.match(RE_EXPORT_DEFAULT_NAMED);
    if (m) {
      const defKind = /class\s/.test(line) ? 'class' : 'function';
      defs.push(_makeDef(filePath, m[1], defKind, true, 'default', lineNumber));
      i++; continue;
    }

    // export default <expr>
    if (RE_EXPORT_DEFAULT_BARE.test(line)) {
      const identM = line.match(RE_EXPORT_DEFAULT_IDENT);
      if (identM) {
        // `export default App;` — defer to Pass 2 so the existing local
        // definition for `App` is marked as the default export.
        defaultExportEntries.push({ localName: identM[1], line: lineNumber });
      } else {
        // Anonymous/expression default: `export default {...}`, `() => {}`, etc.
        defs.push(_makeDef(filePath, 'default', 'const', true, 'default', lineNumber));
      }
      i++; continue;
    }

    // export function / export async function
    m = line.match(RE_EXPORT_FUNCTION);
    if (m) {
      defs.push(_makeDef(filePath, m[1], 'function', true, 'named', lineNumber));
      i++; continue;
    }

    // export class / export abstract class
    m = line.match(RE_EXPORT_CLASS);
    if (m) {
      defs.push(_makeDef(filePath, m[1], 'class', true, 'named', lineNumber));
      i++; continue;
    }

    // export const/let/var
    m = line.match(RE_EXPORT_VAR);
    if (m) {
      defs.push(_makeDef(filePath, m[2], m[1], true, 'named', lineNumber));
      i++; continue;
    }

    // export type Name = (TS type alias) — before interface check
    m = line.match(RE_EXPORT_TYPE_ALIAS);
    if (m) {
      defs.push(_makeDef(filePath, m[1], 'type', true, 'type', lineNumber));
      i++; continue;
    }

    // export interface / enum
    m = line.match(RE_EXPORT_INTERFACE);
    if (m) {
      const defKind = /interface/.test(line) ? 'interface' : 'enum';
      defs.push(_makeDef(filePath, m[1], defKind, true, 'named', lineNumber));
      i++; continue;
    }

    // export { ... } block — collect entries for Pass 2
    if (RE_EXPORT_NAMED_BLOCK_START.test(line)) {
      const isTypeBlock = /^export\s+type\s+\{/.test(line);
      let blockLines = [raw];
      let j = i;
      while (j < lines.length && !blockLines.join('').includes('}')) {
        j++;
        if (j < lines.length) blockLines.push(lines[j]);
      }
      const block = blockLines.join(' ');

      if (!RE_REEXPORT.test(block)) {
        const inner = block.replace(/^[^{]*\{/, '').replace(/\}.*$/, '');
        _collectExportBlockNames(inner, isTypeBlock ? 'type' : 'named', lineNumber, exportBlockEntries);
      }

      // Advance brace depth through skipped lines
      for (let k = i + 1; k <= j && k < lines.length; k++) {
        const t = _updateBraceDepth(lines[k], braceDepth, inBlockComment);
        braceDepth = t.depth;
        inBlockComment = t.inComment;
      }
      i = j + 1;
      continue;
    }

    // ---- Non-exported definitions (new for N1) ---------------------------

    // function Name / async function Name
    m = line.match(RE_DEF_FUNCTION);
    if (m && !line.startsWith('export')) {
      defs.push(_makeDef(filePath, m[1], 'function', false, null, lineNumber));
      i++; continue;
    }

    // class Name / abstract class Name
    m = line.match(RE_DEF_CLASS);
    if (m && !line.startsWith('export')) {
      defs.push(_makeDef(filePath, m[1], 'class', false, null, lineNumber));
      i++; continue;
    }

    // const/let/var Name
    m = line.match(RE_DEF_VAR);
    if (m && !line.startsWith('export')) {
      defs.push(_makeDef(filePath, m[2], m[1], false, null, lineNumber));
      i++; continue;
    }

    // type Name = (TS)
    m = line.match(RE_DEF_TYPE);
    if (m && !line.startsWith('export')) {
      defs.push(_makeDef(filePath, m[1], 'type', false, null, lineNumber));
      i++; continue;
    }

    // interface / enum (TS)
    m = line.match(RE_DEF_INTERFACE);
    if (m && !line.startsWith('export')) {
      const defKind = /interface/.test(line) ? 'interface' : 'enum';
      defs.push(_makeDef(filePath, m[1], defKind, false, null, lineNumber));
      i++; continue;
    }

    i++;
  }

  // ---- Pass 2: Cross-reference export entries with definitions ------------

  // `export default <ident>`: mark the local binding as the default export
  // rather than surfacing a phantom `default`-named symbol.
  for (const entry of defaultExportEntries) {
    const def = defs.find((d) => d.name === entry.localName);
    if (def) {
      def.exported = true;
      def.exportKind = 'default';
    } else {
      defs.push(_makeDef(filePath, entry.localName, 'const', true, 'default', entry.line));
    }
  }

  for (const entry of exportBlockEntries) {
    const def = defs.find((d) => d.name === entry.localName);
    if (def && !def.exported) {
      def.exported = true;
      def.exportKind = entry.exportKind;
    } else if (!def) {
      // Export block references a name not found as a local definition.
      // This can happen with re-exports of imports or dynamically defined symbols.
      // Add as an export-only entry so it appears in the export index.
      defs.push(_makeDef(filePath, entry.exportedName, 'const', true, entry.exportKind, entry.line));
    }
  }

  // Deduplicate by symbolId (keep first occurrence)
  const seen = new Set();
  return defs.filter((d) => {
    if (seen.has(d.symbolId)) return false;
    seen.add(d.symbolId);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Public API — parseJsTsExports (backward-compatible)
// ---------------------------------------------------------------------------

/**
 * Parse all exported symbols from JS/TS source text.
 * Delegates to parseJsTsDefinitions and filters to exported only,
 * mapping to the legacy Symbol shape.
 *
 * @param {string} text     - Full source file content.
 * @param {string} filePath - Absolute file path (used to build symbolId).
 * @returns {Array<{symbolId:string, filePath:string, name:string, exportKind:string, language:string, line:number, meta:{}}>}
 */
export function parseJsTsExports(text, filePath) {
  const allDefs = parseJsTsDefinitions(text, filePath);
  return allDefs
    .filter((d) => d.exported)
    .map((d) => ({
      symbolId: d.symbolId,
      filePath: d.filePath,
      name: d.name,
      exportKind: d.exportKind,
      language: d.language,
      line: d.line,
      meta: d.meta,
    }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Definition record. */
function _makeDef(filePath, name, definitionKind, exported, exportKind, line) {
  return {
    symbolId: `${filePath}::${name}`,
    filePath,
    name,
    definitionKind,
    exported,
    exportKind,
    language: 'typescript',
    line,
    meta: {},
  };
}

/**
 * Collect local→exported name pairs from an export block's inner content.
 * Handles: Name, Name as Alias, type Name
 *
 * @param {string}   inner       - Content between { and }.
 * @param {string}   exportKind  - 'named' or 'type'.
 * @param {number}   line        - 1-indexed line of block start.
 * @param {Array}    entries     - Accumulator for { localName, exportedName, exportKind, line }.
 */
function _collectExportBlockNames(inner, exportKind, line, entries) {
  const items = inner.split(',');
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    // "Name as Alias" → localName = Name, exportedName = Alias
    const asMatch = trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/);
    if (asMatch) {
      const alias = asMatch[2];
      if (alias === 'default') continue; // re-export shape, skip
      entries.push({ localName: asMatch[1], exportedName: alias, exportKind, line });
      continue;
    }

    // Plain "Name" → localName === exportedName
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed)) {
      entries.push({ localName: trimmed, exportedName: trimmed, exportKind, line });
    }
  }
}
