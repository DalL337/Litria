// Node module hook for the ADR-032 D1 regression test.
//
// Substitutes a stub for `@tauri-apps/api/core` so `src/project/dbStorage.js`
// runs FOR REAL — its epoch stamping is the code under test, so replacing
// dbStorage itself would test the model instead of the chokepoint.
//
// The stub stands in for the Rust side: `globalThis.__EPOCH_BACKEND__` models
// the single `PROJECT_DB` slot (`{ epoch, workspace }`, or null once closed)
// and refuses a mismatched stamp the way `with_workspace_db` does, with the
// same `db.workspace_changed` code. Registered per test file via
// `module.register`; the production build never sees this file.

const STUB = `
export async function invoke(command, payload = {}) {
  const backend = globalThis.__EPOCH_BACKEND__;
  globalThis.__EPOCH_CALLS__.push({
    command,
    stamped: payload.workspaceEpoch ?? null,
    openEpoch: backend?.epoch ?? null,
    workspace: backend?.workspace ?? null,
    payload,
  });

  if (command === 'db_open_project' || command === 'db_bootstrap_project') {
    return globalThis.__EPOCH_OPEN__(payload.path);
  }
  if (command === 'db_close_project') {
    globalThis.__EPOCH_BACKEND__ = null;
    return null;
  }

  // with_workspace_db: the epoch is compared under the same lock that hands
  // out the connection, so a stale request never reaches a database.
  if (!backend || backend.epoch !== (payload.workspaceEpoch ?? null)) {
    const error = new Error('Request was issued for a workspace that is not open.');
    error.code = 'db.workspace_changed';
    throw error;
  }
  globalThis.__EPOCH_APPLIED__.push({ command, workspace: backend.workspace, payload });
  return true;
}

export class Channel {
  constructor() { this.onmessage = null; }
}
`;

export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.includes('@tauri-apps/api/core')) {
    return { format: 'module', source: STUB, shortCircuit: true };
  }
  return nextLoad(url, context);
}
