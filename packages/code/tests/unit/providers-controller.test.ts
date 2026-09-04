import { expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { createProvidersController } from "../../src/features/providers/controller.ts";
import { presentProvidersEvent } from "../../src/features/providers/events.ts";
import type {
  FieldIssue,
  ProviderConfig,
  Scope,
  SettingsAdapter,
  SettingsFile,
} from "../../src/adapters/settings.ts";
import type { KeysAdapter, KeySource } from "../../src/adapters/provider-secrets.ts";
import type { CodeConfigStore } from "../../src/adapters/code-config.ts";
import type {
  CatalogModel,
  CatalogProvider,
  ModelsCatalog,
} from "../../src/adapters/models-catalog.ts";

/**
 * Stand-in for a {@link SettingsAdapter} member the providers controller never
 * calls. Throwing rather than answering keeps the fake honest if that changes.
 */
function unusedSetting(member: string): never {
  throw new Error(`SettingsAdapter.${member} is not exercised by the providers controller suite`);
}

function fakeSettings(
  provider: ProviderConfig | undefined,
  opts?: {
    modelRefs?: (id: string) => { agents: string[]; defaultModel: boolean };
    defaultModel?: string;
    issues?: FieldIssue[];
  },
): SettingsAdapter & { written: { scope: string; file: unknown }[] } {
  const written: { scope: string; file: unknown }[] = [];
  return {
    written,
    version: () => 1,
    origin: () => "global",
    planRepair: () => null,
    applyRepair: async () => {},
    reload: async () => {},
    inspectSandbox: () => unusedSetting("inspectSandbox"),
    read: (scope: Scope) =>
      scope === "global"
        ? { providers: provider ? [provider] : [], default_model: opts?.defaultModel }
        : undefined,
    effectiveProviders: () => (provider ? [{ provider, origin: "global" }] : []),
    knownGrants: () => undefined,
    withheldWorkspaceFields: () => [],
    workspaceTrust: () => "inert",
    setWorkspaceTrust: async () => {},
    envStatus: () => "unset",
    validateProviders: () =>
      opts?.issues?.length ? { ok: false, issues: opts.issues } : { ok: true },
    refs: () => ({ agents: [], defaultModel: false }),
    modelRefs: opts?.modelRefs ?? (() => ({ agents: [], defaultModel: false })),
    effective: () => ({ providers: provider ? [provider] : [] }),
    corrupt: () => null,
    sources: () => ({ global: "/tmp/settings.json" }),
    write: async (scope: Scope, file: Partial<SettingsFile>) => {
      written.push({ scope, file });
    },
    declaredMcpServers: () => [],
  };
}

function fakeKeys(): KeysAdapter & { saved: Record<string, string> } {
  const saved: Record<string, string> = {};
  return {
    saved,
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
    updateCheckEnabled: () => true,
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
    writeUpdateCheckEnabled: () => {},
    hasWorkspace: () => false,
  };
}

function fakeCatalog(providers: CatalogProvider[]): ModelsCatalog {
  return {
    source: "bundle",
    providers: () => providers,
    provider: (id) => providers.find((p) => p.id === id || p.name === id),
    models: (providerId) => providers.find((p) => p.id === providerId)?.models ?? [],
    seed: (catalogProviderId, taken) => {
      const p = providers.find((c) => c.id === catalogProviderId);
      if (!p) return undefined;
      let name = p.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
      if (taken.has(name)) name = `${name}-2`;
      return {
        name,
        kind: p.kind,
        ...(p.base_url ? { base_url: p.base_url } : {}),
        ...(p.api_key_env ? { api_key_env: p.api_key_env } : {}),
      };
    },
    fill: (kind, modelId) => {
      for (const p of providers) {
        if (p.kind !== kind) continue;
        const hit = p.models.find((m) => m.modelId === modelId);
        if (hit) return hit;
      }
      return undefined;
    },
  };
}

function catalogModel(modelId: string, extra?: Partial<CatalogModel>): CatalogModel {
  return { modelId, ...extra };
}

function catalogProvider(extra: Partial<CatalogProvider> & { id: string }): CatalogProvider {
  return {
    id: extra.id,
    name: extra.name ?? extra.id,
    kind: extra.kind ?? "openai-compatible",
    needsBaseUrl: extra.needsBaseUrl ?? false,
    models: extra.models ?? [],
    ...(extra.base_url ? { base_url: extra.base_url } : {}),
    ...(extra.api_key_env ? { api_key_env: extra.api_key_env } : {}),
  };
}

function setup(
  provider: ProviderConfig | undefined,
  opts?: Parameters<typeof fakeSettings>[1] & {
    catalog?: ModelsCatalog | null;
    manageDefaultModel?: boolean;
  },
) {
  return createRoot((dispose) => {
    const settings = fakeSettings(provider, opts);
    const keys = fakeKeys();
    const code = fakeCode();
    const dirty: boolean[] = [];
    const notes: string[] = [];
    const reconnects: number[] = [];
    const ctrl = createProvidersController({
      settings,
      keys,
      code,
      catalog: opts?.catalog ?? null,
      scope: () => "global",
      markDirty: (v = true) => dirty.push(v),
      emit: (event) => notes.push(presentProvidersEvent(event).message),
      onReconnect: () => reconnects.push(1),
      manageDefaultModel: opts?.manageDefaultModel,
    });
    return { dispose, settings, keys, code, dirty, notes, reconnects, ctrl };
  });
}

test("load reads providers and clears pending state", () => {
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl, dirty, dispose } = setup(provider);
  ctrl.stageKey("ACME_API_KEY", "sk-x");
  expect(ctrl.pendingKeys().size).toBe(1);
  ctrl.load();
  expect(ctrl.providers().map((p) => p.name)).toEqual(["acme"]);
  expect(ctrl.pendingKeys().size).toBe(0);
  expect(dirty.at(-1)).toBe(false);
  dispose();
});

