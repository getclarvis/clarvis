import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { BrandWordmark, gradientStops, WORDMARK } from "../../src/views/brand.tsx";
import { contrastRatio } from "../../src/theme/contrast.ts";
import { parseColor } from "../../src/theme/model.ts";

test("gradientStops spans from→to and every stop clears AA against the band bg", () => {
  const bg = "#171433";
  const stops = gradientStops(9, "#a5a0f5", "#c4b5fd", bg);
  expect(stops.length).toBe(9);
  const bgc = parseColor(bg);
  for (const stop of stops) {
    const c = parseColor(stop);
    expect(c).toBeTruthy();
    expect(contrastRatio(c!, bgc!)).toBeGreaterThanOrEqual(4.5);
  }
  expect(gradientStops(0, "#000000", "#ffffff", bg)).toEqual([]);
  expect(gradientStops(1, "#a5a0f5", "#c4b5fd", bg).length).toBe(1);
});

test("the wordmark renders its characters", async () => {
  const t = await openRender(() => <BrandWordmark />, { width: 30, height: 3 });
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  expect(out).toContain(WORDMARK);
});
