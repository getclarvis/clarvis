import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { ProvidersPanel } from "../../src/views/config/ProvidersPanel.tsx";
import type {
  FieldIssue,
  ProviderConfig,
  Scope,
  SettingsAdapter,
  SettingsFile,
} from "../../src/adapters/settings.ts";
import type { KeysAdapter, KeySource } from "../../src/adapters/provider-secrets.ts";
import type { CodeConfigStore } from "../../src/adapters/code-config.ts";
import { createModelsCatalog, type ModelsCatalog } from "../../src/adapters/models-catalog.ts";
import type {
  ModelCatalog,
  ModelCatalogService,
  ProviderAuthService,
  SubscriptionAccountStatus,
} from "@clarvis/protocol";
import { glyph } from "../../src/theme/glyphs.ts";
import { captureUntil } from "../helpers/render-support.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const fakeKeymap = createFakeKeymap;

function fakeSettings(
  provider: ProviderConfig | undefined,
  keyed: string,
  opts?: {
    modelRefs?: (id: string) => { agents: string[]; defaultModel: boolean };
    defaultModel?: string;
    issues?: FieldIssue[];
    refs?: (name: string) => { agents: string[]; defaultModel: boolean };
  },
  writes?: { scope: Scope; patch: Partial<SettingsFile> }[],
): SettingsAdapter {
  const providers = provider ? [provider] : [];
  return {
    version: () => 0,
    read: (scope: Scope) =>
      scope === "global" ? { providers, default_model: opts?.defaultModel } : undefined,
    origin: () => "global",
    planRepair: () => null,
    applyRepair: async () => {},
    knownGrants: () => undefined,
    effectiveProviders: () =>
      providers.map((configured) => ({ provider: configured, origin: "global" })),
    withheldWorkspaceFields: () => [],
    workspaceTrust: () => "inert",
    setWorkspaceTrust: async () => {},
    envStatus: (v: string) => (v === keyed ? "keyfile" : "unset"),
    validateProviders: () =>
      opts?.issues?.length ? { ok: false, issues: opts.issues } : { ok: true },
    refs: opts?.refs ?? (() => ({ agents: [], defaultModel: false })),
    modelRefs: opts?.modelRefs ?? (() => ({ agents: [], defaultModel: false })),
    effective: () => ({ providers, default_model: opts?.defaultModel }),
    corrupt: () => null,
    sources: () => ({ global: "/tmp/settings.json" }),
    write: async (scope, patch) => {
      writes?.push({ scope, patch });
    },
    declaredMcpServers: () => [],
    reload: async () => {},
    inspectSandbox: async () => {
      throw new Error("sandbox inspection is outside the ProvidersPanel contract");
    },
  };
}

function fakeKeys(saved: Record<string, string>): KeysAdapter {
  return {
    has: (n) => !!saved[n],
    set: async (n, v) => {
      saved[n] = v;
    },
    reload: async () => {},
  };
}

function fakeCode(): CodeConfigStore {
  const [map, setMap] = createSignal<Record<string, KeySource>>({});
  return {
    guardModeDefault: () => undefined,
    asciiEnabled: () => false,
    keyboardConfig: () => ({ version: 1, environments: {} }),
    keySources: map,
    keySource: (v) => map()[v] ?? "auto",
    writeKeySource: (_scope, v, s) =>
      setMap((m) => {
        const next = { ...m };
        if (s === "auto") delete next[v];
        else next[v] = s;
        return next;
      }),
    read: () => ({}),
    themeAt: () => ({}),
    effectiveTheme: () => ({}),
    agentDefault: () => undefined,
    overrideSource: () => null,
    write: () => {},
    writeTheme: () => {},
    writeAgentDefault: () => {},
    clearAgentDefault: () => {},
    writeAscii: () => {},
    writeKeyboardEnvironment: () => {},
    hasWorkspace: () => false,
  };
}

function mount(
  provider: ProviderConfig | undefined,
  keyed: string,
  opts?: {
    modelRefs?: (id: string) => { agents: string[]; defaultModel: boolean };
    defaultModel?: string;
    issues?: FieldIssue[];
    refs?: (name: string) => { agents: string[]; defaultModel: boolean };
    catalog?: ModelsCatalog | null;
    initialScope?: "global" | "workspace";
  },
) {
  const { keymap, press } = fakeKeymap();
  const notes: string[] = [];
  const saved: Record<string, string> = {};
  const writes: { scope: Scope; patch: Partial<SettingsFile> }[] = [];
  const closed: number[] = [];
  const { host, controls } = createViewHost({
    interaction: {
      keymap,
      renderer: undefined as never,
      pushOverlayContext: () => {},
      popOverlayContext: () => {},
      setModalContext: () => {},
      keyboardEnvironment: undefined as never,
      keyboardEnvironmentId: undefined as never,
      configureKeyboard: () => {},
      dispose: () => {},
    },
    close: () => closed.push(1),
    dispatch: () => {},
    initialScope: opts?.initialScope,
  });
  const deps = {
    settings: fakeSettings(provider, keyed, opts, writes),
    keys: fakeKeys(saved),
    code: fakeCode(),
    notify: (m: string) => notes.push(m),
    catalog: opts?.catalog ?? null,
  };
  return { host, controls, deps, press, notes, saved, writes, closed };
}

const DETAIL_FIELD_COUNT = 8;
const ENV_ROW = 3;
const API_KEY_ROW = 4;
const SOURCE_ROW = 5;

function pressDowns(press: (k: string) => void, n: number): void {
  for (let i = 0; i < n; i++) press("down");
}

test("Enter on a saved API-key row opens the secret editor, never the env-var-name editor", async () => {
  const provider: ProviderConfig = {
    name: "openrouter",
    kind: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1",
    api_key_env: "OPENROUTER_API_KEY",
  };
  const { host, deps, press } = mount(provider, "OPENROUTER_API_KEY");
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();

  const list = t.captureCharFrame();
  expect(list).toContain("openrouter");
  expect(list).toContain("Saved key");
  expect(list).toContain("1 of 1 ready");

  press("return");
  await t.renderOnce();
  const detail = t.captureCharFrame();
  expect(detail).toContain("Credential value");
  expect(detail).toContain("✓ saved in keys.json");
  expect(detail).toContain("OPENROUTER_API_KEY");

  pressDowns(press, API_KEY_ROW);
  press("return");
  await t.renderOnce();
  const editing = t.captureCharFrame();
  expect(editing).toContain("API key → OPENROUTER_API_KEY");
  expect(editing).toContain("input hidden");
  expect(editing).not.toContain("[↵] commit");

  t.renderer.destroy();
});

test("Enter on the env-var row renames it (text editor), separate from setting the key value", async () => {
  const provider: ProviderConfig = {
    name: "openrouter",
    kind: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1",
    api_key_env: "OPENROUTER_API_KEY",
  };
  const { host, deps, press } = mount(provider, "OPENROUTER_API_KEY");
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  pressDowns(press, ENV_ROW);
  press("return");
  await t.renderOnce();
  const editing = t.captureCharFrame();
  expect(editing).toContain("Credential variable");
  expect(editing).toContain("[↵] commit");
  t.renderer.destroy();
});

test("a named-but-empty key shows a missing credential and Enter goes straight to the secret", async () => {
  const provider: ProviderConfig = {
    name: "openrouter",
    kind: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1",
    api_key_env: "OPENROUTER_API_KEY",
  };
  const { host, deps, press } = mount(provider, "none");
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Missing key");
  expect(t.captureCharFrame()).toContain("0 of 1 ready");

  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("✗ no value yet");

  pressDowns(press, API_KEY_ROW);
  press("return");
  await t.renderOnce();
  const editing = t.captureCharFrame();
  expect(editing).toContain("API key → OPENROUTER_API_KEY");
  expect(editing).toContain("input hidden");
  t.renderer.destroy();
});

test("Enter on an unset key names the env var first (chained to the secret)", async () => {
  const provider: ProviderConfig = { name: "local", kind: "openai-compatible" };
  const { host, deps, press } = mount(provider, "none");
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();

  press("return");
  await t.renderOnce();
  const detail = t.captureCharFrame();
  expect(detail).toContain("— not configured");
  expect(detail).toContain("name it");

  pressDowns(press, API_KEY_ROW);
  press("return");
  await t.renderOnce();
  const editing = t.captureCharFrame();
  expect(editing).toContain("Credential variable");
  expect(editing).toContain("LOCAL_API_KEY");
  t.renderer.destroy();
});

