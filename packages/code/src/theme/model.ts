import { createSignal } from "solid-js";
import {
  SUBAGENT_ORDER,
  depthFromCapabilities,
  type ColorDepth,
  type PresetName,
  type ResolvedTokens,
  type ThemeBackground,
  type ThemeConfig,
  type ThemeMode,
  type ThemeModeConfig,
  type TokenName,
} from "../core/theme-types.ts";
import { glyph } from "./glyphs.ts";
import { nudgeToAA } from "./contrast.ts";
import { parseColor, rgbaToHex, type RGBA } from "./color.ts";

export { hslToRgb, parseColor, rgbaToHex, rgbToHsl, type RGBA } from "./color.ts";

/** Re-exported from `core/theme-types` for consumers that only need the theme model. */
export {
  depthFromCapabilities,
  type ColorDepth,
  type PresetName,
  type ResolvedTokens,
  type ThemeBackground,
  type ThemeConfig,
  type ThemeMode,
  type ThemeModeConfig,
};

/** Canonical display/resolution order of the base theme tokens (subagent colors are separate). */
export const TOKEN_ORDER: readonly TokenName[] = [
  "bg",
  "bg-elev",
  "fg",
  "muted",
  "accent",
  "accent-2",
  "add",
  "warn",
  "del",
];

const TOKEN_USED_IN_PARTS: Record<TokenName, readonly string[]> = {
  bg: ["app background"],
  "bg-elev": ["overlays", "cards", "elevated panels"],
  fg: ["body text"],
  muted: ["secondary text", "hints", "borders"],
  accent: ["focus", "headings", "spinner", "wordmark"],
  "accent-2": ["panel sub-headings", "agent/Lead attribution", "links", "active-run border"],
  add: ["additions", "success", "strings"],
  warn: ["warnings", "numbers", "unsaved"],
  del: ["errors", "deletions", "danger"],
};

/** A human-readable, separator-joined summary of where `token` is used in the UI. */
export function tokenUsedIn(token: TokenName): string {
  return TOKEN_USED_IN_PARTS[token].join(" " + glyph("separator") + " ");
}

const FAMILY_DARK: Record<TokenName, string> = {
  accent: "#a5a0f5",
  "accent-2": "#c4b5fd",
  bg: "#0f1020",
  "bg-elev": "#171433",
  fg: "#c7c9d9",
  muted: "#9195ad",
  add: "#3fb950",
  warn: "#d29922",
  del: "#f85149",
};

const FAMILY_LIGHT: Record<TokenName, string> = {
  accent: "#5b54e8",
  "accent-2": "#7c3aed",
  bg: "#fbfbfe",
  "bg-elev": "#eeecf9",
  fg: "#25262f",
  muted: "#6b6e83",
  add: "#1a7f37",
  warn: "#9a6700",
  del: "#cf222e",
};

const FAMILY: Record<ThemeMode, Record<TokenName, string>> = {
  dark: FAMILY_DARK,
  light: FAMILY_LIGHT,
};

const HIGH_CONTRAST: Record<ThemeMode, Partial<Record<TokenName, string>>> = {
  dark: {
    bg: "#000000",
    "bg-elev": "#0c0c14",
    fg: "#ffffff",
    muted: "#a8abbe",
    accent: "#c8c4ff",
    "accent-2": "#ddd4ff",
    add: "#56d364",
    warn: "#e3b341",
    del: "#ff7b72",
  },
  light: {
    bg: "#ffffff",
    "bg-elev": "#f3f2fb",
    fg: "#000000",
    muted: "#4b4e63",
    accent: "#3f37d6",
    "accent-2": "#5b21b6",
    add: "#116329",
    warn: "#7d4e00",
    del: "#a40e26",
  },
};

const MONO: Record<ThemeMode, Record<TokenName, string>> = {
  dark: {
    bg: "#0c0c0c",
    "bg-elev": "#1a1a1a",
    fg: "#e6e6e6",
    muted: "#8a8a8a",
    accent: "#f0f0f0",
    "accent-2": "#cfcfcf",
    add: "#c4c4c4",
    warn: "#dcdcdc",
    del: "#f4f4f4",
  },
  light: {
    bg: "#ffffff",
    "bg-elev": "#eeeeee",
    fg: "#111111",
    muted: "#6a6a6a",
    accent: "#1a1a1a",
    "accent-2": "#3a3a3a",
    add: "#333333",
    warn: "#222222",
    del: "#000000",
  },
};

