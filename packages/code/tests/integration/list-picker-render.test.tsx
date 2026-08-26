import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { rgbToHex, type ScrollBoxRenderable } from "@opentui/core";
import { createMockMouse } from "@opentui/core/testing";
import { ListPicker } from "../../src/views/overlays/ListPicker.tsx";
import { PickerRow } from "../../src/views/overlays/PickerRow.tsx";
import { overlayBg, selectionBg } from "../../src/theme/surfaces.ts";
import { tokens } from "../../src/theme/tokens.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { registerScrollKeys } from "../../src/ui/patterns/list-navigation.ts";
import { createSignal } from "solid-js";

const fakeKeymap = createFakeKeymap;

interface Fruit {
  name: string;
  note: string;
}

const FRUITS: Fruit[] = [
  { name: "apple", note: "crisp" },
  { name: "banana", note: "soft" },
  { name: "cherry", note: "tart" },
];

async function mount(opts?: {
  filter?: boolean;
  verbs?: Parameters<typeof ListPicker<Fruit>>[0]["verbs"];
  items?: Fruit[];
}) {
  const { keymap, press } = fakeKeymap();
  const confirmed: string[] = [];
  const closed: string[] = [];
  const t = await openRender(
    (() => (
      <ListPicker<Fruit>
        keymap={keymap}
        title="Pick a fruit"
        items={() => opts?.items ?? FRUITS}
        cells={(item, selected) => [
          { grow: true, fg: selected() ? tokens.fg : tokens.muted, text: item.name },
          { width: 8, marginLeft: 2, text: item.note },
        ]}
        onConfirm={(item) => confirmed.push(item.name)}
        onClose={() => closed.push("closed")}
        verbs={opts?.verbs}
        filter={opts?.filter ? { haystack: (item) => item.name } : undefined}
        empty={(term) => ({ text: term ? "no matches" : "no fruit yet" })}
      />
    )) as never,
    { width: 100, height: 24 },
  );
  await t.renderOnce();
  return { t, press, confirmed, closed };
}

test("renders title, cell columns, the selection band on the active row and footer hints", async () => {
  const { t } = await mount();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Pick a fruit");
  expect(frame).toContain("apple");
  expect(frame).toContain("crisp");
  expect(frame).toContain("banana");
  expect(frame).toContain("[↵] select");
  expect(frame).toContain("[esc] cancel");
  const spans = t.captureSpans();
  const band = selectionBg(overlayBg()).toLowerCase();
  const cellOf = (needle: string) =>
    spans.lines.flatMap((l) => l.spans).find((s) => s.text.includes(needle))!;
  expect(rgbToHex(cellOf("apple").bg).toLowerCase()).toBe(band);
  expect(rgbToHex(cellOf("crisp").bg).toLowerCase()).toBe(band);
  expect(rgbToHex(cellOf("banana").bg).toLowerCase()).not.toBe(band);
  t.renderer.destroy();
});

test("up/down and j/k move the selection; enter confirms the selected item", async () => {
  const { t, press, confirmed } = await mount();
  press("down");
  press("j");
  press("k");
  press("return");
  expect(confirmed).toEqual(["banana"]);
  t.renderer.destroy();
});

test("a retained picker keeps one key layer registration and gates it while inactive", async () => {
  const { keymap, press, layers } = fakeKeymap();
  const [active, setActive] = createSignal(true);
  const confirmed: string[] = [];
  const t = await openRender(
    () => (
      <ListPicker<Fruit>
        keymap={keymap}
        active={active}
        title="Retained picker"
        items={() => FRUITS}
        cells={(item) => [{ grow: true, text: item.name }]}
        onConfirm={(item) => confirmed.push(item.name)}
      />
    ),
    { width: 80, height: 20 },
  );
  await t.renderOnce();
  const registered = layers.length;

  setActive(false);
  await t.renderOnce();
  expect(layers).toHaveLength(registered);
  press("return");
  expect(confirmed).toEqual([]);

  setActive(true);
  await t.renderOnce();
  expect(layers).toHaveLength(registered);
  press("return");
  expect(confirmed).toEqual(["apple"]);
  t.renderer.destroy();
});

test("Tab traverses rows inside the picker window", async () => {
  const { t, press, confirmed } = await mount();
  press("tab");
  press("return");
  expect(confirmed).toEqual(["banana"]);
  t.renderer.destroy();
});

test("a window-specific Tab action takes precedence over generic row traversal", async () => {
  const switched: string[] = [];
  const { t, press, confirmed } = await mount({
    verbs: [{ key: "tab", label: "switch pane", run: (item) => switched.push(item.name) }],
  });
  press("tab");
  press("return");
  expect(switched).toEqual(["apple"]);
  expect(confirmed).toEqual(["apple"]);
  t.renderer.destroy();
});

test("Tab pages a document window unless that window owns Tab", () => {
  const first = fakeKeymap();
  const moves: number[] = [];
  const scroll = {
    scrollBy: ({ y }: { x: number; y: number }) => moves.push(y),
  } as unknown as ScrollBoxRenderable;
  const off = registerScrollKeys(first.keymap, () => scroll);
  first.press("tab");
  expect(moves).toEqual([8]);
  off();

  const second = fakeKeymap();
  const offReserved = registerScrollKeys(second.keymap, () => scroll, undefined, ["tab"]);
  second.press("tab");
  expect(moves).toEqual([8]);
  offReserved();
});

