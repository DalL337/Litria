/**
 * typescriptLspProviders.js — Monaco language provider registrations backed by
 * the generic LSP transport (lspRequest) using typescript-language-server.
 *
 * Providers are registered once via registerTypescriptLspProviders() called
 * from EditorMonaco's onMount.  The active session context (projectId,
 * projectRootPath) is kept in a module-level singleton updated by
 * setTsLspProviderContext() whenever props change in EditorMonaco.
 *
 * Covered in this file:
 *   textDocument/completion    — full item list for both TypeScript and JavaScript
 *   textDocument/signatureHelp — signatures + active parameter
 *
 * textDocument/hover is handled directly in EditorMonaco's showHover()
 * because CM uses a custom card rather than Monaco's built-in hover widget.
 *
 * (Monaco's built-in TS worker diagnostics are silenced permanently in
 * monacoSetup.js — the old session-scoped disable/restore pair that lived
 * here left a race window that stamped stale 17004 markers on models
 * attached during LSP spawn.)
 */

import { lspRequest } from './lspClient.js';

// ---------------------------------------------------------------------------
// Module-level context (updated from EditorMonaco via setTsLspProviderContext)
// ---------------------------------------------------------------------------

let _projectId = null;
let _projectRootPath = null;

/**
 * Update the context used by all registered providers.
 * Call this from a useEffect that watches projectId and projectRootPath.
 */
export function setTsLspProviderContext(projectId, projectRootPath) {
  _projectId = projectId;
  _projectRootPath = projectRootPath;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a file:// URI from a Monaco model whose URI scheme is cm://tab/…
 *
 * cm://tab/{tabId}/{filename}  →  file:///C:/path/to/filename  (Windows)
 *                              →  file:///home/user/path/filename  (Unix)
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

/**
 * Convert one LSP CompletionItem to a Monaco CompletionItem.
 * `range` is the word range at the cursor (used as insertion range fallback).
 */
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

  // TypeScript label details (e.g. ": string" suffix shown in the widget)
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
 * Register all LSP-backed Monaco language providers for TypeScript and JavaScript.
 *
 * Both languages share one tsserver session (language ID "typescript").
 * Providers are registered for 'typescript' and 'javascript' separately so
 * Monaco routes them correctly by language, but all LSP requests go through
 * the single "typescript" session.
 *
 * @param {object} monacoNs  The Monaco namespace (second arg of onMount).
 * @returns {object[]} Array of disposables — call .dispose() on each to unregister.
 */
export function registerTypescriptLspProviders(monacoNs) {
  const disposables = [];

  for (const monacoLang of ['typescript', 'javascript']) {
    // ── Completion ──────────────────────────────────────────────────────────
    disposables.push(monacoNs.languages.registerCompletionItemProvider(monacoLang, {
      triggerCharacters: ['.', '(', ',', ' ', '[', '"', "'", '/', '@', '<', '{'],

      async provideCompletionItems(model, position) {
        if (!_projectId) return null;
        const uri = modelToLspUri(model);
        if (!uri) return null;

        try {
          const result = await lspRequest(
            'typescript', _projectId, 'textDocument/completion',
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
      signatureHelpTriggerCharacters: ['(', ',', '<'],
      signatureHelpRetriggerCharacters: [',', ')'],

      async provideSignatureHelp(model, position) {
        if (!_projectId) return null;
        const uri = modelToLspUri(model);
        if (!uri) return null;

        try {
          const result = await lspRequest(
            'typescript', _projectId, 'textDocument/signatureHelp',
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
