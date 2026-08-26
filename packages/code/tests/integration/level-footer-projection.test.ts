import { expect, test } from "bun:test";
import { openCoreRenderer } from "../helpers/tracked-core-render.ts";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { registerUiActionFields, uiCommand } from "../../src/keys/actions.ts";
import { LAYER, registerLevel, verb } from "../../src/ui/patterns/level-keys.ts";
import { budgetFooterActions, projectActiveActions } from "../../src/ui/patterns/active-actions.ts";

process.setMaxListeners(50);

/**
 * A panel level exactly as Providers declares one: a nav with an activate, plus
 * `add` and `delete` verbs.
 */
test("a level's verbs reach the footer projection", async () => {
  const t = await openCoreRenderer({ width: 160, height: 45 });
  const keymap = createDefaultOpenTuiKeymap(t.renderer);
  const offFields = registerUiActionFields(keymap);
  const offLevel = registerLevel(keymap, {
    nav: {
      count: () => 3,
      index: () => 0,
      setIndex: () => {},
      activate: { label: "open", run: () => {} },
    },
    verbs: [verb("add", () => {}), verb("delete", () => {})],
  });
  try {
    const actions = projectActiveActions(
      keymap.getActiveKeys({ includeBindings: true, includeMetadata: true }),
    );
    const ids = actions.map((action) => action.id);
    expect(ids).toContain("ui.level.add");
    expect(ids).toContain("ui.level.delete");
    // Both must also survive the footer's own surface filter and width budget:
    // Both the surface filter and the width budget can independently drop a
    // registered action, so this test holds the complete projection path.
    const seated = budgetFooterActions(actions, 160).map((action) => action.id);
    expect(seated).toContain("ui.level.add");
    expect(seated).toContain("ui.level.delete");
  } finally {
    offLevel();
    offFields();
    t.renderer.destroy();
  }
});

test("a lower layer claiming the same letters does not hide the level's verbs", async () => {
  const t = await openCoreRenderer({ width: 160, height: 45 });
  const keymap = createDefaultOpenTuiKeymap(t.renderer);
  const offFields = registerUiActionFields(keymap);
  // Stands in for the prompt input, which binds printable characters beneath
  // every panel. The level is above it and wins dispatch; the question is what
  // the *projection* reports for those keys.
  const offInput = keymap.registerLayer({
    priority: LAYER.INPUT,
    commands: [
      uiCommand({
        id: "input.self-insert",
        title: "Type",
        description: "Insert a character",
        category: "mutation",
        surfaces: [],
        run: () => {},
      }),
    ],
    bindings: [
      { key: "a", cmd: "input.self-insert" },
      { key: "d", cmd: "input.self-insert" },
    ],
  });
  const offLevel = registerLevel(keymap, {
    nav: {
      count: () => 3,
      index: () => 0,
      setIndex: () => {},
      activate: { label: "open", run: () => {} },
    },
    verbs: [verb("add", () => {}), verb("delete", () => {})],
  });
  try {
    const ids = projectActiveActions(
      keymap.getActiveKeys({ includeBindings: true, includeMetadata: true }),
    ).map((action) => action.id);
    expect(ids).toContain("ui.level.add");
    expect(ids).toContain("ui.level.delete");
  } finally {
    offLevel();
    offInput();
    offFields();
    t.renderer.destroy();
  }
});