test("the source row opens the enum picker and stages one representative selection", async () => {
  const provider: ProviderConfig = {
    name: "openrouter",
    kind: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1",
    api_key_env: "OPENROUTER_API_KEY",
  };
  const { host, deps, press } = mount(provider, "OPENROUTER_API_KEY");
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 40,
  });
  await t.renderOnce();

  press("return");
  await t.renderOnce();
  const detail = t.captureCharFrame();
  expect(detail).toContain("source");
  expect(detail).toContain("auto");
  expect(detail).toContain("shell env wins, else keys.json");

  pressDowns(press, SOURCE_ROW);
  press("return");
  await t.renderOnce();
  await t.renderOnce();
  const pick = t.captureCharFrame();
  expect(pick).toContain("key source — OPENROUTER_API_KEY");
  expect(pick).toContain("shell env only (keys.json ignored)");

  press("down");
  press("return");
  await t.renderOnce();
  const staged = t.captureCharFrame();
  expect(staged).toContain("shell env only (keys.json ignored)");
  expect(staged).toContain("(staged)");
  expect(deps.code.keySource("OPENROUTER_API_KEY")).toBe("auto");
  expect(host.dirty()).toBe(true);
  t.renderer.destroy();
});

test("a typed API key stages in memory without touching the key store", async () => {
  const provider: ProviderConfig = {
    name: "openrouter",
    kind: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1",
    api_key_env: "OPENROUTER_API_KEY",
  };
  const { host, deps, press, saved } = mount(provider, "none");
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  pressDowns(press, API_KEY_ROW);
  press("return");
  await t.renderOnce();
  await t.mockInput.typeText("sk-test-123");
  await t.renderOnce();
  press("return");
  await t.renderOnce();

  const stagedFrame = t.captureCharFrame();
  expect(stagedFrame).toContain("staged");
  expect(saved["OPENROUTER_API_KEY"]).toBeUndefined();
  expect(host.dirty()).toBe(true);
  t.renderer.destroy();
});

test("the provider owning the default_model gets a marker; its model row says default", async () => {
  const provider: ProviderConfig = {
    name: "openrouter",
    kind: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1",
    api_key_env: "OPENROUTER_API_KEY",
    models: { "glm-5.2": { context_window_tokens: 128000 } },
  };
  const { host, deps, press } = mount(provider, "OPENROUTER_API_KEY", {
    defaultModel: "openrouter/glm-5.2",
  });
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("default model");

  press("return");
  await t.renderOnce();
  const detail = t.captureCharFrame();
  expect(detail).toContain("current default model");
  expect(detail).toContain("openai-compatible  ▾");
  expect(detail).toMatch(/ctx\s+128000/);
  t.renderer.destroy();
});

test("the provider list has no default_model editor", async () => {
  const provider: ProviderConfig = {
    name: "openrouter",
    kind: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1",
    api_key_env: "OPENROUTER_API_KEY",
  };
  const { host, deps } = mount(provider, "OPENROUTER_API_KEY", {
    defaultModel: "openrouter/glm-5.2",
  });
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("openai-compatible");
  expect(frame).not.toContain("Default model  openrouter/glm-5.2");
  t.renderer.destroy();
});

test("workspace Providers does not duplicate the inherited default-model surface", async () => {
  const provider: ProviderConfig = {
    name: "openrouter",
    kind: "openai-compatible",
    models: { "glm-5.2": { context_window_tokens: 128000 } },
  };
  const { host, deps } = mount(provider, "none", {
    defaultModel: "openrouter/glm-5.2",
    initialScope: "workspace",
  });
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).not.toContain("Default model");
  t.renderer.destroy();
});

function protoCatalog(id: string): ModelCatalog {
  return {
    source: "cache",
    providers: [
      {
        id,
        name: id,
        kind: "openai-compatible",
        base_url: "https://example.invalid/v1",
        needs_base_url: false,
        models: [],
      },
    ],
  };
}

test("a refreshed catalog reaches an already-open panel through the live facade", async () => {
  const [cat, setCat] = createSignal(createModelsCatalog(protoCatalog("alpha-inc")));
  const facade = {
    get source() {
      return cat().source;
    },
    providers: () => cat().providers(),
    provider: (id: string) => cat().provider(id),
    models: (id: string) => cat().models(id),
    seed: (id: string, taken: ReadonlySet<string>) => cat().seed(id, taken),
    fill: (kind: ProviderConfig["kind"], id: string) => cat().fill(kind, id),
  } as ModelsCatalog;
  const provider: ProviderConfig = { name: "local", kind: "openai-compatible" };
  const { host, deps, press } = mount(provider, "none");
  const t = await openRender(
    (() => ProvidersPanel(host, { ...deps, catalog: facade } as never)) as never,
    { width: 100, height: 30 },
  );
  await t.renderOnce();

  press("a");
  await t.renderOnce();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("alpha-inc");

  press("escape");
  await t.renderOnce();
  setCat(createModelsCatalog(protoCatalog("beta-inc")));
  press("a");
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("beta-inc");
  expect(frame).not.toContain("alpha-inc");
  t.renderer.destroy();
});

test("a validation issue stays inline and one representative save reports the blocker", async () => {
  const provider: ProviderConfig = { name: "local", kind: "openai-compatible" };
  const issue: FieldIssue = {
    field: "base_url",
    provider: "local",
    message: "openai-compatible needs an http(s) base_url",
  };
  const { host, controls, deps, notes, press } = mount(provider, "none", { issues: [issue] });
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("local: openai-compatible needs an http(s) base_url");

  press("return");
  await t.renderOnce();
  const detail = t.captureCharFrame();
  expect(detail).toContain("✗ openai-compatible needs an http(s) base_url");
  host.markDirty(true);
  await controls.runSave();
  expect(notes.some((note) => note.includes("cannot save"))).toBe(true);
  expect(host.dirty()).toBe(true);
  t.renderer.destroy();
});

const withModel: ProviderConfig = {
  name: "openrouter",
  kind: "openai-compatible",
  base_url: "https://openrouter.ai/api/v1",
  api_key_env: "OPENROUTER_API_KEY",
  models: { "glm-5.2": { context_window_tokens: 128000 } },
};

