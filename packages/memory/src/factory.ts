import { workspacePaths, workspaceStatePaths } from "@clarvis/paths";

import { createFileMemoryStore } from "./file-store.ts";
import { createMemoryJobBroker } from "./job-broker.ts";
import { createMemory } from "./memory.ts";
import type { MemoryConfig } from "./schemas.ts";
import type { IndexerRuntime, IndexerRuntimeResolver, MemoryStore } from "./types.ts";
import type { Memory } from "./memory-contract.ts";
import { createIndexWorker, type MemoryIndexWorker } from "./worker.ts";

import { parseModelRef, sanitizeErrorMessage } from "@clarvis/capability";
import type { LLMProvider, ProviderKind, ModelExecutionResolver } from "@clarvis/capability";
import type { ExecuteRunArgs, ExecuteRunDeps, ExecuteRunOutcome } from "@clarvis/loop";
import type { Logger } from "@clarvis/capability";
import type { ProviderConfig } from "@clarvis/capability";
import { translateDrainSettlement, type MemoryIngestListener } from "./ingest.ts";
import { resolveMemoryProvider, type ProviderResolution } from "./provider-registry.ts";
import { DEFAULT_BUDGETS } from "./config.ts";

/** How the host's settings map into the factory: the parsed `memory:` block
 * plus what model resolution needs from the surrounding settings. */
export interface MemoryFactorySettings {
  config: MemoryConfig;
  providers?: ProviderConfig[];
}

/** Construction inputs for {@link createMemoryFactory}. */
export interface CreateMemoryFactoryOptions {
  /** Provider the control plane's own model calls go through, when it has any. */
  llm: LLMProvider;
  /** Closed host catalog. When supplied, indexing never derives local provider transports. */
  modelExecutionResolver?: ModelExecutionResolver;
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
  /** Host-owned executor for lifecycle and Extension Profile admission around every indexer pass. */
  executeRun?: (args: ExecuteRunArgs) => Promise<ExecuteRunOutcome>;
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
}

/** A per-process factory that hands back cached, settings-aware memory instances. */
export interface MemoryFactory {
  /**
   * Memory for the background worker, or undefined when memory is disabled.
   */
  forOwner(owner: string): Memory | undefined;
  /**
   * Memory for a **run** and for the **control plane** — the owner browsing,
   * searching and editing the wiki — or undefined only when memory is genuinely
   * off or disabled.
   *
   * @remarks Shares the one process-wide store and exclusion lock with
   *   {@link forOwner}.
   */
  forOwnerControlPlane(owner: string): Memory | undefined;
  /**
   * Resolve the owner's built-in wiki provider, or `undefined` when memory is
   * off or disabled.
   *
   * @remarks Optional so a host or test may supply a factory that only knows
   *   the built-in wiki; the memory capability falls back to wrapping
   *   {@link forOwnerControlPlane} when this is absent. A resolution that
   *   *fails* is reported rather than thrown, and the run then proceeds with no
   *   memory rather than selecting another store.
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

/** Provider tokens that name an SDK kind directly, so an entry can be derived. */
const BUILTIN_PROVIDER_KINDS = new Set<string>([
  "openai-compatible",
  "openai",
  "anthropic",
  "google",
]);

/**
 * Build the process-lived {@link MemoryFactory} over the built-in Markdown wiki.
 *
 * @param opts - model runtime, workspace root, logger and settings ports; see
 *   {@link CreateMemoryFactoryOptions}.
 * @returns a factory whose owner accessors return `undefined` when memory is
 *   disabled or settings cannot be read. Indexing uses the entry model retained
 *   in each completed subject run's snapshot.
 * @remarks Memory facades are cached per owner and a signature of `(config, providers)`.
 *   A settings change rebuilds the facade while retaining that owner's store
 *   and exclusion lock. Without `storeFor`, every owner shares one workspace-local
 *   store. Background workers are cached independently, so facade replacement
 *   does not create another queue timer. Each pass resolves the current settings
 *   and the subject run's saved model through the host catalog or declared provider
 *   configuration. Unavailable runtime blocks the queue without consuming an
 *   attempt; an unresolved subject model skips its pass with `run-model-unavailable`.
 *   The wiki stays readable and editable in either case.
 */
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
  let warnedProviderUnresolved = false;

