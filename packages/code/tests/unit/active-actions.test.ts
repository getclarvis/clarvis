import { expect, test } from "bun:test";
import type { ActiveKey } from "@opentui/keymap";
import type { KeyEvent, Renderable } from "@opentui/core";
import {
  actionSegment,
  bandWidthFor,
  footerSpans,
  footerText,
  footerLines,
  budgetFooterActions,
  projectActiveActions,
  retainWinningActions,
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
  expect(actions[0]!.keys).toEqual(["↵", "Super+O"]);
  expect(actionSegment(actions[0]!)).toBe("[↵/Super+O] list.open");
});

test("projection presents Option and Cmd only for an explicit Mac client", () => {
  const source = [key("thing.open", "meta+p"), key("thing.close", "super+w")];
  expect(
    Object.fromEntries(projectActiveActions(source).map((action) => [action.id, action.keys[0]])),
  ).toEqual({
    "thing.open": "Alt+P",
    "thing.close": "Super+W",
  });
  expect(
    Object.fromEntries(
      projectActiveActions(source, "macos").map((action) => [action.id, action.keys[0]]),
    ),
  ).toEqual({ "thing.open": "Option+P", "thing.close": "Cmd+W" });
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
      keys: ["Ctrl+C"],
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

test("footer labels are lowercase without changing help titles", () => {
  const [action] = projectActiveActions([
    key("review.picker", "ctrl+g", { footerLabel: "Guard", uiTitle: "Guard" }),
  ]);
  expect(actionSegment(action!)).toBe("[Ctrl+G] guard");
  expect(action!.title).toBe("Guard");
});

test("block navigation occupies one atomic footer segment and retains actual bindings", () => {
  const actions = projectActiveActions([
    key("transcript.focusPrev", "ctrl+up", { footerLabel: "previous block" }),
    key("transcript.focusNext", "ctrl+down", { footerLabel: "next block" }),
  ]);
  const grouped = budgetFooterActions(actions, 100);
  expect(grouped.map(actionSegment)).toEqual(["[Ctrl+Up / Ctrl+Down] previous / next block"]);
  expect(budgetFooterActions(actions, 20)).toEqual([]);
  expect(
    budgetFooterActions(
      actions.filter((action) => action.id === "transcript.focusNext"),
      100,
    ).map(actionSegment),
  ).toEqual(["[Ctrl+Down] next block"]);
  expect(actions).toHaveLength(2);
});

test("shared footer modifiers preserve full help keys and budget the rendered text", () => {
  const actions = [
    action("send", 100, "primary", { keys: ["↵"], essential: true }),
    action("isolation", 50, "navigation", { keys: ["Ctrl+X I"] }),
    action("memory", 49, "navigation", { keys: ["Ctrl+X M"] }),
    action("cancel", 90, "escape", { keys: ["Ctrl+C"], essential: true }),
  ];
  expect(footerText(actions)).toBe(
    "[↵] send  [Ctrl+C] cancel  │  Ctrl+X: [I] isolation  [M] memory",
  );
  expect(actions[1]!.keys).toEqual(["Ctrl+X I"]);
  expect(actionSegment(actions[1]!)).toBe("[Ctrl+X I] isolation");
  for (let width = 24; width <= 180; width++) {
    expect(Bun.stringWidth(footerText(budgetFooterActions(actions, width)))).toBeLessThanOrEqual(
      width - 2,
    );
  }
});

test("mixed custom alternatives stay explicit outside the modifier group", () => {
  const actions = [
    action("isolation", 50, "navigation", { keys: ["Ctrl+X I", "Alt+I"] }),
    action("guard", 49, "navigation", { keys: ["Ctrl+X G"] }),
    action("memory", 48, "navigation", { keys: ["Ctrl+X M"] }),
  ];
  expect(footerText(actions)).toBe("[Ctrl+X I/Alt+I] isolation  │  Ctrl+X: [G] guard  [M] memory");
  expect(footerText(actions.slice(0, 2))).toBe("[Ctrl+X I/Alt+I] isolation  [Ctrl+X G] guard");
});

test("responsive footer retains every action across rows with explicit modifier prefixes", () => {
  const actions = [
    action("send", 100, "primary", { keys: ["↵"] }),
    action("isolation", 50, "navigation", { keys: ["Ctrl+X I"] }),
    action("guard", 49, "navigation", { keys: ["Ctrl+X G"] }),
    action("memory", 48, "navigation", { keys: ["Ctrl+X M"] }),
    action("cancel", 90, "escape", { keys: ["Ctrl+C"] }),
  ];
  for (const width of [36, 48, 72, 120, 180]) {
    const lines = footerLines(actions, width);
    for (const item of actions) expect(lines.join(" ")).toContain(item.footerLabel);
    for (const line of lines) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width - 2);
      if (/\[[IGM]\]/.test(line)) expect(line).toContain("Ctrl+X:");
    }
  }
  expect(footerLines(actions, 48).length).toBeGreaterThan(1);
});

test("footer spans keep keys apart from labels and name the shared prefix once", () => {
  const actions = [
    action("send", 100, "primary", { keys: ["↵"] }),
    action("isolation", 50, "navigation", { keys: ["Ctrl+X I"] }),
    action("memory", 49, "navigation", { keys: ["Ctrl+X M"] }),
  ];
  expect(footerSpans(actions).map((span) => [span.tone, span.text])).toEqual([
    ["key", "[↵]"],
    ["label", " send"],
    ["separator", "  │  "],
    ["prefix", "Ctrl+X:"],
    ["separator", " "],
    ["key", "[I]"],
    ["label", " isolation"],
    ["separator", "  "],
    ["key", "[M]"],
    ["label", " memory"],
  ]);
  // The plain string remains the measurement and the tests' contract.
  expect(footerText(actions)).toBe("[↵] send  │  Ctrl+X: [I] isolation  [M] memory");
});

