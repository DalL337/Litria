/**
 * discoveryEngine.js — Discover edges from existing imports/exports.
 *
 * Pure function, no React or Monaco dependencies.
 * Reads project source files, parses their imports (per-language dispatch:
 * JS/TS and Python), resolves specifiers to project files, and returns
 * discovered edges. Anything that doesn't resolve to a file INSIDE the
 * project (stdlib, node_modules, venv packages) draws no edge — external
 * dependencies are not wires.
 *
 * @module discoveryEngine
 */

import { parseJsTsImports } from './jstsImportParser.js';
import { parsePythonImports } from './pythonImportParser.js';

/**
 * @typedef {object} DiscoveredEdge
 * @property {string} sourceFilePath  - Absolute path of the imported module.
 * @property {string} targetFilePath  - Absolute path of the importing file.
 * @property {string} moduleSpecifier - Original relative specifier from code.
 * @property {number} importLine      - 0-indexed line of the import.
 * @property {Array<{name: string, kind: string}>} symbols - Imported bindings.
 */

/** JS/TS file extensions to try when resolving specifiers. */
const EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs'];

/**
 * Discover project edges from existing import statements.
 *
 * @param {object} params
 * @param {string} params.projectRoot  - Absolute path to project root.
 * @param {string[]} params.filePaths  - List of absolute file paths in the project.
 * @param {(path: string) => string|null} params.readFile - Sync file reader (returns text or null).
 * @returns {{ edges: DiscoveredEdge[], errors: string[] }}
 */
