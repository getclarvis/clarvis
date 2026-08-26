import { afterEach, expect, test } from "bun:test";
import {
  depthFromCapabilities,
  hslToRgb,
  parseColor,
  quantize,
  resolveBackground,
  resolveMode,
  resolveToken,
  resolveTokens,
  rgbaToHex,
  rgbToHsl,
  setThemedMixBase,
  TERMINAL_BG,
  mixHex,
} from "../../src/theme/model.ts";

afterEach(() => setThemedMixBase(resolveTokens(undefined, "dark").bg));

const family = (token: "accent" | "bg"): string =>
  resolveTokens({ preset: "family" }, "dark")[token];

test("mixHex: blends tint into base by amount, distinct from bgElev, degrades safely", () => {
  expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
  expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
  expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  expect(mixHex("#0f1020", "#a5a0f5", 0.18)).toBe("#2a2a46");
  expect(mixHex("nope", "#ffffff", 0.5)).toBe("nope");
});

test("mixHex: the terminal-bg sentinel blends against the registered themed base", () => {
  expect(mixHex(TERMINAL_BG, "#a5a0f5", 0.18)).toBe(mixHex("#0f1020", "#a5a0f5", 0.18));
  setThemedMixBase("#ffffff");
  expect(mixHex(TERMINAL_BG, "#000000", 0.5)).toBe("#808080");
});

test("resolveBackground: themed unless the config asks for the terminal's own bg", () => {
  expect(resolveBackground(undefined)).toBe("themed");
  expect(resolveBackground({})).toBe("themed");
  expect(resolveBackground({ background: "terminal" })).toBe("terminal");
});

test("parseColor: hex short/long, rgb, hsl; rejects garbage", () => {
  expect(parseColor("#a5a0f5")).toEqual({ r: 165, g: 160, b: 245 });
  expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204 });
  expect(parseColor("a5a0f5")).toEqual({ r: 165, g: 160, b: 245 });
  expect(parseColor("rgb(15, 16, 32)")).toEqual({ r: 15, g: 16, b: 32 });
  expect(parseColor("hsl(0, 0%, 100%)")).toEqual({ r: 255, g: 255, b: 255 });
  expect(parseColor("not a color")).toBeNull();
  expect(parseColor("")).toBeNull();
});

test("hsl round-trip is stable enough", () => {
  const hsl = rgbToHsl({ r: 165, g: 160, b: 245 });
  const back = hslToRgb(hsl.h, hsl.s, hsl.l);
  expect(Math.abs(back.r - 165)).toBeLessThanOrEqual(2);
  expect(Math.abs(back.g - 160)).toBeLessThanOrEqual(2);
  expect(Math.abs(back.b - 245)).toBeLessThanOrEqual(2);
});

test("resolveToken: chain family → preset → global → workspace (workspace wins)", () => {
  expect(resolveToken("accent", "dark", "family", undefined, undefined)).toEqual({
    value: family("accent"),
    source: "family",
  });
  const preset = resolveToken("bg", "dark", "high-contrast", undefined, undefined);
  expect(preset.source).toBe("preset");
  expect(preset.value).toBe("#000000");
  expect(resolveToken("accent", "dark", "family", { accent: "#111111" }, undefined)).toEqual({
    value: "#111111",
    source: "override-global",
  });
  expect(
    resolveToken("accent", "dark", "family", { accent: "#111111" }, { accent: "#222222" }),
  ).toEqual({
    value: "#222222",
    source: "override-workspace",
  });
});

test("resolveTokens: full map for a mode honors overrides", () => {
  const map = resolveTokens(
    { preset: "family", overrides: { dark: { accent: "#abcdef" } } },
    "dark",
  );
  expect(map.accent).toBe("#abcdef");
  expect(map.bg).toBe(family("bg"));
});

test("resolveTokens: the subagent ramp is a per-mode family — array and flat entries agree", () => {
  const dark = resolveTokens({ preset: "family" }, "dark");
  const light = resolveTokens({ preset: "family" }, "light");
  expect(dark.subagent.length).toBe(6);
  expect(dark["subagent-0"]).toBe(dark.subagent[0]!);
  expect(dark["subagent-5"]).toBe(dark.subagent[5]!);
  expect(light.subagent).not.toEqual(dark.subagent);
});

test("resolveTokens: presets and overrides layer onto the subagent ramp like any token", () => {
  const familyRamp = resolveTokens({ preset: "family" }, "dark").subagent;
  const monoRamp = resolveTokens({ preset: "mono" }, "dark").subagent;
  expect(monoRamp).not.toEqual(familyRamp);
  const overridden = resolveTokens(
    { preset: "mono", overrides: { dark: { "subagent-2": "#7dd3fc" } } },
    "dark",
  );
  expect(overridden.subagent[2]).toBe("#7dd3fc");
});

test("resolveMode: auto follows themeBg; explicit wins", () => {
  expect(resolveMode({ mode: "auto" }, "light")).toBe("light");
  expect(resolveMode({ mode: "dark" }, "light")).toBe("dark");
  expect(resolveMode(undefined, "light")).toBe("dark");
});

test("quantize: truecolor passthrough; mono is on/off; 16 names; 256 has an index", () => {
  const white = { r: 255, g: 255, b: 255 };
  expect(quantize(white, "truecolor")).toEqual({ hex: "#ffffff", label: "truecolor" });
  expect(quantize(white, "mono")).toEqual({ hex: "#ffffff", label: "on" });
  expect(quantize({ r: 0, g: 0, b: 0 }, "mono")).toEqual({ hex: "#000000", label: "off" });
  expect(quantize({ r: 240, g: 30, b: 30 }, "16").label).toContain("red");
  expect(quantize(white, "256").label).toMatch(/idx \d+/);
});

test("depthFromCapabilities: NO_COLOR → mono, rgb → truecolor, ansi256 → 256, else 16", () => {
  expect(depthFromCapabilities(true, true, true)).toBe("mono");
  expect(depthFromCapabilities(true, false, false)).toBe("truecolor");
  expect(depthFromCapabilities(false, true, false)).toBe("256");
  expect(depthFromCapabilities(false, false, false)).toBe("16");
});

test("rgbaToHex clamps and pads", () => {
  expect(rgbaToHex({ r: 5, g: 0, b: 300 })).toBe("#0500ff");
});
