import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInstallFailureMessage,
  buildInstallSuccessMessage,
  buildServerOfferMessage,
  clearOfferedKeysForLanguage,
  decideServerOffer,
  matchRegistryLanguage,
  offerKey
} from '../../src/app/managedServerOffersModel.js';

const PAYLOAD = {
  platformKey: 'windows-x64',
  installed: {},
  registry: {
    version: 1,
    servers: {
      rust: {
        name: 'Rust',
        extensions: ['.rs'],
        server: 'rust-analyzer',
        version: '2026-07-06',
        command: 'rust-analyzer',
        args: [],
        artifacts: {
          'windows-x64': {
            url: 'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-06/x.zip',
            sha256: 'ab'.repeat(32)
          }
        }
      },
      cpp: {
        name: 'C/C++',
        extensions: ['.c', '.cpp', '.hpp'],
        server: 'clangd',
        version: '22.1.6',
        command: 'clangd',
        args: [],
        // No windows artifact → unsupported on this payload's platform.
        artifacts: {
          'linux-x64': { url: 'https://github.com/clangd/clangd/releases/x.zip', sha256: 'cd'.repeat(32) }
        }
      }
    }
  }
};

test('extension matching finds registry languages case-insensitively', () => {
  assert.equal(matchRegistryLanguage(PAYLOAD, 'main.rs').languageId, 'rust');
  assert.equal(matchRegistryLanguage(PAYLOAD, 'MAIN.RS').languageId, 'rust');
  assert.equal(matchRegistryLanguage(PAYLOAD, 'view.hpp').languageId, 'cpp');
  assert.equal(matchRegistryLanguage(PAYLOAD, 'app.py'), null);
  assert.equal(matchRegistryLanguage(PAYLOAD, 'noext'), null);
  assert.equal(matchRegistryLanguage(PAYLOAD, '.rs'), null);
});

test('offer raised for uninstalled, platform-supported language', () => {
  const match = matchRegistryLanguage(PAYLOAD, 'main.rs');
  const offer = decideServerOffer({
    match,
    registryPayload: PAYLOAD,
    offeredKeys: new Set(),
    projectId: 'p1'
  });
  assert.equal(offer.languageId, 'rust');
  assert.equal(offer.key, offerKey('p1', 'rust'));
});

test('no offer when the server is already installed (receipts are truth)', () => {
  const payload = { ...PAYLOAD, installed: { 'rust-analyzer': '2026-07-06' } };
  const match = matchRegistryLanguage(payload, 'main.rs');
  assert.equal(
    decideServerOffer({ match, registryPayload: payload, offeredKeys: new Set(), projectId: 'p1' }),
    null
  );
});

test('no offer when this platform has no artifact — never offer the uninstallable', () => {
  const match = matchRegistryLanguage(PAYLOAD, 'main.cpp');
  assert.equal(
    decideServerOffer({ match, registryPayload: PAYLOAD, offeredKeys: new Set(), projectId: 'p1' }),
    null
  );
});

test('one offer per project per session; other projects still get theirs', () => {
  const match = matchRegistryLanguage(PAYLOAD, 'main.rs');
  const offered = new Set([offerKey('p1', 'rust')]);
  assert.equal(
    decideServerOffer({ match, registryPayload: PAYLOAD, offeredKeys: offered, projectId: 'p1' }),
    null
  );
  assert.ok(
    decideServerOffer({ match, registryPayload: PAYLOAD, offeredKeys: offered, projectId: 'p2' })
  );
});

test('uninstall clears a language\'s offered keys across projects, others survive', () => {
  const offered = new Set([
    offerKey('p1', 'rust'),
    offerKey('p2', 'rust'),
    offerKey('p1', 'cpp'),
  ]);
  clearOfferedKeysForLanguage(offered, 'rust');
  assert.deepEqual([...offered], [offerKey('p1', 'cpp')]);
  // Guard cases: never throws, never mutates on bad input.
  clearOfferedKeysForLanguage(offered, null);
  clearOfferedKeysForLanguage(null, 'rust');
  assert.deepEqual([...offered], [offerKey('p1', 'cpp')]);
});

test('same-session re-offer after uninstall: clear keys + fresh payload → offer returns', () => {
  const match = matchRegistryLanguage(PAYLOAD, 'main.rs');
  const offered = new Set();

  // First open offers, and the key suppresses a second prompt (A3).
  const first = decideServerOffer({ match, registryPayload: PAYLOAD, offeredKeys: offered, projectId: 'p1' });
  assert.ok(first);
  offered.add(first.key);
  assert.equal(
    decideServerOffer({ match, registryPayload: PAYLOAD, offeredKeys: offered, projectId: 'p1' }),
    null
  );

  // Install lands → receipts show it → no offer even with keys cleared.
  const installedPayload = { ...PAYLOAD, installed: { 'rust-analyzer': '2026-07-06' } };
  clearOfferedKeysForLanguage(offered, 'rust');
  assert.equal(
    decideServerOffer({ match, registryPayload: installedPayload, offeredKeys: offered, projectId: 'p1' }),
    null
  );

  // Uninstall: fresh receipts + cleared keys → the offer comes back THIS session.
  assert.ok(
    decideServerOffer({ match, registryPayload: PAYLOAD, offeredKeys: offered, projectId: 'p1' })
  );
});

test('offer copy is provenance-first (A3: show exactly what will happen)', () => {
  const entry = PAYLOAD.registry.servers.rust;
  const message = buildServerOfferMessage(entry, 'windows-x64');
  assert.match(message, /rust-analyzer 2026-07-06/);
  assert.match(message, /github\.com/);
  assert.match(message, /SHA-256 verified/);
  assert.match(message, /pinned version/);
});

test('outcome copy stays honest', () => {
  const entry = PAYLOAD.registry.servers.rust;
  assert.match(buildInstallSuccessMessage(entry), /reopen the file/);
  assert.match(buildInstallFailureMessage(entry, 'checksum mismatch'), /checksum mismatch/);
});

test('success copy promises auto-start only when the lifecycle can deliver it (Slice 6)', () => {
  const entry = PAYLOAD.registry.servers.rust;
  const autoStarted = buildInstallSuccessMessage(entry, { autoStart: true });
  assert.match(autoStarted, /starting the language server/);
  assert.doesNotMatch(autoStarted, /reopen the file/);
  // Without a domain to start the session, the old honest copy stands.
  assert.match(buildInstallSuccessMessage(entry, { autoStart: false }), /reopen the file/);
});
