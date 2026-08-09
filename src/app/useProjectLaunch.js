import { useCallback } from 'react';

import { createProjectInstanceId, normalizeAppearance, DEFAULT_THEME_ID } from '../project/manifest';
import { getRandomPieceColor } from '../utils/pieceColors';
import { getHeaderCommentForFilename } from '../editor/editorHeaders';
import { UNTITLED_FILENAME } from '../project/untitledSession.js';
import { splitPathAtLastSeparator } from '../utils/path';
import { dbOpenProject, dbBootstrapProject, dbCloseProject, dbSaveEditorState, dbCreatePiecesBatch } from '../project/dbStorage.js';
import { prefsSaveGlobal } from '../preferences/preferencesStore.js';
import { PREF_KEYS } from '../preferences/registry.js';
import { buildBlankSeedRows } from '../project/blankSeed.js';
import { clearAllDiagnostics } from '../lsp/diagnosticStore.js';
import { withTimeout } from '../utils/withTimeout.js';

// Workspace-style color defaults (ADR-014 / node visual language). Stored in
// the project's editor_state KV store (no schema change) under `ws.*` keys.
function normalizeWorkspaceStyle(ws) {
  return {
    groupColorMode: ws?.groupColorMode ?? 'auto',
    defaultFolderGroupColor: ws?.defaultFolderGroupColor || null,
    nodeColorMode: ws?.nodeColorMode ?? 'inherit',
    ungroupedEdgeColor: ws?.ungroupedEdgeColor || null,
  };
}

function workspaceStyleFromEditorState(editorState) {
  return normalizeWorkspaceStyle(editorState ? {
    groupColorMode: editorState['ws.groupColorMode'] || 'auto',
    defaultFolderGroupColor: editorState['ws.defaultFolderGroupColor'] || null,
    nodeColorMode: editorState['ws.nodeColorMode'] || 'inherit',
    ungroupedEdgeColor: editorState['ws.ungroupedEdgeColor'] || null,
  } : null);
}

