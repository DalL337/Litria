import { useReducer, useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal, Copy, FileDown } from 'lucide-react';
import { getFrameworks, getLanguages, getAddons, getAddonDeps, isLanguageLocked } from '../scaffold/compatibility-matrix';
import { pinnedCreateSpec, pinnedAddonSpecs, previewCreateLabel, SCAFFOLD_POSTURE_NOTE } from '../scaffold/create-cli-versions';
import {
  PY_ARCHETYPES,
  PY_ENV_MODES,
  PY_ENGINES,
  PY_ENV_CAPTION,
  isPythonWrapper,
  derivePythonFloor,
  derivePythonNames,
  resolvePythonEngine,
  buildPythonPlanPreview,
  buildPythonReviewRows,
  pickDefaultInterpreter,
} from '../scaffold/pythonWizardModel';
import { isDestinationError } from '../scaffold/creationErrors';
import { THEME_ACCENT_SWATCHES } from '../app/themeDomain';
import { BUILTIN_THEME_IDS } from '../theme/themeDefaults';
import { getLastProjectDir, rememberProjectDir } from '../utils/lastProjectDir';
import { getLastPyInterpreter, rememberPyInterpreter } from '../utils/lastPyInterpreter';
import WizardStylePreview from './WizardStylePreview';

// ---------------------------------------------------------------------------
// Card data — matches Widget API Contract and prototype exactly
// ---------------------------------------------------------------------------

const WRAPPERS = [
  { id: 'tauri', name: 'Tauri', icon: '\u{1F980}', desc: 'Rust-powered native desktop', badge: 'DESKTOP', badgeClass: 'npw-badge-tauri', tier: 'npw-tier-tauri' },
  { id: 'electron', name: 'Electron', icon: '\u26A1', desc: 'Node-powered native desktop', badge: 'DESKTOP', badgeClass: 'npw-badge-electron', tier: 'npw-tier-electron' },
  { id: 'web', name: 'Web Only', icon: '\u{1F310}', desc: 'Browser-first, no wrapper', badge: 'WEB', badgeClass: 'npw-badge-web', tier: 'npw-tier-web' },
  // Python (ADR-020): offline blueprint scaffold — Litria writes the files
  // itself, creates the venv with local tools only, and never installs
  // anything at creation. No npm, no network, no third-party code execution.
  { id: 'python', name: 'Python', icon: '\u{1F40D}', desc: 'Offline scaffold, environment-ready', badge: 'OFFLINE', badgeClass: 'npw-badge-python', tier: 'npw-tier-python' },
  // Blank is a first-class template, not a wrapper: no CLI scaffold, no npm,
  // no prerequisites. Generates only the stack-agnostic substrate (README
  // with a quote, .gitignore, .editorconfig) \u2014 the one path that always works.
  { id: 'blank', name: 'Blank', icon: '\u{1F331}', desc: 'No scaffold \u2014 just the essentials', badge: 'INSTANT', badgeClass: 'npw-badge-default', tier: 'npw-tier-blank' },
];

// Substrate files the Blank template generates (mirrors the Rust command's
// creation order; shown in the review card and command preview).
const BLANK_FILES = ['README.md', '.gitignore', '.editorconfig'];

const FRAMEWORKS = [
  { id: 'react', name: 'React', icon: '\u269B\uFE0F', bg: 'rgba(97,218,251,0.1)', desc: 'Component-driven UI' },
  { id: 'svelte', name: 'Svelte', icon: '\u{1F525}', bg: 'rgba(255,62,0,0.1)', desc: 'Compiled, minimal runtime' },
  { id: 'vue', name: 'Vue', icon: '\u{1F49A}', bg: 'rgba(66,184,131,0.1)', desc: 'Progressive, approachable' },
  { id: 'angular', name: 'Angular', icon: '\u{1F170}\uFE0F', bg: 'rgba(221,0,49,0.1)', desc: 'Full platform, TypeScript-first' },
  { id: 'solid', name: 'Solid', icon: '\u{1F4A0}', bg: 'rgba(68,107,230,0.1)', desc: 'Fine-grained reactivity' },
  // Python archetypes render through this same card row — the compatibility
  // matrix filter picks them when the runtime is python, and the section
  // label switches to "Project Type" (they are archetypes, not frameworks).
  ...PY_ARCHETYPES,
];

const LANGUAGES = [
  { id: 'ts', name: 'TypeScript', icon: '\u{1F537}', bg: 'rgba(49,120,198,0.1)', desc: 'Typed, safer, recommended' },
  { id: 'js', name: 'JavaScript', icon: '\u{1F7E8}', bg: 'rgba(247,223,30,0.1)', desc: 'Flexible, zero overhead' },
  { id: 'py', name: 'Python', icon: '\u{1F40D}', bg: 'rgba(53,114,165,0.1)', desc: 'Readable, batteries included' },
];

const BACKENDS = [
  { id: 'none', name: 'None', icon: '\u{1F6AB}', bg: 'rgba(255,255,255,0.04)', desc: 'Frontend only', badge: 'DEFAULT', badgeClass: 'npw-badge-default', isDefault: true },
  { id: 'express', name: 'Express', icon: '\u{1F7E9}', bg: 'rgba(255,255,255,0.06)', desc: 'Minimal Node.js server', badge: 'NODE', badgeClass: 'npw-badge-web' },
  { id: 'fastify', name: 'Fastify', icon: '\u26A1', bg: 'rgba(255,200,50,0.08)', desc: 'Fast, low overhead Node', badge: 'NODE', badgeClass: 'npw-badge-web' },
];

const ADDONS = [
  { id: 'tailwind', name: 'Tailwind', icon: '\u{1F30A}', bg: 'rgba(56,189,248,0.1)', desc: 'Utility-first CSS' },
  { id: 'shadcn', name: 'ShadCN', icon: '\u{1F9E9}', bg: 'rgba(255,255,255,0.05)', desc: 'Accessible UI components' },
  { id: 'router', name: 'Router', icon: '\u{1F500}', bg: 'rgba(99,102,241,0.1)', desc: 'Client-side navigation' },
  // Python add-ons are declaration-only: files + pyproject entries at
  // creation; nothing installs (ADR-020 — deps go via the visible terminal).
  { id: 'pytest', name: 'pytest', icon: '\u{1F9EA}', bg: 'rgba(5,150,105,0.1)', desc: 'Test scaffold + dev dependency (declared)' },
  { id: 'ruff', name: 'Ruff', icon: '\u{1F9F9}', bg: 'rgba(212,93,54,0.1)', desc: 'Linter + formatter config in pyproject' },
];

const THEMES = [
  { id: 'glass', name: 'Glass', tag: 'GLASS \u00B7 DEFAULT', gradient: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(20,184,166,0.1))' },
  { id: 'obsidian', name: 'Obsidian', tag: 'GLASS \u00B7 SMOKED', gradient: 'linear-gradient(135deg, #1b1626, #2a2340)' },
  { id: 'parchment', name: 'Parchment', tag: 'MATTE \u00B7 WARM LIGHT', gradient: 'linear-gradient(135deg, #f2e4c4, #e0cfa8)' },
  { id: 'terminal', name: 'Terminal', tag: 'MATTE \u00B7 FLAT GREEN', gradient: 'linear-gradient(135deg, #0d1117, rgba(62,207,90,0.25), #0d1117)' },
];

