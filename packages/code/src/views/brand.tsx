import type { JSX } from "solid-js";
import { createMemo, Index } from "solid-js";
import { tokens } from "../theme/tokens.ts";
import { mixHex } from "../theme/model.ts";
import { nudgeToAA } from "../theme/contrast.ts";
import { glyph } from "../theme/glyphs.ts";

/**
 * `n` colors interpolated linearly from `from` to `to`, each nudged to stay
 * AA-contrast-legible against `bg`.
 */
export function gradientStops(n: number, from: string, to: string, bg: string): string[] {
  if (n <= 0) return [];
  return Array.from({ length: n }, (_, i) =>
    nudgeToAA(mixHex(from, to, n <= 1 ? 0 : i / (n - 1)), bg),
  );
}

/** The wordmark used alongside the diamond glyph in the header row. */
export const WORDMARK = " Clarvis";

/** A shorter wordmark for space-constrained chrome. */
export const MINI_WORDMARK = "Clarvis";

/** The letter-spaced wordmark used on the splash screen. */
export const SPLASH_WORDMARK = "  C L A R V I S";

/** The gradient-colored "◆ Clarvis" wordmark rendered in the header. */
export function BrandWordmark(): JSX.Element {
  const chars = createMemo(() => [...(glyph("diamond") + WORDMARK)]);
  const stops = createMemo(() =>
    gradientStops(chars().length, tokens.accent, tokens.accent2, tokens.bg),
  );
  return (
    <text flexShrink={0} wrapMode="none">
      <b>
        <Index each={chars()}>{(ch, i) => <span style={{ fg: stops()[i] }}>{ch()}</span>}</Index>
      </b>
    </text>
  );
}
