// Desk.jsx
// Infinite canvas workspace container

import { forwardRef } from 'react';

const Desk = forwardRef(function Desk({ children, backgroundColor = '#1a1a1a' }, ref) {
  return (
    <div
      ref={ref}
      className="desk"
      style={{ backgroundColor }}
    >
      {children}
    </div>
  );
});

export default Desk;