const PM_OPTIONS = ['npm', 'pnpm', 'yarn'];

// Workspace-style color modes (prototype page 3 → "Shape the workspace").
const GROUP_COLOR_MODES = [
  { id: 'auto', name: 'Auto groups', icon: '✦', desc: 'Litria assigns friendly group colors as folders appear.' },
  { id: 'custom', name: 'Custom default', icon: '◈', desc: 'Use one starting group color and adjust later.' },
];

const NODE_COLOR_MODES = [
  { id: 'inherit', name: 'Inherit group', icon: '↳', desc: 'New pieces borrow the color of their folder group.' },
  { id: 'custom', name: 'Custom default', icon: '◆', desc: 'New standalone pieces start with one chosen color.' },
];

const PAGE_COUNT = 4;

// ---------------------------------------------------------------------------
// State reducer — cascade resets on parent tier changes
// ---------------------------------------------------------------------------

const INITIAL_STATE = {
  name: '',
  folder: '',
  wrapper: null,
  framework: null,
  lang: null,
  backend: 'none',
  addons: [],
  manager: 'npm',
  theme: 'glass',
  groupColorMode: 'auto',
  groupColor: '#26a69a',
  nodeColorMode: 'inherit',
  nodeColor: '#42a5f5',
  // Live/Calm viewing lens. Seeded from the global preference and, on create,
  // written back to it (see LaunchScreen) so the project opens in the previewed
  // level. Switches the preview palette to pastel equivalents in Calm.
  energyLevel: 'live',
  // Python environment strip (ADR-020 Slice 2). Deliberately NOT cleared by
  // the wrapper-cascade reset: toggling away from Python and back keeps the
  // interpreter/env choices (they describe the machine, not the stack).
  pyInterpreter: null,      // absolute path of the chosen interpreter
  pyEnvMode: 'venv',        // 'venv' | 'direct' | 'existing'
  pyEnvEngine: 'auto',      // 'auto' | 'uv' | 'venv'
  pyExistingEnv: '',        // path when pyEnvMode === 'existing'
  pyRequiresFloor: null,    // editable Capstone row; auto-derived on pick
};

