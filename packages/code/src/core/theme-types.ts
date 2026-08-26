/**
 * Framework-free theme configuration shapes shared by persistence adapters and UI.
 * Resolution, contrast, and Solid token signals stay in theme/.
 */

/** Resolved color mode. */
export type ThemeMode = "dark" | "light";

/** User-facing theme mode setting; `"auto"` follows the terminal/OS. */
export type ThemeModeConfig = ThemeMode | "auto";

/** Built-in theme preset name. */
export type PresetName = "family" | "high-contrast" | "mono";

/** Terminal color capability band, from richest to none. */
export type ColorDepth = "truecolor" | "256" | "16" | "mono";

/** Whether the terminal's own background shows through or the theme paints one. */
export type ThemeBackground = "themed" | "terminal";

/** Named semantic color slots a theme resolves to concrete colors. */
export type TokenName =
  "accent" | "accent-2" | "bg" | "bg-elev" | "fg" | "muted" | "add" | "warn" | "del";

/** Stable ordering of sub-agent color slots, used to assign colors round-robin. */
export const SUBAGENT_ORDER = [
  "subagent-0",
  "subagent-1",
  "subagent-2",
  "subagent-3",
  "subagent-4",
  "subagent-5",
] as const;

/** One of the fixed sub-agent color slot names. */
export type SubagentName = (typeof SUBAGENT_ORDER)[number];

/** User-authored theme configuration (settings block). */
export interface ThemeConfig {
  mode?: ThemeModeConfig;
  preset?: PresetName;
  background?: ThemeBackground;
  overrides?: Partial<Record<ThemeMode, Partial<Record<TokenName | SubagentName, string>>>>;
}

/** Fully resolved token-to-color map, plus the sub-agent colors as an ordered list. */
export type ResolvedTokens = Record<TokenName | SubagentName, string> & {
  subagent: readonly string[];
};

/** Map terminal capability flags to a color depth band. Pure of UI. */
export function depthFromCapabilities(
  rgb: boolean,
  ansi256: boolean,
  noColor: boolean,
): ColorDepth {
  if (noColor) return "mono";
  if (rgb) return "truecolor";
  if (ansi256) return "256";
  return "16";
}
