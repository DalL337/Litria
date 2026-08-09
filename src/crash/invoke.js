// invoke.js — the crash system's one safe-invoke wrapper. Crash plumbing
// must never throw into app code, so every call swallows failures.
//
// The @tauri-apps/api/core import is prewarmed at module load: the shutdown
// ritual runs under a tight timeout, and a cold dynamic import must not eat
// its budget.

const apiPromise = import('@tauri-apps/api/core').catch(() => null);

export async function invokeSafe(command, payload) {
  try {
    const api = await apiPromise;
    if (!api) return null;
    return await api.invoke(command, payload);
  } catch {
    return null;
  }
}
