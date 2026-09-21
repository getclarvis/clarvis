import { expect, test } from "bun:test";
import { createTestKeymap } from "@opentui/keymap/testing";
import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { liveSequenceOwners, sequenceKey } from "../../src/keys/sequence-owner.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

type OpenTuiKeymap = Keymap<Renderable, KeyEvent>;

function ownersOf(keymap: Keymap<object, never> | unknown): [string, string][] {
  return [...liveSequenceOwners(keymap as unknown as OpenTuiKeymap)];
}

test("a sequence has one canonical map key", () => {
  expect(sequenceKey(["ctrl+x", "p"])).toBe("ctrl+x p");
  expect(sequenceKey([])).toBe("");
});

test("the highest active layer owns the sequence two commands announce", () => {
  const harness = createTestKeymap({ defaultKeys: true });
  harness.keymap.registerLayer({
    priority: 900,
    commands: [{ name: "plan.open", run() {} }],
    bindings: [{ key: "ctrl+x p", cmd: "plan.open" }],
  });
  const offLevel = harness.keymap.registerLayer({
    priority: 950,
    commands: [{ name: "ui.level.close", run() {} }],
    bindings: [{ key: "ctrl+x p", cmd: "ui.level.close" }],
  });
  expect(ownersOf(harness.keymap)).toEqual([[sequenceKey(["ctrl+x", "p"]), "ui.level.close"]]);

  offLevel();
  expect(ownersOf(harness.keymap)).toEqual([[sequenceKey(["ctrl+x", "p"]), "plan.open"]]);
  harness.cleanup();
});

test("a shorter exact binding keeps its own sequence without taking the deeper one", () => {
  // The keymap resolves `ctrl+x` and `ctrl+x p` as two live sequences, so both
  // owners are reported. Recording it here keeps the footer's projection honest
  // about what the layer graph says: it narrows a sequence, it does not invent a
  // winner the keymap never chose.
  const harness = createTestKeymap({ defaultKeys: true });
  harness.keymap.registerLayer({
    priority: 900,
    commands: [{ name: "plan.open", run() {} }],
    bindings: [{ key: "ctrl+x p", cmd: "plan.open" }],
  });
  harness.keymap.registerLayer({
    priority: 950,
    commands: [{ name: "taken", run() {} }],
    bindings: [{ key: "ctrl+x", cmd: "taken" }],
  });
  expect(ownersOf(harness.keymap)).toEqual([
    [sequenceKey(["ctrl+x"]), "taken"],
    [sequenceKey(["ctrl+x", "p"]), "plan.open"],
  ]);
  harness.cleanup();
});

test("a binding that carries its own handler owns no command name", () => {
  const harness = createTestKeymap({ defaultKeys: true });
  harness.keymap.registerLayer({
    priority: 950,
    bindings: [{ key: "ctrl+x p", cmd: () => {} }],
  });
  expect(ownersOf(harness.keymap)).toEqual([]);
  harness.cleanup();
});

test("a keymap double without a layer graph owns nothing, so no announced key is hidden", () => {
  const { keymap } = createFakeKeymap();
  expect(liveSequenceOwners(keymap).size).toBe(0);
});
