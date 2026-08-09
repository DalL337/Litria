const PYTHON_KEYWORDS = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import',
  'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True',
  'try', 'while', 'with', 'yield'
];

const PYTHON_COMPLETION_TRIGGERS = ['.', '_'];

function toRange(monaco, line, startColumn, endColumn) {
  return new monaco.Range(line, startColumn, line, Math.max(startColumn + 1, endColumn));
}

export function parsePythonSymbols(text) {
  const symbols = new Map();
  const lines = text.split(/\r?\n/);

  const addSymbol = (entry) => {
    if (!entry?.name) return;
    if (!symbols.has(entry.name)) {
      symbols.set(entry.name, entry);
    }
  };

  const parseDocstring = (lineIndex) => {
    const next = lines[lineIndex + 1];
    if (!next) return null;
    const trimmed = next.trim();
    if (
      (trimmed.startsWith('"""') && trimmed.endsWith('"""') && trimmed.length > 6)
      || (trimmed.startsWith("'''") && trimmed.endsWith("'''") && trimmed.length > 6)
    ) {
      return trimmed.slice(3, -3).trim() || null;
    }
    return null;
  };

  lines.forEach((line, index) => {
    const lineNo = index + 1;

    const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(([^)]*)\))?\s*:/);
    if (classMatch) {
      const name = classMatch[1];
      const base = classMatch[3] ? `(${classMatch[3].trim()})` : '';
      addSymbol({
        name,
        kind: 'class',
        line: lineNo,
        startColumn: line.indexOf(name) + 1,
        endColumn: line.indexOf(name) + name.length + 1,
        signature: `class ${name}${base}:`,
        doc: parseDocstring(index)
      });
      return;
    }

    const fnMatch = line.match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(->\s*[^:]+)?\s*:/);
    if (fnMatch) {
      const name = fnMatch[1];
      const args = fnMatch[2]?.trim() ?? '';
      const returns = fnMatch[3] ? ` ${fnMatch[3].trim()}` : '';
      addSymbol({
        name,
        kind: 'function',
        line: lineNo,
        startColumn: line.indexOf(name) + 1,
        endColumn: line.indexOf(name) + name.length + 1,
        signature: `def ${name}(${args})${returns}:`,
        params: args
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => ({
            label: value
          })),
        doc: parseDocstring(index)
      });
      return;
    }

    const importMatch = line.match(/^\s*import\s+(.+)$/);
    if (importMatch) {
      importMatch[1]
        .split(',')
        .map((segment) => segment.trim())
        .forEach((segment) => {
          const aliasSplit = segment.split(/\s+as\s+/i).map((value) => value.trim());
          const moduleName = aliasSplit[1] || aliasSplit[0].split('.')[0];
          if (!moduleName) return;
          addSymbol({
            name: moduleName,
            kind: 'module',
            line: lineNo,
            startColumn: line.indexOf(moduleName) + 1,
            endColumn: line.indexOf(moduleName) + moduleName.length + 1,
            signature: `import ${segment}`
          });
        });
      return;
    }

    const fromImportMatch = line.match(/^\s*from\s+([A-Za-z_][A-Za-z0-9_\.]*)\s+import\s+(.+)$/);
    if (fromImportMatch) {
      fromImportMatch[2]
        .split(',')
        .map((segment) => segment.trim())
        .forEach((segment) => {
          const aliasSplit = segment.split(/\s+as\s+/i).map((value) => value.trim());
          const importName = aliasSplit[1] || aliasSplit[0];
          if (!importName || importName === '*') return;
          addSymbol({
            name: importName,
            kind: 'module',
            line: lineNo,
            startColumn: line.indexOf(importName) + 1,
            endColumn: line.indexOf(importName) + importName.length + 1,
            signature: `from ${fromImportMatch[1]} import ${segment}`
          });
        });
      return;
    }

    const assignmentMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (assignmentMatch) {
      const name = assignmentMatch[1];
      addSymbol({
        name,
        kind: 'variable',
        line: lineNo,
        startColumn: line.indexOf(name) + 1,
        endColumn: line.indexOf(name) + name.length + 1,
        signature: `${name} = ...`
      });
    }
  });

  return symbols;
}

