/**
 * syntaxAdapter.js — Bridges Monaco editor events to syntaxDomain commands.
 *
 * Responsibilities:
 *  - Forwards file open/change/close events to the domain.
 *  - Maintains a model registry (absolutePath → Monaco model) so edits can be
 *    applied to OPEN files (kept in Monaco's undo stack) without needing a
 *    monaco namespace reference at call time.
 *  - Reads/writes CLOSED files directly via the injected project file IO.
 *  - Exposes connection/symbol handlers for canvas/UI consumers.
 *
 * CONSISTENT WRITE PATH (data-integrity critical):
 *  Every code-mutating handler computes the FINAL file text once, from
 *  authoritative state (open model value OR fresh disk read), via a pure domain
 *  `compute*Edits` command, then writes that whole text back to the right place:
 *    - OPEN file  → replace the model's full range (stays dirty + undoable,
 *                   reaches disk only on user save — content autosave is NOT done).
 *    - CLOSED file → write directly to disk via writeProjectFile.
 *  In both cases the domain cache is refreshed via notifyFileChanged.
 *
 *  This replaces the old per-symbol patch-plan loop that computed line edits
 *  from a stale cache and applied them to the model — which drifted on the 2nd
 *  symbol and silently dropped edits for files not open in the editor.
 *
 * IMPORTANT: Monaco models in Litria use `cm://tab/ID/filename` URIs,
 * NOT `file:///` URIs. The model registry is the only reliable way to look
 * up a model by file path. Do NOT use monaco.Uri.file() for model lookup.
 *
 * Usage:
 *   const adapter = createSyntaxAdapter({
 *     syntaxDomain, projectRoot, readProjectFile, writeProjectFile,
 *   });
 *
 *   adapter.onFileOpened(absPath, text, monacoModel);
 *   adapter.onFileChanged(absPath, text);
 *   adapter.onFileClosed(absPath);
 *
 *   await adapter.handleConnect({ connectionId, sourceFilePath, targetFilePath });
 *   await adapter.handleResolveSymbol({ connectionId, symbolId });
 *   await adapter.handleResolveMultipleSymbols({ edgeId, symbolIds });
 */

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   syntaxDomain: object,
 *   projectRoot: string,
 *   readProjectFile?: (root: string, relPath: string) => Promise<string|null>,
 *   writeProjectFile?: (root: string, relPath: string, contents: string) => Promise<any>,
 * }} params
 * @returns {object} adapter
 */