function wizardReducer(state, action) {
  switch (action.type) {
    case 'SET_NAME':
      return { ...state, name: action.value };
    case 'SET_FOLDER':
      return { ...state, folder: action.value };
    case 'SET_WRAPPER':
      return { ...state, wrapper: action.value, framework: null, lang: null, backend: 'none', addons: [] };
    case 'SET_FRAMEWORK': {
      const locked = isLanguageLocked(action.value);
      return { ...state, framework: action.value, lang: locked ?? null, backend: 'none', addons: [] };
    }
    case 'SET_LANG':
      return { ...state, lang: action.value, backend: 'none', addons: [] };
    case 'SET_BACKEND':
      return { ...state, backend: action.value };
    case 'TOGGLE_ADDON': {
      const has = state.addons.includes(action.value);
      if (has) {
        // Don't remove if another selected addon depends on it.
        const isDep = state.addons.some((a) => getAddonDeps(a).includes(action.value));
        if (isDep) return state;
        return { ...state, addons: state.addons.filter((a) => a !== action.value) };
      }
      const next = [...state.addons, action.value];
      // Auto-enable dependencies.
      for (const dep of getAddonDeps(action.value)) {
        if (!next.includes(dep)) next.push(dep);
      }
      return { ...state, addons: next };
    }
    case 'SET_MANAGER':
      return { ...state, manager: action.value };
    case 'SET_PY_INTERPRETER':
      // Picking an interpreter re-derives the requires-python floor; the
      // Capstone row stays editable afterwards (ADR-020 owner decision).
      return {
        ...state,
        pyInterpreter: action.path,
        pyRequiresFloor: derivePythonFloor(action.version) ?? state.pyRequiresFloor,
      };
    case 'SET_PY_ENV_MODE':
      return { ...state, pyEnvMode: action.value };
    case 'SET_PY_ENGINE':
      return { ...state, pyEnvEngine: action.value };
    case 'SET_PY_EXISTING_ENV':
      return { ...state, pyExistingEnv: action.value };
    case 'SET_PY_REQUIRES_FLOOR':
      return { ...state, pyRequiresFloor: action.value };
    case 'SET_THEME':
      return { ...state, theme: action.value };
    case 'SET_GROUP_COLOR_MODE':
      return { ...state, groupColorMode: action.value };
    case 'SET_GROUP_COLOR':
      return { ...state, groupColor: action.value };
    case 'SET_NODE_COLOR_MODE':
      return { ...state, nodeColorMode: action.value };
    case 'SET_NODE_COLOR':
      return { ...state, nodeColor: action.value };
    case 'SET_ENERGY_LEVEL':
      return { ...state, energyLevel: action.value === 'calm' ? 'calm' : 'live' };
    case 'RESET':
      return { ...INITIAL_STATE };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Flag preview builder — mirrors prototype's buildFlagPreview()
// ---------------------------------------------------------------------------

function buildCommandPreview(state) {
  if (state.wrapper === 'blank') {
    return [
      { type: 'key', text: 'blank' },
      { type: 'val', text: ` ${state.name.trim() || 'my-app'}` },
      { type: 'comment', text: ` # ${BLANK_FILES.join(' + ')} — no scaffold, no npm` },
    ];
  }
  if (!state.wrapper || !state.framework || !state.lang) return null;

  const name = state.name.trim() || 'my-app';
  const fw = state.framework;
  const isTs = state.lang === 'ts';

  let parts = [];

  if (state.wrapper === 'tauri') {
    const tpl = fw === 'angular' ? 'angular' : isTs ? `${fw}-ts` : fw;
    parts.push({ type: 'key', text: previewCreateLabel('tauri') });
    parts.push({ type: 'val', text: ` ${name}` });
    parts.push({ type: 'key', text: ' --template' });
    parts.push({ type: 'val', text: ` ${tpl}` });
    if (state.manager !== 'npm') {
      parts.push({ type: 'key', text: ' --manager' });
      parts.push({ type: 'val', text: ` ${state.manager}` });
    }
  } else if (state.wrapper === 'electron') {
    const tpl = isTs ? 'vite-typescript' : 'vite';
    parts.push({ type: 'key', text: previewCreateLabel('electron') });
    parts.push({ type: 'val', text: ` ${name}` });
    parts.push({ type: 'key', text: ` --template=` });
    parts.push({ type: 'val', text: tpl });
    parts.push({ type: 'comment', text: ` # +${fw}` });
    if (state.manager !== 'npm') {
      parts.push({ type: 'key', text: ' --manager' });
      parts.push({ type: 'val', text: ` ${state.manager}` });
    }
  } else {
    const tpl = fw === 'angular' ? 'angular' : isTs ? `${fw}-ts` : fw;
    parts.push({ type: 'key', text: previewCreateLabel('web') });
    parts.push({ type: 'val', text: ` ${name}` });
    parts.push({ type: 'key', text: ' --template' });
    parts.push({ type: 'val', text: ` ${tpl}` });
    if (state.manager !== 'npm') {
      parts.push({ type: 'key', text: ' --manager' });
      parts.push({ type: 'val', text: ` ${state.manager}` });
    }
    if (state.backend !== 'none') {
      parts.push({ type: 'comment', text: ` # +backend: ${state.backend}` });
    }
  }

  for (const addon of state.addons) {
    parts.push({ type: 'comment', text: ` # +${addon}` });
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Review card builder
// ---------------------------------------------------------------------------

function capitalize(str) {
  if (!str) return '\u2014';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Tauri command rejections are plain {category, code, message} objects, not
// Error instances \u2014 duck-type the message out of whatever shape arrives.
function toErrorMessage(err, fallback) {
  if (typeof err === 'object' && err !== null && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return typeof err === 'string' && err ? err : fallback;
}

function buildReviewRows(state) {
  if (state.wrapper === 'blank') {
    return [
      ['Project', state.name.trim() || 'my-app'],
      ['Location', state.folder.trim() || '\u2014'],
      ['Template', 'Blank'],
      ['Generated Files', BLANK_FILES.join(', ')],
      ['Scaffold', 'None \u2014 instant, no prerequisites'],
    ];
  }
  const langLabel = state.lang === 'ts' ? 'TypeScript' : state.lang === 'js' ? 'JavaScript' : '\u2014';

  let backendLabel = 'None';
  if (state.wrapper === 'tauri') backendLabel = 'Rust (via Tauri)';
  else if (state.wrapper === 'electron') backendLabel = 'Node (via Electron)';
  else if (state.backend && state.backend !== 'none') backendLabel = capitalize(state.backend);

  const addonList = state.addons.length > 0 ? state.addons.map(capitalize).join(', ') : 'None';

  return [
    ['Project', state.name.trim() || 'my-app'],
    ['Location', state.folder.trim() || '\u2014'],
    ['Wrapper', capitalize(state.wrapper)],
    ['Framework', capitalize(state.framework)],
    ['Language', langLabel],
    ['Backend', backendLabel],
    ['Addons', addonList],
    ['Package Manager', state.manager || 'npm'],
  ];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function NewProjectWizard({
  onDone,
  onCancel,
  defaultFolder,
  initialEnergyLevel,
  initialTheme,
  // Build-log surface. The domain captures the FULL event stream (the
  // rendered buffer below still truncates, to protect the DOM); the actions
  // copy or persist it. All optional — the wizard works without them.
  buildLogDomain = null,
  buildLogActions = null,
  // 'always' (default) | 'warnings' | 'never' — how long the trace stays up
  // once a run ends. Before this existed the trace unmounted the instant
  // scaffolding stopped, taking the only explanation of a failure with it.
  tracePause = 'always',
  autoSendLogs = false,
}) {
  const [state, dispatch] = useReducer(wizardReducer, {
    ...INITIAL_STATE,
    folder: defaultFolder || '',
    // Seed the Live/Calm preview toggle from the current global preference so
    // the preview starts truthful (e.g. already-Calm users see Calm).
    energyLevel: initialEnergyLevel === 'calm' ? 'calm' : 'live',
    // Seed the base theme from the defaultBaseTheme preference (ADR-019
    // Slice 4): the wizard picks from the user's ground and goes.
    theme: BUILTIN_THEME_IDS.includes(initialTheme) ? initialTheme : INITIAL_STATE.theme,
  });
  const [page, setPage] = useState(0);
  const [direction, setDirection] = useState('forward');
  const [isScaffolding, setIsScaffolding] = useState(false);
  const [progressLines, setProgressLines] = useState([]);
  const [error, setError] = useState('');
  // Phase of the last failure. A destination failure must not offer
  // "Create as Blank" — Blank writes to the same place and fails identically.
  const [errorIsDestination, setErrorIsDestination] = useState(false);
  // Held completion: the run succeeded but the trace stays up until the user
  // acts (see `tracePause`). Carries the onDone payload until they continue.
  const [pendingDone, setPendingDone] = useState(null);
  const [traceMenuOpen, setTraceMenuOpen] = useState(false);
  // Same clipping problem the pill menu has: .npw-modal is overflow:hidden and
  // .npw-body scrolls, so an absolutely-positioned menu gets cut off. Anchor
  // it to the button's measured rect and render it fixed.
  const [traceMenuAnchor, setTraceMenuAnchor] = useState({ top: 0, right: 0 });
  const [traceStatus, setTraceStatus] = useState('');
  // Python interpreter inventory (ADR-020): probed once when the Python card
  // is first selected, re-scannable from the empty state. status:
  // 'idle' | 'loading' | 'ready' | 'error'.
  const [pyProbe, setPyProbe] = useState({
    status: 'idle',
    interpreters: [],
    excluded: [],
    uvAvailable: false,
  });

  // -- Page validation --
  const page0Valid = state.name.trim() !== '' && state.folder.trim() !== '';
  const isBlank = state.wrapper === 'blank';
  const isPython = isPythonWrapper(state.wrapper);
  // Blank needs no stack: the wrapper choice alone completes the page.
  // Python never blocks on interpreter state (ADR-020: creation proceeds
  // files-only when no Python exists) — archetype + auto-locked language
  // complete the page exactly like any other stack.
  const page1Valid = isBlank || (state.wrapper !== null && state.framework !== null && state.lang !== null);

  // -- Python interpreter probe --
  const runPythonProbe = useCallback(async () => {
    setPyProbe((prev) => ({ ...prev, status: 'loading' }));
    try {
      const { detectPythonInterpreters } = await import('../lsp/lspClient');
      const report = await detectPythonInterpreters();
      const interpreters = Array.isArray(report?.interpreters) ? report.interpreters : [];
      setPyProbe({
        status: 'ready',
        interpreters,
        excluded: Array.isArray(report?.excluded) ? report.excluded : [],
        uvAvailable: report?.uvAvailable === true,
      });
      // Preselect: keep the current pick if still present, else the
      // remembered last choice, else the probe's recommended first entry.
      const defaultPath = pickDefaultInterpreter(
        interpreters,
        state.pyInterpreter ?? getLastPyInterpreter()
      );
      if (defaultPath) {
        const chosen = interpreters.find((i) => i.path === defaultPath);
        dispatch({ type: 'SET_PY_INTERPRETER', path: defaultPath, version: chosen?.version ?? null });
      }
    } catch {
      setPyProbe({ status: 'error', interpreters: [], excluded: [], uvAvailable: false });
    }
  }, [state.pyInterpreter]);

  useEffect(() => {
    if (isPython && pyProbe.status === 'idle') runPythonProbe();
  }, [isPython, pyProbe.status, runPythonProbe]);

  // -- Navigation --
  const goNext = () => { setDirection('forward'); setPage((p) => p + 1); setError(''); setErrorIsDestination(false); };
  const goBack = () => { setDirection('backward'); setPage((p) => p - 1); setError(''); setErrorIsDestination(false); };

  // -- Folder picker --
  const handlePickFolder = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Project Location',
        defaultPath: getLastProjectDir(),
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (typeof path === 'string' && path) {
        dispatch({ type: 'SET_FOLDER', value: path });
        // Picked folder is the container the new project goes into — remember it.
        rememberProjectDir(path, { isContainer: true });
        setError('');
      }
    } catch {
      setError('Folder picker unavailable.');
    }
  }, []);

  // Shared by both creation paths: everything the launch flow needs besides
  // the creation result itself. One builder so the blank and scaffold
  // payloads can't drift as wizard pages grow.
  const buildDonePayloadBase = useCallback((rootPath) => ({
    name: state.name.trim(),
    rootPath,
    theme: state.theme,
    energyLevel: state.energyLevel,
    workspaceStyle: {
      groupColorMode: state.groupColorMode,
      defaultFolderGroupColor: state.groupColorMode === 'custom' ? state.groupColor : null,
      nodeColorMode: state.nodeColorMode,
      ungroupedEdgeColor: state.nodeColorMode === 'custom' ? state.nodeColor : null,
    },
  }), [state]);

  // Hand off to the workspace, or hold the trace on screen until the user
  // acts. Holding is the default (`tracePause: 'always'`): a run that emitted
  // warnings used to navigate away before they could be read.
  const finishRun = useCallback(async (payload) => {
    if (autoSendLogs) {
      await buildLogActions?.sendCurrentRunToLogs?.();
    }
    const hold =
      tracePause === 'always' ||
      (tracePause === 'warnings' && (buildLogDomain?.selectors.hasIssues?.() ?? false));
    if (!hold) {
      await onDone(payload);
      return;
    }
    setIsScaffolding(false);
    setPendingDone(payload);
  }, [autoSendLogs, buildLogActions, buildLogDomain, onDone, tracePause]);

  // "Open Workspace" — the explicit continue after a held run.
  const handleContinue = useCallback(async () => {
    if (!pendingDone) return;
    const payload = pendingDone;
    setPendingDone(null);
    try {
      await onDone(payload);
    } catch (err) {
      setError(toErrorMessage(err, 'Opening the workspace failed.'));
      setErrorIsDestination(false);
    }
  }, [onDone, pendingDone]);

  const handleCopyTrace = useCallback(async () => {
    setTraceMenuOpen(false);
    const ok = await buildLogActions?.copyCurrentRun?.();
    setTraceStatus(ok ? 'Copied to clipboard.' : 'Copy failed.');
  }, [buildLogActions]);

  const handleSendTraceToLogs = useCallback(async () => {
    setTraceMenuOpen(false);
    const path = await buildLogActions?.sendCurrentRunToLogs?.();
    setTraceStatus(path ? 'Saved to build logs.' : 'Could not write the log.');
  }, [buildLogActions]);

  // Blank creation: no CLI scaffold, no prerequisites, no event channel —
  // one fast local command writes the substrate files, then hands off to the
  // launch flow. Shared by the Blank template's primary path and the
  // create-as-blank fallback offered when a scaffold fails.
  // onDone is awaited so a downstream failure (DB bootstrap, canvas seeding)
  // lands in the caller's catch — otherwise the wizard soft-locks on a
  // success-looking screen with every control disabled.
  const runBlankCreate = useCallback(async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    setProgressLines([{ type: 'step', text: 'Writing project essentials...' }]);
    const result = await invoke('create_blank_project', {
      projectName: state.name.trim(),
      projectLocation: state.folder.trim(),
    });
    setProgressLines((prev) => [...prev, { type: 'done', text: 'Essentials written. Opening workspace...' }]);
    buildLogDomain?.commands.appendEvent({ kind: 'done', success: true });
    await finishRun({
      ...buildDonePayloadBase(result.projectPath),
      // Substrate files → seeded onto the canvas as the first pieces.
      blankFiles: result.createdFiles,
    });
  }, [buildDonePayloadBase, buildLogDomain, finishRun, state.folder, state.name]);

  // -- Scaffold execution --
  const handleDone = useCallback(async () => {
    setIsScaffolding(true);
    setProgressLines([]);
    setError('');
    setPendingDone(null);
    setTraceStatus('');
    buildLogDomain?.commands.startRun({
      projectName: state.name.trim(),
      wrapper: state.wrapper,
      framework: state.framework,
    });

    try {
      const { invoke, Channel } = await import('@tauri-apps/api/core');

      if (state.wrapper === 'blank') {
        await runBlankCreate();
        return;
      }

      // One progress handler for every channel-streaming scaffold (npm +
      // python) — the Capstone renders identical event shapes for both.
      const makeProgressChannel = () => {
        const onEvent = new Channel();
        onEvent.onmessage = (event) => {
          // Full-fidelity capture first: the rendered buffer below drops
          // everything but the last 80 lines, so exports must never read it.
          buildLogDomain?.commands.appendEvent(event);
          setProgressLines((prev) => {
            const next = [...prev];
            if (event.kind === 'stepStarted') {
              next.push({ type: 'step', text: `[${event.step}/${event.total}] ${event.label}...` });
            } else if (event.kind === 'stepOutput') {
              next.push({ type: 'line', text: event.line });
            } else if (event.kind === 'stepCompleted') {
              next.push({ type: 'step', text: `✓ ${event.label}` });
            } else if (event.kind === 'stepFailed') {
              next.push({ type: 'error', text: `✗ ${event.label}: ${event.error}` });
            } else if (event.kind === 'warning') {
              // ADR-021 §2: age-gate fail-open (and other advisories) must be
              // visible, not just logged.
              next.push({ type: 'warn', text: `⚠ ${event.line}` });
            } else if (event.kind === 'done') {
              next.push({ type: event.success ? 'done' : 'error', text: event.success ? 'Scaffold complete!' : 'Scaffold finished with errors.' });
            }
            return next.length > 100 ? next.slice(-80) : next;
          });
        };
        return onEvent;
      };

      // Python routes to python_scaffold (ADR-020 Slice 3) — the offline
      // blueprint executor — never to the npm-shaped scaffold_project
      // command, whose wrapper enum would reject it.
      if (isPythonWrapper(state.wrapper)) {
        const { distName, moduleName } = derivePythonNames(state.name);
        const config = {
          projectName: state.name.trim(),
          projectLocation: state.folder.trim(),
          archetype: state.framework,
          distName,
          moduleName,
          addons: state.addons,
          requiresFloor: state.pyRequiresFloor?.trim() || null,
          envMode: state.pyEnvMode,
          // Resolve 'auto' here so the plan preview and the executed command
          // can never disagree (the preview used the same resolution).
          envEngine: resolvePythonEngine(state.pyEnvEngine, pyProbe.uvAvailable),
          interpreterPath: state.pyInterpreter,
          existingEnv: state.pyEnvMode === 'existing' ? (state.pyExistingEnv.trim() || null) : null,
        };
        const result = await invoke('scaffold_python_project', {
          config,
          onEvent: makeProgressChannel(),
        });
        if (state.pyInterpreter) rememberPyInterpreter(state.pyInterpreter);
        await onDone({
          ...buildDonePayloadBase(result.projectPath),
          // Blueprint files → seeded onto the canvas, same channel as Blank.
          blankFiles: result.createdFiles,
          stack: { language: 'python', framework: state.framework },
          pythonEnv: {
            interpreter: state.pyInterpreter,
            floor: state.pyRequiresFloor?.trim() || null,
          },
        });
        return;
      }

      const config = {
        projectName: state.name.trim(),
        projectLocation: state.folder.trim(),
        wrapper: state.wrapper,
        framework: state.framework,
        language: state.lang,
        backend: state.backend === 'none' ? null : state.backend,
        addons: state.addons,
        manager: state.manager,
        theme: state.theme,
        // ADR-021 §1: exact pinned specs for every CLI the runner executes.
        // The runner refuses bare/ranged/latest specs — pins live in
        // src/scaffold/create-cli-versions.js only.
        createCliSpec: pinnedCreateSpec(state.wrapper),
        addonCliSpecs: pinnedAddonSpecs(),
        // Workspace style (Step 2). Persisted into the project by Slice 2b so the
        // canvas reflects these defaults; collected here regardless.
        groupColorMode: state.groupColorMode,
        defaultFolderGroupColor: state.groupColorMode === 'custom' ? state.groupColor : null,
        nodeColorMode: state.nodeColorMode,
        ungroupedEdgeColor: state.nodeColorMode === 'custom' ? state.nodeColor : null,
      };

      const result = await invoke('scaffold_project', { config, onEvent: makeProgressChannel() });

      // Awaited for the same reason as the blank branch: a rejection from the
      // launch flow must reach our catch, not vanish fire-and-forget.
      await finishRun({
        ...buildDonePayloadBase(result.projectPath),
        scaffoldResult: result,
        // ADR-021 §3: installs ran scripts-off on the npm path — the marker
        // drives the first-open consent pill (npm rebuild, terminal-visible).
        npmScripts: { pending: !!result.scriptsSkipped },
      });
    } catch (err) {
      const message = toErrorMessage(err, 'Scaffold failed.');
      setErrorIsDestination(isDestinationError(err));
      buildLogDomain?.commands.failRun(message);
      if (autoSendLogs) {
        await buildLogActions?.sendCurrentRunToLogs?.();
      }
      setError(message);
      setIsScaffolding(false);
    }
  }, [autoSendLogs, buildDonePayloadBase, buildLogActions, buildLogDomain, finishRun, runBlankCreate, state]);

  // Offered in the page-3 error area after a scaffold failure: same
  // name/location/theme/workspace-style choices, created as Blank instead —
  // the one path with no prerequisites. Note: if the failed scaffold left
  // debris in the target folder, create_blank_project refuses it
  // ("not empty") and that message replaces the error; the offer stays so
  // the user can clean up or rename and try again.
  const handleBlankFallback = useCallback(async () => {
    setIsScaffolding(true);
    setError('');
    // Fresh run: the fallback is a second attempt, so it gets its own log
    // rather than appending to the failed scaffold's trace.
    buildLogDomain?.commands.startRun({
      projectName: state.name.trim(),
      wrapper: 'blank',
      framework: state.framework,
    });
    try {
      await runBlankCreate();
    } catch (err) {
      const message = toErrorMessage(err, 'Blank creation failed.');
      setErrorIsDestination(isDestinationError(err));
      buildLogDomain?.commands.failRun(message);
      setError(message);
      setIsScaffolding(false);
    }
  }, [buildLogDomain, runBlankCreate, state.framework, state.name]);

  // -- Cancel --
  const handleCancel = useCallback(() => {
    if (isScaffolding) return;
    dispatch({ type: 'RESET' });
    onCancel();
  }, [isScaffolding, onCancel]);

  // -- Render helpers --
  const commandPreview = isPython
    ? buildPythonPlanPreview(state, pyProbe)
    : buildCommandPreview(state);
  const reviewRows = isPython
    ? buildPythonReviewRows(state, pyProbe)
    : buildReviewRows(state);

  // Blank hides the entire stack cascade — there is no stack.
  const showFramework = state.wrapper !== null && !isBlank;
  const showLang = state.framework !== null && !isBlank;
  const showBackend = state.wrapper === 'web' && state.lang !== null;
  const showAddons = state.lang !== null && !isBlank;
  // Python replaces the npm manager row with the environment strip.
  const showPackageManager = !isBlank && !isPython;
  const showPythonEnv = isPython && state.framework !== null;

  // Matrix-driven filtering: only valid options appear at each cascade step.
  // 'blank' is not in the compatibility matrix — guard against lookups.
  const availableFrameworks = state.wrapper && !isBlank ? getFrameworks(state.wrapper) : [];
  const availableLangs = state.framework ? getLanguages(state.framework) : [];
  const availableAddons = state.framework ? getAddons(state.framework) : [];
  const lockedLang = state.framework ? isLanguageLocked(state.framework) : null;

  // -- Step dots --
  const dots = Array.from({ length: PAGE_COUNT }, (_, i) => {
    let cls = 'npw-dot';
    if (i === page) cls += ' active';
    else if (i < page) cls += ' done';
    return <div key={i} className={cls} />;
  });

  // -- Page titles --
  const titles = [
    { title: "Let's start here.", sub: 'Name it. Place it. Let\u2019s build.' },
    { title: 'Pick your stack.', sub: 'Choose what powers your project.' },
    { title: 'Shape the workspace.', sub: 'Set the visual defaults before you touch the desk.' },
    { title: 'Ready to create.', sub: 'This is the project Litria is about to make.' },
  ];

  return (
    <div className="npw-overlay" role="dialog" aria-modal="true">
      <div className="npw-modal">
        {/* ---- Header ---- */}
        <div className="npw-header">
          <div className="npw-dots">{dots}</div>
          <div className="npw-title">{titles[page].title}</div>
          <div className="npw-subtitle">{titles[page].sub}</div>
        </div>

        {/* ---- Body ---- */}
        <div className="npw-body">
          {page === 0 && (
            <div className={`npw-page ${direction === 'backward' ? 'backward' : ''}`} key="page0">
              <div className="npw-field">
                <label className="npw-label" htmlFor="npw-name">Project Name</label>
                <input
                  id="npw-name"
                  className="npw-input"
                  value={state.name}
                  onChange={(e) => dispatch({ type: 'SET_NAME', value: e.target.value })}
                  placeholder="my-awesome-app"
                  autoFocus
                />
              </div>
              <div className="npw-field">
                <label className="npw-label" htmlFor="npw-folder">Project Location</label>
                <div className="npw-picker-row">
                  <input
                    id="npw-folder"
                    className="npw-input"
                    value={state.folder}
                    onChange={(e) => dispatch({ type: 'SET_FOLDER', value: e.target.value })}
                    placeholder={defaultFolder || '/home/user/projects/...'}
                  />
                  <button className="npw-browse-btn" type="button" onClick={handlePickFolder}>
                    Browse
                  </button>
                </div>
              </div>
            </div>
          )}

          {page === 1 && (
            <div className={`npw-page ${direction === 'backward' ? 'backward' : ''}`} key="page1">
              {/* Wrapper */}
              <div className="npw-section-label">Runtime Wrapper</div>
              <div className="npw-card-row">
                {WRAPPERS.map((w) => (
                  <div
                    key={w.id}
                    className={`npw-card${state.wrapper === w.id ? ' selected' : ''}`}
                    onClick={() => dispatch({ type: 'SET_WRAPPER', value: w.id })}
                  >
                    <span className="npw-card-check">{'\u2713'}</span>
                    <div className={`npw-card-icon ${w.tier}`}>{w.icon}</div>
                    <div className="npw-card-name">{w.name}</div>
                    <div className="npw-card-desc">{w.desc}</div>
                    <span className={`npw-badge ${w.badgeClass}`}>{w.badge}</span>
                  </div>
                ))}
              </div>

              {/* Framework — filtered by compatibility matrix. For Python the
                  tier holds archetypes, so the label tells the truth. */}
              <div className={`npw-subsection${showFramework ? ' visible' : ''}`}>
                <div className="npw-section-label">{isPython ? 'Project Type' : 'Framework'}</div>
                <div className="npw-card-row">
                  {FRAMEWORKS.filter((fw) => availableFrameworks.includes(fw.id)).map((fw) => (
                    <div
                      key={fw.id}
                      className={`npw-card${state.framework === fw.id ? ' selected' : ''}`}
                      onClick={() => dispatch({ type: 'SET_FRAMEWORK', value: fw.id })}
                    >
                      <span className="npw-card-check">{'\u2713'}</span>
                      <div className="npw-card-icon" style={{ background: fw.bg }}>{fw.icon}</div>
                      <div className="npw-card-name">{fw.name}</div>
                      <div className="npw-card-desc">{fw.desc}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Language — filtered by compatibility matrix */}
              <div className={`npw-subsection${showLang ? ' visible' : ''}`}>
                <div className="npw-section-label">Language</div>
                <div className="npw-card-row">
                  {LANGUAGES.filter((l) => availableLangs.includes(l.id)).map((l) => {
                    const isLocked = lockedLang === l.id;
                    return (
                      <div
                        key={l.id}
                        className={`npw-card${state.lang === l.id ? ' selected' : ''}${isLocked ? ' dep-locked' : ''}`}
                        onClick={() => !isLocked && dispatch({ type: 'SET_LANG', value: l.id })}
                      >
                        <span className="npw-card-check">{'\u2713'}</span>
                        <div className="npw-card-icon" style={{ background: l.bg }}>{l.icon}</div>
                        <div className="npw-card-name">{l.name}</div>
                        <div className="npw-card-desc">{l.desc}</div>
                      </div>
                    );
                  })}
                </div>
                {lockedLang && (
                  <div className="npw-dep-hint">
                    {FRAMEWORKS.find((f) => f.id === state.framework)?.name ?? capitalize(state.framework)} is{' '}
                    {LANGUAGES.find((l) => l.id === lockedLang)?.name}-only
                  </div>
                )}
              </div>

              {/* Backend (Web Only) */}
              <div className={`npw-subsection${showBackend ? ' visible' : ''}`}>
                <div className="npw-section-label">Backend</div>
                <div className="npw-card-row">
                  {BACKENDS.map((b) => (
                    <div
                      key={b.id}
                      className={`npw-card${state.backend === b.id ? ' selected' : ''}`}
                      onClick={() => dispatch({ type: 'SET_BACKEND', value: b.id })}
                    >
                      <span className="npw-card-check">{'\u2713'}</span>
                      <div className="npw-card-icon" style={{ background: b.bg }}>{b.icon}</div>
                      <div className="npw-card-name">{b.name}</div>
                      <div className="npw-card-desc">{b.desc}</div>
                      {b.badge && <span className={`npw-badge ${b.badgeClass}`}>{b.badge}</span>}
                    </div>
                  ))}
                </div>
              </div>

              {/* Addons — filtered by compatibility matrix */}
              <div className={`npw-subsection${showAddons ? ' visible' : ''}`}>
                <div className="npw-section-label">Add-ons</div>
                <div className="npw-card-row">
                  {ADDONS.filter((a) => availableAddons.includes(a.id)).map((a) => {
                    const isSelected = state.addons.includes(a.id);
                    const depParent = state.addons.find((sel) => getAddonDeps(sel).includes(a.id));
                    const isDepLocked = !!depParent;
                    return (
                      <div
                        key={a.id}
                        className={`npw-card${isSelected ? ' selected' : ''}${isDepLocked ? ' dep-locked' : ''}`}
                        onClick={() => dispatch({ type: 'TOGGLE_ADDON', value: a.id })}
                      >
                        <span className="npw-card-check">{'\u2713'}</span>
                        <div className="npw-card-icon" style={{ background: a.bg }}>{a.icon}</div>
                        <div className="npw-card-name">{a.name}</div>
                        <div className="npw-card-desc">{a.desc}</div>
                        {isDepLocked && <div className="npw-dep-hint">required by {ADDONS.find((x) => x.id === depParent)?.name}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Environment strip — Python only (ADR-020). One visible line
                  with an always-visible caption; engine + existing-env live
                  in the expandable detail. Never blocks creation. */}
              <div className={`npw-subsection npw-env-section${showPythonEnv ? ' visible' : ''}`}>
                <div className="npw-section-label">Environment</div>
                {pyProbe.status === 'loading' && (
                  <div className="npw-env-caption">Scanning this machine for Python…</div>
                )}
                {pyProbe.status === 'error' && (
                  <div className="npw-env-empty">
                    <div className="npw-env-caption">
                      The interpreter scan failed. You can still create the project —
                      files only, environment set up later.
                    </div>
                    <button className="npw-browse-btn" type="button" onClick={runPythonProbe}>
                      Re-scan
                    </button>
                  </div>
                )}
                {pyProbe.status === 'ready' && pyProbe.interpreters.length > 0 && (
                  <>
                    <div className="npw-env-row">
                      <select
                        className="npw-env-select"
                        aria-label="Python interpreter"
                        value={state.pyInterpreter ?? ''}
                        onChange={(e) => {
                          const chosen = pyProbe.interpreters.find((i) => i.path === e.target.value);
                          dispatch({ type: 'SET_PY_INTERPRETER', path: e.target.value, version: chosen?.version ?? null });
                        }}
                      >
                        {pyProbe.interpreters.map((i) => (
                          <option key={i.path} value={i.path}>
                            {`Python ${i.version ?? '?'}${i.variant === 'freethreaded' ? 't' : ''} — ${i.path}`}
                          </option>
                        ))}
                      </select>
                      <select
                        className="npw-env-select"
                        aria-label="Environment mode"
                        value={state.pyEnvMode}
                        onChange={(e) => dispatch({ type: 'SET_PY_ENV_MODE', value: e.target.value })}
                      >
                        {PY_ENV_MODES.map((m) => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="npw-env-caption">{PY_ENV_CAPTION}</div>
                    <details className="npw-env-details">
                      <summary>Environment engine</summary>
                      <div className="npw-env-engine-row">
                        {PY_ENGINES.map((engine) => (
                          <label
                            key={engine.id}
                            className={`npw-pm-option${state.pyEnvEngine === engine.id ? ' selected' : ''}`}
                          >
                            <input
                              type="radio"
                              name="npw-py-engine"
                              checked={state.pyEnvEngine === engine.id}
                              onChange={() => dispatch({ type: 'SET_PY_ENGINE', value: engine.id })}
                            />
                            {engine.name}
                            {engine.id === 'auto' && ` — ${pyProbe.uvAvailable ? 'uv detected, will use it' : 'uv not detected, uses python -m venv'}`}
                          </label>
                        ))}
                      </div>
                      {state.pyEnvMode === 'existing' && (
                        <input
                          className="npw-input npw-env-existing"
                          placeholder="Path to an existing environment (e.g. C:\\envs\\shared)"
                          value={state.pyExistingEnv}
                          onChange={(e) => dispatch({ type: 'SET_PY_EXISTING_ENV', value: e.target.value })}
                        />
                      )}
                    </details>
                  </>
                )}
                {pyProbe.status === 'ready' && pyProbe.interpreters.length === 0 && (
                  <div className="npw-env-empty">
                    <div className="npw-env-caption">
                      No Python found on this machine. You can still create the project —
                      files only, and Litria will offer to set up the environment once
                      Python exists. Litria never installs Python itself.
                    </div>
                    {pyProbe.excluded.length > 0 && (
                      <div className="npw-env-caption npw-env-stub">
                        {'⚠'} The {'“'}python{'”'} on this PC is a Microsoft Store
                        shortcut, not an installation.
                      </div>
                    )}
                    <div className="npw-env-caption">
                      Install via python.org (Python Install Manager)
                      {pyProbe.uvAvailable ? ' — or run `uv python install 3.13` in a terminal' : ''}.
                    </div>
                    <button className="npw-browse-btn" type="button" onClick={runPythonProbe}>
                      Re-scan
                    </button>
                  </div>
                )}
              </div>

              {/* Package Manager — meaningless for Blank (no npm involved) */}
              {showPackageManager && (
                <div className="npw-pm-row">
                  <span className="npw-pm-label">Package Manager</span>
                  {PM_OPTIONS.map((pm) => (
                    <label key={pm} className={`npw-pm-option${state.manager === pm ? ' selected' : ''}`}>
                      <input
                        type="radio"
                        name="npw-pm"
                        checked={state.manager === pm}
                        onChange={() => dispatch({ type: 'SET_MANAGER', value: pm })}
                      />
                      {pm}
                    </label>
                  ))}
                </div>
              )}

              {/* Flag Preview */}
              <div className="npw-flag-preview">
                {commandPreview ? (
                  commandPreview.map((part, i) => (
                    <span key={i} className={`npw-flag-${part.type}`}>{part.text}</span>
                  ))
                ) : (
                  <span>Select a stack to see the scaffold command...</span>
                )}
              </div>
              {/* Posture note (ADR-021 §5) — npm-backed stacks only; states
                  exactly what the gate does and its one gap. */}
              {!isBlank && !isPython && state.wrapper !== null && (
                <div className="npw-posture-note">{SCAFFOLD_POSTURE_NOTE}</div>
              )}
            </div>
          )}

          {page === 2 && (
            <div className={`npw-page ${direction === 'backward' ? 'backward' : ''}`} key="page2">
              <div className="npw-style-grid">
                {/* Base theme (top-left) */}
                <div className="npw-style-theme">
                  <div className="npw-section-label">Base Theme</div>
                  <div className="npw-theme-row">
                    {THEMES.map((t) => (
                      <div
                        key={t.id}
                        className={`npw-theme-card${state.theme === t.id ? ' selected' : ''}${t.locked ? ' locked' : ''}`}
                        onClick={() => !t.locked && dispatch({ type: 'SET_THEME', value: t.id })}
                      >
                        {t.locked && <span className="npw-theme-lock">SOON</span>}
                        <div className="npw-theme-preview" style={{ background: t.gradient }} />
                        <div className="npw-theme-name">{t.name}</div>
                        <div className="npw-theme-tag">{t.tag}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Live preview (top-right) */}
                <div className="npw-style-preview">
                  <div className="npw-energy-toggle" role="group" aria-label="Preview energy level">
                    {['live', 'calm'].map((level) => (
                      <button
                        key={level}
                        type="button"
                        className={`npw-energy-option${state.energyLevel === level ? ' selected' : ''}`}
                        aria-pressed={state.energyLevel === level}
                        title={level === 'calm'
                          ? 'Calm — preview your colors as soft pastels'
                          : 'Live — preview your colors at full intensity'}
                        onClick={() => dispatch({ type: 'SET_ENERGY_LEVEL', value: level })}
                      >
                        {level === 'calm' ? 'Calm' : 'Live'}
                      </button>
                    ))}
                  </div>
                  <WizardStylePreview state={state} />
                </div>

                {/* Folder group colors (bottom-left) */}
                <div className="npw-style-group">
                  <div className="npw-section-label">Folder Group Colors</div>
                  <div className="npw-mode-row">
                    {GROUP_COLOR_MODES.map((m) => (
                      <div
                        key={m.id}
                        className={`npw-mode-card${state.groupColorMode === m.id ? ' selected' : ''}`}
                        onClick={() => dispatch({ type: 'SET_GROUP_COLOR_MODE', value: m.id })}
                      >
                        <span className="npw-mode-icon">{m.icon}</span>
                        <div className="npw-mode-name">{m.name}</div>
                        <div className="npw-mode-desc">{m.desc}</div>
                      </div>
                    ))}
                  </div>
                  {state.groupColorMode === 'custom' && (
                    <div className="npw-swatch-grid">
                      {THEME_ACCENT_SWATCHES.map((hex) => (
                        <button
                          key={hex}
                          type="button"
                          className={`npw-swatch${state.groupColor === hex ? ' selected' : ''}`}
                          style={{ background: hex }}
                          title={hex}
                          aria-label={`Group color ${hex}`}
                          onClick={() => dispatch({ type: 'SET_GROUP_COLOR', value: hex })}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Single piece colors (bottom-right) */}
                <div className="npw-style-pieces">
                  <div className="npw-section-label">Single Piece Colors</div>
                  <div className="npw-mode-row">
                    {NODE_COLOR_MODES.map((m) => (
                      <div
                        key={m.id}
                        className={`npw-mode-card${state.nodeColorMode === m.id ? ' selected' : ''}`}
                        onClick={() => dispatch({ type: 'SET_NODE_COLOR_MODE', value: m.id })}
                      >
                        <span className="npw-mode-icon">{m.icon}</span>
                        <div className="npw-mode-name">{m.name}</div>
                        <div className="npw-mode-desc">{m.desc}</div>
                      </div>
                    ))}
                  </div>
                  {state.nodeColorMode === 'custom' && (
                    <div className="npw-swatch-grid">
                      {THEME_ACCENT_SWATCHES.map((hex) => (
                        <button
                          key={hex}
                          type="button"
                          className={`npw-swatch${state.nodeColor === hex ? ' selected' : ''}`}
                          style={{ background: hex }}
                          title={hex}
                          aria-label={`Node color ${hex}`}
                          onClick={() => dispatch({ type: 'SET_NODE_COLOR', value: hex })}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {page === 3 && (
            <div className={`npw-page ${direction === 'backward' ? 'backward' : ''}`} key="page3">
              <div className="npw-capstone">
                <div className="npw-capstone-left">
                  <div className="npw-review">
                    <div className="npw-review-title">Your Project at a Glance</div>
                    {reviewRows.map(([key, val]) => (
                      <div key={key} className="npw-review-row">
                        <span className="npw-review-key">{key}</span>
                        <span className="npw-review-val">{val}</span>
                      </div>
                    ))}
                    {isPython && (
                      // Editable floor (ADR-020 owner decision): pre-filled from
                      // the chosen interpreter's minor, overridable in place.
                      <div className="npw-review-row">
                        <span className="npw-review-key">requires-python</span>
                        <span className="npw-review-val npw-floor-row">
                          {'>='}
                          <input
                            className="npw-floor-input"
                            value={state.pyRequiresFloor ?? ''}
                            placeholder="3.13"
                            aria-label="Minimum Python version"
                            disabled={isScaffolding}
                            onChange={(e) => dispatch({ type: 'SET_PY_REQUIRES_FLOOR', value: e.target.value })}
                          />
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="npw-flag-preview">
                    {commandPreview && commandPreview.map((part, i) => (
                      <span key={i} className={`npw-flag-${part.type}`}>{part.text}</span>
                    ))}
                  </div>
                </div>
                <div className="npw-capstone-right">
                  <WizardStylePreview state={state} />
                  {/* The trace no longer disappears when scaffolding stops —
                      that is what made a failure unreadable. */}
                  {progressLines.length > 0 && (
                    <div className="npw-progress-panel">
                      <div className="npw-progress-header">
                        <span className="npw-progress-title">Build trace</span>
                        <div className="npw-progress-actions">
                          <button
                            className="npw-progress-menu-btn"
                            type="button"
                            aria-label="Build trace actions"
                            aria-haspopup="menu"
                            aria-expanded={traceMenuOpen}
                            onClick={(e) => {
                              if (traceMenuOpen) {
                                setTraceMenuOpen(false);
                                return;
                              }
                              const rect = e.currentTarget.getBoundingClientRect();
                              setTraceMenuAnchor({
                                top: Math.round(rect.bottom + 4),
                                right: Math.round(window.innerWidth - rect.right),
                              });
                              setTraceMenuOpen(true);
                            }}
                          >
                            <MoreHorizontal size={14} />
                          </button>
                          {/* Portalled for the same reason as the pill menu:
                              the modal clips (overflow:hidden) and .npw-page
                              animates a transform, which would capture a
                              fixed-position child. */}
                          {traceMenuOpen && createPortal(
                            <>
                              <div
                                className="npw-progress-menu-backdrop"
                                onClick={() => setTraceMenuOpen(false)}
                              />
                              <div
                                className="npw-progress-menu"
                                role="menu"
                                style={{ top: traceMenuAnchor.top, right: traceMenuAnchor.right }}
                              >
                                <button type="button" role="menuitem" onClick={handleCopyTrace}>
                                  <Copy size={12} /> Copy to clipboard
                                </button>
                                <button type="button" role="menuitem" onClick={handleSendTraceToLogs}>
                                  <FileDown size={12} /> Send to logs
                                </button>
                              </div>
                            </>,
                            document.body
                          )}
                        </div>
                      </div>
                      <div className="npw-progress">
                        {progressLines.map((line, i) => (
                          <div key={i} className={`npw-progress-line${
                            line.type === 'step' ? ' npw-progress-step' :
                            line.type === 'error' ? ' npw-progress-error' :
                            line.type === 'warn' ? ' npw-progress-warn' :
                            line.type === 'done' ? ' npw-progress-done' : ''
                          }`}>
                            {line.text}
                          </div>
                        ))}
                      </div>
                      {traceStatus && <div className="npw-progress-status">{traceStatus}</div>}
                    </div>
                  )}
                  {pendingDone && (
                    <div className="npw-continue">
                      <div className="npw-continue-hint">
                        Project created. Review the trace above — it is discarded
                        when you continue unless you send it to the logs.
                      </div>
                      <button
                        className="npw-btn-done npw-continue-btn"
                        type="button"
                        onClick={handleContinue}
                      >
                        Open Workspace
                      </button>
                    </div>
                  )}
                  {error && <div className="npw-error">{error}</div>}
                  {error && errorIsDestination && (
                    <div className="npw-fallback">
                      <div className="npw-fallback-hint">
                        This is about where the project would go, not how it is built —
                        so creating it as Blank would fail the same way. Go back and
                        choose a different location.
                      </div>
                      <button
                        className="npw-btn-done npw-fallback-btn"
                        type="button"
                        onClick={() => { setError(''); setErrorIsDestination(false); setPage(0); }}
                      >
                        {'\u{1F4C1}'} Choose a different location
                      </button>
                    </div>
                  )}
                  {error && !errorIsDestination && !isScaffolding && !isBlank && (
                    <div className="npw-fallback">
                      <div className="npw-fallback-hint">
                        You can still start this project as Blank — README, .gitignore,
                        and .editorconfig only, no scaffold, no prerequisites. Your name,
                        location, and style choices are kept.
                      </div>
                      <button
                        className="npw-btn-done npw-fallback-btn"
                        type="button"
                        onClick={handleBlankFallback}
                      >
                        {'\u{1F331}'} Create as Blank instead
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ---- Footer ---- */}
        <div className="npw-footer">
          <button
            className="npw-btn-cancel"
            type="button"
            onClick={handleCancel}
            disabled={isScaffolding}
          >
            Cancel
          </button>
          <div className="npw-nav-group">
            <button
              className="npw-btn-nav"
              type="button"
              onClick={goBack}
              disabled={page === 0 || isScaffolding}
            >
              {'\u2190'}
            </button>
            {page < PAGE_COUNT - 1 ? (
              <button
                className={`npw-btn-nav${(page === 0 && page0Valid) || (page === 1 && page1Valid) || page === 2 ? ' active' : ''}`}
                type="button"
                onClick={goNext}
                disabled={(page === 0 && !page0Valid) || (page === 1 && !page1Valid)}
              >
                {'\u2192'}
              </button>
            ) : (
              <button
                className="npw-btn-done"
                type="button"
                onClick={handleDone}
                disabled={isScaffolding}
              >
                {isScaffolding
                  ? (isBlank || isPython ? '\u2726 Creating...' : '\u2726 Scaffolding...')
                  : '\u2726 Create Project'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default NewProjectWizard;
