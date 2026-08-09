import test from 'node:test';
import assert from 'node:assert/strict';

import { discoverProjectEdges } from '../../src/app/discoveryEngine.js';
import { createSyntaxDomain } from '../../src/app/syntaxDomain.js';
import { toDiscoverableAbsPaths } from '../../src/app/useDiscoveryLifecycle.js';

// ---------------------------------------------------------------------------
// Python edge discovery through the engine (ADR-020 follow-up: wiring parity)
// ---------------------------------------------------------------------------

const ROOT = '/proj';

function run(files) {
  return discoverProjectEdges({
    projectRoot: ROOT,
    filePaths: Object.keys(files),
    readFile: (p) => files[p] ?? null,
  });
}

test('absolute import resolves module file and package __init__', () => {
  const { edges } = run({
    [`${ROOT}/main.py`]: 'import app.models\nimport app\n',
    [`${ROOT}/app/__init__.py`]: '',
    [`${ROOT}/app/models.py`]: 'class User: ...\n',
  });
  assert.equal(edges.length, 2);
  assert.equal(edges[0].sourceFilePath, `${ROOT}/app/models.py`);
  assert.equal(edges[0].targetFilePath, `${ROOT}/main.py`);
  assert.deepEqual(edges[0].symbols, [{ name: 'app', kind: 'module' }]);
  assert.equal(edges[1].sourceFilePath, `${ROOT}/app/__init__.py`);
});

test('from-import splits submodule names from attribute names', () => {
  const { edges } = run({
    [`${ROOT}/main.py`]: 'from app import models, helper_func\n',
    [`${ROOT}/app/__init__.py`]: 'def helper_func(): ...\n',
    [`${ROOT}/app/models.py`]: '',
  });
  // models is a submodule → its own edge; helper_func stays an attribute
  // symbol on the __init__ edge.
  assert.equal(edges.length, 2);
  const submoduleEdge = edges.find((e) => e.sourceFilePath.endsWith('models.py'));
  const initEdge = edges.find((e) => e.sourceFilePath.endsWith('__init__.py'));
  assert.deepEqual(submoduleEdge.symbols, [{ name: 'models', kind: 'module' }]);
  assert.deepEqual(initEdge.symbols, [{ name: 'helper_func', kind: 'named' }]);
});

test('relative imports resolve from the importing file package position', () => {
  const { edges } = run({
    [`${ROOT}/pkg/__init__.py`]: '',
    [`${ROOT}/pkg/a.py`]: 'from . import b\nfrom .b import thing\nfrom ..top import x\n',
    [`${ROOT}/pkg/b.py`]: 'def thing(): ...\n',
    [`${ROOT}/top.py`]: 'x = 1\n',
  });
  const sources = edges.map((e) => e.sourceFilePath).sort();
  // from . import b → pkg/b.py; from .b import thing → pkg/b.py (attribute);
  // from ..top import x → /proj/top.py
  assert.deepEqual(sources, [`${ROOT}/pkg/b.py`, `${ROOT}/pkg/b.py`, `${ROOT}/top.py`]);
  const attrEdge = edges.find((e) => e.symbols.some((s) => s.name === 'thing'));
  assert.equal(attrEdge.sourceFilePath, `${ROOT}/pkg/b.py`);
});

test('src layout: absolute imports resolve under src/ first', () => {
  const { edges } = run({
    [`${ROOT}/src/mylib/__init__.py`]: '',
    [`${ROOT}/src/mylib/core.py`]: 'from mylib import helpers\n',
    [`${ROOT}/src/mylib/helpers.py`]: '',
    [`${ROOT}/tests/test_core.py`]: 'from mylib.core import main\n',
  });
  const coreEdge = edges.find((e) => e.targetFilePath.endsWith('test_core.py'));
  assert.equal(coreEdge.sourceFilePath, `${ROOT}/src/mylib/core.py`);
  const helpersEdge = edges.find((e) => e.targetFilePath.endsWith('core.py'));
  assert.equal(helpersEdge.sourceFilePath, `${ROOT}/src/mylib/helpers.py`);
});

