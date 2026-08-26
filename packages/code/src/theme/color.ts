/** An 8-bit-per-channel RGB color (no alpha, despite the historical name). */
export interface RGBA {
  r: number;
  g: number;
  b: number;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** Formats an RGB color as a `#rrggbb` hex string. */
export function rgbaToHex(c: RGBA): string {
  const h = (n: number): string => clampByte(n).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** Parses the CSS color forms accepted by Clarvis themes. */
export function parseColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  if (s.length === 0) return null;
  const body = s.startsWith("#") ? s.slice(1) : s;
  const hex = /^[0-9a-f]{3}$|^[0-9a-f]{6}$/.test(body) ? body : null;
  if (hex !== null) {
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0]! + hex[0]!, 16),
        g: parseInt(hex[1]! + hex[1]!, 16),
        b: parseInt(hex[2]! + hex[2]!, 16),
      };
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (rgb) return { r: clampByte(+rgb[1]!), g: clampByte(+rgb[2]!), b: clampByte(+rgb[3]!) };
  const hsl = /^hsla?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%/.exec(s);
  if (hsl) return hslToRgb(+hsl[1]!, +hsl[2]! / 100, +hsl[3]! / 100);
  return null;
}

/** Converts HSL (`h` degrees, `s`/`l` in `[0, 1]`) to RGB. */
export function hslToRgb(h: number, s: number, l: number): RGBA {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let r: number, g: number, b: number;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: clampByte((r + m) * 255), g: clampByte((g + m) * 255), b: clampByte((b + m) * 255) };
}

/** Converts RGB to HSL (`h` degrees, `s`/`l` in `[0, 1]`). */
export function rgbToHsl(c: RGBA): { h: number; s: number; l: number } {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}
