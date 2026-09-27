import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Crosshair, Map, Braces } from 'lucide-react';
import { useLongPress } from '../behaviors';
import NodeSearchPanel from './NodeSearchPanel';
import StatusBarPopover from './StatusBarPopover';
import { NODE_SCALE_PRESETS } from '../app/gridWidgetModel';

// --- Zoom step presets ---
const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];

// Step helpers take their step list, so the zoom slider and the node-scale
// slider (ADR-030 scale readout) share one implementation.
function nearestStep(value, steps = ZOOM_STEPS) {
  let best = steps[0];
  let bestDist = Math.abs(value - best);
  for (let i = 1; i < steps.length; i++) {
    const dist = Math.abs(value - steps[i]);
    if (dist < bestDist) {
      best = steps[i];
      bestDist = dist;
    }
  }
  return best;
}

function stepFraction(value, steps = ZOOM_STEPS) {
  const min = steps[0];
  const max = steps[steps.length - 1];
  return (value - min) / (max - min);
}

function fractionToStep(fraction, steps = ZOOM_STEPS) {
  const min = steps[0];
  const max = steps[steps.length - 1];
  const raw = min + fraction * (max - min);
  return nearestStep(raw, steps);
}

// --- Zero-pad helper ---
function pad4(n) {
  const abs = Math.abs(Math.round(n));
  const padded = String(abs).padStart(4, '0');
  return n < 0 ? `-${padded}` : ` ${padded}`;
}

// --- Ref-driven viewport coords (no React re-renders during pan) ---
function ViewportCoords({ viewportStateRef, deskWidth, deskHeight }) {
  const xRef = useRef(null);
  const yRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    let mounted = true;
    let prevX = null;
    let prevY = null;
    const tick = () => {
      if (!mounted) return;
      const state = viewportStateRef.current;
      if (state && xRef.current && yRef.current && deskWidth > 0 && deskHeight > 0) {
        const centerX = Math.round((deskWidth / 2 - state.offsetX) / state.scale);
        const centerY = Math.round((deskHeight / 2 - state.offsetY) / state.scale);
        if (centerX !== prevX) {
          xRef.current.textContent = `X:${pad4(centerX)}`;
          prevX = centerX;
        }
        if (centerY !== prevY) {
          yRef.current.textContent = `Y:${pad4(centerY)}`;
          prevY = centerY;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      mounted = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [viewportStateRef, deskWidth, deskHeight]);

  return (
    <span className="status-bar-coords">
      <span ref={xRef}>X: ----</span>
      {'  '}
      <span ref={yRef}>Y: ----</span>
    </span>
  );
}

// --- Zoom slider content (rendered inside PopoverContent) ---
// Also the node-scale slider: `steps` swaps the stops (ADR-030).
function ZoomSlider({ scale, onZoomChange, steps = ZOOM_STEPS }) {
  const trackRef = useRef(null);

  const handleTrackClick = useCallback((e) => {
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onZoomChange(fractionToStep(fraction, steps));
  }, [onZoomChange, steps]);

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    const onMove = (me) => {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (me.clientX - rect.left) / rect.width));
      onZoomChange(fractionToStep(fraction, steps));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    handleTrackClick(e);
  }, [onZoomChange, handleTrackClick, steps]);

  const frac = stepFraction(nearestStep(scale, steps), steps);

  return (
    <div
      ref={trackRef}
      className="status-bar-zoom-track"
      onMouseDown={handleMouseDown}
    >
      <div className="status-bar-zoom-fill" style={{ width: `${frac * 100}%` }} />
      <div className="status-bar-zoom-thumb" style={{ left: `${frac * 100}%` }} />
    </div>
  );
}