test('stdlib and third-party imports draw no edges; self-import draws none', () => {
  const { edges } = run({
    [`${ROOT}/main.py`]: 'import os\nfrom fastapi import FastAPI\nimport main\n',
  });
  assert.deepEqual(edges, []);
});

test('star import draws an edge to the module with no symbol list', () => {
  const { edges } = run({
    [`${ROOT}/main.py`]: 'from helpers import *\n',
    [`${ROOT}/helpers.py`]: '',
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].sourceFilePath, `${ROOT}/helpers.py`);
  assert.deepEqual(edges[0].symbols, []);
});

test('mixed project: JS and Python edges coexist in one run', () => {
  const { edges } = run({
    [`${ROOT}/index.js`]: "import { x } from './util';\n",
    [`${ROOT}/util.js`]: 'export const x = 1;\n',
    [`${ROOT}/main.py`]: 'import tool\n',
    [`${ROOT}/tool.py`]: '',
  });
  assert.equal(edges.length, 2);
  assert.ok(edges.some((e) => e.sourceFilePath.endsWith('util.js')));
  assert.ok(edges.some((e) => e.sourceFilePath.endsWith('tool.py')));
});

// ---------------------------------------------------------------------------
// Syntax-domain write guards: the domain must never edit Python files
// ---------------------------------------------------------------------------

test('connect stub edit is empty for a Python target (no JS injected into .py)', () => {
  const domain = createSyntaxDomain();
  const source = `${ROOT}/tool.py`;
  const target = `${ROOT}/main.py`;
  domain.commands.registerFile(source, '');
  domain.commands.registerFile(target, 'import tool\n');

  const result = domain.commands.connect({
    connectionId: 'conn_py_1', sourceFilePath: source, targetFilePath: target,
  });
  assert.ok(result?.isNewEdge);

  const stub = domain.commands.computeConnectStubEdit({
    edgeId: result.edgeId,
    targetText: 'import tool\n',
  });
  assert.deepEqual(stub.edits, [], 'must not write a JS import stub into a .py file');
});

test('disconnect edit is empty for a Python target', () => {
  const domain = createSyntaxDomain();
  const source = `${ROOT}/tool.py`;
  const target = `${ROOT}/main.py`;
  domain.commands.registerFile(source, '');
  domain.commands.registerFile(target, 'import tool\n');
  const result = domain.commands.connect({
    connectionId: 'conn_py_2', sourceFilePath: source, targetFilePath: target,
  });

  const edit = domain.commands.computeDisconnectEdit({
    connectionId: 'conn_py_2',
    targetText: 'import tool\n',
  });
  assert.deepEqual(edit.edits, [], 'must not delete lines from a .py file');
  void result;
});

test('supportsSymbols covers JS/TS and Python, not symbol-less languages', () => {
  // Python gained a symbol layer in brief-python-wires S2 — the picker now
  // opens for py→py wires. .pyi and non-code types stay unsupported.
  const domain = createSyntaxDomain();
  assert.equal(domain.selectors.supportsSymbols('/proj/app.tsx'), true);
  assert.equal(domain.selectors.supportsSymbols('/proj/util.mjs'), true);
  assert.equal(domain.selectors.supportsSymbols('/proj/main.py'), true);
  assert.equal(domain.selectors.supportsSymbols('/proj/stubs.pyi'), false);
  assert.equal(domain.selectors.supportsSymbols('/proj/README.md'), false);
  assert.equal(domain.selectors.supportsSymbols('/proj/noext'), false);
});

// ---------------------------------------------------------------------------
// Python symbol layer + import writer (brief-python-wires S2)
// ---------------------------------------------------------------------------

