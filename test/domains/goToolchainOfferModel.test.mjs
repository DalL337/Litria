import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GOPLS_INSTALL_COMMAND,
  GOPLS_VERSION,
  buildGoInstallOfferMessage,
  buildGoToolchainHintMessage,
  decideGoOffer,
  goOfferKey,
  isGoFilename
} from '../../src/app/goToolchainOfferModel.js';

const GO_PRESENT = {
  languageId: 'go',
  allMet: true,
  probes: [{ displayName: 'Go toolchain (go)', command: 'go', available: true }],
  resolutionTier: null
};

const GO_MISSING = {
  languageId: 'go',
  allMet: false,
  probes: [{ displayName: 'Go toolchain (go)', command: 'go', available: false }],
  resolutionTier: null
};

test('go filename matcher', () => {
  assert.equal(isGoFilename('cmd/main.go'), true);
  assert.equal(isGoFilename('CMD/MAIN.GO'), true);
  assert.equal(isGoFilename('main.rs'), false);
  assert.equal(isGoFilename('go.mod'), false);
  assert.equal(isGoFilename(null), false);
});

test('install command is pinned, never @latest (security-policy trust rule)', () => {
  assert.match(GOPLS_VERSION, /^v\d+\.\d+\.\d+$/);
  assert.equal(GOPLS_INSTALL_COMMAND, `go install golang.org/x/tools/gopls@${GOPLS_VERSION}`);
  assert.doesNotMatch(GOPLS_INSTALL_COMMAND, /@latest/);
});

test('resolved gopls (any tier) raises no offer — the lifecycle owns it', () => {
  for (const tier of ['global', 'managed', 'bundled']) {
    const offer = decideGoOffer({
      prerequisites: { ...GO_PRESENT, resolutionTier: tier },
      offeredKeys: new Set(),
      projectId: 'p1'
    });
    assert.equal(offer, null, `tier '${tier}' must not offer`);
  }
});

test('toolchain present + gopls missing → class-3 install offer', () => {
  const offer = decideGoOffer({
    prerequisites: GO_PRESENT,
    offeredKeys: new Set(),
    projectId: 'p1'
  });
  assert.equal(offer.kind, 'install');
  assert.equal(offer.key, goOfferKey('p1'));
});

test('toolchain missing → honest hint, never an install command', () => {
  const offer = decideGoOffer({
    prerequisites: GO_MISSING,
    offeredKeys: new Set(),
    projectId: 'p1'
  });
  assert.equal(offer.kind, 'toolchain-hint');
});

test('one offer per project per session; missing inputs offer nothing', () => {
  const offeredKeys = new Set([goOfferKey('p1')]);
  assert.equal(decideGoOffer({ prerequisites: GO_PRESENT, offeredKeys, projectId: 'p1' }), null);
  assert.notEqual(decideGoOffer({ prerequisites: GO_PRESENT, offeredKeys, projectId: 'p2' }), null);
  assert.equal(decideGoOffer({ prerequisites: null, offeredKeys: new Set(), projectId: 'p1' }), null);
  assert.equal(decideGoOffer({ prerequisites: GO_PRESENT, offeredKeys: new Set(), projectId: null }), null);
});

test('offer copy carries the exact command, provenance, and honest follow-up', () => {
  const message = buildGoInstallOfferMessage();
  assert.ok(message.includes(GOPLS_INSTALL_COMMAND), 'the exact command IS the consent copy (A3)');
  assert.match(message, /checksum database/);
  assert.match(message, /pinned version/);
  // Class-3 cannot observe the terminal command finishing — the copy must
  // not promise an auto-start it cannot deliver.
  assert.match(message, /[Rr]eopen the Go file/);
});

test('toolchain hint names the gap and the remedy without installing anything', () => {
  const message = buildGoToolchainHintMessage();
  assert.match(message, /no Go toolchain/);
  assert.match(message, /go\.dev/);
  assert.doesNotMatch(message, /go install/);
});
