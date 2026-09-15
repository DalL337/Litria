import { READ_ONLY_PILL_TEXT } from '../project/persistenceNotices.js';

// Persistence pill (ADR-026 decision 3, slice 4): the canvas's honest answer
// to "did that save?". Two rows, top-center of the canvas, independent of the
// draggable HUD:
//   - a persistent read-only pill while the workspace opened read-only;
//   - the latest persistence write failure, rate-limited by the hook.
// Hand-rolled BEM per the pill protected zone (ADR-008); tokens only.

export default function PersistencePill({ readOnly = false, notice = null, onDismissNotice }) {
  if (!readOnly && !notice) return null;

  return (
    <div className="persistence-pill-stack" role="status" aria-live="polite">
      {readOnly && (
        <div className="persistence-pill persistence-pill--read-only" title="The workspace database could not be opened for writing. Viewing, zooming and panning all work; nothing is written.">
          <span className="persistence-pill-dot" aria-hidden="true" />
          <span className="persistence-pill-text">{READ_ONLY_PILL_TEXT}</span>
        </div>
      )}
      {notice && (
        <div className="persistence-pill persistence-pill--notice">
          <span className="persistence-pill-dot" aria-hidden="true" />
          <span className="persistence-pill-text persistence-pill-text--wrap">{notice.message}</span>
          {notice.suppressed > 0 && (
            <span className="persistence-pill-count">+{notice.suppressed} more</span>
          )}
          <button
            type="button"
            className="persistence-pill-dismiss"
            aria-label="Dismiss"
            onClick={onDismissNotice}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