test("adding a provider updates the list and marks dirty", () => {
  const { ctrl, dirty, dispose } = setup(undefined);
  ctrl.load();
  ctrl.addBlankProvider();
  expect(ctrl.providers().length).toBe(1);
  expect(dirty.at(-1)).toBe(true);
  dispose();
});

test("a value edited back to its original clears the dirty mark", () => {
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl, dirty, dispose } = setup(provider);
  ctrl.load();
  ctrl.setProviderField(0, { kind: "anthropic" });
  expect(dirty.at(-1)).toBe(true);
  // Round-tripping the value leaves the bytes a save would write identical, so
  // "Unsaved" was a claim about nothing — and it armed the discard confirmation
  // on a decision the user had already reversed.
  ctrl.setProviderField(0, { kind: "openai-compatible" });
  expect(dirty.at(-1)).toBe(false);
  dispose();
});

test("a staged credential keeps the panel dirty even when every field is back to its original", () => {
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl, dirty, dispose } = setup(provider);
  ctrl.load();
  ctrl.stageKey("ACME_API_KEY", "secret");
  ctrl.setProviderField(0, { kind: "anthropic" });
  ctrl.setProviderField(0, { kind: "openai-compatible" });
  // The key never lands in settings.json, so it is not in the diff — it has to
  // be counted separately or it would be silently dropped.
  expect(dirty.at(-1)).toBe(true);
  dispose();
});

test("addBlankProvider appends an unused provider-N name", () => {
  const existing: ProviderConfig = { name: "provider-2", kind: "openai-compatible" };
  const { ctrl, dispose } = setup(existing);
  ctrl.load();
  const created = ctrl.addBlankProvider();
  expect(created.name).toBe("provider-3");
  expect(created.kind).toBe("openai-compatible");
  expect(ctrl.providers().length).toBe(2);
  dispose();
});

test("stageKey holds the value in memory and keyStatus reports staged", () => {
  const provider: ProviderConfig = {
    name: "acme",
    kind: "openai-compatible",
    api_key_env: "ACME_API_KEY",
  };
  const { ctrl, keys, notes, dispose } = setup(provider);
  ctrl.load();
  ctrl.stageKey("ACME_API_KEY", "sk-secret");
  expect(keys.saved["ACME_API_KEY"]).toBeUndefined();
  expect(ctrl.pendingKeys().get("ACME_API_KEY")).toBe("sk-secret");
  expect(ctrl.keyStatus(provider)).toBe("staged");
  expect(notes.some((n) => n.includes("key staged for ACME_API_KEY"))).toBe(true);
  dispose();
});