/** py→py domain with the pytest1-shaped layout registered. */
function setupPyWriteDomain() {
  const domain = createSyntaxDomain();
  domain.commands.setProjectRoot('/proj');
  const source = '/proj/oAuth.py';
  const target = '/proj/main/main.py';
  const sourceText = [
    'TOKEN_TTL_SECONDS = 3600',
    'def generate_state(): ...',
    'def make_pkce_pair(): ...',
    'class TokenStore:',
    '    ...',
  ].join('\n');
  const targetText = 'from fastapi import FastAPI\n\napp = FastAPI()\n';
  domain.commands.registerFile(source, sourceText);
  domain.commands.registerFile(target, targetText);
  const { edgeId } = domain.commands.connect({
    connectionId: 'conn_py_w1', sourceFilePath: source, targetFilePath: target,
  });
  return { domain, source, target, sourceText, targetText, edgeId };
}

function symbolIdFor(domain, filePath, name) {
  return domain.selectors.getDefinitionsForFile(filePath).find((d) => d.name === name).symbolId;
}

test('python files register real definitions with public/private split', () => {
  const { domain, source } = setupPyWriteDomain();
  const defs = domain.selectors.getDefinitionsForFile(source);
  assert.deepEqual(
    defs.map((d) => d.name).sort(),
    ['TOKEN_TTL_SECONDS', 'TokenStore', 'generate_state', 'make_pkce_pair'].sort()
  );
  assert.ok(defs.every((d) => d.language === 'python'));
});

test('resolving symbols on a py→py edge writes a from-import after existing imports, source untouched', () => {
  const { domain, source, target, sourceText, targetText, edgeId } = setupPyWriteDomain();
  const result = domain.commands.computeResolveEdits({
    edgeId,
    symbolIds: [symbolIdFor(domain, source, 'TokenStore'), symbolIdFor(domain, source, 'generate_state')],
    targetText,
    sourceText,
  });
  assert.equal(result.edits.length, 1, 'exactly one edit — python has no export block');
  assert.equal(result.edits[0].filePath, target);
  const lines = result.edits[0].newText.split('\n');
  assert.equal(lines[0], 'from fastapi import FastAPI');
  assert.equal(lines[1], 'from oAuth import TokenStore, generate_state');
  assert.equal(result.edge.status, 'resolved');
});

test('python module spec prefers the importer directory (sibling) over the root', () => {
  const domain = createSyntaxDomain();
  domain.commands.setProjectRoot('/proj');
  domain.commands.registerFile('/proj/main/tool.py', 'def shout(): ...\n');
  domain.commands.registerFile('/proj/main/main.py', '');
  const { edgeId } = domain.commands.connect({
    connectionId: 'c1', sourceFilePath: '/proj/main/tool.py', targetFilePath: '/proj/main/main.py',
  });
  const result = domain.commands.computeResolveEdits({
    edgeId,
    symbolIds: [symbolIdFor(domain, '/proj/main/tool.py', 'shout')],
    targetText: '',
    sourceText: 'def shout(): ...\n',
  });
  assert.ok(result.edits[0].newText.startsWith('from tool import shout'));
});

test('python module spec resolves src-layout packages as dotted paths', () => {
  const domain = createSyntaxDomain();
  domain.commands.setProjectRoot('/proj');
  domain.commands.registerFile('/proj/src/mylib/helpers.py', 'def go(): ...\n');
  domain.commands.registerFile('/proj/tests/test_core.py', '');
  const { edgeId } = domain.commands.connect({
    connectionId: 'c2', sourceFilePath: '/proj/src/mylib/helpers.py', targetFilePath: '/proj/tests/test_core.py',
  });
  const result = domain.commands.computeResolveEdits({
    edgeId,
    symbolIds: [symbolIdFor(domain, '/proj/src/mylib/helpers.py', 'go')],
    targetText: '',
    sourceText: 'def go(): ...\n',
  });
  assert.ok(result.edits[0].newText.startsWith('from mylib.helpers import go'));
});

test('resolving merges into an existing from-import for the same module', () => {
  const { domain, source, sourceText, edgeId } = setupPyWriteDomain();
  const targetText = 'from oAuth import generate_state\n\nprint(generate_state())\n';
  const result = domain.commands.computeResolveEdits({
    edgeId,
    symbolIds: [symbolIdFor(domain, source, 'TokenStore')],
    targetText,
    sourceText,
  });
  assert.equal(result.edits.length, 1);
  assert.ok(result.edits[0].newText.startsWith('from oAuth import generate_state, TokenStore'));
});