test("a PANEL_VERBS verb lands in the footer and runs against the selected item", async () => {
  const deleted: string[] = [];
  const { t, press } = await mount({
    verbs: [{ verb: "delete", run: (item) => deleted.push(item.name) }],
  });
  expect(t.captureCharFrame()).toContain("[d] delete");
  press("down");
  press("d");
  expect(deleted).toEqual(["banana"]);
  t.renderer.destroy();
});

test("typing filters fuzzily, resets the selection and empties into the hint", async () => {
  const { t, press, confirmed } = await mount({ filter: true });
  expect(t.captureCharFrame()).toContain("filter");
  press("down");
  await t.mockInput.typeText("cher");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("cherry");
  expect(frame).not.toContain("apple");
  press("return");
  expect(confirmed).toEqual(["cherry"]);
  await t.mockInput.typeText("zzz");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("no matches");
  t.renderer.destroy();
});

test("an empty list shows the caller's empty state", async () => {
  const { t } = await mount({ items: [] });
  expect(t.captureCharFrame()).toContain("no fruit yet");
  t.renderer.destroy();
});

function cardBounds(frame: string): { height: number } {
  const rows = frame.split("\n");
  const top = rows.findIndex((r) => r.includes("╭"));
  const bottom = rows.findIndex((r) => r.includes("╰"));
  return { height: bottom - top + 1 };
}

test("three items render a three-row card, not a 60%-tall frame", async () => {
  const { t } = await mount();
  expect(cardBounds(t.captureCharFrame()).height).toBe(8);
  t.renderer.destroy();
});

test("a long list caps at the terminal share and scrolls inside it", async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `fruit-${i}`, note: "n" }));
  const { t } = await mount({ items: many });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(cardBounds(frame).height).toBeLessThanOrEqual(19);
  expect(frame).toContain("fruit-0");
  expect(frame).not.toContain("fruit-59");
  t.renderer.destroy();
});

test("a mouse press on a row selects and confirms it", async () => {
  const { t, confirmed } = await mount();
  const lines = t.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => l.includes("cherry"));
  const x = lines[y]!.indexOf("cherry");
  await t.mockMouse.click(x, y);
  expect(confirmed).toEqual(["cherry"]);
  t.renderer.destroy();
});

test("PickerRow: the mouse handler is built in — select then confirm", async () => {
  const log: string[] = [];
  const t = await openRender(
    (() => (
      <box width={40} height={3}>
        <PickerRow selected={true} cells={[{ grow: true, text: "first" }]} />
        <PickerRow
          selected={false}
          cells={[{ grow: true, text: "second" }]}
          onSelect={() => log.push("select")}
          onConfirm={() => log.push("confirm")}
        />
      </box>
    )) as never,
    { width: 40, height: 3 },
  );
  await t.renderOnce();
  const lines = t.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => l.includes("second"));
  await t.mockMouse.click(2, y);
  expect(log).toEqual(["select", "confirm"]);
  t.renderer.destroy();
});

test("a list longer than the card mounts only what it shows, and says what is off-screen", async () => {
  // Every mounted row costs native memory the overlay never gives back, so a
  // picker that mounted its whole catalogue to show a dozen rows leaked an order
  // of magnitude more than it needed to on every open. See
  // known-issues.md#every-floatframe-overlay-leaks-native-memory-per-rendered-row.
  const many: Fruit[] = Array.from({ length: 120 }, (_, i) => ({
    name: `fruit-${String(i).padStart(3, "0")}`,
    note: "n",
  }));
  const { t } = await mount({ items: many });
  const frame = t.captureCharFrame();
  const shown = many.filter((fruit) => frame.includes(fruit.name));
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.length).toBeLessThan(30);
  expect(frame).toContain("more");
  // The window starts at the selection, so the first row is mounted and the
  // last is not.
  expect(frame).toContain("fruit-000");
  expect(frame).not.toContain("fruit-119");
  t.renderer.destroy();
});

test("moving past the window scrolls it, keeping the selected row mounted", async () => {
  const many: Fruit[] = Array.from({ length: 120 }, (_, i) => ({
    name: `fruit-${String(i).padStart(3, "0")}`,
    note: "n",
  }));
  const { t, press } = await mount({ items: many });
  press("end");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("fruit-119");
  expect(frame).not.toContain("fruit-000");
  expect(frame).toContain("more");
  t.renderer.destroy();
});

test("the mouse wheel moves the selection, so windowing costs no mouse parity", async () => {
  // The scroll box owned the wheel before the list was windowed; a windowed list
  // has nothing to scroll, so the wheel drives the selection instead.
  const many: Fruit[] = Array.from({ length: 120 }, (_, i) => ({
    name: `fruit-${String(i).padStart(3, "0")}`,
    note: "n",
  }));
  const { t } = await mount({ items: many });
  const mouse = createMockMouse(t.renderer);
  const rowOf = (needle: string): number =>
    t
      .captureCharFrame()
      .split("\n")
      .findIndex((row) => row.includes(needle));
  const target = rowOf("fruit-002");
  expect(target).toBeGreaterThan(0);

  for (let i = 0; i < 40; i++) await mouse.scroll(20, target, "down");
  await t.renderOnce();
  const scrolled = t.captureCharFrame();
  expect(scrolled).not.toContain("fruit-000");

  for (let i = 0; i < 60; i++) await mouse.scroll(20, target, "up");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("fruit-000");
  t.renderer.destroy();
});
