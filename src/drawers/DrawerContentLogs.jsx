import { useCallback, useEffect, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import { formatRecord } from '../app/buildLogDomain';

/**
 * DrawerContentLogs — the log viewer behind Actions ▸ Logs.
 *
 * Two catalogs, deliberately distinct:
 *  - Build: scaffold/build runs from ~/.litria/logs/builds. A failed scaffold
 *    leaves the app healthy, so the crash system never records it — before
 *    this existed, that trace was truncated to 80 lines and unmounted the
 *    moment the run finished.
 *  - Crash: the existing records in ~/.litria/logs/crashes.
 *
 * Text is selectable (the drawer's `user-select: none` applies only to the
 * rail, not content), and "Copy all" covers the select-nothing case.
 *
 * Protected zone conventions (ADR-008): no shadcn/Radix — native buttons.
 */

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

/** Build logs are JSONL; render them through the shared record formatter. */
function renderBuildBody(raw) {
  const lines = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.kind === 'runMeta') {
        lines.push(`# ${record.projectName || 'project'} — ${record.wrapper || ''}${record.framework ? ` / ${record.framework}` : ''}`);
        lines.push(`# started ${formatWhen(record.startedAt)}`);
        if (record.endedAt) {
          lines.push(`# ended   ${formatWhen(record.endedAt)} (${record.success ? 'success' : 'failed'})`);
        }
        if (record.truncated) lines.push('# [buffer was capped — earlier lines dropped]');
        lines.push('');
        continue;
      }
      if (record.kind === 'pill') {
        lines.push(`[${record.severity ?? 'info'}] ${record.message}`);
        continue;
      }
      lines.push(formatRecord(record));
    } catch {
      // A malformed line is still evidence — show it raw rather than hide it.
      lines.push(line);
    }
  }
  return lines.join('\n');
}

function DrawerContentLogs({ buildLogDomain, buildLogActions, initialTab = 'build' }) {
  const [tab, setTab] = useState(initialTab);
  const [entries, setEntries] = useState([]);
  const [crashEntries, setCrashEntries] = useState([]);
  const [selected, setSelected] = useState(null);
  const [body, setBody] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!buildLogDomain) return;
    setEntries(buildLogDomain.selectors.getEntries());
    setCrashEntries(buildLogDomain.selectors.getCrashEntries());
    return buildLogDomain.subscribe((snapshot) => {
      setEntries(snapshot.entries);
      setCrashEntries(snapshot.crashEntries);
    });
  }, [buildLogDomain]);

  const refresh = useCallback(async () => {
    setStatus('');
    await buildLogActions?.refreshEntries?.();
  }, [buildLogActions]);

  // Load the catalog when the drawer mounts — the rail can be opened at any
  // time, so we cannot rely on a prior refresh.
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const openEntry = useCallback(async (name, kind) => {
    setSelected(name);
    setStatus('');
    const raw = kind === 'crash'
      ? await buildLogActions?.readCrashLog?.(name)
      : await buildLogActions?.readBuildLog?.(name);
    if (!raw) {
      setBody('(empty or unreadable)');
      return;
    }
    setBody(kind === 'crash' ? raw : renderBuildBody(raw));
  }, [buildLogActions]);

  const copyAll = useCallback(async () => {
    if (!body) return;
    const ok = await buildLogActions?.copyText?.(body);
    setStatus(ok ? 'Copied to clipboard.' : 'Copy failed.');
  }, [body, buildLogActions]);

  const list = tab === 'crash'
    ? crashEntries.map((name) => ({ name, label: name, meta: '' }))
    : entries.map((entry) => ({
        name: entry.name,
        label: entry.slug,
        meta: `${formatWhen(entry.timestamp)} · ${formatBytes(entry.bytes)}`,
      }));

  return (
    <div className="drawer-logs">
      <div className="drawer-logs-bar">
        <div className="drawer-logs-tabs">
          <button
            type="button"
            className={`drawer-logs-tab${tab === 'build' ? ' is-active' : ''}`}
            onClick={() => setTab('build')}
          >
            Build
          </button>
          <button
            type="button"
            className={`drawer-logs-tab${tab === 'crash' ? ' is-active' : ''}`}
            onClick={() => setTab('crash')}
          >
            Crash
          </button>
        </div>
        <div className="drawer-logs-bar-actions">
          {status && <span className="drawer-logs-status">{status}</span>}
          <button type="button" className="drawer-logs-btn" onClick={refresh} title="Refresh">
            <RefreshCw size={13} /> Refresh
          </button>
          <button
            type="button"
            className="drawer-logs-btn"
            onClick={copyAll}
            disabled={!body}
            title="Copy the whole log"
          >
            <Copy size={13} /> Copy all
          </button>
        </div>
      </div>

      <div className="drawer-logs-body">
        <div className="drawer-logs-list">
          {list.length === 0 && (
            <div className="drawer-logs-empty">
              {tab === 'crash'
                ? 'No crash records.'
                : 'No build logs yet. Use “Send to logs” on a build trace.'}
            </div>
          )}
          {list.map((item) => (
            <button
              key={item.name}
              type="button"
              className={`drawer-logs-item${selected === item.name ? ' is-selected' : ''}`}
              onClick={() => openEntry(item.name, tab)}
            >
              <span className="drawer-logs-item-label">{item.label}</span>
              {item.meta && <span className="drawer-logs-item-meta">{item.meta}</span>}
            </button>
          ))}
        </div>
        <pre className="drawer-logs-content">
          {body || 'Select a log to view it.'}
        </pre>
      </div>
    </div>
  );
}

export default DrawerContentLogs;
