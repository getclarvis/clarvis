import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import type { ModelCatalog } from "@clarvis/protocol";
import { createModelsCatalog } from "../../src/adapters/models-catalog.ts";
import type { SettingsAdapter, SettingsFile } from "../../src/adapters/settings.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { ModelView } from "../../src/views/config/ModelView.tsx";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { openRender } from "../helpers/tracked-render.ts";

const PROVIDERS = [
  {
    name: "anthropic",
    kind: "anthropic",
    models: { "claude-sonnet": { context_window_tokens: 200000 } },
  },
  {
    name: "openrouter",
    kind: "openai-compatible",
    models: { "deepseek-chat": { context_window_tokens: 128000, max_output_tokens: 8192 } },
  },
] as const;

function mount(
  withProviders = true,
  safety?: Pick<Parameters<typeof ModelView>[1], "runActive" | "inspectContext" | "fitContext">,
  writeError?: Error,
) {
  const { keymap, press } = createFakeKeymap();
  const [version, setVersion] = createSignal(0);
  const files: Partial<Record<"global" | "workspace", Partial<SettingsFile>>> = {
    global: {
      providers: withProviders ? ([...PROVIDERS] as never) : [],
      default_model: withProviders ? "anthropic/claude-sonnet" : undefined,
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
      if (writeError !== undefined) throw writeError;
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
        id: "anthropic",
        name: "Anthropic",
        kind: "anthropic",
        needs_base_url: false,
        models: [
          {
            id: "claude-sonnet",
            reasoning_efforts: ["low", "medium", "high", "max"],
          },
        ],
      },
      {
        id: "openrouter",
        name: "OpenRouter",
        kind: "openai-compatible",
        needs_base_url: false,
        models: [{ id: "deepseek-chat", reasoning_efforts: ["none", "low", "medium", "high"] }],
      },
    ],
  } satisfies ModelCatalog);
  const view = () =>
    ModelView(host, {
      settings,
      catalog,
      notify: (message) => notes.push(message),
      ...safety,
    });
  return { host, view, press, writes, notes };
}

test("/model unifies configured models from every provider and marks the effective default", async () => {
  const { host, view } = mount();
  const t = await openRender(view as never, { width: 100, height: 20 });
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Default model");
  expect(frame).toContain("anthropic/claude-sonnet");
  expect(frame).toContain("openrouter/deepseek-chat");
  expect(frame).toContain("(◉) anthropic/claude-sonnet");
  expect(host.dirty()).toBe(false);
  t.renderer.destroy();
});

test("a smaller model asks before mechanically evicting persisted context", async () => {
  const fits: number[] = [];
  const { view, press, writes, notes } = mount(true, {
    inspectContext: async (target) => ({
      execution_id: "exec_prior",
      estimated_tokens: 180000,
      has_context: true,
      high_water_tokens: Math.floor(target * 0.8),
      requires_compaction: true,
    }),
    fitContext: async (target) => {
      fits.push(target);
      return {
        status: "compacted",
        execution_id: "exec_prior",
        freed_chars: 240000,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          cache_write_tokens: 0,
        },
      };
    },
  });
  const t = await openRender(view as never, { width: 100, height: 20 });
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("permanently evict older context");
  expect(writes).toEqual([]);
  press("y");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await t.renderOnce();
  expect(fits).toEqual([128000]);
  expect(writes[0]?.patch.default_model).toBe("openrouter/deepseek-chat");
  expect(notes.some((note) => note.includes("older context evicted"))).toBe(true);
  t.renderer.destroy();
});

test("declining smaller-model eviction keeps the current model", async () => {
  const { view, press, writes } = mount(true, {
    inspectContext: async () => ({
      execution_id: "exec_prior",
      estimated_tokens: 180000,
      has_context: true,
      high_water_tokens: 102400,
      requires_compaction: true,
    }),
    fitContext: async () => {
      throw new Error("must not compact after refusal");
    },
  });
  const t = await openRender(view as never, { width: 100, height: 20 });
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  press("n");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(writes).toEqual([]);
  t.renderer.destroy();
});

test("a failed model write does not compact persisted context", async () => {
  const fits: number[] = [];
  const { view, press, notes } = mount(
    true,
    {
      inspectContext: async () => ({
        execution_id: "exec_prior",
        estimated_tokens: 180000,
        has_context: true,
        high_water_tokens: 102400,
        requires_compaction: true,
      }),
      fitContext: async (target) => {
        fits.push(target);
        throw new Error("must not compact before settings persist");
      },
    },
    new Error("settings write failed"),
  );
  const t = await openRender(view as never, { width: 100, height: 20 });
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  press("y");
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(fits).toEqual([]);
  expect(notes.some((note) => note.includes("settings write failed"))).toBe(true);
  t.renderer.destroy();
});

test("model changes wait for an active run to settle before inspecting context", async () => {
  const { view, press, writes, notes } = mount(true, {
    runActive: () => true,
    inspectContext: async () => {
      throw new Error("an active run has no final context to inspect");
    },
    fitContext: async () => {
      throw new Error("must not compact an active run for a model switch");
    },
  });
  const t = await openRender(view as never, { width: 100, height: 20 });
  await t.renderOnce();
  press("down");
  press("return");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(writes).toEqual([]);
  expect(notes).toContain("finish the active run before changing the model");
  t.renderer.destroy();
});

test("Enter writes the model and resets effort to a compatible balanced level", async () => {
  const { host, view, press, writes, notes } = mount();
  host.toggleScope();
  const t = await openRender(view as never, { width: 100, height: 20 });
  await t.renderOnce();
  press("down");
  press("return");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await t.renderOnce();
  await t.renderOnce();
  expect(writes).toEqual([
    {
      scope: "workspace",
      patch: {
        default_model: "openrouter/deepseek-chat",
        default_reasoning_effort: "medium",
      },
    },
  ]);
  expect(notes[0]).toContain("default model: openrouter/deepseek-chat");
  expect(notes[0]).toContain("effort: medium (workspace)");
  expect(t.captureCharFrame()).toContain("(◉) openrouter/deepseek-chat");
  t.renderer.destroy();
});

test("/model explains where to add models when none are configured", async () => {
  const { view } = mount(false);
  const t = await openRender(view as never, { width: 100, height: 16 });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Add providers and models in /settings/providers");
  t.renderer.destroy();
});
