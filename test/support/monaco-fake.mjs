// Node module hook: a small stand-in for `src/editor/monacoSetup.js`, so a
// test can drive the REAL editor workspace (monacoWorkspace.js) without a
// browser. It models only what the workspace uses: text models with URIs,
// languages, markers, content-change listeners, an attached-to-editor flag
// the test controls, and Monaco's refusal of a duplicate model URI.
// Registered per test file via `module.register`; the production build never
// sees this file. `globalThis.__MONACO_FAKE__.models` lists every model made.

const FAKE = `
class Uri {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
  static parse(text) { return new Uri(text); }
}

const models = [];
globalThis.__MONACO_FAKE__ = { models };

class TextModel {
  constructor(value, language, uri) {
    this.value = value;
    this.language = language;
    this.uri = uri;
    this.disposed = false;
    // Tests set this to model a pane showing the model.
    this.attached = false;
    this.listeners = new Set();
    this.markers = {};
  }
  getValue() { return this.value; }
  setValue(value) { this.value = value; this.fire(); }
  getLanguageId() { return this.language; }
  isDisposed() { return this.disposed; }
  dispose() { this.disposed = true; this.listeners.clear(); }
  isAttachedToEditor() { return this.attached; }
  getLineCount() { return this.value.split('\\n').length; }
  getLineMaxColumn(line) { return this.value.split('\\n')[line - 1].length + 1; }
  offsetAt(line, column) {
    const lines = this.value.split('\\n');
    let offset = 0;
    for (let index = 0; index < line - 1; index += 1) offset += lines[index].length + 1;
    return offset + column - 1;
  }
  getPositionAt(offset) {
    const before = this.value.slice(0, offset).split('\\n');
    return { lineNumber: before.length, column: before[before.length - 1].length + 1 };
  }
  pushEditOperations(_selections, edits) {
    this.pushed = (this.pushed ?? []).concat([edits]);
    const ordered = edits
      .map((edit) => ({
        start: this.offsetAt(edit.range.startLineNumber, edit.range.startColumn),
        end: this.offsetAt(edit.range.endLineNumber, edit.range.endColumn),
        text: edit.text ?? '',
      }))
      .sort((left, right) => right.start - left.start);
    for (const edit of ordered) {
      this.value = this.value.slice(0, edit.start) + edit.text + this.value.slice(edit.end);
    }
    this.fire();
    return null;
  }
  onDidChangeContent(listener) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  fire() {
    for (const listener of [...this.listeners]) listener({ changes: [] });
  }
}

const editor = {
  createModel(value, language, uri) {
    const key = uri.toString();
    if (models.some((model) => !model.disposed && model.uri.toString() === key)) {
      throw new Error('Cannot add model because it already exists!');
    }
    const model = new TextModel(value ?? '', language, uri);
    models.push(model);
    return model;
  },
  setModelLanguage(model, language) { model.language = language; },
  setModelMarkers(model, owner, markers) { model.markers[owner] = markers; },
  getModelMarkers() { return []; },
  onDidChangeMarkers() { return { dispose() {} }; },
};

const monaco = { Uri, editor, MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 }, languages: {} };
export default monaco;
`;

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.replace(/\\/g, '/').endsWith('/src/editor/monacoSetup.js')) {
    return { format: 'module', source: FAKE, shortCircuit: true };
  }
  return nextLoad(url, context);
}