async function drillToModelRow(host: ReturnType<typeof mount>["host"], deps: unknown) {
  const t = await openRender((() => ProvidersPanel(host, deps as never)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();
  return t;
}

test("removing a model referenced by an agent is blocked with a warning; the model stays", async () => {
  const { host, deps, press, notes } = mount(withModel, "OPENROUTER_API_KEY", {
    modelRefs: () => ({ agents: ["coder"], defaultModel: false }),
  });
  const t = await drillToModelRow(host, deps);
  press("return");
  pressDowns(press, DETAIL_FIELD_COUNT);
  press("d");
  await t.renderOnce();
  expect(notes.some((n) => n.includes("coder") && n.includes("stop referencing"))).toBe(true);
  expect(t.captureCharFrame()).toContain("glm-5.2");
  expect(t.captureCharFrame()).not.toContain("remove model 'glm-5.2'?");
  t.renderer.destroy();
});

test("one representative unreferenced-model submit crosses the confirm strip", async () => {
  const { host, deps, press, notes } = mount(withModel, "OPENROUTER_API_KEY");
  const t = await drillToModelRow(host, deps);
  press("return");
  pressDowns(press, DETAIL_FIELD_COUNT);
  press("d");
  await t.renderOnce();
  expect(notes.some((n) => n.includes("can't remove"))).toBe(false);
  const frame = t.captureCharFrame();
  expect(frame).toContain("remove model 'glm-5.2'?");
  // The caller's own verbs, not a generic pair: `ConfirmRequest.confirmLabel` /
  // `cancelLabel` reach the footer, so the operator can see which side of a
  // destructive prompt is which.
  expect(frame).toContain("[y] remove");
  expect(frame).toContain("[n/esc] keep");
  press("y");
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("glm-5.2");
  t.renderer.destroy();
});

function protoCatalogFull(id: string): ModelCatalog {
  return {
    source: "cache",
    providers: [
      {
        id,
        name: id,
        kind: "openai-compatible",
        base_url: "https://example.invalid/v1",
        api_key_env: `${id.toUpperCase()}_API_KEY`,
        needs_base_url: false,
        models: [
          {
            id: "m1",
            name: "Model One",
            context_window: 32000,
            max_output: 4096,
            capabilities: ["tool_calling"],
          },
        ],
      },
    ],
  };
}

function protoCatalogModel(providerId: string, modelId: string): ModelCatalog {
  return {
    source: "cache",
    providers: [
      {
        id: providerId,
        name: providerId,
        kind: "openai-compatible",
        base_url: "https://example.invalid/v1",
        needs_base_url: false,
        models: [
          {
            id: modelId,
            name: modelId,
            context_window: 200000,
            max_output: 8192,
            capabilities: ["tool_calling", "vision"],
          },
        ],
      },
    ],
  };
}

/** A catalog whose one model is priced the way an explicit-breakpoint model is. */
function protoPricedModel(
  providerId: string,
  modelId: string,
  kind: "openai-compatible" | "anthropic",
): ModelCatalog {
  return {
    source: "cache",
    providers: [
      {
        id: providerId,
        name: providerId,
        kind,
        needs_base_url: false,
        models: [
          {
            id: modelId,
            name: modelId,
            context_window: 200000,
            max_output: 8192,
            cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
          },
        ],
      },
    ],
  };
}

const FIELD_LABELS = [
  "Provider name",
  "API type",
  "Base URL",
  "Credential variable",
  "Credential value",
  "Credential source",
] as const;
function selectedFieldLabel(frame: string): string | undefined {
  const rows = frame.split("\n");
  return FIELD_LABELS.find((label) => {
    const row = rows.find((r) => r.includes(label));
    return !!row && row.includes(glyph("chevronRight"));
  });
}

test("deleting a provider shows why it's referenced and only removes it on confirm", async () => {
  const provider: ProviderConfig = {
    name: "openrouter",
    kind: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1",
  };
  const { host, deps, press } = mount(provider, "none", {
    refs: () => ({ agents: ["coder"], defaultModel: true }),
  });
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();

  press("d");
  await t.renderOnce();
  const confirmFrame = t.captureCharFrame();
  expect(confirmFrame).toContain("delete provider 'openrouter'?");
  expect(confirmFrame).toContain("cited by agents: coder");
  expect(confirmFrame).toContain("owns the default_model");

  press("n");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("openrouter");

  press("d");
  await t.renderOnce();
  press("y");
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("openrouter");
  t.renderer.destroy();
});

test("editing kind opens the enum picker and stages the choice", async () => {
  const provider: ProviderConfig = {
    name: "local",
    kind: "openai-compatible",
    base_url: "https://x.invalid/v1",
  };
  const { host, deps, press } = mount(provider, "none");
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  pressDowns(press, 1);
  press("return");
  await t.renderOnce();
  const pick = t.captureCharFrame();
  expect(pick).toContain("API type");
  expect(pick).toContain("anthropic");
  pressDowns(press, 2);
  press("return");
  await t.renderOnce();
  expect(host.dirty()).toBe(true);
  expect(t.captureCharFrame()).toMatch(/API type\s+anthropic/);

  press("home");
  press("return");
  await t.renderOnce();
  await t.mockInput.typeText("-renamed");
  press("return");
  await t.renderOnce();
  expect(host.breadcrumb().at(-1)).toBe("local-renamed");

  pressDowns(press, 2);
  press("return");
  await t.renderOnce();
  await t.mockInput.typeText("?x=1");
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("https://x.invalid/v1?x=1");
  t.renderer.destroy();
});

test("adding a provider from the catalog chains into the model picker, then the key prompt", async () => {
  const catalog = createModelsCatalog(protoCatalogFull("alpha"));
  const provider: ProviderConfig = { name: "seed", kind: "openai-compatible" };
  const { host, deps, press } = mount(provider, "none", { catalog });
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 34,
  });
  await t.renderOnce();

  press("a");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Add provider");

  pressDowns(press, 2);
  press("return");
  await t.renderOnce();
  const modelsPick = t.captureCharFrame();
  expect(modelsPick).toContain("Add models");
  expect(modelsPick).toContain("m1");

  press("return");
  await t.renderOnce();

  press("escape");
  await t.renderOnce();
  const after = t.captureCharFrame();
  expect(after).toContain("Credential value");
  expect(after).toContain("ALPHA_API_KEY");
  t.renderer.destroy();
});

test("first-run setup guides provider and model selection, saves the key, and sets the default", async () => {
  const catalog = createModelsCatalog(protoCatalogFull("alpha"));
  const { host, deps, press, notes, saved, writes, closed } = mount(undefined, "none", {
    catalog,
  });
  const completed: { model: string; reconnectRequired: boolean }[] = [];
  const t = await openRender(
    (() =>
      ProvidersPanel(host, {
        ...deps,
        bootstrap: true,
        onBootstrapComplete: (result) => completed.push(result),
      })) as never,
    {
      width: 100,
      height: 34,
    },
  );

  let frame = await captureUntil(t, "Step 1 of 2");
  expect(frame).toContain(".d8888b.");
  expect(frame).toContain("Set up Clarvis");
  expect(frame).toContain("Step 1 of 2");
  expect(frame).toContain("alpha");

  pressDowns(press, 2);
  press("return");
  frame = await captureUntil(t, "Step 2 of 2");
  expect(frame).toContain(".d8888b.");
  expect(frame).toContain("Step 2 of 2");
  expect(frame).toContain("m1");

  press("return");
  frame = await captureUntil(t, "ALPHA_API_KEY");
  expect(frame).toContain("API key");
  await t.mockInput.typeText("sk-first-run");
  press("return");
  for (let i = 0; i < 6; i++) await Promise.resolve();

  expect(saved.ALPHA_API_KEY).toBe("sk-first-run");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    scope: "global",
    patch: {
      default_model: "alpha/m1",
      providers: [
        {
          name: "alpha",
          models: {
            m1: {
              context_window_tokens: 32000,
              max_output_tokens: 4096,
              capabilities: ["tool_calling"],
            },
          },
        },
      ],
    },
  });
  expect(notes).toContain("Setup complete — alpha/m1 is ready");
  expect(completed).toEqual([{ model: "alpha/m1", reconnectRequired: true }]);
  expect(closed).toEqual([1]);
  expect(host.dirty()).toBe(false);
  t.renderer.destroy();
});

test("first-run Escape closes provider and model pickers back to setup without saving", async () => {
  const catalog = createModelsCatalog(protoCatalogFull("alpha"));
  const providerStage = mount(undefined, "none", { catalog });
  const providerView = await openRender(
    (() =>
      ProvidersPanel(providerStage.host, {
        ...providerStage.deps,
        bootstrap: true,
        onBootstrapComplete: () => {},
      })) as never,
    { width: 100, height: 34 },
  );

  await captureUntil(providerView, "Step 1 of 2");
  providerStage.press("escape");
  await providerView.renderOnce();
  expect(providerStage.closed).toEqual([1]);
  expect(providerStage.writes).toEqual([]);
  providerView.renderer.destroy();

  const modelStage = mount(undefined, "none", { catalog });
  const modelView = await openRender(
    (() =>
      ProvidersPanel(modelStage.host, {
        ...modelStage.deps,
        bootstrap: true,
        onBootstrapComplete: () => {},
      })) as never,
    { width: 100, height: 34 },
  );

  await captureUntil(modelView, "Step 1 of 2");
  pressDowns(modelStage.press, 2);
  modelStage.press("return");
  await captureUntil(modelView, "Step 2 of 2");
  modelStage.press("escape");
  await modelView.renderOnce();
  expect(modelStage.closed).toEqual([1]);
  expect(modelStage.writes).toEqual([]);
  modelView.renderer.destroy();
});

