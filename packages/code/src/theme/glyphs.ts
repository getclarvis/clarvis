import { createSignal } from "solid-js";
import {
  GLYPHS,
  applyAsciiMode as applyCoreAsciiMode,
  asciiMode as coreAsciiMode,
  borderChars as coreBorderChars,
  type GlyphForms,
  type GlyphName,
} from "../core/marks.ts";

/** Re-exported from `core/marks` so terminal UI code need not import the core module directly. */
export { GLYPHS, type GlyphForms, type GlyphName };

const [ascii, setAscii] = createSignal(coreAsciiMode());

/**
 * Sets the process-wide ascii mode and mirrors it into a Solid signal.
 *
 * @remarks `core/marks` holds the actual ascii-mode state; this module wraps
 * it in a Solid signal purely so terminal UI reading {@link glyph} or
 * {@link borderChars} re-renders when the mode toggles.
 */
export function applyAsciiMode(on: boolean): void {
  applyCoreAsciiMode(on);
  setAscii(on);
}

/** Whether ascii mode is currently on, as a reactive read. */
export function asciiMode(): boolean {
  return ascii();
}

/** The glyph text for `name` in the current ascii/unicode mode. */
export function glyph(name: GlyphName): string {
  const g = GLYPHS[name];
  return ascii() ? g.ascii : g.unicode;
}

/** The display column width of `name`'s wider form, for layout that must match both modes. */
export function glyphColWidth(name: GlyphName): number {
  const g = GLYPHS[name];
  return Math.max(g.ascii.length, g.unicode.length);
}

/**
 * The border character set for the current ascii/unicode mode.
 *
 * @remarks Reads the ascii Solid signal (rather than `core/marks` directly) so
 * that border-drawing consumers re-render when ascii mode toggles.
 */
export function borderChars(): ReturnType<typeof coreBorderChars> {
  return coreBorderChars(ascii());
}
