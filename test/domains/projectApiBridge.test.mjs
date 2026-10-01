import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BRIDGE_OPS,
  BRIDGE_REQUEST_EVENT,
  MAX_REPLY_BYTES,
  answerBufferIndex,
  answerDocuments,
  answerSelection,
  bufferRevision,
  createProjectApiBridge,
  deriveReadyEpoch,
  selectionSnapshot,
  serializeAttachments,
  sliceLines,
  utf8Length
} from '../../src/app/projectApiBridge.js';
import {
  editorSessionReducer as reduce,
  getActiveSessionDocument,
  getSessionDocumentsByPath,
  initialEditorSessionState
} from '../../src/editor/editorSessionDomain.js';
import { buildCapabilityMatrix, languageServerState } from '../../src/app/languageCapabilities.js';

// Project API build plan P2: the JavaScript half of the `project-api-bridge`
// contract (ADR-033 decision 4). The committed artifacts under
// src-tauri/contracts/project-api-bridge/v1 are the contract. Rust proves its
// request fixtures are exactly what it emits and that its reply boundary and
// the reply schemas agree on every reply fixture. These tests run the REAL
// bridge module against the same files, with only the transport and the
// owner state mocked: answering a committed request must produce the
// committed reply, field for field and identifier for identifier.

const CONTRACT_DIR = new URL('../../src-tauri/contracts/project-api-bridge/v1/', import.meta.url);
const artifact = (name) => JSON.parse(readFileSync(new URL(name, CONTRACT_DIR), 'utf8'));
const fixture = (name) => artifact(`fixtures/${name}`);
const catalog = artifact('catalog.json');
const manifest = fixture('manifest.json');

function acceptedFixture(name) {
  const entry = manifest.fixtures.find((candidate) => candidate.file === name);
  assert.ok(entry, `${name} is listed in the fixture manifest`);
  assert.equal(entry.expect, 'accept', `${name} is an accepted fixture`);
  return fixture(name);
}

/** Every property name the operation's reply schema declares, anywhere. */
function declaredReplyFields(operation) {
  const entry = catalog.operations.find((candidate) => candidate.name === operation);
  assert.ok(entry, `${operation} is in the committed catalog`);
  const names = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      if (node.properties) Object.keys(node.properties).forEach((name) => names.add(name));
      Object.values(node).forEach(walk);
    }
  };
  walk(artifact(entry.reply));
  return names;
}

/** Every key the bridge sends is one the reply schema declares. */
function assertDeclared(operation, reply) {
  const declared = declaredReplyFields(operation);
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        assert.ok(declared.has(key), `${operation}: the bridge sends undeclared field "${key}"`);
        walk(value);
      }
    }
  };
  walk(reply);
}

// ─── Fixture session ───────────────────────────────────────────────────────
// The editor session the committed reply fixtures describe.

function tab(id, filename, code, workingCode = code) {
  return { id, pieceId: id, filename, code, workingCode, paneId: 1 };
}

function fixtureSession() {
  const tabs = [
    tab(1, 'src/open.ts', 'export const a = 0;\n', 'export const a = 1;\n'),
    tab(2, 'src/closed-dirty.ts', 'let x = 1;\n', 'let x = 2;\n'),
    tab(3, 'src/closed-clean.ts', 'same\n'),
    tab(4, 'src/lines.ts', 'one\ntwo\nthree\nfour\n'),
    tab(5, 'dist/bundle.min.js', '!function(){var a=1}();')
  ];
  return {
    ...initialEditorSessionState,
    openTabIds: [1, 4, 5],
    tabsById: Object.fromEntries(tabs.map((entry) => [entry.id, entry]))
  };
}

/** A transport that records every call; attach mints `g3`, `g4`, … */
function fakeTransport({ firstGeneration = 3, refuse = () => false } = {}) {
  let next = firstGeneration;
  const calls = [];
  const replies = [];
  return {
    calls,
    replies,
    attach: async (epoch) => {
      calls.push(['attach', epoch]);
      if (refuse(epoch)) throw { code: 'workspaceChanged' };
      return `g${next++}`;
    },
    detach: async (generation) => {
      calls.push(['detach', generation]);
      return true;
    },
    reply: async (requestId, generation, text) => {
      replies.push({ requestId, generation, reply: JSON.parse(text), text });
    }
  };
}

