import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { resolveTokens } from "../../src/theme/model.ts";
import { applyResolvedTokens, tokens } from "../../src/theme/tokens.ts";
import {
  bindSyntaxStyleRenderer,
  pendingSyntaxStyleRetirements,
  syntaxStyle,
} from "../../src/theme/syntax.ts";

test("a superseded native SyntaxStyle survives two real renderer frames, then retires", async () => {
  applyResolvedTokens(resolveTokens(undefined, "dark"));
  const rendered = await openRender(() => <text fg={tokens.fg}>theme generation</text>, {
    width: 30,
    height: 3,
  });
  const release = bindSyntaxStyleRenderer(rendered.renderer);
  try {
    await rendered.renderOnce();
    const old = syntaxStyle();
    applyResolvedTokens(resolveTokens(undefined, "light"));
    expect(syntaxStyle()).not.toBe(old);
    expect(pendingSyntaxStyleRetirements()).toBeGreaterThan(0);

    await rendered.renderOnce();
    expect(() => old.ptr).not.toThrow();
    await rendered.renderOnce();
    expect(() => old.ptr).toThrow();
  } finally {
    release();
    applyResolvedTokens(resolveTokens(undefined, "dark"));
    rendered.renderer.destroy();
  }
});
