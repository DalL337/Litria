// ---------------------------------------------------------------------------
// New Project Wizard — standalone prototype
// Wrapped in an IIFE so browser global names from compatibility-matrix.js
// do not collide with local wizard helpers when opened as plain scripts.
// ---------------------------------------------------------------------------

(() => {
// ---------------------------------------------------------------------------
// Matrix-driven stack setup plus workspace-style setup and a capstone review.
// Tauri-only calls (folder dialog, scaffold invoke) are simulated so this
// runs in any browser by double-clicking index.html.
//
// Note: The real app can swap the DOM-based style sample for a Konva preview
// that renders FolderGroupPill, GroupOutline, PuzzlePiece, and EdgeGlow from
// the canvas primitives. This prototype keeps the preview no-build and static.
// ---------------------------------------------------------------------------

const {
  getFrameworks, getLanguages, getAddons,
  getAddonDeps, isLanguageLocked,
} = window.CompatibilityMatrix;

// ---- Card data -------------------------------------------------------------

const WRAPPERS = [
  { id: 'tauri',    name: 'Tauri',    icon: '\u{1F980}', desc: 'Rust-powered native desktop', badge: 'DESKTOP', badgeClass: 'npw-badge-tauri',    tier: 'npw-tier-tauri' },
  { id: 'electron', name: 'Electron', icon: '⚡',        desc: 'Node-powered native desktop', badge: 'DESKTOP', badgeClass: 'npw-badge-electron', tier: 'npw-tier-electron' },
  { id: 'web',      name: 'Web Only', icon: '\u{1F310}', desc: 'Browser-first, no wrapper',   badge: 'WEB',     badgeClass: 'npw-badge-web',      tier: 'npw-tier-web' },
];

const FRAMEWORKS = [
  { id: 'react',   name: 'React',   icon: '⚛️',        bg: 'rgba(97,218,251,0.1)', desc: 'Component-driven UI' },
  { id: 'svelte',  name: 'Svelte',  icon: '\u{1F525}', bg: 'rgba(255,62,0,0.1)',   desc: 'Compiled, minimal runtime' },
  { id: 'vue',     name: 'Vue',     icon: '\u{1F49A}', bg: 'rgba(66,184,131,0.1)', desc: 'Progressive, approachable' },
  { id: 'angular', name: 'Angular', icon: '\u{1F170}️', bg: 'rgba(221,0,49,0.1)',   desc: 'Full platform, TypeScript-first' },
  { id: 'solid',   name: 'Solid',   icon: '\u{1F4A0}', bg: 'rgba(68,107,230,0.1)', desc: 'Fine-grained reactivity' },
];

const LANGUAGES = [
  { id: 'ts', name: 'TypeScript', icon: '\u{1F537}', bg: 'rgba(49,120,198,0.1)', desc: 'Typed, safer, recommended' },
  { id: 'js', name: 'JavaScript', icon: '\u{1F7E8}', bg: 'rgba(247,223,30,0.1)',  desc: 'Flexible, zero overhead' },
];

const BACKENDS = [
  { id: 'none',    name: 'None',    icon: '\u{1F6AB}', bg: 'rgba(255,255,255,0.04)', desc: 'Frontend only',          badge: 'DEFAULT', badgeClass: 'npw-badge-default' },
  { id: 'express', name: 'Express', icon: '\u{1F7E9}', bg: 'rgba(255,255,255,0.06)', desc: 'Minimal Node.js server', badge: 'NODE',    badgeClass: 'npw-badge-web' },
  { id: 'fastify', name: 'Fastify', icon: '⚡',        bg: 'rgba(255,200,50,0.08)',  desc: 'Fast, low overhead Node', badge: 'NODE',   badgeClass: 'npw-badge-web' },
];

const ADDONS = [
  { id: 'tailwind', name: 'Tailwind', icon: '\u{1F30A}', bg: 'rgba(56,189,248,0.1)',   desc: 'Utility-first CSS' },
  { id: 'shadcn',   name: 'ShadCN',   icon: '\u{1F9E9}', bg: 'rgba(255,255,255,0.05)', desc: 'Accessible UI components' },
  { id: 'router',   name: 'Router',   icon: '\u{1F500}', bg: 'rgba(99,102,241,0.1)',   desc: 'Client-side navigation' },
];

const THEMES = [
  { id: 'glass',    name: 'Glass',    tag: 'DEFAULT · AVAILABLE', gradient: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(20,184,166,0.1))', unlocked: true },
  { id: 'obsidian', name: 'Obsidian', tag: 'DEEP DARK',           gradient: 'linear-gradient(135deg, #1a1a2e, #16213e)', locked: true },
  { id: 'terminal', name: 'Terminal', tag: 'RETRO GREEN',         gradient: 'linear-gradient(135deg, #0d1117, rgba(0,255,65,0.2), #0d1117)', locked: true },
  { id: 'paper',    name: 'Paper',    tag: 'LIGHT MODE',          gradient: 'linear-gradient(135deg, #fff8f0, #ffecd2)', locked: true },
];

const GROUP_COLOR_MODES = [
  { id: 'auto',   name: 'Auto groups',    icon: '✦', desc: 'Litria assigns friendly group colors as folders appear.' },
  { id: 'custom', name: 'Custom default', icon: '◈', desc: 'Use one starting group color and adjust later.' },
];

const NODE_COLOR_MODES = [
  { id: 'inherit', name: 'Inherit group', icon: '↳', desc: 'New pieces borrow the color of their folder group.' },
  { id: 'custom',  name: 'Custom default', icon: '◆', desc: 'New standalone pieces start with one chosen color.' },
];

// Real palette — mirrors THEME_ACCENT_SWATCHES in src/app/themeDomain.js.
// Hex values are used as IDs; the app deliberately has no swatch names.
const COLOR_SWATCHES = [
  '#ef5350', '#ec407a', '#ab47bc', '#7e57c2',
  '#5c6bc0', '#42a5f5', '#26c6da', '#26a69a',
  '#66bb6a', '#9ccc65', '#d4e157', '#ffca28',
  '#ffa726', '#ff7043', '#8d6e63', '#78909c',
];

const PM_OPTIONS = ['npm', 'pnpm', 'yarn'];

const PAGE_COUNT = 4;

// ---- State ----------------------------------------------------------------

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
};

const state = {
  ...INITIAL_STATE,
  page: 0,
  direction: 'forward',
  isScaffolding: false,
  progressLines: [],
  error: '',
};

function reduce(action) {
  switch (action.type) {
    case 'SET_NAME': state.name = action.value; break;
    case 'SET_FOLDER': state.folder = action.value; break;
    case 'SET_WRAPPER':
      state.wrapper = action.value;
      state.framework = null;
      state.lang = null;
      state.backend = 'none';
      state.addons = [];
      break;
    case 'SET_FRAMEWORK': {
      const locked = isLanguageLocked(action.value);
      state.framework = action.value;
      state.lang = locked ?? null;
      state.backend = 'none';
      state.addons = [];
      break;
    }
    case 'SET_LANG':
      state.lang = action.value;
      state.backend = 'none';
      state.addons = [];
      break;
    case 'SET_BACKEND': state.backend = action.value; break;
    case 'TOGGLE_ADDON': {
      const has = state.addons.includes(action.value);
      if (has) {
        const isDep = state.addons.some((a) => getAddonDeps(a).includes(action.value));
        if (isDep) break;
        state.addons = state.addons.filter((a) => a !== action.value);
      } else {
        const next = [...state.addons, action.value];
        for (const dep of getAddonDeps(action.value)) {
          if (!next.includes(dep)) next.push(dep);
        }
        state.addons = next;
      }
      break;
    }
    case 'SET_MANAGER': state.manager = action.value; break;
    case 'SET_THEME': state.theme = action.value; break;
    case 'SET_GROUP_COLOR_MODE': state.groupColorMode = action.value; break;
    case 'SET_GROUP_COLOR': state.groupColor = action.value; break;
    case 'SET_NODE_COLOR_MODE': state.nodeColorMode = action.value; break;
    case 'SET_NODE_COLOR': state.nodeColor = action.value; break;
    case 'RESET':
      Object.assign(state, INITIAL_STATE, {
        page: 0,
        direction: 'forward',
        isScaffolding: false,
        progressLines: [],
        error: '',
      });
      break;
  }
  render();
}

// ---- Derived views ---------------------------------------------------------

function capitalize(s) { return !s ? '—' : s.charAt(0).toUpperCase() + s.slice(1); }
function findById(list, id) { return list.find((item) => item.id === id); }
function selectedTheme() { return findById(THEMES, state.theme) ?? THEMES[0]; }
function selectedGroupMode() { return findById(GROUP_COLOR_MODES, state.groupColorMode) ?? GROUP_COLOR_MODES[0]; }
function selectedNodeMode() { return findById(NODE_COLOR_MODES, state.nodeColorMode) ?? NODE_COLOR_MODES[0]; }

function buildCommandPreview() {
  if (!state.wrapper || !state.framework || !state.lang) return null;
  const name = state.name.trim() || 'my-app';
  const fw = state.framework;
  const isTs = state.lang === 'ts';
  const parts = [];

  if (state.wrapper === 'tauri') {
    const tpl = fw === 'angular' ? 'angular' : isTs ? `${fw}-ts` : fw;
    parts.push({ type: 'key', text: 'create-tauri-app' });
    parts.push({ type: 'val', text: ` ${name}` });
    parts.push({ type: 'key', text: ' --template' });
    parts.push({ type: 'val', text: ` ${tpl}` });
    if (state.manager !== 'npm') {
      parts.push({ type: 'key', text: ' --manager' });
      parts.push({ type: 'val', text: ` ${state.manager}` });
    }
  } else if (state.wrapper === 'electron') {
    const tpl = isTs ? 'vite-typescript' : 'vite';
    parts.push({ type: 'key', text: 'create-electron-app' });
    parts.push({ type: 'val', text: ` ${name}` });
    parts.push({ type: 'key', text: ' --template=' });
    parts.push({ type: 'val', text: tpl });
    parts.push({ type: 'comment', text: ` # +${fw}` });
    if (state.manager !== 'npm') {
      parts.push({ type: 'key', text: ' --manager' });
      parts.push({ type: 'val', text: ` ${state.manager}` });
    }
  } else {
    const tpl = fw === 'angular' ? 'angular' : isTs ? `${fw}-ts` : fw;
    parts.push({ type: 'key', text: 'create-vite' });
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

function buildProjectRows() {
  return [
    ['Project', state.name.trim() || 'my-app'],
    ['Location', state.folder.trim() || '—'],
  ];
}

function buildStackRows() {
  const langLabel = state.lang === 'ts' ? 'TypeScript' : state.lang === 'js' ? 'JavaScript' : '—';
  let backend = 'None';
  if (state.wrapper === 'tauri') backend = 'Rust (via Tauri)';
  else if (state.wrapper === 'electron') backend = 'Node (via Electron)';
  else if (state.backend && state.backend !== 'none') backend = capitalize(state.backend);
  const addonList = state.addons.length ? state.addons.map(capitalize).join(', ') : 'None';
  return [
    ['Wrapper', capitalize(state.wrapper)],
    ['Framework', capitalize(state.framework)],
    ['Language', langLabel],
    ['Backend', backend],
    ['Add-ons', addonList],
    ['Package Manager', state.manager || 'npm'],
  ];
}

function buildWorkspaceRows() {
  const nodeDetail = state.nodeColorMode === 'custom'
    ? `${selectedNodeMode().name} · ${state.nodeColor}`
    : selectedNodeMode().name;
  const groupDetail = state.groupColorMode === 'custom'
    ? `${selectedGroupMode().name} · ${state.groupColor}`
    : selectedGroupMode().name;
  return [
    ['Theme', selectedTheme().name],
    ['Groups', groupDetail],
    ['Pieces', nodeDetail],
  ];
}

// ---- DOM helpers -----------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'className') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'checked' || k === 'disabled' || k === 'autofocus') {
      if (v) node.setAttribute(k, '');
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// ---- Navigation ------------------------------------------------------------

function page0Valid() { return state.name.trim() !== '' && state.folder.trim() !== ''; }
function page1Valid() { return state.wrapper && state.framework && state.lang; }
function page2Valid() { return state.theme && state.groupColorMode && state.nodeColorMode; }

function canAdvancePage(page) {
  if (page === 0) return page0Valid();
  if (page === 1) return page1Valid();
  if (page === 2) return page2Valid();
  return false;
}

function goNext() {
  state.direction = 'forward';
  state.page += 1;
  state.error = '';
  render();
}

function goBack() {
  state.direction = 'backward';
  state.page -= 1;
  state.error = '';
  render();
}

// ---- Stubbed Tauri interactions -------------------------------------------

async function pickFolder() {
  const hint = prompt(
    'Prototype folder picker: paste a path (the real wizard opens a native dialog).',
    state.folder || '/Users/you/projects'
  );
  if (typeof hint === 'string' && hint.trim()) {
    reduce({ type: 'SET_FOLDER', value: hint.trim() });
  }
}

async function runScaffold() {
  state.isScaffolding = true;
  state.progressLines = [];
  state.error = '';
  render();

  const steps = [
    'Validating project configuration',
    `Scaffolding ${state.wrapper} + ${state.framework} (${state.lang})`,
    ...(state.backend && state.backend !== 'none' ? [`Adding ${state.backend} backend`] : []),
    ...state.addons.map((a) => `Installing addon: ${a}`),
    `Configuring ${state.manager}`,
    `Applying ${selectedTheme().name} workspace theme`,
    `Setting group colors: ${selectedGroupMode().name}`,
    `Setting piece colors: ${selectedNodeMode().name}`,
    'Writing litria.toml',
  ];

  for (let i = 0; i < steps.length; i++) {
    const label = steps[i];
    state.progressLines.push({ type: 'step', text: `[${i + 1}/${steps.length}] ${label}...` });
    render();
    await new Promise((r) => setTimeout(r, 220));
    state.progressLines.push({ type: 'step', text: `✓ ${label}` });
    render();
  }
  state.progressLines.push({ type: 'done', text: 'Scaffold complete! (simulated)' });
  state.isScaffolding = false;
  render();
}

// ---- Shared renderers ------------------------------------------------------

function renderPageShell(...children) {
  return el('div', { className: `npw-page${state.direction === 'backward' ? ' backward' : ''}` }, children);
}

function renderCard(card, selected, onClick, extra = {}) {
  const classes = ['npw-card'];
  if (selected) classes.push('selected');
  if (extra.depLocked) classes.push('dep-locked');
  if (extra.compact) classes.push('compact');
  return el('div', { className: classes.join(' '), onclick: onClick },
    el('span', { className: 'npw-card-check' }, '✓'),
    el('div', {
      className: `npw-card-icon ${extra.tier || ''}`.trim(),
      style: extra.bg ? { background: extra.bg } : null,
    }, card.icon),
    el('div', { className: 'npw-card-name' }, card.name),
    el('div', { className: 'npw-card-desc' }, card.desc),
    card.badge ? el('span', { className: `npw-badge ${card.badgeClass}` }, card.badge) : null,
    extra.hint ? el('div', { className: 'npw-dep-hint' }, extra.hint) : null,
  );
}

function renderThemeCards() {
  return el('div', { className: 'npw-theme-row' },
    THEMES.map((t) => el('div',
      {
        className: `npw-theme-card${state.theme === t.id ? ' selected' : ''}${t.locked ? ' locked' : ''}`,
        onclick: () => { if (!t.locked) reduce({ type: 'SET_THEME', value: t.id }); },
      },
      t.locked ? el('span', { className: 'npw-theme-lock' }, 'SOON') : null,
      el('div', { className: 'npw-theme-preview', style: { background: t.gradient } }),
      el('div', { className: 'npw-theme-name' }, t.name),
      el('div', { className: 'npw-theme-tag' }, t.tag),
    )),
  );
}

// 8-column grid of unlabeled 22×22 squares — mirrors the real ColorPickerPopup.
function renderSwatches(ariaLabelKind, selectedHex, actionType) {
  return el('div', { className: 'npw-swatch-grid' },
    COLOR_SWATCHES.map((hex) => el('button', {
      type: 'button',
      className: `npw-swatch${selectedHex === hex ? ' selected' : ''}`,
      style: { background: hex },
      title: `${ariaLabelKind}: ${hex}`,
      'aria-label': `${ariaLabelKind} ${hex}`,
      onclick: () => reduce({ type: actionType, value: hex }),
    })),
  );
}

function renderRows(rows) {
  return rows.map(([k, v]) => el('div', { className: 'npw-review-row' },
    el('span', { className: 'npw-review-key' }, k),
    el('span', { className: 'npw-review-val' }, v),
  ));
}

function renderReviewCard(title, rows) {
  return el('div', { className: 'npw-review' },
    el('div', { className: 'npw-review-title' }, title),
    renderRows(rows),
  );
}

function renderCommandPreview() {
  const preview = buildCommandPreview();
  return el('div', { className: 'npw-flag-preview' },
    preview
      ? preview.map((p) => el('span', { className: `npw-flag-${p.type}` }, p.text))
      : el('span', {}, 'Select a stack to see the scaffold command...'),
  );
}

function renderStyleSample({ capstone = false } = {}) {
  const groupCanvas = el('canvas', { className: 'npw-preview-canvas' });
  const standaloneCanvas = el('canvas', { className: 'npw-preview-canvas' });

  requestAnimationFrame(() => {
    window.PreviewCanvas.drawGroupSample(groupCanvas, state);
    window.PreviewCanvas.drawStandaloneSample(standaloneCanvas, state);
  });

  return el('div', {
    className: `npw-style-sample${capstone ? ' capstone' : ''}`,
  },
    el('div', { className: 'npw-style-sample-header' },
      el('div', {},
        el('div', { className: 'npw-style-sample-title' }, 'Workspace Style Sample'),
        el('div', { className: 'npw-style-sample-subtitle' },
          'Real Canvas 2D primitives — same paint path as the live workspace.'),
      ),
      el('span', { className: 'npw-style-sample-badge' }, 'SAMPLE'),
    ),
    el('div', { className: 'npw-preview-split' },
      el('div', { className: 'npw-preview-cell' },
        el('div', { className: 'npw-preview-label' }, 'Folder Group'),
        groupCanvas,
        el('div', { className: 'npw-preview-caption' },
          'Group color tints the outline, pill, and edge strip on member pieces.'),
      ),
      el('div', { className: 'npw-preview-cell' },
        el('div', { className: 'npw-preview-label' }, 'Standalone Piece'),
        standaloneCanvas,
        el('div', { className: 'npw-preview-caption' },
          'Applies only to pieces that live outside any group.'),
      ),
    ),
  );
}

// ---- Page renderers --------------------------------------------------------

function renderPage0() {
  return renderPageShell(
    el('div', { className: 'npw-field' },
      el('label', { className: 'npw-label', for: 'npw-name' }, 'Project Name'),
      el('input', {
        id: 'npw-name', className: 'npw-input',
        value: state.name, placeholder: 'my-awesome-app', autofocus: true,
        oninput: (e) => reduce({ type: 'SET_NAME', value: e.target.value }),
      }),
    ),
    el('div', { className: 'npw-field' },
      el('label', { className: 'npw-label', for: 'npw-folder' }, 'Project Location'),
      el('div', { className: 'npw-picker-row' },
        el('input', {
          id: 'npw-folder', className: 'npw-input',
          value: state.folder, placeholder: '/home/user/projects/...',
          oninput: (e) => reduce({ type: 'SET_FOLDER', value: e.target.value }),
        }),
        el('button', { className: 'npw-browse-btn', type: 'button', onclick: pickFolder }, 'Browse'),
      ),
    ),
  );
}

function renderPage1() {
  const showFramework = state.wrapper !== null;
  const showLang = state.framework !== null;
  const showBackend = state.wrapper === 'web' && state.lang !== null;
  const showAddons = state.lang !== null;
  const availableFrameworks = state.wrapper ? getFrameworks(state.wrapper) : [];
  const availableLangs = state.framework ? getLanguages(state.framework) : [];
  const availableAddons = state.framework ? getAddons(state.framework) : [];
  const lockedLang = state.framework ? isLanguageLocked(state.framework) : null;

  return renderPageShell(
    el('div', { className: 'npw-section-label' }, 'Runtime Wrapper'),
    el('div', { className: 'npw-card-row' },
      WRAPPERS.map((w) => renderCard(
        w, state.wrapper === w.id,
        () => reduce({ type: 'SET_WRAPPER', value: w.id }),
        { tier: w.tier },
      )),
    ),

    el('div', { className: `npw-subsection${showFramework ? ' visible' : ''}` },
      el('div', { className: 'npw-section-label' }, 'Framework'),
      el('div', { className: 'npw-card-row' },
        FRAMEWORKS.filter((f) => availableFrameworks.includes(f.id)).map((f) => renderCard(
          f, state.framework === f.id,
          () => reduce({ type: 'SET_FRAMEWORK', value: f.id }),
          { bg: f.bg },
        )),
      ),
    ),

    el('div', { className: `npw-subsection${showLang ? ' visible' : ''}` },
      el('div', { className: 'npw-section-label' }, 'Language'),
      el('div', { className: 'npw-card-row' },
        LANGUAGES.filter((l) => availableLangs.includes(l.id)).map((l) => {
          const locked = lockedLang === l.id;
          return renderCard(
            l, state.lang === l.id,
            () => { if (!locked) reduce({ type: 'SET_LANG', value: l.id }); },
            { bg: l.bg, depLocked: locked },
          );
        }),
      ),
      lockedLang ? el('div', { className: 'npw-dep-hint' },
        `${capitalize(state.framework)} is ${LANGUAGES.find((l) => l.id === lockedLang).name}-only`,
      ) : null,
    ),

    el('div', { className: `npw-subsection${showBackend ? ' visible' : ''}` },
      el('div', { className: 'npw-section-label' }, 'Backend'),
      el('div', { className: 'npw-card-row' },
        BACKENDS.map((b) => renderCard(
          b, state.backend === b.id,
          () => reduce({ type: 'SET_BACKEND', value: b.id }),
          { bg: b.bg },
        )),
      ),
    ),

    el('div', { className: `npw-subsection${showAddons ? ' visible' : ''}` },
      el('div', { className: 'npw-section-label' }, 'Add-ons'),
      el('div', { className: 'npw-card-row' },
        ADDONS.filter((a) => availableAddons.includes(a.id)).map((a) => {
          const selected = state.addons.includes(a.id);
          const parent = state.addons.find((sel) => getAddonDeps(sel).includes(a.id));
          const depLocked = !!parent;
          const hint = depLocked ? `required by ${ADDONS.find((x) => x.id === parent).name}` : null;
          return renderCard(
            a, selected,
            () => reduce({ type: 'TOGGLE_ADDON', value: a.id }),
            { bg: a.bg, depLocked, hint },
          );
        }),
      ),
    ),

    el('div', { className: 'npw-pm-row' },
      el('span', { className: 'npw-pm-label' }, 'Package Manager'),
      PM_OPTIONS.map((pm) => el('label',
        { className: `npw-pm-option${state.manager === pm ? ' selected' : ''}` },
        el('input', {
          type: 'radio', name: 'npw-pm',
          checked: state.manager === pm,
          onchange: () => reduce({ type: 'SET_MANAGER', value: pm }),
        }),
        pm,
      )),
    ),

    renderCommandPreview(),
  );
}

function renderPage2() {
  return renderPageShell(
    el('div', { className: 'npw-split-layout' },
      // Grid area: theme (top-left)
      el('div', { className: 'npw-area-theme' },
        el('div', { className: 'npw-section-label' }, 'Base Theme'),
        renderThemeCards(),
      ),
      // Grid area: preview (top-right)
      el('div', { className: 'npw-area-preview' },
        renderStyleSample(),
      ),
      // Grid area: group colors (bottom-left)
      el('div', { className: 'npw-area-group' },
        el('div', { className: 'npw-section-label' }, 'Folder Group Colors'),
        el('div', { className: 'npw-card-row' },
          GROUP_COLOR_MODES.map((m) => renderCard(
            m, state.groupColorMode === m.id,
            () => reduce({ type: 'SET_GROUP_COLOR_MODE', value: m.id }),
            { compact: true },
          )),
        ),
        state.groupColorMode === 'custom'
          ? renderSwatches('Group color', state.groupColor, 'SET_GROUP_COLOR')
          : null,
      ),
      // Grid area: piece colors (bottom-right)
      el('div', { className: 'npw-area-pieces' },
        el('div', { className: 'npw-section-label' }, 'Single Piece Colors'),
        el('div', { className: 'npw-card-row' },
          NODE_COLOR_MODES.map((m) => renderCard(
            m, state.nodeColorMode === m.id,
            () => reduce({ type: 'SET_NODE_COLOR_MODE', value: m.id }),
            { compact: true },
          )),
        ),
        state.nodeColorMode === 'custom'
          ? renderSwatches('Node color', state.nodeColor, 'SET_NODE_COLOR')
          : null,
      ),
    ),
  );
}

function renderPage3() {
  const preview = buildCommandPreview();
  return renderPageShell(
    el('div', { className: 'npw-capstone' },
      el('div', { className: 'npw-capstone-left' },
        el('div', { className: 'npw-review-grid' },
          renderReviewCard('Project', buildProjectRows()),
          renderReviewCard('Stack', buildStackRows()),
          renderReviewCard('Workspace', buildWorkspaceRows()),
        ),
      ),
      el('div', { className: 'npw-capstone-right' },
        renderStyleSample({ capstone: true }),
        preview ? renderCommandPreview() : null,
        (state.isScaffolding || state.progressLines.length) ? el('div', { className: 'npw-progress' },
          state.progressLines.map((line) => el('div', {
            className: 'npw-progress-line' +
              (line.type === 'step' ? ' npw-progress-step' :
               line.type === 'error' ? ' npw-progress-error' :
               line.type === 'done' ? ' npw-progress-done' : ''),
          }, line.text)),
        ) : null,
        state.error ? el('div', { className: 'npw-error' }, state.error) : null,
      ),
    ),
  );
}

function renderFooter() {
  const canAdvance = canAdvancePage(state.page);
  const navRight = state.page < PAGE_COUNT - 1
    ? el('button', {
        type: 'button',
        className: `npw-btn-nav${canAdvance ? ' active' : ''}`,
        disabled: !canAdvance || state.isScaffolding,
        onclick: goNext,
      }, '→')
    : el('button', {
        type: 'button',
        className: 'npw-btn-done',
        disabled: state.isScaffolding,
        onclick: runScaffold,
      }, state.isScaffolding ? '✦ Scaffolding...' : '✦ Create Project');

  return el('div', { className: 'npw-footer' },
    el('button', {
      type: 'button', className: 'npw-btn-cancel',
      disabled: state.isScaffolding,
      onclick: () => reduce({ type: 'RESET' }),
    }, 'Cancel'),
    el('div', { className: 'npw-nav-group' },
      el('button', {
        type: 'button', className: 'npw-btn-nav',
        disabled: state.page === 0 || state.isScaffolding,
        onclick: goBack,
      }, '←'),
      navRight,
    ),
  );
}

function renderHeader() {
  const titles = [
    { title: "Let's start here.", sub: 'Name it. Place it. Let’s build.' },
    { title: 'Pick your stack.', sub: 'Choose what powers your project.' },
    { title: 'Shape the workspace.', sub: 'Set the visual defaults before you touch the desk.' },
    { title: 'Ready to create.', sub: 'This is the project Litria is about to make.' },
  ];

  const dots = Array.from({ length: PAGE_COUNT }, (_, i) => {
    let cls = 'npw-dot';
    if (i === state.page) cls += ' active';
    else if (i < state.page) cls += ' done';
    return el('div', { className: cls });
  });

  return el('div', { className: 'npw-header' },
    el('div', { className: 'npw-dots' }, dots),
    el('div', { className: 'npw-title' }, titles[state.page].title),
    el('div', { className: 'npw-subtitle' }, titles[state.page].sub),
  );
}

function renderCurrentPage() {
  if (state.page === 0) return renderPage0();
  if (state.page === 1) return renderPage1();
  if (state.page === 2) return renderPage2();
  return renderPage3();
}

function render() {
  const root = document.getElementById('root');
  root.replaceChildren(
    el('div', { className: 'npw-overlay', role: 'dialog', 'aria-modal': 'true' },
      el('div', { className: 'npw-modal' },
        renderHeader(),
        el('div', { className: 'npw-body' }, renderCurrentPage()),
        renderFooter(),
      ),
    ),
    el('div', { className: 'proto-banner' }, 'Prototype · Matrix + Workspace Setup'),
  );
}

render();

})();