// The canvas the committed selection reply describes: pieces 2 and 5 are
// selected (5 twice, and stored with a Windows separator), group g1 is a
// folder group, and the focused pane shows piece 5's file with an edit.
function fixtureWorkspace() {
  return {
    selectedIds: [5, 2, 5, 99],
    piecesById: new Map([
      [2, { id: 2, filename: 'src/session.ts' }],
      [5, { id: 5, filename: 'src\\auth.ts' }],
      [7, { id: 7, filename: 'README.md' }]
    ]),
    selectedGroupId: 'g1',
    groups: [{ id: 'g1', folderPath: 'src' }, { id: 'g2', name: 'manual' }]
  };
}

function fixtureActiveSession() {
  const auth = tab(5, 'src/auth.ts', 'export {};\n', 'export function signIn() {}\n');
  return { ...initialEditorSessionState, openTabIds: [5], tabsById: { 5: auth } };
}

async function readyBridge({ session = fixtureSession(), epoch = 'ws-7', workspaceEpoch = epoch, ceiling } = {}) {
  const transport = fakeTransport();
  let current = workspaceEpoch;
  const holder = {
    session,
    workspace: fixtureWorkspace(),
    active: getActiveSessionDocument(fixtureActiveSession(), 5),
    languages: []
  };
  const bridge = createProjectApiBridge({
    ports: {
      sessionDocuments: () => getSessionDocumentsByPath(holder.session),
      selection: () => selectionSnapshot(holder.workspace, holder.active),
      languageCapabilities: () => holder.languages
    },
    transport,
    getWorkspaceEpoch: () => current,
    ...(ceiling ? { ceiling } : {})
  });
  await bridge.setReadyEpoch(epoch);
  return {
    bridge,
    transport,
    holder,
    setWorkspaceEpoch: (value) => { current = value; }
  };
}

const documentsRequest = (documents, maxTextBytes = 262144) => ({
  requestId: 'r9', epoch: 'ws-7', generation: 'g3', op: BRIDGE_OPS.documents, request: { documents, maxTextBytes }
});

// ─── The committed contract ────────────────────────────────────────────────

test('bridge names and limits are exactly the committed catalog', () => {
  assert.equal(catalog.family, 'project-api-bridge');
  assert.equal(BRIDGE_REQUEST_EVENT, catalog.event);
  assert.equal(MAX_REPLY_BYTES, catalog.maxReplyBytes);
  assert.deepEqual(
    Object.values(BRIDGE_OPS).sort(),
    catalog.operations.map((operation) => operation.name).sort()
  );
});

test('editor.documents: the committed request gets the committed reply', async () => {
  const { bridge, transport } = await readyBridge();
  const request = acceptedFixture('editor.documents.request.json');
  assert.equal(bridge.handleRequest(request), true);
  assert.equal(transport.replies.length, 1);
  const [{ requestId, generation, reply }] = transport.replies;
  // Identifiers are echoed exactly, as strings.
  assert.equal(requestId, 'r1');
  assert.equal(generation, 'g3');
  assert.deepEqual(reply, acceptedFixture('editor.documents.reply.json'));
  assertDeclared(BRIDGE_OPS.documents, reply);
});

test('editor.bufferIndex: the committed request gets the committed reply', async () => {
  const { bridge, transport } = await readyBridge();
  bridge.handleRequest(acceptedFixture('editor.bufferIndex.request.json'));
  const [{ requestId, generation, reply }] = transport.replies;
  assert.equal(requestId, 'r1');
  assert.equal(generation, 'g3');
  assert.deepEqual(reply, acceptedFixture('editor.bufferIndex.reply.json'));
  assertDeclared(BRIDGE_OPS.bufferIndex, reply);
});

test('an unfamiliar operation is refused, never served as a known one', async () => {
  const { bridge, transport } = await readyBridge();
  for (const op of ['editor.documentsV2', 'editor.documents ', 'Editor.Documents', undefined]) {
    bridge.handleRequest({ ...acceptedFixture('editor.documents.request.json'), requestId: `r-${op}`, op });
  }
  for (const { reply } of transport.replies) {
    assert.deepEqual(reply, acceptedFixture('editor.documents.reply.unknown-operation.json'));
  }
  assert.equal(transport.replies.length, 4);
});

