import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyntaxDomain } from '../../src/app/syntaxDomain.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a domain with two JS files registered. */
function setupDomain() {
  const domain = createSyntaxDomain();

  const srcPath = '/project/src/utils.js';
  const srcText = [
    'export function helper() {}',
    'export const MAX = 100;',
    'function internal() {}',
    'export type Config = {};',
  ].join('\n');

  const tgtPath = '/project/src/app.js';
  const tgtText = '// app entry\n';

  domain.commands.registerFile(srcPath, srcText);
  domain.commands.registerFile(tgtPath, tgtText);

  return { domain, srcPath, srcText, tgtPath, tgtText };
}

// ---------------------------------------------------------------------------
// registerFile / getDefinitionsForFile / getExportCandidates
// ---------------------------------------------------------------------------

test('registerFile populates definitionIndex and symbolIndex', () => {
  const { domain, srcPath } = setupDomain();

  const defs = domain.selectors.getDefinitionsForFile(srcPath);
  assert.ok(defs.length >= 3, 'should have at least 3 definitions');

  const exports = domain.selectors.getExportCandidates(srcPath);
  assert.ok(exports.length >= 2, 'should have at least 2 export candidates');
  assert.ok(exports.some((s) => s.name === 'helper'));
  assert.ok(exports.some((s) => s.name === 'MAX'));
});

test('getDefinitionsForFile includes non-exported definitions', () => {
  const { domain, srcPath } = setupDomain();
  const defs = domain.selectors.getDefinitionsForFile(srcPath);
  assert.ok(defs.some((d) => d.name === 'internal' && !d.exported));
});

// ---------------------------------------------------------------------------
// connect — new edge creation
// ---------------------------------------------------------------------------

test('connect creates a new SyntaxEdge with import stub', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const result = domain.commands.connect({
    connectionId: 'conn-1',
    sourceFilePath: srcPath,
    targetFilePath: tgtPath,
  });

  assert.ok(result, 'should return result');
  assert.ok(result.patchPlan, 'should have patch plan for stub');
  assert.equal(result.patchPlan.kind, 'insert');
  assert.ok(result.patchPlan.text.includes('/* TODO'));
  assert.equal(result.isNewEdge, true);
  assert.ok(result.edgeId);
  assert.ok(result.syntaxConn);
  assert.equal(result.syntaxConn.status, 'pending');
});

test('connect returns null for same-file connection', () => {
  const { domain, srcPath } = setupDomain();
  const result = domain.commands.connect({
    connectionId: 'conn-1',
    sourceFilePath: srcPath,
    targetFilePath: srcPath,
  });
  assert.equal(result, null);
});

test('connect returns null for duplicate connectionId', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const dup = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  assert.equal(dup, null);
});

test('connect reuses existing edge for same file pair', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const first = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  assert.equal(first.isNewEdge, true);

  const second = domain.commands.connect({ connectionId: 'conn-2', sourceFilePath: srcPath, targetFilePath: tgtPath });
  assert.ok(second);
  assert.equal(second.isNewEdge, false);
  assert.equal(second.patchPlan, null, 'no stub for reused edge');
  assert.equal(second.edgeId, first.edgeId);
});

// ---------------------------------------------------------------------------
// getSyntaxEdge / getSyntaxEdgeForPair
// ---------------------------------------------------------------------------

test('getSyntaxEdge returns edge after connect', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const edge = domain.selectors.getSyntaxEdge(edgeId);

  assert.ok(edge);
  assert.equal(edge.sourceFilePath, srcPath);
  assert.equal(edge.targetFilePath, tgtPath);
  assert.equal(edge.status, 'pending');
  assert.deepEqual(edge.symbols, []);
  assert.deepEqual(edge.connectionIds, ['conn-1']);
});

test('getSyntaxEdgeForPair finds edge by file pair', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const edge = domain.selectors.getSyntaxEdgeForPair(srcPath, tgtPath);
  assert.ok(edge);
  assert.equal(edge.sourceFilePath, srcPath);
});

test('getSyntaxEdgeForPair returns null for non-existent pair', () => {
  const { domain, srcPath } = setupDomain();
  assert.equal(domain.selectors.getSyntaxEdgeForPair(srcPath, '/no/such/file.js'), null);
});

// ---------------------------------------------------------------------------
// disconnectConnection
// ---------------------------------------------------------------------------

test('disconnectConnection removes last connection and edge', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const result = domain.commands.disconnectConnection('conn-1');

  assert.ok(result);
  // Edge should be deleted
  assert.equal(domain.selectors.getSyntaxEdge(edgeId), null);
  assert.equal(domain.selectors.getSyntaxConnection('conn-1'), null);
});

test('disconnectConnection keeps edge when other connections remain', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const { edgeId } = domain.commands.connect({ connectionId: 'conn-2', sourceFilePath: srcPath, targetFilePath: tgtPath });

  domain.commands.disconnectConnection('conn-1');

  // Edge should still exist
  const edge = domain.selectors.getSyntaxEdge(edgeId);
  assert.ok(edge);
  assert.deepEqual(edge.connectionIds, ['conn-2']);

  // conn-1 should be gone
  assert.equal(domain.selectors.getSyntaxConnection('conn-1'), null);
  // conn-2 should still work
  assert.ok(domain.selectors.getSyntaxConnection('conn-2'));
});

test('disconnectConnection generates removeLine when removeImport=true', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const result = domain.commands.disconnectConnection('conn-1', { removeImport: true });

  assert.ok(result.patchPlan);
  assert.equal(result.patchPlan.kind, 'removeLine');
});

test('disconnectConnection skips removal when removeImport=false', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const result = domain.commands.disconnectConnection('conn-1', { removeImport: false });

  assert.equal(result.patchPlan, null);
});