test("first-run ChatGPT subscription login clears its code and guides entitled model selection", async () => {
  const { host, deps, press, writes, closed } = mount(undefined, "none");
  let finishWait!: () => void;
  const waitBarrier = new Promise<void>((resolve) => {
    finishWait = resolve;
  });
  const providerAuth: ProviderAuthService = {
    list: async () => [
      {
        scheme: "openai-codex",
        state: "disconnected",
        authorization_available: true,
      },
      { scheme: "xai-grok", state: "disconnected", authorization_available: true },
    ],
    startDevice: async () => ({
      attempt_id: "attempt-public",
      verification_url: "https://auth.example.test/device",
      user_code: "SAFE-CODE",
      expires_at: Date.now() + 60_000,
      polling_interval_ms: 1_000,
    }),
    wait: async () => {
      await waitBarrier;
      return {
        scheme: "openai-codex",
        state: "connected",
        authorization_available: true,
        plan: "Plus",
      };
    },
    cancel: async () => {},
    disconnect: async () => {},
  };
  const modelsService: ModelCatalogService = {
    get: async () => ({ source: "bundle", providers: [] }),
    refresh: async () => ({ source: "bundle", providers: [] }),
    getEntitled: async () => ({
      id: "openai-codex",
      name: "ChatGPT subscription",
      kind: "openai-codex",
      needs_base_url: false,
      models: [
        {
          id: "gpt-codex",
          context_window: 200_000,
          capabilities: ["tool_calling"],
          reasoning_efforts: ["low", "medium", "high"],
        },
      ],
    }),
    refreshEntitled: async (scheme) => modelsService.getEntitled(scheme),
  };
  const completed: string[] = [];
  const t = await openRender(
    (() =>
      ProvidersPanel(host, {
        ...deps,
        providerAuth,
        modelsService,
        bootstrap: true,
        onBootstrapComplete: ({ model }) => completed.push(model),
      })) as never,
    { width: 140, height: 34 },
  );

  await t.renderOnce();
  press("a");
  await captureUntil(t, "ChatGPT subscription");
  press("return");
  let frame = await captureUntil(t, "SAFE-CODE");
  expect(frame).toContain("URL: https:/");
  expect(frame).toContain("e.test/device");
  finishWait();
  frame = await captureUntil(t, "gpt-codex");
  expect(frame).not.toContain("SAFE-CODE");
  press("return");
  for (let i = 0; i < 8; i++) await Promise.resolve();

  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    scope: "global",
    patch: {
      default_model: "chatgpt/gpt-codex",
      providers: [
        {
          name: "chatgpt",
          kind: "openai-codex",
          models: { "gpt-codex": { context_window_tokens: 200_000 } },
        },
      ],
    },
  });
  expect(completed).toEqual(["chatgpt/gpt-codex"]);
  expect(closed).toEqual([1]);
  t.renderer.destroy();
});

test("first-run subscription catalog failure completes through manual model entry", async () => {
  const { host, deps, press, writes, closed } = mount(undefined, "none");
  const providerAuth: ProviderAuthService = {
    list: async () => [
      { scheme: "openai-codex", state: "connected", authorization_available: true },
      { scheme: "xai-grok", state: "disconnected", authorization_available: true },
    ],
    startDevice: async () => {
      throw new Error("already connected");
    },
    wait: async () => {
      throw new Error("already connected");
    },
    cancel: async () => {},
    disconnect: async () => {},
  };
  const modelsService: ModelCatalogService = {
    get: async () => ({ source: "bundle", providers: [] }),
    refresh: async () => ({ source: "bundle", providers: [] }),
    getEntitled: async () => {
      throw new Error("catalog unavailable");
    },
    refreshEntitled: async () => {
      throw new Error("catalog unavailable");
    },
  };
  const completed: string[] = [];
  const t = await openRender(
    (() =>
      ProvidersPanel(host, {
        ...deps,
        providerAuth,
        modelsService,
        bootstrap: true,
        onBootstrapComplete: ({ model }) => completed.push(model),
      })) as never,
    { width: 120, height: 34 },
  );

  await captureUntil(t, "connected");
  press("return");
  await captureUntil(t, "Unverified entitlement");
  press("return");
  await captureUntil(t, "Model ID");
  await t.mockInput.typeText("gpt-manual");
  press("return");
  for (let i = 0; i < 8; i++) await Promise.resolve();

  expect(writes[0]).toMatchObject({
    scope: "global",
    patch: {
      default_model: "chatgpt/gpt-manual",
      providers: [
        {
          name: "chatgpt",
          kind: "openai-codex",
          models: { "gpt-manual": { context_window_tokens: 128000 } },
        },
      ],
    },
  });
  expect(completed).toEqual(["chatgpt/gpt-manual"]);
  expect(closed).toEqual([1]);
  t.renderer.destroy();
});

test("workspace provider scope refuses personal subscription setup", async () => {
  const { host, deps, press, notes } = mount(undefined, "none", {
    initialScope: "workspace",
  });
  let starts = 0;
  const providerAuth: ProviderAuthService = {
    list: async () => [
      { scheme: "openai-codex", state: "disconnected", authorization_available: true },
    ],
    startDevice: async () => {
      starts += 1;
      throw new Error("must not start");
    },
    wait: async () => {
      throw new Error("must not wait");
    },
    cancel: async () => {},
    disconnect: async () => {},
  };
  const t = await openRender((() => ProvidersPanel(host, { ...deps, providerAuth })) as never, {
    width: 120,
    height: 34,
  });
  await t.renderOnce();
  press("a");
  const frame = await captureUntil(t, "Switch to global scope");
  expect(frame).toContain("ChatGPT subscription");
  press("return");
  await Promise.resolve();
  expect(starts).toBe(0);
  expect(notes).toContain("Subscriptions can be configured only in global scope");
  t.renderer.destroy();
});

test("first-run save retries complete setup with the staged credential", async () => {
  const catalog = createModelsCatalog(protoCatalogFull("alpha"));
  const mounted = mount(undefined, "none", { catalog });
  const { host, controls, press, notes, writes, saved, closed } = mounted;
  const baseSettings = mounted.deps.settings;
  let attempts = 0;
  mounted.deps.settings = {
    ...baseSettings,
    write: async (scope, patch) => {
      attempts += 1;
      if (attempts === 1) throw new Error("settings unavailable");
      await baseSettings.write(scope, patch);
    },
  };
  const completed: string[] = [];
  const t = await openRender(
    (() =>
      ProvidersPanel(host, {
        ...mounted.deps,
        bootstrap: true,
        onBootstrapComplete: ({ model }) => completed.push(model),
      })) as never,
    { width: 120, height: 34 },
  );

  await captureUntil(t, "Step 1 of 2");
  pressDowns(press, 2);
  press("return");
  await captureUntil(t, "Step 2 of 2");
  press("return");
  await captureUntil(t, "ALPHA_API_KEY");
  await t.mockInput.typeText("sk-retry");
  press("return");
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(notes.some((note) => note.includes("settings unavailable"))).toBe(true);
  expect(completed).toEqual([]);

  await controls.runSave();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(attempts).toBe(2);
  expect(saved.ALPHA_API_KEY).toBe("sk-retry");
  expect(writes).toHaveLength(1);
  expect(completed).toEqual(["alpha/m1"]);
  expect(closed).toEqual([1]);
  t.renderer.destroy();
});

test("Settings adds Grok beside ChatGPT without replacing either subscription", async () => {
  const chatgpt: ProviderConfig = {
    name: "chatgpt",
    kind: "openai-codex",
    models: { "gpt-codex": { context_window_tokens: 200_000 } },
  };
  const { host, controls, deps, press, writes } = mount(chatgpt, "none");
  const providerAuth: ProviderAuthService = {
    list: async () => [
      { scheme: "openai-codex", state: "connected", authorization_available: true },
      { scheme: "xai-grok", state: "connected", authorization_available: true },
    ],
    startDevice: async () => {
      throw new Error("already connected");
    },
    wait: async () => {
      throw new Error("already connected");
    },
    cancel: async () => {},
    disconnect: async () => {},
  };
  const modelsService: ModelCatalogService = {
    get: async () => ({ source: "bundle", providers: [] }),
    refresh: async () => ({ source: "bundle", providers: [] }),
    getEntitled: async (scheme) => ({
      id: scheme,
      name: scheme === "openai-codex" ? "ChatGPT subscription" : "Grok subscription",
      kind: scheme,
      needs_base_url: false,
      models: [
        {
          id: scheme === "openai-codex" ? "gpt-codex" : "grok-code",
          context_window: scheme === "openai-codex" ? 200_000 : 256_000,
          capabilities: ["tool_calling"],
        },
      ],
    }),
    refreshEntitled: async (scheme) => modelsService.getEntitled(scheme),
  };
  const t = await openRender(
    (() => ProvidersPanel(host, { ...deps, providerAuth, modelsService })) as never,
    { width: 120, height: 34 },
  );

  await captureUntil(t, "1 of 1 ready");
  press("a");
  await captureUntil(t, "Grok subscription");
  press("down");
  press("return");
  await captureUntil(t, "grok-code");
  press("return");
  await t.renderOnce();
  await controls.runSave();

  expect(writes).toHaveLength(1);
  expect(writes[0]?.patch.providers).toEqual([
    chatgpt,
    {
      name: "grok",
      kind: "xai-grok",
      models: {
        "grok-code": {
          context_window_tokens: 256_000,
          capabilities: ["tool_calling"],
        },
      },
    },
  ]);
  t.renderer.destroy();
});

