import { expect, test } from "bun:test";
import { KeyEvent, type CliRenderer } from "@opentui/core";
import { openCoreRenderer } from "../helpers/tracked-core-render.ts";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { registerUiActionFields, uiCommand } from "../../src/keys/actions.ts";
import { LAYER, registerLevel } from "../../src/ui/patterns/level-keys.ts";

process.setMaxListeners(50);

function press(renderer: CliRenderer, name: string): void {
  renderer.keyInput.emit(
    "keypress",
    new KeyEvent({
      name,
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
    } as ConstructorParameters<typeof KeyEvent>[0]),
  );
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

/**
 * A level with one gated verb over a lower layer that binds the same key.
 *
 * @remarks The lower layer stands in for the prompt input and any level beneath
 *   this one — whatever a key reaches when the level above stops claiming it.
 */
async function scenario(when: () => boolean): Promise<{
  renderer: CliRenderer;
  verbRuns: () => number;
  lowerRuns: () => number;
  activeCommands: () => unknown[];
  dispose: () => void;
}> {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const keymap = createDefaultOpenTuiKeymap(t.renderer);
  const offFields = registerUiActionFields(keymap);
  let verbRuns = 0;
  let lowerRuns = 0;
  const offLower = keymap.registerLayer({
    priority: LAYER.INPUT,
    commands: [
      uiCommand({
        id: "beneath.action",
        title: "Beneath",
        description: "An action on a lower layer",
        category: "mutation",
        surfaces: ["footer"],
        run: () => {
          lowerRuns += 1;
        },
      }),
    ],
    bindings: [{ key: "q", cmd: "beneath.action" }],
  });
  const offLevel = registerLevel(keymap, {
    verbs: [
      {
        id: "ui.level.quit",
        key: "q",
        label: "quit",
        when,
        run: () => {
          verbRuns += 1;
        },
      },
    ],
  });
  return {
    renderer: t.renderer,
    verbRuns: () => verbRuns,
    lowerRuns: () => lowerRuns,
    activeCommands: () =>
      keymap
        .getActiveKeys({ includeBindings: true, includeMetadata: true })
        .filter((key) => key.display === "q")
        .map((key) => key.command),
    dispose: () => {
      offLevel();
      offLower();
      offFields();
      t.renderer.destroy();
    },
  };
}

test("a level's gated verb runs and is projected while its `when` holds", async () => {
  const s = await scenario(() => true);
  expect(s.activeCommands()).toEqual(["ui.level.quit"]);
  press(s.renderer, "q");
  await settle();
  expect(s.verbRuns()).toBe(1);
  expect(s.lowerRuns()).toBe(0);
  s.dispose();
});

test("a level's gated verb swallows its key while its `when` is false", async () => {
  // `when` compiles to the command's `enabled` predicate, which makes the
  // *binding* inactive — so without a same-key guard the key falls through to
  // whatever lower layer or focused input claims it. Doctor's `q` on a
  // hard-required gate has to do nothing, not reach the screen underneath.
  const s = await scenario(() => false);
  expect(s.activeCommands()).not.toContain("ui.level.quit");
  expect(s.activeCommands()).not.toContain("beneath.action");
  press(s.renderer, "q");
  await settle();
  expect(s.verbRuns()).toBe(0);
  expect(s.lowerRuns()).toBe(0);
  s.dispose();
});

test("an ungated verb needs no guard and still claims its key", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const keymap = createDefaultOpenTuiKeymap(t.renderer);
  const offFields = registerUiActionFields(keymap);
  let runs = 0;
  const off = registerLevel(keymap, {
    verbs: [{ id: "ui.level.go", key: "g", label: "go", run: () => void (runs += 1) }],
  });
  press(t.renderer, "g");
  await settle();
  expect(runs).toBe(1);
  off();
  offFields();
  t.renderer.destroy();
});
