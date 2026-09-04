import { useEffect, useState } from 'react';
import { usePlatformConfig } from './usePlatformConfig';

/**
 * The absolute folder the New Project wizard starts in on first run.
 *
 * Computed, never a literal. Until 2026-08-31 the wizard fell back to
 * `platformDefaults.placeholderNewProjectPath` — a string named *placeholder*
 * that was being passed as an actual value — so on macOS and Linux the
 * destination handed to Rust was the literal `~/Projects/python-projects`.
 * Nothing expanded `~`, and a `.app` launched from Finder has cwd `/`, so the
 * path resolved against the sealed read-only system volume and creation failed
 * with `Read-only file system (os error 30)`.
 *
 * Windows never showed it only because its literal (`C:\Projects\...`) happened
 * to be absolute — the same code path with a luckier string.
 * (Journal: .research/2026-08-31-macos-tilde-default-path.md)
 *
 * Returns `''` until the home directory resolves, and on failure. Callers must
 * treat empty as "no default" rather than substituting one, so a broken lookup
 * surfaces as an empty field the user can fill instead of a bad path they
 * cannot see.
 *
 * @returns {string} Absolute path, or '' when not (yet) known.
 */
export function useDefaultProjectFolder() {
  const { projectsDirName } = usePlatformConfig();
  const [folder, setFolder] = useState('');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Dynamic import keeps the Tauri path API out of the module graph for
        // non-Tauri contexts (tests, plain vite preview), per Rule 2.
        const { homeDir, join } = await import('@tauri-apps/api/path');
        const home = await homeDir();
        if (!home) return;
        const resolved = await join(home, projectsDirName);
        if (!cancelled) setFolder(resolved);
      } catch {
        // Leave it empty — an empty location field is recoverable, a wrong one
        // is the bug this hook exists to prevent.
      }
    })();

    return () => { cancelled = true; };
  }, [projectsDirName]);

  return folder;
}
