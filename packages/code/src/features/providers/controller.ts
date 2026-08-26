import { createMemo, createSignal, type Accessor } from "solid-js";
import { derivePromptCacheMode } from "../../adapters/model-policy.ts";
import type {
  EnvKeyStatus,
  FieldIssue,
  ProviderConfig,
  ProviderKind,
  SettingsAdapter,
  SettingsFile,
} from "../../adapters/settings.ts";
import { mergeProviders } from "../../adapters/settings.ts";
import type { KeysAdapter, KeySource } from "../../adapters/provider-secrets.ts";
import type { CodeConfigStore } from "../../adapters/code-config.ts";
import type {
  CatalogModel,
  CatalogProvider,
  ModelsCatalog,
} from "../../adapters/models-catalog.ts";
import type { Scope } from "../../keys/commands.ts";
import { createDisposeGuard } from "../dispose-guard.ts";
import type { ProvidersEvent } from "./events.ts";

/** Dependencies {@link createProvidersController} needs to load, edit and save providers. */
export interface ProvidersControllerDeps {
  settings: SettingsAdapter;
  keys: KeysAdapter;
  code: CodeConfigStore;
  catalog: ModelsCatalog | null;
  scope: Accessor<Scope>;
  markDirty: (value?: boolean) => void;
  emit: (event: ProvidersEvent) => void;
  /** Called after a successful save that wrote keys or key sources. */
  onReconnect?: () => void;
  /** First-run setup alone owns staging `default_model` with its first provider. */
  manageDefaultModel?: boolean;
}

const DEFAULT_WINDOW = 128000;
/** The full set of selectable {@link KeySource} values, in display order. */
export const KEY_SOURCES: KeySource[] = ["auto", "env", "keyfile"];
/** Human-readable explanation of each {@link KeySource}'s precedence, for UI copy. */
export const SOURCE_MEANING: Record<KeySource, string> = {
  auto: "shell env wins, else keys.json",
  env: "shell env only (keys.json ignored)",
  keyfile: "keys.json only (overrides shell env)",
};

/** Provider key availability, before a view chooses copy, glyphs, or colors. */
export type ProviderKeyStatus = "not-required" | "staged" | "environment" | "keyfile" | "missing";

/** Semantic reason a configured model cannot be removed. */
export type ModelRemovalBlock =
  | { kind: "default-model"; model: string }
  | { kind: "agent-references"; model: string; agents: string[] };

/** The two free-form maps a provider and each of its models may carry. */
export type ProviderMapField = "headers" | "body";

