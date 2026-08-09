import { useEffect, useRef } from 'react';

const AUTO_PAN_EDGE = 80;
const AUTO_PAN_SPEED = 0.5;

export function useAutoPan({ isDragging, containerRef, setOffsetX, setOffsetY, stateRef }) {
  const rafRef = useRef(null);

  useEffect(() => {
    if (!isDragging) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    let lastMouseX = 0;
    let lastMouseY = 0;
    const onMouseMove = (e) => { lastMouseX = e.clientX; lastMouseY = e.clientY; };
    window.addEventListener('mousemove', onMouseMove);

    const loop = () => {
      const container = containerRef.current;
      if (!container) { rafRef.current = requestAnimationFrame(loop); return; }
      const rect = container.getBoundingClientRect();
      const { offsetX, offsetY } = stateRef.current;

      let dx = 0;
      let dy = 0;
      const leftDist = lastMouseX - rect.left;
      const rightDist = rect.right - lastMouseX;
      const topDist = lastMouseY - rect.top;
      const botDist = rect.bottom - lastMouseY;

      if (leftDist < AUTO_PAN_EDGE && leftDist >= 0) dx = (AUTO_PAN_EDGE - leftDist) * AUTO_PAN_SPEED;
      if (rightDist < AUTO_PAN_EDGE && rightDist >= 0) dx = -(AUTO_PAN_EDGE - rightDist) * AUTO_PAN_SPEED;
      if (topDist < AUTO_PAN_EDGE && topDist >= 0) dy = (AUTO_PAN_EDGE - topDist) * AUTO_PAN_SPEED;
      if (botDist < AUTO_PAN_EDGE && botDist >= 0) dy = -(AUTO_PAN_EDGE - botDist) * AUTO_PAN_SPEED;

      if (dx !== 0) setOffsetX(offsetX + dx);
      if (dy !== 0) setOffsetY(offsetY + dy);

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      window.removeEventListener('mousemove', onMouseMove);
    };
  }, [isDragging, containerRef, setOffsetX, setOffsetY, stateRef]);
}
