import { workspacePaths, workspaceStatePaths } from "@clarvis/paths";

import { createFileMemoryStore } from "./file-store.ts";
import { createMemoryJobBroker } from "./job-broker.ts";
import { createMemory } from "./memory.ts";
import type { MemoryConfig } from "./schemas.ts";
import type { IndexerRuntime, IndexerRuntimeResolver, MemoryStore } from "./types.ts";
import type { Memory } from "./memory-contract.ts";
import { createIndexWorker, type MemoryIndexWorker } from "./worker.ts";

import { parseModelRef, sanitizeErrorMessage } from "@clarvis/capability";
import type { CapabilityExecutablePort, LLMProvider, ProviderKind } from "@clarvis/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";
import type { Logger } from "@clarvis/capability";
import type { ProviderConfig } from "@clarvis/capability";
import { translateDrainSettlement, type MemoryIngestListener } from "./ingest.ts";
import {
  resolveMemoryProvider,
  type MemoryPluginPort,
  type ProviderResolution,
} from "./provider-registry.ts";
import type { MemoryServerPortResolver } from "./mcp-provider.ts";
import { DEFAULT_BUDGETS } from "./config.ts";

/** How the host's settings map into the factory: the parsed `memory:` block
 * plus what model resolution needs from the surrounding settings. */
export interface MemoryFactorySettings {
  config: MemoryConfig;
  /** Fallback indexer model when config.model is unset. */
  defaultModel?: string;
  providers?: ProviderConfig[];
}

/** Construction inputs for {@link createMemoryFactory}. */
export interface CreateMemoryFactoryOptions {
  /** Provider the control plane's own model calls go through, when it has any. */
  llm: LLMProvider;
  /**
   * The engine deps an indexer pass runs against.
   *
   * @remarks A thunk, because the host builds its deps *from* this factory — the
   * memory capability is folded into `deps.capabilities` — so an eager value
   * would be circular. Omitted, or resolving `undefined`, indexing is simply not
   * available: the wiki stays readable and editable, and the durable queue holds
   * every run's learning until deps are wired.
   */
  runDeps?: () => ExecuteRunDeps | undefined;
  /**
   * The engine deps a pass uses when it continues the run it indexes.
   *
   * @remarks A thunk for the same reason {@link runDeps} is. Omitted, every pass
   * runs isolated over its own small prefix — correct, and merely more
   * expensive. See {@link IndexerRuntime.passDeps} for what the host must have
   * removed from them and why "removed" rather than "disabled".
   */
  passRunDeps?: () => ExecuteRunDeps | undefined;
  /**
   * The operator's composed recording policy, or `undefined` for none.
   *
   * @remarks A thunk like {@link loadSettings}, so editing the authored files
   * takes effect on the next pass rather than at the next restart.
   */
  loadPolicy?: () => string | undefined;
  /** Workspace whose `.clarvis/memory` subtree the factory's instances root at.
   * Ignored when `storeFor` is supplied. */
  workspaceRoot: string;
  /**
   * Where memory reports what it did outside any run's view.
   *
   * @remarks Threaded all the way down — into the per-owner store (its tree
   * lock, journal recovery and job records), into every `Memory` instance and
   * from there into the drain and the index pass. The kernel supplies
   * `componentLogger("memory")`.
   */
  logger?: Logger;
  /**
   * How long the memory tree lock may be held before the store reports it, in
   * milliseconds.
   *
   * @remarks The host resolves `CLARVIS_MEMORY_LOCK_WARN_MS`; this package
   * never reads the environment itself. Only reaches a store this factory
   * builds — a `storeFor` host constructs its own.
   */
  lockWarnMs?: number;
  /** Called per run so settings edits take effect without a rebuild.
   * `undefined` = memory off. */
  loadSettings: () => MemoryFactorySettings | undefined;
  /**
   * Persistence for one owner's tree.
   *
   * @remarks Called **at most once per owner** — the factory memoizes the result
   * for its own lifetime — so the returned store is the single instance over that
   * tree and its exclusion lock is authoritative. Omitted, every owner shares one
   * workspace-local markdown store over `<workspaceRoot>/.clarvis/memory`, which is
   * right for a local product where the workspace is the user. Supplying it is
   * what a standing multi-application server needs instead: the agent writes
   * memory in-run with no approval gate, so a shared tree would let one
   * application rewrite another's facts and be seeded with them.
   */
  storeFor?: (owner: string) => MemoryStore;
  /**
   * The host's tool-server seam, handed to an `mcp` memory provider.
   *
   * @remarks Optional: a host with no tool servers simply reports an `mcp`
   * declaration unavailable, which is the posture everywhere else — report,
   * never substitute. Declared as the narrow {@link MemoryServerPort} so this
   * package never acquires a dependency on the MCP client. The resolver binds
   * each provider to its owner before any model-facing tool is constructed.
   */
  serverPort?: MemoryServerPortResolver;
  /**
   * How a plugin-offered memory provider is located, when the host has plugins.
   *
   * @remarks Declared structurally, like {@link serverPort}: this package knows
   * nothing about plugin installation, trust or marketplaces.
   */
  pluginPort?: MemoryPluginPort;
  /** Kernel-owned persistent executable sessions. */
  executablePort?: CapabilityExecutablePort;
}