test("subscription detail omits API-key and endpoint fields", async () => {
  const provider: ProviderConfig = {
    name: "grok",
    kind: "xai-grok",
    models: { "grok-code": { context_window_tokens: 256_000 } },
  };
  const { host, deps, press } = mount(provider, "none");
  const t = await openRender(
    (() =>
      ProvidersPanel(host, {
        ...deps,
        providerAuth: {
          list: async () => [
            {
              scheme: "xai-grok",
              state: "connected",
              authorization_available: true,
              plan: "Premium",
            },
          ],
          startDevice: async () => {
            throw new Error("not used");
          },
          wait: async () => {
            throw new Error("not used");
          },
          cancel: async () => {},
          disconnect: async () => {},
        },
      })) as never,
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Subscription");
  expect(t.captureCharFrame()).toContain("1 of 1 ready");
  press("return");
  const frame = await captureUntil(t, "connected");
  expect(frame).toContain("Premium");
  expect(frame).not.toContain("Base URL");
  expect(frame).not.toContain("Credential variable");
  expect(frame).not.toContain("Request headers");
  expect(frame).not.toContain("Request body");
  t.renderer.destroy();
});

test("subscription detail confirms and performs credential disconnect", async () => {
  const provider: ProviderConfig = {
    name: "grok",
    kind: "xai-grok",
    models: { "grok-code": { context_window_tokens: 256_000 } },
  };
  const { host, deps, press, notes } = mount(provider, "none");
  const disconnected: string[] = [];
  const t = await openRender(
    (() =>
      ProvidersPanel(host, {
        ...deps,
        providerAuth: {
          list: async () => [
            { scheme: "xai-grok", state: "connected", authorization_available: true },
          ],
          startDevice: async () => {
            throw new Error("not used");
          },
          wait: async () => {
            throw new Error("not used");
          },
          cancel: async () => {},
          disconnect: async (scheme) => {
            disconnected.push(scheme);
          },
        },
      })) as never,
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  press("return");
  await captureUntil(t, "connected");
  pressDowns(press, 2);
  press("return");
  const confirm = await captureUntil(t, "disconnect Grok subscription?");
  expect(confirm).toContain("[y] disconnect");
  press("y");
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(disconnected).toEqual(["xai-grok"]);
  expect(notes).toContain("Grok subscription disconnected");
  t.renderer.destroy();
});

test("device login actions copy, open, and cancel only the public authorization values", async () => {
  const { host, deps, press, notes } = mount(undefined, "none");
  const copied: string[] = [];
  const opened: string[] = [];
  const cancelled: string[] = [];
  const providerAuth: ProviderAuthService = {
    list: async () => [
      { scheme: "openai-codex", state: "disconnected", authorization_available: true },
      { scheme: "xai-grok", state: "disconnected", authorization_available: true },
    ],
    startDevice: async () => ({
      attempt_id: "attempt-public",
      verification_url: "https://auth.example.test/device",
      user_code: "SAFE-CODE",
      expires_at: Date.now() + 60_000,
      polling_interval_ms: 1_000,
    }),
    wait: () => new Promise(() => {}),
    cancel: async (id) => {
      cancelled.push(id);
    },
    disconnect: async () => {},
  };
  const t = await openRender(
    (() =>
      ProvidersPanel(host, {
        ...deps,
        providerAuth,
        copyText: async (value) => {
          copied.push(value);
          return true;
        },
        openUrl: async (value) => {
          opened.push(value);
          return true;
        },
      })) as never,
    { width: 120, height: 34 },
  );

  await t.renderOnce();
  press("a");
  await captureUntil(t, "ChatGPT subscription");
  press("return");
  await captureUntil(t, "SAFE-CODE");
  press("return");
  await Promise.resolve();
  expect(copied).toContain("SAFE-CODE");
  expect(notes).toContain("Login code copied");
  const copiedCodeFrame = await captureUntil(t, "Copied to clipboard");
  expect(copiedCodeFrame).toContain(glyph("success"));

  press("down");
  press("return");
  await Promise.resolve();
  expect(opened).toContain("https://auth.example.test/device");
  const openedFrame = await captureUntil(t, "Browser opened");
  expect(openedFrame).toContain(glyph("success"));

  press("down");
  press("return");
  await Promise.resolve();
  expect(copied).toContain("https://auth.example.test/device");
  expect(notes).toContain("Verification URL copied");
  const copiedUrlFrame = await captureUntil(t, "Copied to clipboard");
  expect(copiedUrlFrame).toContain("verification URL");

  press("down");
  press("return");
  await Promise.resolve();
  expect(cancelled).toEqual(["attempt-public"]);
  t.renderer.destroy();
});

test("device login renders progress in place while clipboard and browser actions are pending", async () => {
  const { host, deps, press } = mount(undefined, "none");
  let finishCopy: ((ok: boolean) => void) | undefined;
  let finishOpen: ((ok: boolean) => void) | undefined;
  const providerAuth: ProviderAuthService = {
    list: async () => [
      { scheme: "openai-codex", state: "disconnected", authorization_available: true },
    ],
    startDevice: async () => ({
      attempt_id: "attempt-public",
      verification_url: "https://auth.example.test/device",
      user_code: "SAFE-CODE",
      expires_at: Date.now() + 60_000,
      polling_interval_ms: 1_000,
    }),
    wait: () => new Promise(() => {}),
    cancel: async () => {},
    disconnect: async () => {},
  };
  const t = await openRender(
    (() =>
      ProvidersPanel(host, {
        ...deps,
        providerAuth,
        copyText: () => new Promise<boolean>((resolve) => (finishCopy = resolve)),
        openUrl: () => new Promise<boolean>((resolve) => (finishOpen = resolve)),
      })) as never,
    { width: 120, height: 34 },
  );

  await t.renderOnce();
  press("a");
  await captureUntil(t, "ChatGPT subscription");
  press("return");
  await captureUntil(t, "SAFE-CODE");
  press("return");
  const pending = await captureUntil(t, "Copying to clipboard");
  expect(pending).not.toContain("Copied to clipboard");

  finishCopy?.(true);
  const copied = await captureUntil(t, "Copied to clipboard");
  expect(copied).toContain(glyph("success"));
  expect(copied).toContain("login code");

  press("down");
  press("return");
  const opening = await captureUntil(t, "Opening browser");
  expect(opening).not.toContain("Browser opened");

  finishOpen?.(true);
  const opened = await captureUntil(t, "Browser opened");
  expect(opened).toContain(glyph("success"));
  expect(opened).toContain("verification URL");
  t.renderer.destroy();
});

test("unmounting an active device login cancels its bounded kernel attempt", async () => {
  const { host, deps, press } = mount(undefined, "none");
  const cancelled: string[] = [];
  const t = await openRender(
    (() =>
      ProvidersPanel(host, {
        ...deps,
        providerAuth: {
          list: async () => [
            { scheme: "openai-codex", state: "disconnected", authorization_available: true },
          ],
          startDevice: async () => ({
            attempt_id: "attempt-public",
            verification_url: "https://auth.example.test/device",
            user_code: "SAFE-CODE",
            expires_at: Date.now() + 60_000,
            polling_interval_ms: 1_000,
          }),
          wait: () => new Promise(() => {}),
          cancel: async (id) => {
            cancelled.push(id);
          },
          disconnect: async () => {},
        },
      })) as never,
    { width: 120, height: 34 },
  );
  await t.renderOnce();
  press("a");
  await captureUntil(t, "ChatGPT subscription");
  press("return");
  await captureUntil(t, "SAFE-CODE");
  t.renderer.destroy();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(cancelled).toEqual(["attempt-public"]);
});

test("device login actions explain unavailable and failed local integrations", async () => {
  const providerAuth = (): ProviderAuthService => ({
    list: async () => [
      { scheme: "openai-codex", state: "disconnected", authorization_available: true },
    ],
    startDevice: async () => ({
      attempt_id: "attempt-public",
      verification_url: "https://auth.example.test/device",
      user_code: "SAFE-CODE",
      expires_at: Date.now() + 60_000,
      polling_interval_ms: 1_000,
    }),
    wait: () => new Promise(() => {}),
    cancel: async () => {},
    disconnect: async () => {},
  });
  const openPicker = async (
    overrides: Partial<Pick<Parameters<typeof ProvidersPanel>[1], "copyText" | "openUrl">>,
  ) => {
    const mounted = mount(undefined, "none");
    const t = await openRender(
      (() =>
        ProvidersPanel(mounted.host, {
          ...mounted.deps,
          providerAuth: providerAuth(),
          ...overrides,
        })) as never,
      { width: 120, height: 34 },
    );
    await t.renderOnce();
    mounted.press("a");
    await captureUntil(t, "ChatGPT subscription");
    mounted.press("return");
    await captureUntil(t, "SAFE-CODE");
    return { ...mounted, t };
  };

  const unavailable = await openPicker({});
  unavailable.press("return");
  await Promise.resolve();
  expect(unavailable.notes).toContain("Clipboard unavailable");
  unavailable.press("down");
  unavailable.press("return");
  await Promise.resolve();
  expect(unavailable.notes.some((note) => note.includes("Browser opening is unavailable"))).toBe(
    true,
  );
  unavailable.t.renderer.destroy();

  const failed = await openPicker({ copyText: async () => false, openUrl: async () => false });
  failed.press("return");
  for (let i = 0; i < 4; i++) await Promise.resolve();
  expect(failed.notes).toContain("clipboard unavailable");
  failed.press("down");
  failed.press("return");
  for (let i = 0; i < 4; i++) await Promise.resolve();
  expect(failed.notes).toContain("browser could not open the URL");
  failed.t.renderer.destroy();
});

test("an expired device attempt clears the public code and guides reauthentication", async () => {
  const { host, deps, press, notes } = mount(undefined, "none");
  const t = await openRender(
    (() =>
      ProvidersPanel(host, {
        ...deps,
        providerAuth: {
          list: async () => [
            { scheme: "openai-codex", state: "disconnected", authorization_available: true },
          ],
          startDevice: async () => ({
            attempt_id: "attempt-public",
            verification_url: "https://auth.example.test/device",
            user_code: "SAFE-CODE",
            expires_at: Date.now() + 60_000,
            polling_interval_ms: 1_000,
          }),
          wait: async () => ({
            scheme: "openai-codex",
            state: "expired",
            authorization_available: true,
          }),
          cancel: async () => {},
          disconnect: async () => {},
        },
      })) as never,
    { width: 120, height: 34 },
  );
  await t.renderOnce();
  press("a");
  await captureUntil(t, "ChatGPT subscription");
  press("return");
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await t.renderOnce();
  expect(notes).toContain("Device login expired; start a new login");
  expect(t.captureCharFrame()).not.toContain("SAFE-CODE");
  t.renderer.destroy();
});

test("a non-terminal device outcome closes login without claiming connection", async () => {
  const { host, deps, press, notes } = mount(undefined, "none");
  const t = await openRender(
    (() =>
      ProvidersPanel(host, {
        ...deps,
        providerAuth: {
          list: async () => [
            { scheme: "openai-codex", state: "disconnected", authorization_available: true },
          ],
          startDevice: async () => ({
            attempt_id: "attempt-public",
            verification_url: "https://auth.example.test/device",
            user_code: "SAFE-CODE",
            expires_at: Date.now() + 60_000,
            polling_interval_ms: 1_000,
          }),
          wait: async () => ({
            scheme: "openai-codex",
            state: "disconnected",
            authorization_available: true,
          }),
          cancel: async () => {},
          disconnect: async () => {},
        },
      })) as never,
    { width: 120, height: 34 },
  );
  await t.renderOnce();
  press("a");
  await captureUntil(t, "ChatGPT subscription");
  press("return");
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(notes).toContain("Device login did not complete");
  expect(notes).not.toContain("ChatGPT subscription connected");
  t.renderer.destroy();
});

test("device start and polling failures clear transient authorization state", async () => {
  const run = async (failAt: "start" | "wait") => {
    const mounted = mount(undefined, "none");
    const t = await openRender(
      (() =>
        ProvidersPanel(mounted.host, {
          ...mounted.deps,
          providerAuth: {
            list: async () => [
              { scheme: "openai-codex", state: "disconnected", authorization_available: true },
            ],
            startDevice: async () => {
              if (failAt === "start") throw new Error("start refused");
              return {
                attempt_id: "attempt-public",
                verification_url: "https://auth.example.test/device",
                user_code: "SAFE-CODE",
                expires_at: Date.now() + 60_000,
                polling_interval_ms: 1_000,
              };
            },
            wait: async () => {
              throw new Error("poll refused");
            },
            cancel: async () => {},
            disconnect: async () => {},
          },
        })) as never,
      { width: 120, height: 34 },
    );
    await t.renderOnce();
    mounted.press("a");
    await captureUntil(t, "ChatGPT subscription");
    mounted.press("return");
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await t.renderOnce();
    return { ...mounted, t };
  };

  const start = await run("start");
  expect(start.notes.some((note) => note.includes("start refused"))).toBe(true);
  start.t.renderer.destroy();
  const wait = await run("wait");
  expect(wait.notes.some((note) => note.includes("poll refused"))).toBe(true);
  expect(wait.t.captureCharFrame()).not.toContain("SAFE-CODE");
  wait.t.renderer.destroy();
});

test("subscription rows fail closed when authorization or entitled catalogs are unavailable", async () => {
  const open = async (status: SubscriptionAccountStatus) => {
    const mounted = mount(undefined, "none");
    const t = await openRender(
      (() =>
        ProvidersPanel(mounted.host, {
          ...mounted.deps,
          providerAuth: {
            list: async () => [status],
            startDevice: async () => {
              throw new Error("must not start");
            },
            wait: async () => {
              throw new Error("must not wait");
            },
            cancel: async () => {},
            disconnect: async () => {},
          },
        })) as never,
      { width: 120, height: 34 },
    );
    await t.renderOnce();
    mounted.press("a");
    await captureUntil(t, "ChatGPT subscription");
    mounted.press("return");
    for (let i = 0; i < 6; i++) await Promise.resolve();
    return { ...mounted, t };
  };

  const unauthorized = await open({
    scheme: "openai-codex",
    state: "unavailable",
    authorization_available: false,
  });
  expect(unauthorized.notes).toContain("Integration not enabled in this build");
  unauthorized.t.renderer.destroy();

  const noCatalog = await open({
    scheme: "openai-codex",
    state: "connected",
    authorization_available: true,
  });
  expect(noCatalog.notes).toContain("Subscription model catalog is unavailable in this client");
  noCatalog.t.renderer.destroy();
});

test("an entitled-catalog failure keeps the connected subscription and offers manual model entry", async () => {
  const { host, deps, press, notes } = mount(undefined, "none");
  const providerAuth: ProviderAuthService = {
    list: async () => [
      { scheme: "openai-codex", state: "connected", authorization_available: true },
      { scheme: "xai-grok", state: "disconnected", authorization_available: true },
    ],
    startDevice: async () => {
      throw new Error("not used");
    },
    wait: async () => {
      throw new Error("not used");
    },
    cancel: async () => {},
    disconnect: async () => {},
  };
  const modelsService: ModelCatalogService = {
    get: async () => ({ source: "bundle", providers: [] }),
    refresh: async () => ({ source: "bundle", providers: [] }),
    getEntitled: async () => {
      throw new Error("catalog unavailable");
    },
    refreshEntitled: async () => {
      throw new Error("catalog unavailable");
    },
  };
  const t = await openRender(
    (() => ProvidersPanel(host, { ...deps, providerAuth, modelsService })) as never,
    { width: 120, height: 34 },
  );
  await t.renderOnce();
  press("a");
  await captureUntil(t, "connected");
  press("return");
  const frame = await captureUntil(t, "Unverified entitlement");
  expect(frame).toContain("manual model");
  expect(notes.some((note) => note.includes("catalog unavailable"))).toBe(true);
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Model ID");
  t.renderer.destroy();
});

test("first-run manual entry guides a local endpoint through creating its first model", async () => {
  const catalog = createModelsCatalog(protoCatalogFull("alpha"));
  const { host, deps, press, writes, closed } = mount(undefined, "none", { catalog });
  const completed: { model: string; reconnectRequired: boolean }[] = [];
  const t = await openRender(
    (() =>
      ProvidersPanel(host, {
        ...deps,
        bootstrap: true,
        onBootstrapComplete: (result) => completed.push(result),
      })) as never,
    { width: 120, height: 34 },
  );

  await captureUntil(t, "Step 1 of 2");
  pressDowns(press, 4); // subscriptions, alpha, Browse all providers, manual entry
  press("return");
  let frame = await captureUntil(t, "Manual provider setup");
  expect(frame).toContain("Set up Clarvis");
  expect(frame).toContain("1. Set a provider name, API type, and endpoint.");
  expect(frame).toContain("Press A to create its model.");

  press("a");
  frame = await captureUntil(t, "Step 2 of 2");
  expect(frame).toContain("Model ID");
  await t.mockInput.typeText("qwen2.5-coder:7b");
  press("return");
  for (let i = 0; i < 6; i++) await Promise.resolve();

  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    scope: "global",
    patch: {
      default_model: "provider-1/qwen2.5-coder:7b",
      providers: [
        {
          name: "provider-1",
          kind: "openai-compatible",
          models: { "qwen2.5-coder:7b": { context_window_tokens: 128000 } },
        },
      ],
    },
  });
  expect(completed).toEqual([{ model: "provider-1/qwen2.5-coder:7b", reconnectRequired: false }]);
  expect(closed).toEqual([1]);
  t.renderer.destroy();
});

