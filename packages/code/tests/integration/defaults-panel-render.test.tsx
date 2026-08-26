import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { rgbToHex } from "@opentui/core";
import { selectionBg } from "../../src/theme/surfaces.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { DefaultsPanel } from "../../src/views/config/DefaultsPanel.tsx";
import type { SettingsAdapter } from "../../src/adapters/settings.ts";
import type { EnvView } from "../../src/adapters/agent-files.ts";
import { configuredModelRows } from "../../src/views/config/catalog-pick.ts";
import type { HintTone } from "../../src/views/hint.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const fakeKeymap = createFakeKeymap;

const ENV: EnvView = {
  budgetOnExceed: "escalate",
  iterationDefault: 50,
  iterationCeiling: 100,
  tokenDefault: 4_000_000,
  tokenCeiling: 5_000_000,
  maxGrant: "edit",
  contextWindowDefault: 128000,
};

/**
 * Shape of the provider fixtures below.
 *
 * @remarks Declared rather than inferred from the literal: `capabilities` is a
 * real catalog field (`src/adapters/models-catalog.ts`) that only one test
 * supplies, so `typeof PROVIDERS` would type it away and reject that test's
 * override.
 */
interface ProviderFixture {
  name: string;
  kind: string;
  models: Record<
    string,
    { context_window_tokens?: number; max_output_tokens?: number; capabilities?: string[] }
  >;
}

const PROVIDERS: ProviderFixture[] = [
  {
    name: "openrouter",
    kind: "openai-compatible",
    models: {
      "glm-5.2": { context_window_tokens: 128000, max_output_tokens: 8000 },
      "qwen-max": { context_window_tokens: 64000 },
    },
  },
];

function fakeSettings(
  opts: { resolvable?: boolean; providers?: ProviderFixture[]; writes?: unknown[] } = {},
): SettingsAdapter {
  const { resolvable = true, providers = PROVIDERS, writes } = opts;
  return {
    read: () => ({ providers, default_model: "openrouter/glm-5.2" }),
    effective: () => ({ providers, default_model: "openrouter/glm-5.2" }),
    effectiveProviders: () => providers.map((p) => ({ provider: p, origin: "global" })),
    knownGrants: () => undefined,
    withheldWorkspaceFields: () => [],
    workspaceTrust: () => "inert",
    setWorkspaceTrust: async () => {},
    validateProviders: () =>
      resolvable ? { ok: true } : { ok: false, issues: [{ field: "default_model", message: "x" }] },
    refs: () => ({ agents: [], defaultModel: false }),
    modelRefs: () => ({ agents: [], defaultModel: false }),
    envStatus: () => "unset",
    corrupt: () => null,
    sources: () => ({ global: "/tmp/settings.json" }),
    write: async (scope: string, patch: unknown) => {
      writes?.push({ scope, patch });
    },
    declaredMcpServers: () => [],
  } as unknown as SettingsAdapter;
}

function mount(
  opts: {
    resolvable?: boolean;
    providers?: ProviderFixture[];
  } = {},
) {
  const { keymap, press } = fakeKeymap();
  const notes: string[] = [];
  const tones: (HintTone | undefined)[] = [];
  const writes: unknown[] = [];
  const { host, controls } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const deps = {
    settings: fakeSettings({ ...opts, writes }),
    env: ENV,
    notify: (m: string, tone?: HintTone) => {
      notes.push(m);
      tones.push(tone);
    },
  };
  return { host, controls, deps, press, notes, tones, writes };
}

test("the three vision/budget defaults render with the derived footer", async () => {
  const { host, deps } = mount();
  const t = await openRender((() => DefaultsPanel(host, deps)) as never, {
    width: 100,
    height: 20,
  });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).not.toContain("Default model");
  expect(frame).not.toContain("Reasoning effort");
  expect(frame).toContain("When budget is exceeded");
  expect(frame).toMatch(/When budget is exceeded\s+escalate/);
  expect(frame).toContain("Total token limit");
  expect(frame).toMatch(/Total token limit\s+4000000/);
  expect(frame).not.toContain("unlimited");
  expect(frame).toContain("[↵] edit");
  t.renderer.destroy();
});

test("the selected field row carries the full-width selection band, like the pickers", async () => {
  const { host, deps } = mount();
  const t = await openRender((() => DefaultsPanel(host, deps)) as never, {
    width: 100,
    height: 20,
  });
  await t.renderOnce();
  const spans = t.captureSpans();
  const band = selectionBg().toLowerCase();
  const cellOf = (needle: string) =>
    spans.lines.flatMap((l) => l.spans).find((s) => s.text.includes(needle))!;
  expect(rgbToHex(cellOf("Vision model").bg).toLowerCase()).toBe(band);
  expect(rgbToHex(cellOf("When budget is exceeded").bg).toLowerCase()).not.toBe(band);
  t.renderer.destroy();
});

test("the vision-model picker withholds a model that declares capabilities without vision", async () => {
  const providers: ProviderFixture[] = [
    {
      name: "openrouter",
      kind: "openai-compatible",
      models: {
        "glm-5.2": {
          context_window_tokens: 128000,
          max_output_tokens: 8000,
          capabilities: ["tool_calling"],
        },
        "sees-things": { context_window_tokens: 64000, capabilities: ["vision"] },
      },
    },
  ];
  const { host, deps, press } = mount({ providers });
  const t = await openRender((() => DefaultsPanel(host, deps)) as never, {
    width: 100,
    height: 24,
  });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Pick a vision model");
  expect(frame).toContain("openrouter/sees-things");
  expect(frame).not.toContain("openrouter/glm-5.2");
  t.renderer.destroy();
});

test("the vision-model picker still offers a model the catalog knows nothing about", async () => {
  const providers: ProviderFixture[] = [
    {
      name: "openrouter",
      kind: "openai-compatible",
      models: {
        // declares capabilities, and vision is not among them -> withheld
        "glm-5.2": { context_window_tokens: 128000, capabilities: ["tool_calling"] },
        // a custom entry the catalog has never seen -> unknown, not unsupported
        "home-grown": { context_window_tokens: 64000 },
      },
    },
  ];
  const { host, deps, press } = mount({ providers });
  const t = await openRender((() => DefaultsPanel(host, deps)) as never, {
    width: 100,
    height: 24,
  });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("openrouter/home-grown");
  expect(frame).not.toContain("openrouter/glm-5.2");
  t.renderer.destroy();
});

test("saving writes neither default model nor default effort", async () => {
  const { host, controls, deps, writes, notes, tones } = mount();
  const t = await openRender((() => DefaultsPanel(host, deps)) as never, {
    width: 100,
    height: 20,
  });
  await t.renderOnce();
  await controls.runSave();
  expect(writes).toEqual([
    {
      scope: "global",
      patch: {
        default_vision_model: undefined,
        budget: undefined,
      },
    },
  ]);
  expect(notes).toEqual(["saved global defaults"]);
  expect(tones).toEqual([undefined]);
  t.renderer.destroy();
});

test("configuredModelRows flattens provider/model pairs and marks the current value", () => {
  const rows = configuredModelRows(PROVIDERS, "openrouter/qwen-max");
  expect(rows.map((r) => r.id)).toEqual(["openrouter/glm-5.2", "openrouter/qwen-max"]);
  expect(rows[0]!.added).toBe(false);
  expect(rows[1]!.added).toBe(true);
  expect(rows[0]!.columns?.[0]?.text).toBe("128k/8.0k");
  expect(rows[1]!.columns?.[0]?.text).toContain("64k/");
});
