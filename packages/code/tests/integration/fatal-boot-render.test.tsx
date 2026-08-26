import { expect, test } from "bun:test";
import { render } from "@opentui/solid";
import type { KeyEvent } from "@opentui/core";
import { openCoreRenderer } from "../helpers/tracked-core-render.ts";
import { runFatalBoot } from "../../src/views/FatalBoot.tsx";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const press = (renderer: { keyInput: { emit(ev: string, key: KeyEvent): void } }, name: string) =>
  renderer.keyInput.emit("keypress", { name } as KeyEvent);

test("fatal boot: shows the actual error, retries on r until one succeeds, then unmounts", async () => {
  const t = await openCoreRenderer({ width: 90, height: 24 });
  let attempts = 0;
  const settled = runFatalBoot({
    renderer: t.renderer,
    error: new Error("kernel exploded"),
    retry: () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("still down")) : Promise.resolve();
    },
    quit: () => {
      throw new Error("quit must not fire");
    },
  });
  await flush();
  await t.renderOnce();
  let frame = t.captureCharFrame();
  expect(frame).toContain("clarvis failed to start");
  expect(frame).toContain("kernel exploded");
  expect(frame).toContain("[r] retry   [ctrl+c] quit");
  expect(frame).toContain("Doctor lists checks");
  expect(frame.toLowerCase()).not.toContain("settings.json");

  press(t.renderer, "r");
  await flush();
  await t.renderOnce();
  frame = t.captureCharFrame();
  expect(frame).toContain("still down");

  press(t.renderer, "r");
  await settled;
  await t.renderOnce();
  frame = t.captureCharFrame();
  expect(frame).not.toContain("clarvis failed to start");
  expect(attempts).toBe(2);
  t.renderer.destroy();
});

test("fatal boot: only ctrl+c routes to quit; other keys are inert", async () => {
  const t = await openCoreRenderer({ width: 80, height: 20 });
  let quits = 0;
  void runFatalBoot({
    renderer: t.renderer,
    error: new Error("nope"),
    retry: () => Promise.reject(new Error("unreachable")),
    quit: () => {
      quits += 1;
    },
  });
  await flush();
  press(t.renderer, "x");
  await flush();
  expect(quits).toBe(0);
  press(t.renderer, "q");
  await flush();
  expect(quits).toBe(0);
  t.renderer.keyInput.emit("keypress", { name: "c", ctrl: true } as KeyEvent);
  await flush();
  expect(quits).toBe(1);
  t.renderer.destroy();
});

test("fatal boot: disposes its root on success so the App mounts alone (no stacked roots)", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const rootsBefore = t.renderer.listenerCount("destroy");
  const settled = runFatalBoot({
    renderer: t.renderer,
    error: new Error("kernel exploded"),
    retry: () => Promise.resolve(),
    quit: () => {
      throw new Error("quit must not fire");
    },
  });
  await flush();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("clarvis failed to start");

  press(t.renderer, "r");
  await settled;
  await t.renderOnce();

  void render(() => <text>APP_MOUNTED</text>, t.renderer);
  await flush();
  await t.renderOnce();

  const frame = t.captureCharFrame();
  expect(frame).toContain("APP_MOUNTED");
  expect(frame).not.toContain("clarvis failed to start");
  expect(t.renderer.listenerCount("destroy") - rootsBefore).toBe(1);
  t.renderer.destroy();
});