test('the epoch check refuses a request whose epoch is not the ready and current one', async () => {
  const cases = [
    { epoch: 'ws-6', workspace: 'ws-7', why: 'request for another workspace' },
    { epoch: 'ws-7', workspace: 'ws-8', why: 'the global epoch has already moved on' }
  ];
  for (const { epoch, workspace, why } of cases) {
    const { bridge, transport, setWorkspaceEpoch } = await readyBridge();
    setWorkspaceEpoch(workspace);
    bridge.handleRequest({ ...acceptedFixture('editor.documents.request.json'), epoch });
    assert.deepEqual(transport.replies[0].reply, acceptedFixture('editor.documents.reply.workspace-changed.json'), why);
  }
});

test('a request for another generation is ignored, and each request is answered once', async () => {
  const { bridge, transport } = await readyBridge();
  const request = acceptedFixture('editor.documents.request.json');
  assert.equal(bridge.handleRequest({ ...request, generation: 'g2' }), false);
  assert.equal(transport.replies.length, 0);
  assert.equal(bridge.handleRequest(request), true);
  assert.equal(bridge.handleRequest(request), false);
  assert.equal(transport.replies.length, 1);
});

test('a malformed request is refused as invalidRequest', async () => {
  const { bridge, transport } = await readyBridge();
  for (const request of [null, {}, { documents: [], maxTextBytes: 1 }, { documents: [{ path: 1, maxBytes: 4 }], maxTextBytes: 1 }]) {
    bridge.handleRequest({ ...documentsRequest([]), requestId: `r${transport.replies.length}`, request });
  }
  assert.ok(transport.replies.every(({ reply }) => reply.kind === 'error' && reply.code === 'invalidRequest'));
});

// ─── Session truth ─────────────────────────────────────────────────────────

test('a closed dirty tab is served from the session', async () => {
  let state = reduce(initialEditorSessionState, {
    type: 'OPEN_FOR_PIECE',
    piece: { id: 9, filename: 'notes.md', code: 'saved\n', workingCode: 'saved\n' }
  });
  state = reduce(state, { type: 'UPDATE_WORKING_CODE', tabId: 9, workingCode: 'typed, not saved\n' });
  state = reduce(state, { type: 'CLOSE_TAB', tabId: 9 });
  const { bridge, transport } = await readyBridge({ session: state });
  bridge.handleRequest(documentsRequest([{ path: 'notes.md', maxBytes: 1024 }]));
  const [entry] = transport.replies[0].reply.result.documents;
  assert.equal(entry.kind, 'buffer');
  assert.equal(entry.state, 'closedDirty');
  assert.equal(entry.dirty, true);
  assert.equal(entry.text, 'typed, not saved\n');
});

test('the revision is stable across calls and changes after an edit', async () => {
  const { bridge, transport, holder } = await readyBridge();
  const ask = (requestId) => bridge.handleRequest({
    ...documentsRequest([{ path: 'src/lines.ts', startLine: 1, endLine: 1, maxBytes: 1024 }]),
    requestId
  });
  ask('r1');
  ask('r2');
  holder.session = reduce(holder.session, { type: 'UPDATE_WORKING_CODE', tabId: 4, workingCode: 'one\ntwo\nthree\nfive\n' });
  ask('r3');
  const revisions = transport.replies.map(({ reply }) => reply.result.documents[0].revision);
  assert.equal(revisions[0], revisions[1], 'unchanged text keeps its revision');
  assert.notEqual(revisions[1], revisions[2], 'an edit outside the slice still changes the revision');
  assert.equal(revisions[2], bufferRevision('one\ntwo\nthree\nfive\n'));
});

// ─── Slices, budgets and the reply ceiling ─────────────────────────────────

