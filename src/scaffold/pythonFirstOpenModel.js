// ---------------------------------------------------------------------------
// Python first-open model (ADR-020 Slice 4) — pure decision logic for the
// first-open offers: finish a deferred environment, install declared
// dependencies (visible terminal, click = run — owner decision), or a
// one-time first-run hint. No React, no IPC; the hook feeds it and the pill
// carries what it returns.
//
// The offer command is SHELL INPUT typed into the project's visible terminal
// session (PowerShell on Windows, sh-family elsewhere) — never a spawned
// executable. That is the ADR-005 class-3 boundary: the project's own
// tooling runs where the user can see it.
// ---------------------------------------------------------------------------

const DEP_STRING_RE = /"([^"\n]+)"|'([^'\n]+)'/g;

function extractArrayItems(source) {
  const items = [];
  let match;
  while ((match = DEP_STRING_RE.exec(source)) !== null) {
    const value = (match[1] ?? match[2] ?? '').trim();
    if (value) items.push(value);
  }
  return items;
}

function sectionBody(text, header) {
  // From the exact `[header]` line to the next `[section]` line or EOF.
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${header}]`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*\[/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * Tolerant, dependency-free summary of a pyproject.toml. Returns null when
 * the text is missing or has no [project] table (not a Python project we
 * should offer anything for). Regex-based on purpose: the frontend has no
 * TOML parser, and these files are ones Litria itself wrote in the common
 * case — exotic TOML degrades to "no offer", never to a wrong command.
 */
export function parsePyprojectSummary(text) {
  if (typeof text !== 'string' || !text.includes('[project]')) return null;

  const projectBody = sectionBody(text, 'project') ?? '';
  let deps = [];
  const depsMatch = projectBody.match(/(^|\n)\s*dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (depsMatch) deps = extractArrayItems(depsMatch[2]);

  let devDeps = [];
  const groupsBody = sectionBody(text, 'dependency-groups');
  if (groupsBody) {
    const devMatch = groupsBody.match(/(^|\n)\s*dev\s*=\s*\[([\s\S]*?)\]/);
    if (devMatch) devDeps = extractArrayItems(devMatch[2]);
  }

  const pyrightBody = sectionBody(text, 'tool.pyright');
  const expectsVenv = !!pyrightBody && /(^|\n)\s*venv\s*=\s*["']\.venv["']/.test(pyrightBody);

  return {
    hasProject: true,
    deps,
    devDeps,
    expectsVenv,
    hasBuildSystem: text.includes('[build-system]'),
  };
}

/** editor_state keys gating each offer (persisted when actioned). */
export const PY_FIRST_OPEN_FLAGS = {
  'create-env': 'hint.python.envOffered',
  'install-deps': 'hint.python.depsOffered',
  'first-run': 'hint.python.firstRunShown',
};

/**
 * Which offer (if any) this open deserves. One pill maximum, priority:
 * finish the environment > install deps > first-run hint. Flags are the
 * persisted "already actioned" markers; a dismissed-but-unactioned pill
 * returns on the next open (cheap, and mis-clicking X must not bury a
 * useful one-click action forever).
 */
export function decidePythonFirstOpen({ summary, venvExists, flags = {} }) {
  if (!summary?.hasProject) return null;
  const hasDeps = summary.deps.length > 0 || summary.devDeps.length > 0;
  if (summary.expectsVenv && !venvExists && !flags['create-env']) return 'create-env';
  if (venvExists && hasDeps && !flags['install-deps']) return 'install-deps';
  if (venvExists && !hasDeps && !summary.hasBuildSystem && !flags['first-run']) return 'first-run';
  return null;
}

function quoteForShell(path, isWindows) {
  // PowerShell needs the call operator for a quoted executable path.
  return isWindows ? `& "${path}"` : `"${path}"`;
}

/**
 * The exact shell input for the offer, or null when nothing runnable exists
 * (no uv and no interpreter → no pill; toolchain honesty means we never
 * fabricate a command that cannot work).
 * Returns { command, display } — display is the short form the pill names
 * (the pill must state exactly what it runs, ADR-020 owner decision).
 */
export function buildPythonOfferCommand({ kind, summary, uvAvailable, interpreterPath, isWindows }) {
  const venvPython = isWindows ? '.venv\\Scripts\\python.exe' : '.venv/bin/python';
  if (kind === 'create-env') {
    if (uvAvailable) {
      const command = interpreterPath
        ? `uv venv .venv --python "${interpreterPath}"`
        : 'uv venv .venv';
      return { command, display: 'uv venv .venv' };
    }
    if (interpreterPath) {
      const command = `${quoteForShell(interpreterPath, isWindows)} -m venv .venv`;
      return { command, display: 'python -m venv .venv' };
    }
    return null;
  }
  if (kind === 'install-deps') {
    if (uvAvailable) return { command: 'uv sync', display: 'uv sync' };
    const pip = `${quoteForShell(venvPython, isWindows)} -m pip install`;
    if (summary.hasBuildSystem) {
      const extras = summary.devDeps.length ? ` ${summary.devDeps.join(' ')}` : '';
      return { command: `${pip} -e .${extras}`, display: 'pip install -e .' };
    }
    const packages = [...summary.deps, ...summary.devDeps];
    if (packages.length === 0) return null;
    return { command: `${pip} ${packages.join(' ')}`, display: 'pip install' };
  }
  if (kind === 'first-run') {
    if (uvAvailable) return { command: 'uv run main.py', display: 'uv run main.py' };
    return {
      command: `${quoteForShell(venvPython, isWindows)} main.py`,
      display: 'python main.py',
    };
  }
  return null;
}

/** Pill copy — names the exact command it will run in the terminal. */
export function buildPythonOfferMessage(kind, display) {
  switch (kind) {
    case 'create-env':
      return `Finish Python setup — runs ${display} in the terminal`;
    case 'install-deps':
      return `Install dependencies — runs ${display} in the terminal`;
    case 'first-run':
      return `Try it — runs ${display} in the terminal`;
    default:
      return display;
  }
}
