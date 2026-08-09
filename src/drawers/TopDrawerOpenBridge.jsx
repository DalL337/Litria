import { useEffect, useRef } from 'react';
import { useTopDrawers } from './TopDrawerContext';

/**
 * TopDrawerOpenBridge — lets code OUTSIDE the top-drawer provider ask for a
 * drawer to open.
 *
 * The menu bar renders above TopDrawerProvider, so it cannot call
 * `openDrawer` itself. Rather than make the provider a controlled component
 * (TopDrawerContext.jsx is a protected zone), App raises a request object and
 * this null-rendering child — which IS inside the provider — performs the
 * open.
 *
 * `request.seq` is what makes it fire: repeating the same menu item must
 * reopen the drawer, so the effect keys on a monotonic sequence rather than
 * on the drawer id.
 */
function TopDrawerOpenBridge({ request }) {
  const { openDrawer } = useTopDrawers();
  const lastSeqRef = useRef(0);

  useEffect(() => {
    if (!request?.id || request.seq === lastSeqRef.current) return;
    lastSeqRef.current = request.seq;
    openDrawer(request.id);
    // openDrawer is recreated each render by the provider; depending on it
    // would refire this effect on every render, so the seq guard above is the
    // real gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  return null;
}

export default TopDrawerOpenBridge;