// ---------------------------------------------------------------------------
// Backward compat: getSyntaxConnection
// ---------------------------------------------------------------------------

test('getSyntaxConnection returns SyntaxConn-shaped object', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const conn = domain.selectors.getSyntaxConnection('conn-1');

  assert.ok(conn);
  assert.equal(conn.connectionId, 'conn-1');
  assert.equal(conn.sourceFilePath, srcPath);
  assert.equal(conn.targetFilePath, tgtPath);
  assert.equal(conn.status, 'pending');
  assert.ok(conn.relSpec);
  assert.ok(typeof conn.stubLine === 'number');
});

test('getSyntaxConnection reflects resolved status after symbols resolve', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const helperSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'helper');
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperSym.symbolId] });

  const conn = domain.selectors.getSyntaxConnection('conn-1');
  assert.equal(conn.status, 'resolved');
});

test('getSyntaxConnection returns null for unknown connectionId', () => {
  const { domain } = setupDomain();
  assert.equal(domain.selectors.getSyntaxConnection('unknown'), null);
});

// ---------------------------------------------------------------------------
// getAllSyntaxConnections / getSyntaxConnectionsByFile
// ---------------------------------------------------------------------------

test('getAllSyntaxConnections returns all connections', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  domain.commands.connect({ connectionId: 'conn-2', sourceFilePath: srcPath, targetFilePath: tgtPath });

  const all = domain.selectors.getAllSyntaxConnections();
  assert.equal(all.length, 2);
});

test('getSyntaxConnectionsByFile returns connections for file', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });

  const srcConns = domain.selectors.getSyntaxConnectionsByFile(srcPath);
  assert.equal(srcConns.length, 1);

  const tgtConns = domain.selectors.getSyntaxConnectionsByFile(tgtPath);
  assert.equal(tgtConns.length, 1);
});

// ---------------------------------------------------------------------------
// Edge-level selectors
// ---------------------------------------------------------------------------

test('getAllSyntaxEdges returns all edges', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const tgt2 = '/project/src/other.js';
  domain.commands.registerFile(tgt2, '// other\n');

  domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  domain.commands.connect({ connectionId: 'conn-2', sourceFilePath: srcPath, targetFilePath: tgt2 });

  const edges = domain.selectors.getAllSyntaxEdges();
  assert.equal(edges.length, 2);
});

test('getEdgesForFile returns edges involving file', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const tgt2 = '/project/src/other.js';
  domain.commands.registerFile(tgt2, '// other\n');

  domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  domain.commands.connect({ connectionId: 'conn-2', sourceFilePath: srcPath, targetFilePath: tgt2 });

  const srcEdges = domain.selectors.getEdgesForFile(srcPath);
  assert.equal(srcEdges.length, 2);

  const tgtEdges = domain.selectors.getEdgesForFile(tgtPath);
  assert.equal(tgtEdges.length, 1);
});

test('getSymbolsOnEdge returns edge symbols', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const helperSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'helper');

  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperSym.symbolId] });

  const symbols = domain.selectors.getSymbolsOnEdge(edgeId);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0].symbolName, 'helper');
});

test('getAvailableSymbolsForEdge filters out connected symbols', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const allDefs = domain.selectors.getDefinitionsForFile(srcPath);
  const helperSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'helper');

  // Before adding any symbols — all definitions available
  const beforeAvail = domain.selectors.getAvailableSymbolsForEdge(srcPath, edgeId);
  assert.equal(beforeAvail.length, allDefs.length);

  // After adding helper — it should be filtered out
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperSym.symbolId] });
  const afterAvail = domain.selectors.getAvailableSymbolsForEdge(srcPath, edgeId);
  assert.equal(afterAvail.length, allDefs.length - 1);
  assert.ok(!afterAvail.some((d) => d.symbolId === helperSym.symbolId));
});

test('getEdgeIdForConnection returns edgeId', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  assert.equal(domain.selectors.getEdgeIdForConnection('conn-1'), edgeId);
});

test('getEdgeIdForConnection returns null for unknown connection', () => {
  const { domain } = setupDomain();
  assert.equal(domain.selectors.getEdgeIdForConnection('unknown'), null);
});

// ---------------------------------------------------------------------------
// onStateChange
// ---------------------------------------------------------------------------

test('onStateChange emits connectionsChanged and edgesChanged', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const events = [];
  domain.onStateChange((diff) => events.push(diff));

  domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });

  assert.ok(events.length >= 1);
  const last = events[events.length - 1];
  assert.ok(last.connectionsChanged);
  assert.ok(last.edgesChanged);
  assert.ok(last.connectionsChanged.includes('conn-1'));
});

// ---------------------------------------------------------------------------
// notifyFileChanged / reconciliation
// ---------------------------------------------------------------------------

test('notifyFileChanged reconciles broken status when symbol removed', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const helperSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'helper');
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperSym.symbolId] });

  // Now remove the helper function from source
  domain.commands.notifyFileChanged(srcPath, 'export const MAX = 100;\n');

  const edge = domain.selectors.getSyntaxEdge(edgeId);
  assert.ok(edge);
  assert.equal(edge.status, 'broken');
  assert.equal(edge.symbols[0].status, 'broken');
});

test('notifyFileChanged does not break pending edges', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });

  // Change source — should not affect pending edge
  domain.commands.notifyFileChanged(srcPath, 'export const MAX = 100;\n');

  const edge = domain.selectors.getSyntaxEdge(edgeId);
  assert.equal(edge.status, 'pending');
});

// ---------------------------------------------------------------------------
// N5: Edge Warning States — drifted, unused, recovery
// ---------------------------------------------------------------------------

