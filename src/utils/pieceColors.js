export const PIECE_COLOR_PALETTE = ['#ef5350', '#66bb6a', '#ffd54f', '#42a5f5'];

export function getRandomPieceColor() {
  const index = Math.floor(Math.random() * PIECE_COLOR_PALETTE.length);
  return PIECE_COLOR_PALETTE[index];
}
