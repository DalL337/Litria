// Build log domain — the in-memory record of the current build/scaffold run,
// plus the catalog of stored runs for the log viewer.
//
// Why this exists: scaffold events streamed straight into React state that
// truncated to the last 80 lines and unmounted when the run ended, so the one
// trace explaining a failure was unreadable and unrecoverable. This domain
// keeps the FULL stream independent of whatever the UI chooses to render.
//
// State only — no `invoke` here. Persistence and clipboard IO live in
// src/app/useBuildLogs.js, matching how pillDomain stays pure.

/** Hard ceiling so a runaway build cannot grow the buffer without bound. */
const MAX_TRACE_RECORDS = 5000;

/** Kinds that make a run "interesting" for the `onIssue` pause preference. */
const ISSUE_KINDS = new Set(['warning', 'stepFailed']);

export function createBuildLogDomain() {
  let trace = [];
  let runMeta = null;
  let truncated = false;
  // Issue counters live outside the capped trace (F24): a warning followed
  // by 5000 output lines must still count as an issue for "pause on
  // warnings" even after the record itself has been dropped.
  let issueCount = 0;
  let failedSteps = 0;
  let entries = [];
  let crashEntries = [];
  let listeners = [];

  function notify() {
    const snapshot = {
      trace,
      runMeta,
      truncated,
      entries,
      crashEntries,
    };
    for (const fn of listeners) {
      fn(snapshot);
    }
  }

  const commands = {
    /** Begin a run; clears any previous buffer. */
    startRun({ projectName = '', wrapper = '', framework = '' } = {}) {
      trace = [];
      truncated = false;
      issueCount = 0;
      failedSteps = 0;
      runMeta = {
        projectName,
        wrapper,
        framework,
        startedAt: Date.now(),
        endedAt: null,
        success: null,
      };
      notify();
    },

    /**
     * Record one scaffold event verbatim. Accepts the raw channel event so
     * nothing is lost in translation; the renderer formats separately.
     */
    appendEvent(event) {
      if (!event || typeof event !== 'object') return;
      if (ISSUE_KINDS.has(event.kind)) issueCount += 1;
      if (event.kind === 'stepFailed') failedSteps += 1;
      if (trace.length >= MAX_TRACE_RECORDS) {
        // Drop the oldest rather than the newest: the tail carries the
        // failure. Flagged so exports can say so honestly.
        trace = [...trace.slice(1), { ts: Date.now(), ...event }];
        truncated = true;
      } else {
        trace = [...trace, { ts: Date.now(), ...event }];
      }
      if (event.kind === 'done' && runMeta) {
        runMeta = { ...runMeta, endedAt: Date.now(), success: !!event.success };
      }
      notify();
    },

    /** Mark a run finished when the failure arrived as a thrown error. */
    failRun(message) {
      if (message) {
        trace = [...trace, { ts: Date.now(), kind: 'stepFailed', label: 'scaffold', error: String(message) }];
        issueCount += 1;
        failedSteps += 1;
      }
      if (runMeta) {
        runMeta = { ...runMeta, endedAt: Date.now(), success: false };
      }
      notify();
    },

    clearRun() {
      trace = [];
      runMeta = null;
      truncated = false;
      issueCount = 0;
      failedSteps = 0;
      notify();
    },

    setEntries(next) {
      entries = Array.isArray(next) ? next : [];
      notify();
    },

    setCrashEntries(next) {
      crashEntries = Array.isArray(next) ? next : [];
      notify();
    },
  };

  const selectors = {
    getTrace() {
      return trace;
    },
    getRunMeta() {
      return runMeta;
    },
    getEntries() {
      return entries;
    },
    getCrashEntries() {
      return crashEntries;
    },
    isTruncated() {
      return truncated;
    },
    /** True when the run produced a warning or a failed step — counted as
     *  events arrive, not read back from the capped trace (F24). */
    hasIssues() {
      return issueCount > 0;
    },
    getIssueCount() {
      return issueCount;
    },
    getFailedStepCount() {
      return failedSteps;
    },
    /** JSONL body as stored on disk — one event per line. */
    getTraceJsonl() {
      const header = {
        ts: runMeta?.startedAt ?? Date.now(),
        kind: 'runMeta',
        ...(runMeta ?? {}),
        truncated,
      };
      return [header, ...trace].map((record) => JSON.stringify(record)).join('\n');
    },
  };

  return {
    commands,
    selectors,
    subscribe(fn) {
      listeners.push(fn);
      return () => {
        listeners = listeners.filter((l) => l !== fn);
      };
    },
  };
}

/**
 * Render trace records as the plain text a human pastes into a bug report.
 * Kept beside the domain (not in a component) so the wizard, the pill menu,
 * and the log drawer all produce byte-identical output.
 */
export function formatTraceText(trace, runMeta = null, truncated = false) {
  const lines = [];
  if (runMeta) {
    lines.push(`# Litria build log — ${runMeta.projectName || 'project'}`);
    if (runMeta.wrapper) lines.push(`# wrapper: ${runMeta.wrapper}${runMeta.framework ? ` / ${runMeta.framework}` : ''}`);
    lines.push(`# started: ${new Date(runMeta.startedAt).toISOString()}`);
    if (runMeta.endedAt) {
      lines.push(`# ended:   ${new Date(runMeta.endedAt).toISOString()} (${runMeta.success ? 'success' : 'failed'})`);
    }
    lines.push('');
  }
  if (truncated) {
    lines.push(`[earlier lines dropped — buffer capped at ${MAX_TRACE_RECORDS} records]`);
  }
  for (const record of trace) {
    lines.push(formatRecord(record));
  }
  return lines.join('\n');
}

/** One trace record → one display line. Shared by the renderer and exports. */
export function formatRecord(record) {
  if (!record || typeof record !== 'object') return '';
  switch (record.kind) {
    case 'stepStarted':
      return `[${record.step}/${record.total}] ${record.label}...`;
    case 'stepOutput':
      return record.line ?? '';
    case 'stepCompleted':
      return `✓ ${record.label}`;
    case 'stepFailed':
      return `✗ ${record.label}: ${record.error}`;
    case 'warning':
      return `⚠ ${record.line}`;
    case 'done':
      return record.success ? 'Scaffold complete!' : 'Scaffold finished with errors.';
    default:
      return record.line ?? '';
  }
}
