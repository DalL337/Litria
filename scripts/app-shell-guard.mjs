import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const APP_FILE = path.join(ROOT, 'src', 'App.jsx');

// ============================================================================
// Shell composition manifest.
//
// App.jsx is a composition shell. Everything it contains must pass the
// four-rule test (docs/Orchestration.md §1.3):
//   1. Imports
//   2. Hook invocations (src/app/use* or src/behaviors/use*)
//   3. Truly cross-cutting wiring with no natural domain owner
//   4. Composition that would force a bad abstraction to extract
//
// This manifest is the enforced import surface of that contract — ratified
// 2026-07-10 after the Tier 1/2 debt cleanup (PRs #111/#112) removed every
// four-rule violation from the shell. It is permanent, not transitional:
// entries are affirmative grants, and the list growing with new features is
// healthy — a shell that composes N domains imports N modules.
//
// Adding an entry: run the four-rule test first. If the import carries logic
// the shell would then invoke inline, extract the hook/domain and list THAT
// instead — the default response to a guard rejection is extract, not amend.
// Every addition needs a one-line rationale comment.
//
// Known blind spot: this guard checks the import surface only. Inline logic
// can grow inside App.jsx with zero new imports — reviews of App.jsx-touching
// PRs must apply the four-rule test by hand.
// ============================================================================
const SHELL_COMPOSITION_MANIFEST = new Set([
  // --- Domain factories, contexts, and providers -------------------------
  // Rule-4 composition: constructing domains and composing providers is the
  // shell's job. One entry per wired domain (Orchestration.md §2 register).
  './app/pieceDomain',
  './app/selectionDomain',
  './app/groupDomain',
  './app/connectionDomain',
  './app/interactionDomain',
  './app/languageSupportDomain',
  './app/themeDomain',
  './project/projectDomain',
  './terminal/terminalDomain',
  './terminal/pillDomain',
  // Build/scaffold diagnostics domain — same shape as pillDomain: the shell
  // constructs it and threads it to the wizard, the pill, and the log drawer.
  './app/buildLogDomain',
  './history/undoManager',
  './editor/EditorSessionContext',
  './app/WorkspaceContext',

  // --- Pure modules the shell threads between domains --------------------
  // Rule-3 wiring: values passed into domain factories/param bags, never
  // invoked as inline shell logic.
  './history/actions',
  './app/selectors/workspaceSelectors',

  // --- Canvas behavior hooks ----------------------------------------------
  // Rule-2: the pointer/selection/viewport behavior family predating the
  // domain refactor; consumed by the interaction domain wiring.
  './behaviors',

  // --- Lifecycle hooks -----------------------------------------------------
  // Rule-2: session-scoped effects (persistence, LSP activation, teardown)
  // that bind domains to the project lifecycle.
  './project/useProjectPersistence',
  './terminal/useTerminalLifecycle',
  './app/usePythonLspLifecycle',
  // Python first-open offers (ADR-020 Slice 4) — per-open lifecycle hook,
  // same composition shape as the LSP lifecycle hooks.
  './app/usePythonFirstOpen',
  // npm scripts-off consent pill (ADR-021 §3) — same first-open pill shape.
  './app/useNpmScriptsFirstOpen',
  // Managed-server install offers (ADR-005 A3) — file-open reconciler pill.
  './app/useManagedServerOffers',
  // Go class-3 toolchain offer (ADR-005 Slice 6.5) — same file-open pill shape.
  './app/useGoToolchainOffer',
  // Managed-server session lifecycle (ADR-005 Slice 6) — one hook for all
  // generic pack languages, same composition shape as the LSP lifecycle hooks.
  './app/useManagedLspLifecycle',
  './app/useTsLspLifecycle',
  './app/useSyntaxDomainLifecycle',
  './app/useDiscoveryLifecycle',
  // Off-canvas import badge (brief-cross-group-wires S3) — bridges discovery's
  // pending edges, scaffold piece creation, and the stage badge props.
  './app/useOffCanvasImports',
  // Drop-on-pill picker (brief-cross-group-wires S4) — routes wire-drag misses
  // to the collapsed-pill picker/expand preference.
  './app/useWireDropOnPill',
  './app/useWindowCloseGuard',
  // Blocks webview navigation on external file drops — required companion of
  // tauri.conf.json dragDropEnabled:false (which un-breaks in-page HTML5 DnD).
  './app/useExternalFileDropGuard',
  // Group-folder reconciliation — ensures folder = group invariant (Option A safety net)
  './app/useGroupFolderReconciliation',
  // DP2 ghost-group rectification (brief-group-physicality W4) — once-per-open disk healing
  './app/useGroupPhysicalityMigration',
  './app/useRecentProjects',
  // Build-log IO (persist/copy/list) — the invoke half of buildLogDomain,
  // kept out of the domain so the domain stays pure state.
  './app/useBuildLogs',

  // --- Extracted shell-logic hooks -----------------------------------------
  // Rule-2: each owns logic App.jsx once declared inline (extraction sessions
  // 1-4, then Tier 1/2). If a hook here grows a second unrelated concern,
  // split it — don't route new logic through an existing grant.
  // Launch flows: create/open/open-file/new-file + File→Open Project dialog.
  './app/useProjectLaunch',
  // Group context-menu command family (rename, collapse, theme, save, delete).
  './app/useGroupMenuActions',
  // Scaffold tree selection/visibility/open actions.
  './app/useScaffoldActions',
  // Scaffold drag-drop + context-menu file operations (via FSM).
  './app/useScaffoldOperations',
  // Piece creation modal + piece click/double-click actions.
  './app/usePieceUiActions',
  // Canvas-level UI actions (group menu toggle, pill select, wire delete).
  './app/useCanvasUiActions',
  // Exit prompt save/discard/cancel flows (window close guard companion).
  './app/useExitPromptActions',
  // Shared dirty-tab gate for project-lifecycle transitions (live switch,
  // exit to launcher) — promise-based confirm + prompt state; injected into
  // useProjectLaunch as guardUnsavedChanges.
  './app/useUnsavedChangesGate',
  // Group menu open/anchor/rename-field UI state.
  './app/useGroupMenuUi',
  // Theme commands + palette state (create/rename/delete/accent/tokens).
  './app/useThemeActions',
  // Preferences panel open-state (ADR-019 Slice 2) — File menu surface.
  './app/usePreferencesSurface',
  // Splash gating on the splashScreen preference (ADR-024) — mounts the
  // overlay only after global prefs resolve; never flash-then-remove.
  './app/useSplashVisibility',
  // Global keyboard shortcuts — owns the window keydown
  // listener and the key→action dispatch table App.jsx used to declare inline.
  // The natural seam for the future shortcut registry.
  './app/useGlobalShortcuts',
  // Syntax picker + wire action menu — owns picker/wire
  // selection state, symbol resolution dispatch, and screen-anchor math that
  // lived inline in App.jsx since the discovery-canvas arc.
  './app/useSyntaxPickerActions',
  // Filesystem write manager hook — wraps the centralized fs mutation
  // service (PRD-FSM-001) in a memoized hook. Extracted from App.jsx
  // in Session 1 Group B of the app-shell extraction refactor.
  './app/useFilesystemWriteManager',
  // Group/piece drop handlers — owns the pendingGroupDrop modal state and
  // the three drag-resolution callbacks. Extracted from App.jsx in
  // Session 2 Group C of the app-shell extraction refactor.
  './app/useGroupDropHandlers',
  // Render-time derivations and visibility selectors. Extracted from
  // App.jsx in Session 3 Group D of the app-shell extraction refactor.
  './app/useWorkspaceRenderSelectors',
  // Group context-menu canvas/screen anchor math. Extracted from App.jsx
  // in Session 3 Group E of the app-shell extraction refactor.
  './app/useGroupMenuAnchor',
  // WorkspaceStage prop bag. Extracted from App.jsx in Session 3 Group F
  // of the app-shell extraction refactor.
  './app/useWorkspaceStageBindings',
  // Viewport navigation handlers (StatusBar zoom, navigate-to-piece,
  // navigate-home, select-dirty-tab) + the fit/reset family (Tier 1 —
  // was duplicated five ways across menu/status-bar/shortcut bodies).
  './app/useViewportNavigation',
  // MenuBar prop bag — mirrors the useWorkspaceStageBindings pattern.
  // Added for the feedback #7 menubar buildout; menu structure itself lives
  // in src/components/menuBarItems.js (pure, tested).
  './app/useMenuBarBindings',
  // Canvas-node → editor-pane drop (ADR-017 Phase C node→pane slice) —
  // wraps the piece-drag handlers; geometry in app/editorDropGeometry.js
  // (pure, tested).
  './app/useEditorPaneDrop',
  // Canvas quick-action HUD state (ADR-018 Phase A) — position/visibility
  // persistence + H keybind; pure logic in app/hudState.js (node-tested).
  './app/useCanvasHud',
  // Untitled Save As resolver (launcher New File) — materializes the project
  // root on first save of an untitled single-file session. App only wires it
  // between useEditorSession and useProjectPersistence; session-shape logic
  // lives in project/untitledSession.js (pure, node-tested).
  './app/useUntitledSaveAs',

  // --- Crash system wiring (B5) --------------------------------------------
  // App wires session context (setCrashProjectName) + the project-lifecycle
  // breadcrumb; pure logic in crash/crashDomain.js (node-tested).
  './crash/errorCapture',
  './crash/breadcrumbs',
  // B5 boot sequence (marker phase, app info, startup scan → launch notices).
  // Crash system is fully self-contained in src/crash/.
  './crash/useCrashBoot',
]);

