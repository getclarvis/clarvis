import { expect, test } from "bun:test";
import type { Renderable } from "@opentui/core";
import {
  waitForStableDimensions,
  waitForSyntaxFrame,
} from "../../src/ui/patterns/stable-syntax.tsx";

interface FrameRenderer {
  isDestroyed: boolean;
  off(event: "frame", callback: () => void): void;
  on(event: "frame", callback: () => void): void;
  requestRender(): void;
}

function frameRenderer(afterRender?: () => void): FrameRenderer {
  const listeners = new Set<() => void>();
  return {
    isDestroyed: false,
    off: (_event, callback) => listeners.delete(callback),
    on: (_event, callback) => listeners.add(callback),
    requestRender: () => {
      afterRender?.();
      for (const listener of [...listeners]) listener();
    },
  };
}

function root(dimensions = { width: 80, height: 12 }): Renderable {
  return {
    ...dimensions,
    isDestroyed: false,
    getChildren: () => [],
  } as unknown as Renderable;
}

test("syntax settlement requests and observes consecutive empty frames", async () => {
  await expect(
    waitForSyntaxFrame(root(), () => true, frameRenderer() as never),
  ).resolves.toBeUndefined();
});

test("dimension settlement requires the same positive geometry twice", async () => {
  await expect(
    waitForStableDimensions(root(), () => true, frameRenderer() as never),
  ).resolves.toEqual({ columns: 80, rows: 12 });
});

test("dimension settlement stops when its publication is superseded", async () => {
  let current = true;
  await expect(
    waitForStableDimensions(
      root(),
      () => current,
      frameRenderer(() => {
        current = false;
      }) as never,
    ),
  ).resolves.toBeNull();
});
