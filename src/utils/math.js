// math.js

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