test("a band admits the authored short wording before it drops a segment", () => {
  const actions = [
    action("send", 100, "primary", {
      keys: ["↵"],
      footerLabel: "send / steer",
      shortLabel: "send",
      essential: true,
    }),
    action("plan", 55, "navigation", {
      keys: ["Ctrl+X P"],
      footerLabel: "open plan",
      shortLabel: "plan",
    }),
  ];
  // The full row is 37 cells and the shortened row 25, so at a 30-column band only
  // the shortened pair is admissible.
  expect(budgetFooterActions(actions, 30).map(actionSegment)).toEqual([
    "[↵] send",
    "[Ctrl+X P] plan",
  ]);
  expect(
    budgetFooterActions(
      actions.map((entry) => ({ ...entry, shortLabel: undefined })),
      30,
    ).map((entry) => entry.id),
  ).toEqual(["send"]);
  // The projection itself is never mutated by a budget.
  expect(actions[1]!.footerLabel).toBe("open plan");
});

test("the responsive band prefers short wording over a third row", () => {
  const actions = [
    action("workflow", 50, "navigation", {
      keys: ["Ctrl+X W"],
      footerLabel: "open workflow",
      shortLabel: "workflow",
    }),
    action("plan", 55, "navigation", {
      keys: ["Ctrl+X P"],
      footerLabel: "open plan",
      shortLabel: "plan",
    }),
    action("editor", 45, "navigation", {
      keys: ["Ctrl+X E"],
      footerLabel: "expand editor",
      shortLabel: "editor",
    }),
  ];
  const rows = footerLines(actions, 32);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.trim())).toEqual([
    "Ctrl+X: [P] plan  [W] workflow",
    "Ctrl+X: [E] editor",
  ]);
  expect(
    footerLines(
      actions.map((entry) => ({ ...entry, shortLabel: undefined })),
      32,
    ),
  ).toHaveLength(3);
});

test("a command that lost its sequence keeps only the keys the keymap dispatches", () => {
  const global = action("plan.open", 55, "navigation", {
    keys: ["Ctrl+X P"],
    sequences: [["<leader>", "p"]],
  });
  const level = action("ui.level.close", 100, "escape", {
    keys: ["Ctrl+X P"],
    sequences: [["<leader>", "p"]],
    essential: true,
  });
  expect(
    retainWinningActions([global, level], (sequence) =>
      sequence[1] === "p" ? "ui.level.close" : undefined,
    ).map((entry) => entry.id),
  ).toEqual(["ui.level.close"]);

  const custom = action("isolation.picker", 50, "navigation", {
    keys: ["Ctrl+X I", "Alt+I"],
    sequences: [
      ["<leader>", "i"],
      ["alt", "i"],
    ],
  });
  // Every announced key taken: nothing truthful is left to print.
  expect(retainWinningActions([custom], () => "something.else")).toEqual([]);
  // One live alternative keeps the action and drops only the taken key.
  const [kept] = retainWinningActions([custom], (sequence) =>
    sequence[0] === "<leader>" ? "something.else" : undefined,
  );
  expect(kept!.keys).toEqual(["Alt+I"]);
  // A key the keymap cannot resolve is kept: the band narrows what it knows.
  expect(retainWinningActions([custom], () => undefined)[0]!.keys).toEqual(["Ctrl+X I", "Alt+I"]);
});

test("a nested surface converts its usable cells into a band width", () => {
  expect(bandWidthFor(40)).toBe(42);
  expect(bandWidthFor(0)).toBe(2);
  expect(bandWidthFor(-5)).toBe(2);
});

test("a band narrower than one segment seats nothing rather than overflowing", () => {
  // Contractual end of the adaptation sequence, recorded in `specs/known-issues.md`:
  // with no wording left to shorten, a segment that does not fit is dropped — even an
  // essential one — because the row must never paint past its container. Only a
  // container with fewer cells than one whole segment reaches this; the shell's own
  // 24-column floor is not one.
  const essential = [
    action("back", 40, "escape", { keys: ["Ctrl+X B"], footerLabel: "close", essential: true }),
  ];
  expect(budgetFooterActions(essential, bandWidthFor(12))).toEqual([]);
  expect(budgetFooterActions(essential, bandWidthFor(20)).map((entry) => entry.id)).toEqual([
    "back",
  ]);
});

test("a card's row fits its own interior without losing the terminal's seat cap", () => {
  // A 48-column terminal gives a card about 36 usable cells. The card must budget
  // its row against its interior, but its seat cap belongs to the scope, not to the
  // card: passing one width for both dropped the cap from 3 to 2 here and once cost
  // a card its escape route outright (10 seats to 4).
  const actions = [
    action("open", 90, "primary", { keys: ["↵"], essential: true }),
    action("move", 60, "navigation", { keys: ["↑/k"] }),
    action("add", 55, "mutation", { keys: ["a"] }),
    action("delete", 50, "mutation", { keys: ["d"] }),
    action("back", 40, "escape", { keys: ["esc"], essential: true }),
  ];
  const card = budgetFooterActions(actions, bandWidthFor(36), { capWidth: 48 });
  expect(card.map((entry) => entry.id)).toEqual(
    budgetFooterActions(actions, 48).map((entry) => entry.id),
  );
  expect(Bun.stringWidth(footerText(card))).toBeLessThanOrEqual(36);
  // The same card without the terminal's cap keeps one seat fewer.
  expect(budgetFooterActions(actions, bandWidthFor(36)).map((entry) => entry.id)).toHaveLength(2);
});
