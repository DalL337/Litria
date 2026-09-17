// Node module hooks so a test can import a React component source file:
// `.jsx` (and `.js` with JSX) is transformed with esbuild — the compiler Vite
// already brings — and extension-less relative specifiers resolve the way
// Vite resolves them. Registered per test file via `module.register`; the
// production build never sees this file.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';

const CANDIDATES = ['', '.js', '.jsx', '.mjs', '/index.js', '/index.jsx'];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    const base = new URL(specifier, pathToFileURL(parent));
    for (const suffix of CANDIDATES) {
      const candidate = fileURLToPath(base) + suffix;
      if (existsSync(candidate) && !candidate.endsWith('/')) {
        try {
          if (readFileSync(candidate).length >= 0) {
            return nextResolve(pathToFileURL(candidate).href, context);
          }
        } catch {
          // a directory — keep looking
        }
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  // Only `.jsx` is transformed; `.js` modules (some carry JSON import
  // attributes that a re-emit would drop) load untouched.
  if (url.startsWith('file:') && url.endsWith('.jsx')) {
    const source = readFileSync(fileURLToPath(url), 'utf8');
    const { code } = transformSync(source, {
      loader: 'jsx',
      jsx: 'automatic',
      format: 'esm',
      target: 'es2022',
      sourcefile: url,
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
