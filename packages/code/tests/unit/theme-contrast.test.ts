import { expect, test } from "bun:test";
import {
  auditContrast,
  contrastLevel,
  contrastRatio,
  nudgeToAA,
  relativeLuminance,
} from "../../src/theme/contrast.ts";
import { parseColor, resolveTokens, type ThemeMode } from "../../src/theme/model.ts";
import { SUBAGENT_ORDER } from "../../src/theme/tokens.ts";
import type { PresetName } from "../../src/theme/model.ts";

test("contrastRatio: black/white is 21, identical is 1", () => {
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };
  expect(Math.round(contrastRatio(black, white))).toBe(21);
  expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
});

test("relativeLuminance monotonic (white brighter than black)", () => {
  expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeGreaterThan(
    relativeLuminance({ r: 0, g: 0, b: 0 }),
  );
});

test("contrastLevel thresholds (AAA 7 / AA 4.5 / large 3 / fail)", () => {
  expect(contrastLevel(8)).toBe("AAA");
  expect(contrastLevel(5)).toBe("AA");
  expect(contrastLevel(3.2)).toBe("AA-large");
  expect(contrastLevel(2)).toBe("fail");
});

test("auditContrast: family-dark fg/bg clears AA", () => {
  const resolved = resolveTokens({ preset: "family" }, "dark");
  const results = auditContrast(resolved);
  const fgbg = results.find((r) => r.pair[0] === "fg" && r.pair[1] === "bg")!;
  expect(fgbg.ratio).toBeGreaterThan(4.5);
  expect(fgbg.level === "AA" || fgbg.level === "AAA").toBe(true);
});

test("nudgeToAA: raises a failing pair to at least AA", () => {
  const bg = "#101010";
  const fg = "#3a3a3a";
  const before = contrastRatio(parseColor(fg)!, parseColor(bg)!);
  expect(before).toBeLessThan(4.5);
  const nudged = nudgeToAA(fg, bg);
  const after = contrastRatio(parseColor(nudged)!, parseColor(bg)!);
  expect(after).toBeGreaterThanOrEqual(4.5);
});

test("nudgeToAA: a pair already at AA is left unchanged", () => {
  const unchanged = nudgeToAA("#ffffff", "#000000");
  expect(unchanged).toBe("#ffffff");
});

const PRESETS: PresetName[] = ["family", "high-contrast", "mono"];
const MODES: ThemeMode[] = ["dark", "light"];

test("every subagent ramp entry clears AA-large against its resolved bg, per preset and mode", () => {
  for (const preset of PRESETS) {
    for (const mode of MODES) {
      const resolved = resolveTokens({ preset }, mode);
      const bg = parseColor(resolved.bg)!;
      expect(resolved.subagent.length).toBe(SUBAGENT_ORDER.length);
      for (const entry of resolved.subagent) {
        const c = parseColor(entry)!;
        expect(contrastRatio(c, bg)).toBeGreaterThanOrEqual(3);
      }
    }
  }
});

test("mono preset renders the subagent ramp as grayscale steps (lightness-only differentiation)", () => {
  for (const mode of MODES) {
    const ramp = resolveTokens({ preset: "mono" }, mode).subagent;
    const lightnesses = new Set<number>();
    for (const entry of ramp) {
      const c = parseColor(entry)!;
      expect(c.g).toBe(c.r);
      expect(c.b).toBe(c.r);
      lightnesses.add(c.r);
    }
    expect(lightnesses.size).toBe(ramp.length);
  }
});

test("auditContrast covers what is on screen: warn/del on bg, fg/muted on bg-elev, the subagent family", () => {
  const results = auditContrast(resolveTokens({ preset: "family" }, "dark"));
  const has = (fg: string, bg: string): boolean =>
    results.some((r) => r.pair[0] === fg && r.pair[1] === bg);
  expect(has("warn", "bg")).toBe(true);
  expect(has("del", "bg")).toBe(true);
  expect(has("fg", "bg-elev")).toBe(true);
  expect(has("muted", "bg-elev")).toBe(true);
  expect(has("warn", "bg-elev")).toBe(true);
  expect(has("del", "bg-elev")).toBe(true);
  for (const name of SUBAGENT_ORDER) expect(has(name, "bg")).toBe(true);
});

test("a low-contrast subagent override is applied but nudged back to AA over the resolved bg", () => {
  const resolved = resolveTokens(
    { preset: "family", overrides: { dark: { "subagent-0": "#20222f" } } },
    "dark",
  );
  const bg = parseColor(resolved.bg)!;
  expect(resolved.subagent[0]).not.toBe("#20222f");
  expect(resolved["subagent-0"]).toBe(resolved.subagent[0]!);
  expect(contrastRatio(parseColor(resolved.subagent[0]!)!, bg)).toBeGreaterThanOrEqual(4.5);
  expect(resolved.subagent[1]).toBe(resolveTokens({ preset: "family" }, "dark").subagent[1]!);
});