const SUBAGENT_RAMP: Record<PresetName, Record<ThemeMode, readonly string[]>> = {
  family: {
    dark: ["#a78bfa", "#38bdf8", "#34d399", "#fbbf24", "#fb7185", "#c084fc"],
    light: ["#6d28d9", "#0369a1", "#047857", "#b45309", "#be123c", "#7e22ce"],
  },
  "high-contrast": {
    dark: ["#c4b5fd", "#7dd3fc", "#6ee7b9", "#fcd34d", "#fda4af", "#d8b4fe"],
    light: ["#5b21b6", "#075985", "#065f46", "#92400e", "#9f1239", "#6b21a8"],
  },
  mono: {
    dark: ["#f2f2f2", "#c8c8c8", "#a0a0a0", "#e0e0e0", "#b4b4b4", "#8c8c8c"],
    light: ["#1a1a1a", "#585858", "#767676", "#303030", "#676767", "#4a4a4a"],
  },
};

function presetLayer(preset: PresetName, mode: ThemeMode): Partial<Record<TokenName, string>> {
  if (preset === "high-contrast") return HIGH_CONTRAST[mode];
  if (preset === "mono") return MONO[mode];
  return {};
}

/** Which layer a resolved token's value ultimately came from, most to least specific. */
export type TokenSource = "family" | "preset" | "override-global" | "override-workspace";

/**
 * Resolves one token's color, following precedence: workspace override, then
 * global override, then the active preset's layer, then the mode's base family.
 *
 * @returns the resolved hex value and which layer it came from.
 */
export function resolveToken(
  token: TokenName,
  mode: ThemeMode,
  preset: PresetName,
  overridesGlobal: Partial<Record<TokenName, string>> | undefined,
  overridesWorkspace: Partial<Record<TokenName, string>> | undefined,
): { value: string; source: TokenSource } {
  const w = overridesWorkspace?.[token];
  if (w) return { value: w, source: "override-workspace" };
  const g = overridesGlobal?.[token];
  if (g) return { value: g, source: "override-global" };
  const p = presetLayer(preset, mode)[token];
  if (p) return { value: p, source: "preset" };
  return { value: FAMILY[mode][token], source: "family" };
}

/** The effective dark/light mode: `config.mode`, or the host terminal's background when `"auto"`. */
export function resolveMode(config: ThemeConfig | undefined, themeBg: ThemeMode): ThemeMode {
  const m = config?.mode ?? "dark";
  return m === "auto" ? themeBg : m;
}

/** The effective background strategy, defaulting to `"themed"` when unset. */
export function resolveBackground(config: ThemeConfig | undefined): ThemeBackground {
  return config?.background ?? "themed";
}

/** Sentinel background value meaning "let the terminal's own background show through". */
export const TERMINAL_BG = "transparent";

const [themedMixBase, setThemedMixBaseSignal] = createSignal(FAMILY_DARK.bg);

/**
 * Sets the color {@link mixHex} substitutes for {@link TERMINAL_BG} when mixing.
 *
 * @remarks `TERMINAL_BG` is not an actual color `mixHex` can blend against, so
 * callers that resolve tokens for a `"terminal"` background must supply a
 * stand-in base (the resolved `bg` token) before any tint/gutter color is computed.
 */
export function setThemedMixBase(hex: string): void {
  setThemedMixBaseSignal(hex);
}

/** Resolves every base and subagent token for `config` at `mode`, nudging subagent colors to AA contrast against `bg`. */
export function resolveTokens(config: ThemeConfig | undefined, mode: ThemeMode): ResolvedTokens {
  const preset = config?.preset ?? "family";
  const ov = config?.overrides?.[mode];
  const out = {} as ResolvedTokens;
  for (const token of TOKEN_ORDER) {
    const o = ov?.[token];
    out[token] = o ?? presetLayer(preset, mode)[token] ?? FAMILY[mode][token];
  }
  const ramp = SUBAGENT_RAMP[preset][mode];
  const subagent = SUBAGENT_ORDER.map((name, i) => nudgeToAA(ov?.[name] ?? ramp[i]!, out.bg));
  for (let i = 0; i < SUBAGENT_ORDER.length; i++) out[SUBAGENT_ORDER[i]!] = subagent[i]!;
  out.subagent = subagent;
  return out;
}

/**
 * Linearly blends `tint` into `base` by `amount` (0 = pure `base`, 1 = pure `tint`).
 *
 * @remarks If `base` is {@link TERMINAL_BG}, the blend uses {@link setThemedMixBase}'s
 * value instead, since `TERMINAL_BG` itself is not a color. Returns `base`
 * unchanged if either color fails to parse.
 */
