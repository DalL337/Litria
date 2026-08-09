// EdgeGlow.jsx
// Renders a soft, fading glow on a specific edge of a piece
// Used during connection drag to show where the connection will attach
//
// The glow:
// - Is 5px total thickness (including fade)
// - Wraps around the two corners that belong to that edge
// - Fades from solid green at the edge to transparent
// - Feels like a light that fades at the edges

import { Shape } from 'react-konva';
import { PIECE_WIDTH, PIECE_HEIGHT } from './PuzzlePiece';

// Glow settings
const GLOW_SIZE = 5;           // Total thickness of glow (including fade)
const CORNER_RADIUS = 12;      // Must match PuzzlePiece nodeCornerRadius token default
const GLOW_COLOR = '#4CAF50';  // Theme fallback

function EdgeGlow({ 
  piece, 
  edge, 
  glowColor = GLOW_COLOR,
  glowSize = GLOW_SIZE,
  pieceWidth = PIECE_WIDTH, 
  pieceHeight = PIECE_HEIGHT,
  cornerRadius = CORNER_RADIUS
}) {
  if (!piece || !edge) return null;

  return (
    <Shape
      x={piece.x}
      y={piece.y}
      sceneFunc={(context, shape) => {
        // Draw a path along the edge (including rounded corners)
        // Use multiple passes with decreasing opacity for smooth fade
        
        const passes = [
          { alpha: 0.6, blur: glowSize, width: glowSize },
          { alpha: 0.4, blur: glowSize * 0.7, width: glowSize * 0.7 },
          { alpha: 0.2, blur: glowSize * 0.4, width: glowSize * 0.4 },
        ];

        passes.forEach(({ alpha, blur, width }) => {
          context.beginPath();
          
          switch (edge) {
            case 'top':
              // Start at bottom-left of top edge, go around top corners
              context.moveTo(0, cornerRadius);
              context.arcTo(0, 0, cornerRadius, 0, cornerRadius);
              context.lineTo(pieceWidth - cornerRadius, 0);
              context.arcTo(pieceWidth, 0, pieceWidth, cornerRadius, cornerRadius);
              break;
              
            case 'right':
              // Start at top-left of right edge, go around right corners
              context.moveTo(pieceWidth - cornerRadius, 0);
              context.arcTo(pieceWidth, 0, pieceWidth, cornerRadius, cornerRadius);
              context.lineTo(pieceWidth, pieceHeight - cornerRadius);
              context.arcTo(pieceWidth, pieceHeight, pieceWidth - cornerRadius, pieceHeight, cornerRadius);
              break;
              
            case 'bottom':
              // Start at top-right of bottom edge, go around bottom corners
              context.moveTo(pieceWidth, pieceHeight - cornerRadius);
              context.arcTo(pieceWidth, pieceHeight, pieceWidth - cornerRadius, pieceHeight, cornerRadius);
              context.lineTo(cornerRadius, pieceHeight);
              context.arcTo(0, pieceHeight, 0, pieceHeight - cornerRadius, cornerRadius);
              break;
              
            case 'left':
              // Start at bottom-right of left edge, go around left corners
              context.moveTo(cornerRadius, pieceHeight);
              context.arcTo(0, pieceHeight, 0, pieceHeight - cornerRadius, cornerRadius);
              context.lineTo(0, cornerRadius);
              context.arcTo(0, 0, cornerRadius, 0, cornerRadius);
              break;
              
            default:
              return;
          }

          // Style for this pass
          context.lineCap = 'round';
          context.lineJoin = 'round';
          context.lineWidth = width;
          
          // Glow effect using shadow
          context.shadowColor = glowColor;
          context.shadowBlur = blur;
          context.shadowOffsetX = 0;
          context.shadowOffsetY = 0;
          
          // Stroke with transparency
          context.strokeStyle = glowColor;
          context.globalAlpha = alpha;
          
          context.stroke();
        });
        
        // Reset alpha
        context.globalAlpha = 1;
      }}
      // Disable interactions - this is just a visual indicator
      listening={false}
    />
  );
}

export default EdgeGlow;
