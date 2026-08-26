import { glyph } from "./glyphs.ts";
import { tokens } from "./tokens.ts";

/** A semantic status tone used to color and glyph transcript/status rows. */
export type Tone = "ok" | "warn" | "error" | "pending" | "muted" | "running";

/** The glyph and foreground color for one {@link Tone}. */
export interface ToneStyle {
  glyph: string;
  fg: string;
}

/**
 * The {@link ToneStyle} for a given {@link Tone}.
 *
 * @remarks `"running"` requires a caller-supplied spinner character, since it
 * has no static glyph of its own; every other tone takes no second argument.
 */
export function tone(t: Exclude<Tone, "running">): ToneStyle;
export function tone(t: "running", spinnerChar: string): ToneStyle;
export function tone(t: Tone, spinnerChar?: string): ToneStyle {
  switch (t) {
    case "ok":
      return { glyph: glyph("success"), fg: tokens.add };
    case "warn":
      return { glyph: glyph("warning"), fg: tokens.warn };
    case "error":
      return { glyph: glyph("error"), fg: tokens.del };
    case "pending":
      return { glyph: glyph("pending"), fg: tokens.muted };
    case "muted":
      return { glyph: glyph("info"), fg: tokens.muted };
    case "running":
      return { glyph: spinnerChar ?? "", fg: tokens.accent };
  }
}