export function mixHex(base: string, tint: string, amount: number): string {
  const b = parseColor(base === TERMINAL_BG ? themedMixBase() : base);
  const t = parseColor(tint);
  if (!b || !t) return base;
  return rgbaToHex({
    r: b.r + (t.r - b.r) * amount,
    g: b.g + (t.g - b.g) * amount,
    b: b.b + (t.b - b.b) * amount,
  });
}

/** Terminal ANSI-16 palette used by {@link quantize}. */
const ANSI16: { name: string; rgb: RGBA }[] = [
  { name: "black", rgb: { r: 0, g: 0, b: 0 } },
  { name: "red", rgb: { r: 205, g: 49, b: 49 } },
  { name: "green", rgb: { r: 13, g: 188, b: 121 } },
  { name: "yellow", rgb: { r: 229, g: 229, b: 16 } },
  { name: "blue", rgb: { r: 36, g: 114, b: 200 } },
  { name: "magenta", rgb: { r: 188, g: 63, b: 188 } },
  { name: "cyan", rgb: { r: 17, g: 168, b: 205 } },
  { name: "white", rgb: { r: 229, g: 229, b: 229 } },
  { name: "brightBlack", rgb: { r: 102, g: 102, b: 102 } },
  { name: "brightRed", rgb: { r: 241, g: 76, b: 76 } },
  { name: "brightGreen", rgb: { r: 35, g: 209, b: 139 } },
  { name: "brightYellow", rgb: { r: 245, g: 245, b: 67 } },
  { name: "brightBlue", rgb: { r: 59, g: 142, b: 234 } },
  { name: "brightMagenta", rgb: { r: 214, g: 112, b: 214 } },
  { name: "brightCyan", rgb: { r: 41, g: 184, b: 219 } },
  { name: "brightWhite", rgb: { r: 255, g: 255, b: 255 } },
];

function dist2(a: RGBA, b: RGBA): number {
  return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
}

function nearest16(c: RGBA): { idx: number; name: string; rgb: RGBA } {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < ANSI16.length; i++) {
    const d = dist2(c, ANSI16[i]!.rgb);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { idx: best, name: ANSI16[best]!.name, rgb: ANSI16[best]!.rgb };
}

function xterm256Levels(v: number): number {
  const levels = [0, 95, 135, 175, 215, 255];
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < levels.length; i++) {
    const d = Math.abs(levels[i]! - v);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function nearest256(c: RGBA): { idx: number; rgb: RGBA } {
  const ri = xterm256Levels(c.r);
  const gi = xterm256Levels(c.g);
  const bi = xterm256Levels(c.b);
  const levels = [0, 95, 135, 175, 215, 255];
  const cubeRgb: RGBA = { r: levels[ri]!, g: levels[gi]!, b: levels[bi]! };
  const cubeIdx = 16 + 36 * ri + 6 * gi + bi;
  const grey = Math.round((c.r + c.g + c.b) / 3);
  const gLevel = Math.max(0, Math.min(23, Math.round((grey - 8) / 10)));
  const gVal = 8 + gLevel * 10;
  const greyRgb: RGBA = { r: gVal, g: gVal, b: gVal };
  const greyIdx = 232 + gLevel;
  return dist2(c, greyRgb) < dist2(c, cubeRgb)
    ? { idx: greyIdx, rgb: greyRgb }
    : { idx: cubeIdx, rgb: cubeRgb };
}

/** A color snapped to a terminal color depth, with a label describing the snapped value. */
export interface QuantizedSwatch {
  hex: string;
  label: string;
}

/** Snaps `input` to the nearest representable color at `depth` (truecolor/256/16/mono). */
export function quantize(input: RGBA, depth: ColorDepth): QuantizedSwatch {
  if (depth === "truecolor") return { hex: rgbaToHex(input), label: "truecolor" };
  if (depth === "mono") {
    const grey = Math.round(0.299 * input.r + 0.587 * input.g + 0.114 * input.b);
    const on = grey >= 128;
    return { hex: on ? "#ffffff" : "#000000", label: on ? "on" : "off" };
  }
  if (depth === "16") {
    const n = nearest16(input);
    return { hex: rgbaToHex(n.rgb), label: n.name };
  }
  const n = nearest256(input);
  return { hex: rgbaToHex(n.rgb), label: `idx ${n.idx}` };
}
