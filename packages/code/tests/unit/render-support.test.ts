import { expect, test } from "bun:test";
import { captureUntil } from "../helpers/render-support.ts";

type Rendered = Parameters<typeof captureUntil>[0];

/** A testRender stand-in whose frame changes after `appearAfter` renders. */
function fakeRender(appearAfter: number, needle = "ready"): Rendered {
  let renders = 0;
  return {
    captureCharFrame: () => (renders >= appearAfter ? `frame ${needle}` : "frame pending"),
    renderOnce: async () => {
      renders++;
    },
  } as unknown as Rendered;
}

test("returns the frame once the needle appears", async () => {
  expect(await captureUntil(fakeRender(3), "ready")).toBe("frame ready");
});

test("returns immediately when the needle is already on screen", async () => {
  expect(await captureUntil(fakeRender(0), "ready")).toBe("frame ready");
});

test("throws rather than returning a stale frame when the needle never appears", async () => {
  // The whole point: a wait that quietly expires turns every call with no
  // follow-up assertion into a sleep, so a renamed label goes uncaught.
  await expect(captureUntil(fakeRender(99), "never", 5)).rejects.toThrow(
    /"never" never rendered after 5 frames/,
  );
});

test("the failure carries the last frame so it shows what was on screen", async () => {
  await expect(captureUntil(fakeRender(99), "never", 2)).rejects.toThrow(/frame pending/);
});
