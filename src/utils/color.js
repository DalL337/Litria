// Generic color parsing + HSL transforms shared across the canvas paint paths.
// Kept dependency-free and pure so it can be unit-tested in isolation.

/**
 * Parse a hex (#rgb, #rgba, #rrggbb, #rrggbbaa) or rgb()/rgba() string into
 * {r, g, b} channels (0–255). Alpha is ignored. Returns null on parse failure.
 */
export function parseColorToRgb(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value) return null;

  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      if ([r, g, b].some((channel) => Number.isNaN(channel))) return null;
      return { r, g, b };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].some((channel) => Number.isNaN(channel))) return null;
      return { r, g, b };
    }
    return null;
  }

  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgbMatch) return null;
  const parts = rgbMatch[1].split(',').map((part) => part.trim());
  if (parts.length < 3) return null;
  const r = Number(parts[0]);
  const g = Number(parts[1]);
  const b = Number(parts[2]);
  if (![r, g, b].every(Number.isFinite)) return null;
  return {
    r: Math.max(0, Math.min(255, r)),
    g: Math.max(0, Math.min(255, g)),
    b: Math.max(0, Math.min(255, b))
  };
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/** {r,g,b} (0–255) → {h (0–360), s (0–1), l (0–1)}. */
export function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h;
  if (max === rn) {
    h = ((gn - bn) / delta) % 6;
  } else if (max === gn) {
    h = (bn - rn) / delta + 2;
  } else {
    h = (rn - gn) / delta + 4;
  }
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

/** {h,s,l} → {r,g,b} (0–255, rounded). */
export function hslToRgb({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255)
  };
}

/** {r,g,b} → '#rrggbb'. */
export function rgbToHex({ r, g, b }) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Pastelize a color by scaling its saturation down and lightness up. The
 * Live/Calm energy axis drives this via static tokens (identity = scales of 1
 * and no lightness cap, so Live returns the color untouched). Calm lowers
 * saturation and raises lightness to produce a soft pastel.
 *
 * `maxLightness` caps the result so already-light hues (reds/oranges/yellows)
 * can't creep toward white, where hue differences stop being visible and warm
 * pastels converge. Falls back to the original string on parse failure so it
 * never blanks an edge.
 */
export function pastelizeColor(
  color,
  { saturationScale = 1, lightnessScale = 1, maxLightness = 1 } = {}
) {
  if (saturationScale === 1 && lightnessScale === 1 && maxLightness >= 1) return color;
  const rgb = parseColorToRgb(color);
  if (!rgb) return color;
  const hsl = rgbToHsl(rgb);
  hsl.s = clamp01(hsl.s * saturationScale);
  hsl.l = Math.min(clamp01(hsl.l * lightnessScale), maxLightness);
  return rgbToHex(hslToRgb(hsl));
}