test("adding models with no catalog goes straight to manual entry", async () => {
  const provider: ProviderConfig = { name: "local", kind: "openai-compatible" };
  const { host, deps, press } = mount(provider, "none");
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  press("a");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Model ID");
  await t.mockInput.typeText("custom-model");
  press("return");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Model ID");
  expect(frame).toContain("custom-model");
  t.renderer.destroy();
});

test("adding models resolves the matching catalog provider directly, skipping the source picker", async () => {
  const catalog = createModelsCatalog(protoCatalogFull("alpha"));
  const provider: ProviderConfig = {
    name: "custom",
    kind: "openai-compatible",
    base_url: "https://example.invalid/v1",
  };
  const { host, deps, press } = mount(provider, "none", { catalog });
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  press("a");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Add models");
  expect(frame).toContain("alpha");
  expect(frame).not.toContain("No catalog match");
  t.renderer.destroy();
});

test("adding models with no direct catalog match offers a source-provider picker", async () => {
  const catalog = createModelsCatalog(protoCatalogFull("alpha"));
  const provider: ProviderConfig = { name: "custom", kind: "anthropic" };
  const { host, deps, press } = mount(provider, "none", { catalog });
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  press("a");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("No catalog match");

  press("return");
  await t.renderOnce();
  const modelsPick = t.captureCharFrame();
  expect(modelsPick).toContain("Add models");
  expect(modelsPick).toContain("m1");

  press("escape");
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("Credential value" + " " + glyph("arrowRight"));
  t.renderer.destroy();
});