// --- Language status indicator ---
function LanguageStatus({ languageSupportDomain }) {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    if (!languageSupportDomain) return;
    function refresh() {
      const packIds = languageSupportDomain.selectors.getSupportedPackIds();
      for (const id of packIds) {
        const session = languageSupportDomain.selectors.getActiveSession(id);
        if (session) {
          const pack = languageSupportDomain.selectors.getPackState(id);
          setInfo({ packId: id, pack });
          return;
        }
      }
      setInfo(null);
    }
    refresh();
    const offCompleted = languageSupportDomain.events.onActivationCompleted(refresh);
    const offFailed = languageSupportDomain.events.onActivationFailed(refresh);
    const offSetup = languageSupportDomain.events.onSetupCompleted(refresh);
    return () => { offCompleted(); offFailed(); offSetup(); };
  }, [languageSupportDomain]);

  if (!info) return null;

  const { packId, pack } = info;
  const server = pack?.prerequisites?.server;
  const serverLabel = server?.command ?? packId;
  const serverVersion = server?.version;

  const title = [
    serverLabel,
    serverVersion ? `v${serverVersion}` : null,
    pack?.prerequisites?.python?.version ? `Python ${pack.prerequisites.python.version}` : null,
    pack?.session?.projectRoot ? `cwd: ${pack.session.projectRoot}` : null
  ].filter(Boolean).join(' · ');

  return (
    <span className="status-bar-lang" title={title}>
      <Braces size={14} />
      <span className="status-bar-lang-label">
        {serverLabel}{serverVersion ? ` ${serverVersion}` : ''}
      </span>
    </span>
  );
}

