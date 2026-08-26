import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { createTestKeymap } from "@opentui/keymap/testing";
import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { registerListNav } from "../../src/ui/patterns/list-navigation.ts";

type TestKeymap = Keymap<Renderable, KeyEvent>;

interface Registered {
  name: string;
  enabled?: () => boolean;
}

/** Reads the activate command's own `enabled` predicate off the keymap. */
function activateGate(keymap: TestKeymap): (() => boolean) | undefined {
  const commands = (keymap as unknown as { getCommands(o: unknown): Registered[] }).getCommands({
    visibility: "registered",
  });
  return commands.find((command) => command.name === "ui.list.activate")?.enabled;
}

test("an empty list does not advertise its primary action", () => {
  // The Tasks hub with no provider configured offered `[↵] details` and did
  // nothing on Enter — invariant 8, "no silent no-op is advertised".
  const keymap = createTestKeymap({ defaultKeys: true }).keymap as unknown as TestKeymap;
  const [count, setCount] = createSignal(0);
  const off = registerListNav(keymap, {
    count,
    index: () => 0,
    setIndex: () => {},
    activate: { label: "details", run: () => {} },
  });
  const gate = activateGate(keymap);
  expect(gate).toBeDefined();
  expect(gate!()).toBe(false);
  setCount(3);
  expect(gate!()).toBe(true);
  off();
});

test("`when` narrows the gate further for a list whose rows are not all actionable", () => {
  const keymap = createTestKeymap({ defaultKeys: true }).keymap as unknown as TestKeymap;
  const [actionable, setActionable] = createSignal(false);
  const off = registerListNav(keymap, {
    count: () => 5,
    index: () => 0,
    setIndex: () => {},
    activate: { label: "open", run: () => {}, when: actionable },
  });
  const gate = activateGate(keymap)!;
  expect(gate()).toBe(false);
  setActionable(true);
  expect(gate()).toBe(true);
  off();
});
