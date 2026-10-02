// Node module hook: plain stand-ins for `@tauri-apps/api/core` and
// `@tauri-apps/api/event`.
//
// Every `invoke(command, payload)` is handed to `globalThis.__INVOKE__`, which
// the test file installs. `listen(event, handler)` registers the handler, and
// `globalThis.__EMIT__(event, payload)` delivers a backend event to every
// handler registered for it. So a test can drive a real hook or component,
// assert on the commands it sends and play the backend's events, without a
// Tauri runtime. Registered per test file via `module.register`; the
// production build never sees this file. (workspace-epoch-stub.mjs is the
// specialised version that models the workspace database for the ADR-032
// tests.)

const CORE = `
export async function invoke(command, payload = {}) {
  return globalThis.__INVOKE__(command, payload);
}

export class Channel {
  constructor() { this.onmessage = null; }
}
`;

const EVENT = `
function handlers(event) {
  const all = (globalThis.__LISTENERS__ ??= new Map());
  if (!all.has(event)) all.set(event, new Set());
  return all.get(event);
}

globalThis.__EMIT__ = (event, payload) => {
  for (const handler of [...handlers(event)]) handler({ event, payload });
};

export async function listen(event, handler) {
  handlers(event).add(handler);
  return () => handlers(event).delete(handler);
}

export async function emit() {}
`;

export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.includes('@tauri-apps/api/core')) {
    return { format: 'module', source: CORE, shortCircuit: true };
  }
  if (url.includes('@tauri-apps/api/event')) {
    return { format: 'module', source: EVENT, shortCircuit: true };
  }
  return nextLoad(url, context);
}
