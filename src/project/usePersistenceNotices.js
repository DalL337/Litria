import { useCallback, useEffect, useRef, useState } from 'react';
import { onPersistenceWriteFailure } from './dbStorage.js';
import {
  NOTICE_RATE_LIMIT_MS,
  clearNotices,
  createNoticeState,
  describeWriteFailure,
  dismissNotice as dismissNoticeState,
  expireNotice,
  reduceWriteFailure
} from './persistenceNotices.js';

/**
 * usePersistenceNotices — ADR-026 decision 3 (slice 4). Binds the pure notice
 * state to the project lifecycle: subscribes to the adapter's write-failure
 * observer for the session, clears on project switch, and ages a notice out
 * after the rate window. Rendered by components/PersistencePill.jsx.
 *
 * `console.warn` stays as the secondary trace (one line per failure, with the
 * command name); the notice is the primary surface.
 */
export function usePersistenceNotices({ projectInstance }) {
  const readOnly = projectInstance?.readOnly === true;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  const [state, setState] = useState(createNoticeState);

  // Nothing from the previous workspace may linger (ids overlap across projects).
  useEffect(() => {
    setState(clearNotices());
  }, [projectInstance?.instanceId]);

  useEffect(() => {
    return onPersistenceWriteFailure(({ command, error }) => {
      // eslint-disable-next-line no-console
      console.warn('[persistence] write failed:', command, error);
      const failure = describeWriteFailure(command, error);
      const now = Date.now();
      const isReadOnly = readOnlyRef.current;
      setState((prev) => reduceWriteFailure(prev, failure, { now, readOnly: isReadOnly }));
    });
  }, []);

  // Age the visible notice out after the window.
  const noticeAt = state.notice?.at ?? null;
  useEffect(() => {
    if (noticeAt === null) return undefined;
    const remaining = Math.max(0, noticeAt + NOTICE_RATE_LIMIT_MS - Date.now());
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setState((prev) => expireNotice(prev, now));
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [noticeAt]);

  const dismissNotice = useCallback(() => {
    setState((prev) => dismissNoticeState(prev));
  }, []);

  return { readOnly, notice: state.notice, dismissNotice };
}
