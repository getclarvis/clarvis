import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import type { ModelCatalog } from "@clarvis/protocol";
import { createModelsCatalog } from "../../src/adapters/models-catalog.ts";
import type { SettingsAdapter, SettingsFile } from "../../src/adapters/settings.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { EffortView } from "../../src/views/config/EffortView.tsx";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { openRender } from "../helpers/tracked-render.ts";

function mount(
  capabilities: string[] = ["reasoning"],
  reasoningEfforts: string[] = ["none", "low", "medium", "high"],
  catalogAvailable = true,
  kind: "openai-compatible" | "openai-codex" = "openai-compatible",
  persistEfforts = true,
  entitledEfforts?: string[],
) {
  const { keymap, press } = createFakeKeymap();
  const [version, setVersion] = createSignal(0);
  const files: Partial<Record<"global" | "workspace", Partial<SettingsFile>>> = {
    global: {
      providers: [
        {
          name: "alpha",
          kind,
          models: {
            small: {
              context_window_tokens: 32000,
              capabilities,
              ...(persistEfforts ? { reasoning_efforts: reasoningEfforts } : {}),
            },
          },
        },
      ],
      default_model: "alpha/small",
      default_reasoning_effort: "medium",
    },
  };
  const writes: { scope: string; patch: Partial<SettingsFile> }[] = [];
  const notes: string[] = [];
  const settings = {
    version,
    read: (scope: "global" | "workspace") => files[scope],
    effective: () => {
      version();
      return { ...files.global, ...files.workspace };
    },
    origin: (field: string) => {
      version();
      return files.workspace?.[field as keyof SettingsFile] !== undefined ? "workspace" : "global";
    },
    write: async (scope: "global" | "workspace", patch: Partial<SettingsFile>) => {
      writes.push({ scope, patch });
      files[scope] = { ...files[scope], ...patch };
      setVersion((value) => value + 1);
    },
  } as unknown as SettingsAdapter;
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const catalog = createModelsCatalog({
    source: "bundle",
    providers: [
      {
        id: "alpha",
        name: "Alpha",
        kind,
        needs_base_url: true,
        models: [{ id: "small", capabilities, reasoning_efforts: reasoningEfforts }],
      },
    ],
  } satisfies ModelCatalog);
  const view = () =>
    EffortView(host, {
      settings,
      catalog: catalogAvailable ? catalog : null,
      ...(entitledEfforts === undefined
        ? {}
        : {
            modelsService: {
              getEntitled: async () => ({
                id: kind,
                name: "Subscription",
                kind,
                needs_base_url: false,
                models: [{ id: "small", reasoning_efforts: entitledEfforts }],
              }),
            },
          }),
      notify: (message) => notes.push(message),
    });
  return { host, view, press, writes, notes };
}

test("/effort shows only the levels published for the default model", async () => {
  const { view } = mount();
  const t = await openRender(view as never, { width: 120, height: 20 });
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Select reasoning level for small");
  expect(frame).toContain("Provider default");
  expect(frame).toContain("Off");
  expect(frame).toContain("Low");
  expect(frame).toContain("Fast responses with lighter reasoning");
  expect(frame).toContain("recommended");
  expect(frame).toContain("current");
  expect(frame).not.toContain("minimal");
  expect(frame).not.toContain("xhigh");
  expect(frame).toContain("(◉) Medium");
  expect(frame).toMatch(/model\s+alpha\/small/);
  t.renderer.destroy();
});

test("Enter writes only default_reasoning_effort in the active scope", async () => {
  const { host, view, press, writes, notes } = mount();
  host.toggleScope();
  const t = await openRender(view as never, { width: 100, height: 20 });
  await t.renderOnce();
  press("end");
  press("return");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await t.renderOnce();
  expect(writes).toEqual([{ scope: "workspace", patch: { default_reasoning_effort: "high" } }]);
  expect(notes[0]).toContain("default effort: High (workspace)");
  const frame = t.captureCharFrame();
  expect(frame).toContain("(◉) High");
  expect(frame).toMatch(/source\s+workspace/);
  t.renderer.destroy();
});

test("/effort warns when the default model declares no reasoning support", async () => {
  const { view } = mount(["tool_calling"], []);
  const t = await openRender(view as never, { width: 100, height: 20 });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("does not declare reasoning support");
  t.renderer.destroy();
});

test("/effort loads entitled levels for a legacy subscription model", async () => {
  const { host, view, press, writes } = mount(
    ["reasoning"],
    ["low", "medium", "high"],
    false,
    "openai-codex",
    false,
    ["low", "medium", "high"],
  );
  host.toggleScope();
  const t = await openRender(view as never, { width: 100, height: 20 });
  await t.renderOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("3 model-supported levels");
  expect(t.captureCharFrame()).not.toContain("does not declare reasoning support");
  press("end");
  press("return");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(writes).toEqual([{ scope: "workspace", patch: { default_reasoning_effort: "high" } }]);
  t.renderer.destroy();
});
