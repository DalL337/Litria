// Node module hook: a plain stand-in for `@tauri-apps/api/core`.
//
// Every `invoke(command, payload)` is handed to `globalThis.__INVOKE__`, which
// the test file installs, so a test can drive a real hook or component and
// assert on the commands it sends without a Tauri runtime. Registered per test
// file via `module.register`; the production build never sees this file.
// (workspace-epoch-stub.mjs is the specialised version that models the
// workspace database for the ADR-032 tests.)

const STUB = `
export async function invoke(command, payload = {}) {
  return globalThis.__INVOKE__(command, payload);
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
