import type { JSX } from "solid-js";
import { createMemo, Index, Show } from "solid-js";
import { tokens } from "../theme/tokens.ts";
import { glyph } from "../theme/glyphs.ts";
import { gradientStops, SPLASH_WORDMARK } from "./brand.tsx";

/** ASCII-art wordmark shown on the splash screen at wide terminal widths. */
export const BANNER = [
  " .d8888b.  888                           d8b",
  "d88P  Y88b 888                           Y8P",
  "888    888 888",
  "888        888  8888b.  888d888 888  888 888 .d8888b",
  '888        888     "88b 888P"   888  888 888 88K',
  '888    888 888 .d888888 888     Y88  88P 888 "Y8888b.',
  "Y88b  d88P 888 888  888 888      Y8bd8P  888      X88",
  ' "Y8888P"  888 "Y888888 888       Y88P   888  88888P\'',
];

/** Smallest terminal that can keep the complete banner throughout first-run setup. */
export const FIRST_RUN_SPLASH_MIN_COLUMNS = 76;

/** Smallest terminal that leaves a useful catalog below the complete first-run banner. */
export const FIRST_RUN_SPLASH_MIN_ROWS = 24;

/**
 * Whether first-run setup can keep the complete splash visible without crowding its pickers.
 *
 * @remarks The width accounts for the 85%-wide large floating card and its horizontal chrome. The
 * height leaves room for the eight-row banner, card chrome, a filter and at least three catalog rows.
 * One shared threshold keeps the splash from appearing on Welcome only to disappear at provider or
 * model selection.
 */
export function firstRunSplashFits(width: number, height: number): boolean {
  return width >= FIRST_RUN_SPLASH_MIN_COLUMNS && height >= FIRST_RUN_SPLASH_MIN_ROWS;
}

/** Shared Clarvis banner used by the idle splash and the first-run experience. */
export function BrandBanner(props: { width: () => number }): JSX.Element {
  const stops = createMemo(() =>
    gradientStops(BANNER.length, tokens.accent, tokens.accent2, tokens.bg),
  );
  return (
    <Show
      when={props.width() >= 60}
      fallback={<text fg={tokens.accent}>{glyph("diamond") + SPLASH_WORDMARK}</text>}
    >
      <box flexDirection="column" flexShrink={0}>
        <Index each={BANNER}>
          {(line, i) => (
            <text fg={stops()[i]} wrapMode="none">
              {line()}
            </text>
          )}
        </Index>
      </box>
    </Show>
  );
}

/**
 * The idle-state welcome screen: the gradient {@link BANNER} (or a compact
 * wordmark below 60 columns), the active agent/model and the top-level key
 * hints.
 */
export function Splash(props: {
  agent: () => string;
  model: () => string;
  width: () => number;
  /** Columns to leave free on the right (e.g. a visible sidebar) so the
   * centered banner neither paints under it nor centers off-screen. */
  rightInset?: () => number;
}): JSX.Element {
  return (
    <box
      position="absolute"
      left={0}
      right={props.rightInset?.() ?? 0}
      top={0}
      bottom={0}
      backgroundColor={tokens.bg}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <BrandBanner width={props.width} />
      <box paddingTop={1} flexShrink={0}>
        <text wrapMode="none">
          <span style={{ fg: tokens.muted }}>{"agent: "}</span>
          <span style={{ fg: tokens.fg }}>{props.agent()}</span>
          <span style={{ fg: tokens.muted }}>{" " + glyph("separator") + " model: "}</span>
          <span style={{ fg: tokens.fg }}>{props.model()}</span>
        </text>
      </box>
      <box paddingTop={1} flexShrink={0}>
        <text fg={tokens.muted} wrapMode="none">
          {["Type / for commands", "@ for workspace files", "Shift+Tab for agents"].join(
            " " + glyph("separator") + " ",
          )}
        </text>
      </box>
    </box>
  );
}
