// Load-time stand-in for src/components/TerminalRenderer.jsx. xterm needs a
// real canvas and layout, which happy-dom does not have; the drawer tests only
// need to know which screens are mounted, what they are shown, and what each
// one received. Every instance records itself in globalThis.__TERMINAL_VIEWS__.
// Registered per test file via `module.register`; the build never sees it.

const FAKE = `
import { useEffect, useRef, createElement } from 'react';

export default function TerminalRenderer(props) {
  const recordRef = useRef(null);
  if (!recordRef.current) {
    recordRef.current = { stream: props.stream, mounted: false, unmounts: 0, visible: [], events: [], props };
    // Looked up per render: each test starts its own list.
    (globalThis.__TERMINAL_VIEWS__ ??= []).push(recordRef.current);
  }
  recordRef.current.props = props;
  recordRef.current.visible.push(props.isVisible);

  useEffect(() => {
    const record = recordRef.current;
    record.mounted = true;
    return () => {
      record.mounted = false;
      record.unmounts += 1;
    };
  }, []);

  useEffect(() => {
    if (!props.stream) return undefined;
    const record = recordRef.current;
    record.events = [];
    return props.stream.subscribe((event) => record.events.push(event));
  }, [props.stream]);

  return createElement('div', { className: 'terminal-renderer-fake' });
}
`;

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.replace(/\\/g, '/').endsWith('/src/components/TerminalRenderer.jsx')) {
    return { format: 'module', source: FAKE, shortCircuit: true };
  }
  return nextLoad(url, context);
}
