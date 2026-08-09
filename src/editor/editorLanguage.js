export function getLanguageFromFilename(filename) {
  if (!filename) return 'plaintext';
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'md':
      return 'markdown';
    case 'py':
    case 'pyi':
      return 'python';
    case 'rs':
      return 'rust';
    case 'c':
      return 'c';
    case 'h':
    case 'cpp':
    case 'hpp':
    case 'cc':
    case 'cxx':
      // .h follows the VSCode default (C++); clangd infers the real language
      // from the compilation database regardless.
      return 'cpp';
    case 'go':
      return 'go';
    default:
      return 'plaintext';
  }
}

/**
 * Return the LSP `textDocument.languageId` value for a filename.
 *
 * Distinct from `getLanguageFromFilename` because Monaco and the LSP
 * spec use different identifiers for JSX/TSX:
 *   - Monaco language registry has no `typescriptreact`/`javascriptreact`;
 *     `.tsx` and `.jsx` use the bare `typescript`/`javascript` ids and
 *     JSX support is enabled via TypeScript's own configuration.
 *   - LSP spec requires `typescriptreact`/`javascriptreact` for `.tsx`
 *     and `.jsx`; without these, typescript-language-server treats the
 *     file as plain TS/JS and refuses to parse JSX (error 17004:
 *     "Cannot use JSX unless the '--jsx' flag is provided").
 *
 * Returning `getLanguageFromFilename`'s value for `.tsx`/`.jsx` would
 * silently break LSP JSX support. Use this function whenever a value
 * is destined for an LSP `didOpen` call; use `getLanguageFromFilename`
 * whenever a value is destined for Monaco's editor.createModel.
 */
export function getLspLanguageIdFromFilename(filename) {
  if (!filename) return 'plaintext';
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'javascriptreact';
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'tsx':
      return 'typescriptreact';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'md':
      return 'markdown';
    case 'py':
    case 'pyi':
      return 'python';
    case 'rs':
      return 'rust';
    case 'c':
      return 'c';
    case 'h':
    case 'cpp':
    case 'hpp':
    case 'cc':
    case 'cxx':
      return 'cpp';
    case 'go':
      return 'go';
    default:
      return 'plaintext';
  }
}

/**
 * Registry language id (= LSP session key) a filename belongs to, or null
 * for files no managed server claims (ADR-005 Slice 6).
 *
 * Distinct from both functions above: the SESSION is keyed by the registry
 * language id ('cpp' covers every C-family extension because one clangd
 * session serves them all), while Monaco and textDocument.languageId still
 * distinguish 'c' from 'cpp'. Extensions mirror
 * src-tauri/resources/language-server-registry.json — the contract test in
 * test/domains/useManagedLspLifecycle.test.mjs fails on drift.
 */
export function getManagedSessionLanguageFromFilename(filename) {
  if (!filename) return null;
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'rs':
      return 'rust';
    case 'c':
    case 'h':
    case 'cpp':
    case 'hpp':
    case 'cc':
    case 'cxx':
      return 'cpp';
    case 'go':
      // Toolchain-tier (ADR-005 Slice 6.5) — not in the registry, but gopls
      // sessions ride the same generic machinery once installed.
      return 'go';
    default:
      return null;
  }
}