/** A per-process factory that hands back cached, settings-aware memory instances. */
export interface MemoryFactory {
  /**
   * Memory for a caller that **cannot proceed without indexing**, or undefined
   * when memory is off, disabled, or no indexer model resolves.
   *
   * @remarks The background index worker, and nothing else. A missing model is
   *   a hard gate here because draining the queue *is* inference; for every
   *   other caller it is a reason to stop learning, not a reason to stop
   *   having memory — see {@link forOwnerControlPlane}.
   */
  forOwner(owner: string): Memory | undefined;
  /**
   * Memory for a **run** and for the **control plane** — the owner browsing,
   * searching and editing the wiki — or undefined only when memory is genuinely
   * off or disabled.
   *
   * @remarks Resolves even with no indexer model: the wiki is readable and
   *   editable without one, and only learning stops. Collapsing that case into
   *   "not configured" is what made an enabled-but-model-less workspace report
   *   *"memory is off"* in the UI, and what cost such a run its seed block and
   *   its wiki tools as well as its learning. Shares the one process-wide
   *   store, and therefore its exclusive lock, with {@link forOwner}'s
   *   instance.
   */
  forOwnerControlPlane(owner: string): Memory | undefined;
  /**
   * Resolve the {@link MemoryProvider} this workspace declared, or `undefined`
   * when memory is off or disabled.
   *
   * @remarks Optional so a host or test may supply a factory that only knows
   *   the built-in wiki; the memory capability falls back to wrapping
   *   {@link forOwnerControlPlane} when this is absent. A resolution that
   *   *fails* is reported rather than thrown, and the run then proceeds with no
   *   memory at all — never with a different store than the one declared.
   */
  providerFor?(owner: string): Promise<ProviderResolution | undefined>;
  /** Begin draining one owner's durable index queue: once now, then on an interval. */
  start(owner: string): void;
  /**
   * Ask the worker to drain soon, after a run has been queued.
   *
   * @remarks Coalesced, so a burst of finished runs cannot stack up passes.
   */
  poke(owner: string): void;
  /** Stop and evict one inactive owner's worker and settings-derived facades. */
  stopOwner?(owner: string): Promise<void>;
  /**
   * Stop every owner worker, cancel in-flight model work and pending settlement
   * subscriptions, and await lease release.
   *
   * @remarks Concurrent and later calls await the same idempotent teardown;
   *   `start`, `poke` and `subscribeToRun` stay inert afterwards.
   */
  stop(): Promise<void>;
  /**
   * Subscribe to a run's eventual index-job settlement, already translated to
   * a {@link MemoryIngestNotice} via {@link translateDrainSettlement}.
   *
   * @remarks Call **before** the run's job is enqueued — subscribing after
   *   risks missing a settlement the worker's own recurring timer drains
   *   immediately. Delivers a non-terminal `"queued"` notice on every retry
   *   without unsubscribing; delivers exactly one of `"done"`/`"failed"`/
   *   `"blocked"` and then unsubscribes automatically (or after a generous
   *   leak-guard timeout if the job never settles). A caller that never
   *   subscribes does not stop the worker from processing and persisting the
   *   job — this is purely an observability side channel.
   * @returns an unsubscribe function; safe to call more than once.
   */
  subscribeToRun(owner: string, runId: string, onSettled: MemoryIngestListener): () => void;
}