const DOMAIN_PREFIXES = ['./behaviors/', './history/', './project/', './editor/', './app/', './terminal/', './crash/'];

function parseImports(sourceText) {
  const importRegex = /^\s*import(?:[\s\w{},*]+\s+from\s+)?['"]([^'"]+)['"]/gm;
  const imports = [];
  let match = importRegex.exec(sourceText);
  while (match) {
    imports.push(match[1]);
    match = importRegex.exec(sourceText);
  }
  return imports;
}

function isDomainImport(specifier) {
  return specifier === './behaviors' || DOMAIN_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

function run() {
  if (!fs.existsSync(APP_FILE)) {
    console.error('App shell guard: src/App.jsx not found.');
    process.exit(1);
  }

  const text = fs.readFileSync(APP_FILE, 'utf8');
  const imports = parseImports(text);

  const violations = imports.filter((specifier) => isDomainImport(specifier) && !SHELL_COMPOSITION_MANIFEST.has(specifier));

  if (violations.length > 0) {
    console.error('App shell guard failed. Domain-coupled imports not in the shell composition manifest:');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    console.error('Run the four-rule test (docs/Orchestration.md §1.3). Default response: extract the logic into a hook/domain and list that. If this genuinely is composition, add it to the manifest with a one-line rationale comment.');
    process.exit(1);
  }

  console.log('App shell guard passed.');
}

run();
