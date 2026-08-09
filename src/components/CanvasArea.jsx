import { forwardRef } from 'react';

const CanvasArea = forwardRef(function CanvasArea({ children, className = '' }, ref) {
  return (
    <div ref={ref} className={`canvas-area${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
});

export default CanvasArea;