test("adding models to a connected subscription opens its entitled catalog", async () => {
  const provider: ProviderConfig = {
    name: "chatgpt",
    kind: "openai-codex",
    models: { "gpt-existing": { context_window_tokens: 200_000 } },
  };
  const { host, deps, press } = mount(provider, "none", {
    catalog: createModelsCatalog(protoCatalogFull("alpha")),
  });
  const providerAuth: ProviderAuthService = {
    list: async () => [
      { scheme: "openai-codex", state: "connected", authorization_available: true },
    ],
    startDevice: async () => {
      throw new Error("already connected");
    },
    wait: async () => {
      throw new Error("already connected");
    },
    cancel: async () => {},
    disconnect: async () => {},
  };
  let entitledReads = 0;
  const modelsService: ModelCatalogService = {
    get: async () => ({ source: "bundle", providers: [] }),
    refresh: async () => ({ source: "bundle", providers: [] }),
    getEntitled: async () => {
      entitledReads += 1;
      return {
        id: "openai-codex",
        name: "ChatGPT subscription",
        kind: "openai-codex",
        needs_base_url: false,
        models: [
          { id: "gpt-existing", context_window: 200_000 },
          { id: "gpt-new", context_window: 272_000 },
        ],
      };
    },
    refreshEntitled: async (scheme) => modelsService.getEntitled(scheme),
  };
  const t = await openRender(
    (() => ProvidersPanel(host, { ...deps, providerAuth, modelsService })) as never,
    { width: 120, height: 34 },
  );

  await captureUntil(t, "1 of 1 ready");
  press("return");
  await captureUntil(t, "Subscription");
  press("a");
  let frame = await captureUntil(t, "gpt-new");
  expect(frame).toContain("Add models");
  expect(frame).not.toContain("No catalog match");
  expect(entitledReads).toBe(1);

  press("escape");
  frame = await captureUntil(t, "Providers");
  expect(frame).toContain("Provider name");
  expect(frame).toContain("chatgpt");
  expect(frame).not.toContain("Model ID");
  t.renderer.destroy();
});

test("model detail owns one catalog fill while a no-match keeps 'f' inert", async () => {
  const matchingCatalog = createModelsCatalog(protoCatalogModel("beta", "glm-5.2"));
  const matching = mount(withModel, "OPENROUTER_API_KEY", { catalog: matchingCatalog });
  const filled = await drillToModelRow(matching.host, matching.deps);
  matching.press("return");
  await filled.renderOnce();
  pressDowns(matching.press, DETAIL_FIELD_COUNT);
  matching.press("return");
  await filled.renderOnce();
  expect(filled.captureCharFrame()).toContain("models.dev: glm-5.2");
  matching.press("f");
  await filled.renderOnce();
  expect(filled.captureCharFrame()).toMatch(/Context window\s+200000/);
  expect(filled.captureCharFrame()).toMatch(/Maximum output\s+8192/);
  matching.press("return");
  await filled.renderOnce();
  await filled.mockInput.typeText("0");
  matching.press("return");
  await filled.renderOnce();
  expect(filled.captureCharFrame()).toMatch(/Context window\s+2000000/);
  filled.renderer.destroy();

  const catalog = createModelsCatalog(protoCatalogModel("beta", "other-model"));
  const { host, deps, press } = mount(withModel, "OPENROUTER_API_KEY", { catalog });
  const t = await drillToModelRow(host, deps);
  press("return");
  await t.renderOnce();
  pressDowns(press, DETAIL_FIELD_COUNT);
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("not in the models.dev catalog");
  expect(t.captureCharFrame()).toContain("[a] at the provider level browses it");
  expect(t.captureCharFrame()).not.toContain("[m]");
  press("f");
  await t.renderOnce();
  expect(t.captureCharFrame()).toMatch(/Context window\s+128000/);
  t.renderer.destroy();
});

test("prompt_cache on an openai-compatible provider says the catalog's explicit is NOT derived", async () => {
  // The kernel caps derivation at "implicit" for this kind, so a note promising
  // "sends cache markers" would be the same lie the own-name lookup already
  // removed, in a second dress. Measured on OpenRouter: one upstream ignores the
  // marker outright, another turns a deterministic 92.5% hit rate into a 49-92%
  // lottery — which upstream serves a call is not the caller's to choose.
  const catalog = createModelsCatalog(
    protoPricedModel("openrouter", "glm-5.2", "openai-compatible"),
  );
  const { host, deps, press } = mount(withModel, "OPENROUTER_API_KEY", { catalog });
  const t = await drillToModelRow(host, deps);
  press("return");
  await t.renderOnce();
  pressDowns(press, DETAIL_FIELD_COUNT);
  press("return");
  const frame = await captureUntil(t, "Prompt cache");
  expect(frame).toContain("not derived");
  expect(frame).not.toContain("sends cache markers");
  t.renderer.destroy();
});

