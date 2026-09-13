import { expect, test } from "bun:test";
import { captureUntil, flush, until } from "../helpers/render-support.ts";
import { disposeRender } from "../helpers/tracked-render.ts";

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

test("flush renders after one event-loop turn", async () => {
  expect(await flush(fakeRender(1))).toBe("frame ready");
});

test("until accepts an arbitrary observable predicate", async () => {
  expect(await until(fakeRender(2), (frame) => frame === "frame ready", "frame")).toBe(
    "frame ready",
  );
});

test("returns immediately when the needle is already on screen", async () => {
  expect(await captureUntil(fakeRender(0), "ready")).toBe("frame ready");
});

test("throws rather than returning a stale frame when the needle never appears", async () => {
  // The whole point: a wait that quietly expires turns every call with no
  // follow-up assertion into a sleep, so a renamed label goes uncaught.
  await expect(captureUntil(fakeRender(99), "never", 5)).rejects.toThrow(
    /render until "never" timed out after 5 turns/,
  );
});

test("the failure carries the last frame so it shows what was on screen", async () => {
  await expect(captureUntil(fakeRender(99), "never", 2)).rejects.toThrow(/frame pending/);
});

test("disposeRender destroys the renderer and yields once for teardown", async () => {
  let destroyed = 0;
  await disposeRender({
    renderer: {
      isDestroyed: false,
      destroy: () => {
        destroyed += 1;
      },
    },
  } as never);
  expect(destroyed).toBe(1);
});
