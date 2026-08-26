import { expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { useArmedConfirm, type ArmedConfirm } from "../../src/views/confirm.ts";
import { LAYER } from "../../src/ui/patterns/level-keys.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

function fakeKeymap(): {
  keymap: Keymap<Renderable, KeyEvent>;
  press: (this: void, key: string) => void;
  layers: { priority?: number }[];
} {
  const { keymap, press, layers } = createFakeKeymap();
  return { keymap, press, layers };
}

function harness(): {
  confirm: ArmedConfirm<string>;
  press: (key: string) => void;
  layers: { priority?: number }[];
  navigated: string[];
  deleted: string[];
  setSel: (v: number) => void;
  dispose: () => void;
} {
  const { keymap, press, layers } = fakeKeymap();
  const navigated: string[] = [];
  const deleted: string[] = [];
  keymap.registerLayer({
    priority: LAYER.OVERLAY,
    bindings: [
      {
        key: "up",
        cmd: () => {
          navigated.push("up");
        },
      },
      {
        key: "down",
        cmd: () => {
          navigated.push("down");
        },
      },
    ],
  });
  let confirm!: ArmedConfirm<string>;
  let setSel!: (v: number) => void;
  const dispose = createRoot((d) => {
    const [sel, ss] = createSignal(0);
    setSel = ss;
    confirm = useArmedConfirm<string>(keymap, {
      message: (target) => `delete '${target}'?`,
      onYes: (target) => {
        deleted.push(target);
      },
      watch: sel,
    });
    return d;
  });
  return { confirm, press, layers, navigated, deleted, setSel, dispose };
}

test("arm exposes the message, y confirms the armed target and disarms", () => {
  const h = harness();
  expect(h.confirm.armed()).toBeNull();
  h.confirm.arm("plan A");
  expect(h.confirm.message()).toBe("delete 'plan A'?");
  expect(h.layers.some((l) => l.priority === LAYER.CONFIRM)).toBe(true);
  h.press("y");
  expect(h.deleted).toEqual(["plan A"]);
  expect(h.confirm.armed()).toBeNull();
  expect(h.layers.some((l) => l.priority === LAYER.CONFIRM)).toBe(false);
  h.dispose();
});

test("n and esc keep the target: nothing runs, the layer is gone", () => {
  const h = harness();
  h.confirm.arm("plan A");
  h.press("n");
  expect(h.deleted).toEqual([]);
  expect(h.confirm.armed()).toBeNull();
  h.confirm.arm("plan A");
  h.press("escape");
  expect(h.deleted).toEqual([]);
  expect(h.confirm.armed()).toBeNull();
  h.dispose();
});

test("navigation is suppressed while armed", () => {
  const h = harness();
  h.press("up");
  expect(h.navigated).toEqual(["up"]);
  h.confirm.arm("plan A");
  h.press("up");
  h.press("down");
  expect(h.navigated).toEqual(["up"]);
  h.dispose();
});

test("a selection change auto-disarms: the armed delete cannot land elsewhere", () => {
  const h = harness();
  h.confirm.arm("plan A");
  h.setSel(1);
  expect(h.confirm.armed()).toBeNull();
  expect(h.layers.some((l) => l.priority === LAYER.CONFIRM)).toBe(false);
  h.press("y");
  expect(h.deleted).toEqual([]);
  h.dispose();
});

test("owner cleanup disarms a live confirm so the layer cannot leak", () => {
  const h = harness();
  h.confirm.arm("plan A");
  h.dispose();
  expect(h.layers.some((l) => l.priority === LAYER.CONFIRM)).toBe(false);
  h.press("y");
  expect(h.deleted).toEqual([]);
});
