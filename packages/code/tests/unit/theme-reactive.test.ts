import { afterAll, expect, test } from "bun:test";
import { applyResolvedTokens, tokens } from "../../src/theme/tokens.ts";
import { resolveTokens } from "../../src/theme/model.ts";
import { diffColorProps, syntaxStyle } from "../../src/theme/syntax.ts";

afterAll(() => applyResolvedTokens(resolveTokens(undefined, "dark")));

test("diffColorProps recomputes when the theme swaps dark → light", () => {
  applyResolvedTokens(resolveTokens(undefined, "dark"));
  expect(diffColorProps().lineNumberFg).toBe("#9195ad");
  expect(diffColorProps().addedSignColor).toBe("#3fb950");
  expect(diffColorProps().fg).toBe("#c7c9d9");

  applyResolvedTokens(resolveTokens(undefined, "light"));
  expect(diffColorProps().lineNumberFg).toBe("#6b6e83");
  expect(diffColorProps().addedSignColor).toBe("#1a7f37");
  expect(diffColorProps().fg).toBe("#25262f");
});

test("diff change-line backgrounds are theme-aware tints (not the fixed dark defaults)", () => {
  applyResolvedTokens(resolveTokens(undefined, "dark"));
  const darkAdd = diffColorProps().addedContentBg;
  const darkDel = diffColorProps().removedContentBg;
  applyResolvedTokens(resolveTokens(undefined, "light"));
  const lightAdd = diffColorProps().addedContentBg;
  const lightDel = diffColorProps().removedContentBg;
  expect(lightAdd).not.toBe(darkAdd);
  expect(lightDel).not.toBe(darkDel);
  expect(lightAdd).toBe("#d7e7de");
  expect(darkAdd).toBe("#172b28");
});

test("syntaxStyle is rebuilt (new instance) on a theme swap", () => {
  applyResolvedTokens(resolveTokens(undefined, "dark"));
  const dark = syntaxStyle();
  applyResolvedTokens(resolveTokens(undefined, "light"));
  const light = syntaxStyle();
  expect(light).not.toBe(dark);
});

test("tokens.subagent follows a theme swap and wraps its spawn-order index", () => {
  const darkResolved = resolveTokens(undefined, "dark");
  applyResolvedTokens(darkResolved);
  expect(tokens.subagent(0)).toBe(darkResolved.subagent[0]!);
  expect(tokens.subagent(6)).toBe(tokens.subagent(0));
  expect(tokens.subagent(-1)).toBe(tokens.subagent(5));

  const lightResolved = resolveTokens(undefined, "light");
  applyResolvedTokens(lightResolved);
  expect(tokens.subagent(0)).toBe(lightResolved.subagent[0]!);
  expect(tokens.subagent(0)).not.toBe(darkResolved.subagent[0]!);
});