test("modelRemovalBlocked explains default_model and agent references", () => {
  const provider: ProviderConfig = {
    name: "acme",
    kind: "openai-compatible",
    models: { "m-1": { context_window_tokens: 128000 } },
  };
  const { ctrl, dispose } = setup(provider, {
    modelRefs: (id) => {
      if (id === "acme/m-1") return { agents: ["coder"], defaultModel: false };
      if (id === "acme/default") return { agents: [], defaultModel: true };
      return { agents: [], defaultModel: false };
    },
  });
  ctrl.load();
  expect(ctrl.modelRemovalBlocked(provider, "m-1")).toEqual({
    kind: "agent-references",
    model: "acme/m-1",
    agents: ["coder"],
  });
  expect(ctrl.modelRemovalBlocked(provider, "default")).toEqual({
    kind: "default-model",
    model: "acme/default",
  });
  expect(ctrl.modelRemovalBlocked(provider, "other")).toBeNull();
  dispose();
});

test("save with validation issues returns validation and writes nothing", async () => {
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const issue: FieldIssue = {
    field: "base_url",
    provider: "acme",
    message: "openai-compatible needs an http(s) base_url",
  };
  const { ctrl, settings, notes, dispose } = setup(provider, { issues: [issue] });
  ctrl.load();
  const result = await ctrl.save();
  expect(result).toBe("validation");
  expect(settings.written.length).toBe(0);
  expect(notes.some((n) => n.includes("cannot save"))).toBe(true);
  const check = ctrl.validation();
  expect(check.ok).toBe(false);
  dispose();
});

test("save writes settings and staged keys, then reconnects", async () => {
  const provider: ProviderConfig = {
    name: "acme",
    kind: "openai-compatible",
    api_key_env: "ACME_API_KEY",
  };
  const { ctrl, settings, keys, code, reconnects, dispose } = setup(provider);
  ctrl.load();
  ctrl.stageKey("ACME_API_KEY", "sk-secret");
  ctrl.stageSource("ACME_API_KEY", "keyfile");
  const result = await ctrl.save();
  expect(result).toBe("ok");
  expect(settings.written.length).toBe(1);
  expect(keys.saved["ACME_API_KEY"]).toBe("sk-secret");
  expect(ctrl.pendingKeys().size).toBe(0);
  expect(ctrl.pendingSources().size).toBe(0);
  expect(code.keySource("ACME_API_KEY")).toBe("keyfile");
  expect(reconnects.length).toBe(1);
  dispose();
});

test("ordinary provider saves never co-write a stale default_model", async () => {
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl, settings, dispose } = setup(provider, { defaultModel: "acme/old" });
  ctrl.load();
  ctrl.setProviderField(0, { base_url: "https://example.test/v1" });
  expect(await ctrl.save()).toBe("ok");
  expect(settings.written).toEqual([
    {
      scope: "global",
      file: { providers: [{ ...provider, base_url: "https://example.test/v1" }] },
    },
  ]);
  dispose();
});

test("dispose prevents an in-flight save from publishing or continuing with staged secrets", async () => {
  const provider: ProviderConfig = {
    name: "acme",
    kind: "openai-compatible",
    api_key_env: "ACME_API_KEY",
  };
  const { ctrl, settings, keys, notes, reconnects, dispose } = setup(provider);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  settings.write = async () => gate;
  ctrl.load();
  ctrl.stageKey("ACME_API_KEY", "sk-secret");
  const saving = ctrl.save();
  ctrl.dispose();
  release();
  expect(await saving).toBe("ok");
  expect(keys.saved["ACME_API_KEY"]).toBeUndefined();
  expect(reconnects).toHaveLength(0);
  expect(notes.some((note) => note.includes("saved providers"))).toBe(false);
  dispose();
});

