import { expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { bindLevelKeys, type FieldEditState } from "../../src/views/config/view-host.tsx";

function harness(): {
  log: string[];
  enabled: () => boolean;
  setDepth: (v: number) => void;
  setEditing: (v: FieldEditState | null) => void;
  dispose: () => void;
} {
  const log: string[] = [];
  let setDepth!: (v: number) => void;
  let setEditing!: (v: FieldEditState | null) => void;
  let layerEnabled = (): boolean => false;
  const dispose = createRoot((d) => {
    const [depth, sd] = createSignal(0);
    const [editing, se] = createSignal<FieldEditState | null>(null);
    setDepth = sd;
    setEditing = se;
    bindLevelKeys({
      editor: { editing },
      register: (enabled) => {
        layerEnabled = enabled;
        const dp = depth();
        log.push(`on:${dp}`);
        return () => log.push(`off:${dp}`);
      },
    });
    return d;
  });
  return { log, enabled: () => layerEnabled(), setDepth, setEditing, dispose };
}

test("bindLevelKeys: registers for the current level and re-registers when it changes", () => {
  const h = harness();
  expect(h.log).toEqual(["on:0"]);
  h.setDepth(1);
  expect(h.log).toEqual(["on:0", "off:0", "on:1"]);
  h.dispose();
});

test("bindLevelKeys: an open field editor gates the stable band without re-registering", () => {
  const h = harness();
  h.setEditing({ mode: "text", label: "x", current: "" });
  expect(h.log).toEqual(["on:0"]);
  expect(h.enabled()).toBe(false);
  h.setEditing(null);
  expect(h.log).toEqual(["on:0"]);
  expect(h.enabled()).toBe(true);
  h.dispose();
});

test("bindLevelKeys: disposing the owner unregisters the live layer", () => {
  const h = harness();
  h.dispose();
  expect(h.log).toEqual(["on:0", "off:0"]);
});

test("bindLevelKeys: suspend gates the stable band and structural changes still re-register", () => {
  const log: string[] = [];
  let setDepth!: (v: number) => void;
  let setSuspend!: (v: boolean) => void;
  let enabled = (): boolean => false;
  const dispose = createRoot((d) => {
    const [depth, sd] = createSignal(0);
    const [susp, ss] = createSignal(false);
    setDepth = sd;
    setSuspend = ss;
    bindLevelKeys({
      suspend: susp,
      register: (active) => {
        enabled = active;
        const dp = depth();
        log.push(`on:${dp}`);
        return () => log.push(`off:${dp}`);
      },
    });
    return d;
  });
  expect(log).toEqual(["on:0"]);
  setSuspend(true);
  expect(log).toEqual(["on:0"]);
  expect(enabled()).toBe(false);
  setDepth(1);
  expect(log).toEqual(["on:0", "off:0", "on:1"]);
  expect(enabled()).toBe(false);
  setSuspend(false);
  expect(log).toEqual(["on:0", "off:0", "on:1"]);
  expect(enabled()).toBe(true);
  dispose();
});

test("bindLevelKeys: host activation gates one registration", () => {
  const log: string[] = [];
  let setActive!: (value: boolean) => void;
  let enabled = (): boolean => false;
  const dispose = createRoot((destroy) => {
    const [active, updateActive] = createSignal(true);
    setActive = updateActive;
    bindLevelKeys({
      host: { active, pendingConfirm: () => null },
      register: (gate) => {
        enabled = gate;
        log.push("on");
        return () => log.push("off");
      },
    });
    return destroy;
  });

  expect(enabled()).toBe(true);
  setActive(false);
  expect(enabled()).toBe(false);
  setActive(true);
  expect(enabled()).toBe(true);
  expect(log).toEqual(["on"]);
  dispose();
  expect(log).toEqual(["on", "off"]);
});