// --- Main StatusBar component ---
function StatusBar({
  projectName,
  viewportScale,
  viewportStateRef,
  deskWidth,
  deskHeight,
  onResetView,
  onZoomChange,
  tabsById,
  hasDirtyTabs,
  isTabDirty,
  onSelectDirtyTab,
  isMinimapVisible,
  onToggleMinimap,
  languageSupportDomain,
  pieces,
  onNavigateToPiece,
  onNavigateHome,
  interactionModeLabel = null,
  energyLevel = 'live',
  onToggleEnergy,
  // Node scale (owner rulings 2026-09-27): shown only with a selection;
  // 'Mixed' for a mixed selection. Opens the same slider as zoom.
  nodeScaleText = null,
  nodeScale = null,
  onNodeScaleChange = null,
  // Where a drag will land (ADR-030: the reticle's coordinate lives here).
  landingReadout = null
}) {
  const [zoomPopoverOpen, setZoomPopoverOpen] = useState(false);
  const [scalePopoverOpen, setScalePopoverOpen] = useState(false);
  const [dirtyPopoverOpen, setDirtyPopoverOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Radix handles single-click toggle; we just manage mutual exclusion
  const handleZoomOpenChange = useCallback((open) => {
    setZoomPopoverOpen(open);
    if (open) setDirtyPopoverOpen(false);
  }, []);

  const handleDirtyOpenChange = useCallback((open) => {
    if (open && !hasDirtyTabs) return; // guard: no dirty tabs = no popover
    setDirtyPopoverOpen(open);
    if (open) setZoomPopoverOpen(false);
  }, [hasDirtyTabs]);

  // Double-click zoom button = reset to 100%
  const handleZoomDoubleClick = useCallback(() => {
    onZoomChange(1.0);
    setZoomPopoverOpen(false);
  }, [onZoomChange]);

  // Dirty tab list
  const dirtyTabs = tabsById
    ? Object.values(tabsById).filter((tab) => isTabDirty?.(tab.id))
    : [];
  const dirtyCount = dirtyTabs.length;

  const handleSelectDirtyTab = useCallback((tabId) => {
    onSelectDirtyTab?.(tabId);
    setDirtyPopoverOpen(false);
  }, [onSelectDirtyTab]);

  const compassPress = useLongPress({
    onClick: onResetView,
    onLongPress: () => setSearchOpen(true)
  });

  const zoomPercent = Math.round(viewportScale * 100);

  return (
    <div className="status-bar">
      {/* Left Zone: Crosshair + Coords + Zoom */}
      <div className="status-bar-left">
        <StatusBarPopover
          open={searchOpen}
          onOpenChange={setSearchOpen}
          className="status-bar-search-popover"
          align="start"
          anchor={
            <button
              className="status-bar-btn"
              type="button"
              title="Fit view (hold for search)"
              {...compassPress}
            >
              <Crosshair size={18} />
            </button>
          }
        >
          <NodeSearchPanel
            pieces={pieces ?? []}
            onNavigateToPiece={onNavigateToPiece}
            onNavigateHome={onNavigateHome}
            onClose={() => setSearchOpen(false)}
          />
        </StatusBarPopover>
        <ViewportCoords
          viewportStateRef={viewportStateRef}
          deskWidth={deskWidth}
          deskHeight={deskHeight}
        />
        <span className="status-bar-separator" />
        <StatusBarPopover
          open={zoomPopoverOpen}
          onOpenChange={handleZoomOpenChange}
          className="status-bar-zoom-popover"
          trigger={
            <button
              className="status-bar-zoom-btn"
              type="button"
              onDoubleClick={handleZoomDoubleClick}
              title="Zoom level (double-click to reset)"
            >
              {zoomPercent}%
            </button>
          }
        >
          <ZoomSlider
            scale={viewportScale}
            onZoomChange={onZoomChange}
          />
        </StatusBarPopover>
        {nodeScaleText && (
          <>
            <span className="status-bar-separator" />
            <StatusBarPopover
              open={scalePopoverOpen}
              onOpenChange={(open) => {
                setScalePopoverOpen(open);
                if (open) setZoomPopoverOpen(false);
              }}
              className="status-bar-zoom-popover"
              trigger={
                <button
                  className="status-bar-zoom-btn status-bar-scale-btn"
                  type="button"
                  onDoubleClick={() => {
                    onNodeScaleChange?.(1);
                    setScalePopoverOpen(false);
                  }}
                  title="Node scale (double-click to reset to 100%)"
                >
                  Node {nodeScaleText}
                </button>
              }
            >
              <ZoomSlider
                scale={nodeScale ?? 1}
                onZoomChange={(value) => onNodeScaleChange?.(value)}
                steps={NODE_SCALE_PRESETS}
              />
            </StatusBarPopover>
          </>
        )}
        {landingReadout && (
          <>
            <span className="status-bar-separator" />
            <span className="status-bar-landing">{landingReadout}</span>
          </>
        )}
      </div>

      {/* Center Zone: Project Name + Save State */}
      <div className="status-bar-center">
        {projectName && (
          <span className="status-bar-project-name" title={projectName}>
            {projectName}
          </span>
        )}
        <StatusBarPopover
          open={dirtyPopoverOpen && dirtyCount > 0}
          onOpenChange={handleDirtyOpenChange}
          className="status-bar-dirty-popover"
          trigger={
            <button
              className={`status-bar-save-indicator ${dirtyCount > 0 ? 'is-dirty' : 'is-clean'}`}
              type="button"
              title={dirtyCount > 0 ? `${dirtyCount} unsaved file(s)` : 'All files saved'}
            >
              {dirtyCount > 0 ? (
                <>{`* ${dirtyCount}`}</>
              ) : (
                <><Check size={14} /> All Saved</>
              )}
            </button>
          }
        >
          {dirtyTabs.map((tab) => {
            const name = tab.filename?.split('/').pop() || tab.filename || `Tab ${tab.id}`;
            return (
              <button
                key={tab.id}
                className="status-bar-dirty-item"
                type="button"
                onClick={() => handleSelectDirtyTab(tab.id)}
                title={tab.filename}
              >
                {name}
              </button>
            );
          })}
        </StatusBarPopover>
      </div>

      {/* Right Zone: Mode Indicator + Language Status + Minimap Toggle */}
      <div className="status-bar-right">
        {interactionModeLabel && (
          <>
            <span className="status-bar-mode" title="Interaction mode (tap E to toggle)">
              {interactionModeLabel}
            </span>
            <span className="status-bar-separator" />
          </>
        )}
        <LanguageStatus languageSupportDomain={languageSupportDomain} />
        <span className="status-bar-separator" />
        {onToggleEnergy && (
          <button
            className={`status-bar-energy ${energyLevel === 'calm' ? 'is-calm' : 'is-live'}`}
            type="button"
            onClick={onToggleEnergy}
            title={energyLevel === 'calm'
              ? 'Calm — low-stimulus visuals. Click for Live.'
              : 'Live — full-intensity visuals. Click for Calm.'}
          >
            {energyLevel === 'calm' ? 'Calm' : 'Live'}
          </button>
        )}
        <button
          className={`status-bar-btn ${isMinimapVisible ? 'is-active' : ''}`}
          type="button"
          onClick={onToggleMinimap}
          title={isMinimapVisible ? 'Hide minimap' : 'Show minimap'}
        >
          <Map size={18} />
        </button>
      </div>
    </div>
  );
}

export default StatusBar;
