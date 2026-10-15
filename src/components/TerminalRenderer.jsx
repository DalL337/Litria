import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

const THEME = {
  background: '#0e0e10',
  foreground: '#d4d4d8',
  cursor: '#a1a1aa',
  selectionBackground: '#3f3f46',
  black: '#18181b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa'
};

// Flow-control watermarks, in BYTES queued into xterm but not yet parsed.
// These exist to stop a flood (cat huge-file) from ballooning memory — they
// must be unreachable by interactive use. The original count-based watermark
// (pause at 5 in-flight writes) was hair-trigger with the sideloaded ConPTY
// host, which splits every keystroke repaint into several small writes
// (hide-cursor / move / text / show-cursor): ordinary typing paused the
// Rust reader mid-redraw — frozen echoes, vanished cursor, dead backspace.
const PAUSE_ABOVE_BYTES = 1024 * 1024;
const RESUME_BELOW_BYTES = 256 * 1024;

/**
 * Releases a WebGL context now instead of at garbage collection. Disposing the
 * WebGL addon removes its canvas but never loses the context, and live
 * contexts are capped (Chromium drops the OLDEST past about 16): with several
 * terminals, created and removed, a live tab would lose its renderer.
 */
function releaseWebglContexts(canvases) {
  for (const canvas of canvases) {
    try {
      canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // A 2D canvas, or a context that is already gone.
    }
  }
}

/**
 * One terminal session's screen. Mounted for the session's whole life and
 * hidden with CSS when another tab or drawer is in front (implementation
 * policy Rule 4), so its screen and modes survive. It never decides whether
 * its session exists.
 */
export default function TerminalRenderer({
  stream,
  onInput,
  onResize,
  onPause,
  onResume,
  isVisible = true
}) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const fitAddonRef = useRef(null);
  const pendingRef = useRef(0);
  const pausedRef = useRef(false);
  const visibleRef = useRef(isVisible);
  visibleRef.current = isVisible;

  // Callbacks are read through refs: the mount effect registers xterm
  // listeners once, and a new callback identity must never resubscribe the
  // stream (that would replay its output into the screen again).
  const callbacksRef = useRef({ onInput, onResize, onPause, onResume });
  callbacksRef.current = { onInput, onResize, onPause, onResume };

  // Fit only a measured box. A terminal hidden by `display: none` (another
  // top drawer in front) measures 0×0, and FitAddon would read the computed
  // `height: 100%` as 100px and shrink the PTY to a sliver.
  const fitIfSized = useCallback(() => {
    const container = containerRef.current;
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) return false;
    try {
      fitAddonRef.current?.fit();
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const terminal = new Terminal({
      theme: THEME,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      convertEol: true
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(container);

    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL not available, canvas renderer is fine
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const dataDisposable = terminal.onData((data) => {
      callbacksRef.current.onInput?.(data);
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      callbacksRef.current.onResize?.(cols, rows);
    });

    // The first fit runs after onResize is registered, then the size is
    // reported once even if fit changed nothing: the session may have started
    // at a default size before this view measured it.
    if (fitIfSized()) callbacksRef.current.onResize?.(terminal.cols, terminal.rows);

    const observer = new ResizeObserver(() => {
      fitIfSized();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      // A view leaving while it held the session paused would park the
      // session's output for good: lift the pause on the way out.
      if (pausedRef.current) callbacksRef.current.onResume?.();
      const canvases = [...container.querySelectorAll('canvas')];
      terminal.dispose();
      releaseWebglContexts(canvases);
      terminalRef.current = null;
      fitAddonRef.current = null;
      pendingRef.current = 0;
      pausedRef.current = false;
    };
  }, [fitIfSized]);

  // Session output -> terminal.write with backpressure.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!stream || !terminal) return undefined;

    const handleEvent = (event) => {
      if (event.event === 'Output' && event.data?.chunk) {
        const bytes = event.data.chunk.length;
        pendingRef.current += bytes;
        terminal.write(event.data.chunk, () => {
          // xterm still runs a disposed screen's queued writes; they must not
          // count against the screen that replaced it.
          if (terminalRef.current !== terminal) return;
          pendingRef.current -= bytes;
          if (pausedRef.current && pendingRef.current <= RESUME_BELOW_BYTES) {
            pausedRef.current = false;
            callbacksRef.current.onResume?.();
          }
        });

        if (!pausedRef.current && pendingRef.current >= PAUSE_ABOVE_BYTES) {
          pausedRef.current = true;
          callbacksRef.current.onPause?.();
        }
      } else if (event.event === 'Exited') {
        const code = event.data?.exitCode;
        const label = code === 0 ? 'completed' : code == null ? 'ended' : `failed (exit ${code})`;
        terminal.write(`\r\n\x1b[90m[Process ${label}]\x1b[0m\r\n`);
      }
    };

    // The stream replays the session's recent output, then streams live.
    return stream.subscribe(handleEvent);
  }, [stream]);

  // Shown: fit, repaint, focus. Hidden: give the focus up, so keystrokes can
  // never reach a session the person cannot see.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return undefined;
    if (!isVisible) {
      terminal.blur();
      return undefined;
    }
    const timer = setTimeout(() => {
      const term = terminalRef.current;
      if (!term || !visibleRef.current) return;
      fitIfSized();
      term.refresh(0, term.rows - 1);
      term.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [isVisible, fitIfSized]);

  return (
    <div
      ref={containerRef}
      className="terminal-renderer"
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden'
      }}
    />
  );
}
