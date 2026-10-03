import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyntaxDomain } from '../../src/app/syntaxDomain.js';

// P4c (2026-10-03): SyntaxDomain records, per registered file, the source and
// content revision of the text it parsed (brief §4.5/§7.4), minted by the
// owner and passed in — the domain never computes one. Exposed read-only via
// `getParsedRevision`. A registration without a revision records none.

const EDITOR = { source: 'editor', revision: 'b1-aaaa' };
const DISK = { source: 'disk', revision: 'd1-bbbb' };

test('a registration with a revision records its source and revision', () => {
  const domain = createSyntaxDomain();
  domain.commands.registerFile('/p/a.js', 'export const a = 1;\n', EDITOR);
  assert.deepEqual(domain.selectors.getParsedRevision('/p/a.js'), EDITOR);
});

test('a registration without a revision records none (reads unknown, never current)', () => {
  const domain = createSyntaxDomain();
  domain.commands.registerFile('/p/a.js', 'export const a = 1;\n');
  assert.equal(domain.selectors.getParsedRevision('/p/a.js'), null);
});

test('an unknown file has no parsed revision', () => {
  const domain = createSyntaxDomain();
  assert.equal(domain.selectors.getParsedRevision('/p/missing.js'), null);
});

test('a malformed revision argument records none', () => {
  const domain = createSyntaxDomain();
  domain.commands.registerFile('/p/a.js', 'x\n', { source: 'editor' }); // no revision
  assert.equal(domain.selectors.getParsedRevision('/p/a.js'), null);
  domain.commands.registerFile('/p/b.js', 'x\n', { source: 'bogus', revision: 'z1-1' });
  assert.equal(domain.selectors.getParsedRevision('/p/b.js'), null);
});

test('notifyFileChanged replaces the parsed revision', () => {
  const domain = createSyntaxDomain();
  domain.commands.registerFile('/p/a.js', 'v1\n', DISK);
  domain.commands.notifyFileChanged('/p/a.js', 'v2\n', EDITOR);
  assert.deepEqual(domain.selectors.getParsedRevision('/p/a.js'), EDITOR);
});

test('a later registration without a revision clears the previous one', () => {
  const domain = createSyntaxDomain();
  domain.commands.registerFile('/p/a.js', 'v1\n', DISK);
  domain.commands.notifyFileChanged('/p/a.js', 'v2\n'); // no revision
  assert.equal(domain.selectors.getParsedRevision('/p/a.js'), null);
});

test('registerFileIfAbsent carries the revision, and only when it registers', () => {
  const domain = createSyntaxDomain();
  assert.equal(domain.commands.registerFileIfAbsent('/p/a.js', 'v1\n', DISK), true);
  assert.deepEqual(domain.selectors.getParsedRevision('/p/a.js'), DISK);
  // Already present: no overwrite, revision unchanged.
  assert.equal(domain.commands.registerFileIfAbsent('/p/a.js', 'v2\n', EDITOR), false);
  assert.deepEqual(domain.selectors.getParsedRevision('/p/a.js'), DISK);
});

test('unregisterFile, forgetFile and reset drop the parsed revision', () => {
  const domain = createSyntaxDomain();
  domain.commands.registerFile('/p/a.js', 'x\n', DISK);
  domain.commands.unregisterFile('/p/a.js');
  assert.equal(domain.selectors.getParsedRevision('/p/a.js'), null);

  domain.commands.registerFile('/p/b.js', 'x\n', DISK);
  domain.commands.forgetFile('/p/b.js');
  assert.equal(domain.selectors.getParsedRevision('/p/b.js'), null);

  domain.commands.registerFile('/p/c.js', 'x\n', DISK);
  domain.commands.reset();
  assert.equal(domain.selectors.getParsedRevision('/p/c.js'), null);
});

test('a rename carries the parsed revision to the new path and drops the old', () => {
  const domain = createSyntaxDomain();
  domain.commands.registerFile('/p/old.js', 'export const a = 1;\n', DISK);
  domain.commands.renameFile('/p/old.js', '/p/new.js');
  assert.deepEqual(domain.selectors.getParsedRevision('/p/new.js'), DISK);
  assert.equal(domain.selectors.getParsedRevision('/p/old.js'), null);
});

test('the parsed revision is distinct from the identity counter (getFileRevision)', () => {
  const domain = createSyntaxDomain();
  domain.commands.registerFile('/p/a.js', 'x\n', DISK);
  const identity = domain.selectors.getFileRevision('/p/a.js');
  assert.equal(typeof identity, 'number');
  // Stamping a new identity revision must not touch the parsed (content) one.
  domain.commands.stampFileRevision('/p/a.js');
  assert.notEqual(domain.selectors.getFileRevision('/p/a.js'), identity);
  assert.deepEqual(domain.selectors.getParsedRevision('/p/a.js'), DISK);
});

// -- Provenance (task 3) ----------------------------------------------------

test('getProvenanceForConnection reports manual for a wire with no syntax edge', () => {
  const domain = createSyntaxDomain();
  assert.deepEqual(domain.selectors.getProvenanceForConnection('conn_x'), { provenance: 'manual' });
});

test('getProvenanceForConnection reports sourceDerived with status and symbols', () => {
  const domain = createSyntaxDomain();
  const source = '/p/utils.js';
  const target = '/p/app.js';
  domain.commands.registerFile(source, 'export function helper() {}\n', DISK);
  domain.commands.registerFile(target, "import { helper } from './utils';\nhelper();\n", DISK);
  const { edgeId } = domain.commands.connectDiscovered({
    connectionId: 'conn_1',
    sourceFilePath: source,
    targetFilePath: target,
    moduleSpecifier: './utils',
  });
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [`${source}::helper`] });

  const prov = domain.selectors.getProvenanceForConnection('conn_1');
  assert.equal(prov.provenance, 'sourceDerived');
  assert.equal(prov.sourceFilePath, source);
  assert.equal(prov.targetFilePath, target);
  assert.equal(prov.status, 'resolved');
  assert.deepEqual(prov.symbols, [{ name: 'helper', kind: 'named' }]);
});

test('getAllEdgeProvenance lists every edge with endpoints and status', () => {
  const domain = createSyntaxDomain();
  domain.commands.registerFile('/p/utils.js', 'export function helper() {}\n', DISK);
  domain.commands.registerFile('/p/app.js', "import { helper } from './utils';\n", DISK);
  domain.commands.connectDiscovered({
    connectionId: 'conn_1',
    sourceFilePath: '/p/utils.js',
    targetFilePath: '/p/app.js',
    moduleSpecifier: './utils',
  });
  const all = domain.selectors.getAllEdgeProvenance();
  assert.equal(all.length, 1);
  assert.equal(all[0].sourceFilePath, '/p/utils.js');
  assert.equal(all[0].targetFilePath, '/p/app.js');
  assert.deepEqual(all[0].connectionIds, ['conn_1']);
});
