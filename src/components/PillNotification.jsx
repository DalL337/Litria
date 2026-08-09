import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronDown, Copy, FileDown, Terminal as TerminalIcon } from 'lucide-react';
import { useTopDrawers } from '../drawers/TopDrawerContext';

const AUTO_DISMISS_MS = 8000;
// Action pills: how long to wait for the terminal session to exist after
// opening the drawer (spawn is drawer-driven), and a settle delay so the
// injected command lands after the shell's startup banner/prompt.
const SESSION_POLL_MS = 250;
const SESSION_POLL_TRIES = 40;
const SHELL_SETTLE_MS = 600;

function PillNotification({ pillDomain, terminalDomain, buildLogActions = null }) {
  const [pills, setPills] = useState([]);
  // Which pill's action menu is open, by id. Pills are transient, so this is
  // cleared implicitly when the pill leaves the list.
  const [menuPillId, setMenuPillId] = useState(null);
  // Viewport coordinates for the open menu. The pill sets `overflow: hidden`
  // to keep child hover fills inside its radius, which also clips any
  // absolutely-positioned child — the menu rendered as a 1px sliver. Anchoring
  // it with position:fixed escapes that clip entirely.
  const [menuAnchor, setMenuAnchor] = useState({ top: 0, right: 0 });
  const [statusById, setStatusById] = useState({});
  const { openDrawer } = useTopDrawers();

  useEffect(() => {
    if (!pillDomain) return;
    setPills(pillDomain.selectors.getPills());
    return pillDomain.subscribe((next) => setPills(next));
  }, [pillDomain]);

  // Auto-dismiss success pills
  useEffect(() => {
    const successPills = pills.filter((p) => p.severity === 'success');
    if (successPills.length === 0) return;

    const timers = successPills.map((pill) => {
      // Don't yank a pill out from under an open menu — the user is
      // mid-interaction with exactly the message we'd be discarding.
      if (pill.id === menuPillId) return null;
      const age = Date.now() - pill.timestamp;
      const remaining = Math.max(0, AUTO_DISMISS_MS - age);
      return setTimeout(() => {
        pillDomain?.commands.dismissPill(pill.id);
      }, remaining);
    });

    return () => timers.forEach((timer) => timer && clearTimeout(timer));
  }, [pills, pillDomain, menuPillId]);

  const handleDismiss = useCallback(
    (id) => {
      pillDomain?.commands.dismissPill(id);
    },
    [pillDomain]
  );

  const handleOpenTerminal = useCallback(() => {
    openDrawer('terminal');
  }, [openDrawer]);

  // A pill is the only surface some warnings ever get (the scaffold age-gate
  // advisory, for one), and it auto-dismisses. These two actions make it
  // recoverable instead of a message you had to read in time.
  const handleCopyPill = useCallback(async (pill) => {
    setMenuPillId(null);
    const ok = await buildLogActions?.copyText?.(pill.message);
    setStatusById((prev) => ({ ...prev, [pill.id]: ok ? 'Copied' : 'Copy failed' }));
  }, [buildLogActions]);

  const handleSendPillToLogs = useCallback(async (pill) => {
    setMenuPillId(null);
    const path = await buildLogActions?.sendRecordToLogs?.({
      slug: 'notice',
      record: {
        kind: 'pill',
        severity: pill.severity,
        message: pill.message,
        exitCode: pill.exitCode ?? null,
        command: pill.command ?? null,
      },
    });
    setStatusById((prev) => ({ ...prev, [pill.id]: path ? 'Saved' : 'Save failed' }));
  }, [buildLogActions]);

  // Action pill (ADR-020 Slice 4): open the visible terminal, wait for the
  // drawer-driven spawn to yield a session, then TYPE the pill's command
  // into it — the user watches it run. The pill dismisses on activation;
  // its onActivated persists the "actioned" flag.
  const handleActivate = useCallback(async (pill) => {
    openDrawer('terminal');
    if (!pill.command) return;
    pillDomain?.commands.dismissPill(pill.id);
    try {
      pill.onActivated?.();
    } catch {
      // Flag persistence is best-effort; the command still runs.
    }
    if (!terminalDomain) return;
    for (let attempt = 0; attempt < SESSION_POLL_TRIES; attempt++) {
      const session = terminalDomain.selectors.getActiveSession?.();
      if (session?.sessionId) {
        await new Promise((resolve) => setTimeout(resolve, SHELL_SETTLE_MS));
        terminalDomain.commands.sendInput({
          projectId: session.projectId,
          input: `${pill.command}\r`,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_MS));
    }
  }, [openDrawer, pillDomain, terminalDomain]);

  // Callback pill (ADR-005 A3, Slice 5): class-1 consent — the click runs
  // the pill's action (a verified managed install), not the terminal.
  const handleAction = useCallback((pill) => {
    pillDomain?.commands.dismissPill(pill.id);
    try {
      pill.onActivated?.();
    } catch {
      // Flag persistence is best-effort; the action still runs.
    }
    try {
      pill.action?.();
    } catch {
      // Action errors surface through their own pills/events.
    }
  }, [pillDomain]);

  if (pills.length === 0) return null;

  return (
    <div className="pill-notification-container">
      {pills.map((pill) => (
        <div
          key={pill.id}
          className={`pill-notification pill-${pill.severity}`}
          role="status"
        >
          <button
            className="pill-notification-body"
            type="button"
            onClick={
              pill.command ? () => handleActivate(pill)
              : pill.action ? () => handleAction(pill)
              : handleOpenTerminal
            }
            title={
              pill.command ? `Run in terminal: ${pill.command}`
              : pill.action ? pill.message
              : 'Open terminal'
            }
          >
            <TerminalIcon size={12} />
            <span className="pill-notification-text">{pill.message}</span>
          </button>
          {statusById[pill.id] && (
            <span className="pill-notification-status">{statusById[pill.id]}</span>
          )}
          <div className="pill-notification-menu-wrap">
            <button
              className="pill-notification-caret"
              type="button"
              aria-label="Pill actions"
              aria-haspopup="menu"
              aria-expanded={menuPillId === pill.id}
              onClick={(e) => {
                if (menuPillId === pill.id) {
                  setMenuPillId(null);
                  return;
                }
                // Measure at open time — the pill stack shifts as pills come
                // and go, so a cached position would drift.
                const rect = e.currentTarget.getBoundingClientRect();
                setMenuAnchor({
                  top: Math.round(rect.bottom + 4),
                  right: Math.round(window.innerWidth - rect.right),
                });
                setMenuPillId(pill.id);
              }}
            >
              <ChevronDown size={11} />
            </button>
            {/* Portalled to <body>: the pill's backdrop-filter makes it the
                containing block for fixed descendants, so a menu rendered
                in-place stays trapped by its overflow:hidden no matter how it
                is positioned. */}
            {menuPillId === pill.id && createPortal(
              <>
                <div
                  className="pill-notification-backdrop"
                  onClick={() => setMenuPillId(null)}
                />
                <div
                  className="pill-notification-menu"
                  role="menu"
                  style={{ top: menuAnchor.top, right: menuAnchor.right }}
                >
                  <button type="button" role="menuitem" onClick={() => handleCopyPill(pill)}>
                    <Copy size={12} /> Copy to clipboard
                  </button>
                  <button type="button" role="menuitem" onClick={() => handleSendPillToLogs(pill)}>
                    <FileDown size={12} /> Send to logs
                  </button>
                </div>
              </>,
              document.body
            )}
          </div>
          <button
            className="pill-notification-dismiss"
            type="button"
            onClick={() => handleDismiss(pill.id)}
            aria-label="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export default PillNotification;