test("prompt_cache on the vendor's own SDK still reports the catalog's explicit as live", async () => {
  const anthropic: ProviderConfig = {
    name: "anthropic",
    kind: "anthropic",
    api_key_env: "OPENROUTER_API_KEY",
    models: { "glm-5.2": { context_window_tokens: 128000 } },
  };
  const catalog = createModelsCatalog(protoPricedModel("anthropic", "glm-5.2", "anthropic"));
  const { host, deps, press } = mount(anthropic, "OPENROUTER_API_KEY", { catalog });
  const t = await drillToModelRow(host, deps);
  press("return");
  await t.renderOnce();
  pressDowns(press, DETAIL_FIELD_COUNT);
  press("return");
  const frame = await captureUntil(t, "Prompt cache");
  expect(frame).toContain("sends cache markers");
  expect(frame).not.toContain("not derived");
  t.renderer.destroy();
});

test("save() from inside a provider's detail view jumps the cursor to the offending field", async () => {
  const provider: ProviderConfig = {
    name: "local",
    kind: "openai-compatible",
    base_url: "https://x.invalid/v1",
  };
  const issue: FieldIssue = { field: "api_key_env", provider: "local", message: "needs a key" };
  const { host, controls, deps, press } = mount(provider, "none", { issues: [issue] });
  const t = await openRender((() => ProvidersPanel(host, deps)) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  expect(selectedFieldLabel(t.captureCharFrame())).toBe("Provider name");

  await controls.runSave();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("✗ needs a key");
  expect(selectedFieldLabel(frame)).toBe("Credential variable");
  t.renderer.destroy();
});

const PROVIDER_HEADERS_ROW = 6;
const PROVIDER_BODY_ROW = 7;
const MODEL_HEADERS_ROW = 3;

const withRouting: ProviderConfig = {
  name: "openrouter",
  kind: "openai-compatible",
  base_url: "https://openrouter.ai/api/v1",
  api_key_env: "OPENROUTER_API_KEY",
  body: { provider: { order: ["deepseek"], allow_fallbacks: false } },
  models: { "glm-5.2": { context_window_tokens: 128000 } },
};

test("provider detail counts the configured maps, and Enter opens headers as its own level", async () => {
  const provider: ProviderConfig = {
    ...withRouting,
    headers: { "X-Title": "clarvis", "HTTP-Referer": "https://example.test" },
  };
  const { host, controls, deps, press } = mount(provider, "OPENROUTER_API_KEY");
  const t = await drillToModelRow(host, deps);
  press("return");
  await t.renderOnce();
  const detail = t.captureCharFrame();
  expect(detail).toMatch(/headers\s+2 entries/);
  expect(detail).toMatch(/body\s+1 entry/);

  pressDowns(press, PROVIDER_HEADERS_ROW);
  press("return");
  await t.renderOnce();
  const map = t.captureCharFrame();
  expect(map).toContain("X-Title");
  expect(map).toContain("clarvis");
  expect(map).toContain("never paste a key here");
  expect(map).toContain("[a] add");
  expect(map).toContain("[d] delete");
  expect(map).not.toContain("Credential value");

  // Escape is the host shell's, and it only decrements the depth — the editor
  // has to notice that on its own or the map level outlives its own stack entry.
  controls.escape();
  await t.renderOnce();
  const back = t.captureCharFrame();
  expect(back).toContain("Credential value");
  expect(back).toMatch(/headers\s+2 entries/);
  t.renderer.destroy();
});

test("body drills into the routing block, so order/allow_fallbacks are ordinary rows", async () => {
  const { host, controls, deps, press } = mount(withRouting, "OPENROUTER_API_KEY");
  const t = await drillToModelRow(host, deps);
  press("return");
  pressDowns(press, PROVIDER_BODY_ROW);
  press("return");
  await t.renderOnce();
  const root = t.captureCharFrame();
  expect(root).toContain("provider");
  expect(root).toContain("{ 2 keys }");

  press("return");
  await t.renderOnce();
  const nested = t.captureCharFrame();
  expect(nested).toContain("order");
  expect(nested).toContain('["deepseek"]');
  expect(nested).toContain("allow_fallbacks");
  expect(nested).toContain("false");
  expect(nested).toContain("body " + glyph("chevronRight") + " provider");

  // One escape unwinds one drill, not the whole map: the level stack and the
  // path have to stay in step, and nothing but the depth tells the editor so.
  controls.escape();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("{ 2 keys }");
  controls.escape();
  await t.renderOnce();
  const back = t.captureCharFrame();
  expect(back).toContain("Credential value");
  expect(back).toMatch(/body\s+1 entry/);
  t.renderer.destroy();
});

test("[a] inside body offers the documented keys for the level it is on", async () => {
  const { host, deps, press } = mount(withRouting, "OPENROUTER_API_KEY");
  const t = await drillToModelRow(host, deps);
  press("return");
  pressDowns(press, PROVIDER_BODY_ROW);
  press("return");
  await t.renderOnce();
  press("a");
  await t.renderOnce();
  const rootPick = t.captureCharFrame();
  expect(rootPick).toContain("add to body");
  expect(rootPick).toContain("transforms");
  expect(rootPick).not.toContain("allow_fallbacks");

  press("escape");
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("allow_fallbacks");
  press("a");
  const nestedPick = await captureUntil(t, "manual entry");
  expect(nestedPick).toContain("add to body.provider");
  expect(nestedPick).toContain("only");
  expect(nestedPick).not.toContain("transforms");
  t.renderer.destroy();
});

test("a model carries its own headers and body, edited the same way", async () => {
  const provider: ProviderConfig = {
    ...withRouting,
    models: {
      "glm-5.2": { context_window_tokens: 128000, headers: { "X-Model": "${MODEL_TOKEN}" } },
    },
  };
  const { host, controls, deps, press } = mount(provider, "OPENROUTER_API_KEY");
  const t = await drillToModelRow(host, deps);
  press("return");
  pressDowns(press, DETAIL_FIELD_COUNT);
  press("return");
  await t.renderOnce();
  const model = t.captureCharFrame();
  expect(model).toMatch(/headers\s+1 entry/);
  expect(model).toContain("replaces the provider's value");

  pressDowns(press, MODEL_HEADERS_ROW);
  press("return");
  await t.renderOnce();
  const map = t.captureCharFrame();
  expect(map).toContain("X-Model");
  expect(map).toContain("${MODEL_TOKEN}");
  expect(map).toContain("this model");

  // Back to the MODEL level, not the provider's: the map level and the model
  // level share one depth range and are told apart only by which is active.
  controls.escape();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Context window");
  t.renderer.destroy();
});

test("a body on a kind with no request-body seam says so where it is authored", async () => {
  const provider: ProviderConfig = {
    name: "claude",
    kind: "anthropic",
    api_key_env: "ANTHROPIC_API_KEY",
    body: { top_k: 40 },
  };
  const { host, deps, press } = mount(provider, "ANTHROPIC_API_KEY");
  const t = await drillToModelRow(host, deps);
  press("return");
  pressDowns(press, PROVIDER_BODY_ROW);
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("no request-body seam");
  t.renderer.destroy();
});

test("a representative header submit stages a value, while malformed interpolation is refused", async () => {
  const provider: ProviderConfig = { ...withRouting, headers: { "X-Title": "clarvis" } };
  const { host, deps, press, notes } = mount(provider, "OPENROUTER_API_KEY");
  const t = await drillToModelRow(host, deps);
  press("return");
  pressDowns(press, PROVIDER_HEADERS_ROW);
  press("return");
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  await t.mockInput.typeText("-tui");
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("clarvis-tui");
  expect(host.dirty()).toBe(true);

  press("return");
  await t.renderOnce();
  await t.mockInput.typeText("${NOPE");
  press("return");
  await t.renderOnce();
  expect(notes.some((n) => n.includes("malformed"))).toBe(true);
  expect(t.captureCharFrame()).toContain("clarvis-tui");
  expect(t.captureCharFrame()).not.toContain("${NOPE");
  t.renderer.destroy();
});