test('slices follow the read rules exactly', () => {
  assert.deepEqual(sliceLines('a\nb\nc\n', 2, 3, 100), { text: 'b\nc\n', range: [2, 3], totalLines: 3, truncated: false, lineCut: false });
  assert.deepEqual(sliceLines('a\nb\nc', 1, undefined, 3), { text: 'a\n', range: [1, 1], totalLines: 3, truncated: true, lineCut: false });
  assert.deepEqual(sliceLines('', 1, undefined, 10), { text: '', range: null, totalLines: 0, truncated: false, lineCut: false });
  assert.deepEqual(sliceLines('a\nb\n', 3, 1, 10), { text: '', range: null, totalLines: 2, truncated: false, lineCut: false });
  // A cut never splits a character, and the budget is strict.
  assert.deepEqual(sliceLines('é😀x\n', 1, undefined, 5), { text: 'é', range: [1, 1], totalLines: 1, truncated: true, lineCut: true });
  assert.deepEqual(sliceLines('😀\n', 1, undefined, 3), { text: '', range: null, totalLines: 1, truncated: true, lineCut: false });
  assert.equal(utf8Length('é😀x'), 7);
});

test('the reply text budget is spent in request order', async () => {
  const session = {
    ...initialEditorSessionState,
    openTabIds: [1, 2],
    tabsById: { 1: tab(1, 'a.txt', 'aaaa\n'), 2: tab(2, 'b.txt', 'bbbb\n') }
  };
  const { bridge, transport } = await readyBridge({ session });
  bridge.handleRequest(documentsRequest([{ path: 'a.txt', maxBytes: 100 }, { path: 'b.txt', maxBytes: 100 }], 7));
  const [first, second] = transport.replies[0].reply.result.documents;
  assert.equal(first.text, 'aaaa\n');
  assert.equal(second.text, 'bb', 'two bytes were left for the second document');
  assert.equal(second.lineCut, true);
});

test('pages never exceed the ceiling: the first shrinks, later ones defer', async () => {
  const big = 'x'.repeat(3000) + '\n';
  const session = {
    ...initialEditorSessionState,
    openTabIds: [1, 2, 3],
    tabsById: { 1: tab(1, 'a.txt', big), 2: tab(2, 'b.txt', big), 3: tab(3, 'c.txt', big) }
  };
  const ceiling = 2048;
  const { bridge, transport } = await readyBridge({ session, ceiling });
  bridge.handleRequest(documentsRequest(['a.txt', 'gone.txt', 'b.txt', 'c.txt'].map((path) => ({ path, maxBytes: 65536 }))));
  const { text, reply } = transport.replies[0];
  assert.ok(utf8Length(text) <= ceiling, `${utf8Length(text)} bytes against ${ceiling}`);
  const kinds = reply.result.documents.map((entry) => entry.kind);
  assert.deepEqual(kinds, ['buffer', 'notBuffered', 'deferred', 'deferred']);
  assert.equal(reply.result.documents[0].truncated, true);
  assert.equal(reply.result.documents[0].lineCut, true);
  assertDeclared(BRIDGE_OPS.documents, reply);
});

test('escape-heavy text fits the real ceiling, truncated rather than overflowing', async () => {
  const heavy = '\u0001'.repeat(256 * 1024);
  const session = {
    ...initialEditorSessionState,
    openTabIds: [1, 2],
    tabsById: { 1: tab(1, 'a.bin', heavy), 2: tab(2, 'b.bin', heavy) }
  };
  const { bridge, transport } = await readyBridge({ session });
  bridge.handleRequest(documentsRequest([{ path: 'a.bin', maxBytes: 262144 }, { path: 'b.bin', maxBytes: 262144 }]));
  const { text, reply } = transport.replies[0];
  assert.ok(utf8Length(text) <= MAX_REPLY_BYTES, `${utf8Length(text)} bytes`);
  const [first, second] = reply.result.documents;
  assert.equal(first.kind, 'buffer');
  assert.equal(first.truncated, true);
  assert.ok(first.text.length > 0);
  assert.equal(second.kind, 'deferred');
});

test('a lone surrogate is sent well-formed, and the revision still covers the original', () => {
  const docs = new Map([['a.txt', { tabId: 1, path: 'a.txt', state: 'open', dirty: false, text: 'a\ud800b' }]]);
  const reply = answerDocuments({ documents: [{ path: 'a.txt', maxBytes: 100 }], maxTextBytes: 100 }, docs, (doc) => bufferRevision(doc.text));
  const [entry] = reply.result.documents;
  assert.equal(entry.text, 'a�b');
  assert.equal(entry.revision, bufferRevision('a\ud800b'));
});

