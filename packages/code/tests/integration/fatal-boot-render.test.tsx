import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "@opentui/solid";
import type { KeyEvent } from "@opentui/core";
import { openCoreRenderer } from "../helpers/tracked-core-render.ts";
import { runFatalBoot } from "../../src/views/FatalBoot.tsx";
import {
  installBootRendererLifecycle,
  type BootRendererProcess,
} from "../../src/adapters/renderer-bootstrap.ts";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function keyEvent(name: string, ctrl = false): KeyEvent {
  let defaultPrevented = false;
  let propagationStopped = false;
  return {
    name,
    ctrl,
    get defaultPrevented() {
      return defaultPrevented;
    },
    get propagationStopped() {
      return propagationStopped;
    },
    preventDefault: () => {
      defaultPrevented = true;
    },
    stopPropagation: () => {
      propagationStopped = true;
    },
  } as KeyEvent;
}

const press = (
  renderer: { keyInput: { emit(ev: string, key: KeyEvent): void } },
  name: string,
  ctrl = false,
) => renderer.keyInput.emit("keypress", keyEvent(name, ctrl));

class FakeProcess extends EventEmitter {
  readonly platform = process.platform;
  exit(): never {
    return undefined as never;
  }
}

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
  expect(await settled).toBe(true);
  await t.renderOnce();
  frame = t.captureCharFrame();
  expect(frame).not.toContain("clarvis failed to start");
  expect(attempts).toBe(2);
  t.renderer.destroy();
});

test("fatal boot: renderer teardown is terminal for the surrounding boot", async () => {
  const t = await openCoreRenderer({ width: 80, height: 20 });
  let profilesStarted = 0;
  const boot = async (): Promise<void> => {
    const recovered = await runFatalBoot({
      renderer: t.renderer,
      error: new Error("nope"),
      retry: () => Promise.reject(new Error("unreachable")),
      quit: () => undefined,
    });
    if (!recovered) return;
    profilesStarted += 1;
  };
  const settled = boot();
  await flush();
  t.renderer.destroy();
  await settled;
  expect(profilesStarted).toBe(0);
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
  press(t.renderer, "c", true);
  await flush();
  expect(quits).toBe(1);
  t.renderer.destroy();
});

test("fatal boot owns Ctrl+C ahead of bootstrap teardown and ignores it during retry", async () => {
  const t = await openCoreRenderer({ width: 80, height: 20 });
  const host = new FakeProcess();
  const lifecycle = installBootRendererLifecycle(
    t.renderer,
    host as unknown as BootRendererProcess,
  );
  let platformShutdowns = 0;
  const releaseLifecycle = lifecycle.handoff(() => {
    platformShutdowns += 1;
  });
  let rejectRetry!: (error: Error) => void;
  let quits = 0;
  const settled = runFatalBoot({
    renderer: t.renderer,
    error: new Error("nope"),
    retry: () =>
      new Promise<void>((_resolve, reject) => {
        rejectRetry = reject;
      }),
    quit: () => {
      quits += 1;
    },
  });
  await flush();

  press(t.renderer, "r");
  await flush();
  press(t.renderer, "c", true);
  expect(quits).toBe(0);
  expect(platformShutdowns).toBe(0);

  rejectRetry(new Error("still down"));
  await flush();
  press(t.renderer, "c", true);
  expect(quits).toBe(1);
  expect(platformShutdowns).toBe(0);

  releaseLifecycle();
  t.renderer.destroy();
  await settled;
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
  expect(await settled).toBe(true);
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