/**
 * Build the process-lived {@link MemoryFactory} whose `forOwner` resolves the
 * current `memory:` settings, picks the indexer model, and returns a cached
 * {@link Memory} keyed by owner and a signature of `(config, model, providers)`.
 *
 * @param opts - provider, workspace root, logger, and the per-run
 *   `loadSettings` port; see {@link CreateMemoryFactoryOptions}.
 * @returns a factory whose `forOwner` returns `undefined` when memory is off,
 *   `config.enabled === false`, `loadSettings` throws, or no model can be
 *   resolved (neither `memory.model` nor `defaultModel`), and whose
 *   `forOwnerControlPlane` returns `undefined` only for the first three — a
 *   workspace with no indexer model still has a wiki worth reading.
 * @remarks Lives in long-lived deps and is built once per process; instances
 *   are cached per owner plus a settings signature, the same pattern
 *   `dynamicSkills` uses in `build-run-deps`, so a settings edit between runs
 *   is picked up without rebuilding on every run. A settings change is
 *   detected by the signature and rebuilds only that owner's instance — an
 *   unchanged signature returns the cached one. The **store is built once per
 *   owner**, in a cache the signature never touches, so a settings-driven
 *   rebuild never produces a second store over the same tree (which would give
 *   the two instances independent exclusion). With no `storeFor`, that
 *   per-owner cache resolves every owner to the *same* shared instance, so the
 *   local product's exclusion semantics are unchanged. The chosen model's
 *   provider is resolved via {@link resolveProvider}; an unresolved provider is
 *   warned once and the generation calls fall back to ambient credentials. The
 *   background index workers are built beside the per-owner cache rather than
 *   inside it — a settings edit rebuilds the `Memory` instance without leaving
 *   a second timer on that owner's queue. Each worker holds an owner-bound
 *   resolver rather than a resolved model, so an indexer model appearing where
 *   there was none takes effect on its next tick.
 */
/** Provider tokens that name an SDK kind directly, so an entry can be derived. */
const BUILTIN_PROVIDER_KINDS = new Set<string>([
  "openai-compatible",
  "openai",
  "anthropic",
  "google",
]);