test('notifyFileChanged detects drifted when symbol renamed (case-insensitive match)', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const helperSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'helper');
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperSym.symbolId] });

  // Rename helper → Helper (case change)
  domain.commands.notifyFileChanged(srcPath, [
    'export function Helper() {}',
    'export const MAX = 100;',
  ].join('\n'));

  const edge = domain.selectors.getSyntaxEdge(edgeId);
  assert.equal(edge.symbols[0].status, 'drifted');
  assert.equal(edge.status, 'drifted');
});

test('notifyFileChanged marks broken when no drift candidate found', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const helperSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'helper');
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperSym.symbolId] });

  // Remove helper entirely — no similar name exists
  domain.commands.notifyFileChanged(srcPath, 'export const MAX = 100;\n');

  const edge = domain.selectors.getSyntaxEdge(edgeId);
  assert.equal(edge.symbols[0].status, 'broken');
});

test('notifyFileChanged recovers broken symbol when definition reappears', () => {
  const { domain, srcPath, srcText, tgtPath } = setupDomain();

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const helperSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'helper');
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperSym.symbolId] });

  // Break it
  domain.commands.notifyFileChanged(srcPath, 'export const MAX = 100;\n');
  assert.equal(domain.selectors.getSyntaxEdge(edgeId).symbols[0].status, 'broken');

  // Restore it
  domain.commands.notifyFileChanged(srcPath, srcText);
  assert.equal(domain.selectors.getSyntaxEdge(edgeId).symbols[0].status, 'resolved');
  assert.equal(domain.selectors.getSyntaxEdge(edgeId).status, 'resolved');
});

test('notifyFileChanged detects unused when symbol not referenced in target', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  // Register target with content that imports helper but does not use it
  const tgtTextWithImport = "import { helper } from './utils';\n// nothing here\n";
  domain.commands.registerFile(tgtPath, tgtTextWithImport);

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const helperSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'helper');
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperSym.symbolId] });

  // Now simulate target file update that still doesn't use the symbol
  domain.commands.notifyFileChanged(tgtPath, "import { helper } from './utils';\n// still nothing\n");

  const edge = domain.selectors.getSyntaxEdge(edgeId);
  const sym = edge.symbols.find((s) => s.symbolName === 'helper');
  assert.equal(sym.status, 'unused');
  assert.equal(edge.status, 'unused');
});

test('notifyFileChanged recovers unused symbol when reference appears in target', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  // Target with import but no usage
  const tgtTextNoUse = "import { helper } from './utils';\n// nothing\n";
  domain.commands.registerFile(tgtPath, tgtTextNoUse);

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const helperSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'helper');
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperSym.symbolId] });

  // Trigger target reconciliation — mark as unused
  domain.commands.notifyFileChanged(tgtPath, tgtTextNoUse);
  assert.equal(domain.selectors.getSyntaxEdge(edgeId).symbols[0].status, 'unused');

  // Now add a reference to helper in target
  domain.commands.notifyFileChanged(tgtPath, "import { helper } from './utils';\nconst x = helper();\n");

  const edge = domain.selectors.getSyntaxEdge(edgeId);
  assert.equal(edge.symbols[0].status, 'resolved');
  assert.equal(edge.status, 'resolved');
});

test('aggregate edge status reports worst across mixed symbol states', () => {
  const domain = createSyntaxDomain();

  const srcPath = '/project/src/multi.js';
  domain.commands.registerFile(srcPath, [
    'export function alpha() {}',
    'export function beta() {}',
  ].join('\n'));

  const tgtPath = '/project/src/consumer.js';
  // Target uses alpha but not beta
  domain.commands.registerFile(tgtPath, "import { alpha, beta } from './multi';\nalpha();\n");

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const exports = domain.selectors.getExportCandidates(srcPath);
  domain.commands.resolveSymbolsMetadata({
    edgeId,
    symbolIds: [
      exports.find((s) => s.name === 'alpha').symbolId,
      exports.find((s) => s.name === 'beta').symbolId,
    ],
  });

  // Trigger target reconciliation — beta unused, alpha used
  domain.commands.notifyFileChanged(tgtPath, "import { alpha, beta } from './multi';\nalpha();\n");

  const edge = domain.selectors.getSyntaxEdge(edgeId);
  const alphaSym = edge.symbols.find((s) => s.symbolName === 'alpha');
  const betaSym = edge.symbols.find((s) => s.symbolName === 'beta');
  assert.equal(alphaSym.status, 'resolved');
  assert.equal(betaSym.status, 'unused');
  // Aggregate should be unused (worst)
  assert.equal(edge.status, 'unused');

  // Now remove alpha definition from source → broken is worse than unused
  domain.commands.notifyFileChanged(srcPath, 'export function beta() {}\n');

  const edge2 = domain.selectors.getSyntaxEdge(edgeId);
  assert.equal(edge2.symbols.find((s) => s.symbolName === 'alpha').status, 'broken');
  assert.equal(edge2.status, 'broken');
});

test('drifted recovers to resolved when exact name is restored', () => {
  const { domain, srcPath, srcText, tgtPath } = setupDomain();

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const helperSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'helper');
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperSym.symbolId] });

  // Drift it
  domain.commands.notifyFileChanged(srcPath, 'export function Helper() {}\nexport const MAX = 100;\n');
  assert.equal(domain.selectors.getSyntaxEdge(edgeId).symbols[0].status, 'drifted');

  // Restore exact name
  domain.commands.notifyFileChanged(srcPath, srcText);
  assert.equal(domain.selectors.getSyntaxEdge(edgeId).symbols[0].status, 'resolved');
});

// ---------------------------------------------------------------------------
// unregisterFile
// ---------------------------------------------------------------------------

