import { expect, test } from "bun:test";
import { createSignal, type Setter } from "solid-js";
import { rgbToHex } from "@opentui/core";
import { openRender } from "../helpers/tracked-render.ts";
import { AutocompletePopup } from "../../src/views/input/AutocompletePopup.tsx";
import type { CompleteItem } from "../../src/views/input/autocomplete.ts";
import type { ItemMatch } from "../../src/core/fuzzy.ts";
import { overlayBg, selectionBg } from "../../src/theme/surfaces.ts";
import { tokens } from "../../src/theme/tokens.ts";

const ITEMS: CompleteItem[] = [
  { label: "/clear", detail: "Start a new session", value: "session.clear" },
  { label: "/config", detail: "Choose a settings page", value: "config.open" },
  { label: "/diff", detail: "Open the latest diff", value: "transcript.diff" },
];

test("the popup sizes to content instead of consuming the input width", async () => {
  const t = await openRender(() => <AutocompletePopup label="commands" items={ITEMS} index={0} />, {
    width: 120,
    height: 24,
  });
  await t.renderOnce();
  const rows = t.captureCharFrame().split("\n");
  expect(rows.join("\n")).toContain("/diff");
  const border = rows.find((row) => row.includes("commands"))!;
  expect(border.trimEnd().length).toBeGreaterThanOrEqual(24);
  expect(border.trimEnd().length).toBeLessThan(80);
  t.renderer.destroy();
});

test("cursor selection paints both identity and description inside the content-sized row", async () => {
  const t = await openRender(() => <AutocompletePopup label="commands" items={ITEMS} index={1} />, {
    width: 120,
    height: 24,
  });
  await t.renderOnce();
  const spans = t.captureSpans().lines.flatMap((line) => line.spans);
  const band = selectionBg(overlayBg()).toLowerCase();
  expect(rgbToHex(spans.find((span) => span.text.includes("/config"))!.bg).toLowerCase()).toBe(
    band,
  );
  expect(
    rgbToHex(spans.find((span) => span.text.includes("Choose a settings"))!.bg).toLowerCase(),
  ).toBe(band);
  t.renderer.destroy();
});

test("fuzzy emphasis stays in the field that matched", async () => {
  const items: (CompleteItem & { match?: ItemMatch })[] = [
    {
      label: "/agent",
      detail: "Switch agent",
      value: "agent.picker",
      match: { field: "detail", positions: [0, 1, 2, 3, 4, 5] },
    },
  ];
  const t = await openRender(
    () => <AutocompletePopup label="commands" items={items} index={0} term="switch" />,
    { width: 120, height: 24 },
  );
  await t.renderOnce();
  const spans = t.captureSpans().lines.flatMap((line) => line.spans);
  expect(rgbToHex(spans.find((span) => span.text === "Switch")!.fg).toLowerCase()).toBe(
    tokens.accent.toLowerCase(),
  );
  expect(rgbToHex(spans.find((span) => span.text.includes("/agent"))!.fg).toLowerCase()).not.toBe(
    tokens.accent.toLowerCase(),
  );
  t.renderer.destroy();
});

test("a tall terminal caps suggestions at ten continuous rows without overflow labels", async () => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    label: `/cmd-${index}`,
    detail: `command ${index}`,
    value: `cmd.${index}`,
  }));
  const t = await openRender(() => <AutocompletePopup label="commands" items={many} index={0} />, {
    width: 120,
    height: 45,
  });
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).toContain("/cmd-9");
  expect(out).not.toContain("/cmd-10");
  expect(out).not.toContain("more");
  t.renderer.destroy();
});

test("low height retains an explicit initial focus without adding overflow labels", async () => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    label: `/cmd-${index}`,
    detail: `command ${index}`,
    value: `cmd.${index}`,
  }));
  const t = await openRender(() => <AutocompletePopup label="commands" items={many} index={0} />, {
    width: 120,
    height: 12,
  });
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).toContain("▸ /cmd-0");
  expect(out).not.toContain("more");
  t.renderer.destroy();
});

test("scrolling keeps the popup frame fixed while the visible rows move continuously", async () => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    label: `/cmd-${index}`,
    detail: `command ${index}`,
    value: `cmd.${index}`,
  }));
  let setIndex: Setter<number> | undefined;
  const t = await openRender(
    () => {
      const [index, set] = createSignal(0);
      setIndex = set;
      return <AutocompletePopup label="commands" items={many} index={index()} />;
    },
    { width: 120, height: 24 },
  );
  await t.renderOnce();
  const before = t.captureCharFrame().split("\n");
  const beforeTop = before.findIndex((line) => line.includes("commands"));
  const beforeBottom = before.findIndex((line) => line.includes("╰"));

  setIndex!(20);
  await t.renderOnce();
  const after = t.captureCharFrame().split("\n");
  expect(after.findIndex((line) => line.includes("commands"))).toBe(beforeTop);
  expect(after.findIndex((line) => line.includes("╰"))).toBe(beforeBottom);
  expect(after.join("\n")).not.toContain("more");
  expect(after.join("\n")).toContain("/cmd-20");
  expect(after.join("\n")).not.toContain("/cmd-0 ");
  t.renderer.destroy();
});

test("group labels appear once and mouse activation keeps original item identity", async () => {
  const items: CompleteItem[] = [
    { label: "/clear", detail: "Clear", value: "clear", group: "Actions" },
    { label: "/export", detail: "Export", value: "export", group: "Actions" },
    { label: "Providers", detail: "Configure", value: "providers", group: "Go to" },
  ];
  const picked: number[] = [];
  const confirmed: string[] = [];
  const t = await openRender(
    () => (
      <AutocompletePopup
        label="commands"
        items={items}
        index={0}
        onSelect={(index) => picked.push(index)}
        onConfirm={() => confirmed.push("open")}
      />
    ),
    { width: 80, height: 24 },
  );
  await t.renderOnce();
  const lines = t.captureCharFrame().split("\n");
  expect(lines.filter((line) => line.includes("Actions") && !line.includes("/"))).toHaveLength(1);
  expect(
    lines.filter((line) => line.includes("Go to") && !line.includes("Providers")),
  ).toHaveLength(1);
  const y = lines.findIndex((line) => line.includes("Providers"));
  await t.mockMouse.click(lines[y]!.indexOf("Providers"), y);
  expect(picked).toEqual([2]);
  expect(confirmed).toEqual(["open"]);
  t.renderer.destroy();
});

test("long group labels truncate without overflowing a narrow terminal", async () => {
  const items: CompleteItem[] = [
    { label: "/x", detail: "x", value: "x", group: "A Rather Long Group Label" },
  ];
  const t = await openRender(() => <AutocompletePopup label="commands" items={items} index={0} />, {
    width: 30,
    height: 20,
  });
  await t.renderOnce();
  const lines = t.captureCharFrame().split("\n");
  expect(lines.some((line) => line.includes("A Rather Long Group Label"))).toBe(false);
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(30);
  t.renderer.destroy();
});