function getCompletionKind(monaco, kind) {
  if (kind === 'class') return monaco.languages.CompletionItemKind.Class;
  if (kind === 'function') return monaco.languages.CompletionItemKind.Function;
  if (kind === 'module') return monaco.languages.CompletionItemKind.Module;
  if (kind === 'variable') return monaco.languages.CompletionItemKind.Variable;
  return monaco.languages.CompletionItemKind.Text;
}

function getSymbolKind(monaco, kind) {
  if (kind === 'class') return monaco.languages.SymbolKind.Class;
  if (kind === 'function') return monaco.languages.SymbolKind.Function;
  if (kind === 'module') return monaco.languages.SymbolKind.Module;
  if (kind === 'variable') return monaco.languages.SymbolKind.Variable;
  return monaco.languages.SymbolKind.String;
}

function isWordBoundary(char) {
  return !char || !/[A-Za-z0-9_]/.test(char);
}

function pushSemanticToken(tokenEntries, line, start, length, tokenTypeIndex, tokenModifiers = 0) {
  if (line < 0 || start < 0 || length < 1 || tokenTypeIndex < 0) return;
  tokenEntries.push({
    line,
    start,
    length,
    tokenTypeIndex,
    tokenModifiers
  });
}

function encodeSemanticTokens(tokenEntries) {
  const sorted = [...tokenEntries].sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    return a.start - b.start;
  });
  const data = [];
  let previousLine = 0;
  let previousStart = 0;

  sorted.forEach((token) => {
    const deltaLine = token.line - previousLine;
    const deltaStart = deltaLine === 0 ? token.start - previousStart : token.start;
    data.push(
      deltaLine,
      Math.max(0, deltaStart),
      token.length,
      token.tokenTypeIndex,
      token.tokenModifiers
    );
    previousLine = token.line;
    previousStart = token.start;
  });
  return new Uint32Array(data);
}

