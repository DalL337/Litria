// LassoBox.jsx
// Visual component for the lasso/marquee selection box
// Just renders - no logic (that's in useLassoSelection)

import { Rect } from 'react-konva';

function LassoBox({ box, fill = "rgba(0, 191, 255, 0.2)", stroke = "#00BFFF" }) {
  if (!box) return null;
  
  return (
    <Rect
      x={box.x}
      y={box.y}
      width={box.width}
      height={box.height}
      fill={fill}
      stroke={stroke}
      strokeWidth={2}
      dash={[5, 5]}
    />
  );
}

export default LassoBox;