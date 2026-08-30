/**
 * syntaxDomain.js — Editor-agnostic core for connection-driven code updates.
 *
 * Owns:
 *  - Symbol index (exported symbols per file)
 *  - Definition index (all symbols per file, exported + non-exported)
 *  - Port index (derived from symbol index)
 *  - Syntax edge graph: one edge per file pair, carrying multiple symbols
 *  - Import binding records
 *  - Patch plan generation for imports and exports
 *
 * Does NOT import Monaco or any editor runtime.
 *
 * Exported API:
 *   createSyntaxDomain() → { commands, selectors, onStateChange }
 *
 * See: docs/rfcs/syntax-domain-architecture.md
 *      docs/plans/node-system-design.md
 *      docs/plans/import-connections-implementation-plan.md
 */

import { parseJsTsExports, parseJsTsDefinitions } from './jstsSymbolParser.js';
import { parsePythonDefinitions, advanceTripleQuoteState } from './pythonSymbolParser.js';
import { addToExportBlock, removeFromExportBlock } from './exportBlockManager.js';

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const JSTS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);

function _isJsTs(filePath) {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return false;
  return JSTS_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

/**
 * Import-line writes are JS/TS-target-only (ADR-020 follow-up: Python edges
 * are discovered from imports that already exist in the code, and a JS-syntax
 * line must never land in a non-JS file). Every site that COMPOSES an
 * import-line patch — not just the compute commands the adapter calls —
 * consults this. The 2026-07-17 pytest1 corruption went through renameFile's
 * unguarded patchPlan and replaced line 0 of a .py file with a JS stub.
 *
 * Python import writes exist too (brief-python-wires S2) but ONLY through
 * computeResolveEdits' python path, which locates lines in authoritative
 * text at write time — python edges keep the importLine-based patchPlan
 * sites fail-closed (rename rewrite + removal semantics are S3).
 */
function _canWriteImportLine(edge) {
  return _isJsTs(edge.targetFilePath);
}

function _isPython(filePath) {
  return /\.py$/i.test(filePath); // .pyi stays out — types, not structure
}

function _escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new SyntaxDomain instance.
 *
 * @returns {{ commands: object, selectors: object, onStateChange: function }}
 */
export function createSyntaxDomain() {
  // ---- Internal state -------------------------------------------------------

  /** @type {Map<string, Array>} filePath → Definition[] (all definitions) */
  const definitionIndex = new Map();

  /** @type {Map<string, Array>} filePath → Symbol[] (exports only) */
  const symbolIndex = new Map();

  /** @type {Map<string, Array>} filePath → Port[] */
  const portIndex = new Map();

  /**
   * @type {Map<string, object>} edgeId → SyntaxEdge
   *
   * SyntaxEdge shape:
   * {
   *   edgeId: string,           // "${sourceFilePath}→${targetFilePath}"
   *   sourceFilePath: string,
   *   targetFilePath: string,
   *   relSpec: string,
   *   importLine: number|null,  // 0-indexed line of the import statement
   *   symbols: EdgeSymbol[],
   *   connectionIds: string[],  // canvas connectionIds mapped to this edge
   *   status: string,           // 'pending'|'resolved'|'broken'|'orphaned'|'drifted'|'unused'
   * }
   *
   * EdgeSymbol shape:
   * {
   *   symbolId: string,
   *   symbolName: string,
   *   exportKind: 'named'|'default'|'type',
   *   status: 'resolved'|'broken'|'orphaned'|'drifted'|'unused',
   * }
   */
  const syntaxEdges = new Map();

  /** @type {Map<string, string>} connectionId → edgeId */
  const connectionToEdge = new Map();

  /** @type {Map<string, string>} connectionId → symbolId (for backward-compat SyntaxConn shim) */

  /** @type {Map<string, object>} connectionId → ImportBinding (backward compat) */
  const bindingMap = new Map();

  /** @type {Map<string, string>} filePath → raw text */
  const fileTextCache = new Map();

  /** @type {Map<string, string>} filePath → 'ok' | 'unknown' | 'parsing' */
  const fileStatus = new Map();

  /** @type {Set<function>} */
  const listeners = new Set();

  /** @type {string|null} normalized project root — python module-spec derivation */
  let projectRootPath = null;

  // ---- Private helpers ------------------------------------------------------

  function _notify(diff) {
    for (const fn of listeners) {
      try { fn(diff); } catch (_) { /* listener errors must not break domain */ }
    }
  }

  /** Compute canonical edge key for a source→target file pair. */
  function _edgeKey(sourceFilePath, targetFilePath) {
    return `${sourceFilePath}→${targetFilePath}`;
  }

  /** Build Port[] from a Symbol[]. Each exported symbol → one 'out' port. */
  function _portsFromSymbols(symbols) {
    return symbols.map((sym) => ({
      portId: `${sym.filePath}::export::${sym.name}`,
      filePath: sym.filePath,
      symbolId: sym.symbolId,
      direction: 'out',
      kind: 'exportSymbol',
      label: sym.name,
      status: 'active',
    }));
  }

  /** Re-parse a file and update definitionIndex, symbolIndex, and portIndex. */
  function _refreshFile(filePath) {
    const text = fileTextCache.get(filePath);
    if (text == null) return;

    let definitions = [];
    let symbols = [];
    if (_isJsTs(filePath) || _isPython(filePath)) {
      fileStatus.set(filePath, 'parsing');
      try {
        definitions = _isJsTs(filePath)
          ? parseJsTsDefinitions(text, filePath)
          : parsePythonDefinitions(text, filePath);
        symbols = definitions
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
        fileStatus.set(filePath, 'ok');
      } catch (_) {
        fileStatus.set(filePath, 'unknown');
      }
    } else {
      fileStatus.set(filePath, 'unknown');
    }

    definitionIndex.set(filePath, definitions);
    symbolIndex.set(filePath, symbols);
    portIndex.set(filePath, _portsFromSymbols(symbols));
  }

  /**
   * Compute the aggregate status for an edge from its per-symbol statuses.
   * Priority: broken(4) > orphaned(3) > drifted(2) > unused(1) > resolved(0).
   */
  function _aggregateEdgeStatus(edge) {
    if (edge.symbols.length === 0) return 'pending';
    const priority = { broken: 4, orphaned: 3, drifted: 2, unused: 1, resolved: 0 };
    let worst = 'resolved';
    for (const sym of edge.symbols) {
      if ((priority[sym.status] ?? 0) > (priority[worst] ?? 0)) {
        worst = sym.status;
      }
    }
    return worst;
  }

  /**
   * After a file's content changes, check all edges involving that file
   * and transition per-symbol states.
   *
   * Source-side checks (when changedFilePath is the source):
   *   - broken:  symbol definition removed from source
   *   - drifted: symbol definition gone but case-insensitive match exists
   *   - resolved: previously broken/drifted symbol reappears
   *
   * Target-side checks (when changedFilePath is the target):
   *   - unused: symbol imported but its name is not referenced in target body
   *   - resolved: previously unused symbol is now referenced
   */
  function _reconcileEdges(changedFilePath) {
    const changedEdges = [];
    const changedConns = [];
    for (const [edgeId, edge] of syntaxEdges) {
      const isSource = edge.sourceFilePath === changedFilePath;
      const isTarget = edge.targetFilePath === changedFilePath;
      if (!isSource && !isTarget) continue;
      if (edge.status === 'pending') continue;

      let edgeChanged = false;

      // --- Source-side: broken / drifted / recovery ---
      if (isSource) {
        const definitions = definitionIndex.get(edge.sourceFilePath) ?? [];
        for (const sym of edge.symbols) {
          const prevStatus = sym.status;
          const exactMatch = definitions.some((d) => d.symbolId === sym.symbolId);

          if (exactMatch) {
            // Recovery: broken/drifted → resolved
            if (prevStatus === 'broken' || prevStatus === 'drifted') {
              sym.status = 'resolved';
              edgeChanged = true;
            }
          } else if (prevStatus === 'resolved' || prevStatus === 'drifted') {
            // Check for drift (case-insensitive or substring match)
            const drifted = _findDriftCandidate(definitions, sym.symbolName);
            sym.status = drifted ? 'drifted' : 'broken';
            if (sym.status !== prevStatus) edgeChanged = true;
          }
        }
      }

      // --- Target-side: unused / recovery ---
      if (isTarget) {
        const targetText = fileTextCache.get(edge.targetFilePath) ?? '';
        for (const sym of edge.symbols) {
          if (sym.status !== 'resolved' && sym.status !== 'unused') continue;
          const prevStatus = sym.status;
          const isUsed = _isSymbolUsedInTarget(targetText, sym.symbolName);
          if (isUsed && prevStatus === 'unused') {
            sym.status = 'resolved';
            edgeChanged = true;
          } else if (!isUsed && prevStatus === 'resolved') {
            sym.status = 'unused';
            edgeChanged = true;
          }
        }
      }

      if (edgeChanged) {
        edge.status = _aggregateEdgeStatus(edge);
        changedEdges.push(edgeId);
        changedConns.push(...edge.connectionIds);
      }
    }
    return { changedEdges, changedConns };
  }

  /**
   * Find a drift candidate: a definition whose name matches the symbol name
   * case-insensitively (e.g. renamed from `myFunc` to `MyFunc`).
   *
   * @param {object[]} definitions
   * @param {string} symbolName
   * @returns {object|null}
   */
  function _findDriftCandidate(definitions, symbolName) {
    const lower = symbolName.toLowerCase();
    return definitions.find((d) => d.name.toLowerCase() === lower && d.name !== symbolName) ?? null;
  }

  /**
   * Check whether a symbol name is referenced in target file text, excluding
   * import lines (any line starting with `import`).
   *
   * @param {string} text       - Target file content.
   * @param {string} symbolName - Symbol name to search for.
   * @returns {boolean}
   */
  function _isSymbolUsedInTarget(text, symbolName) {
    const lines = text.split('\n');
    const re = new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    for (let i = 0; i < lines.length; i++) {
      // Skip import lines — we're checking for usage, not the import itself.
      if (/^\s*import\s/.test(lines[i])) continue;
      if (re.test(lines[i])) return true;
    }
    return false;
  }

  /**
   * Count how many OTHER edges from the same source carry a given symbol.
   * Used to decide whether removing a symbol should also remove its export.
   */
  function _countOtherEdgesCarrying(sourceFilePath, symbolName, excludeEdgeId) {
    let count = 0;
    for (const [edgeId, edge] of syntaxEdges) {
      if (edgeId === excludeEdgeId) continue;
      if (edge.sourceFilePath !== sourceFilePath) continue;
      if (edge.symbols.some((s) => s.symbolName === symbolName)) count++;
    }
    return count;
  }

  /**
   * Derive a backward-compatible SyntaxConn object from edge data.
   * This shim ensures existing consumers (App.jsx, WorkspaceStage) work
   * without modification during the transition to the SyntaxEdge model.
   */
  function _deriveSyntaxConn(connectionId) {
    const edgeId = connectionToEdge.get(connectionId);
    if (!edgeId) return null;
    const edge = syntaxEdges.get(edgeId);
    if (!edge) return null;
    return {
      connectionId,
      sourceFilePath: edge.sourceFilePath,
      targetFilePath: edge.targetFilePath,
      // Mirror the EDGE's aggregate status directly. The old guard keyed on
      // a legacy per-connection resolve map (removed 2026-07-28 with the
      // stored-line commands), which only the single-symbol picker path
      // populated — every multi-/metadata-resolved wire (discovery, batch
      // picks) reported 'pending' forever, so wires rendered orange and a
      // broken edge could never surface red (owner live-verify C, 2026-07-18).
      // A symbol-less edge still reads 'pending': that is the aggregate.
      status: edge.status,
      relSpec: edge.relSpec,
      stubLine: edge.importLine,
    };
  }

  /**
   * Build a single import line from the symbols on an edge.
   *
   * Rules:
   *  - Named exports: `import { A, B } from './path';`
   *  - Default export: `import Default from './path';`
   *  - Default + named: `import Default, { A, B } from './path';`
   *  - Type-only: `import type { T1, T2 } from './path';`
   *  - Mixed named + type: `import { A, type T } from './path';` (inline type)
   */
  function _buildImportLine(symbols, relSpec, sourceFilePath) {
    if (symbols.length === 0) return '';

    const defaultSyms = symbols.filter((s) => s.exportKind === 'default');
    const typeSyms = symbols.filter((s) => s.exportKind === 'type');
    const namedSyms = symbols.filter((s) => s.exportKind !== 'default' && s.exportKind !== 'type');

    // Special case: all type-only → `import type { T } from '...'`
    if (typeSyms.length > 0 && namedSyms.length === 0 && defaultSyms.length === 0) {
      return `import type { ${typeSyms.map((s) => s.symbolName).join(', ')} } from '${relSpec}';\n`;
    }

    const parts = [];

    if (defaultSyms.length > 0) {
      const name = defaultSyms[0].symbolName === 'default'
        ? _defaultIdentifier(sourceFilePath)
        : defaultSyms[0].symbolName;
      parts.push(name);
    }

    const namedParts = [];
    for (const s of namedSyms) namedParts.push(s.symbolName);
    for (const s of typeSyms) namedParts.push(`type ${s.symbolName}`);

    if (namedParts.length > 0) {
      parts.push(`{ ${namedParts.join(', ')} }`);
    }

    if (parts.length === 0) return '';
    return `import ${parts.join(', ')} from '${relSpec}';\n`;
  }

  // ---- Relative path utility ------------------------------------------------
  // Used by patch plan generation. No Node.js `path` dep (runs in browser).

  function _computeRelativePath(fromFilePath, toFilePath) {
    const from = fromFilePath.replace(/\\/g, '/');
    const to   = toFilePath.replace(/\\/g, '/');

    const fromParts = from.split('/');
    fromParts.pop(); // strip filename — we want the dir
    const toParts   = to.split('/');

    let commonLength = 0;
    const minLen = Math.min(fromParts.length, toParts.length);
    while (commonLength < minLen && fromParts[commonLength] === toParts[commonLength]) {
      commonLength++;
    }

    const upSteps = fromParts.length - commonLength;
    const downParts = toParts.slice(commonLength);

    const relParts = [];
    for (let i = 0; i < upSteps; i++) relParts.push('..');
    relParts.push(...downParts);

    const rel = relParts.join('/');
    return rel.startsWith('.') ? rel : `./${rel}`;
  }

  // Extensions we drop from a written import specifier. Importing `./App` rather
  // than `./App.tsx` matches the common ESM/TS convention, dedups against
  // extensionless imports, and avoids TS `allowImportingTsExtensions` errors.
  const _IMPORT_EXT_RE = /\.(jsx?|tsx?|mjs|cjs)$/;

  /** Strip a known JS/TS extension from an import specifier (`./App.tsx` → `./App`). */
  function _stripImportExt(spec) {
    return spec.replace(_IMPORT_EXT_RE, '');
  }

  // ---- Import stub generation -----------------------------------------------

  /**
   * Collect the top-level import STATEMENTS in `text`, each as a line range.
   *
   * Why this exists (2026-08-30): every import helper here used to scan line by
   * line and treat "line starts with `import`" as "this line is a whole import".
   * That is false for the multi-line form, which is the norm in this codebase:
   *
   *     import {            <- only this line starts with `import`
   *       HUD_WIDGETS,
   *     } from './hudState.js';   <- the `from` clause lives HERE
   *
   * The consequences were not cosmetic. `_findImportFromSpec` never matched a
   * multi-line import (the `from` line starts with `}`), so the writer believed
   * no import existed and took the insert branch; `_findImportInsertLine`
   * returned "after `import {`", i.e. INSIDE the statement. Dragging a folder
   * onto the canvas therefore wrote a stub into the middle of an existing
   * import and left the file syntactically invalid. Found by dogfooding Litria
   * on Litria; 10 files corrupted in one drag.
   * (Journal: .research/2026-08-30-import-insertion-corruption.md)
   *
   * A statement starts on a line whose first token is `import` (but not the
   * dynamic `import(`) and continues until its module specifier string closes —
   * either `from '…'` or the side-effect form `import '…'`. Lookahead is capped
   * so a stray `import` in prose can never swallow the file.
   *
   * @param {string} text
   * @returns {Array<{ startLine: number, endLine: number, text: string }>}
   *   Line indices are 0-based and INCLUSIVE. Single-line imports have
   *   startLine === endLine.
   */
  function _collectImportStatements(text) {
    const lines = text.split('\n');
    const statements = [];
    // `import` as a statement keyword: followed by whitespace, a brace, a star,
    // or a quote. Excludes `import(` (dynamic) and identifiers like `important`.
    const startRe = /^import(?=[\s{*'"`])/;
    // A complete statement: `import … from '…'` or the bare `import '…'`.
    const doneRe = /^\s*import\b[\s\S]*?(?:from\s*['"`][^'"`]*['"`]|['"`][^'"`]*['"`])/;
    const MAX_STATEMENT_LINES = 200;

    for (let i = 0; i < lines.length; i++) {
      if (!startRe.test(lines[i].trimStart())) continue;

      let acc = lines[i];
      let end = i;
      while (!doneRe.test(acc) && end - i < MAX_STATEMENT_LINES && end + 1 < lines.length) {
        end += 1;
        acc += `\n${lines[end]}`;
      }
      // Unterminated (truncated file, or a false positive) — do not claim a
      // range we cannot prove; skip it rather than guess at a boundary.
      if (!doneRe.test(acc)) continue;

      statements.push({ startLine: i, endLine: end, text: acc });
      i = end;
    }
    return statements;
  }

  function _findImportInsertLine(text) {
    const statements = _collectImportStatements(text);
    if (statements.length === 0) return 0;
    // After the LAST line of the last statement — never inside one.
    return statements[statements.length - 1].endLine + 1;
  }

  // ---- Python import writing (brief-python-wires S2) ------------------------
  // Python edges never carry a TODO stub (there is no valid empty python
  // import) — the from-import line is composed here, from AUTHORITATIVE text
  // at write time, only when symbols resolve. Absolute module specs only
  // (owner-ratified v1); spec derivation mirrors the discovery engine's base
  // order: importer's directory → <root>/src → <root>.

  /**
   * Derive the dotted module spec for a python edge, or null when the source
   * lies outside every base (fail closed — no write).
   * @param {object} edge
   * @returns {string|null}
   */
  function _pyModuleSpecForEdge(edge) {
    const source = edge.sourceFilePath.replace(/\\/g, '/');
    const target = edge.targetFilePath.replace(/\\/g, '/');
    const targetDir = target.split('/').slice(0, -1).join('/');
    const bases = [targetDir];
    if (projectRootPath) bases.push(`${projectRootPath}/src`, projectRootPath);
    for (const base of bases) {
      if (!base || !source.startsWith(`${base}/`)) continue;
      let rel = source.slice(base.length + 1).replace(/\.py$/i, '');
      if (rel.endsWith('/__init__')) rel = rel.slice(0, -'/__init__'.length);
      if (!rel) continue;
      return rel.split('/').join('.');
    }
    return null;
  }

  /** Insert position for a fresh python import: after the last top-level
   *  import/from line, skipping module docstrings. */
  function _findPythonImportInsertLine(text) {
    const lines = text.split('\n');
    let last = -1;
    let open = null;
    for (let i = 0; i < lines.length; i++) {
      const wasInString = open != null;
      open = advanceTripleQuoteState(lines[i], open);
      if (wasInString) continue;
      if (/^import\s/.test(lines[i]) || /^from\s/.test(lines[i])) last = i;
    }
    return last + 1;
  }

  /**
   * Compute new target text carrying the edge's symbols as ONE
   * `from <module> import <names>` line: union into an existing single-line
   * from-import for the same module (idempotent — discovery re-resolving an
   * already-written import must produce no edit), else insert fresh after
   * the last import. Multi-line clauses and star imports are left untouched.
   * Updates `edge.importLine` to where the line lives.
   *
   * @returns {string} new target text (=== targetText when nothing to do)
   */
  function _writePythonImportForEdge(targetText, edge, moduleSpec) {
    const names = edge.symbols.map((s) => s.symbolName);
    if (names.length === 0) return targetText;

    const lines = targetText.split('\n');
    const fromRe = new RegExp(`^from\\s+${_escapeRegExp(moduleSpec)}\\s+import\\s+(.+?)\\s*$`);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(fromRe);
      if (!m) continue;
      // Parenthesized/continued clauses and star imports: leave the line
      // alone. A star import already covers every name; a multi-line clause
      // is not safely editable line-wise.
      if (/[(\\]/.test(m[1]) || m[1].includes('*')) {
        edge.importLine = i;
        return targetText;
      }
      const existing = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      const existingLocal = existing.map((e) => e.split(/\s+as\s+/)[0].trim());
      const merged = [...existing];
      for (const name of names) {
        if (!existingLocal.includes(name)) merged.push(name);
      }
      edge.importLine = i;
      if (merged.length === existing.length) return targetText;
      lines[i] = `from ${moduleSpec} import ${merged.join(', ')}`;
      return lines.join('\n');
    }

    const insertLine = _findPythonImportInsertLine(targetText);
    edge.importLine = insertLine;
    lines.splice(insertLine, 0, `from ${moduleSpec} import ${names.join(', ')}`);
    return lines.join('\n');
  }

  // ---- Pure text-based edit application --------------------------------------
  // These helpers compute final file text from authoritative text passed in by
  // the adapter — never from the (possibly stale) fileTextCache. This is the
  // core of the consistent write path: compute the whole file once, return it.

  /**
   * Apply line-indexed patch plans (the kind produced by exportBlockManager and
   * the import builders) to a string, returning the new string.
   *
   * Supported plan kinds (lines 0-indexed):
   *   'insert'     → insert `text` before line `insertLine`
   *   'replace'    → replace the content of line `line` with `text`
   *   'removeLine' → delete line `line`
   *
   * Plans are applied bottom-up (highest line first) so earlier edits don't
   * shift the line indices of later ones.
   *
   * `text` on insert/replace plans may carry a trailing '\n'; it's stripped so
   * we don't introduce blank lines (we operate on the array of lines, then
   * re-join with '\n').
   *
   * @param {string} text
   * @param {object[]} plans
   * @returns {string}
   */
  function _applyPlansToText(text, plans) {
    if (!plans || plans.length === 0) return text;
    const lines = text.split('\n');

    // Sort a copy bottom-to-top. For insert, use insertLine; otherwise line.
    const sorted = [...plans].sort((a, b) => {
      const la = a.kind === 'insert' ? a.insertLine : a.line;
      const lb = b.kind === 'insert' ? b.insertLine : b.line;
      return lb - la;
    });

    for (const plan of sorted) {
      switch (plan.kind) {
        case 'insert': {
          const at = Math.max(0, Math.min(plan.insertLine, lines.length));
          const insertText = plan.text.replace(/\n$/, '');
          // A plan text may itself contain multiple lines (e.g. "\nexport ...").
          lines.splice(at, 0, ...insertText.split('\n'));
          break;
        }
        // `endLine` (INCLUSIVE, optional) lets a plan address a whole multi-line
        // statement. Omitted, it collapses to the historical single-line
        // behavior. A multi-line import replaced one line at a time would keep
        // its orphaned specifier lines and its `} from '…';` tail — broken
        // source, the same class of damage this pass fixes.
        case 'replace': {
          if (plan.line >= 0 && plan.line < lines.length) {
            const end = Math.min(
              Math.max(plan.endLine ?? plan.line, plan.line),
              lines.length - 1
            );
            lines.splice(plan.line, end - plan.line + 1, ...plan.text.replace(/\n$/, '').split('\n'));
          }
          break;
        }
        case 'removeLine': {
          if (plan.line >= 0 && plan.line < lines.length) {
            const end = Math.min(
              Math.max(plan.endLine ?? plan.line, plan.line),
              lines.length - 1
            );
            lines.splice(plan.line, end - plan.line + 1);
          }
          break;
        }
        default:
          break;
      }
    }

    return lines.join('\n');
  }

  /**
   * Find an existing import line in `text` that imports from `relSpec`.
   * Matches both the TODO stub and any real `import ... from '<relSpec>'` line.
   *
   * Matching is extension-tolerant: a stored relSpec of `./App` matches an
   * existing `import ... from './App'` OR `'./App.tsx'`, so we dedup against
   * imports the user wrote with an extension. `spec` returns the path the
   * existing line actually uses, so merges preserve it (we don't rewrite the
   * user's import path).
   *
   * @param {string} text
   * @param {string} relSpec - extension-stripped module specifier
   * @returns {{ line: number, endLine: number, raw: string, spec: string } | null}
   *   `line`/`endLine` 0-indexed and INCLUSIVE; `raw` is the full existing
   *   import STATEMENT (which may span several lines); `spec` is the existing
   *   statement's module specifier (with whatever extension it had).
   */
  function _findImportFromSpec(text, relSpec) {
    const escaped = relSpec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Same module, with or without a JS/TS extension. Capture the actual spec.
    const specRe = new RegExp(`from\\s*['"\`](${escaped}(?:\\.(?:jsx?|tsx?|mjs|cjs))?)['"\`]`);
    // Statement-wise, not line-wise: a multi-line import keeps its `from`
    // clause on the closing line, which no line-level `startsWith('import')`
    // test can ever reach.
    for (const stmt of _collectImportStatements(text)) {
      const m = stmt.text.match(specRe);
      if (!m) continue;
      return { line: stmt.startLine, endLine: stmt.endLine, raw: stmt.text, spec: m[1] };
    }
    return null;
  }

  /**
   * Parse a full `import <clause> from '...'` line into its three clause parts.
   * Handles every legal form: default-only, named-only, namespace, and
   * `Default, { named }`. The TODO-comment stub yields empty named.
   *
   * CRITICAL: this captures the DEFAULT and NAMESPACE clauses, not just the
   * `{ named }` group — dropping them on rebuild silently deletes a user's
   * `import App from '...'`. (That was the bug.)
   *
   * @param {string} line
   * @returns {{ def: string|null, ns: string|null, named: string[] }}
   */
  function _parseImportClause(line) {
    const m = line.match(/^\s*import\s+([\s\S]*?)\s+from\s*['"`]/);
    if (!m) return { def: null, ns: null, named: [] };
    let clause = m[1].trim();

    // Pull out the `{ ... }` named group (strip block comments inside it).
    const named = [];
    const braceM = clause.match(/\{([\s\S]*?)\}/);
    if (braceM) {
      const inner = braceM[1].replace(/\/\*[\s\S]*?\*\//g, '');
      for (const raw of inner.split(',')) {
        const entry = raw.trim();
        if (entry) named.push(entry);
      }
      clause = (clause.slice(0, braceM.index) + clause.slice(braceM.index + braceM[0].length)).trim();
    }

    // Remaining clause holds default and/or `* as NS`, comma-separated.
    clause = clause.replace(/^,+|,+$/g, '').trim();
    let def = null;
    let ns = null;
    for (const part of clause.split(',')) {
      const p = part.trim();
      if (!p) continue;
      const nsM = p.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (nsM) ns = nsM[1];
      else def = p;
    }
    return { def, ns, named };
  }

  /**
   * The local binding name a specifier introduces: `X`→`X`, `type X`→`X`,
   * `X as Y`→`Y`. Used to dedup/remove by binding rather than source name.
   */
  function _localBindingName(specifier) {
    const s = specifier.trim();
    const asM = s.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
    if (asM) return asM[1];
    return s.replace(/^type\s+/, '').trim();
  }

  /**
   * Compose an `import ... from <q><relSpec><q>;\n` line from clause parts.
   * `quote` preserves the existing line's quote style. Returns '' when there is
   * nothing to import (caller should remove the line).
   */
  function _composeImportLine({ def, ns, named }, relSpec, quote = "'") {
    const parts = [];
    if (def) parts.push(def);
    if (ns) parts.push(`* as ${ns}`);
    if (named && named.length) parts.push(`{ ${named.join(', ')} }`);
    if (parts.length === 0) return '';
    return `import ${parts.join(', ')} from ${quote}${relSpec}${quote};\n`;
  }

  /** The quote character an existing import line uses (defaults to single). */
  function _detectQuote(line) {
    const m = line.match(/from\s*(['"`])/);
    return m ? m[1] : "'";
  }

  /** Whether two parsed import clauses are equivalent (no rewrite needed). */
  function _sameClause(a, b) {
    return (a.def || null) === (b.def || null)
      && (a.ns || null) === (b.ns || null)
      && a.named.length === b.named.length
      && a.named.every((n) => b.named.includes(n));
  }

  /** The default/namespace/named clause the edge's own symbols contribute. */
  function _edgeImportClause(edge) {
    if (edge.symbols.length === 0) return { def: null, ns: null, named: [] };
    return _parseImportClause(_buildImportLine(edge.symbols, edge.relSpec, edge.sourceFilePath));
  }

  /**
   * Compute the new full target text with the edge's import line written, and
   * update `edge.importLine` to where the import now lives.
   *
   * Behavior (add path):
   *  - Existing import from `edge.relSpec` found → UNION its full clause
   *    (default + namespace + named) with the edge's clause. Preserves a manual
   *    `import App from '...'` default and any hand-added named specifiers.
   *  - No existing import → insert a fresh import after the last import.
   *  - 0 symbols on edge and no existing import → write the TODO stub.
   *
   * @param {string} targetText  - Authoritative current target file text.
   * @param {object} edge        - The edge (mutated: edge.importLine updated).
   * @returns {string} new target text
   */
  function _writeImportForEdge(targetText, edge) {
    const existing = _findImportFromSpec(targetText, edge.relSpec);
    const edgeClause = _edgeImportClause(edge);

    if (existing) {
      const ex = _parseImportClause(existing.raw);
      const merged = {
        def: edgeClause.def || ex.def,
        ns: ex.ns || edgeClause.ns,
        named: _dedupSpecifiers([...ex.named, ...edgeClause.named]),
      };
      edge.importLine = existing.line;
      // Nothing new to add → leave the line untouched (true no-op; also avoids
      // flipping the user's quote style on an already-satisfied import).
      if (_sameClause(ex, merged)) return targetText;
      // Preserve the path AND quote style the existing line uses.
      const newLine = _composeImportLine(merged, existing.spec, _detectQuote(existing.raw));
      if (newLine === '') {
        // Nothing left to import (e.g. stub merge of an empty edge) — keep the
        // stub rather than deleting a line the user may expect to exist.
        const stub = `import { /* TODO: select symbol */ } from '${existing.spec}';\n`;
        return _applyPlansToText(targetText, [
          { kind: 'replace', filePath: edge.targetFilePath, line: existing.line, endLine: existing.endLine, text: stub },
        ]);
      }
      return _applyPlansToText(targetText, [
        { kind: 'replace', filePath: edge.targetFilePath, line: existing.line, endLine: existing.endLine, text: newLine },
      ]);
    }

    // No existing import — insert fresh after the last import.
    const edgeImportLine = edge.symbols.length === 0
      ? `import { /* TODO: select symbol */ } from '${edge.relSpec}';\n`
      : _composeImportLine(edgeClause, edge.relSpec);
    const insertLine = _findImportInsertLine(targetText);
    edge.importLine = insertLine;
    return _applyPlansToText(targetText, [
      { kind: 'insert', filePath: edge.targetFilePath, insertLine, text: edgeImportLine },
    ]);
  }

  /**
   * Compute the new target text for REMOVING a symbol from the edge's import,
   * preserving the default/namespace clause and any other named specifiers.
   * Removes the whole line only if nothing remains to import.
   *
   * @param {string} targetText
   * @param {object} edge
   * @param {string} symbolName - binding to remove from the named group
   * @returns {string} new target text
   */
  function _removeSymbolFromImport(targetText, edge, symbolName) {
    const existing = _findImportFromSpec(targetText, edge.relSpec);
    if (!existing) return targetText;
    const ex = _parseImportClause(existing.raw);
    const named = ex.named.filter((n) => _localBindingName(n) !== symbolName);
    if (_sameClause(ex, { def: ex.def, ns: ex.ns, named })) return targetText;
    const newLine = _composeImportLine({ def: ex.def, ns: ex.ns, named }, existing.spec, _detectQuote(existing.raw));
    if (newLine === '') {
      return _applyPlansToText(targetText, [
        { kind: 'removeLine', filePath: edge.targetFilePath, line: existing.line, endLine: existing.endLine },
      ]);
    }
    return _applyPlansToText(targetText, [
      { kind: 'replace', filePath: edge.targetFilePath, line: existing.line, endLine: existing.endLine, text: newLine },
    ]);
  }

  /**
   * Dedup named import specifiers by their LOCAL binding name, preserving
   * first-seen order. `X`, `type X`, and `X as Y` are compared by their
   * effective local name (`X`, `X`, `Y` respectively); a plain `X` is preferred
   * over a `type X` duplicate.
   *
   * @param {string[]} specifiers
   * @returns {string[]}
   */
  function _dedupSpecifiers(specifiers) {
    const byLocal = new Map();
    for (const raw of specifiers) {
      const spec = raw.trim();
      if (!spec) continue;
      const asMatch = spec.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      let local;
      if (asMatch) {
        local = asMatch[1];
      } else {
        local = spec.replace(/^type\s+/, '').trim();
      }
      if (!byLocal.has(local)) {
        byLocal.set(local, spec);
      } else if (/^type\s+/.test(byLocal.get(local)) && !/^type\s+/.test(spec)) {
        // Prefer the value import over a type-only duplicate.
        byLocal.set(local, spec);
      }
    }
    return [...byLocal.values()];
  }

  // ---- Commands -------------------------------------------------------------

  const commands = {
    /**
     * Record the project root. Python import composition derives absolute
     * module specs from it (importer dir → src/ → root, mirroring the
     * discovery engine's base order). Called by the syntax adapter factory,
     * which is recreated on project switch.
     *
     * @param {string|null} rootPath - Absolute project root path.
     */
    setProjectRoot(rootPath) {
      projectRootPath = typeof rootPath === 'string' && rootPath.trim()
        ? rootPath.replace(/\\/g, '/').replace(/\/$/, '')
        : null;
    },

    /**
     * Register a file and parse its exports.
     *
     * @param {string} filePath - Absolute file path.
     * @param {string} text     - Current file content.
     */
    registerFile(filePath, text) {
      fileTextCache.set(filePath, text);
      _refreshFile(filePath);
      // Reconcile edge statuses too — registration is how discovery and the
      // incremental refresh push text into the domain, and without this the
      // statuses only ever updated on live editor keystrokes (stale colors
      // after reopen/refresh; owner live-verify 2026-07-18). At first load
      // no edges exist yet, so this is a no-op there.
      const { changedEdges, changedConns } = _reconcileEdges(filePath);
      _notify({ portsChanged: [filePath], connectionsChanged: changedConns, edgesChanged: changedEdges, fileChanged: filePath });
    },

    /**
     * Unregister a file and mark dependent edges broken.
     *
     * @param {string} filePath
     */
    unregisterFile(filePath) {
      fileTextCache.delete(filePath);
      definitionIndex.delete(filePath);
      symbolIndex.delete(filePath);
      portIndex.delete(filePath);
      fileStatus.delete(filePath);

      const changedEdges = [];
      const changedConns = [];
      for (const [edgeId, edge] of syntaxEdges) {
        if (edge.sourceFilePath === filePath && edge.status !== 'broken') {
          for (const sym of edge.symbols) sym.status = 'broken';
          edge.status = 'broken';
          changedEdges.push(edgeId);
          changedConns.push(...edge.connectionIds);
        }
      }

      _notify({ portsChanged: [filePath], connectionsChanged: changedConns, edgesChanged: changedEdges, fileChanged: filePath });
    },

    /**
     * Notify the domain that a file's content has changed.
     * Re-parses definitions/exports and reconciles edge states.
     *
     * @param {string} filePath
     * @param {string} text
     * @returns {{ connectionsChanged: string[] }}
     */
    notifyFileChanged(filePath, text) {
      fileTextCache.set(filePath, text);
      _refreshFile(filePath);
      const { changedEdges, changedConns } = _reconcileEdges(filePath);
      _notify({ portsChanged: [filePath], connectionsChanged: changedConns, edgesChanged: changedEdges, fileChanged: filePath });
      return { connectionsChanged: changedConns };
    },

    /**
     * Create or reuse a semantic edge for a file pair.
     * If no edge exists, creates one with an import stub in the target file.
     * If an edge already exists, adds the connectionId to it (no stub write).
     *
     * @param {{ connectionId: string, sourceFilePath: string, targetFilePath: string }} params
     * @returns {{ patchPlan: object|null, syntaxConn: object, edgeId: string, isNewEdge: boolean } | null}
     */
    connect({ connectionId, sourceFilePath, targetFilePath }) {
      if (connectionToEdge.has(connectionId)) return null; // idempotent
      if (sourceFilePath === targetFilePath) return null;

      const edgeId = _edgeKey(sourceFilePath, targetFilePath);
      const existingEdge = syntaxEdges.get(edgeId);

      if (existingEdge) {
        // Reuse existing edge — just register this connection
        existingEdge.connectionIds.push(connectionId);
        connectionToEdge.set(connectionId, edgeId);

        const syntaxConn = _deriveSyntaxConn(connectionId);
        _notify({ portsChanged: [], connectionsChanged: [connectionId], edgesChanged: [edgeId], fileChanged: null });
        return { patchPlan: null, syntaxConn, edgeId, isNewEdge: false };
      }

      // New edge — create with import stub. Non-JS targets get edge metadata
      // only: importLine stays null so no later path (rename, disconnect,
      // detach) has a line number to clobber in a file we must not write.
      const relSpec = _stripImportExt(_computeRelativePath(targetFilePath, sourceFilePath));
      const writable = _isJsTs(targetFilePath);
      const targetText = fileTextCache.get(targetFilePath) ?? '';
      const insertLine = writable ? _findImportInsertLine(targetText) : null;

      const patchPlan = writable
        ? {
          kind: 'insert',
          filePath: targetFilePath,
          insertLine,
          text: `import { /* TODO: select symbol */ } from '${relSpec}';\n`,
        }
        : null;

      const edge = {
        edgeId,
        sourceFilePath,
        targetFilePath,
        relSpec,
        importLine: insertLine,
        symbols: [],
        connectionIds: [connectionId],
        status: 'pending',
      };

      syntaxEdges.set(edgeId, edge);
      connectionToEdge.set(connectionId, edgeId);

      const syntaxConn = _deriveSyntaxConn(connectionId);
      _notify({ portsChanged: [], connectionsChanged: [connectionId], edgesChanged: [edgeId], fileChanged: null });
      return { patchPlan, syntaxConn, edgeId, isNewEdge: true };
    },

    /**
     * Compute the final target text for writing a NEW edge's import stub,
     * from authoritative text (not the cache). Recomputes the insert position
     * and updates `edge.importLine`. Dedup-aware: if the target already imports
     * from this module, no stub is written (returns an empty edit list).
     *
     * Used by the adapter on connect so the connect-stub write goes through the
     * same consistent text path as symbol resolution.
     *
     * @param {{ edgeId: string, targetText: string }} params
     * @returns {{ edits: Array<{ filePath: string, newText: string }>, edge: object } | null}
     */
    computeConnectStubEdit({ edgeId, targetText }) {
      const edge = syntaxEdges.get(edgeId);
      if (!edge) return null;

      // Import writing is JS/TS-only (ADR-020 follow-up: Python edges are
      // discovered from imports that already exist in the code — the domain
      // must NEVER write a JS-syntax stub into a .py file). The edge itself
      // still exists as metadata; only the file edit is gated.
      if (!_isJsTs(edge.targetFilePath)) {
        return { edits: [], edge: { ...edge, symbols: [...edge.symbols] } };
      }

      // If there's already an import from this module, don't add a stub.
      const existing = _findImportFromSpec(targetText, edge.relSpec);
      if (existing) {
        edge.importLine = existing.line;
        return { edits: [], edge: { ...edge, symbols: [...edge.symbols] } };
      }

      const newTargetText = _writeImportForEdge(targetText, edge);
      const edits = newTargetText !== targetText
        ? [{ filePath: edge.targetFilePath, newText: newTargetText }]
        : [];
      return { edits, edge: { ...edge, symbols: [...edge.symbols] } };
    },

    /**
     * Compute the final text of the target + source files for resolving a set
     * of symbols onto an edge — the consistent, drift-free write path.
     *
     * Unlike addSymbolToEdge, this command:
     *  - Computes ALL edits for a batch of symbols at once (no per-symbol loop
     *    against a stale cache).
     *  - Works from the authoritative `targetText` / `sourceText` PASSED IN by
     *    the adapter (open model value OR fresh disk read), never the cache.
     *  - Is dedup-aware: if the target already imports from this module, it
     *    merges the new specifiers into the existing import line in place.
     *  - Evolves the source text symbol-by-symbol so the second export edit is
     *    computed against the result of the first (kills line drift).
     *
     * Pure: no Monaco, no async, no disk. Returns full file texts.
     *
     * @param {{ edgeId: string, symbolIds: string[], targetText: string, sourceText: string }} params
     * @returns {{ edits: Array<{ filePath: string, newText: string }>, edge: object } | null}
     */
    /**
     * Resolve symbols onto an edge as METADATA ONLY — no file edits, ever.
     *
     * Discovery uses this (2026-07-18, owner live-verify finding): its job is
     * to mirror code into wires, never to push wires back into code. The
     * write-capable path (computeResolveEdits) run by a background discovery
     * refresh could re-insert an import the user had just deleted in an open
     * editor (model ≠ disk mid-edit) — and, for JS edges, add export-block
     * entries on every project open.
     *
     * @param {{ edgeId: string, symbolIds: string[] }} params
     * @returns {{ edge: object } | null}
     */
    resolveSymbolsMetadata({ edgeId, symbolIds, brokenNames = [] }) {
      const edge = syntaxEdges.get(edgeId);
      if (!edge) return null;

      const sourceSymbols = symbolIndex.get(edge.sourceFilePath) ?? [];
      const sourceDefs = definitionIndex.get(edge.sourceFilePath) ?? [];
      const onEdge = new Set(edge.symbols.map((s) => s.symbolId));
      for (const symbolId of symbolIds ?? []) {
        if (onEdge.has(symbolId)) continue;
        let sym = sourceSymbols.find((s) => s.symbolId === symbolId);
        if (!sym) sym = sourceDefs.find((d) => d.symbolId === symbolId);
        if (!sym) continue;
        onEdge.add(symbolId);
        edge.symbols.push({
          symbolId,
          symbolName: sym.name,
          exportKind: sym.exportKind ?? 'named',
          status: 'resolved',
        });
      }
      // Imported names with NO matching definition (discovery found the
      // import but the symbol doesn't exist — e.g. project reopened after
      // the def was deleted) register as BROKEN, so a dead import is red
      // from the first load, not stuck pending/orange (owner live-verify,
      // 2026-07-18). The fabricated symbolId matches the parsers'
      // `${filePath}::${name}` convention, so retyping the definition
      // recovers through the normal reconcile path.
      for (const name of brokenNames ?? []) {
        const symbolId = `${edge.sourceFilePath}::${name}`;
        if (onEdge.has(symbolId)) continue;
        onEdge.add(symbolId);
        edge.symbols.push({
          symbolId,
          symbolName: name,
          exportKind: 'named',
          status: 'broken',
        });
      }
      edge.status = _aggregateEdgeStatus(edge);

      _notify({ portsChanged: [], connectionsChanged: [...edge.connectionIds], edgesChanged: [edgeId], fileChanged: null });
      return { edge: { ...edge, symbols: [...edge.symbols] } };
    },

    computeResolveEdits({ edgeId, symbolIds, targetText, sourceText }) {
      const edge = syntaxEdges.get(edgeId);
      if (!edge) return null;
      if (!symbolIds?.length) return { edits: [], edge: { ...edge, symbols: [...edge.symbols] } };

      const sourceSymbols = symbolIndex.get(edge.sourceFilePath) ?? [];
      const sourceDefs = definitionIndex.get(edge.sourceFilePath) ?? [];

      // Filter to symbols not already on the edge, resolving each to its info.
      const onEdge = new Set(edge.symbols.map((s) => s.symbolId));
      const newlyAdded = [];
      for (const symbolId of symbolIds) {
        if (onEdge.has(symbolId)) continue;
        let sym = sourceSymbols.find((s) => s.symbolId === symbolId);
        if (!sym) sym = sourceDefs.find((d) => d.symbolId === symbolId);
        if (!sym) continue;
        onEdge.add(symbolId); // guard against duplicate symbolIds in the input
        const edgeSym = {
          symbolId,
          symbolName: sym.name,
          exportKind: sym.exportKind ?? 'named',
          status: 'resolved',
        };
        edge.symbols.push(edgeSym);
        newlyAdded.push(edgeSym);
      }

      edge.status = _aggregateEdgeStatus(edge);

      const edits = [];

      // --- Python target: single from-import line, no export block (python
      //     has none — the source file is never touched). Spec derivation can
      //     fail (source outside importer-dir/src/root bases) → fail closed
      //     with no write; the edge still carries the resolved symbols. ---
      if (_isPython(edge.targetFilePath)) {
        const moduleSpec = _pyModuleSpecForEdge(edge);
        if (moduleSpec) {
          const newTargetText = _writePythonImportForEdge(targetText, edge, moduleSpec);
          if (newTargetText !== targetText) {
            edits.push({ filePath: edge.targetFilePath, newText: newTargetText });
          }
        }
        _notify({ portsChanged: [], connectionsChanged: [...edge.connectionIds], edgesChanged: [edgeId], fileChanged: null });
        return { edits, edge: { ...edge, symbols: [...edge.symbols] } };
      }

      // --- Target import text (dedup-aware) ---
      const newTargetText = _writeImportForEdge(targetText, edge);
      if (newTargetText !== targetText) {
        edits.push({ filePath: edge.targetFilePath, newText: newTargetText });
      }

      // --- Source export text (evolving copy → no drift) ---
      // Default-exported symbols are already exported (`export default ...`);
      // they must NOT get a managed `export { name }` entry (that would
      // double-export and, for `export default App`, emit invalid syntax).
      let evolvingSource = sourceText;
      for (const sym of newlyAdded) {
        if (sym.exportKind === 'default') continue;
        const plans = addToExportBlock(evolvingSource, edge.sourceFilePath, sym.symbolName);
        evolvingSource = _applyPlansToText(evolvingSource, plans);
      }
      if (evolvingSource !== sourceText) {
        edits.push({ filePath: edge.sourceFilePath, newText: evolvingSource });
      }

      _notify({ portsChanged: [], connectionsChanged: [...edge.connectionIds], edgesChanged: [edgeId], fileChanged: null });
      return { edits, edge: { ...edge, symbols: [...edge.symbols] } };
    },

    /**
     * Compute the final text for removing a single symbol from an edge — the
     * consistent text-based counterpart to removeSymbolFromEdge.
     *
     * @param {{ edgeId: string, symbolName: string, targetText: string, sourceText: string, removeExport?: boolean }} params
     * @returns {{ edits: Array<{ filePath: string, newText: string }>, edge: object } | null}
     */
    computeRemoveEdits({ edgeId, symbolName, targetText, sourceText, removeExport = true }) {
      const edge = syntaxEdges.get(edgeId);
      if (!edge) return null;

      const symIdx = edge.symbols.findIndex((s) => s.symbolName === symbolName);
      if (symIdx === -1) return null;

      // Python removal semantics are S3 (owner design note pending,
      // brief-python-wires) — fail closed WITHOUT mutating the edge, so the
      // symbol chip stays honest about what the import line still says.
      if (_isPython(edge.targetFilePath)) {
        return { edits: [], edge: { ...edge, symbols: [...edge.symbols] } };
      }

      edge.symbols.splice(symIdx, 1);
      edge.status = edge.symbols.length === 0 ? 'pending' : _aggregateEdgeStatus(edge);

      const edits = [];

      // --- Target import text: drop just this symbol, preserving the default/
      //     namespace clause and any other named specifiers on the line. ---
      const newTargetText = _removeSymbolFromImport(targetText, edge, symbolName);
      if (newTargetText !== targetText) {
        edits.push({ filePath: edge.targetFilePath, newText: newTargetText });
      }

      // --- Source export text: remove from the managed block if no other edge
      //     carries this symbol ---
      if (removeExport) {
        const otherCount = _countOtherEdgesCarrying(edge.sourceFilePath, symbolName, edgeId);
        if (otherCount === 0) {
          const plans = removeFromExportBlock(sourceText, edge.sourceFilePath, symbolName);
          const newSourceText = _applyPlansToText(sourceText, plans);
          if (newSourceText !== sourceText) {
            edits.push({ filePath: edge.sourceFilePath, newText: newSourceText });
          }
        }
      }

      _notify({ portsChanged: [], connectionsChanged: [...edge.connectionIds], edgesChanged: [edgeId], fileChanged: null });
      return { edits, edge: { ...edge, symbols: [...edge.symbols] } };
    },

    /**
     * Remove a semantic connection from its edge.
     * If this was the last connection on the edge, the edge is fully removed
     * and optionally the import line is deleted.
     *
     * @param {string} connectionId
     * @param {object} [opts]
     * @param {boolean} [opts.removeImport=true]
     * @returns {{ patchPlan: object | null }}
     */
    disconnectConnection(connectionId, { removeImport = true } = {}) {
      const edgeId = connectionToEdge.get(connectionId);
      if (!edgeId) return { patchPlan: null };

      const edge = syntaxEdges.get(edgeId);
      if (!edge) return { patchPlan: null };

      // Remove this connection from the edge
      edge.connectionIds = edge.connectionIds.filter((id) => id !== connectionId);
      connectionToEdge.delete(connectionId);
      bindingMap.delete(connectionId);

      // If no more connections reference this edge, remove it
      if (edge.connectionIds.length === 0) {
        let patchPlan = null;
        if (removeImport && _canWriteImportLine(edge) && edge.importLine != null && edge.status !== 'broken') {
          patchPlan = {
            kind: 'removeLine',
            filePath: edge.targetFilePath,
            line: edge.importLine,
          };
        }
        syntaxEdges.delete(edgeId);
        _notify({ portsChanged: [], connectionsChanged: [connectionId], edgesChanged: [edgeId], fileChanged: null });
        return { patchPlan };
      }

      // Edge still has other connections — don't touch code
      _notify({ portsChanged: [], connectionsChanged: [connectionId], edgesChanged: [edgeId], fileChanged: null });
      return { patchPlan: null };
    },

    /**
     * Compute the final target text for disconnecting a connection — the
     * consistent text-based counterpart to disconnectConnection.
     *
     * NO LIVE CALLER since edge deletion became state-only for every
     * language (owner decision 2026-07-17, brief-python-wires S3): the
     * adapter's handleDisconnect no longer removes import lines. Kept as a
     * tested pure command in case a future "delete wire AND its import"
     * affordance wants it back.
     *
     * Read-only with respect to domain state: it does NOT remove the connection
     * or edge (the caller still invokes disconnectConnection for that). It only
     * inspects the edge to compute the file edit, locating the import line in
     * the AUTHORITATIVE target text (not via the possibly-stale edge.importLine).
     *
     * Only produces an edit when this is the last connection on the edge and
     * removeImport is set and the edge isn't broken — matching
     * disconnectConnection's removal rule.
     *
     * @param {{ connectionId: string, targetText: string, removeImport?: boolean }} params
     * @returns {{ edits: Array<{ filePath: string, newText: string }> }}
     */
    computeDisconnectEdit({ connectionId, targetText, removeImport = true }) {
      const edgeId = connectionToEdge.get(connectionId);
      if (!edgeId) return { edits: [] };
      const edge = syntaxEdges.get(edgeId);
      if (!edge) return { edits: [] };

      // Only the last connection on the edge triggers an import removal.
      const isLast = edge.connectionIds.filter((id) => id !== connectionId).length === 0;
      if (!isLast || !removeImport || edge.status === 'broken') return { edits: [] };

      // Import removal is JS/TS-only — same guard as computeConnectStubEdit.
      // (_findImportFromSpec would never match Python syntax anyway; this
      // makes the invariant explicit instead of incidental.)
      if (!_isJsTs(edge.targetFilePath)) return { edits: [] };

      const existing = _findImportFromSpec(targetText, edge.relSpec);
      if (!existing) return { edits: [] };

      const newTargetText = _applyPlansToText(targetText, [
        { kind: 'removeLine', filePath: edge.targetFilePath, line: existing.line, endLine: existing.endLine },
      ]);
      if (newTargetText === targetText) return { edits: [] };
      return { edits: [{ filePath: edge.targetFilePath, newText: newTargetText }] };
    },

    /**
     * Locate the line of an existing JS/TS import from `spec` in the given
     * authoritative text. Pure text query — no domain state read or written.
     *
     * Rename patch plans carry the pre-rename spec as `matchSpec`; the
     * adapter uses this to find where the import ACTUALLY lives at apply
     * time instead of trusting the stored edge.importLine, which goes stale
     * as soon as the user adds or removes lines above the import (the JS
     * twin of the 2026-07-17 python line-0 corruption).
     *
     * @param {{ text: string, spec: string }} params
     * @returns {number|null} 0-indexed line, or null when no import matches
     */
    computeImportLineForSpec({ text, spec }) {
      if (typeof text !== 'string' || !spec) return null;
      return _findImportFromSpec(text, spec)?.line ?? null;
    },

    /**
     * Detach an edge visually — remove from internal state without
     * touching the code. The import and export lines stay in the files.
     *
     * @param {string} edgeId
     * @returns {{ success: boolean }}
     */
    detachEdge(edgeId) {
      const edge = syntaxEdges.get(edgeId);
      if (!edge) return { success: false };

      const affectedConns = [...edge.connectionIds];
      for (const connId of affectedConns) {
        connectionToEdge.delete(connId);
        bindingMap.delete(connId);
      }
      syntaxEdges.delete(edgeId);
      _notify({ portsChanged: [], connectionsChanged: affectedConns, edgesChanged: [edgeId], fileChanged: null });
      return { success: true };
    },

    /**
     * Handle a file rename or move.
     * Updates all internal indexes and generates patch plans to fix import
     * paths in any affected edges.
     *
     * @param {string} oldPath
     * @param {string} newPath
     * @returns {{ patchPlans: object[] }}
     */
    renameFile(oldPath, newPath) {
      if (oldPath === newPath) return { patchPlans: [] };

      // Move file-level state to new path
      const text = fileTextCache.get(oldPath);
      const status = fileStatus.get(oldPath);
      fileTextCache.delete(oldPath);
      definitionIndex.delete(oldPath);
      symbolIndex.delete(oldPath);
      portIndex.delete(oldPath);
      fileStatus.delete(oldPath);

      if (text != null) {
        fileTextCache.set(newPath, text);
        fileStatus.set(newPath, status ?? 'unknown');
        _refreshFile(newPath);
      }

      // Update edges that reference the old path
      const patchPlans = [];
      const changedEdgeIds = [];
      const changedConnIds = [];
      const edgesToRename = [];

      for (const [edgeId, edge] of syntaxEdges) {
        if (edge.sourceFilePath !== oldPath && edge.targetFilePath !== oldPath) continue;
        edgesToRename.push([edgeId, edge]);
      }

      for (const [oldEdgeId, edge] of edgesToRename) {
        syntaxEdges.delete(oldEdgeId);

        if (edge.sourceFilePath === oldPath) edge.sourceFilePath = newPath;
        if (edge.targetFilePath === oldPath) edge.targetFilePath = newPath;

        // The import sitting in the target file still says the OLD spec —
        // carried on the plans below as `matchSpec` so the adapter can locate
        // the real line at apply time (edge.importLine is a stale-prone hint;
        // see _applyRenamePlans in syntaxAdapter.js).
        const priorRelSpec = edge.relSpec;
        edge.relSpec = _stripImportExt(_computeRelativePath(edge.targetFilePath, edge.sourceFilePath));
        edge.edgeId = _edgeKey(edge.sourceFilePath, edge.targetFilePath);

        // Update import line — JS/TS targets with a known line only. This is
        // the path that corrupted a Python file (2026-07-17): a pending py→py
        // edge held importLine 0 (the JS insert heuristic doesn't read Python),
        // and the rename replaced line 0 — the file's real first import — with
        // the JS stub.
        if (_canWriteImportLine(edge) && edge.importLine != null) {
          if (edge.symbols.length > 0) {
            const importText = _buildImportLine(edge.symbols, edge.relSpec, edge.sourceFilePath);
            patchPlans.push({
              kind: 'replace',
              filePath: edge.targetFilePath,
              line: edge.importLine,
              matchSpec: priorRelSpec,
              text: importText,
            });
          } else if (edge.status === 'pending') {
            patchPlans.push({
              kind: 'replace',
              filePath: edge.targetFilePath,
              line: edge.importLine,
              matchSpec: priorRelSpec,
              text: `import { /* TODO: select symbol */ } from '${edge.relSpec}';\n`,
            });
          }
        }

        syntaxEdges.set(edge.edgeId, edge);

        // Update connectionToEdge mappings
        for (const connId of edge.connectionIds) {
          connectionToEdge.set(connId, edge.edgeId);
        }

        changedEdgeIds.push(edge.edgeId);
        changedConnIds.push(...edge.connectionIds);
      }

      // Update bindings for backward compat
      for (const [connId, binding] of bindingMap) {
        const eId = connectionToEdge.get(connId);
        const edge = eId ? syntaxEdges.get(eId) : null;
        if (edge) {
          const importText = edge.symbols.length > 0
            ? _buildImportLine(edge.symbols, edge.relSpec, edge.sourceFilePath)
            : '';
          bindingMap.set(connId, {
            ...binding,
            targetFilePath: edge.targetFilePath,
            moduleSpecifier: edge.relSpec,
            importClause: importText.trim(),
          });
        }
      }

      _notify({ portsChanged: [oldPath, newPath], connectionsChanged: changedConnIds, edgesChanged: changedEdgeIds, fileChanged: newPath });
      return { patchPlans };
    },
  };

  // ---- Selectors ------------------------------------------------------------

  const selectors = {
    // -- Port and symbol selectors (unchanged) --

    getPortsForFile(filePath) {
      return portIndex.get(filePath) ?? [];
    },

    getExportCandidates(filePath) {
      return symbolIndex.get(filePath) ?? [];
    },

    getDefinitionsForFile(filePath) {
      return definitionIndex.get(filePath) ?? [];
    },

    /**
     * Whether this file's language has symbol support (definitions/exports
     * parsing) in the domain. Lets UI layers distinguish "no symbols LEFT to
     * import" (JS edge fully resolved) from "no symbols POSSIBLE" (e.g. a
     * Python or Markdown source — ADR-020 follow-up: python wires exist but
     * the symbol layer doesn't yet).
     */
    supportsSymbols(filePath) {
      return _isJsTs(filePath) || _isPython(filePath);
    },

    getFileStatus(filePath) {
      return fileStatus.get(filePath);
    },

    getImportBinding(connectionId) {
      return bindingMap.get(connectionId) ?? null;
    },

    // -- Backward-compat connection selectors --

    /** Backward-compat shim: derives a SyntaxConn view from the edge model. */
    getSyntaxConnection(connectionId) {
      return _deriveSyntaxConn(connectionId);
    },

    getSyntaxConnectionsByFile(filePath) {
      const result = [];
      for (const [connId, edgeId] of connectionToEdge) {
        const edge = syntaxEdges.get(edgeId);
        if (edge && (edge.sourceFilePath === filePath || edge.targetFilePath === filePath)) {
          const conn = _deriveSyntaxConn(connId);
          if (conn) result.push(conn);
        }
      }
      return result;
    },

    getAllSyntaxConnections() {
      const result = [];
      for (const connId of connectionToEdge.keys()) {
        const conn = _deriveSyntaxConn(connId);
        if (conn) result.push(conn);
      }
      return result;
    },

    // -- New edge-level selectors --

    /** Get a SyntaxEdge by its edge ID. */
    getSyntaxEdge(edgeId) {
      const edge = syntaxEdges.get(edgeId);
      return edge ? { ...edge, symbols: [...edge.symbols] } : null;
    },

    /** Get the edge for a source→target file pair, if one exists. */
    getSyntaxEdgeForPair(sourceFilePath, targetFilePath) {
      const edgeId = _edgeKey(sourceFilePath, targetFilePath);
      return selectors.getSyntaxEdge(edgeId);
    },

    /** Get all edges involving a file (as source or target). */
    getEdgesForFile(filePath) {
      const result = [];
      for (const edge of syntaxEdges.values()) {
        if (edge.sourceFilePath === filePath || edge.targetFilePath === filePath) {
          result.push({ ...edge, symbols: [...edge.symbols] });
        }
      }
      return result;
    },

    /** Get all edges. */
    getAllSyntaxEdges() {
      return [...syntaxEdges.values()].map((e) => ({ ...e, symbols: [...e.symbols] }));
    },

    /** Get resolved symbols on an edge. */
    getSymbolsOnEdge(edgeId) {
      const edge = syntaxEdges.get(edgeId);
      return edge ? [...edge.symbols] : [];
    },

    /**
     * Get definitions from the source file that are NOT already on the edge.
     * This is the data source for the enhanced symbol picker.
     */
    getAvailableSymbolsForEdge(sourceFilePath, edgeId) {
      const definitions = definitionIndex.get(sourceFilePath) ?? [];
      const edge = syntaxEdges.get(edgeId);
      if (!edge) return definitions;

      const onEdge = new Set(edge.symbols.map((s) => s.symbolId));
      return definitions.filter((d) => !onEdge.has(d.symbolId));
    },

    /** Get the edge ID for a canvas connection ID. */
    getEdgeIdForConnection(connectionId) {
      return connectionToEdge.get(connectionId) ?? null;
    },
  };

  // ---- Event subscription ---------------------------------------------------

  /**
   * Subscribe to domain state changes.
   *
   * @param {function} handler - Called with { portsChanged, connectionsChanged, edgesChanged, fileChanged }.
   * @returns {function} Unsubscribe function.
   */
  function onStateChange(handler) {
    listeners.add(handler);
    return () => listeners.delete(handler);
  }

  return { commands, selectors, onStateChange };
}

// ---------------------------------------------------------------------------
// Internal utility
// ---------------------------------------------------------------------------

/** Derive a reasonable local identifier name for a default import from a file path. */
function _defaultIdentifier(filePath) {
  const base = filePath.split('/').pop() ?? 'module';
  const withoutExt = base.replace(/\.[^.]+$/, '');
  return withoutExt.replace(/[-_](.)/g, (_, c) => c.toUpperCase());
}
