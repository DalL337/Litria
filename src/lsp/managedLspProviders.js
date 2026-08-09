/**
 * managedLspProviders.js — Monaco language provider registrations for the
 * managed registry languages (ADR-005 Slice 6: rust-analyzer, clangd),
 * backed by the generic LSP transport (lspRequest).
 *
 * Mirrors typescriptLspProviders.js: providers are registered once via
 * registerManagedLspProviders() from monacoWorkspace.ensureLspProviders();
 * the active session context (projectId, projectRootPath) is a module-level
 * singleton updated by setManagedLspProviderContext() from EditorMonaco.
 *
 * Covered in this file:
 *   textDocument/completion    — full item list
 *   textDocument/signatureHelp — signatures + active parameter
 *
 * textDocument/hover is handled directly in EditorMonacoPane's showHover()
 * because CM uses a custom card rather than Monaco's built-in hover widget.
 */

import { lspRequest } from './lspClient.js';

// Monaco language id → session language id. One clangd session (registry
// language 'cpp') serves both of Monaco's 'c' and 'cpp' languages, the same
// way one tsserver session serves 'typescript' and 'javascript'. go is
// toolchain-tier (ADR-005 Slice 6.5) but rides the same session machinery.
const MONACO_TO_SESSION = Object.freeze({
  rust: 'rust',
  cpp: 'cpp',
  c: 'cpp',
  go: 'go'
});

/** Session language id for a Monaco language id, or null if unmanaged. */
export function managedSessionLanguageForMonacoLanguage(monacoLanguageId) {
  return MONACO_TO_SESSION[monacoLanguageId] ?? null;
}

// ---------------------------------------------------------------------------
// Module-level context (updated from EditorMonaco via setManagedLspProviderContext)
// ---------------------------------------------------------------------------

let _projectId = null;
let _projectRootPath = null;

