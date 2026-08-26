import { expect, test } from "bun:test";
import {
  actionSegment,
  budgetFooterActions,
  type ActiveAction,
} from "../../src/ui/patterns/active-actions.ts";

const a = (
  id: string,
  priority: number,
  group: string,
  keys: string[],
  label: string,
  essential = false,
): ActiveAction => ({
  id,
  title: id,
  description: id,
  category: "x",
  keys,
  surfaces: ["footer"],
  footerLabel: label,
  hintPriority: priority,
  hintGroup: group as never,
  essential,
});

/** A hub's action set: a primary, navigation, mutation verbs and back. */
const HUB: ActiveAction[] = [
  a("open", 90, "primary", ["↵"], "open", true),
  a("move", 60, "navigation", ["↑/k"], "move"),
  a("add", 55, "mutation", ["a"], "add"),
  a("delete", 50, "mutation", ["d"], "delete"),
  a("back", 40, "escape", ["esc"], "back", true),
];

test("the seated set never shrinks as the terminal grows", () => {
  // "non-monotonic around 30 columns": a wider terminal must never show less.
  let previous = 0;
  for (let width = 24; width <= 160; width++) {
    const seated = budgetFooterActions(HUB, width);
    expect(seated.length, `width ${width}`).toBeGreaterThanOrEqual(previous);
    expect(seated.map(actionSegment).join("  ").length, `overflow at ${width}`).toBeLessThanOrEqual(
      width - 2,
    );
    previous = seated.length;
  }
});

test("a hub keeps its primary action across the 72-103 span, and its verbs at full width", () => {
  // Settings omitted "open" and navigation across 72-103; Providers and Agents
  // omitted Add/Delete at full width. Both were the container's padding being
  // charged twice — once by the caller, once by `fits`.
  for (const width of [72, 80, 99, 100, 103]) {
    const ids = budgetFooterActions(HUB, width).map((action) => action.id);
    expect(ids, `width ${width}`).toContain("open");
    expect(ids, `width ${width}`).toContain("move");
  }
  const wide = budgetFooterActions(HUB, 120).map((action) => action.id);
  expect(wide).toContain("add");
  expect(wide).toContain("delete");
});

/**
 * The Providers panel's footer candidates.
 */
const PANEL: ActiveAction[] = [
  a("ui.list.activate", 90, "primary", ["↵"], "open", true),
  a("ui.list.previous", 60, "navigation", ["↑/k"], "move"),
  a("view.scope.toggle", 58, "navigation", ["^t"], "scope"),
  a("ui.level.add", 55, "mutation", ["a"], "add"),
  a("ui.level.delete", 50, "mutation", ["d"], "delete"),
  a("view.escape", 40, "escape", ["esc"], "back / close", true),
  a("run.cancel", 35, "escape", ["^c"], "cancel / quit", true),
];

test("a panel keeps its own verbs at full width", () => {
  // Observed at 160 and 200 columns: the footer dropped `add` and `delete` despite ample width.
  // The cap was on segment *count* and stopped climbing at 100, and
  // essentials are seated first regardless of group — so the level's own verbs
  // were the ones that lost, on a terminal with eighty columns to spare.
  for (const width of [130, 132, 139, 160, 200]) {
    const ids = budgetFooterActions(PANEL, width).map((action) => action.id);
    expect(ids, `width ${width}`).toContain("ui.level.add");
    expect(ids, `width ${width}`).toContain("ui.level.delete");
  }
});

test("raising the cap never overflows the row at any width", () => {
  for (let width = 24; width <= 200; width++) {
    const seated = budgetFooterActions(PANEL, width);
    expect(seated.map(actionSegment).join("  ").length, `overflow at ${width}`).toBeLessThanOrEqual(
      width - 2,
    );
  }
});

test("above 100 columns nothing is dropped for any reason but width", () => {
  // The 140 rung was raised to 10 and the 100 rung left at 6, which moved the
  // defect rather than closing it: the panel's nine segments measure 120
  // columns, so from 122 up the row fits them all, and `delete` was still lost
  // at 132 with 29 columns to spare. The rule is not a number - it is that from
  // 100 up, a candidate is absent only when adding it would overflow the row.
  // Below 100 the rungs are a deliberate editorial cap and this does not hold.
  for (let width = 100; width <= 200; width += 1) {
    const seated = budgetFooterActions(PANEL, width);
    const ids = new Set(seated.map((action) => action.id));
    const used = Bun.stringWidth(seated.map(actionSegment).join("  "));

    for (const dropped of PANEL.filter((action) => !ids.has(action.id))) {
      const grown = used + 2 + Bun.stringWidth(actionSegment(dropped));
      expect(grown, `width ${width} could have seated ${dropped.id}`).toBeGreaterThan(width - 2);
    }
  }
});

test("the Providers footer keeps add and delete once the wide band can fit the full row", () => {
  const row = Bun.stringWidth(PANEL.map(actionSegment).join("  "));

  for (let width = Math.max(100, row + 2); width <= 200; width += 1) {
    const ids = budgetFooterActions(PANEL, width).map((action) => action.id);
    expect(ids, `width ${width}`).toContain("ui.level.add");
    expect(ids, `width ${width}`).toContain("ui.level.delete");
  }
});
