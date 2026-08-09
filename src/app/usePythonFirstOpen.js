// usePythonFirstOpen (ADR-020 Slice 4) — first-open affordances for Python
// projects: one pill per open, priority env-finish > deps-install > run-hint.
//
// Runs once per project load (the useDiscoveryLifecycle token idiom:
// `_dbState` is a fresh object every dbOpen/dbBootstrap). Detection is
// probe-shaped, never diagnostic-parsing (ADR-005 A2): pyproject.toml is
// read and summarized, `.venv/pyvenv.cfg` presence is the env truth, and
// the interpreter probe supplies uv availability + a validated interpreter.
// The pill carries the exact shell input; PillNotification opens the
// visible terminal drawer and types it there (class-3 boundary — the
// project's own tooling runs where the user can see it).
//
// "Actioned" persists to editor_state (never offered again); a dismissed
// pill returns next open — mis-clicking X must not bury the action forever.

import { useEffect, useRef } from 'react';
import { readProjectFile } from '../project/storage';
import { dbSaveEditorState } from '../project/dbStorage';
import {
  parsePyprojectSummary,
  decidePythonFirstOpen,
  buildPythonOfferCommand,
  buildPythonOfferMessage,
  PY_FIRST_OPEN_FLAGS,
} from '../scaffold/pythonFirstOpenModel';

export function usePythonFirstOpen({ projectInstance, pillDomain, languageSupportDomain }) {
  const ranForTokenRef = useRef(null);

  useEffect(() => {
    const token = projectInstance?._dbState;
    if (!token || !projectInstance?.rootPath || !pillDomain || !languageSupportDomain) return undefined;
    if (ranForTokenRef.current === token) return undefined;
    ranForTokenRef.current = token;

    let cancelled = false;
    (async () => {
      const rootPath = projectInstance.rootPath;
      const pyprojectText = await readProjectFile(rootPath, 'pyproject.toml');
      const summary = parsePyprojectSummary(pyprojectText);
      if (!summary || cancelled) return;

      const venvExists = (await readProjectFile(rootPath, '.venv/pyvenv.cfg')) !== null;
      if (cancelled) return;

      const editorState = token.editorState ?? {};
      const flags = Object.fromEntries(
        Object.entries(PY_FIRST_OPEN_FLAGS).map(([kind, key]) => [kind, editorState[key] === '1'])
      );
      const kind = decidePythonFirstOpen({ summary, venvExists, flags });
      if (!kind || cancelled) return;

      // Probe lazily — only when an offer is actually on the table. Supplies
      // uv availability and validates the bound interpreter still exists.
      const probe = await languageSupportDomain.commands.probePythonInterpreters();
      if (cancelled) return;
      const bound = editorState['env.python.interpreter'];
      const interpreterPath =
        bound && probe.interpreters.some((i) => i.path === bound)
          ? bound
          : probe.interpreters[0]?.path ?? null;

      const isWindows = (window.navigator?.platform ?? '').toLowerCase().includes('win');
      const offer = buildPythonOfferCommand({
        kind,
        summary,
        uvAvailable: probe.uvAvailable,
        interpreterPath,
        isWindows,
      });
      if (!offer || cancelled) return;

      pillDomain.commands.addPill({
        projectId: projectInstance.instanceId,
        message: buildPythonOfferMessage(kind, offer.display),
        severity: 'info',
        command: offer.command,
        onActivated: () => {
          // Persist "actioned" so this offer never re-appears for the
          // project. Fire-and-forget: a failed write only means one extra
          // offer on the next open.
          dbSaveEditorState(PY_FIRST_OPEN_FLAGS[kind], '1').catch(() => {});
        },
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [projectInstance, pillDomain, languageSupportDomain]);
}