export function discoverProjectEdges({ projectRoot, filePaths, readFile }) {
  const edges = [];
  const errors = [];

  // Build a set of known file paths for resolution
  const knownFiles = new Set(filePaths.map((f) => _normalizePath(f)));

  // Python source roots, computed once: absolute imports resolve against the
  // project root AND `src/` when a src layout is present (the ADR-020 Library
  // archetype and the wider ecosystem norm).
  const normRoot = _normalizePath(projectRoot ?? '').replace(/\/$/, '');
  const pySourceRoots = _pythonSourceRoots(normRoot, knownFiles);

  for (const filePath of filePaths) {
    const text = readFile(filePath);
    if (text == null) {
      errors.push(`Could not read file: ${filePath}`);
      continue;
    }

    if (/\.py$/.test(filePath)) {
      try {
        _discoverPythonEdges({ filePath, text, knownFiles, pySourceRoots, edges });
      } catch (e) {
        errors.push(`Parse error in ${filePath}: ${e.message}`);
      }
      continue;
    }

    let imports;
    try {
      imports = parseJsTsImports(text, filePath);
    } catch (e) {
      errors.push(`Parse error in ${filePath}: ${e.message}`);
      continue;
    }

    for (const imp of imports) {
      if (imp.isSideEffect) continue;

      const resolved = _resolveSpecifier(filePath, imp.moduleSpecifier, knownFiles);
      if (!resolved) continue; // Unresolvable — skip silently

      edges.push({
        sourceFilePath: resolved,
        targetFilePath: _normalizePath(filePath),
        moduleSpecifier: imp.moduleSpecifier,
        importLine: imp.line,
        symbols: imp.symbols.map((s) => ({ name: s.name, kind: s.kind })),
      });
    }
  }

  return { edges, errors };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a file path to forward slashes.
 * @param {string} p
 * @returns {string}
 */
function _normalizePath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Resolve a relative import specifier to an absolute file path.
 * Tries the specifier as-is first, then with known extensions, then as
 * a directory with an index file.
 *
 * @param {string} importerPath    - Absolute path of the importing file.
 * @param {string} specifier       - Relative module specifier (e.g. './utils').
 * @param {Set<string>} knownFiles - Set of all known absolute file paths.
 * @returns {string|null} Resolved absolute path or null.
 */
function _resolveSpecifier(importerPath, specifier, knownFiles) {
  const importerDir = _normalizePath(importerPath).split('/').slice(0, -1).join('/');
  const resolved = _joinPaths(importerDir, specifier);

  // Try exact path
  if (knownFiles.has(resolved)) return resolved;

  // Try with extensions
  for (const ext of EXTENSIONS) {
    const candidate = resolved + ext;
    if (knownFiles.has(candidate)) return candidate;
  }

  // Try as directory with index file
  for (const ext of EXTENSIONS) {
    const candidate = resolved + '/index' + ext;
    if (knownFiles.has(candidate)) return candidate;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Python discovery (ADR-020 follow-up: wiring parity)
// ---------------------------------------------------------------------------

/**
 * Roots that Python ABSOLUTE imports resolve against: `src/` first when a
 * src layout exists (more specific), then the project root.
 * @param {string} normRoot   - Normalized project root (no trailing slash).
 * @param {Set<string>} knownFiles
 * @returns {string[]}
 */
function _pythonSourceRoots(normRoot, knownFiles) {
  if (!normRoot) return [];
  const srcPrefix = `${normRoot}/src/`;
  for (const file of knownFiles) {
    if (file.startsWith(srcPrefix)) return [`${normRoot}/src`, normRoot];
  }
  return [normRoot];
}

/**
 * Resolve a dotted module path against a base directory:
 * `a.b.c` → `<base>/a/b/c.py`, else `<base>/a/b/c/__init__.py`.
 * Empty dotted path → the base package's own `__init__.py`.
 * @returns {string|null}
 */
function _resolvePyDotted(base, dotted, knownFiles) {
  if (!base) return null;
  if (!dotted) {
    const init = `${base}/__init__.py`;
    return knownFiles.has(init) ? init : null;
  }
  const asPath = dotted.split('.').join('/');
  const fileCandidate = `${base}/${asPath}.py`;
  if (knownFiles.has(fileCandidate)) return fileCandidate;
  const pkgCandidate = `${base}/${asPath}/__init__.py`;
  if (knownFiles.has(pkgCandidate)) return pkgCandidate;
  return null;
}

/** First base that resolves the dotted path wins. @returns {string|null} */
function _resolvePyAgainstBases(bases, dotted, knownFiles) {
  for (const base of bases) {
    const resolved = _resolvePyDotted(base, dotted, knownFiles);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Bases for a file's ABSOLUTE imports: the importer's own directory first
 * (script semantics — `python main/main.py` puts main/ on sys.path, so
 * `from tool import shout` beside the script is legal), then the project
 * source roots. Without the importer-dir base, sibling imports in any
 * script-style layout silently resolved to nothing (pytest1, 2026-07-17).
 * @returns {string[]}
 */
function _pyAbsoluteBases(importerPath, pySourceRoots) {
  const dir = _normalizePath(importerPath).split('/').slice(0, -1).join('/');
  if (!dir) return [...pySourceRoots];
  return [dir, ...pySourceRoots.filter((base) => base !== dir)];
}

/**
 * The base directory a RELATIVE import resolves against: one leading dot is
 * the importer's own package dir, each further dot ascends one level.
 * @returns {string|null} null when the dots climb past the filesystem root.
 */
function _pyRelativeBase(importerPath, relativeLevel) {
  const parts = _normalizePath(importerPath).split('/');
  parts.pop(); // drop the filename → importer's dir
  for (let ascent = 1; ascent < relativeLevel; ascent++) {
    if (parts.length === 0) return null;
    parts.pop();
  }
  if (parts.length === 0) return null;
  const joined = parts.join('/');
  return joined || null;
}

/**
 * Discover edges from one Python file's imports. Pushes onto `edges`
 * (DiscoveredEdge shape, identical to the JS path).
 *
 * Resolution semantics (project-scope only — never stdlib/venv):
 *  - `import a.b.c`            → a/b/c.py or a/b/c/__init__.py under a root
 *  - `from a.b import X, Y`    → per name, X as SUBMODULE (a/b/X.py) gets its
 *    own edge; remaining names group as symbols on the edge to a.b's file
 *  - `from . import x` / `from ..pkg import y` → same, based at the
 *    importer's package position
 *  - `from mod import *`       → edge to mod's file, no symbol list
 */
function _discoverPythonEdges({ filePath, text, knownFiles, pySourceRoots, edges }) {
  const importerPath = _normalizePath(filePath);
  const statements = parsePythonImports(text);

  const absoluteBases = _pyAbsoluteBases(importerPath, pySourceRoots);

  for (const stmt of statements) {
    if (stmt.kind === 'import') {
      const resolved = _resolvePyAgainstBases(absoluteBases, stmt.moduleSpecifier, knownFiles);
      if (!resolved || resolved === importerPath) continue;
      edges.push({
        sourceFilePath: resolved,
        targetFilePath: importerPath,
        moduleSpecifier: stmt.moduleSpecifier,
        importLine: stmt.line,
        symbols: stmt.symbols.map((s) => ({ name: s.alias ?? s.name, kind: 'module' })),
      });
      continue;
    }

    // from-import: resolve the module part, then split names into
    // submodule-imports (own edges) vs attribute-imports (symbols).
    const bases = stmt.relativeLevel === 0
      ? absoluteBases
      : [_pyRelativeBase(importerPath, stmt.relativeLevel)].filter(Boolean);
    if (bases.length === 0) continue;

    const moduleFile = _resolvePyAgainstBases(bases, stmt.moduleSpecifier, knownFiles);
    const attributeSymbols = [];

    for (const sym of stmt.symbols) {
      if (sym.kind === 'star') continue; // star has no names; edge below covers it
      const originalName = sym.alias ?? sym.name;
      const submodulePath = stmt.moduleSpecifier
        ? `${stmt.moduleSpecifier}.${originalName}`
        : originalName;
      const submoduleFile = _resolvePyAgainstBases(bases, submodulePath, knownFiles);
      if (submoduleFile && submoduleFile !== importerPath) {
        edges.push({
          sourceFilePath: submoduleFile,
          targetFilePath: importerPath,
          moduleSpecifier: `${'.'.repeat(stmt.relativeLevel)}${submodulePath}`,
          importLine: stmt.line,
          symbols: [{ name: originalName, kind: 'module' }],
        });
      } else {
        attributeSymbols.push({ name: originalName, kind: 'named' });
      }
    }

    const isStar = stmt.symbols.some((s) => s.kind === 'star');
    const hasAttributeImport = attributeSymbols.length > 0 || isStar;
    if (hasAttributeImport && moduleFile && moduleFile !== importerPath) {
      edges.push({
        sourceFilePath: moduleFile,
        targetFilePath: importerPath,
        moduleSpecifier: `${'.'.repeat(stmt.relativeLevel)}${stmt.moduleSpecifier}`,
        importLine: stmt.line,
        symbols: attributeSymbols,
      });
    }
  }
}

/**
 * Join a directory path and a relative specifier.
 * Handles `.`, `..` segments.
 *
 * @param {string} dir       - Absolute directory path (forward slashes).
 * @param {string} specifier - Relative specifier.
 * @returns {string} Absolute path (forward slashes).
 */
function _joinPaths(dir, specifier) {
  const parts = dir.split('/').filter(Boolean);
  const specParts = specifier.split('/');

  for (const seg of specParts) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }

  // Preserve leading slash for absolute paths
  const prefix = dir.startsWith('/') ? '/' : '';
  return prefix + parts.join('/');
}
