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
import { SettingDetail } from "../../src/ui/patterns/detail-view.tsx";

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

test("setting details show pending and read-only facts without repeating an equal configured value", async () => {
  const t = await openRender(
    (() => (
      <SettingDetail
        setting={{
          label: "Managed value",
          configured: "locked",
          effective: "locked",
          pending: "new value",
          source: "workspace policy",
          applies: "next run",
          mutation: "staged",
          readOnlyReason: "managed by the workspace owner",
        }}
      />
    )) as never,
    { width: 80, height: 16 },
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).not.toContain("Configured:");
  expect(frame).toContain("Pending: new value");
  expect(frame).toContain("managed by the workspace owner");
  t.renderer.destroy();
});

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

test("the two budget defaults render with the derived footer", async () => {
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
  expect(rgbToHex(cellOf("When budget is exceeded").bg).toLowerCase()).toBe(band);
  expect(rgbToHex(cellOf("Total token limit").bg).toLowerCase()).not.toBe(band);
  t.renderer.destroy();
});

test("details open separately without expanding the defaults overview", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => DefaultsPanel(host, deps)) as never, {
    width: 100,
    height: 20,
  });
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("Configured:");
  press("i");
  await t.renderOnce();
  const detail = t.captureCharFrame();
  expect(detail).toContain("Defaults ▸ When budget is exceeded");
  expect(detail).toContain("Configured: inherit");
  expect(detail).toContain("Effective: escalate");
  expect(detail).toContain("[e] edit");
  t.renderer.destroy();
});

test("the token-limit detail explains the host ceiling", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => DefaultsPanel(host, deps)) as never, {
    width: 100,
    height: 20,
  });
  await t.renderOnce();
  press("down");
  press("i");
  await t.renderOnce();
  const detail = t.captureCharFrame();
  expect(detail).toContain("Defaults ▸ Total token limit");
  expect(detail).toContain("Effective: 4000000");
  expect(detail).toMatch(/host ceiling\s+5000000/);
  t.renderer.destroy();
});

test("editing the budget outcome stages only the selected budget field", async () => {
  const { host, controls, deps, press, writes } = mount();
  const t = await openRender((() => DefaultsPanel(host, deps)) as never, {
    width: 100,
    height: 20,
  });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("budget.on_exceed");
  press("up");
  press("return");
  await controls.runSave();
  expect(writes).toEqual([
    {
      scope: "global",
      patch: {
        budget: { on_exceed: "stop" },
      },
    },
  ]);
  t.renderer.destroy();
});

test("editing the token limit opens the bounded numeric editor", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => DefaultsPanel(host, deps)) as never, {
    width: 100,
    height: 20,
  });
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  const editor = t.captureCharFrame();
  expect(editor).toContain("total_token_limit");
  expect(editor).toContain("[↵] commit");
  press("escape");
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