test('unregisterFile marks source edges as broken', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const helperSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'helper');
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperSym.symbolId] });

  domain.commands.unregisterFile(srcPath);

  const edge = domain.selectors.getSyntaxEdge(edgeId);
  assert.equal(edge.status, 'broken');
});

// ---------------------------------------------------------------------------
// renameFile
// ---------------------------------------------------------------------------

test('renameFile updates edge paths and relSpec', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const helperSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'helper');
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperSym.symbolId] });

  const newSrcPath = '/project/src/lib/utils.js';
  const result = domain.commands.renameFile(srcPath, newSrcPath);

  assert.ok(result.patchPlans.length > 0, 'should generate import path patches');

  // Old edge key should be gone, new one exists
  const oldEdge = domain.selectors.getSyntaxEdgeForPair(srcPath, tgtPath);
  assert.equal(oldEdge, null);

  const newEdge = domain.selectors.getSyntaxEdgeForPair(newSrcPath, tgtPath);
  assert.ok(newEdge);
  assert.equal(newEdge.sourceFilePath, newSrcPath);
  assert.ok(newEdge.relSpec.includes('lib'));
});

test('renameFile is no-op when paths are identical', () => {
  const { domain, srcPath } = setupDomain();
  const result = domain.commands.renameFile(srcPath, srcPath);
  assert.deepEqual(result.patchPlans, []);
});

// ---------------------------------------------------------------------------
// N6: Detach Modes
// ---------------------------------------------------------------------------

test('detachEdge removes edge from state without generating patches', () => {
  const { domain, srcPath, tgtPath } = setupDomain();

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const helperSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'helper');
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperSym.symbolId] });

  const result = domain.commands.detachEdge(edgeId);
  assert.equal(result.success, true);

  // Edge should be gone
  assert.equal(domain.selectors.getSyntaxEdge(edgeId), null);
  assert.equal(domain.selectors.getSyntaxEdgeForPair(srcPath, tgtPath), null);

  // Connection mapping should be gone too
  assert.equal(domain.selectors.getEdgeIdForConnection('conn-1'), null);
});

test('detachEdge returns false for unknown edgeId', () => {
  const { domain } = setupDomain();
  const result = domain.commands.detachEdge('nonexistent');
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Import line composition
// ---------------------------------------------------------------------------

/** Resolve one symbol via the live text path and return the import line written to the target. */
function resolveAndGetImportLine(domain, edgeId, symbolId, tgtPath, srcText) {
  const result = domain.commands.computeResolveEdits({
    edgeId,
    symbolIds: [symbolId],
    targetText: '// app\n',
    sourceText: srcText,
  });
  const targetEdit = result.edits.find((e) => e.filePath === tgtPath);
  return targetEdit.newText.split('\n').find((l) => l.includes('import')) ?? '';
}

test('import line for named export uses { name }', () => {
  const domain = createSyntaxDomain();

  const srcPath = '/project/src/mod.js';
  const srcText = 'export function helper() {}\n';
  domain.commands.registerFile(srcPath, srcText);

  const tgtPath = '/project/src/app.js';
  domain.commands.registerFile(tgtPath, '// app\n');

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const helperSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'helper');

  const importLine = resolveAndGetImportLine(domain, edgeId, helperSym.symbolId, tgtPath, srcText);
  assert.ok(/import\s*\{.*helper.*\}\s*from/.test(importLine));
});

test('import line for default export uses bare name', () => {
  const domain = createSyntaxDomain();

  const srcPath = '/project/src/mod.js';
  const srcText = 'export default function main() {}';
  domain.commands.registerFile(srcPath, srcText);

  const tgtPath = '/project/src/app.js';
  domain.commands.registerFile(tgtPath, '// app\n');

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const defaultSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.exportKind === 'default');

  const importLine = resolveAndGetImportLine(domain, edgeId, defaultSym.symbolId, tgtPath, srcText);
  // Should be `import main from ...` not `import { main } from ...`
  assert.ok(/^import\s+\w+\s+from/.test(importLine));
  assert.ok(!importLine.includes('{'));
});

test('import line for type-only uses import type { }', () => {
  const domain = createSyntaxDomain();

  const srcPath = '/project/src/types.ts';
  const srcText = 'export type Config = { key: string };';
  domain.commands.registerFile(srcPath, srcText);

  const tgtPath = '/project/src/app.ts';
  domain.commands.registerFile(tgtPath, '// app\n');

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const typeSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'Config');

  const importLine = resolveAndGetImportLine(domain, edgeId, typeSym.symbolId, tgtPath, srcText);
  assert.ok(importLine.includes('import type'));
});

// ---------------------------------------------------------------------------
// Ports (unchanged from M2)
// ---------------------------------------------------------------------------

test('getPortsForFile returns ports for exported symbols', () => {
  const { domain, srcPath } = setupDomain();
  const ports = domain.selectors.getPortsForFile(srcPath);
  assert.ok(ports.length >= 2);
  assert.ok(ports.every((p) => p.direction === 'out'));
  assert.ok(ports.some((p) => p.label === 'helper'));
});

// ---------------------------------------------------------------------------
// computeResolveEdits — consistent text-based write path (bug fix)
// ---------------------------------------------------------------------------

/** Find the import line in a multi-line text. */
function findImportLine(text, spec) {
  return text.split('\n').find((l) => l.includes('import') && l.includes(spec)) ?? null;
}