test("save reports key-error and stops when a key write throws", async () => {
  const provider: ProviderConfig = {
    name: "acme",
    kind: "openai-compatible",
    api_key_env: "ACME_API_KEY",
  };
  const settings = fakeSettings(provider);
  const notes: string[] = [];
  const reconnects: number[] = [];
  const boom = new Error("keyring locked");
  const keys: KeysAdapter = {
    has: () => false,
    set: async () => {
      throw boom;
    },
    reload: async () => {},
  };
  const result = await createRoot(async (dispose) => {
    const ctrl = createProvidersController({
      settings,
      keys,
      code: fakeCode(),
      catalog: null,
      scope: () => "global",
      markDirty: () => {},
      emit: (event) => notes.push(presentProvidersEvent(event).message),
      onReconnect: () => reconnects.push(1),
    });
    ctrl.load();
    ctrl.stageKey("ACME_API_KEY", "sk-secret");
    const outcome = await ctrl.save();
    expect(ctrl.pendingKeys().get("ACME_API_KEY")).toBe("sk-secret");
    dispose();
    return outcome;
  });
  expect(result).toBe("key-error");
  expect(notes.some((n) => n.includes("key save failed for ACME_API_KEY: keyring locked"))).toBe(
    true,
  );
  expect(reconnects).toHaveLength(0);
});

test("save reports source-error and stops when writeKeySource throws, after keys already saved", async () => {
  const provider: ProviderConfig = {
    name: "acme",
    kind: "openai-compatible",
    api_key_env: "ACME_API_KEY",
  };
  const settings = fakeSettings(provider);
  const notes: string[] = [];
  const savedKeys: Record<string, string> = {};
  const keys: KeysAdapter = {
    has: (n) => !!savedKeys[n],
    set: async (n, v) => {
      savedKeys[n] = v;
    },
    reload: async () => {},
  };
  const boom = new Error("read-only settings dir");
  const code: CodeConfigStore = {
    ...fakeCode(),
    writeKeySource: () => {
      throw boom;
    },
  };
  const result = await createRoot(async (dispose) => {
    const ctrl = createProvidersController({
      settings,
      keys,
      code,
      catalog: null,
      scope: () => "global",
      markDirty: () => {},
      emit: (event) => notes.push(presentProvidersEvent(event).message),
    });
    ctrl.load();
    ctrl.stageSource("ACME_API_KEY", "keyfile");
    const outcome = await ctrl.save();
    dispose();
    return outcome;
  });
  expect(result).toBe("source-error");
  expect(savedKeys["ACME_API_KEY"]).toBeUndefined();
  expect(notes.some((n) => n.includes("source save failed for ACME_API_KEY: read-only"))).toBe(
    true,
  );
});

test("setDefaultModel updates the signal and marks dirty", () => {
  const { ctrl, dirty, dispose } = setup(undefined, { manageDefaultModel: true });
  ctrl.load();
  ctrl.setDefaultModel("acme/gpt-x");
  expect(ctrl.defaultModel()).toBe("acme/gpt-x");
  expect(dirty.at(-1)).toBe(true);
  ctrl.setDefaultModel(undefined);
  expect(ctrl.defaultModel()).toBeUndefined();
  dispose();
});

test("deleteProviderAt removes it from the list and marks dirty", () => {
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl, dirty, dispose } = setup(provider);
  ctrl.load();
  ctrl.deleteProviderAt(0);
  expect(ctrl.providers()).toEqual([]);
  expect(dirty.at(-1)).toBe(true);
  dispose();
});

test("deleteProviderAt removes one row, not every provider sharing its name", () => {
  // Deleting by name destroyed the user's original credentialed provider the
  // moment a second one was saved under the same name.
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl, dispose } = setup(provider);
  ctrl.load();
  const created = ctrl.addBlankProvider();
  ctrl.setProviderField(ctrl.providers().indexOf(created), { name: "acme" });
  expect(ctrl.providers()).toHaveLength(2);
  ctrl.deleteProviderAt(1);
  expect(ctrl.providers()).toHaveLength(1);
  expect(ctrl.providers()[0]).toEqual(provider);
  dispose();
});