/** Reactive state and operations backing the Providers settings view. */
export interface ProvidersController {
  providers: Accessor<ProviderConfig[]>;
  /** The `default_model` staged in the scope currently being edited. */
  defaultModel: Accessor<string | undefined>;
  /** The merged `default_model` a run would use right now. */
  effectiveDefaultModel: Accessor<string | undefined>;
  setDefaultModel: (value: string | undefined) => void;
  pendingKeys: Accessor<Map<string, string>>;
  pendingSources: Accessor<Map<string, KeySource>>;
  defaultWindow: number;
  load: () => void;
  clearPending: () => void;
  origins: () => Map<string, "global" | "workspace" | "shadow">;
  envStatusOf: (name: string) => EnvKeyStatus;
  sourceOf: (envVar: string) => KeySource;
  resolveCatalogProvider: (p: ProviderConfig) => CatalogProvider | undefined;
  suggestedEnvVar: (p: ProviderConfig) => string;
  keyUsageNote: (envVar: string) => string | undefined;
  stageKey: (envVar: string, value: string) => void;
  stageSource: (envVar: string, source: KeySource) => void;
  setProviderField: (
    index: number,
    patch: Partial<Pick<ProviderConfig, "name" | "kind" | "base_url" | "api_key_env">>,
  ) => void;
  addBlankProvider: () => ProviderConfig;
  seedProviderFromCatalog: (catalogProviderId: string) => ProviderConfig | undefined;
  addSubscriptionProvider: (provider: CatalogProvider) => ProviderConfig;
  addModelFromCatalog: (providerIndex: number, id: string, hit: CatalogModel | undefined) => void;
  addBlankModel: (providerIndex: number, id: string) => void;
  removeModel: (providerIndex: number, id: string) => void;
  modelRemovalBlocked: (provider: ProviderConfig, id: string) => ModelRemovalBlock | null;
  setModelField: (
    providerIndex: number,
    modelId: string,
    field: "context_window_tokens" | "max_output_tokens",
    value: number | undefined,
  ) => void;
  setModelCapabilities: (providerIndex: number, modelId: string, caps: string[]) => void;
  /** Stages a provider's whole `headers` or `body`; `undefined` deletes the key. */
  setProviderMap: (
    providerIndex: number,
    field: ProviderMapField,
    value: Record<string, unknown> | undefined,
  ) => void;
  /** Stages a model's whole `headers` or `body`; `undefined` deletes the key. */
  setModelMap: (
    providerIndex: number,
    modelId: string,
    field: ProviderMapField,
    value: Record<string, unknown> | undefined,
  ) => void;
  /** Stages a model's `prompt_cache`; `undefined` deletes the key ("(auto)"). */
  setModelPromptCache: (
    providerIndex: number,
    modelId: string,
    mode: "explicit" | "implicit" | "off" | undefined,
  ) => void;
  fillModelFromCatalog: (provider: ProviderConfig, modelId: string) => CatalogModel | undefined;
  /**
   * The catalog entry for this model **under this provider's own name**.
   *
   * @remarks Deliberately not {@link ProvidersController.fillModelFromCatalog},
   *   which falls back to the same model id under any provider of the same kind
   *   and then under any provider at all. That fallback is right for offering to
   *   fill a context window, and wrong for saying anything the kernel will act
   *   on: `derivePromptCacheMode` is applied against the configured provider's
   *   own name only, so a value or a note derived through the fallback can state
   *   the opposite of what the run does — an `openai-compatible` gateway named for itself carrying a model id
   *   the catalog knows under Anthropic reads as cached and is stamped with
   *   nothing.
   */
  catalogModelFor: (provider: ProviderConfig, modelId: string) => CatalogModel | undefined;
  validation: Accessor<{ ok: true } | { ok: false; issues: FieldIssue[] }>;
  keyStatus: (p: ProviderConfig) => ProviderKeyStatus;
  keyedCount: () => number;
  deleteProviderAt: (index: number) => void;
  providerRefs: (name: string) => { agents: string[]; defaultModel: boolean };
  save: () => Promise<"ok" | "validation" | "key-error" | "source-error">;
  dispose: () => void;
  catalog: ModelsCatalog | null;
}

/**
 * Creates the {@link ProvidersController} backing the Providers settings view:
 * loads providers for the active scope, stages provider/model/key edits, validates
 * them, and saves on request.
 *
 * @param deps - adapters and callbacks the controller reads and writes through.
 * @returns the controller handle.
 */