test('computeResolveEdits: two symbols produce ONE merged import and ONE export, no drift', () => {
  const domain = createSyntaxDomain();

  const srcPath = '/project/src/utils.js';
  // Non-exported defs so the export block must be created/extended.
  const srcText = [
    'function helper() {}',
    'function compute() {}',
  ].join('\n');

  const tgtPath = '/project/src/app.js';
  const tgtText = "import { existing } from './other';\n// app body\n";

  domain.commands.registerFile(srcPath, srcText);
  domain.commands.registerFile(tgtPath, tgtText);

  const { edgeId, syntaxConn } = domain.commands.connect({
    connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath,
  });
  const relSpec = syntaxConn.relSpec;

  const defs = domain.selectors.getDefinitionsForFile(srcPath);
  const helperId = defs.find((d) => d.name === 'helper').symbolId;
  const computeId = defs.find((d) => d.name === 'compute').symbolId;

  const result = domain.commands.computeResolveEdits({
    edgeId,
    symbolIds: [helperId, computeId],
    targetText: tgtText,
    sourceText: srcText,
  });

  assert.ok(result);
  assert.equal(result.edge.symbols.length, 2);

  const tgtEdit = result.edits.find((e) => e.filePath === tgtPath);
  const srcEdit = result.edits.find((e) => e.filePath === srcPath);
  assert.ok(tgtEdit, 'should produce a target edit');
  assert.ok(srcEdit, 'should produce a source edit');

  // Exactly ONE generated import from the new module (the existing one untouched).
  const importLines = tgtEdit.newText.split('\n').filter((l) => l.includes('import') && l.includes(relSpec));
  assert.equal(importLines.length, 1, 'exactly one import line from the new module');
  assert.ok(importLines[0].includes('helper'));
  assert.ok(importLines[0].includes('compute'));
  // The pre-existing import survives.
  assert.ok(tgtEdit.newText.includes("import { existing } from './other';"));

  // ONE export block with BOTH symbols (no drift / no duplicate blocks).
  const exportBlocks = srcEdit.newText.split('\n').filter((l) => /^export\s*\{/.test(l.trimStart()));
  assert.equal(exportBlocks.length, 1, 'exactly one export block');
  assert.ok(exportBlocks[0].includes('helper'));
  assert.ok(exportBlocks[0].includes('compute'));

  // No stale TODO stub remains.
  assert.ok(!tgtEdit.newText.includes('TODO'));
});

test('computeResolveEdits: dedup — resolving into an already-imported module merges, no duplicate line', () => {
  const domain = createSyntaxDomain();

  const srcPath = '/project/src/utils.js';
  const srcText = 'export function helper() {}\nexport function compute() {}\n';
  domain.commands.registerFile(srcPath, srcText);

  const tgtPath = '/project/src/app.js';
  domain.commands.registerFile(tgtPath, '// placeholder\n');

  const { edgeId, syntaxConn } = domain.commands.connect({
    connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath,
  });
  const relSpec = syntaxConn.relSpec;

  const exports = domain.selectors.getExportCandidates(srcPath);
  const helperId = exports.find((s) => s.name === 'helper').symbolId;
  const computeId = exports.find((s) => s.name === 'compute').symbolId;

  // Target already imports `helper` manually from the same module.
  const tgtText = `import { helper } from '${relSpec}';\n// app body\n`;

  // Add helper (already imported) + compute.
  const result = domain.commands.computeResolveEdits({
    edgeId,
    symbolIds: [helperId, computeId],
    targetText: tgtText,
    sourceText: srcText,
  });

  const tgtEdit = result.edits.find((e) => e.filePath === tgtPath);
  assert.ok(tgtEdit);

  // Still exactly ONE import line from the module — merged, not duplicated.
  const importLines = tgtEdit.newText.split('\n').filter((l) => l.includes('import') && l.includes(relSpec));
  assert.equal(importLines.length, 1, 'merged into the existing import line');
  assert.ok(importLines[0].includes('helper'));
  assert.ok(importLines[0].includes('compute'));
  // helper appears once, not twice.
  assert.equal((importLines[0].match(/\bhelper\b/g) || []).length, 1, 'no duplicate helper specifier');
});

test('computeResolveEdits: merging a named symbol preserves an existing DEFAULT import (no data loss)', () => {
  const domain = createSyntaxDomain();

  const srcPath = '/project/src/App.tsx';
  const srcText = 'export function helper() {}\nexport default function App() { return null; }\n';
  domain.commands.registerFile(srcPath, srcText);

  const tgtPath = '/project/src/main.tsx';
  domain.commands.registerFile(tgtPath, '// placeholder\n');

  const { edgeId, syntaxConn } = domain.commands.connect({
    connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath,
  });
  const relSpec = syntaxConn.relSpec;

  const helperId = domain.selectors.getDefinitionsForFile(srcPath).find((s) => s.name === 'helper').symbolId;

  // Target already imports the DEFAULT from the same module (the Vite case).
  const tgtText = `import App from '${relSpec}';\nrender(<App />);\n`;

  const result = domain.commands.computeResolveEdits({
    edgeId, symbolIds: [helperId], targetText: tgtText, sourceText: srcText,
  });

  const tgtEdit = result.edits.find((e) => e.filePath === tgtPath);
  assert.ok(tgtEdit, 'produces a target edit');
  const importLine = findImportLine(tgtEdit.newText, relSpec);
  assert.ok(/\bApp\b/.test(importLine), 'default App preserved, not dropped');
  assert.ok(/\{[^}]*\bhelper\b[^}]*\}/.test(importLine), 'named helper added');
  // One combined line: `import App, { helper } from '...'`
  assert.equal((tgtEdit.newText.match(new RegExp(`from '${relSpec.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}'`, 'g')) || []).length, 1, 'single merged import line');
  assert.ok(/import\s+App\s*,\s*\{/.test(importLine), 'default + named form');
});