test("an out-of-range index deletes nothing", () => {
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl, dispose } = setup(provider);
  ctrl.load();
  ctrl.deleteProviderAt(-1);
  ctrl.deleteProviderAt(7);
  expect(ctrl.providers()).toHaveLength(1);
  dispose();
});

test("providerRefs delegates to settings.refs", () => {
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl, dispose } = setup(provider);
  ctrl.load();
  expect(ctrl.providerRefs("acme")).toEqual({ agents: [], defaultModel: false });
  dispose();
});

test("setProviderField patches only the targeted provider", () => {
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const other: ProviderConfig = { name: "other", kind: "anthropic" };
  const { ctrl, dispose } = setup(provider);
  ctrl.load();
  ctrl.addBlankProvider();
  ctrl.setProviderField(1, { name: other.name, kind: other.kind });
  ctrl.setProviderField(0, { name: "acme-renamed", base_url: "https://acme.example" });
  expect(ctrl.providers()[0]).toMatchObject({
    name: "acme-renamed",
    base_url: "https://acme.example",
  });
  expect(ctrl.providers()[1]).toEqual(other);
  dispose();
});

test("keyStatus stays semantic when no api_key_env is configured", () => {
  const noKeyEnv: ProviderConfig = { name: "bare", kind: "openai-compatible" };
  const { ctrl, dispose } = setup(noKeyEnv);
  ctrl.load();
  expect(ctrl.keyStatus(noKeyEnv)).toBe("not-required");
  expect(ctrl.keyedCount()).toBe(0);
  dispose();
});

test("resolveCatalogProvider matches by name+kind, then falls back to base_url/api_key_env, then undefined with no catalog", () => {
  const byName = catalogProvider({ id: "acme", name: "acme", kind: "openai-compatible" });
  const byUrl = catalogProvider({
    id: "other-co",
    name: "other-co",
    kind: "anthropic",
    base_url: "https://other.example",
  });
  const catalog = fakeCatalog([byName, byUrl]);

  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl: withCatalog, dispose: d1 } = setup(provider, { catalog });
  withCatalog.load();
  expect(withCatalog.resolveCatalogProvider(provider)?.id).toBe("acme");
  d1();

  const renamed: ProviderConfig = {
    name: "my-anthropic",
    kind: "anthropic",
    base_url: "https://other.example",
  };
  const { ctrl: withCatalog2, dispose: d2 } = setup(renamed, { catalog });
  withCatalog2.load();
  expect(withCatalog2.resolveCatalogProvider(renamed)?.id).toBe("other-co");
  d2();

  const { ctrl: noCatalog, dispose: d3 } = setup(provider);
  noCatalog.load();
  expect(noCatalog.resolveCatalogProvider(provider)).toBeUndefined();
  d3();
});

test("suggestedEnvVar prefers the catalog's api_key_env, else sanitizes the provider name", () => {
  const catalogEntry = catalogProvider({
    id: "acme",
    name: "acme",
    kind: "openai-compatible",
    api_key_env: "ACME_KEY_FROM_CATALOG",
  });
  const catalog = fakeCatalog([catalogEntry]);
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl, dispose } = setup(provider, { catalog });
  ctrl.load();
  expect(ctrl.suggestedEnvVar(provider)).toBe("ACME_KEY_FROM_CATALOG");
  expect(ctrl.suggestedEnvVar({ name: "My Weird! Name--", kind: "openai" })).toBe(
    "MY_WEIRD_NAME_API_KEY",
  );
  expect(ctrl.suggestedEnvVar({ name: "___", kind: "openai" })).toBe("PROVIDER_API_KEY");
  dispose();
});

test("keyUsageNote explains env-sourced, keyfile-sourced, and shell-env-overrides cases", () => {
  const provider: ProviderConfig = {
    name: "acme",
    kind: "openai-compatible",
    api_key_env: "ACME_API_KEY",
  };
  const { ctrl, code, dispose } = setup(provider);
  ctrl.load();
  ctrl.stageSource("ACME_API_KEY", "env");
  expect(ctrl.keyUsageNote("ACME_API_KEY")).toContain("source=env");
  ctrl.stageSource("ACME_API_KEY", "keyfile");
  expect(ctrl.keyUsageNote("ACME_API_KEY")).toBeUndefined();
  code.writeKeySource("global", "ACME_API_KEY", "auto");
  expect(ctrl.keyUsageNote("ACME_API_KEY")).toBeUndefined();
  dispose();
});

