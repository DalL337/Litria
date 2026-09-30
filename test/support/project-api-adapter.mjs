// ADR-033 S0 prototype: a JavaScript adapter for the two illustrative
// Project API read operations (src-tauri/contracts/project-api/v0).
//
// No production JavaScript consumer of these contracts exists yet, so the
// prototype lives here rather than under src/ (a src/ home needs a Domain
// Register entry first). It is written the way a real adapter would be: the
// transport is injected, requests are built from caller options, results are
// normalized. contractFixtures.test.mjs runs THIS code against the committed
// fixtures with only the transport mocked. When the first real consumer
// lands, its adapter gets the same treatment and this file goes.
//
// Reader rules (brief §6): inputs strict, outputs tolerant. Unfamiliar output
// fields are ignored; an unfamiliar outcome `kind` becomes { kind: 'unknown' },
// never one of the known outcomes. Identifiers, revisions and epochs stay
// strings — never numbers.

export const OPERATIONS = Object.freeze({
  projectContext: 'litria_project_context',
  filesRead: 'litria_files_read',
});

const KNOWN_DOCUMENT_KINDS = new Set(['read', 'notFound', 'denied', 'tooLarge']);

/**
 * @param {{ call: (operation: string, request: object) => Promise<object> }} transport
 */
export function createProjectApiAdapter({ call }) {
  return {
    async projectContext({ includeSelection = false } = {}) {
      const request = includeSelection ? { includeSelection: true } : {};
      return normalizeProjectContext(await call(OPERATIONS.projectContext, request));
    },

    async filesRead({ paths, source, maxBytesPerDocument } = {}) {
      const request = { paths: [...paths] };
      if (source !== undefined) request.source = source;
      if (maxBytesPerDocument !== undefined) request.maxBytesPerDocument = maxBytesPerDocument;
      const result = await call(OPERATIONS.filesRead, request);
      return { documents: result.documents.map(normalizeDocumentOutcome) };
    },
  };
}

export function normalizeProjectContext(result) {
  return {
    workspaceEpoch: result.workspaceEpoch,
    projectName: result.projectName,
    selection: Array.isArray(result.selection)
      ? result.selection.map((node) => ({ nodeId: node.nodeId, path: node.path ?? null }))
      : [],
    languages: result.languages.map((language) => ({
      languageId: language.languageId,
      documentAccess: language.documentAccess,
      diagnostics: language.diagnostics,
      navigation: language.navigation,
      symbols: language.symbols,
      relationshipDiscovery: language.relationshipDiscovery,
      sourceTransformations: language.sourceTransformations,
    })),
  };
}

export function normalizeDocumentOutcome(outcome) {
  if (!outcome || !KNOWN_DOCUMENT_KINDS.has(outcome.kind)) {
    return { kind: 'unknown', rawKind: outcome?.kind ?? null };
  }
  switch (outcome.kind) {
    case 'read':
      return {
        kind: 'read',
        path: outcome.path,
        documentId: outcome.documentId,
        revision: outcome.revision,
        source: outcome.source,
        dirty: outcome.dirty === true,
        text: outcome.text,
      };
    case 'tooLarge':
      return { kind: 'tooLarge', path: outcome.path, limitBytes: outcome.limitBytes };
    default:
      return { kind: outcome.kind, path: outcome.path };
  }
}

/**
 * Bridge side: the owner's answer for one open buffer, shaped as the
 * contract's `read` outcome (Rust reads it with the inbound result schema).
 */
export function documentReadFromBuffer({ path, documentId, revision, dirty, text }) {
  return { kind: 'read', path, documentId, revision, source: 'editor', dirty, text };
}
