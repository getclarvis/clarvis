import { expect, test } from "bun:test";
import type { ActiveKey } from "@opentui/keymap";
import type { KeyEvent, Renderable } from "@opentui/core";
import {
  actionSegment,
  budgetFooterActions,
  projectActiveActions,
  type ActiveAction,
} from "../../src/ui/patterns/active-actions.ts";

function key(
  command: string,
  display: string,
  patch: Record<string, unknown> = {},
): ActiveKey<Renderable, KeyEvent> {
  return {
    stroke: { name: display, ctrl: false, shift: false, meta: false, super: false },
    display,
    command,
    continues: false,
    commandAttrs: {
      title: command,
      desc: `Run ${command}`,
      category: "Navigation",
      uiSurfaces: ["footer", "full-help"],
      footerLabel: command,
      hintPriority: 10,
      hintGroup: "navigation",
      ...patch,
    },
  };
}

test("active action projection deduplicates alternatives by command identity", () => {
  const actions = projectActiveActions([
    key("list.open", "return", { hintPriority: 100, hintGroup: "primary" }),
    key("list.open", "super+o", { hintPriority: 100, hintGroup: "primary" }),
    key("list.close", "escape", { hintGroup: "escape" }),
  ]);
  expect(actions.map((action) => action.id)).toEqual(["list.open", "list.close"]);
  expect(actions[0]!.keys).toEqual(["↵", "super+o"]);
  expect(actionSegment(actions[0]!)).toBe("[↵/super+o] list.open");
});

test("projection presents Option and Cmd only for an explicit Mac client", () => {
  const source = [key("thing.open", "meta+p"), key("thing.close", "super+w")];
  expect(
    Object.fromEntries(projectActiveActions(source).map((action) => [action.id, action.keys[0]])),
  ).toEqual({
    "thing.open": "alt+p",
    "thing.close": "super+w",
  });
  expect(
    Object.fromEntries(
      projectActiveActions(source, "macos").map((action) => [action.id, action.keys[0]]),
    ),
  ).toEqual({ "thing.open": "opt+p", "thing.close": "cmd+w" });
});

function action(
  id: string,
  priority: number,
  group: ActiveAction["hintGroup"],
  patch: Partial<ActiveAction> = {},
): ActiveAction {
  return {
    id,
    title: id,
    description: id,
    category: "test",
    keys: [id.slice(0, 1)],
    surfaces: ["footer", "full-help"],
    footerLabel: id,
    hintPriority: priority,
    hintGroup: group,
    essential: false,
    ...patch,
  };
}

test("footer budgeting keeps whole segments at width boundaries", () => {
  const actions = [
    action("open", 50, "primary"),
    action("move", 40, "navigation"),
    action("refresh", 30, "mutation"),
    action("close", 20, "escape"),
  ];
  for (const width of [24, 36, 48, 71, 72, 99, 100, 140]) {
    const selected = budgetFooterActions(actions, width);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.map(actionSegment).join("  ").length).toBeLessThanOrEqual(width - 2);
  }
  expect(budgetFooterActions(actions, 22).length).toBeGreaterThan(0);
  expect(budgetFooterActions(actions, 0)).toEqual([]);
});

test("the 24-47 band keeps a primary action when it fits", () => {
  const actions = [
    action("send", 90, "primary", { keys: ["\u21b5"], footerLabel: "send / steer" }),
  ];
  for (let terminalWidth = 24; terminalWidth <= 47; terminalWidth++) {
    const selected = budgetFooterActions(actions, terminalWidth);
    expect(
      selected.map((action) => action.id),
      `width ${terminalWidth}`,
    ).toContain("send");
  }
});

test("a confirmation keeps both of its verbs at every width the footer paints", () => {
  // ViewFrame no longer prints a static [y]/[n] row, so this budget is the only
  // place the pair appears. Seating the two always-active globals by count first
  // dropped confirm.cancel (escape group, printed last) and left a destructive
  // prompt whose only visible "cancel" was run.cancel — which cancels the run.
  const actions = [
    action("confirm.accept", 100, "primary", {
      keys: ["y"],
      footerLabel: "delete",
      essential: true,
    }),
    action("confirm.cancel", 95, "escape", { keys: ["n"], footerLabel: "keep", essential: true }),
    action("run.cancel", 90, "escape", {
      keys: ["^c"],
      footerLabel: "cancel / quit",
      essential: true,
    }),
  ];
  for (const width of [48, 60, 71, 72, 100, 140]) {
    const ids = budgetFooterActions(actions, width).map((a) => a.id);
    expect(ids, `width ${width}`).toContain("confirm.accept");
    expect(ids, `width ${width}`).toContain("confirm.cancel");
  }
});

test("footer budgeting never overflows its width, even when every action is essential", () => {
  // The essentials used to be seated by count alone, before `fits` was consulted,
  // so a wide enough set of them painted past the container's edge.
  const actions = Array.from({ length: 6 }, (_, index) =>
    action(`essential-with-a-long-label-${index}`, 100 - index, "primary", { essential: true }),
  );
  for (const width of [24, 36, 48, 60, 72, 100]) {
    const selected = budgetFooterActions(actions, width);
    expect(selected.map(actionSegment).join("  ").length, `width ${width}`).toBeLessThanOrEqual(
      width - 2,
    );
  }
});