test("seedProviderFromCatalog appends a config from the catalog, or undefined without one/on a miss", () => {
  const seed = catalogProvider({
    id: "acme",
    name: "Acme",
    kind: "openai-compatible",
    base_url: "https://acme.example",
  });
  const catalog = fakeCatalog([seed]);
  const { ctrl, dispose } = setup(undefined, { catalog });
  ctrl.load();
  const created = ctrl.seedProviderFromCatalog("acme");
  expect(created?.name).toBe("acme");
  expect(ctrl.providers()).toHaveLength(1);
  expect(ctrl.seedProviderFromCatalog("missing")).toBeUndefined();
  dispose();

  const { ctrl: noCatalog, dispose: d2 } = setup(undefined);
  noCatalog.load();
  expect(noCatalog.seedProviderFromCatalog("acme")).toBeUndefined();
  d2();
});

test("addModelFromCatalog fills model and effort metadata from a hit, or defaults without one", () => {
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl, notes, dispose } = setup(provider);
  ctrl.load();
  const hit = catalogModel("gpt-x", {
    context_window_tokens: 200000,
    max_output_tokens: 8000,
    capabilities: ["vision"],
    reasoning_efforts: ["low", "medium", "high"],
  });
  ctrl.addModelFromCatalog(0, "gpt-x", hit);
  expect(ctrl.providers()[0]!.models?.["gpt-x"]).toEqual({
    context_window_tokens: 200000,
    max_output_tokens: 8000,
    capabilities: ["vision"],
    reasoning_efforts: ["low", "medium", "high"],
  });
  expect(notes.some((n) => n.includes("added gpt-x"))).toBe(true);

  ctrl.addModelFromCatalog(0, "gpt-bare", undefined);
  expect(ctrl.providers()[0]!.models?.["gpt-bare"]).toEqual({
    context_window_tokens: ctrl.defaultWindow,
  });
  dispose();
});

test("addBlankModel adds a default-window model with no metadata", () => {
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl, dispose } = setup(provider);
  ctrl.load();
  const other = ctrl.addBlankProvider();
  ctrl.addBlankModel(0, "m-1");
  expect(ctrl.providers()[0]!.models).toEqual({ "m-1": { context_window_tokens: 128000 } });
  expect(ctrl.providers()[1]).toEqual(other);
  dispose();
});

test("removeModel deletes just the targeted model", () => {
  const provider: ProviderConfig = {
    name: "acme",
    kind: "openai-compatible",
    models: { "m-1": { context_window_tokens: 128000 }, "m-2": { context_window_tokens: 128000 } },
  };
  const { ctrl, dispose } = setup(provider);
  ctrl.load();
  ctrl.removeModel(0, "m-1");
  expect(Object.keys(ctrl.providers()[0]!.models ?? {})).toEqual(["m-2"]);
  dispose();
});

test("setModelField sets context window, sets then clears max_output_tokens", () => {
  const provider: ProviderConfig = {
    name: "acme",
    kind: "openai-compatible",
    models: { "m-1": { context_window_tokens: 128000 } },
  };
  const { ctrl, dispose } = setup(provider);
  ctrl.load();
  ctrl.setModelField(0, "m-1", "context_window_tokens", 200000);
  expect(ctrl.providers()[0]!.models!["m-1"]!.context_window_tokens).toBe(200000);
  ctrl.setModelField(0, "m-1", "max_output_tokens", 4096);
  expect(ctrl.providers()[0]!.models!["m-1"]!.max_output_tokens).toBe(4096);
  ctrl.setModelField(0, "m-1", "max_output_tokens", undefined);
  expect(ctrl.providers()[0]!.models!["m-1"]!.max_output_tokens).toBeUndefined();
  ctrl.setModelField(0, "m-1", "context_window_tokens", undefined);
  expect(ctrl.providers()[0]!.models!["m-1"]!.context_window_tokens).toBe(ctrl.defaultWindow);
  dispose();
});

