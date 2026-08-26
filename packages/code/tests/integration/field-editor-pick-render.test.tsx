import { expect, test } from "bun:test";
import { Show } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import { rgbToHex } from "@opentui/core";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createFieldEditor, type FieldEditor } from "../../src/views/config/view-host.tsx";
import { overlayBg, selectionBg } from "../../src/theme/surfaces.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const fakeKeymap = createFakeKeymap;

async function mountEditor() {
  const { keymap, press } = fakeKeymap();
  let fe!: FieldEditor;
  const t = await openRender(
    (() => {
      fe = createFieldEditor({ keymap } as unknown as Interaction);
      return (
        <>
          <Show when={fe.editing()}>{fe.EditInput()}</Show>
          {fe.PickerInput()}
        </>
      );
    }) as never,
    { width: 90, height: 30 },
  );
  await t.renderOnce();
  return { t, fe, press };
}

test("startPick opens the shared pick surface and enter commits the first item", async () => {
  const { t, fe, press } = await mountEditor();
  const committed: string[] = [];
  fe.startPick(
    "default_spawn",
    [
      { label: "explorer", value: "explorer" },
      { label: "builder", value: "builder" },
      { label: "(unset)", value: "" },
    ],
    (v) => committed.push(v),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("default_spawn");
  expect(frame).toContain("explorer");
  expect(frame).toContain("╭");
  press("return");
  expect(committed).toEqual(["explorer"]);
  expect(fe.editing()).toBeNull();
  t.renderer.destroy();
});

test("startEnum opens pre-selected on the current value — enter on it is a no-op (never dirties)", async () => {
  const { t, fe, press } = await mountEditor();
  const committed: string[] = [];
  fe.startEnum("reasoning_effort", ["off", "minimal", "low", "medium", "high"], "medium", (v) =>
    committed.push(v),
  );
  await t.renderOnce();
  const spans = t.captureSpans();
  const band = selectionBg(overlayBg()).toLowerCase();
  const cellOf = (needle: string) =>
    spans.lines.flatMap((l) => l.spans).find((s) => s.text.includes(needle))!;
  expect(rgbToHex(cellOf("medium").bg).toLowerCase()).toBe(band);
  expect(rgbToHex(cellOf("off").bg).toLowerCase()).not.toBe(band);
  press("return");
  expect(committed).toEqual([]);
  expect(fe.editing()).toBeNull();
  t.renderer.destroy();
});

test("startEnum commits only a real change (moving off the preselection)", async () => {
  const { t, fe, press } = await mountEditor();
  const committed: string[] = [];
  fe.startEnum("reasoning_effort", ["off", "minimal", "low", "medium", "high"], "medium", (v) =>
    committed.push(v),
  );
  await t.renderOnce();
  press("down");
  press("return");
  expect(committed).toEqual(["high"]);
  t.renderer.destroy();
});

test("a short enum compacts (no filter) and still navigates from the preselection", async () => {
  const { t, fe, press } = await mountEditor();
  const committed: string[] = [];
  fe.startEnum("kind", ["anthropic", "openai", "google"], "openai", (v) => committed.push(v));
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("filter");
  press("down");
  press("return");
  expect(committed).toEqual(["google"]);
  t.renderer.destroy();
});

test("start (text) skips the commit when the value is unchanged", async () => {
  const { t, fe, press } = await mountEditor();
  const committed: string[] = [];
  fe.start("label", "hello", (v) => committed.push(v));
  await t.renderOnce();
  press("return");
  expect(committed).toEqual([]);
  expect(fe.editing()).toBeNull();
  t.renderer.destroy();
});

test("startNumber skips the commit when the number is unchanged", async () => {
  const { t, fe, press } = await mountEditor();
  const committed: (number | undefined)[] = [];
  fe.startNumber("total", 42, {
    commit: (v) => committed.push(v),
    notify: () => {},
  });
  await t.renderOnce();
  press("return");
  expect(committed).toEqual([]);
  expect(fe.editing()).toBeNull();
  t.renderer.destroy();
});

test("escape cancels the pick: nothing committed, editing cleared, layer released", async () => {
  const { t, fe, press } = await mountEditor();
  const committed: string[] = [];
  fe.startPick("field", [{ label: "a", value: "a" }], (v) => committed.push(v));
  await t.renderOnce();
  press("escape");
  expect(committed).toEqual([]);
  expect(fe.editing()).toBeNull();
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("╭");
  t.renderer.destroy();
});

test("the retained picker resets selection and callbacks for a later edit", async () => {
  const { t, fe, press } = await mountEditor();
  const committed: string[] = [];
  fe.startEnum("first", ["a", "b", "c"], "b", (value) => committed.push(`first:${value}`));
  await t.renderOnce();
  press("down");
  press("return");
  expect(committed).toEqual(["first:c"]);

  fe.startEnum("second", ["x", "y", "z"], "x", (value) => committed.push(`second:${value}`));
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("second");
  press("down");
  press("return");
  expect(committed).toEqual(["first:c", "second:y"]);
  t.renderer.destroy();
});