export function createSyntaxAdapter({ syntaxDomain, projectRoot, readProjectFile, writeProjectFile }) {
  // Python import composition derives absolute module specs from the project
  // root (brief-python-wires S2). The adapter is recreated on project switch
  // (useSyntaxDomainLifecycle), so this stays current.
  syntaxDomain.commands.setProjectRoot?.(projectRoot ?? null);

  /**
   * Registry: absolutePath → Monaco ITextModel.
   * Populated by onFileOpened, cleared by onFileClosed.
   *
   * @type {Map<string, object>}
   */
  const modelRegistry = new Map();

  const _root = typeof projectRoot === 'string'
    ? projectRoot.replace(/\\/g, '/').replace(/\/$/, '')
    : '';

  // ---- Path helpers ---------------------------------------------------------

  /** Convert an absolute file path to a project-relative path for disk IO. */
  function absToRel(absPath) {
    const norm = absPath.replace(/\\/g, '/');
    if (_root && norm.startsWith(_root + '/')) return norm.slice(_root.length + 1);
    // Already relative, or root unknown — best effort.
    return norm.replace(/^\//, '');
  }

  // ---- Authoritative text + write -------------------------------------------

  /**
   * Get the authoritative current text for a file:
   *  - open in editor → the live model value
   *  - otherwise      → a fresh read from disk
   *
   * @param {string} absPath
   * @returns {Promise<string|null>}
   */
  async function getAuthoritativeText(absPath) {
    const model = modelRegistry.get(absPath);
    if (model) return model.getValue();
    if (!readProjectFile) return null;
    try {
      return await readProjectFile(projectRoot, absToRel(absPath));
    } catch (_) {
      return null;
    }
  }

  /**
   * Write the final text for a file to the right place and refresh the cache.
   *  - open  → replace model full range via pushEditOperations (undoable, dirty)
   *  - closed → writeProjectFile to disk
   * Always notifies the domain so the cache + edge reconciliation stay in sync.
   *
   * @param {string} absPath
   * @param {string} newText
   * @returns {Promise<boolean>} true if a write happened
   */
  async function writeResultText(absPath, newText) {
    const model = modelRegistry.get(absPath);
    if (model) {
      const lineCount = model.getLineCount();
      const endColumn = model.getLineMaxColumn(lineCount);
      model.pushEditOperations(
        [],
        [{
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: lineCount, endColumn },
          text: newText,
        }],
        () => null,
      );
      syntaxDomain.commands.notifyFileChanged(absPath, newText);
      return true;
    }

    if (writeProjectFile) {
      await writeProjectFile(projectRoot, absToRel(absPath), newText);
      syntaxDomain.commands.notifyFileChanged(absPath, newText);
      return true;
    }

    return false;
  }

  /**
   * Apply a list of { filePath, newText } edits from a domain compute command.
   * @param {Array<{ filePath: string, newText: string }>} edits
   * @returns {Promise<number>} number of files written
   */
  async function _applyEdits(edits) {
    let written = 0;
    for (const edit of edits ?? []) {
      if (await writeResultText(edit.filePath, edit.newText)) written++;
    }
    return written;
  }

  // ---- File lifecycle -------------------------------------------------------

  function onFileOpened(filePath, text, model = null) {
    syntaxDomain.commands.registerFile(filePath, text);
    if (model) modelRegistry.set(filePath, model);
  }

  function onFileChanged(filePath, text) {
    syntaxDomain.commands.notifyFileChanged(filePath, text);
  }

  function onFileClosed(filePath) {
    syntaxDomain.commands.unregisterFile(filePath);
    modelRegistry.delete(filePath);
  }

  // ---- Canvas connection handlers -------------------------------------------

  /**
   * Handle a canvas drag connection completing.
   * Creates a pending SyntaxEdge and writes an import stub to the target file
   * via the consistent text path (works for closed target files too).
   *
   * @param {{ connectionId: string, sourceFilePath: string, targetFilePath: string }} params
   * @returns {Promise<{ success: boolean, patchApplied: boolean, syntaxConn: object|null, edgeId: string|null, isNewEdge: boolean }>}
   */
  async function handleConnect({ connectionId, sourceFilePath, targetFilePath }) {
    if (!connectionId || !sourceFilePath || !targetFilePath) {
      return { success: false, patchApplied: false, syntaxConn: null, edgeId: null, isNewEdge: false };
    }

    const result = syntaxDomain.commands.connect({ connectionId, sourceFilePath, targetFilePath });
    if (!result) {
      // Already exists or same-file — idempotent no-op
      return { success: false, patchApplied: false, syntaxConn: null, edgeId: null, isNewEdge: false };
    }

    let patchApplied = false;
    if (result.isNewEdge && result.edgeId) {
      const targetText = await getAuthoritativeText(targetFilePath);
      if (targetText != null) {
        const stub = syntaxDomain.commands.computeConnectStubEdit({ edgeId: result.edgeId, targetText });
        patchApplied = (await _applyEdits(stub?.edits)) > 0;
      }
    }

    return {
      success: true,
      patchApplied,
      syntaxConn: result.syntaxConn,
      edgeId: result.edgeId,
      isNewEdge: result.isNewEdge,
    };
  }

  /**
   * Handle the user picking a single symbol for a pending connection.
   *
   * @param {{ connectionId: string, symbolId: string }} params
   * @returns {Promise<{ success: boolean, patchesApplied: number, syntaxConn: object|null }>}
   */
  async function handleResolveSymbol({ connectionId, symbolId }) {
    if (!connectionId || !symbolId) {
      return { success: false, patchesApplied: 0, syntaxConn: null };
    }

    const edgeId = syntaxDomain.selectors.getEdgeIdForConnection(connectionId);
    if (!edgeId) return { success: false, patchesApplied: 0, syntaxConn: null, status: 'error' };

    const res = await _resolveSymbolsOnEdge(edgeId, [symbolId]);
    if (res == null) return { success: false, patchesApplied: 0, syntaxConn: null, status: 'error' };

    return {
      success: res.status !== 'error',
      patchesApplied: res.written,
      status: res.status,
      syntaxConn: syntaxDomain.selectors.getSyntaxConnection(connectionId),
    };
  }

  /**
   * Resolve multiple symbols on an edge at once — the multi-symbol path that
   * previously drifted. Computes one consistent set of edits for the whole batch.
   *
   * @param {{ edgeId: string, symbolIds: string[] }} params
   * @returns {Promise<{ success: boolean, patchesApplied: number, edge: object|null }>}
   */
  async function handleResolveMultipleSymbols({ edgeId, symbolIds }) {
    if (!edgeId || !symbolIds?.length) {
      return { success: false, patchesApplied: 0, edge: null };
    }

    const res = await _resolveSymbolsOnEdge(edgeId, symbolIds);
    if (res == null) return { success: false, patchesApplied: 0, edge: null, status: 'error' };

    return {
      success: res.status !== 'error',
      patchesApplied: res.written,
      status: res.status,
      edge: syntaxDomain.selectors.getSyntaxEdge(edgeId),
    };
  }

  /**
   * Shared core for symbol resolution: gather authoritative source + target
   * text, run the pure domain compute, write each returned edit.
   *
   * @param {string} edgeId
   * @param {string[]} symbolIds
   * @returns {Promise<{ status: 'written'|'noop'|'error', written: number }|null>}
   *   null if the edge is gone; 'error' if a file couldn't be read; 'noop' if
   *   there was genuinely nothing to write (symbol already imported+exported);
   *   'written' if at least one file changed.
   */
  async function _resolveSymbolsOnEdge(edgeId, symbolIds) {
    const edge = syntaxDomain.selectors.getSyntaxEdge(edgeId);
    if (!edge) return null;

    const [targetText, sourceText] = await Promise.all([
      getAuthoritativeText(edge.targetFilePath),
      getAuthoritativeText(edge.sourceFilePath),
    ]);
    if (targetText == null || sourceText == null) return { status: 'error', written: 0 };

    const result = syntaxDomain.commands.computeResolveEdits({
      edgeId,
      symbolIds,
      targetText,
      sourceText,
    });
    if (!result) return null;

    const written = await _applyEdits(result.edits);
    return { status: written > 0 ? 'written' : 'noop', written };
  }

  /**
   * Handle a canvas connection being removed — STATE-ONLY, for every
   * language (owner decision 2026-07-17, brief-python-wires S3): deleting a
   * wire never edits code. Imports are authoritative, so the import line
   * stays and discovery re-derives the wire on the next project open;
   * permanently removing the relationship means removing the import in the
   * editor. (Previously the JS path deleted the generated import line here.)
   *
   * @param {{ connectionId: string }} params
   * @returns {Promise<{ success: boolean, patchApplied: boolean }>}
   */
  async function handleDisconnect({ connectionId }) {
    if (!connectionId) return { success: false, patchApplied: false };

    syntaxDomain.commands.disconnectConnection(connectionId, { removeImport: false });

    return { success: true, patchApplied: false };
  }

  // ---- Edge-level helpers ---------------------------------------------------

  /**
   * Check if an edge already exists for a source→target file pair.
   * @param {string} sourceFilePath
   * @param {string} targetFilePath
   * @returns {string|null} edgeId if edge exists, null otherwise.
   */
  function getEdgeForPair(sourceFilePath, targetFilePath) {
    const edge = syntaxDomain.selectors.getSyntaxEdgeForPair(sourceFilePath, targetFilePath);
    return edge ? edge.edgeId : null;
  }

  // ---- Detach handlers (N6) -------------------------------------------------

  /**
   * Detach an edge visually — remove from domain state, code stays in place.
   * @param {{ edgeId: string }} params
   * @returns {{ success: boolean }}
   */
  function handleDetach({ edgeId }) {
    return syntaxDomain.commands.detachEdge(edgeId);
  }

  /**
   * Detach an edge AND remove generated code (import + export block entries),
   * via the consistent text path so closed files persist.
   *
   * @param {{ edgeId: string }} params
   * @returns {Promise<{ success: boolean, patchesApplied: number }>}
   */
  async function handleDetachAndRemove({ edgeId }) {
    const edge = syntaxDomain.selectors.getSyntaxEdge(edgeId);
    if (!edge) return { success: false, patchesApplied: 0 };

    const [targetText, sourceText] = await Promise.all([
      getAuthoritativeText(edge.targetFilePath),
      getAuthoritativeText(edge.sourceFilePath),
    ]);

    let written = 0;

    // Remove each symbol from the export side via the text path (evolving copy).
    let evolvingSource = sourceText;
    if (evolvingSource != null) {
      for (const sym of edge.symbols) {
        const result = syntaxDomain.commands.computeRemoveEdits({
          edgeId,
          symbolName: sym.symbolName,
          targetText: targetText ?? '',
          sourceText: evolvingSource,
          removeExport: true,
        });
        const srcEdit = result?.edits?.find((e) => e.filePath === edge.sourceFilePath);
        if (srcEdit) evolvingSource = srcEdit.newText;
      }
      if (evolvingSource !== sourceText) {
        if (await writeResultText(edge.sourceFilePath, evolvingSource)) written++;
      }
    }

    // Remove the import line from the target by locating it in authoritative text.
    if (targetText != null && edge.connectionIds.length > 0) {
      const result = syntaxDomain.commands.computeDisconnectEdit({
        connectionId: edge.connectionIds[0],
        targetText,
        removeImport: true,
      });
      if (result?.edits?.length) {
        if (await writeResultText(result.edits[0].filePath, result.edits[0].newText)) written++;
      }
    }

    // Tear down edge state without re-touching code.
    syntaxDomain.commands.detachEdge(edgeId);

    return { success: true, patchesApplied: written };
  }

  // ---- File rename ----------------------------------------------------------

  /**
   * Handle a file being renamed or moved. Updates the model registry and
   * delegates to the domain. Import-path fix-ups are written via the text path.
   *
   * @param {string} oldPath
   * @param {string} newPath
   * @returns {Promise<{ patchesApplied: number }>}
   */
  async function onFileRenamed(oldPath, newPath) {
    const model = modelRegistry.get(oldPath);
    if (model) {
      modelRegistry.set(newPath, model);
      modelRegistry.delete(oldPath);
    }

    const result = syntaxDomain.commands.renameFile(oldPath, newPath);

    // Group rename patch plans by file and apply them to authoritative text.
    const byFile = new Map();
    for (const plan of result.patchPlans ?? []) {
      if (!byFile.has(plan.filePath)) byFile.set(plan.filePath, []);
      byFile.get(plan.filePath).push(plan);
    }

    let patchesApplied = 0;
    for (const [filePath, plans] of byFile) {
      const text = await getAuthoritativeText(filePath);
      if (text == null) continue;
      const newText = _applyRenamePlans(text, plans);
      if (newText !== text && await writeResultText(filePath, newText)) patchesApplied++;
    }

    return { patchesApplied };
  }

  /**
   * Apply rename patch plans (replace by line) to a string. Local to the
   * adapter; rename plans only ever 'replace' a single import line.
   *
   * The stored plan.line is a HINT, not an address: edge.importLine goes
   * stale the moment the user edits lines above the import, and a blind
   * lines[plan.line] replace then overwrites arbitrary code (the JS twin of
   * the 2026-07-17 python line-0 corruption). Locate the import by its
   * pre-rename spec (plan.matchSpec) in the text actually being edited, and
   * fail closed — no matching import, no write.
   */
  function _applyRenamePlans(text, plans) {
    const lines = text.split('\n');
    for (const plan of plans) {
      if (plan.kind !== 'replace') continue;
      const line = syntaxDomain.commands.computeImportLineForSpec({
        text: lines.join('\n'),
        spec: plan.matchSpec,
      });
      if (line == null) continue;
      lines[line] = plan.text.replace(/\n$/, '');
    }
    return lines.join('\n');
  }

  // ---- Introspection --------------------------------------------------------

  /** Exposed for debugging / testing only. */
  function getModelRegistry() {
    return modelRegistry;
  }

  return {
    // File lifecycle
    onFileOpened,
    onFileChanged,
    onFileClosed,
    onFileRenamed,

    // Authoritative text + write (consistent path)
    getAuthoritativeText,
    writeResultText,
    absToRel,

    // Canvas connection handlers (now async)
    handleConnect,
    handleResolveSymbol,
    handleDisconnect,

    // Edge-level handlers (N3+)
    getEdgeForPair,
    handleResolveMultipleSymbols,

    // Detach handlers (N6)
    handleDetach,
    handleDetachAndRemove,

    // Debug
    getModelRegistry,
  };
}
