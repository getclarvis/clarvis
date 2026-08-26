import { afterAll, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import {
  focusBg,
  ruleColor,
  scrimColor,
  scrollbarOptions,
  selectionBg,
  userBandBg,
} from "../../src/theme/surfaces.ts";
import { createTheme } from "../../src/theme/theme.ts";
import { applyResolvedTokens, tokens } from "../../src/theme/tokens.ts";
import {
  mixHex,
  parseColor,
  resolveTokens,
  setThemedMixBase,
  TERMINAL_BG,
  type ThemeConfig,
} from "../../src/theme/model.ts";

afterAll(() => {
  applyResolvedTokens(resolveTokens(undefined, "dark"));
  setThemedMixBase(resolveTokens(undefined, "dark").bg);
});

test("surface intents sit on one accent-wash scale: focus == selection, user band one step above", () => {
  applyResolvedTokens(resolveTokens(undefined, "dark"));
  expect(focusBg()).toBe(selectionBg());
  expect(selectionBg()).toBe(mixHex(tokens.bg, tokens.accent, 0.16));
  expect(userBandBg()).toBe(mixHex(tokens.bg, tokens.accent, 0.18));
  expect(userBandBg()).not.toBe(selectionBg());
  expect(ruleColor()).toBe(mixHex(tokens.bg, tokens.muted, 0.55));
});

test("surface intents track a theme swap instead of freezing their first values", () => {
  applyResolvedTokens(resolveTokens(undefined, "dark"));
  const dark = { focus: focusBg(), band: userBandBg(), rule: ruleColor() };
  applyResolvedTokens(resolveTokens(undefined, "light"));
  expect(focusBg()).not.toBe(dark.focus);
  expect(userBandBg()).not.toBe(dark.band);
  expect(ruleColor()).not.toBe(dark.rule);
});

test("terminal background: bg paints transparent while every wash keeps mixing off the themed bg", () => {
  const map = resolveTokens(undefined, "dark");
  setThemedMixBase(map.bg);
  applyResolvedTokens({ ...map, bg: TERMINAL_BG });

  expect(tokens.bg).toBe(TERMINAL_BG);
  expect(selectionBg()).toBe(mixHex(map.bg, map.accent, 0.16));
  expect(userBandBg()).toBe(mixHex(map.bg, map.accent, 0.18));
  expect(ruleColor()).toBe(mixHex(map.bg, map.muted, 0.55));
  expect(scrimColor()).toBe(mixHex(map.bg, "#000000", 0.5));
  const washes = [
    selectionBg(),
    focusBg(),
    userBandBg(),
    ruleColor(),
    scrimColor(),
    scrollbarOptions().trackOptions.backgroundColor,
    scrollbarOptions().trackOptions.foregroundColor,
  ];
  for (const wash of washes) expect(parseColor(wash)).not.toBeNull();
});

test("createTheme wires terminal mode end to end and washes track the themed preset", () => {
  const [cfg, setCfg] = createSignal<ThemeConfig>({ background: "terminal" });
  const dispose = createRoot((d) => {
    createTheme({ themeBg: () => "dark" }, cfg);
    return d;
  });
  expect(tokens.bg).toBe(TERMINAL_BG);
  const familyBand = userBandBg();
  setCfg({ background: "terminal", preset: "mono" });
  expect(tokens.bg).toBe(TERMINAL_BG);
  expect(userBandBg()).not.toBe(familyBand);
  expect(userBandBg()).toBe(
    mixHex(resolveTokens({ preset: "mono" }, "dark").bg, tokens.accent, 0.18),
  );
  setCfg({ preset: "mono" });
  expect(tokens.bg).toBe(resolveTokens({ preset: "mono" }, "dark").bg);
  dispose();
});