// ─── Readiness, attach and hydration ───────────────────────────────────────

/**
 * Rust's side, reduced to what the bridge relies on: one binding (the open
 * workspace), one attachment, requests sent only to a bridge attached for
 * their epoch (otherwise `ownerUnavailable`).
 */
function fakeRust() {
  let next = 1;
  const rust = {
    binding: null,
    attachment: null,
    bridge: null,
    replies: [],
    transport: serializeAttachments({
      attach: async (epoch) => {
        if (epoch !== rust.binding) throw { code: 'workspaceChanged' };
        rust.attachment = { epoch, generation: `g${next++}` };
        return rust.attachment.generation;
      },
      detach: async (generation) => {
        if (rust.attachment?.generation !== generation) return false;
        rust.attachment = null;
        return true;
      },
      reply: async (requestId, generation, text) => {
        rust.replies.push({ requestId, generation, reply: JSON.parse(text) });
      }
    }),
    request(epoch, documents, requestId = `r${next++}`) {
      if (rust.attachment?.epoch !== epoch) return 'ownerUnavailable';
      const before = rust.replies.length;
      for (const bridge of rust.listeners) {
        bridge.handleRequest({
          requestId, epoch, generation: rust.attachment.generation, op: BRIDGE_OPS.documents,
          request: { documents, maxTextBytes: 262144 }
        });
      }
      return rust.replies.slice(before);
    },
    listeners: []
  };
  return rust;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('ready only for the instance whose own load is fully hydrated', () => {
  const load = { workspaceEpoch: 'ws-2' };
  const instance = { _dbState: load };
  assert.equal(deriveReadyEpoch(instance, load), 'ws-2');
  assert.equal(deriveReadyEpoch(instance, { workspaceEpoch: 'ws-2' }), null, 'another load with the same epoch text');
  assert.equal(deriveReadyEpoch(instance, null), null, 'not hydrated yet');
  assert.equal(deriveReadyEpoch({ _dbState: undefined }, undefined), null, 'single-file session');
  assert.equal(deriveReadyEpoch(null, null), null);
});

test('a project switch: detached until B is hydrated, then B answers from B', async () => {
  const rust = fakeRust();
  let globalEpoch = null;
  const sessions = {
    A: { ...initialEditorSessionState, openTabIds: [1], tabsById: { 1: tab(1, 'main.ts', 'project A\n') } },
    B: { ...initialEditorSessionState, openTabIds: [1], tabsById: { 1: tab(1, 'main.ts', 'project B\n') } }
  };
  let owners = sessions.A;
  const bridge = createProjectApiBridge({
    ports: { sessionDocuments: () => getSessionDocumentsByPath(owners) },
    transport: rust.transport,
    getWorkspaceEpoch: () => globalEpoch
  });
  rust.listeners.push(bridge);
  const ask = (epoch) => rust.request(epoch, [{ path: 'main.ts', maxBytes: 1024 }]);

  // A opens and hydrates.
  const loadA = { workspaceEpoch: 'ws-1' };
  rust.binding = 'ws-1';
  globalEpoch = 'ws-1';
  await bridge.setReadyEpoch(deriveReadyEpoch({ _dbState: loadA }, loadA));
  assert.equal(ask('ws-1')[0].reply.result.documents[0].text, 'project A\n');

  // A request from A, interrupted by the switch: dbOpenProject(B) has set
  // the global epoch, React has not re-rendered, the owners still hold A.
  rust.binding = 'ws-2';
  globalEpoch = 'ws-2';
  const interrupted = ask('ws-1');
  assert.equal(interrupted[0].reply.kind, 'error');
  assert.equal(interrupted[0].reply.code, 'workspaceChanged');

  // B's instance is current but not hydrated (owners still A's): detached.
  const loadB = { workspaceEpoch: 'ws-2' };
  await bridge.setReadyEpoch(deriveReadyEpoch({ _dbState: loadB }, loadA));
  assert.equal(rust.attachment, null);
  assert.equal(ask('ws-2'), 'ownerUnavailable');

  // Half-hydrated: B's pieces loaded, the session not yet restored — the
  // persistence signal still names A's load. Still detached.
  owners = { ...initialEditorSessionState };
  await bridge.setReadyEpoch(deriveReadyEpoch({ _dbState: loadB }, loadA));
  assert.equal(ask('ws-2'), 'ownerUnavailable');

  // Hydrated: attaches under B and answers from B's state.
  owners = sessions.B;
  await bridge.setReadyEpoch(deriveReadyEpoch({ _dbState: loadB }, loadB));
  assert.equal(rust.attachment?.epoch, 'ws-2');
  assert.equal(ask('ws-2')[0].reply.result.documents[0].text, 'project B\n');
  assert.equal(ask('ws-1'), 'ownerUnavailable', 'nothing answers for A any more');
});

test('a refused attach stays detached until the bridge is ready again', async () => {
  const rust = fakeRust();
  rust.binding = 'ws-2';
  const bridge = createProjectApiBridge({
    ports: { sessionDocuments: () => new Map() },
    transport: rust.transport,
    getWorkspaceEpoch: () => 'ws-2'
  });
  await bridge.setReadyEpoch('ws-1'); // stale: Rust already moved to ws-2
  assert.equal(rust.attachment, null);
  assert.equal(bridge.snapshot().generation, null);
  await bridge.setReadyEpoch('ws-2');
  assert.equal(rust.attachment?.epoch, 'ws-2');
});

// Live pass, 2026-09-30: Rust records an attach before the frontend's attach
// promise resolves. A request emitted in between used to be ignored (the
// bridge did not know its generation yet) and timed out after 2 s.
test('a request that arrives while the attach is resolving is answered once it resolves', async () => {
  let resolveAttach;
  const transport = {
    replies: [],
    attach: () => new Promise((resolve) => { resolveAttach = resolve; }),
    detach: async () => true,
    reply: async (requestId, generation, text) => { transport.replies.push({ requestId, generation, reply: JSON.parse(text) }); }
  };
  const bridge = createProjectApiBridge({
    ports: { sessionDocuments: () => getSessionDocumentsByPath(fixtureSession()) },
    transport,
    getWorkspaceEpoch: () => 'ws-7'
  });
  const ready = bridge.setReadyEpoch('ws-7');
  await flush();
  // Rust has attached (generation g5) and already emitted a request.
  bridge.handleRequest({ ...documentsRequest([{ path: 'src/open.ts', maxBytes: 1024 }]), generation: 'g5' });
  // A request for another epoch in the same window is not kept.
  bridge.handleRequest({ ...documentsRequest([{ path: 'src/open.ts', maxBytes: 1024 }]), requestId: 'r-other', epoch: 'ws-6', generation: 'g5' });
  assert.equal(transport.replies.length, 0, 'nothing is answered before the generation is known');
  resolveAttach('g5');
  await ready;
  assert.equal(transport.replies.length, 1);
  assert.equal(transport.replies[0].requestId, 'r9');
  assert.equal(transport.replies[0].generation, 'g5');
  assert.equal(transport.replies[0].reply.result.documents[0].text, 'export const a = 1;\n');
});

test('requests held during an attach that is refused are dropped, never answered', async () => {
  let rejectAttach;
  const replies = [];
  const bridge = createProjectApiBridge({
    ports: { sessionDocuments: () => getSessionDocumentsByPath(fixtureSession()) },
    transport: {
      attach: () => new Promise((_, reject) => { rejectAttach = reject; }),
      detach: async () => true,
      reply: async (...args) => { replies.push(args); }
    },
    getWorkspaceEpoch: () => 'ws-7'
  });
  const ready = bridge.setReadyEpoch('ws-7');
  await flush();
  bridge.handleRequest({ ...documentsRequest([{ path: 'src/open.ts', maxBytes: 1024 }]), generation: 'g5' });
  rejectAttach({ code: 'workspaceChanged' });
  await ready;
  assert.equal(replies.length, 0);
  assert.equal(bridge.snapshot().generation, null);
});

test('a remount (StrictMode) reaches Rust in order: the live bridge stays attached', async () => {
  const rust = fakeRust();
  rust.binding = 'ws-1';
  const make = () => createProjectApiBridge({
    ports: { sessionDocuments: () => new Map() },
    transport: rust.transport,
    getWorkspaceEpoch: () => 'ws-1'
  });
  const first = make();
  void first.setReadyEpoch('ws-1');
  void first.dispose(); // cleanup runs before the first attach has resolved
  const second = make();
  await second.setReadyEpoch('ws-1');
  await flush();
  assert.equal(rust.attachment?.generation, second.snapshot().generation);
  assert.notEqual(rust.attachment, null);
});

// ─── Build plan P3: workspace.selection and languages.capabilities ─────────

test('workspace.selection: the committed request gets the committed reply', async () => {
  const { bridge, transport } = await readyBridge();
  bridge.handleRequest(acceptedFixture('workspace.selection.request.json'));
  const [{ requestId, generation, reply }] = transport.replies;
  assert.equal(requestId, 'r1');
  assert.equal(generation, 'g3');
  // Ids 5 and 2 map to their files' paths, sorted and without duplicates;
  // the unknown id 99 has no file; the Windows separator is normalized.
  assert.deepEqual(reply, acceptedFixture('workspace.selection.reply.json'));
  assertDeclared(BRIDGE_OPS.selection, reply);
});

test('workspace.selection: optional parts are left out, never sent empty', async () => {
  const { bridge, transport, holder } = await readyBridge();
  holder.workspace = { selectedIds: [], piecesById: new Map(), selectedGroupId: 'g2', groups: fixtureWorkspace().groups };
  holder.active = null;
  bridge.handleRequest(acceptedFixture('workspace.selection.request.json'));
  // g2 is a manual group with no folder.
  assert.deepEqual(transport.replies[0].reply, acceptedFixture('workspace.selection.reply.empty.json'));
});

test('workspace.selection: a list over the limit or the ceiling is counted, not overflowed', () => {
  const many = { selectedPaths: Array.from({ length: 12 }, (_, index) => `src/f${index}.ts`), folder: null, activeDocument: null };
  const limited = answerSelection({ maxPaths: 5 }, many);
  assert.deepEqual(limited.result.selected, ['src/f0.ts', 'src/f1.ts', 'src/f10.ts', 'src/f11.ts', 'src/f2.ts']);
  assert.equal(limited.result.omitted, 7);
  const ceiling = 200;
  const fitted = answerSelection({ maxPaths: 1000 }, many, ceiling);
  assert.ok(utf8Length(JSON.stringify(fitted)) <= ceiling);
  assert.equal(fitted.result.selected.length + fitted.result.omitted, 12);
  assert.ok(fitted.result.omitted > 0);
  // A path the contract cannot carry is counted, never sent.
  const long = answerSelection({ maxPaths: 10 }, { selectedPaths: ['a.ts', 'x'.repeat(1025)] });
  assert.deepEqual(long.result, { selected: ['a.ts'], omitted: 1 });
  assert.deepEqual(answerSelection({ maxPaths: -1 }, many), {
    kind: 'error', code: 'invalidRequest', message: 'the editor could not read the request'
  });
});

test('the active document is the focused tab, with the session\'s dirty rule', () => {
  const session = fixtureSession();
  assert.deepEqual(getActiveSessionDocument(session, 1), { path: 'src/open.ts', dirty: true });
  assert.deepEqual(getActiveSessionDocument(session, 3), { path: 'src/closed-clean.ts', dirty: false });
  assert.equal(getActiveSessionDocument(session, null), null);
  assert.equal(getActiveSessionDocument(session, 404), null);
  const crlf = { tabsById: { 1: tab(1, '/src/a.ts', 'a\r\nb\r\n', 'a\nb\n') } };
  assert.deepEqual(getActiveSessionDocument(crlf, 1), { path: 'src/a.ts', dirty: false });
});

test('languages.capabilities: the committed request gets the committed reply', async () => {
  const { bridge, transport, holder } = await readyBridge();
  holder.languages = acceptedFixture('languages.capabilities.reply.json').result.languages;
  bridge.handleRequest(acceptedFixture('languages.capabilities.request.json'));
  assert.deepEqual(transport.replies[0].reply, acceptedFixture('languages.capabilities.reply.json'));
  assertDeclared(BRIDGE_OPS.capabilities, transport.replies[0].reply);
});

test('the real capability matrix is a reply Rust accepts (the committed matrix fixture)', async () => {
  const { bridge, transport, holder } = await readyBridge();
  holder.languages = buildCapabilityMatrix(null); // nothing checked yet in this session
  bridge.handleRequest(acceptedFixture('languages.capabilities.request.json'));
  assert.deepEqual(transport.replies[0].reply, acceptedFixture('languages.capabilities.reply.matrix.json'));
  assertDeclared(BRIDGE_OPS.capabilities, transport.replies[0].reply);
});

/** A LanguageSupportDomain stand-in: status and whether it was checked, per pack. */
function languageSupport(packs) {
  const state = (packId) => {
    const pack = packs[packId];
    return pack ? { status: pack[0], lastCheckedAt: pack[1] ? '2026-09-30T00:00:00Z' : null } : null;
  };
  return { selectors: { getPackState: state, getManagedPackState: state } };
}

test('the capability matrix matches the language tiers', () => {
  const support = languageSupport({ typescript: ['Installed', true], python: ['Not Installed', true] });
  const rows = buildCapabilityMatrix(support).map((row) => [
    row.language,
    row.extensions.join(' '),
    row.languageServer,
    [row.documentAccess, row.diagnostics, row.navigation, row.symbols, row.relationshipDiscovery, row.sourceTransformations]
      .map((flag) => (flag ? 1 : 0)).join('')
  ]);
  // Flags: documentAccess, diagnostics, navigation, symbols,
  // relationshipDiscovery, sourceTransformations.
  assert.deepEqual(rows, [
    ['javascript', '.js .jsx .mjs', 'installed', '111111'],
    ['javascript', '.cjs', 'installed', '111101'],
    ['typescript', '.ts .tsx', 'installed', '111111'],
    ['typescript', '.mts .cts', 'installed', '111101'],
    ['json', '.json', 'none', '110100'],
    ['css', '.css', 'none', '111100'],
    ['html', '.html', 'none', '100100'],
    ['markdown', '.md', 'none', '100000'],
    ['python', '.py', 'notInstalled', '101111'],
    ['python', '.pyi', 'notInstalled', '101100'],
    ['rust', '.rs', 'unknown', '100000'],
    ['c', '.c', 'unknown', '100000'],
    ['cpp', '.h .cpp .hpp .cc .cxx', 'unknown', '100000'],
    ['go', '.go', 'unknown', '100000']
  ]);
});

test('installing a language server turns on its diagnostics, and nothing else', () => {
  const before = buildCapabilityMatrix(languageSupport({}));
  const after = buildCapabilityMatrix(languageSupport({ rust: ['Installed', true] }));
  const rustBefore = before.find((row) => row.language === 'rust');
  const rustAfter = after.find((row) => row.language === 'rust');
  assert.deepEqual({ ...rustAfter, diagnostics: false, languageServer: 'unknown' }, rustBefore);
  assert.equal(rustAfter.diagnostics, true);
  assert.equal(rustAfter.navigation, false, 'an installed server does not imply navigation');
});

test('language-server states', () => {
  const cases = [
    [{ typescript: ['Installed', true] }, 'typescript', 'installed'],
    [{ typescript: ['Update Available', true] }, 'typescript', 'installed'],
    [{ python: ['Not Installed', true] }, 'python', 'notInstalled'],
    [{ python: ['Not Installed', false] }, 'python', 'unknown'],
    [{ python: ['Installing', true] }, 'python', 'unknown'],
    [{ go: ['Error', true] }, 'go', 'error'],
    [{}, 'cpp', 'unknown'],
    [{}, null, 'none']
  ];
  for (const [packs, packId, expected] of cases) {
    assert.equal(languageServerState(languageSupport(packs), packId), expected, `${packId} ${JSON.stringify(packs)}`);
  }
});

test('editor.bufferIndex: a path the contract cannot carry is counted as omitted, never sent', () => {
  const long = `${'d/'.repeat(600)}a.ts`; // 1,204 code points
  const documents = new Map([
    ['a.ts', { tabId: 1, path: 'a.ts', state: 'open', dirty: false, text: 'x' }],
    [long, { tabId: 2, path: long, state: 'closedDirty', dirty: true, text: 'y' }]
  ]);
  const reply = answerBufferIndex({ maxEntries: 500 }, documents, () => 'b1-x');
  assert.deepEqual(reply.result.entries.map((entry) => entry.path), ['a.ts']);
  assert.equal(reply.result.omitted, 1);
});