test('computeResolveEdits: resolving an already-imported default symbol is a clean no-op (no edit)', () => {
  const domain = createSyntaxDomain();

  const srcPath = '/project/src/App.tsx';
  const srcText = 'export default function App() { return null; }\n';
  domain.commands.registerFile(srcPath, srcText);

  const tgtPath = '/project/src/main.tsx';
  domain.commands.registerFile(tgtPath, '// placeholder\n');

  const { edgeId, syntaxConn } = domain.commands.connect({
    connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath,
  });
  const relSpec = syntaxConn.relSpec;
  const appId = domain.selectors.getDefinitionsForFile(srcPath).find((s) => s.name === 'App').symbolId;

  // Target already imports App (default) and source already exports it inline.
  const tgtText = `import App from '${relSpec}';\nrender(<App />);\n`;

  const result = domain.commands.computeResolveEdits({
    edgeId, symbolIds: [appId], targetText: tgtText, sourceText: srcText,
  });

  // Import already present + export already inline → genuinely nothing to write.
  assert.equal(result.edits.length, 0, 'no edits when the symbol is already fully wired');
});

test('parser: `export default App` marks App as the default export, no phantom "default" symbol', () => {
  const domain = createSyntaxDomain();
  const srcPath = '/project/src/App.tsx';
  domain.commands.registerFile(srcPath, 'function App() { return null; }\n\nexport default App;\n');

  const defNames = domain.selectors.getDefinitionsForFile(srcPath).map((d) => d.name);
  assert.ok(defNames.includes('App'), 'App is a definition');
  assert.ok(!defNames.includes('default'), 'no phantom "default" symbol');

  const exports = domain.selectors.getExportCandidates(srcPath);
  const app = exports.find((e) => e.name === 'App');
  assert.ok(app, 'App is an export candidate');
  assert.equal(app.exportKind, 'default', 'App is the default export');
});

test('computeResolveEdits: resolving a default-exported symbol adds NO managed export block', () => {
  const domain = createSyntaxDomain();
  const srcPath = '/project/src/App.tsx';
  domain.commands.registerFile(srcPath, 'function App() { return null; }\n\nexport default App;\n');
  const tgtPath = '/project/src/main.tsx';
  domain.commands.registerFile(tgtPath, '// placeholder\n');

  const { edgeId } = domain.commands.connect({
    connectionId: 'c1', sourceFilePath: srcPath, targetFilePath: tgtPath,
  });
  const appId = domain.selectors.getDefinitionsForFile(srcPath).find((d) => d.name === 'App').symbolId;

  const result = domain.commands.computeResolveEdits({
    edgeId, symbolIds: [appId],
    targetText: '// fresh target\n',
    sourceText: 'function App() { return null; }\n\nexport default App;\n',
  });

  const srcEdit = result.edits.find((e) => e.filePath === srcPath);
  assert.equal(srcEdit, undefined, 'no source edit — App is already default-exported');

  const tgtEdit = result.edits.find((e) => e.filePath === tgtPath);
  assert.ok(tgtEdit, 'target gets the import');
  const importLine = tgtEdit.newText.split('\n').find((l) => l.includes('import'));
  assert.ok(/import\s+App\s+from/.test(importLine), 'default import form, not { App }');
  assert.ok(!importLine.includes('{'), 'no named braces for a default import');
});

test('computeResolveEdits: preserves existing quote style and is a no-op when already imported', () => {
  const domain = createSyntaxDomain();
  const srcPath = '/project/src/App.tsx';
  domain.commands.registerFile(srcPath, 'function App() {}\nexport default App;\n');
  const tgtPath = '/project/src/main.tsx';
  domain.commands.registerFile(tgtPath, '// x\n');
  const { edgeId, syntaxConn } = domain.commands.connect({
    connectionId: 'c1', sourceFilePath: srcPath, targetFilePath: tgtPath,
  });
  const appId = domain.selectors.getDefinitionsForFile(srcPath).find((d) => d.name === 'App').symbolId;

  // Target already imports App with DOUBLE quotes.
  const tgtText = `import App from "${syntaxConn.relSpec}";\n`;
  const result = domain.commands.computeResolveEdits({
    edgeId, symbolIds: [appId], targetText: tgtText, sourceText: 'function App() {}\nexport default App;\n',
  });

  assert.equal(result.edits.length, 0, 'already imported → no edits, no quote flip');
});

test('computeResolveEdits: closed-file scenario returns correct newText from passed-in text', () => {
  const domain = createSyntaxDomain();

  // Register source/target so the domain knows the definitions, but the adapter
  // would pass authoritative DISK text (here simulated) — not the cache.
  const srcPath = '/project/src/lib.js';
  domain.commands.registerFile(srcPath, 'export function doThing() {}\n');

  const tgtPath = '/project/src/consumer.js';
  domain.commands.registerFile(tgtPath, '// stale cache content that must be ignored\n');

  const { edgeId, syntaxConn } = domain.commands.connect({
    connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath,
  });
  const relSpec = syntaxConn.relSpec;

  const doThingId = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'doThing').symbolId;

  // Authoritative (disk) texts — DIFFERENT from what was registered.
  const diskTarget = "import { other } from './x';\nconst y = 1;\n";
  const diskSource = 'export function doThing() {}\n';

  const result = domain.commands.computeResolveEdits({
    edgeId,
    symbolIds: [doThingId],
    targetText: diskTarget,
    sourceText: diskSource,
  });

  const tgtEdit = result.edits.find((e) => e.filePath === tgtPath);
  assert.ok(tgtEdit, 'produces a target edit from passed-in disk text');
  // Built from the DISK target, not the stale cache.
  assert.ok(tgtEdit.newText.includes("import { other } from './x';"));
  assert.ok(tgtEdit.newText.includes('const y = 1;'));
  assert.ok(findImportLine(tgtEdit.newText, relSpec).includes('doThing'));
  assert.ok(!tgtEdit.newText.includes('stale cache content'));
});