export function useProjectLaunch({
  applyScaffold,
  rebuildAllAdjacencies,
  setPieces,
  replaceGroups,
  setNextId,
  setNextGroupId,
  bumpScaffoldRefresh,
  createConnectionAndInsert,
  pieceWidth,
  pieceHeight,
  setProjectInstance,
  openFileDialog,
  getProjectStorageError,
  setGroups,
  setSelectedGroupId,
  setHiddenScaffoldPaths,
  clearSelection,
  projectInstance,
  terminalDomain,
  languageSupportDomain,
  showToast,
  setConnections,
  setNextConnectionIdValue,
  clearHistory,
  guardUnsavedChanges
}) {
  const getStorageErrorMessage = useCallback((error, fallback) => {
    if (!error || typeof error !== 'object') return fallback;
    const message = typeof error.message === 'string' && error.message.trim()
      ? error.message.trim()
      : fallback;
    switch (error.category) {
      case 'InvalidPath':
        return `Invalid path. ${message}`;
      case 'AccessDenied':
        return `Access denied. ${message}`;
      case 'NotFound':
        return `Not found. ${message}`;
      case 'Conflict':
        return `Path conflict. ${message}`;
      default:
        return message;
    }
  }, []);

  const resolveProjectRootPath = useCallback((rootPath, projectName) => {
    const trimmedRoot = typeof rootPath === 'string' ? rootPath.trim() : '';
    const trimmedName = typeof projectName === 'string' ? projectName.trim() : '';
    if (!trimmedRoot) return trimmedRoot;
    if (!trimmedName) return trimmedRoot;

    const normalizedRoot = trimmedRoot.replace(/[\\\/]+$/, '');
    const rootName = normalizedRoot.split(/[\\\/]/).pop() || '';
    if (rootName.localeCompare(trimmedName, undefined, { sensitivity: 'accent' }) === 0) {
      return normalizedRoot;
    }

    const separator = normalizedRoot.includes('\\') ? '\\' : '/';
    return `${normalizedRoot}${separator}${trimmedName}`;
  }, []);

  const applyPlan = useCallback(async (targetRoot, plan) => {
    if (!plan) return;
    await applyScaffold({
      targetRoot,
      plan,
      rebuildAllAdjacencies,
      setPieces,
      replaceGroups,
      setNextId,
      setNextGroupId,
      bumpScaffoldRefresh,
      createConnectionAndInsert,
      getRandomPieceColor,
      pieceWidth,
      pieceHeight
    });
  }, [
    applyScaffold,
    bumpScaffoldRefresh,
    createConnectionAndInsert,
    pieceHeight,
    pieceWidth,
    rebuildAllAdjacencies,
    replaceGroups,
    setNextGroupId,
    setNextId,
    setPieces
  ]);

  const handleCreateProjectInstance = useCallback(async ({ name, rootPath, scaffoldPlan = null, workspaceStyle = null, theme = null, seedFiles = null, stack = null, pythonEnv = null, npmScripts = null }) => {
    const targetRootPath = resolveProjectRootPath(rootPath, name);
    // SQLite bootstrap: creates .litria/, workspace.db, litria.toml. The
    // wizard's stack choice rides along into the project row, and a Python
    // requires-floor becomes litria.toml's [environment] block (ADR-020).
    const projectState = await dbBootstrapProject(
      targetRootPath,
      name,
      stack?.language ?? null,
      stack?.framework ?? null,
      pythonEnv?.floor ?? null
    );
    const normalizedRoot = targetRootPath.replace(/[\\\/]+$/, '');

    // Blank template: seed the generated substrate files onto the canvas as
    // the project's first pieces. Rows are written to SQLite here, then
    // injected into the bootstrap state so the NORMAL hydration path places
    // them and loads their contents from disk — no bespoke canvas machinery.
    // Failure is non-fatal: the files still exist in the scaffold tree.
    if (Array.isArray(seedFiles) && seedFiles.length > 0) {
      try {
        // One payload for both the SQLite rows and the injected hydration
        // state, so the persisted piece and its first-frame render can't drift.
        const payload = buildBlankSeedRows(seedFiles).map((r) => ({
          filePath: r.filePath,
          label: r.label,
          x: r.x,
          y: r.y,
          color: r.color
        }));
        const ids = await dbCreatePiecesBatch(payload);
        if (Array.isArray(ids) && ids.length === payload.length) {
          projectState.pieces = payload.map((p, i) => ({
            id: ids[i],
            ...p,
            scale: 1,
            isHidden: false
          }));
        }
      } catch (e) {
        console.warn('[project] seeding blank-project pieces failed (files remain in the tree):', e);
      }
    }

    // Seed the chosen base material preset as the project's active theme. Only
    // when a non-default preset was picked — Glass is the resolve-time fallback,
    // so leaving appearance unwritten opens in Glass. normalizeAppearance seeds
    // all four built-ins and validates the id (unknown ids fall back to Glass).
    if (typeof theme === 'string' && theme && theme !== DEFAULT_THEME_ID) {
      try {
        const appearance = normalizeAppearance({ activeThemeId: theme, themes: {} });
        await prefsSaveGlobal(PREF_KEYS.appearance, appearance);
      } catch (e) {
        console.warn('[project] failed to seed base theme:', e);
      }
    }

    // Machine-local interpreter binding (ADR-020 §5): the resolved absolute
    // path is this-machine state, so it lives in workspace.db editor_state —
    // never in litria.toml (team-shared, sparse by rule). Re-validated by
    // probe on open (Slice 4).
    if (typeof pythonEnv?.interpreter === 'string' && pythonEnv.interpreter) {
      try {
        await dbSaveEditorState('env.python.interpreter', pythonEnv.interpreter);
      } catch (e) {
        console.warn('[project] failed to persist interpreter binding:', e);
      }
    }

    // ADR-021 §3: scaffold installs skipped dependency scripts (npm path) —
    // persist the marker that drives the first-open consent pill. This-machine
    // state, so editor_state, never litria.toml.
    if (npmScripts?.pending) {
      try {
        await dbSaveEditorState('npm.scriptsPending', '1');
      } catch (e) {
        console.warn('[project] failed to persist scripts-pending marker:', e);
      }
      // Reflect into the in-flight bootstrap state too — the consent pill
      // must appear on THIS first open (an Electron project can't run until
      // actioned), not on the next one.
      projectState.editorState = {
        ...(projectState.editorState ?? {}),
        'npm.scriptsPending': '1'
      };
    }

    // Persist the wizard's workspace-style color choices into the project's
    // editor_state KV (generic per-project store — no schema change). Read back
    // on open via workspaceStyleFromEditorState.
    const ws = normalizeWorkspaceStyle(workspaceStyle);
    if (workspaceStyle) {
      try {
        await dbSaveEditorState('ws.groupColorMode', ws.groupColorMode ?? '');
        await dbSaveEditorState('ws.defaultFolderGroupColor', ws.defaultFolderGroupColor ?? '');
        await dbSaveEditorState('ws.nodeColorMode', ws.nodeColorMode ?? '');
        await dbSaveEditorState('ws.ungroupedEdgeColor', ws.ungroupedEdgeColor ?? '');
      } catch (e) {
        console.warn('[project] failed to persist workspace style:', e);
      }
    }

    const instance = {
      instanceId: projectState.project.instanceId || createProjectInstanceId(),
      name: projectState.project.name || name,
      rootPath: targetRootPath,
      manifestPath: `${normalizedRoot}/.litria/workspace.db`,
      createdAt: projectState.project.createdAt || new Date().toISOString(),
      updatedAt: projectState.project.updatedAt || new Date().toISOString(),
      workspaceStyle: ws,
      _dbState: projectState
    };
    setProjectInstance(instance);
    await applyPlan(instance.rootPath, scaffoldPlan);
  }, [applyPlan, resolveProjectRootPath, setProjectInstance]);

  // ─── Coordinator: tear down the ACTIVE project ───────────────────────
  //
  // Explicitly tear down the current project's per-project workers in
  // dependency order BEFORE the SQLite connection goes away. Each step is
  // awaited with a timeout safety net so a hung subsystem can't lock the
  // UI indefinitely. The per-subsystem useEffect hooks
  // (useTerminalLifecycle, useTsLspLifecycle, usePythonLspLifecycle)
  // remain as backstops for the unmount/app-close paths but are NOT the
  // primary teardown route here.
  //
  // Shared by project switch (handleOpenProjectInstance) and Exit to
  // Launcher (handleExitToLauncher) — one coordinator so the two paths
  // can't drift. See docs/plans/persistence/project-switch-crash-
  // investigation.md Phase 3 for the ordering rationale.
  const teardownActiveProject = useCallback(async () => {
    if (!projectInstance || !projectInstance.instanceId) return;
    if (terminalDomain) {
      await withTimeout(terminalDomain.commands.teardownAll(), 5000, 'terminal teardown');
    }
    if (languageSupportDomain) {
      await withTimeout(
        languageSupportDomain.commands.teardownTsLifecycle(),
        5000,
        'ts lsp teardown'
      );
      await withTimeout(
        languageSupportDomain.commands.teardownPythonLifecycle(),
        5000,
        'python lsp teardown'
      );
    }
    // Diagnostics are keyed by absolute file path. Without an explicit
    // clear here, entries from the previous project survive into the
    // new one and could collide on shared paths (or just accumulate
    // forever across switches). Run AFTER the LSP teardowns so we
    // don't race their final diagnostic emissions.
    clearAllDiagnostics();
    // The undo stack references the outgoing project's canvas state —
    // undoing across a teardown would resurrect it into whatever comes
    // next (project switch or launcher).
    clearHistory?.();
    // Close the SQLite connection cleanly. Rust drops the Connection
    // and releases the WAL lock. Any in-flight debounced writes from
    // useProjectPersistence will fail harmlessly (the DB is gone).
    try {
      await dbCloseProject();
    } catch (e) {
      console.warn('[project-teardown] dbCloseProject failed:', e);
    }
  }, [projectInstance, terminalDomain, languageSupportDomain, clearHistory]);

  const handleOpenProjectInstance = useCallback(async ({ rootPath }) => {
    const trimmedRootPath = typeof rootPath === 'string' ? rootPath.trim() : '';
    if (!trimmedRootPath) {
      throw new Error('Project path is required.');
    }

    // Dirty-tab gate at the choke point: covers File → Open Project…
    // (deliberately AFTER the folder picker so Discard can't fire for a
    // switch the user then cancels at the picker), the in-workspace
    // ProjectSwitcher, and the launcher (no-op there — no tabs can be
    // dirty). Unsaved workingCode is memory-only, so an unguarded switch
    // silently discards it.
    if (guardUnsavedChanges && !(await guardUnsavedChanges('switch-project'))) {
      return;
    }

    // Tear down the OLD project before opening the NEW one.
    await teardownActiveProject();

    // ─── Open the NEW project ─────────────────────────────────────────
    // db_open_project handles all detection: returning project
    // (.litria/workspace.db), rebuild from marker (litria.toml), or fresh
    // bootstrap (open-any-folder, ADR-016). There is no legacy-manifest
    // migration tier — closed as obsolete, ADR-015 erratum 2026-08-01.
    let projectState;
    try {
      projectState = await dbOpenProject(trimmedRootPath);
    } catch (err) {
      const storageError = typeof getProjectStorageError === 'function'
        ? getProjectStorageError()
        : null;
      throw new Error(getStorageErrorMessage(
        storageError,
        `Could not open project at that path: ${err?.message || err}`
      ));
    }
    const normalizedRoot = trimmedRootPath.replace(/[\\\/]+$/, '');
    setProjectInstance({
      instanceId: projectState.project.instanceId || createProjectInstanceId(),
      name: projectState.project.name || normalizedRoot.split(/[\\\/]/).pop() || 'Litria Project',
      rootPath: trimmedRootPath,
      manifestPath: `${normalizedRoot}/.litria/workspace.db`,
      createdAt: projectState.project.createdAt || new Date().toISOString(),
      updatedAt: projectState.project.updatedAt || new Date().toISOString(),
      workspaceStyle: workspaceStyleFromEditorState(projectState.editorState),
      _dbState: projectState
    });
  }, [
    guardUnsavedChanges,
    teardownActiveProject,
    getProjectStorageError,
    getStorageErrorMessage,
    setProjectInstance
  ]);

  // File → Exit to Launcher: the first half of a project switch with no
  // second half. Teardown, then wipe the workspace state back to pristine —
  // App itself never unmounts, so without the wipe stale pieces would flash
  // before the next project's hydration and would leak into a subsequent
  // launcher single-file session (whose hydration loads nothing). Wipe list
  // mirrors startSingleFileSession, plus connections (the launcher makes
  // single-file sessions reachable AFTER a project for the first time).
  // setProjectInstance(null) re-renders the launch screen; the instanceId
  // change to null also dispatches RESET_SESSION, wiping editor tabs.
  // No clean-shutdown ritual: this is not an app exit.
  const handleExitToLauncher = useCallback(async () => {
    if (guardUnsavedChanges && !(await guardUnsavedChanges('exit-to-launcher'))) {
      return;
    }
    await teardownActiveProject();
    setPieces([]);
    setNextId(1);
    setGroups([]);
    setNextGroupId(1);
    setSelectedGroupId(null);
    setHiddenScaffoldPaths([]);
    clearSelection();
    setConnections?.([]);
    setNextConnectionIdValue?.(1);
    setProjectInstance(null);
  }, [
    guardUnsavedChanges,
    teardownActiveProject,
    clearSelection,
    setConnections,
    setGroups,
    setHiddenScaffoldPaths,
    setNextConnectionIdValue,
    setNextGroupId,
    setNextId,
    setPieces,
    setProjectInstance,
    setSelectedGroupId
  ]);

  // Shared constructor for both single-file session flows ("Open File" and
  // launcher "New File"): one piece on the canvas, no workspace DB
  // (manifestPath null). Keeping the instance + piece shape in one place so
  // the two flows can't drift when the piece schema grows.
  const startSingleFileSession = useCallback(({ name, rootPath, filename, contents, isUntitled = false }) => {
    const now = new Date().toISOString();
    setProjectInstance({
      instanceId: createProjectInstanceId(),
      name,
      rootPath,
      manifestPath: null,
      isUntitled,
      createdAt: now,
      updatedAt: now
    });
    setPieces([{
      id: 1,
      x: 220,
      y: 180,
      filename,
      label: filename,
      color: getRandomPieceColor(),
      code: contents,
      workingCode: contents,
      scale: 1,
      adjacentTo: { top: null, right: null, bottom: null, left: null },
      references: [],
      isSpawning: false
    }]);
    setNextId(2);
    setGroups([]);
    setNextGroupId(1);
    setSelectedGroupId(null);
    setHiddenScaffoldPaths([]);
    clearSelection();
  }, [
    clearSelection,
    setGroups,
    setHiddenScaffoldPaths,
    setNextGroupId,
    setNextId,
    setPieces,
    setProjectInstance,
    setSelectedGroupId
  ]);

  const handleOpenFileInstance = useCallback(async () => {
    // ADR-022 (audit #1): Rust owns the picker AND the read (open_file_dialog),
    // so a consented path never round-trips through JS. Result is
    // { path, contents } on success, { cancelled: true } on cancel, or null on
    // error (surfaced from the storage error state).
    const result = await openFileDialog();
    if (result === null) {
      const storageError = typeof getProjectStorageError === 'function'
        ? getProjectStorageError()
        : null;
      throw new Error(getStorageErrorMessage(
        storageError,
        'Could not open the selected file.'
      ));
    }
    if (result.cancelled) return;
    const { path, contents } = result;
    const { dir: rootPath, base: filename } = splitPathAtLastSeparator(path);
    startSingleFileSession({
      name: filename || 'Opened File',
      rootPath,
      filename: filename || path,
      contents
    });
  }, [
    getProjectStorageError,
    getStorageErrorMessage,
    openFileDialog,
    startSingleFileSession
  ]);

  // Launcher "New File": a single untitled node with no disk backing and no
  // project root. Same single-file mode as Open File except rootPath starts
  // EMPTY — every rootPath-gated subsystem (scaffold ops, discovery, LSP,
  // recents) skips until the first save materializes a location via the
  // untitled Save As gate (isUntitled marks the session for that gate).
  // Deliberately does NOT open an editor tab: setProjectInstance triggers
  // RESET_SESSION once the instance id lands, which would wipe a tab opened
  // here.
  const handleNewFileInstance = useCallback(() => {
    startSingleFileSession({
      name: UNTITLED_FILENAME,
      rootPath: '',
      filename: UNTITLED_FILENAME,
      contents: getHeaderCommentForFilename(UNTITLED_FILENAME) ?? '',
      isUntitled: true
    });
  }, [startSingleFileSession]);

  // File → Open Project…: pick a folder, then run the standard open flow
  // (which tears down the current project before switching). The menu item
  // was previously wired STRAIGHT to handleOpenProjectInstance — invoked
  // with no rootPath it threw "Project path is required." (first bug
  // captured end-to-end by the B5 crash log, 2026-07-07).
  const handleMenuOpenProject = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Open Project Folder'
      });
      const rootPath = Array.isArray(selected) ? selected[0] : selected;
      if (typeof rootPath !== 'string' || !rootPath.trim()) return; // canceled
      await handleOpenProjectInstance({ rootPath });
    } catch (error) {
      showToast?.(
        error instanceof Error ? error.message : 'Failed to open project.',
        { severity: 'error' }
      );
    }
  }, [handleOpenProjectInstance, showToast]);

  return {
    handleCreateProjectInstance,
    handleOpenProjectInstance,
    handleOpenFileInstance,
    handleNewFileInstance,
    handleMenuOpenProject,
    handleExitToLauncher
  };
}
