import { afterEach, expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { rgbToHex } from "@opentui/core";
import { CatalogPicker } from "../../src/views/config/CatalogPicker.tsx";
import type { CatalogRow } from "../../src/views/config/catalog-pick.ts";
import { overlayBg, selectionBg } from "../../src/theme/surfaces.ts";
import { applyAsciiMode } from "../../src/theme/glyphs.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

afterEach(() => applyAsciiMode(false));

const stubKeymap = createFakeKeymap().keymap;

async function frame(ui: () => unknown): Promise<string> {
  const t = await openRender(ui as never, { width: 100, height: 30 });
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

const ROWS: CatalogRow[] = [
  { id: "anthropic", label: "anthropic", haystack: "anthropic", detail: "anthropic · 12 models" },
  { id: "openai", label: "openai", haystack: "openai", detail: "openai · 40 models", added: true },
];

const MANY_ROWS: CatalogRow[] = Array.from({ length: 12 }, (_, i) => ({
  id: `provider-${i}`,
  label: `provider-${i}`,
  haystack: `provider-${i}`,
  detail: `kind · ${i} models`,
}));

test("a long catalog renders title, filter, rows with details and the manual escape", async () => {
  const out = await frame(() => (
    <CatalogPicker
      keymap={stubKeymap}
      title="Add provider — models.dev catalog"
      rows={() => MANY_ROWS}
      onPick={() => {}}
      onManual={() => {}}
      onClose={() => {}}
    />
  ));
  expect(out).toContain("Add provider — models.dev catalog");
  expect(out).toContain("filter");
  expect(out).toContain("kind · 3 models");
  expect(out).toContain("manual entry…");
  expect(out).toContain("[↵] select");
  expect(out).toContain("[esc] cancel");
  expect(out).toContain("╭");
});

test("a short list compacts: no filter field, j/k in the hints, card hugs the rows", async () => {
  const out = await frame(() => (
    <CatalogPicker
      keymap={stubKeymap}
      title="Pick one"
      rows={() => ROWS}
      onPick={() => {}}
      onClose={() => {}}
    />
  ));
  expect(out).not.toContain("filter");
  const lines = out.split("\n");
  const top = lines.findIndex((l) => l.includes("╭"));
  const bottom = lines.findIndex((l) => l.includes("╰"));
  expect(bottom - top + 1).toBe(7);
});

test("initialId opens the picker pre-selected on that row", async () => {
  const t = await openRender(
    (() => (
      <CatalogPicker
        keymap={stubKeymap}
        title="Pick one"
        rows={() => ROWS}
        initialId="openai"
        onPick={() => {}}
        onClose={() => {}}
      />
    )) as never,
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  const spans = t.captureSpans();
  const band = selectionBg(overlayBg()).toLowerCase();
  const cellOf = (needle: string) =>
    spans.lines.flatMap((l) => l.spans).find((s) => s.text.includes(needle))!;
  expect(rgbToHex(cellOf("40 models").bg).toLowerCase()).toBe(band);
  expect(rgbToHex(cellOf("12 models").bg).toLowerCase()).not.toBe(band);
  t.renderer.destroy();
});

test("added rows show the ✓ marker and the multi-add footer counts", async () => {
  const out = await frame(() => (
    <CatalogPicker
      keymap={stubKeymap}
      title="Add models — openai"
      rows={() => ROWS}
      onPick={() => {}}
      onClose={() => {}}
      stayOpen
      counter={() => 3}
      counterLabel="models"
    />
  ));
  expect(out).toMatch(/✓\s+openai/);
  expect(out).toContain("3 models");
  expect(out).toContain("[↵] add/remove");
  expect(out).toContain("[esc] done");
});

test("the selected row paints the selection band across its cells", async () => {
  const t = await openRender(
    (() => (
      <CatalogPicker
        keymap={stubKeymap}
        title="Add provider"
        rows={() => ROWS}
        onPick={() => {}}
        onClose={() => {}}
      />
    )) as never,
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  const spans = t.captureSpans();
  const band = selectionBg(overlayBg()).toLowerCase();
  const cellOf = (needle: string) =>
    spans.lines.flatMap((l) => l.spans).find((s) => s.text.includes(needle))!;
  expect(rgbToHex(cellOf("12 models").bg).toLowerCase()).toBe(band);
  expect(rgbToHex(cellOf("40 models").bg).toLowerCase()).not.toBe(band);
  t.renderer.destroy();
});

test("ascii mode fits the [ok] marker without truncating it", async () => {
  applyAsciiMode(true);
  const out = await frame(() => (
    <CatalogPicker
      keymap={stubKeymap}
      title="Add models — openai"
      rows={() => ROWS}
      onPick={() => {}}
      onClose={() => {}}
      stayOpen
    />
  ));
  expect(out).toMatch(/\[ok\]\s+openai/);
});

test("first-run branding stays with the picker only while the complete splash fits", async () => {
  const large = await openRender(
    (() => (
      <CatalogPicker
        keymap={stubKeymap}
        title="Set up Clarvis · Model"
        rows={() => MANY_ROWS}
        onPick={() => {}}
        onClose={() => {}}
        firstRun
      />
    )) as never,
    { width: 100, height: 24 },
  );
  await large.renderOnce();
  const branded = large.captureCharFrame();
  expect(branded).toContain(".d8888b.");
  expect(branded).toContain("provider-0");
  large.renderer.destroy();

  const small = await openRender(
    (() => (
      <CatalogPicker
        keymap={stubKeymap}
        title="Set up Clarvis · Model"
        rows={() => MANY_ROWS}
        onPick={() => {}}
        onClose={() => {}}
        firstRun
      />
    )) as never,
    { width: 75, height: 23 },
  );
  await small.renderOnce();
  const unbranded = small.captureCharFrame();
  expect(unbranded).not.toContain(".d8888b.");
  expect(unbranded).toContain("provider-0");
  small.renderer.destroy();
});