test('computeResolveEdits: returns null for unknown edge', () => {
  const { domain } = setupDomain();
  assert.equal(
    domain.commands.computeResolveEdits({ edgeId: 'nope', symbolIds: ['x'], targetText: '', sourceText: '' }),
    null,
  );
});

test('computeResolveEdits: skips symbols already on the edge (idempotent merge)', () => {
  const domain = createSyntaxDomain();
  const srcPath = '/project/src/u.js';
  const srcText = 'export function a() {}\n';
  domain.commands.registerFile(srcPath, srcText);
  const tgtPath = '/project/src/c.js';
  domain.commands.registerFile(tgtPath, '// c\n');

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const aId = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'a').symbolId;

  domain.commands.computeResolveEdits({ edgeId, symbolIds: [aId], targetText: '// c\n', sourceText: srcText });
  // Re-resolve same symbol — should be a no-op (no new symbol added).
  const second = domain.commands.computeResolveEdits({
    edgeId, symbolIds: [aId], targetText: "import { a } from '../u';\n", sourceText: srcText,
  });
  assert.equal(second.edge.symbols.length, 1, 'symbol not added twice');
});

// ---------------------------------------------------------------------------
// computeRemoveEdits
// ---------------------------------------------------------------------------

test('computeRemoveEdits: removing one of two symbols rebuilds import + export in place', () => {
  const domain = createSyntaxDomain();
  const srcPath = '/project/src/u.js';
  const srcText = 'function a() {}\nfunction b() {}\n';
  domain.commands.registerFile(srcPath, srcText);
  const tgtPath = '/project/src/c.js';
  domain.commands.registerFile(tgtPath, '// c\n');

  const { edgeId, syntaxConn } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const relSpec = syntaxConn.relSpec;
  const defs = domain.selectors.getDefinitionsForFile(srcPath);

  // Resolve both via the consistent path to get current texts.
  const r1 = domain.commands.computeResolveEdits({
    edgeId,
    symbolIds: [defs.find((d) => d.name === 'a').symbolId, defs.find((d) => d.name === 'b').symbolId],
    targetText: '// c\n',
    sourceText: srcText,
  });
  const curTarget = r1.edits.find((e) => e.filePath === tgtPath).newText;
  const curSource = r1.edits.find((e) => e.filePath === srcPath).newText;

  const result = domain.commands.computeRemoveEdits({
    edgeId,
    symbolName: 'a',
    targetText: curTarget,
    sourceText: curSource,
  });

  assert.ok(result);
  assert.equal(result.edge.symbols.length, 1);
  assert.equal(result.edge.symbols[0].symbolName, 'b');

  const tgtEdit = result.edits.find((e) => e.filePath === tgtPath);
  assert.ok(tgtEdit.newText.includes('b'));
  // 'a' should no longer appear as an import specifier.
  const importLine = findImportLine(tgtEdit.newText, relSpec);
  assert.ok(!/\ba\b/.test(importLine.replace(/from\s*['"`].*$/, '')), 'a removed from import');

  const srcEdit = result.edits.find((e) => e.filePath === srcPath);
  if (srcEdit) {
    const exportLine = srcEdit.newText.split('\n').find((l) => /^export\s*\{/.test(l.trimStart()));
    assert.ok(exportLine.includes('b'));
    assert.ok(!/\ba\b/.test(exportLine.replace(/^export/, '')), 'a removed from export block');
  }
});

test('computeRemoveEdits: preserves export when another edge carries the same symbol', () => {
  const domain = createSyntaxDomain();

  const srcPath = '/project/src/shared.js';
  const srcText = 'export function util() {}\n';
  domain.commands.registerFile(srcPath, srcText);

  const tgt1 = '/project/src/a.js';
  const tgt2 = '/project/src/b.js';
  domain.commands.registerFile(tgt1, '// a\n');
  domain.commands.registerFile(tgt2, '// b\n');

  // Two edges from the same source, both carrying 'util'.
  const r1 = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgt1 });
  const r2 = domain.commands.connect({ connectionId: 'conn-2', sourceFilePath: srcPath, targetFilePath: tgt2 });
  const utilSym = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'util');
  domain.commands.resolveSymbolsMetadata({ edgeId: r1.edgeId, symbolIds: [utilSym.symbolId] });
  domain.commands.resolveSymbolsMetadata({ edgeId: r2.edgeId, symbolIds: [utilSym.symbolId] });

  // Removing util from edge1 must not emit a source-export edit — edge2 still carries it.
  const result = domain.commands.computeRemoveEdits({
    edgeId: r1.edgeId,
    symbolName: 'util',
    targetText: "import { util } from './shared';\n// a\n",
    sourceText: srcText,
  });

  assert.ok(result);
  const sourceEdit = result.edits.find((e) => e.filePath === srcPath);
  assert.equal(sourceEdit, undefined, 'no export removal while another edge carries the symbol');

  const edge2 = domain.selectors.getSyntaxEdge(r2.edgeId);
  assert.ok(edge2.symbols.some((s) => s.symbolName === 'util'), 'edge2 untouched');
});

test('computeRemoveEdits: returns null for unknown symbol', () => {
  const { domain, srcPath, tgtPath } = setupDomain();
  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  assert.equal(
    domain.commands.computeRemoveEdits({ edgeId, symbolName: 'nope', targetText: '', sourceText: '' }),
    null,
  );
});

// ---------------------------------------------------------------------------
// computeConnectStubEdit / computeDisconnectEdit
// ---------------------------------------------------------------------------

test('computeConnectStubEdit: writes stub after existing imports, not at top', () => {
  const domain = createSyntaxDomain();
  const srcPath = '/project/src/u.js';
  domain.commands.registerFile(srcPath, 'export function a() {}\n');
  const tgtPath = '/project/src/c.js';
  domain.commands.registerFile(tgtPath, "import { x } from './x';\nconst y = 1;\n");

  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });

  const targetText = "import { x } from './x';\nconst y = 1;\n";
  const result = domain.commands.computeConnectStubEdit({ edgeId, targetText });
  const edit = result.edits[0];
  assert.ok(edit);
  const lines = edit.newText.split('\n');
  // Stub appears on line index 1 (after the existing import), not at the top.
  assert.ok(lines[0].includes("import { x }"));
  assert.ok(lines[1].includes('TODO'));
});

