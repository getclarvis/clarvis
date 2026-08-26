import { SUBAGENT_ORDER, type SubagentName, type TokenName } from "./tokens.ts";
import { hslToRgb, parseColor, rgbaToHex, rgbToHsl, type RGBA } from "./color.ts";
import type { ResolvedTokens } from "../core/theme-types.ts";

/**
 * Relative luminance of an sRGB color per the WCAG 2 formula.
 *
 * @returns a value in `[0, 1]`, used by {@link contrastRatio}.
 */
export function relativeLuminance(c: RGBA): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2 contrast ratio between two colors, in `[1, 21]`; order of `fg`/`bg` does not matter. */
export function contrastRatio(fg: RGBA, bg: RGBA): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG conformance tier a contrast ratio meets. */
export type ContrastLevel = "AAA" | "AA" | "AA-large" | "fail";

/** Classifies a {@link contrastRatio} result into its {@link ContrastLevel}. */
export function contrastLevel(ratio: number): ContrastLevel {
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA-large";
  return "fail";
}

/** Any token name {@link auditContrast} checks as a foreground color. */
export type ContrastFgName = TokenName | SubagentName;

const CONTRAST_PAIRS: readonly [ContrastFgName, TokenName][] = [
  ["fg", "bg"],
  ["muted", "bg"],
  ["accent", "bg"],
  ["accent-2", "bg"],
  ["add", "bg"],
  ["warn", "bg"],
  ["del", "bg"],
  ["fg", "bg-elev"],
  ["muted", "bg-elev"],
  ["warn", "bg-elev"],
  ["del", "bg-elev"],
  ...SUBAGENT_ORDER.map((name): [ContrastFgName, TokenName] => [name, "bg"]),
];

/** The measured contrast for one foreground/background token pair. */
export interface ContrastResult {
  pair: [ContrastFgName, TokenName];
  ratio: number;
  level: ContrastLevel;
}

/** Measures contrast for every foreground/background pair the theme cares about. */
export function auditContrast(resolved: ResolvedTokens): ContrastResult[] {
  const out: ContrastResult[] = [];
  for (const [fgTok, bgTok] of CONTRAST_PAIRS) {
    const fg = parseColor(resolved[fgTok]);
    const bg = parseColor(resolved[bgTok]);
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    out.push({ pair: [fgTok, bgTok], ratio, level: contrastLevel(ratio) });
  }
  return out;
}

/**
 * Nudges `fgHex`'s lightness toward `bgHex` until it clears `target` contrast,
 * without changing its hue or saturation.
 *
 * @param target - minimum contrast ratio to reach; defaults to WCAG AA (4.5).
 * @returns `fgHex` unchanged if it already clears `target`; otherwise the
 *   closest color found within 100 lightness steps (never worse than the input).
 */
export function nudgeToAA(fgHex: string, bgHex: string, target = 4.5): string {
  const fg = parseColor(fgHex);
  const bg = parseColor(bgHex);
  if (!fg || !bg) return fgHex;
  if (contrastRatio(fg, bg) >= target) return fgHex;
  const bgLum = relativeLuminance(bg);
  const hsl = rgbToHsl(fg);
  const dir = bgLum < 0.5 ? 1 : -1;
  let best = fg;
  let bestRatio = contrastRatio(fg, bg);
  for (let step = 1; step <= 100; step++) {
    const l = Math.max(0, Math.min(1, hsl.l + dir * (step / 100)));
    const cand = hslToRgb(hsl.h, hsl.s, l);
    const ratio = contrastRatio(cand, bg);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = cand;
    }
    if (ratio >= target) return rgbaToHex(cand);
  }
  return rgbaToHex(best);
}