export function registerPythonLocalIntelligence(monaco) {
  const semanticLegend = {
    tokenTypes: ['class', 'function', 'method', 'variable', 'parameter', 'keyword', 'namespace'],
    tokenModifiers: ['declaration']
  };
  const tokenTypeIndex = semanticLegend.tokenTypes.reduce((acc, tokenType, index) => {
    acc[tokenType] = index;
    return acc;
  }, {});
  const tokenModifierIndex = semanticLegend.tokenModifiers.reduce((acc, modifier, index) => {
    acc[modifier] = 1 << index;
    return acc;
  }, {});

  const hoverProvider = monaco.languages.registerHoverProvider('python', {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word?.word) return null;
      const symbols = parsePythonSymbols(model.getValue());
      const symbol = symbols.get(word.word);
      if (!symbol) return null;
      const contents = [
        { value: `\`\`\`python\n${symbol.signature}\n\`\`\`` }
      ];
      if (symbol.doc) {
        contents.push({ value: symbol.doc });
      } else {
        contents.push({ value: `Local ${symbol.kind} symbol` });
      }
      return {
        range: toRange(monaco, position.lineNumber, word.startColumn, word.endColumn),
        contents
      };
    }
  });

  const completionProvider = monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: PYTHON_COMPLETION_TRIGGERS,
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const replaceRange = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn
      );

      const symbols = parsePythonSymbols(model.getValue());
      const symbolItems = Array.from(symbols.values()).map((symbol) => ({
        label: symbol.name,
        kind: getCompletionKind(monaco, symbol.kind),
        insertText: symbol.name,
        range: replaceRange,
        detail: symbol.signature,
        sortText: `1_${symbol.name}`
      }));
      const keywordItems = PYTHON_KEYWORDS.map((keyword) => ({
        label: keyword,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: keyword,
        range: replaceRange,
        detail: 'Python keyword',
        sortText: `2_${keyword}`
      }));
      return {
        suggestions: [...symbolItems, ...keywordItems]
      };
    }
  });

  const definitionProvider = monaco.languages.registerDefinitionProvider('python', {
    provideDefinition(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word?.word) return null;
      const symbols = parsePythonSymbols(model.getValue());
      const symbol = symbols.get(word.word);
      if (!symbol) return null;
      return {
        uri: model.uri,
        range: toRange(monaco, symbol.line, symbol.startColumn, symbol.endColumn)
      };
    }
  });

  const documentSymbolProvider = monaco.languages.registerDocumentSymbolProvider('python', {
    provideDocumentSymbols(model) {
      const symbols = parsePythonSymbols(model.getValue());
      return Array.from(symbols.values()).map((symbol) => ({
        name: symbol.name,
        detail: symbol.signature,
        kind: getSymbolKind(monaco, symbol.kind),
        range: toRange(monaco, symbol.line, symbol.startColumn, symbol.endColumn),
        selectionRange: toRange(monaco, symbol.line, symbol.startColumn, symbol.endColumn),
        tags: []
      }));
    }
  });

  const signatureProvider = monaco.languages.registerSignatureHelpProvider('python', {
    signatureHelpTriggerCharacters: ['(', ','],
    provideSignatureHelp(model, position) {
      const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const callMatch = linePrefix.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\([^()]*$/);
      if (!callMatch) return null;
      const fnName = callMatch[1];
      const symbols = parsePythonSymbols(model.getValue());
      const fn = symbols.get(fnName);
      if (!fn || fn.kind !== 'function') return null;

      const argumentText = linePrefix.slice(callMatch.index + fnName.length);
      const activeParameter = Math.max(0, (argumentText.match(/,/g) || []).length);
      return {
        value: {
          activeParameter,
          activeSignature: 0,
          signatures: [
            {
              label: fn.signature.replace(/^def\s+/, '').replace(/:$/, ''),
              documentation: fn.doc || 'Local function signature',
              parameters: Array.isArray(fn.params) ? fn.params : []
            }
          ]
        },
        dispose: () => {}
      };
    }
  });

  const semanticTokensProvider = monaco.languages.registerDocumentSemanticTokensProvider('python', {
    getLegend() {
      return semanticLegend;
    },
    provideDocumentSemanticTokens(model) {
      const tokenEntries = [];
      const text = model.getValue();
      const lines = text.split(/\r?\n/);

      lines.forEach((lineText, lineIndex) => {
        const lineNumber = lineIndex;

        PYTHON_KEYWORDS.forEach((keyword) => {
          let searchFrom = 0;
          while (searchFrom < lineText.length) {
            const foundAt = lineText.indexOf(keyword, searchFrom);
            if (foundAt === -1) break;
            const before = lineText[foundAt - 1];
            const after = lineText[foundAt + keyword.length];
            if (isWordBoundary(before) && isWordBoundary(after)) {
              pushSemanticToken(
                tokenEntries,
                lineNumber,
                foundAt,
                keyword.length,
                tokenTypeIndex.keyword
              );
            }
            searchFrom = foundAt + keyword.length;
          }
        });

        const classDecl = lineText.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (classDecl) {
          const className = classDecl[1];
          const start = lineText.indexOf(className);
          pushSemanticToken(
            tokenEntries,
            lineNumber,
            start,
            className.length,
            tokenTypeIndex.class,
            tokenModifierIndex.declaration
          );
        }

        const fnDecl = lineText.match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/);
        if (fnDecl) {
          const fnName = fnDecl[1];
          const fnStart = lineText.indexOf(fnName);
          const isMethod = lineText.startsWith('    def ') || lineText.startsWith('\tdef ');
          pushSemanticToken(
            tokenEntries,
            lineNumber,
            fnStart,
            fnName.length,
            isMethod ? tokenTypeIndex.method : tokenTypeIndex.function,
            tokenModifierIndex.declaration
          );

          const paramsText = fnDecl[2] || '';
          const declarationColumn = lineText.indexOf('(') + 1;
          let cursor = declarationColumn;
          paramsText.split(',').forEach((rawParam) => {
            const trimmedParam = rawParam.trim();
            if (!trimmedParam) {
              cursor += rawParam.length + 1;
              return;
            }
            const paramName = trimmedParam.split(':')[0].split('=')[0].trim();
            const paramStart = lineText.indexOf(paramName, Math.max(0, cursor - 1));
            if (paramStart >= 0) {
              pushSemanticToken(
                tokenEntries,
                lineNumber,
                paramStart,
                paramName.length,
                tokenTypeIndex.parameter,
                tokenModifierIndex.declaration
              );
            }
            cursor += rawParam.length + 1;
          });
        }
      });

      return {
        data: encodeSemanticTokens(tokenEntries),
        resultId: `${model.getVersionId()}`
      };
    },
    releaseDocumentSemanticTokens() {}
  });

  return () => {
    hoverProvider.dispose();
    completionProvider.dispose();
    definitionProvider.dispose();
    documentSymbolProvider.dispose();
    signatureProvider.dispose();
    semanticTokensProvider.dispose();
  };
}
