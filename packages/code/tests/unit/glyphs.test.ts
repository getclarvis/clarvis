import { afterEach, expect, test } from "bun:test";
import {
  applyAsciiMode,
  asciiMode,
  borderChars,
  glyph,
  glyphColWidth,
  GLYPHS,
} from "../../src/theme/glyphs.ts";

afterEach(() => applyAsciiMode(false));

test("glyph returns the unicode form when ascii mode is off", () => {
  applyAsciiMode(false);
  expect(asciiMode()).toBe(false);
  expect(glyph("success")).toBe("✓");
  expect(glyph("error")).toBe("✗");
  expect(glyph("chevronRight")).toBe("▸");
  expect(glyph("separator")).toBe("·");
  expect(glyph("emDash")).toBe("—");
  expect(glyph("ellipsis")).toBe("…");
  expect(glyph("arrowRight")).toBe("→");
  expect(glyph("diamond")).toBe("◆");
});

test("glyph returns the ascii form when ascii mode is on", () => {
  applyAsciiMode(true);
  expect(asciiMode()).toBe(true);
  expect(glyph("success")).toBe("[ok]");
  expect(glyph("error")).toBe("[x]");
  expect(glyph("chevronRight")).toBe(">");
  expect(glyph("separator")).toBe(".");
  expect(glyph("emDash")).toBe("--");
  expect(glyph("ellipsis")).toBe("...");
  expect(glyph("arrowRight")).toBe("->");
  expect(glyph("diamond")).toBe("#");
});

test("every registry entry has a unicode form and a pure-ascii form", () => {
  for (const [name, forms] of Object.entries(GLYPHS)) {
    expect(forms.unicode.length, `${name}.unicode`).toBeGreaterThan(0);
    expect(forms.ascii.length, `${name}.ascii`).toBeGreaterThan(0);
    for (const ch of forms.ascii) {
      expect(ch.codePointAt(0)!, `${name}.ascii '${ch}'`).toBeLessThanOrEqual(0x7f);
    }
  }
});

test("glyphColWidth returns the widest of the ascii and unicode forms, regardless of mode", () => {
  expect(glyphColWidth("success")).toBe(4);
  expect(glyphColWidth("chevronRight")).toBe(1);
  applyAsciiMode(true);
  expect(glyphColWidth("success")).toBe(4);
});

test("borderChars is undefined in unicode mode and ascii box chars in ascii mode", () => {
  applyAsciiMode(false);
  expect(borderChars()).toBeUndefined();
  applyAsciiMode(true);
  const b = borderChars();
  expect(b).toBeDefined();
  expect(b!.horizontal).toBe("-");
  expect(b!.vertical).toBe("|");
  expect(b!.topLeft).toBe("+");
});
