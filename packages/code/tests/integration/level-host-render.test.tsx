import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { ViewHost } from "../../src/keys/commands.ts";
import { registerLevel, type LevelSpec } from "../../src/ui/patterns/level-keys.ts";
import type { CatalogPickerSpec } from "../../src/views/config/CatalogPicker.tsx";
import {
  createFieldEditor,
  createViewHost,
  bindLevelKeys,
  LevelHost,
  type FieldEditor,
} from "../../src/views/config/view-host.tsx";
import { tokens } from "../../src/theme/tokens.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const fakeKeymap = createFakeKeymap;

function specFor(depth: number): LevelSpec {
  if (depth === 0) return { verbs: [{ key: "a", label: "add", run: () => {} }] };
  return { verbs: [{ key: "d", label: "remove", run: () => {} }] };
}

async function mount(build: (host: ViewHost, fe: FieldEditor) => Parameters<typeof LevelHost>[0]) {
  const { keymap, press } = fakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const t = await openRender(
    (() => {
      const fe = createFieldEditor(host.interaction);
      bindLevelKeys({
        host,
        editor: fe,
        register: (enabled) =>
          registerLevel(host.interaction.keymap, { ...specFor(host.level.depth()), enabled }),
      });
      return <LevelHost {...build(host, fe)} />;
    }) as never,
    { width: 100, height: 26 },
  );
  await t.renderOnce();
  return { t, host, press };
}

test("one ViewFrame serves every level: title, body, footer and breadcrumb track the depth", async () => {
  const { t, host } = await mount((h) => ({
    host: h,
    levels: [
      { title: () => "Things (2 keyed)", body: () => <text>LIST BODY</text> },
      { title: "Things", body: () => <text>DETAIL BODY</text> },
    ],
  }));
  let frame = t.captureCharFrame();
  expect(frame).toContain("Things (2 keyed)");
  expect(frame).toContain("LIST BODY");
  expect(frame).toContain("[a] add");

  host.level.push("alpha");
  await t.renderOnce();
  frame = t.captureCharFrame();
  expect(frame).toContain("DETAIL BODY");
  expect(frame).not.toContain("LIST BODY");
  expect(frame).toContain("alpha");
  expect(frame).toContain("[d] remove");
  t.renderer.destroy();
});

test("a when-matched level (a panel's own screen state) wins over the depth default", async () => {
  const [screen, setScreen] = createSignal<"doc" | null>(null);
  const { t, host } = await mount((h) => ({
    host: h,
    levels: [
      { title: "Memory", body: () => <text>OVERVIEW</text>, readOnly: true },
      {
        title: "Memory",
        body: () => <text>DOC BODY</text>,
        when: () => screen() === "doc",
        readOnly: true,
      },
    ],
  }));
  expect(t.captureCharFrame()).toContain("OVERVIEW");
  expect(t.captureCharFrame()).toContain("Read-only");

  setScreen("doc");
  host.level.push("profile.md");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("DOC BODY");
  expect(frame).not.toContain("OVERVIEW");
  t.renderer.destroy();
});

test("the field editor is mounted once by the shell — any level's start() shows it", async () => {
  let fe!: FieldEditor;
  const { t } = await mount((h, editor) => {
    fe = editor;
    return {
      host: h,
      levels: [{ title: "Things", body: () => <text>LIST BODY</text> }],
      editor,
    };
  });
  fe.start("env var name", "OPENAI_API_KEY", () => {});
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("env var name:");
  expect(frame).toContain("[↵] commit");
  t.renderer.destroy();
});

test("the picker signal drives the single CatalogPicker mount", async () => {
  const [picker, setPicker] = createSignal<CatalogPickerSpec | null>(null);
  const { t } = await mount((h) => ({
    host: h,
    levels: [{ title: "Things", body: () => <text fg={tokens.fg}>LIST BODY</text> }],
    picker,
  }));
  setPicker({
    title: "grants — builder",
    rows: () => [{ id: "read", label: "read_workspace", haystack: "read_workspace" }],
    onPick: () => {},
    onClose: () => setPicker(null),
  });
  await t.renderOnce();
  await t.renderOnce();
  let frame = t.captureCharFrame();
  expect(frame).toContain("grants — builder");
  expect(frame).toContain("read_workspace");

  setPicker(null);
  await t.renderOnce();
  frame = t.captureCharFrame();
  expect(frame).not.toContain("grants — builder");
  expect(frame).toContain("LIST BODY");
  t.renderer.destroy();
});
