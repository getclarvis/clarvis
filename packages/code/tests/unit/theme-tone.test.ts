import { afterEach, expect, test } from "bun:test";
import { tone } from "../../src/theme/tone.ts";
import { tokens } from "../../src/theme/tokens.ts";
import { applyAsciiMode, glyph } from "../../src/theme/glyphs.ts";

afterEach(() => applyAsciiMode(false));

test("tone maps every semantic state to its glyph + token color", () => {
  applyAsciiMode(false);
  expect(tone("ok")).toEqual({ glyph: "✓", fg: tokens.add });
  expect(tone("warn")).toEqual({ glyph: "⚠", fg: tokens.warn });
  expect(tone("error")).toEqual({ glyph: "✗", fg: tokens.del });
  expect(tone("pending")).toEqual({ glyph: "○", fg: tokens.muted });
  expect(tone("muted")).toEqual({ glyph: "ⓘ", fg: tokens.muted });
});

test("tone glyphs follow the ascii toggle like every other glyph", () => {
  applyAsciiMode(true);
  expect(tone("ok").glyph).toBe(glyph("success"));
  expect(tone("ok").glyph).toBe("[ok]");
  expect(tone("error").glyph).toBe("[x]");
});

test("running composes the caller's spinner frame with the accent color", () => {
  expect(tone("running", "⠋")).toEqual({ glyph: "⠋", fg: tokens.accent });
  expect(tone("running", "|").glyph).toBe("|");
});
