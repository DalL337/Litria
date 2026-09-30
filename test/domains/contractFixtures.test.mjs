import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  OPERATIONS,
  createProjectApiAdapter,
  documentReadFromBuffer,
} from '../support/project-api-adapter.mjs';

// ADR-033 S0: the JavaScript half of the contract schema proof.
//
// The committed artifacts under src-tauri/contracts/project-api/v0 are the
// contract; the fixtures beside them are sampled evidence. The Rust suite
// (src-tauri/src/contracts) proves the Rust boundary and the schemas agree on
// every fixture and that the result fixtures are exactly what Rust emits.
// These tests run the JavaScript adapter against the same files, mocking only
// the transport: a request it builds must match an accepted fixture and use
// only fields the inbound schema declares; a result fixture must be read
// correctly — identifiers kept as strings, unfamiliar fields ignored, an
// unfamiliar outcome kind surfaced as unknown. No JSON Schema validator is
// needed on this side.

const CONTRACT_DIR = new URL('../../src-tauri/contracts/project-api/v0/', import.meta.url);

function artifact(name) {
  return JSON.parse(readFileSync(new URL(name, CONTRACT_DIR), 'utf8'));
}

function fixture(name) {
  return artifact(`fixtures/${name}`);
}

const catalog = artifact('catalog.json');
const manifest = fixture('manifest.json');

function acceptedFixture(name) {
  const entry = manifest.fixtures.find((candidate) => candidate.file === name);
  assert.ok(entry, `${name} is listed in the fixture manifest`);
  assert.equal(entry.expect, 'accept', `${name} is an accepted fixture`);
  return fixture(name);
}

/** A transport that records requests and answers with a fixed result. */
function recordingTransport(result = {}) {
  const calls = [];
  return {
    calls,
    call: async (operation, request) => {
      calls.push({ operation, request });
      return result;
    },
  };
}

function requestSchema(operation) {
  const entry = catalog.operations.find((candidate) => candidate.name === operation);
  assert.ok(entry, `${operation} is in the committed catalog`);
  return artifact(entry.request);
}

/** Every field the adapter sends is declared by the inbound schema. */
function assertDeclaredFields(operation, request) {
  const declared = Object.keys(requestSchema(operation).properties);
  for (const key of Object.keys(request)) {
    assert.ok(declared.includes(key), `${operation}: the adapter sends undeclared field "${key}"`);
  }
}

test('adapter operation names are exactly the committed catalog', () => {
  assert.deepEqual(
    Object.values(OPERATIONS).sort(),
    catalog.operations.map((operation) => operation.name).sort(),
  );
});

test('projectContext requests match the accepted fixtures', async () => {
  const cases = [
    [undefined, 'project_context.request.default.json'],
    [{ includeSelection: true }, 'project_context.request.selection.json'],
  ];
  for (const [options, file] of cases) {
    const transport = recordingTransport(fixture('project_context.result.json'));
    await createProjectApiAdapter(transport).projectContext(options);
    const [{ operation, request }] = transport.calls;
    assert.equal(operation, OPERATIONS.projectContext);
    assert.deepEqual(request, acceptedFixture(file), file);
    assertDeclaredFields(operation, request);
  }
});

test('filesRead requests match the accepted fixtures', async () => {
  const cases = [
    [{ paths: ['src/auth.ts'] }, 'files_read.request.minimal.json'],
    [
      { paths: ['src/auth.ts', 'README.md'], source: 'disk', maxBytesPerDocument: 65536 },
      'files_read.request.disk.json',
    ],
  ];
  for (const [options, file] of cases) {
    const transport = recordingTransport(fixture('files_read.result.json'));
    await createProjectApiAdapter(transport).filesRead(options);
    const [{ operation, request }] = transport.calls;
    assert.equal(operation, OPERATIONS.filesRead);
    assert.deepEqual(request, acceptedFixture(file), file);
    assertDeclaredFields(operation, request);
  }
});

test('project context results are read as Rust emits them', async () => {
  const bare = await createProjectApiAdapter(
    recordingTransport(fixture('project_context.result.json')),
  ).projectContext();
  assert.deepEqual(bare.selection, [], 'an omitted selection reads as empty');
  assert.equal(bare.workspaceEpoch, 'ws-12');
  assert.equal(typeof bare.workspaceEpoch, 'string');

  const selected = await createProjectApiAdapter(
    recordingTransport(fixture('project_context.result.with-selection.json')),
  ).projectContext({ includeSelection: true });
  assert.deepEqual(selected.selection, [
    { nodeId: 'node-7f3a', path: 'src/auth.ts' },
    { nodeId: 'node-group-02', path: null },
  ]);
  assert.deepEqual(
    selected.languages.find((language) => language.languageId === 'go'),
    {
      languageId: 'go',
      documentAccess: true,
      diagnostics: true,
      navigation: false,
      symbols: false,
      relationshipDiscovery: false,
      sourceTransformations: false,
    },
  );
});

test('files read results keep identifiers as strings and read every outcome', async () => {
  const { documents } = await createProjectApiAdapter(
    recordingTransport(fixture('files_read.result.json')),
  ).filesRead({ paths: ['src/auth.ts'] });
  assert.deepEqual(
    documents.map((document) => document.kind),
    ['read', 'read', 'notFound', 'denied', 'tooLarge'],
  );
  const [editor, disk] = documents;
  // 2^53 + 1 survives only as a string; a numeric conversion would change it.
  assert.equal(editor.documentId, 'doc-9007199254740993');
  assert.equal(typeof editor.documentId, 'string');
  assert.equal(typeof editor.revision, 'string');
  assert.equal(editor.dirty, true);
  assert.equal(disk.dirty, false);
  assert.equal(documents[4].limitBytes, 1048576);
});

test('a producer that omits dirty is read as clean', async () => {
  const { documents } = await createProjectApiAdapter(
    recordingTransport(fixture('files_read.result.dirty-omitted.json')),
  ).filesRead({ paths: ['src/auth.ts'] });
  assert.equal(documents[0].dirty, false);
});

test('unfamiliar output fields are ignored', async () => {
  const withExtras = await createProjectApiAdapter(
    recordingTransport(fixture('files_read.result.additive-field.json')),
  ).filesRead({ paths: ['src/auth.ts'] });
  const base = fixture('files_read.result.json');
  const expected = await createProjectApiAdapter(
    recordingTransport({ documents: [base.documents[0], base.documents[2]] }),
  ).filesRead({ paths: ['src/auth.ts'] });
  assert.deepEqual(withExtras, expected);
});

test('an unfamiliar outcome kind is surfaced as unknown, never as a known outcome', async () => {
  const { documents } = await createProjectApiAdapter(
    recordingTransport(fixture('files_read.result.unknown-kind.json')),
  ).filesRead({ paths: ['src/a.ts'] });
  assert.deepEqual(documents[0], { kind: 'unknown', rawKind: 'moved' });
  assert.equal(documents[1].kind, 'notFound', 'known outcomes around it are still read');
});

test('the bridge-side producer emits the exact shape Rust accepts', () => {
  const emitted = fixture('files_read.result.json').documents[0];
  const produced = documentReadFromBuffer({
    path: 'src/auth.ts',
    documentId: 'doc-9007199254740993',
    revision: 'rev-42',
    dirty: true,
    text: 'export function signIn() {}\n',
  });
  assert.deepEqual(produced, emitted);
});
