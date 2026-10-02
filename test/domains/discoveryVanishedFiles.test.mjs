import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyntaxDomain } from '../../src/app/syntaxDomain.js';
import { forgetVanishedFiles } from '../../src/app/useDiscoveryLifecycle.js';

// P4 (owner ruling 2026-10-01): discovery registered every file it found and
// never unregistered one that had gone — deleted from a terminal, a git
// checkout, another editor. The file stayed indexed as `ok`, its wires
// resolved, and the graph query (which reads this index) would have shown
// a file that no longer exists. A re-run now forgets the files its previous
// run registered that the listing no longer has.

const UTILS = 'export function helper() {}\n';
const APP = "import { helper } from './utils';\nhelper();\n";

function indexed() {
  const domain = createSyntaxDomain();
  domain.commands.registerFile('/proj/src/utils.ts', UTILS);
  domain.commands.registerFile('/proj/src/app.ts', APP);
  const { edgeId } = domain.commands.connectDiscovered({
    connectionId: 'conn_1',
    sourceFilePath: '/proj/src/utils.ts',
    targetFilePath: '/proj/src/app.ts',
    moduleSpecifier: './utils',
    importLine: 0,
  });
  return { domain, edgeId };
}

test('a file discovery registered that is gone from the listing is forgotten', () => {
  const { domain, edgeId } = indexed();
  const forgotten = forgetVanishedFiles({
    syntaxDomain: domain,
    root: '/proj',
    previous: new Set(['/proj/src/utils.ts', '/proj/src/app.ts']),
    listed: ['/proj/src/app.ts'],
  });
  assert.deepEqual(forgotten, ['/proj/src/utils.ts']);
  assert.equal(domain.selectors.getFileStatus('/proj/src/utils.ts'), undefined);
  const edge = domain.selectors.getSyntaxEdge(edgeId);
  assert.equal(edge.status, 'broken', 'the importer\'s import is real and now broken');
  assert.equal(domain.selectors.getEdgeIdForConnection('conn_1'), edgeId, 'the piece and its wire are still on the canvas');
});

test('a vanished importer takes its edges with it', () => {
  const { domain, edgeId } = indexed();
  forgetVanishedFiles({
    syntaxDomain: domain,
    root: '/proj',
    previous: new Set(['/proj/src/utils.ts', '/proj/src/app.ts']),
    listed: ['/proj/src/utils.ts'],
  });
  assert.equal(domain.selectors.getSyntaxEdge(edgeId), null);
});

test('an open buffer, a file outside the project, and files discovery never registered are left alone', () => {
  const { domain } = indexed();
  domain.commands.registerFile('/other/x.ts', UTILS);
  domain.commands.registerFile('/proj/node_modules/pkg/index.d.ts', UTILS); // opened by the user, never listed
  const forgotten = forgetVanishedFiles({
    syntaxDomain: domain,
    root: '/proj',
    previous: new Set(['/proj/src/utils.ts', '/other/x.ts']),
    listed: [],
    isHeldOpen: (path) => path === '/proj/src/utils.ts',
  });
  assert.deepEqual(forgotten, []);
  for (const path of ['/proj/src/utils.ts', '/other/x.ts', '/proj/node_modules/pkg/index.d.ts']) {
    assert.equal(domain.selectors.getFileStatus(path), 'ok', path);
  }
});