test('re-resolving an already-imported symbol is a no-op (discovery idempotence)', () => {
  const { domain, source, sourceText, edgeId } = setupPyWriteDomain();
  const targetText = 'from oAuth import TokenStore\n';
  const result = domain.commands.computeResolveEdits({
    edgeId,
    symbolIds: [symbolIdFor(domain, source, 'TokenStore')],
    targetText,
    sourceText,
  });
  assert.deepEqual(result.edits, [], 'reopen discovery must not churn the file');
});

test('a star import already covers every symbol — no edit', () => {
  const { domain, source, sourceText, edgeId } = setupPyWriteDomain();
  const result = domain.commands.computeResolveEdits({
    edgeId,
    symbolIds: [symbolIdFor(domain, source, 'TokenStore')],
    targetText: 'from oAuth import *\n',
    sourceText,
  });
  assert.deepEqual(result.edits, []);
});

test('underivable module spec fails closed with no write', () => {
  const domain = createSyntaxDomain();
  // No project root; source is not under the target's directory.
  domain.commands.registerFile('/elsewhere/lib.py', 'def x(): ...\n');
  domain.commands.registerFile('/proj/main.py', '');
  const { edgeId } = domain.commands.connect({
    connectionId: 'c3', sourceFilePath: '/elsewhere/lib.py', targetFilePath: '/proj/main.py',
  });
  const result = domain.commands.computeResolveEdits({
    edgeId,
    symbolIds: [symbolIdFor(domain, '/elsewhere/lib.py', 'x')],
    targetText: '',
    sourceText: 'def x(): ...\n',
  });
  assert.deepEqual(result.edits, []);
});

test('connection status mirrors the edge: resolved after metadata resolve, broken after def deletion', () => {
  // Owner live-verify C (2026-07-18): the legacy shim keyed connection status
  // on the single-symbol picker map, so discovery-resolved wires reported
  // 'pending' (orange) forever and a broken edge never surfaced red.
  const domain = createSyntaxDomain();
  domain.commands.setProjectRoot('/proj');
  domain.commands.registerFile('/proj/tool.py', 'def shout(): ...\n');
  domain.commands.registerFile('/proj/main.py', 'from tool import shout\n');
  const { edgeId } = domain.commands.connect({
    connectionId: 'conn-status-1', sourceFilePath: '/proj/tool.py', targetFilePath: '/proj/main.py',
  });
  assert.equal(domain.selectors.getSyntaxConnection('conn-status-1').status, 'pending', 'symbol-less edge is pending');

  const shoutId = domain.selectors.getDefinitionsForFile('/proj/tool.py').find((d) => d.name === 'shout').symbolId;
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [shoutId] });
  assert.equal(domain.selectors.getSyntaxConnection('conn-status-1').status, 'resolved');

  // Definition deleted (file emptied) → broken must surface at the
  // connection level, because that is what the wire renders from.
  domain.commands.notifyFileChanged('/proj/tool.py', '');
  assert.equal(domain.selectors.getSyntaxConnection('conn-status-1').status, 'broken');

  // Retyping the def recovers.
  domain.commands.notifyFileChanged('/proj/tool.py', 'def shout(): ...\n');
  assert.equal(domain.selectors.getSyntaxConnection('conn-status-1').status, 'resolved');
});