export function createMemoryFactory(opts: CreateMemoryFactoryOptions): MemoryFactory {
  const ownerStores = new Map<string, MemoryStore>();
  let sharedStore: MemoryStore | undefined;
  const storeFor = (owner: string): MemoryStore => {
    if (opts.storeFor === undefined) {
      sharedStore ??= createFileMemoryStore({
        root: workspacePaths(opts.workspaceRoot).memoryRoot,
        machineryRoot: workspaceStatePaths(opts.workspaceRoot).memoryMachineryRoot,
        workspaceRoot: opts.workspaceRoot,
        ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
        ...(opts.lockWarnMs !== undefined ? { lock: { warnMs: opts.lockWarnMs } } : {}),
      });
      return sharedStore;
    }
    const cached = ownerStores.get(owner);
    if (cached !== undefined) return cached;
    const store = opts.storeFor(owner);
    ownerStores.set(owner, store);
    return store;
  };
  const cache = new Map<string, { sig: string; memory: Memory }>();
  let warnedNoModel = false;
  let warnedProviderUnresolved = false;

  /**
   * Build the per-pass {@link IndexerRuntimeResolver} for one owner.
   *
   * @remarks A resolver rather than a resolved value, called per pass: a
   * settings edit, or a model configured after the process started, takes effect
   * on the next drain tick without rebuilding anything. It yields `undefined`
   * whenever indexing cannot proceed — memory off, no model, or no engine deps
   * wired — and the drain treats that as `blocked` rather than as a failure, so
   * no attempt is consumed and the learning is recovered later.
   */
  const indexerFor =
    (owner: string): IndexerRuntimeResolver =>
    async (): Promise<IndexerRuntime | undefined> => {
      let settings: MemoryFactorySettings | undefined;
      try {
        settings = opts.loadSettings();
      } catch {
        return undefined;
      }
      if (settings === undefined || settings.config.enabled === false) return undefined;
      const modelRef = settings.config.model ?? settings.defaultModel;
      const deps = opts.runDeps?.();
      if (modelRef === undefined || deps === undefined) return undefined;
      const providers = providersFor(modelRef, settings.providers);
      if (providers === undefined) return undefined;
      const resolved = await resolveProviderFor(owner);
      if (resolved === undefined || !resolved.ok) return undefined;
      const passDeps = opts.passRunDeps?.();
      const policy = opts.loadPolicy?.();
      return {
        owner,
        deps,
        modelRef,
        providers,
        memoryProvider: resolved.provider,
        memoryProviderKey: resolved.key,
        ...(passDeps !== undefined ? { passDeps } : {}),
        ...(policy !== undefined ? { policy } : {}),
      };
    };

  /**
   * The `providers` array an indexer request must declare.
   *
   * @param modelRef - the indexer model, `provider/model`.
   * @param declared - what the workspace's settings declare, if anything.
   * @returns the declared providers when they already cover `modelRef`'s token,
   *   a single entry derived from that token when they do not and the token
   *   names a built-in SDK kind, or `undefined` when neither holds.
   * @remarks A run request is rejected outright unless every profile's provider
   *   token matches a `providers[]` entry, and `providers` may not be empty. The
   *   common local setup declares `default_model: "anthropic/..."` and no
   *   `providers` block at all, relying on ambient credentials — so without this
   *   fallback memory would simply stop learning there, with the failure landing
   *   as a validation error deep inside a background pass. Deriving the entry
   *   keeps that setup working; a token naming no built-in kind cannot be guessed
   *   at, and yields `undefined` so the drain reports the job blocked rather than
   *   burning its retry budget on a request that can never validate.
   */
  function providersFor(
    modelRef: string,
    declared: ProviderConfig[] | undefined,
  ): ProviderConfig[] | undefined {
    const token = parseModelRef(modelRef).provider;
    if (declared !== undefined && declared.some((p) => p.name === token)) return declared;
    if (!BUILTIN_PROVIDER_KINDS.has(token)) {
      if (!warnedProviderUnresolved) {
        warnedProviderUnresolved = true;
        opts.logger?.warn(
          { event: "memory.provider.undeclared", provider: token, model: modelRef },
          "the memory model's provider is not declared in 'providers' and is not a built-in kind, so runs cannot learn until it is",
        );
      }
      return undefined;
    }
    return [...(declared ?? []), { name: token, kind: token as ProviderKind }];
  }

  /**
   * Resolve the owner's memory, optionally requiring an indexer model.
   *
   * @param owner - the owner scope to resolve for.
   * @param requireModel - when true, a workspace with no resolvable indexer
   *   model yields `undefined` (the run path); when false, a model-less
   *   instance is built whose `index` reports `"no-model"` while every
   *   store-backed operation works (the control-plane path).
   * @returns the cached {@link Memory}, or undefined when memory is off.
   * @remarks Cache key is the bare `owner` whenever a model resolved, so both
   *   entry points share one instance in the common case; the model-less
   *   instance gets its own key and exists only for the control plane.
   */
  function resolve(owner: string, requireModel: boolean): Memory | undefined {
    let settings: MemoryFactorySettings | undefined;
    try {
      settings = opts.loadSettings();
    } catch (err) {
      opts.logger?.warn(
        {
          event: "memory.settings.unreadable",
          cause: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        },
        "this workspace's memory settings could not be read; the run proceeds with memory off entirely",
      );
      return undefined;
    }
    if (settings === undefined || settings.config.enabled === false) return undefined;

    const modelRef = settings.config.model ?? settings.defaultModel;
    if (modelRef === undefined) {
      if (!warnedNoModel) {
        warnedNoModel = true;
        opts.logger?.warn(
          { event: "memory.model.absent" },
          "memory is enabled and neither memory.model nor default_model is set; the wiki stays readable and editable, and every finished run's learning waits in the durable queue until a model is configured",
        );
      }
      if (requireModel) return undefined;
    }

    const key = modelRef === undefined ? `no-model:${owner}` : owner;
    const sig = JSON.stringify([settings.config, modelRef ?? null, settings.providers ?? []]);
    const hit = cache.get(key);
    if (hit !== undefined && hit.sig === sig) return hit.memory;

    const memory = createMemory({
      store: storeFor(owner),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      ...(modelRef !== undefined ? { indexer: indexerFor(owner) } : {}),
      ...(settings.config.budgets !== undefined ? { budgets: settings.config.budgets } : {}),
    });
    cache.set(key, { sig, memory });
    return memory;
  }

  /**
   * Bridges a settled job back to whichever run subscribed for it via
   * {@link MemoryFactory.subscribeToRun}.
   *
   * @remarks Knows nothing about runs beyond their id — the translation from
   * drain vocabulary to {@link MemoryIngestNotice} phases lives in
   * `ingest-run.ts`'s `translateDrainSettlement`.
   */
  const broker = createMemoryJobBroker();
  const workers = new Map<string, MemoryIndexWorker>();
  let stopped = false;
  let stopPromise: Promise<void> | null = null;

  /**
   * Resolve the one process-lived worker for `owner`.
   *
   * @remarks Workers are cached independently of `Memory` facades so a settings
   *   change can rebuild a facade without starting a second timer over the same
   *   durable queue. Once stopped, the factory never admits another worker.
   */
  function workerFor(owner: string): MemoryIndexWorker | undefined {
    if (stopped) return undefined;
    const hit = workers.get(owner);
    if (hit !== undefined) return hit;
    const worker = createIndexWorker({
      resolve: () => resolve(owner, true),
      onJobSettled: (job) => broker.publish(owner, job),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });
    workers.set(owner, worker);
    return worker;
  }

  /**
   * The environment a command-backed provider is given.
   *
   * @remarks `process.env` minus this run's provider API-key variables, and
   * nothing else. The broad filtering `@clarvis/hooks` applies exists because a
   * **plugin** may contribute a hook; a memory provider cannot be
   * plugin-contributed (`memorySettingsSpec` is not `pluginContributable`), so
   * the command was named in the operator's own `settings.json` by someone who
   * already has this shell. Withholding their own environment from their own
   * command would buy nothing. The provider credentials are still denied,
   * because those are the run's secrets rather than the operator's, and a
   * memory command has no reason to see them.
   */
  /**
   * Read the declared provider, tolerating an unreadable settings file exactly
   * as {@link resolve} does.
   *
   * @returns the declaration, or `undefined` when memory is off or disabled —
   *   which is the same signal `resolve` gives, kept in one place so the two
   *   cannot disagree about whether memory exists.
   */
  function providerConfig(): { config: MemoryFactorySettings } | undefined {
    let settings: MemoryFactorySettings | undefined;
    try {
      settings = opts.loadSettings();
    } catch {
      return undefined;
    }
    if (settings === undefined || settings.config.enabled === false) return undefined;
    return { config: settings };
  }

  async function resolveProviderFor(owner: string): Promise<ProviderResolution | undefined> {
    const settings = providerConfig();
    if (settings === undefined) return undefined;
    const declared = settings.config.config.provider;
    const wiki =
      declared === undefined || declared.kind === "wiki" ? resolve(owner, false) : undefined;
    return resolveMemoryProvider(declared, {
      workspaceRoot: opts.workspaceRoot,
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      ...(wiki !== undefined ? { wiki } : {}),
      seedMaxChars: settings.config.config.budgets?.seed_chars ?? DEFAULT_BUDGETS.seed_chars,
      ...(opts.serverPort !== undefined ? { serverPort: opts.serverPort.forOwner(owner) } : {}),
      ...(opts.pluginPort !== undefined ? { pluginPort: opts.pluginPort } : {}),
      ...(opts.executablePort !== undefined ? { executablePort: opts.executablePort } : {}),
      owner,
    });
  }

  return {
    forOwner: (owner: string) => resolve(owner, true),
    forOwnerControlPlane: (owner: string) => resolve(owner, false),
    providerFor: resolveProviderFor,
    start: (owner) => workerFor(owner)?.start(),
    poke: (owner) => workerFor(owner)?.poke(),
    async stopOwner(owner): Promise<void> {
      broker.closeOwner(owner);
      try {
        const worker = workers.get(owner);
        if (worker !== undefined) {
          await worker.stop();
          if (workers.get(owner) === worker) workers.delete(owner);
        }
      } finally {
        cache.delete(owner);
        cache.delete(`no-model:${owner}`);
        ownerStores.delete(owner);
      }
    },
    stop(): Promise<void> {
      if (stopPromise !== null) return stopPromise;
      stopped = true;
      broker.close();
      // Defer worker.stop() by one microtask so `stopPromise` is assigned before
      // an abort callback can re-enter stop(). Every concurrent caller then
      // observes and awaits this same lifecycle completion.
      stopPromise = Promise.resolve().then(async () => {
        await Promise.all([...workers.values()].map((worker) => worker.stop()));
      });
      return stopPromise;
    },
    subscribeToRun: (owner, runId, onSettled) =>
      broker.subscribe(owner, runId, (job) => onSettled(translateDrainSettlement(job))),
  };
}