  /**
   * Build the per-pass {@link IndexerRuntimeResolver} for one owner.
   *
   * @remarks A resolver rather than a resolved value, called per pass: a
   * settings edit after the process started takes effect
   * on the next drain tick without rebuilding anything. It yields `undefined`
   * whenever indexing cannot proceed — memory disabled or no engine deps
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
      const deps = opts.runDeps?.();
      if (deps === undefined) return undefined;
      const resolved = await resolveProviderFor(owner);
      if (resolved === undefined || !resolved.ok) return undefined;
      const passDeps = opts.passRunDeps?.();
      const policy = opts.loadPolicy?.();
      return {
        owner,
        deps,
        modelRef: "",
        providers: [],
        resolveRunModel: (run) => {
          if (run.model_ref === undefined) return undefined;
          const providers = providersFor(run.model_ref, settings.providers);
          return providers === undefined ? undefined : { modelRef: run.model_ref, providers };
        },
        ...(opts.executeRun === undefined ? {} : { executeRun: opts.executeRun }),
        memoryProvider: resolved.provider,
        memoryProviderKey: resolved.key,
        ...(passDeps !== undefined ? { passDeps } : {}),
        ...(policy !== undefined ? { policy } : {}),
      };
    };

  /**
   * Resolve model transport declarations for the completed run's indexer request.
   *
   * @param modelRef - the subject run's saved entry model, `provider/model`.
   * @param declared - providers available from the host's current settings.
   * @returns an empty array when the closed host catalog resolves the exact model;
   *   otherwise the matching declarations, a derived built-in SDK entry, or
   *   `undefined` when no supported provider can be resolved.
   * @remarks A host model resolver owns transport selection and needs no provider
   *   declarations in the request. Without it, a built-in SDK token can derive
   *   its declaration and use ambient credentials. An undeclared custom token
   *   cannot be guessed; returning `undefined` skips the pass with
   *   `run-model-unavailable` instead of generating an invalid request.
   */
  function providersFor(
    modelRef: string,
    declared: ProviderConfig[] | undefined,
  ): ProviderConfig[] | undefined {
    const { provider: token, modelId: model } = parseModelRef(modelRef);
    if (opts.modelExecutionResolver !== undefined) {
      const resolved = opts.modelExecutionResolver.resolve(token, model);
      return resolved?.provider === token && resolved.model === model ? [] : undefined;
    }
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
   * Resolve the owner's memory.
   *
   * @param owner - the owner scope to resolve for.
   * @returns the cached {@link Memory}, or undefined when memory is off.
   * @remarks Both entry points share one instance and one exclusion lock.
   */
  function resolve(owner: string): Memory | undefined {
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

    const key = owner;
    const sig = JSON.stringify([settings.config, settings.providers ?? []]);
    const hit = cache.get(key);
    if (hit !== undefined && hit.sig === sig) return hit.memory;

    const memory = createMemory({
      store: storeFor(owner),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      indexer: indexerFor(owner),
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
   * `ingest.ts`'s `translateDrainSettlement`.
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
      resolve: () => resolve(owner),
      onJobSettled: (job) => broker.publish(owner, job),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });
    workers.set(owner, worker);
    return worker;
  }

  /**
   * Read the built-in wiki settings, tolerating an unreadable settings file exactly
   * as {@link resolve} does.
   *
   * @returns the settings, or `undefined` when memory is off or disabled —
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
    return resolveMemoryProvider(settings.config.config.provider, {
      wiki: resolve(owner),
      seedMaxChars: settings.config.config.budgets?.seed_chars ?? DEFAULT_BUDGETS.seed_chars,
    });
  }

  return {
    forOwner: (owner: string) => resolve(owner),
    forOwnerControlPlane: (owner: string) => resolve(owner),
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