test('a dead import is BROKEN from first load, and refresh registration recovers it', () => {
  // Owner live-verify (2026-07-18): reopening a project whose import
  // referenced a deleted definition drew a pending/orange wire — the load
  // path had no way to say "broken", and registerFile never reconciled.
  const domain = createSyntaxDomain();
  domain.commands.setProjectRoot('/proj');
  domain.commands.registerFile('/proj/tool.py', ''); // def already deleted
  domain.commands.registerFile('/proj/main.py', 'from tool import shout\n');
  const { edgeId } = domain.commands.connect({
    connectionId: 'conn-dead-1', sourceFilePath: '/proj/tool.py', targetFilePath: '/proj/main.py',
  });
  // Discovery's pre-resolve path: no matching definition → broken marker.
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [], brokenNames: ['shout'] });
  assert.equal(domain.selectors.getSyntaxConnection('conn-dead-1').status, 'broken');

  // The def is retyped and the refresh re-registers the file (not a live
  // keystroke) — registration now reconciles, so the wire recovers.
  domain.commands.registerFile('/proj/tool.py', 'def shout(): ...\n');
  assert.equal(domain.selectors.getSyntaxConnection('conn-dead-1').status, 'resolved');
});

test('computeRemoveEdits fails closed for python edges without mutating (S3 pending)', () => {
  const { domain, source, sourceText, edgeId } = setupPyWriteDomain();
  domain.commands.computeResolveEdits({
    edgeId,
    symbolIds: [symbolIdFor(domain, source, 'TokenStore')],
    targetText: '',
    sourceText,
  });
  const before = domain.selectors.getSyntaxEdge(edgeId).symbols.length;
  const result = domain.commands.computeRemoveEdits({
    edgeId,
    symbolName: 'TokenStore',
    targetText: 'from oAuth import TokenStore\n',
    sourceText,
  });
  assert.deepEqual(result.edits, []);
  assert.equal(domain.selectors.getSyntaxEdge(edgeId).symbols.length, before, 'edge symbols unchanged');
});

// ---------------------------------------------------------------------------
// Lifecycle filter
// ---------------------------------------------------------------------------

test('discoverable paths include .py but not .pyi or ignored types', () => {
  const tree = [
    { path: 'main.py' },
    { path: 'src/mylib/core.py' },
    { path: 'stubs/typed.pyi' },
    { path: 'index.ts' },
    { path: 'README.md' },
    { path: 'src' }, // directory entry — no extension, dropped
  ];
  const paths = toDiscoverableAbsPaths(tree, '/proj');
  assert.deepEqual(paths, ['/proj/main.py', '/proj/src/mylib/core.py', '/proj/index.ts']);
});

// ---------------------------------------------------------------------------
// Importer-directory base for absolute imports (script semantics — running
// `python main/main.py` puts main/ on sys.path, so sibling imports are
// legal; brief-python-wires S1. Regression: pytest1's main/main.py +
// main/tool.py produced no edge, 2026-07-17.)
// ---------------------------------------------------------------------------

test('absolute from-import resolves a sibling of the importing script', () => {
  const { edges } = run({
    [`${ROOT}/main/main.py`]: 'from tool import shout\n',
    [`${ROOT}/main/tool.py`]: 'def shout(m): ...\n',
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].sourceFilePath, `${ROOT}/main/tool.py`);
  assert.equal(edges[0].targetFilePath, `${ROOT}/main/main.py`);
  assert.deepEqual(edges[0].symbols, [{ name: 'shout', kind: 'named' }]);
});

test('plain import resolves a sibling module of the importing script', () => {
  const { edges } = run({
    [`${ROOT}/scripts/job.py`]: 'import helpers\n',
    [`${ROOT}/scripts/helpers.py`]: 'def go(): ...\n',
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].sourceFilePath, `${ROOT}/scripts/helpers.py`);
});

test('importer-dir base wins over a same-named module at a source root', () => {
  const { edges } = run({
    [`${ROOT}/main/main.py`]: 'import tool\n',
    [`${ROOT}/main/tool.py`]: '',
    [`${ROOT}/tool.py`]: '',
  });
  assert.equal(edges.length, 1);
  // Script semantics: the sibling shadows the root module.
  assert.equal(edges[0].sourceFilePath, `${ROOT}/main/tool.py`);
});

test('root-level importer keeps existing root resolution (no duplicate base)', () => {
  const { edges } = run({
    [`${ROOT}/main.py`]: 'import util\n',
    [`${ROOT}/util.py`]: '',
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].sourceFilePath, `${ROOT}/util.py`);
});
