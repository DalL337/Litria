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

export default function TerminalRenderer({
  channel,
  projectId,
  sessionId,
  onInput,
  onResize,
  onPause,
  onResume,
  onProcessComplete,
  isVisible = true
}) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const fitAddonRef = useRef(null);
  const pendingRef = useRef(0);
  const pausedRef = useRef(false);

  const handleFit = useCallback(() => {
    if (fitAddonRef.current && terminalRef.current) {
      try {
        fitAddonRef.current.fit();
      } catch {
        // fit() can throw if terminal is not attached
      }
    }
  }, []);

  // Mount terminal
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

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

    // WebGL addon — load after open() for GPU-accelerated rendering
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL not available, canvas renderer is fine
    }

    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // User keystrokes -> PTY stdin
    const dataDisposable = terminal.onData((data) => {
      if (typeof onInput === 'function') {
        onInput(data);
      }
    });

    // Resize -> PTY resize
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (typeof onResize === 'function') {
        onResize(cols, rows);
      }
    });

    // ResizeObserver for container dimension changes
    const observer = new ResizeObserver(() => {
      handleFit();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      pendingRef.current = 0;
      pausedRef.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // New session = fresh screen (VS Code panel semantics). Closing the
  // drawer ends the shell session but this component stays mounted, so
  // without a reset the NEXT session's prompt prints wherever the dead
  // session's cursor sat — appended mid-line after whatever was typed.
  // Declared BEFORE the channel effect: same-commit effects run in order,
  // and the reset must land before the new channel's backlog drains.
  const lastSessionRef = useRef(null);
  useEffect(() => {
    if (!sessionId) return;
    if (lastSessionRef.current && lastSessionRef.current !== sessionId && terminalRef.current) {
      terminalRef.current.reset();
      pendingRef.current = 0;
      pausedRef.current = false;
    }
    lastSessionRef.current = sessionId;
  }, [sessionId]);

  // Wire channel output -> terminal.write with backpressure
  useEffect(() => {
    if (!channel || !terminalRef.current) return;

    const terminal = terminalRef.current;

    const handleEvent = (event) => {
      if (event.event === 'Output' && event.data?.chunk) {
        const bytes = event.data.chunk.length;
        pendingRef.current += bytes;
        terminal.write(event.data.chunk, () => {
          pendingRef.current -= bytes;
          if (pausedRef.current && pendingRef.current <= RESUME_BELOW_BYTES) {
            pausedRef.current = false;
            if (typeof onResume === 'function') {
              onResume();
            }
          }
        });

        if (!pausedRef.current && pendingRef.current >= PAUSE_ABOVE_BYTES) {
          pausedRef.current = true;
          if (typeof onPause === 'function') {
            onPause();
          }
        }
      } else if (event.event === 'Exited') {
        const code = event.data?.exitCode;
        const label = code === 0 || code === null ? 'completed' : `failed (exit ${code})`;
        terminal.write(`\r\n\x1b[90m[Process ${label}]\x1b[0m\r\n`);
        if (typeof onProcessComplete === 'function') {
          onProcessComplete(code);
        }
      }
    };

    // Event-stream wrapper (terminalStorage.createTerminalEventStream):
    // subscribe replays events buffered between PTY spawn and this effect —
    // the shell's opening banner/prompt land in that window. Plain-channel
    // fallback kept for any legacy caller.
    if (typeof channel.subscribe === 'function') {
      channel.subscribe(handleEvent);
      return () => {
        channel.unsubscribe();
      };
    }

    channel.onmessage = handleEvent;

    return () => {
      channel.onmessage = null;
    };
  }, [channel, onPause, onResume, onProcessComplete]);

  // Re-fit, refresh, and focus when visibility changes
  useEffect(() => {
    if (isVisible && terminalRef.current) {
      // Slight delay for layout to settle
      const timer = setTimeout(() => {
        handleFit();
        const term = terminalRef.current;
        if (term) {
          term.refresh(0, term.rows - 1);
          term.focus();
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isVisible, handleFit]);

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