export function createProvidersController(deps: ProvidersControllerDeps): ProvidersController {
  const settings = deps.settings;
  const [providers, setProviders] = createSignal<ProviderConfig[]>([]);
  const [defaultModel, setDefaultModelSignal] = createSignal<string | undefined>(undefined);
  const [pendingKeys, setPendingKeys] = createSignal<Map<string, string>>(new Map());
  const [pendingSources, setPendingSources] = createSignal<Map<string, KeySource>>(new Map());
  /**
   * Bumped whenever `deps.keys`/`deps.code`'s key state is mutated outside Solid's
   * reactivity (currently only at the end of {@link save}), so `envStatusOf`/`sourceOf`
   * re-derive from the underlying store instead of returning a stale cached read.
   */
  const [keysRev, setKeysRev] = createSignal(0);
  const guard = createDisposeGuard(deps.emit);
  const disposed = guard.isDisposed;
  const emit = guard.emit;

  const effectiveDefaultModel = (): string | undefined => {
    settings.version();
    return settings.effective().default_model;
  };

  /**
   * The list as last loaded from disk, for deciding whether a draft differs.
   *
   * @remarks `markDirty` is a latch: anything that edits sets it, and nothing
   * clears it short of a save or a reload. Editing a field and putting it back
   * therefore left "Unsaved" on screen forever, with the bytes on disk provably
   * identical — the user is then told they have changes to lose, and the
   * discard confirmation fires on a decision they already reversed.
   */
  let savedSnapshot = "";

  function load(): void {
    const s = settings.read(deps.scope()) ?? {};
    setProviders((s.providers ?? []).map((p) => ({ ...p })));
    setDefaultModelSignal(s.default_model);
    setPendingKeys(new Map());
    setPendingSources(new Map());
    savedSnapshot = snapshot();
    deps.markDirty(false);
  }

  /** A stable serialization of everything a save would write. */
  function snapshot(): string {
    return JSON.stringify({
      providers: providers(),
      ...(deps.manageDefaultModel ? { default_model: defaultModel() } : {}),
    });
  }

  /**
   * Marks dirty only when the draft actually differs from what was loaded.
   *
   * @remarks A staged credential or source is a pending change of its own, and
   * is not part of {@link snapshot} — it never lands in `settings.json` — so it
   * has to be counted here or reverting an unrelated field would clear the
   * "Unsaved" mark while a key was still waiting to be written.
   */
  function refreshDirty(): void {
    deps.markDirty(
      snapshot() !== savedSnapshot || pendingKeys().size > 0 || pendingSources().size > 0,
    );
  }

  function clearPending(): void {
    setPendingKeys(new Map());
    setPendingSources(new Map());
  }

  function mutate(fn: (list: ProviderConfig[]) => ProviderConfig[]): void {
    setProviders((list) => fn(list.map((p) => ({ ...p }))));
    refreshDirty();
  }

  const origins = (): Map<string, "global" | "workspace" | "shadow"> =>
    new Map(settings.effectiveProviders().map((e) => [e.provider.name, e.origin]));

  const envStatusOf = (name: string): EnvKeyStatus => {
    keysRev();
    return settings.envStatus(name);
  };

  const sourceOf = (envVar: string): KeySource => {
    keysRev();
    return pendingSources().get(envVar) ?? deps.code.keySource(envVar);
  };

  function resolveCatalogProvider(p: ProviderConfig): CatalogProvider | undefined {
    const catalog = deps.catalog;
    if (!catalog) return undefined;
    const byName = catalog.provider(p.name);
    if (byName && byName.kind === p.kind) return byName;
    return catalog
      .providers()
      .find(
        (c) =>
          c.kind === p.kind &&
          ((!!p.base_url && c.base_url === p.base_url) ||
            (!!p.api_key_env && c.api_key_env === p.api_key_env)),
      );
  }

  function suggestedEnvVar(p: ProviderConfig): string {
    const fromCatalog = resolveCatalogProvider(p)?.api_key_env;
    if (fromCatalog) return fromCatalog;
    const base = p.name
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase();
    return `${base || "PROVIDER"}_API_KEY`;
  }

  function keyUsageNote(envVar: string): string | undefined {
    const src = sourceOf(envVar);
    if (src === "env") return "source=env - keys.json is ignored";
    if (src === "keyfile") return undefined;
    return envStatusOf(envVar) === "set" ? "shell env overrides this (source=auto)" : undefined;
  }

  function stageKey(envVar: string, value: string): void {
    setPendingKeys((m) => new Map(m).set(envVar, value));
    deps.markDirty(true);
    emit({ type: "key_staged", envVar });
  }

  function stageSource(envVar: string, source: KeySource): void {
    setPendingSources((m) => new Map(m).set(envVar, source));
    deps.markDirty(true);
    emit({ type: "source_staged", envVar, source, meaning: SOURCE_MEANING[source] });
  }

  function setProviderField(
    index: number,
    patch: Partial<Pick<ProviderConfig, "name" | "kind" | "base_url" | "api_key_env">>,
  ): void {
    mutate((l) => l.map((x, i) => (i === index ? { ...x, ...patch } : x)));
  }

  function addBlankProvider(): ProviderConfig {
    const used = new Set(providers().map((p) => p.name));
    let n = providers().length + 1;
    while (used.has(`provider-${n}`)) n++;
    const created: ProviderConfig = { name: `provider-${n}`, kind: "openai-compatible" };
    mutate((l) => [...l, created]);
    return created;
  }

  function seedProviderFromCatalog(catalogProviderId: string): ProviderConfig | undefined {
    const catalog = deps.catalog;
    if (!catalog) return undefined;
    const taken = new Set(providers().map((x) => x.name));
    const config = catalog.seed(catalogProviderId, taken);
    if (!config) return undefined;
    mutate((l) => [...l, config]);
    return config;
  }

  function addSubscriptionProvider(provider: CatalogProvider): ProviderConfig {
    const taken = new Set(providers().map((item) => item.name));
    const base = provider.kind === "openai-codex" ? "chatgpt" : "grok";
    let name = base;
    let suffix = 2;
    while (taken.has(name)) name = `${base}-${suffix++}`;
    const config: ProviderConfig = { name, kind: provider.kind };
    mutate((list) => [...list, config]);
    return config;
  }

  /**
   * Adds a model to a provider, seeded from its catalog entry.
   *
   * @remarks Provider-published `reasoning_efforts` are copied **here**, where
   *   an entitled or public catalog model becomes durable configuration, so
   *   `/effort` does not depend on that catalog still being loaded. `prompt_cache`
   *   is derived at the same boundary and written alongside the window and
   *   capability tags. It used to be stamped per run request inside the
   *   kernel, which made the 1.6 MB bundled catalog a hard dependency of every
   *   run — a throwing read there failed the whole run — in exchange for a value
   *   that cannot change a byte on the wire once
   *   {@link derivePromptCacheMode}'s kind cap is applied. Stored, it is visible,
   *   editable, survives a catalog refresh, and is read identically by a memory
   *   continuation pass and the run it indexes, which is what keeps their two
   *   prefixes byte-identical.
   */
  function addModelFromCatalog(
    providerIndex: number,
    id: string,
    hit: CatalogModel | undefined,
  ): void {
    mutate((l) =>
      l.map((x, i) => {
        if (i !== providerIndex) return x;
        const models = { ...(x.models ?? {}) };
        const entry: {
          context_window_tokens: number;
          max_output_tokens?: number;
          capabilities?: string[];
          reasoning_efforts?: string[];
          prompt_cache?: "explicit" | "implicit";
        } = {
          context_window_tokens: hit?.context_window_tokens ?? DEFAULT_WINDOW,
        };
        if (hit?.max_output_tokens) entry.max_output_tokens = hit.max_output_tokens;
        if (hit?.capabilities?.length) entry.capabilities = hit.capabilities;
        if (hit?.reasoning_efforts !== undefined)
          entry.reasoning_efforts = [...hit.reasoning_efforts];
        const cache = derivePromptCacheMode(hit?.cost, x.kind);
        if (cache !== undefined) entry.prompt_cache = cache;
        models[id] = entry;
        return { ...x, models };
      }),
    );
    emit({
      type: "model_added",
      id,
      contextWindow: hit?.context_window_tokens ?? DEFAULT_WINDOW,
    });
  }

  function addBlankModel(providerIndex: number, id: string): void {
    mutate((l) =>
      l.map((x, i) =>
        i === providerIndex
          ? {
              ...x,
              models: {
                ...(x.models ?? {}),
                [id]: { context_window_tokens: DEFAULT_WINDOW },
              },
            }
          : x,
      ),
    );
  }

  function removeModel(providerIndex: number, id: string): void {
    mutate((l) =>
      l.map((x, i) => {
        if (i !== providerIndex) return x;
        const models = { ...(x.models ?? {}) };
        delete models[id];
        return { ...x, models };
      }),
    );
  }

  function modelRemovalBlocked(provider: ProviderConfig, id: string): ModelRemovalBlock | null {
    const full = `${provider.name}/${id}`;
    const r = settings.modelRefs(full);
    if (r.defaultModel) return { kind: "default-model", model: full };
    if (r.agents.length) return { kind: "agent-references", model: full, agents: r.agents };
    return null;
  }

  function setModelField(
    providerIndex: number,
    modelId: string,
    field: "context_window_tokens" | "max_output_tokens",
    value: number | undefined,
  ): void {
    mutate((l) =>
      l.map((x, i) => {
        if (i !== providerIndex) return x;
        const models = { ...(x.models ?? {}) };
        const entry = { ...(models[modelId] ?? { context_window_tokens: DEFAULT_WINDOW }) };
        if (field === "context_window_tokens")
          entry.context_window_tokens = value ?? DEFAULT_WINDOW;
        else if (value == null) delete entry.max_output_tokens;
        else entry.max_output_tokens = value;
        models[modelId] = entry;
        return { ...x, models };
      }),
    );
  }

  function setModelCapabilities(providerIndex: number, modelId: string, caps: string[]): void {
    mutate((l) =>
      l.map((x, i) => {
        if (i !== providerIndex) return x;
        const models = { ...(x.models ?? {}) };
        const entry = { ...(models[modelId] ?? { context_window_tokens: DEFAULT_WINDOW }) };
        entry.capabilities = [...caps];
        models[modelId] = entry;
        return { ...x, models };
      }),
    );
  }

  /**
   * Applies a staged map to a target object, deleting the key when it is empty.
   *
   * @remarks The cast is the one place the editor's `unknown` values meet the
   * schema's `Record<string, string>` for `headers`. It is safe by construction
   * and only by construction: the headers map is opened with a `rejectValue`
   * that refuses anything but text, so a non-string can only arrive from a
   * caller that skipped it. Kept to this single line rather than spread across
   * two near-identical setters.
   */
  function applyMap(
    target: { headers?: Record<string, string>; body?: Record<string, unknown> },
    field: ProviderMapField,
    value: Record<string, unknown> | undefined,
  ): void {
    if (value === undefined || Object.keys(value).length === 0) {
      delete target[field];
      return;
    }
    if (field === "headers") target.headers = value as Record<string, string>;
    else target.body = value;
  }

  function setProviderMap(
    providerIndex: number,
    field: ProviderMapField,
    value: Record<string, unknown> | undefined,
  ): void {
    mutate((l) =>
      l.map((x, i) => {
        if (i !== providerIndex) return x;
        const next = { ...x };
        applyMap(next, field, value);
        return next;
      }),
    );
  }

  function setModelMap(
    providerIndex: number,
    modelId: string,
    field: ProviderMapField,
    value: Record<string, unknown> | undefined,
  ): void {
    mutate((l) =>
      l.map((x, i) => {
        if (i !== providerIndex) return x;
        const models = { ...(x.models ?? {}) };
        const entry = { ...(models[modelId] ?? { context_window_tokens: DEFAULT_WINDOW }) };
        applyMap(entry, field, value);
        models[modelId] = entry;
        return { ...x, models };
      }),
    );
  }

  /**
   * Stages a model's `prompt_cache`, deleting the key when `mode` is undefined.
   *
   * @remarks A setter of its own rather than a widening of `setModelField`,
   * whose `value` is number-typed — the same reason `setModelCapabilities` is
   * separate. Deleting on `undefined` is what makes "(auto)" expressible at all:
   * an absent key is how the kernel is told to derive the mode from the catalog,
   * and it is a different state from every value the field can hold.
   */
  function setModelPromptCache(
    providerIndex: number,
    modelId: string,
    mode: "explicit" | "implicit" | "off" | undefined,
  ): void {
    mutate((l) =>
      l.map((x, i) => {
        if (i !== providerIndex) return x;
        const models = { ...(x.models ?? {}) };
        const entry = { ...(models[modelId] ?? { context_window_tokens: DEFAULT_WINDOW }) };
        if (mode === undefined) delete entry.prompt_cache;
        else entry.prompt_cache = mode;
        models[modelId] = entry;
        return { ...x, models };
      }),
    );
  }

  function fillModelFromCatalog(
    provider: ProviderConfig,
    modelId: string,
  ): CatalogModel | undefined {
    return deps.catalog ? deps.catalog.fill(provider.kind, modelId) : undefined;
  }

  function catalogModelFor(provider: ProviderConfig, modelId: string): CatalogModel | undefined {
    return deps.catalog?.provider(provider.name)?.models.find((m) => m.modelId === modelId);
  }

  const resolveSet = (): ProviderConfig[] => {
    const g = deps.scope() === "global" ? providers() : (settings.read("global")?.providers ?? []);
    const w =
      deps.scope() === "workspace" ? providers() : (settings.read("workspace")?.providers ?? []);
    return mergeProviders(g, w) ?? [];
  };

  const validation = createMemo(() =>
    settings.validateProviders(
      {
        ...(settings.read(deps.scope()) ?? {}),
        providers: providers(),
        default_model: defaultModel(),
      },
      resolveSet(),
    ),
  );

  function keyStatus(p: ProviderConfig): ProviderKeyStatus {
    const envVar = p.api_key_env;
    if (!envVar) return "not-required";
    if (pendingKeys().has(envVar)) return "staged";
    const st = envStatusOf(envVar);
    if (st === "set") return "environment";
    if (st === "keyfile") return "keyfile";
    return "missing";
  }

  const keyedCount = (): number =>
    providers().filter((p) => {
      if (p.kind === "openai-codex" || p.kind === "xai-grok") return true;
      const status = keyStatus(p);
      return status === "staged" || status === "environment" || status === "keyfile";
    }).length;

  function deleteProviderAt(index: number): void {
    mutate((l) => (index < 0 || index >= l.length ? l : l.filter((_, i) => i !== index)));
  }

  function providerRefs(name: string): { agents: string[]; defaultModel: boolean } {
    return settings.refs(name);
  }

  async function save(): Promise<"ok" | "validation" | "key-error" | "source-error"> {
    if (disposed()) return "ok";
    const check = validation();
    if (!check.ok) {
      emit({ type: "validation_failed", issue: check.issues[0]! });
      return "validation";
    }
    const next: SettingsFile = {
      providers: providers(),
      ...(deps.manageDefaultModel ? { default_model: defaultModel() } : {}),
    };
    await settings.write(deps.scope(), next);
    if (disposed()) return "ok";
    const stagedKeys = [...pendingKeys()];
    const stagedSources = [...pendingSources()];
    for (const [envVar, value] of stagedKeys) {
      try {
        await deps.keys.set(envVar, value);
        if (disposed()) return "ok";
        setPendingKeys((m) => {
          const copy = new Map(m);
          copy.delete(envVar);
          return copy;
        });
      } catch (e) {
        emit({ type: "key_save_failed", envVar, error: e });
        return "key-error";
      }
    }
    for (const [envVar, source] of stagedSources) {
      if (disposed()) return "ok";
      try {
        deps.code.writeKeySource(deps.scope(), envVar, source);
        setPendingSources((m) => {
          const copy = new Map(m);
          copy.delete(envVar);
          return copy;
        });
      } catch (e) {
        emit({ type: "source_save_failed", envVar, error: e });
        return "source-error";
      }
    }
    if (disposed()) return "ok";
    setKeysRev((v) => v + 1);
    deps.markDirty(false);
    const reconnect = stagedKeys.length > 0 || stagedSources.length > 0;
    emit({ type: "saved", scope: deps.scope(), reconnecting: reconnect });
    if (reconnect) deps.onReconnect?.();
    return "ok";
  }

  return {
    providers,
    defaultModel,
    effectiveDefaultModel,
    setDefaultModel: (value) => {
      setDefaultModelSignal(value);
      refreshDirty();
    },
    pendingKeys,
    pendingSources,
    defaultWindow: DEFAULT_WINDOW,
    load,
    clearPending,
    origins,
    envStatusOf,
    sourceOf,
    resolveCatalogProvider,
    suggestedEnvVar,
    keyUsageNote,
    stageKey,
    stageSource,
    setProviderField,
    addBlankProvider,
    seedProviderFromCatalog,
    addSubscriptionProvider,
    addModelFromCatalog,
    addBlankModel,
    removeModel,
    modelRemovalBlocked,
    setModelField,
    setModelCapabilities,
    setProviderMap,
    setModelMap,
    setModelPromptCache,
    fillModelFromCatalog,
    catalogModelFor,
    validation,
    keyStatus,
    keyedCount,
    deleteProviderAt,
    providerRefs,
    save,
    dispose: () => {
      guard.dispose();
      clearPending();
    },
    catalog: deps.catalog,
  };
}

/** Utility re-export for callers typing kind edits. */
export type { ProviderKind };
