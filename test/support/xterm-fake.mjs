// Load-time stand-ins for xterm and its addons, so the REAL
// src/components/TerminalRenderer.jsx can run under happy-dom (no canvas, no
// layout). Each Terminal records itself in globalThis.__XTERMS__ with what it
// was asked to do; write callbacks are held until the test runs them, the way
// xterm runs them after it parses. Registered per test file via
// `module.register`; the build never sees it.

const MODULES = {
  '@xterm/xterm': `
    export class Terminal {
      constructor(options) {
        this.options = options;
        this.cols = 80;
        this.rows = 24;
        this.writes = [];
        this.callbacks = [];
        this.blurs = 0;
        this.focuses = 0;
        this.disposed = false;
        this.listeners = { data: [], resize: [] };
        (globalThis.__XTERMS__ ??= []).push(this);
      }
      loadAddon(addon) { addon.activate?.(this); }
      open(element) { this.element = element; }
      onData(fn) { return this.listen('data', fn); }
      onResize(fn) { return this.listen('resize', fn); }
      listen(kind, fn) {
        this.listeners[kind].push(fn);
        return { dispose: () => { this.listeners[kind] = this.listeners[kind].filter((f) => f !== fn); } };
      }
      write(data, callback) {
        this.writes.push(data);
        if (callback) this.callbacks.push(callback);
      }
      /** Test helper: xterm finished parsing everything queued so far. */
      drain() {
        const callbacks = this.callbacks;
        this.callbacks = [];
        for (const callback of callbacks) callback();
      }
      blur() { this.blurs += 1; }
      focus() { this.focuses += 1; }
      refresh() {}
      dispose() { this.disposed = true; }
    }
  `,
  '@xterm/addon-fit': `
    export class FitAddon {
      activate(terminal) { this.terminal = terminal; }
      fit() {}
    }
  `,
  '@xterm/addon-webgl': `
    export class WebglAddon {
      onContextLoss() { return { dispose() {} }; }
      dispose() {}
    }
  `,
  '@xterm/addon-web-links': `
    export class WebLinksAddon {}
  `,
  '@xterm/xterm/css/xterm.css': `export default {};`,
};

const PREFIX = 'xterm-fake:';

export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(MODULES, specifier)) {
    return { url: `${PREFIX}${specifier}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(PREFIX)) {
    return { format: 'module', source: MODULES[url.slice(PREFIX.length)], shortCircuit: true };
  }
  return nextLoad(url, context);
}
