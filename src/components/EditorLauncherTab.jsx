import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileCode2 } from 'lucide-react';

function clamp(value, min, max) {
  if (min > max) return 0;
  return Math.max(min, Math.min(max, value));
}

function EditorLauncherTab({ isVisible, isOpen, onOpen, label }) {
  const railRef = useRef(null);
  const dragState = useRef({ dragging: false, startY: 0, startOffset: 0 });
  const [railOffset, setRailOffset] = useState(0);
  const [railBounds, setRailBounds] = useState({ min: -200, max: 200 });
  const [isDragging, setIsDragging] = useState(false);

  useLayoutEffect(() => {
    const updateBounds = () => {
      const rail = railRef.current;
      if (!rail) return;
      const viewportHeight = window.innerHeight;
      const railHeight = rail.offsetHeight;
      const padding = 48;
      const half = viewportHeight / 2;
      const min = -(half - padding);
      const max = half - railHeight - padding;
      setRailBounds({ min, max });
      setRailOffset((offset) => clamp(offset, min, max));
    };

    updateBounds();
    window.addEventListener('resize', updateBounds);
    return () => window.removeEventListener('resize', updateBounds);
  }, []);

  useEffect(() => {
    const handleMove = (event) => {
      if (!dragState.current.dragging) return;
      const delta = event.clientY - dragState.current.startY;
      const next = dragState.current.startOffset + delta;
      setRailOffset(clamp(next, railBounds.min, railBounds.max));
    };

    const handleUp = () => {
      dragState.current.dragging = false;
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [railBounds.max, railBounds.min]);

  const handleRailMouseDown = (event) => {
    if (event.target.closest('button')) return;
    dragState.current = {
      dragging: true,
      startY: event.clientY,
      startOffset: railOffset
    };
    setIsDragging(true);
  };

  if (!isVisible || isOpen) return null;

  return (
    <div
      ref={railRef}
      className={`editor-launcher-rail ${isDragging ? 'is-dragging' : ''}`}
      style={{ '--editor-launcher-offset': `${railOffset}px` }}
      onMouseDown={handleRailMouseDown}
    >
      <button
        className={`drawer-tab editor-launcher-tab ${isOpen ? 'is-active' : ''}`}
        type="button"
        onClick={onOpen}
        title={label ?? (isOpen ? 'Editor Open' : 'Open Editor')}
        aria-label={label ?? (isOpen ? 'Editor Open' : 'Open Editor')}
      >
        <FileCode2 size={18} />
      </button>
    </div>
  );
}

export default EditorLauncherTab;
