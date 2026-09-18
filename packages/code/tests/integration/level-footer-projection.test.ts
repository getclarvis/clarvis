import { expect, test } from "bun:test";
import { openCoreRenderer } from "../helpers/tracked-core-render.ts";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { registerUiActionFields, uiCommand } from "../../src/keys/actions.ts";
import { detailCloseActions, detailStatusColor } from "../../src/ui/patterns/detail-view.tsx";
import { tokens } from "../../src/theme/tokens.ts";
import { LAYER, registerLevel, verb } from "../../src/ui/patterns/level-keys.ts";
import { budgetFooterActions, projectActiveActions } from "../../src/ui/patterns/active-actions.ts";

process.setMaxListeners(50);

test("detail lifecycle colors consistently group success, failure, attention and idle states", () => {
  expect(detailStatusColor("running")).toBe(tokens.add);
  expect(detailStatusColor("completed")).toBe(tokens.add);
  expect(detailStatusColor("failed")).toBe(tokens.del);
  expect(detailStatusColor("canceled")).toBe(tokens.del);
  expect(detailStatusColor("needs-approval")).toBe(tokens.warn);
  expect(detailStatusColor("attention")).toBe(tokens.warn);
  expect(detailStatusColor("paused")).toBe(tokens.muted);
  expect(detailStatusColor("waiting")).toBe(tokens.muted);
});

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

for (const key of ["ctrl+p", "ctrl+o", "ctrl+w"]) {
  test(`detail footer groups Escape and ${key} as one essential close action`, async () => {
    const t = await openCoreRenderer({ width: 80, height: 24 });
    const keymap = createDefaultOpenTuiKeymap(t.renderer);
    const offFields = registerUiActionFields(keymap);
    const offLevel = registerLevel(
      keymap,
      detailCloseActions(key, () => {}),
    );
    try {
      const actions = projectActiveActions(
        keymap.getActiveKeys({ includeBindings: true, includeMetadata: true }),
      );
      const close = actions.find((action) => action.footerLabel === "close")!;
      expect(close.keys).toEqual(["esc", "Ctrl+" + key.slice(5).toUpperCase()]);
      expect(close.hintGroup).toBe("escape");
      expect(close.essential).toBe(true);
      expect(budgetFooterActions(actions, 40)).toContain(close);
      expect(actions.filter((action) => action.footerLabel === "close")).toHaveLength(1);
    } finally {
      offLevel();
      offFields();
      t.renderer.destroy();
    }
  });
}

test("nested workflow footer separates back from close without changing the close identity", async () => {
  const t = await openCoreRenderer({ width: 80, height: 24 });
  const keymap = createDefaultOpenTuiKeymap(t.renderer);
  const offFields = registerUiActionFields(keymap);
  const offLevel = registerLevel(
    keymap,
    detailCloseActions(
      "ctrl+w",
      () => {},
      () => {},
    ),
  );
  try {
    const actions = projectActiveActions(
      keymap.getActiveKeys({ includeBindings: true, includeMetadata: true }),
    );
    expect(actions.find((action) => action.footerLabel === "close")?.keys).toEqual(["Ctrl+W"]);
    expect(actions.find((action) => action.footerLabel === "back")?.keys).toEqual(["esc"]);
    expect(budgetFooterActions(actions, 40).map((action) => action.footerLabel)).toEqual([
      "back",
      "close",
    ]);
  } finally {
    offLevel();
    offFields();
    t.renderer.destroy();
  }
});