test('computeConnectStubEdit: no stub when module already imported (dedup)', () => {
  const domain = createSyntaxDomain();
  const srcPath = '/project/src/u.js';
  domain.commands.registerFile(srcPath, 'export function a() {}\n');
  const tgtPath = '/project/src/c.js';
  domain.commands.registerFile(tgtPath, '// c\n');

  const { edgeId, syntaxConn } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const relSpec = syntaxConn.relSpec;

  const targetText = `import { a } from '${relSpec}';\n`;
  const result = domain.commands.computeConnectStubEdit({ edgeId, targetText });
  assert.deepEqual(result.edits, [], 'no stub added when an import from the module exists');
});

test('computeDisconnectEdit: removes the import line located in authoritative text', () => {
  const domain = createSyntaxDomain();
  const srcPath = '/project/src/u.js';
  domain.commands.registerFile(srcPath, 'export function a() {}\n');
  const tgtPath = '/project/src/c.js';
  domain.commands.registerFile(tgtPath, '// c\n');

  const { edgeId, syntaxConn } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const relSpec = syntaxConn.relSpec;
  const aId = domain.selectors.getExportCandidates(srcPath).find((s) => s.name === 'a').symbolId;
  domain.commands.computeResolveEdits({ edgeId, symbolIds: [aId], targetText: '// c\n', sourceText: 'export function a() {}\n' });

  const targetText = `import { a } from '${relSpec}';\nconst y = 1;\n`;
  const result = domain.commands.computeDisconnectEdit({ connectionId: 'conn-1', targetText, removeImport: true });
  assert.equal(result.edits.length, 1);
  assert.ok(!result.edits[0].newText.includes('import'));
  assert.ok(result.edits[0].newText.includes('const y = 1;'));
});

// ---------------------------------------------------------------------------
// Non-JS target guard — no import-line patch may EVER target a non-JS file
// (2026-07-17 pytest1 regression: renameFile's unguarded patchPlan replaced
// line 0 of a Python file — its real `from fastapi import FastAPI` — with the
// JS TODO stub.)
// ---------------------------------------------------------------------------

/** Create a domain with a py→py pending edge (mirrors the pytest1 layout). */
function setupPyDomain() {
  const domain = createSyntaxDomain();
  const srcPath = '/project/oAuth.py';
  const tgtPath = '/project/main/main.py';
  domain.commands.registerFile(srcPath, 'def shout():\n    pass\n');
  domain.commands.registerFile(tgtPath, 'from fastapi import FastAPI\n\napp = FastAPI()\n');
  return { domain, srcPath, tgtPath };
}

test('connect: non-JS target gets no patchPlan and a null importLine', () => {
  const { domain, srcPath, tgtPath } = setupPyDomain();
  const result = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  assert.ok(result.edgeId);
  assert.equal(result.patchPlan, null);
  assert.equal(domain.selectors.getSyntaxEdge(result.edgeId).importLine, null);
});

test('renameFile: pending py→py edge emits zero patchPlans but still renames edge metadata', () => {
  const { domain, srcPath, tgtPath } = setupPyDomain();
  domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });

  const newSrcPath = '/project/oauth_helper.py';
  const result = domain.commands.renameFile(srcPath, newSrcPath);

  assert.deepEqual(result.patchPlans, []);
  const edge = domain.selectors.getSyntaxEdgeForPair(newSrcPath, tgtPath);
  assert.ok(edge, 'edge follows the rename');
  assert.ok(edge.relSpec.includes('oauth_helper'), 'relSpec recomputed');
});

test('renameFile: pending JS edge still emits the stub rewrite (non-regression)', () => {
  const { domain, srcPath, tgtPath } = setupDomain();
  domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });

  const newSrcPath = '/project/src/lib/utils.js';
  const result = domain.commands.renameFile(srcPath, newSrcPath);

  assert.equal(result.patchPlans.length, 1);
  assert.equal(result.patchPlans[0].filePath, tgtPath);
  assert.ok(result.patchPlans[0].text.includes('TODO: select symbol'));
  assert.ok(result.patchPlans[0].text.includes('lib/utils'));
});

test('disconnectConnection: py edge yields no import-removal patchPlan', () => {
  const { domain, srcPath, tgtPath } = setupPyDomain();
  domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const result = domain.commands.disconnectConnection('conn-1');
  assert.equal(result.patchPlan, null);
});

test('computeConnectStubEdit: non-JS target returns empty edits (existing #127 guard)', () => {
  const { domain, srcPath, tgtPath } = setupPyDomain();
  const { edgeId } = domain.commands.connect({ connectionId: 'conn-1', sourceFilePath: srcPath, targetFilePath: tgtPath });
  const result = domain.commands.computeConnectStubEdit({
    edgeId,
    targetText: 'from fastapi import FastAPI\n\napp = FastAPI()\n',
  });
  assert.deepEqual(result.edits, []);
});