test("setModelField on a not-yet-configured model id seeds it from the default window", () => {
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl, dispose } = setup(provider);
  ctrl.load();
  ctrl.setModelField(0, "brand-new", "max_output_tokens", 1024);
  expect(ctrl.providers()[0]!.models!["brand-new"]).toEqual({
    context_window_tokens: 128000,
    max_output_tokens: 1024,
  });
  dispose();
});

test("setModelCapabilities replaces the capabilities list", () => {
  const provider: ProviderConfig = {
    name: "acme",
    kind: "openai-compatible",
    models: { "m-1": { context_window_tokens: 128000, capabilities: ["old"] } },
  };
  const { ctrl, dispose } = setup(provider);
  ctrl.load();
  ctrl.setModelCapabilities(0, "m-1", ["vision", "tools"]);
  expect(ctrl.providers()[0]!.models!["m-1"]!.capabilities).toEqual(["vision", "tools"]);
  dispose();
});

test("fillModelFromCatalog delegates to the catalog's fill, or undefined without one", () => {
  const seed = catalogProvider({
    id: "acme",
    name: "acme",
    kind: "openai-compatible",
    models: [catalogModel("gpt-x", { context_window_tokens: 100000 })],
  });
  const catalog = fakeCatalog([seed]);
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl, dispose } = setup(provider, { catalog });
  ctrl.load();
  expect(ctrl.fillModelFromCatalog(provider, "gpt-x")?.context_window_tokens).toBe(100000);
  dispose();

  const { ctrl: noCatalog, dispose: d2 } = setup(provider);
  noCatalog.load();
  expect(noCatalog.fillModelFromCatalog(provider, "gpt-x")).toBeUndefined();
  d2();
});

test("setModelPromptCache stages each mode, and undefined deletes the key", () => {
  const provider: ProviderConfig = {
    name: "acme",
    kind: "openai-compatible",
    models: { "gpt-x": { context_window_tokens: 100000 } },
  };
  const { ctrl, dispose } = setup(provider);
  ctrl.load();
  const mode = (): unknown => ctrl.providers()[0]!.models!["gpt-x"]!.prompt_cache;

  expect(mode()).toBeUndefined();
  ctrl.setModelPromptCache(0, "gpt-x", "explicit");
  expect(mode()).toBe("explicit");
  ctrl.setModelPromptCache(0, "gpt-x", "off");
  expect(mode()).toBe("off");

  // "(auto)" is the ABSENCE of the key, not a value: it is what tells the kernel
  // to derive the mode from the catalog, and a leftover "off" would be a
  // different instruction entirely.
  ctrl.setModelPromptCache(0, "gpt-x", undefined);
  expect("prompt_cache" in ctrl.providers()[0]!.models!["gpt-x"]!).toBe(false);
  dispose();
});

test("T10: headers, body and prompt_cache survive an unrelated edit and a save", async () => {
  const provider: ProviderConfig = {
    name: "acme",
    kind: "openai-compatible",
    base_url: "https://acme.example/v1",
    headers: { "X-Partner": "${PARTNER_TOKEN}" },
    body: { provider: { order: ["deepseek"] } },
    models: {
      "gpt-x": {
        context_window_tokens: 100000,
        prompt_cache: "off",
        headers: { "X-Model": "${MODEL_TOKEN}" },
        body: { top_k: 40 },
      },
    },
  };
  const { ctrl, settings, dispose } = setup(provider);
  ctrl.load();
  ctrl.setModelField(0, "gpt-x", "context_window_tokens", 200000);
  const result = await ctrl.save();
  expect(result).toBe("ok");

  // The panel stages a whole copy and writes the scope wholesale, so a field it
  // does not know about is lost silently — no error, no diff to notice.
  const written = settings.written[0]!.file as { providers: ProviderConfig[] };
  const saved = written.providers[0]!;
  expect(saved.headers).toEqual({ "X-Partner": "${PARTNER_TOKEN}" });
  expect(saved.body).toEqual({ provider: { order: ["deepseek"] } });
  const model = saved.models!["gpt-x"]!;
  expect(model.context_window_tokens).toBe(200000);
  expect(model.prompt_cache).toBe("off");
  expect(model.headers).toEqual({ "X-Model": "${MODEL_TOKEN}" });
  expect(model.body).toEqual({ top_k: 40 });
  dispose();
});