export function setManagedLspProviderContext(projectId, projectRootPath) {
  _projectId = projectId;
  _projectRootPath = projectRootPath;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a file:// URI from a Monaco model whose URI scheme is cm://tab/…
 */
function modelToLspUri(model) {
  const uriStr = model.uri.toString();
  const match = uriStr.match(/^cm:\/\/tab\/[^/]+\/(.+)$/);
  if (!match) return null;
  const filename = decodeURIComponent(match[1]);
  const root = typeof _projectRootPath === 'string'
    ? _projectRootPath.replace(/\\/g, '/').replace(/\/$/, '')
    : '';
  if (!root) return null;
  const file = filename.replace(/\\/g, '/').replace(/^\//, '');
  const full = `${root}/${file}`;
  return /^[a-zA-Z]:/.test(full) ? `file:///${full}` : `file://${full}`;
}

/** Map an LSP CompletionItemKind (1-25) to Monaco CompletionItemKind. */
function lspKindToMonaco(monacoNs, lspKind) {
  const k = monacoNs.languages.CompletionItemKind;
  switch (lspKind) {
    case 1:  return k.Text;
    case 2:  return k.Method;
    case 3:  return k.Function;
    case 4:  return k.Constructor;
    case 5:  return k.Field;
    case 6:  return k.Variable;
    case 7:  return k.Class;
    case 8:  return k.Interface;
    case 9:  return k.Module;
    case 10: return k.Property;
    case 11: return k.Unit;
    case 12: return k.Value;
    case 13: return k.Enum;
    case 14: return k.Keyword;
    case 15: return k.Snippet;
    case 16: return k.Color;
    case 17: return k.File;
    case 18: return k.Reference;
    case 19: return k.Folder;
    case 20: return k.EnumMember;
    case 21: return k.Constant;
    case 22: return k.Struct;
    case 23: return k.Event;
    case 24: return k.Operator;
    case 25: return k.TypeParameter;
    default: return k.Text;
  }
}

/** Convert one LSP CompletionItem to a Monaco CompletionItem. */
function convertCompletionItem(monacoNs, lspItem, range) {
  const label = typeof lspItem.label === 'string' ? lspItem.label : String(lspItem.label ?? '');
  const insertText = lspItem.insertText ?? label;

  let documentation;
  if (lspItem.documentation) {
    const doc = lspItem.documentation;
    documentation = typeof doc === 'string'
      ? { value: doc }
      : { value: doc.value ?? '', isTrusted: false };
  }

  let labelDetails;
  if (lspItem.labelDetails) {
    labelDetails = lspItem.labelDetails;
  }

  return {
    label: labelDetails ? { label, detail: labelDetails.detail ?? '', description: labelDetails.description ?? '' } : label,
    kind: lspKindToMonaco(monacoNs, lspItem.kind ?? 1),
    detail: lspItem.detail ?? undefined,
    documentation,
    insertText,
    range,
    sortText: lspItem.sortText ?? label,
    filterText: lspItem.filterText ?? label,
    preselect: lspItem.preselect ?? false,
    tags: lspItem.deprecated ? [1] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

/**
 * Register LSP-backed Monaco providers for every managed Monaco language.
 *
 * @param {object} monacoNs  The Monaco namespace.
 * @returns {object[]} Array of disposables.
 */
export function registerManagedLspProviders(monacoNs) {
  const disposables = [];

  for (const [monacoLang, sessionLang] of Object.entries(MONACO_TO_SESSION)) {
    // ── Completion ──────────────────────────────────────────────────────────
    disposables.push(monacoNs.languages.registerCompletionItemProvider(monacoLang, {
      // Union of rust-analyzer and clangd trigger characters: member access
      // ('.', '->' via '>'), paths ('::' via ':'), calls, generics, includes.
      triggerCharacters: ['.', ':', '(', '<', '>', '"', '/'],

      async provideCompletionItems(model, position) {
        if (!_projectId) return null;
        const uri = modelToLspUri(model);
        if (!uri) return null;

        try {
          const result = await lspRequest(
            sessionLang, _projectId, 'textDocument/completion',
            {
              textDocument: { uri },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
              context: { triggerKind: 1 }, // Invoked
            },
            4000,
          );

          const rawItems = Array.isArray(result)
            ? result
            : Array.isArray(result?.items) ? result.items : [];

          if (!rawItems.length) return null;

          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: position.column,
          };

          return {
            suggestions: rawItems.map((item) => convertCompletionItem(monacoNs, item, range)),
            incomplete: result?.isIncomplete ?? false,
          };
        } catch {
          return null;
        }
      },
    }));

    // ── Signature Help ───────────────────────────────────────────────────────
    disposables.push(monacoNs.languages.registerSignatureHelpProvider(monacoLang, {
      signatureHelpTriggerCharacters: ['(', ','],
      signatureHelpRetriggerCharacters: [',', ')'],

      async provideSignatureHelp(model, position) {
        if (!_projectId) return null;
        const uri = modelToLspUri(model);
        if (!uri) return null;

        try {
          const result = await lspRequest(
            sessionLang, _projectId, 'textDocument/signatureHelp',
            {
              textDocument: { uri },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            },
            3000,
          );

          if (!result?.signatures?.length) return null;

          const signatures = result.signatures.map((sig) => {
            const params = (sig.parameters ?? []).map((p) => ({
              label: typeof p.label === 'string'
                ? p.label
                : [p.label[0], p.label[1]], // character-offset range
              documentation: p.documentation
                ? (typeof p.documentation === 'string'
                  ? { value: p.documentation }
                  : { value: p.documentation.value ?? '' })
                : undefined,
            }));
            return {
              label: sig.label,
              documentation: sig.documentation
                ? (typeof sig.documentation === 'string'
                  ? { value: sig.documentation }
                  : { value: sig.documentation.value ?? '' })
                : undefined,
              parameters: params,
              activeParameter: sig.activeParameter ?? result.activeParameter ?? 0,
            };
          });

          return {
            value: {
              signatures,
              activeSignature: result.activeSignature ?? 0,
              activeParameter: result.activeParameter ?? 0,
            },
            dispose: () => {},
          };
        } catch {
          return null;
        }
      },
    }));
  }

  return disposables;
}