test("setProviderMap stages headers and body, and an empty map deletes the key", () => {
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl, dispose } = setup(provider);
  ctrl.load();
  const at = (): ProviderConfig => ctrl.providers()[0]!;

  ctrl.setProviderMap(0, "body", { provider: { order: ["deepseek"], allow_fallbacks: false } });
  ctrl.setProviderMap(0, "headers", { "X-Title": "clarvis" });
  expect(at().body).toEqual({ provider: { order: ["deepseek"], allow_fallbacks: false } });
  expect(at().headers).toEqual({ "X-Title": "clarvis" });

  // An emptied map is the ABSENCE of the key, not `{}`: `.strict()` accepts both
  // but only one of them reads as "this provider configures nothing extra", and
  // an empty object left behind is what a later reader has to guess about.
  ctrl.setProviderMap(0, "body", {});
  ctrl.setProviderMap(0, "headers", undefined);
  expect("body" in at()).toBe(false);
  expect("headers" in at()).toBe(false);
  dispose();
});

test("setModelMap stages a model's own maps without disturbing the provider's", () => {
  const provider: ProviderConfig = {
    name: "acme",
    kind: "openai-compatible",
    headers: { "X-Partner": "${PARTNER_TOKEN}" },
    models: { "gpt-x": { context_window_tokens: 100000 } },
  };
  const { ctrl, dispose } = setup(provider);
  ctrl.load();
  const model = () => ctrl.providers()[0]!.models!["gpt-x"]!;

  ctrl.setModelMap(0, "gpt-x", "body", { top_k: 40 });
  expect(model().body).toEqual({ top_k: 40 });
  expect(ctrl.providers()[0]!.headers).toEqual({ "X-Partner": "${PARTNER_TOKEN}" });
  expect(model().context_window_tokens).toBe(100000);

  ctrl.setModelMap(0, "gpt-x", "body", undefined);
  expect("body" in model()).toBe(false);
  dispose();
});

test("setModelMap creates the model entry it is given, with the default window", () => {
  const provider: ProviderConfig = { name: "acme", kind: "openai-compatible" };
  const { ctrl, dispose } = setup(provider);
  ctrl.load();
  ctrl.setModelMap(0, "new-model", "headers", { "X-Title": "clarvis" });
  const entry = ctrl.providers()[0]!.models!["new-model"]!;
  expect(entry.context_window_tokens).toBe(ctrl.defaultWindow);
  expect(entry.headers).toEqual({ "X-Title": "clarvis" });
  dispose();
});

test("catalogModelFor looks the model up under the provider's own name, never across providers", () => {
  // `fillModelFromCatalog` deliberately falls back across providers, which is
  // right for offering to fill a context window. The kernel's
  // `withPromptCacheModes` does not: it matches the configured provider's name
  // only. Anything the panel derives from `fill` and presents as what the run
  // will do can therefore state the opposite of what it does.
  const anthropic = catalogProvider({
    id: "anthropic",
    kind: "anthropic",
    models: [
      catalogModel("claude-sonnet-4-5", {
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      }),
    ],
  });
  const gateway = catalogProvider({ id: "my-gateway", kind: "openai-compatible", models: [] });
  const provider: ProviderConfig = { name: "my-gateway", kind: "openai-compatible" };
  const { ctrl, dispose } = setup(provider, { catalog: fakeCatalog([anthropic, gateway]) });
  ctrl.load();

  expect(ctrl.catalogModelFor(provider, "claude-sonnet-4-5")).toBeUndefined();
  expect(
    ctrl.catalogModelFor({ name: "anthropic", kind: "anthropic" }, "claude-sonnet-4-5")?.cost,
  ).toBeDefined();
  dispose();

  const { ctrl: noCatalog, dispose: d2 } = setup(provider);
  noCatalog.load();
  expect(noCatalog.catalogModelFor(provider, "claude-sonnet-4-5")).toBeUndefined();
  d2();
});
