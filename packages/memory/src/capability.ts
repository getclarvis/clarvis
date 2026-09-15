/**
 * Execution memory (@clarvis/memory) packaged as a capability: the per-run gate
 * + PROFILE seed, the wiki toolset (read-only navigation for every agent, plus
 * direct write/edit/delete for the entry agent — no approval gate), and the
 * fire-and-forget post-run index pass.
 */
import { createHash } from "node:crypto";

import { SEED_MAX_CHARS, SEED_OPEN_TAG, wrapMemorySeed } from "./seed.ts";
import type { Memory } from "./memory-contract.ts";
import { wikiMemoryProvider } from "./wiki-provider.ts";

import type {
  AgentCapability,
  Capability,
  ExecutionRecord,
  RunCapability,
  RunCapabilityContext,
  ToolEffect,
} from "@clarvis/capability";
import { handlerBaseOf } from "@clarvis/capability";
import { enqueueFinishedRun, type MemoryIngestNotice } from "./ingest.ts";
import type { MemoryFactory } from "./factory.ts";
import { firstUserText } from "./run-snapshot.ts";
import { buildMemoryToolsHandler } from "./handler.ts";
import { MEMORY_CAPABILITY_NAME, MEMORY_INGEST_EVENT } from "./settings.ts";
import { buildMemoryToolset } from "./toolset.ts";
import {
  MEMORY_READ_TOOL_NAMES,
  MEMORY_WRITE_TOOL_NAMES,
  type MemoryProvider,
} from "./provider.ts";
import {
  MEMORY_TOOL_CONTRACTS,
  memoryToolParameters,
  type MemoryToolName,
} from "./tool-contract.ts";
import type { MemoryToolResult } from "./types.ts";

export { MEMORY_CAPABILITY_NAME, MEMORY_INGEST_EVENT } from "./settings.ts";
export { buildMemoryToolsHandler, type MemoryToolsHandlerDeps } from "./handler.ts";

export { createMemoryFactory, type MemoryFactory, type MemoryFactorySettings } from "./factory.ts";
export { enqueueFinishedRun, type MemoryIngestNotice } from "./ingest.ts";
export { storedExecutionToRunSnapshot, firstUserText } from "./run-snapshot.ts";
export { captureWorkspaceState } from "./workspace-state.ts";
export { buildMemoryToolset, type MemoryToolset } from "./toolset.ts";
export {
  assertProviderVocabulary,
  MEMORY_READ_TOOL_NAMES,
  MEMORY_WRITE_TOOL_NAMES,
  type MemoryProvider,
} from "./provider.ts";
export {
  MEMORY_TOOL_CONTRACTS,
  memoryToolParameters,
  type MemoryToolName,
} from "./tool-contract.ts";
export type { MemoryToolDef, MemoryToolResult } from "./types.ts";
export { wikiMemoryProvider, WIKI_PROVIDER_KIND } from "./wiki-provider.ts";
export type { MemoryServerPort, MemoryServerPortResolver } from "./mcp-provider.ts";
export type { MemoryPluginPort } from "./provider-registry.ts";
export {
  createExecutableMemoryProvider,
  EXECUTABLE_MEMORY_PROVIDER_KIND,
  type ExecutableMemoryProviderOptions,
} from "./executable-provider.ts";
export {
  composeMemoryPolicy,
  loadMemoryPolicy,
  MEMORY_POLICY_MAX_CHARS,
  type MemoryPolicyFiles,
  type MemoryPolicyScopes,
} from "./recording-policy.ts";

/** The fixed provider vocabulary is also the capability's reservation/effect source. */
const MEMORY_TOOL_WIRE_NAMES: readonly string[] = [
  ...MEMORY_READ_TOOL_NAMES,
  ...MEMORY_WRITE_TOOL_NAMES,
];
const MEMORY_TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = Object.fromEntries([
  ...MEMORY_READ_TOOL_NAMES.map((name) => [name, "read"] as const),
  ...MEMORY_WRITE_TOOL_NAMES.map((name) => [name, "mutate"] as const),
]);

/**
 * Build the memory capability over an optional per-owner {@link MemoryFactory}.
 *
 * @param factory - Resolves a {@link Memory} for the run's owner; when absent
 *   (or it yields none for the owner) the capability is inactive for the run.
 * @returns A {@link Capability} that declares the seed block's open tag as its
 *   `seedMarker` for context ownership while historical publications retain
 *   their persisted position, returns null from `forRun` when the run requests
 *   `memory: "off"` or memory is off or disabled, and otherwise activates the
 *   wiki seed, tools and post-run index pass.
 *
 * @remarks The per-run override is read through
 *   {@link RunCapabilityContext.requestParam} rather than off `ctx.request`: the
 *   `memory` param is declared by {@link memorySettingsSpec} and registered by
 *   the host, so it is absent from the engine's own request type.
 *
 * @remarks Resolves through {@link MemoryFactory.forOwnerControlPlane}, not
 *   `forOwner`: a missing indexer model must cost the run its **learning**, not
 *   its memory. Under `forOwner` a workspace with no `default_model` lost the
 *   seed block, all seven wiki tools and the post-run enqueue together — the
 *   run could not even read what earlier runs had written by hand. The enqueue
 *   still happens, because the queue is durable and `drainIndexJobs` reports
 *   such a job `blocked` without consuming an attempt or taking a lease: the
 *   day a model is configured, the drain recovers the learning of every run
 *   that came before it. `forOwner` remains the right gate for the background
 *   worker, which genuinely cannot proceed without a model.
 */
export function createMemoryCapability(
  factory?: MemoryFactory,
  opts: MemoryCapabilityOptions = {},
): Capability {
  return {
    name: MEMORY_CAPABILITY_NAME,
    seedMarker: SEED_OPEN_TAG,
    reservedWireNames: MEMORY_TOOL_WIRE_NAMES,
    toolEffects: MEMORY_TOOL_EFFECTS,
    async forRun(ctx): Promise<RunCapability | null> {
      return (await prepareMemoryRunInternal(factory, ctx, opts))?.capability ?? null;
    },
  };
}

/** How {@link createMemoryCapability} behaves for one particular run. */
export interface MemoryCapabilityOptions {
  /**
   * Whether a finished run enqueues itself for indexing. Defaults to `true`.
   *
   * @remarks Set `false` for an **indexing pass** — a run that continues the run
   *   it is indexing — or the pass enqueues itself and the queue never empties.
   *
   *   It has to be this narrow. The obvious alternatives all break the prefix
   *   cache the pass exists to exploit: leaving the capability out removes its
   *   system section and advertised tools, and requesting `memory: "off"`
   *   returns `null` from `forRun`. The historical seed remains intact, but
   *   the pass also needs every one of
   *   this capability's wire surfaces intact and exactly one of its behaviours
   *   gone, so the flag governs `onRunEnd` **alone** — `seedMarker`,
   *   `seedBlock`, `systemSection` and the advertised tools are deliberately
   *   outside its reach, and `capability-flag-surface.test.ts` pins that.
   */
  enqueueOnRunEnd?: boolean;
}

/** Host-path-free description of the exact read-only memory surface admitted for one run. */
export interface MemoryRuntimeDescriptor {
  /** Stable digest used in the prompt prefix without disclosing provider configuration. */
  readonly providerDigest: string;
  /** Maximum size of the safely wrapped seed block. */
  readonly seedMaxChars: number;
  /** Canonical read operations supplied by the selected provider. */
  readonly readTools: readonly MemoryToolName[];
}

/**
 * Host-owned execution lease for projecting memory into another execution placement.
 *
 * @remarks The lease exposes no store, provider configuration, credential, filesystem path, or
 * mutating operation. A host may serialize {@link descriptor} and proxy `seed`/read-only `invoke`,
 * while `finish` keeps durable post-run ingestion on the host against the host-persisted record.
 */
export interface PreparedMemoryRuntime {
  readonly descriptor: MemoryRuntimeDescriptor;
  seed(task?: string): Promise<string | null>;
  accepts(name: string, args: unknown): boolean;
  invoke(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MemoryToolResult>;
  finish(record: ExecutionRecord): Promise<void>;
}

interface PreparedMemoryRunInternal extends PreparedMemoryRuntime {
  readonly capability: RunCapability;
}

function providerDigest(providerKey: string): string {
  return (
    /^[^:]+:([a-f0-9]{64})$/.exec(providerKey)?.[1] ??
    createHash("sha256").update(providerKey).digest("hex")
  );
}

async function prepareMemoryRunInternal(
  factory: MemoryFactory | undefined,
  ctx: RunCapabilityContext,
  opts: MemoryCapabilityOptions,
): Promise<PreparedMemoryRunInternal | null> {
  if (ctx.requestParam(MEMORY_CAPABILITY_NAME) === "off") return null;
  const memory = factory?.forOwnerControlPlane(ctx.owner);
  let provider: MemoryProvider;
  let providerKey: string;
  let seedMaxChars: number;

  if (factory?.providerFor !== undefined) {
    const resolved = await factory.providerFor(ctx.owner);
    if (resolved === undefined) return null;
    if (!resolved.ok) {
      ctx.logger?.warn(
        { cause: resolved.failure.reason, provider: resolved.failure.kind },
        "memory_provider_unavailable: the run continues with no memory at all — it is " +
          "never silently served from a different store than the one declared",
      );
      return null;
    }
    provider = resolved.provider;
    providerKey = resolved.key;
    seedMaxChars = resolved.seedMaxChars;
  } else {
    if (memory === undefined) return null;
    provider = wikiMemoryProvider(memory);
    providerKey = "wiki:local";
    seedMaxChars = SEED_MAX_CHARS;
  }

  const seed = async (task?: string): Promise<string | null> => {
    try {
      return await provider.seed(task);
    } catch (err) {
      ctx.logger?.warn(
        { cause: err instanceof Error ? err.message : String(err) },
        "memory_seed_failed: the run continues without the memory block",
      );
      return null;
    }
  };
  const capability = createMemoryRunCapability(
    memory,
    provider,
    providerKey,
    seedMaxChars,
    seed,
    ctx,
    factory,
    opts,
  );
  const tools = new Map(provider.readTools.map((tool) => [tool.name, tool]));
  const accepts = (name: string, args: unknown): boolean => {
    const contract = MEMORY_TOOL_CONTRACTS[name as MemoryToolName];
    return tools.has(name) && contract !== undefined && contract.schema.safeParse(args).success;
  };
  return {
    capability,
    descriptor: {
      providerDigest: providerDigest(providerKey),
      seedMaxChars,
      readTools: provider.readTools.map((tool) => tool.name as MemoryToolName),
    },
    seed,
    accepts,
    async invoke(name, args, signal) {
      if (!accepts(name, args)) return { text: `invalid memory tool '${name}'`, isError: true };
      return tools.get(name)!.execute(args, signal);
    },
    async finish(record) {
      await capability.onRunEnd?.(record);
    },
  };
}

/**
 * Resolve one run's memory provider and bind a host-owned runtime lease.
 *
 * @returns `null` under the same gates as {@link createMemoryCapability}; otherwise a bounded,
 * provider-opaque, read-only lease suitable for an isolated guest bridge.
 */
export async function prepareMemoryRuntime(
  factory: MemoryFactory | undefined,
  ctx: RunCapabilityContext,
  opts: MemoryCapabilityOptions = {},
): Promise<PreparedMemoryRuntime | null> {
  return prepareMemoryRunInternal(factory, ctx, opts);
}

/** Writes are not rate-limited — the agent should record freely; the read
 * budget exists only to keep drill-down navigation bounded. */
const WRITE_CALL_LIMIT = Number.MAX_SAFE_INTEGER;

function createMemoryRunCapability(
  memory: Memory | undefined,
  provider: MemoryProvider,
  providerKey: string,
  seedMaxChars: number,
  seed: (task?: string) => Promise<string | null>,
  ctx: RunCapabilityContext,
  factory: MemoryFactory | undefined,
  opts: MemoryCapabilityOptions,
): RunCapability {
  const canonical = (tool: (typeof provider.readTools)[number]) => {
    const name = tool.name as MemoryToolName;
    const contract = MEMORY_TOOL_CONTRACTS[name];
    if (contract === undefined) return tool;
    return {
      ...tool,
      description: contract.description,
      parameters: memoryToolParameters(name),
    };
  };
  const readToolset = buildMemoryToolset(
    provider.readTools.map(canonical),
    ctx.env.CLARVIS_MEMORY_TOOL_CALL_LIMIT,
  );
  const writeToolset = buildMemoryToolset(
    (provider.writeTools ?? []).map(canonical),
    WRITE_CALL_LIMIT,
  );
  const resolvedProviderDigest = providerDigest(providerKey);
  return {
    name: MEMORY_CAPABILITY_NAME,
    async seedBlock(): Promise<string | undefined> {
      const raw = await seed(firstUserText(ctx.request.messages));
      return raw === null ? undefined : (wrapMemorySeed(raw, seedMaxChars) ?? undefined);
    },
    /**
     * The standing instruction that this workspace has a memory wiki, present
     * whether or not the tree has anything in it yet.
     *
     * @param id - the agent this section is composed for.
     * @returns the section text; navigation for every agent, plus the write
     *   policy for the entry agent alone.
     * @remarks Only the entry agent carries the write policy, because only it is
     *   given the write tools — telling a subagent anything about `write_memory`
     *   would buy nothing but tool calls that fail.
     *
     *   **Writes are opt-in, not standing.** The section used to say "record
     *   durable learnings as you go", and the seed block's preamble said the same
     *   thing; between them the agent was told twice to edit the wiki mid-task.
     *   That is the indexing pass's job, and an agent doing it inline records
     *   what it currently believes rather than what turned out to be true. The
     *   two authorisations that remain are the user asking, and the explicit
     *   instruction an indexing pass is handed — which is why the wording names
     *   that pass rather than forbidding writes outright: the continuation pass
     *   *inherits this very section* and would otherwise read a system-level
     *   prohibition and a trailing instruction to write, with the prohibition in
     *   the stronger position.
     *
     *   Static text, so it sits in the system head without costing a provider
     *   prompt-cache hit; that is precisely why the PROFILE itself stays out of
     *   the system prompt and rides `seedBlock` as its own context entry. Some
     *   standing instruction has to exist, because a workspace whose tree is
     *   still empty gives the model no signal that memory is there at all:
     *   `seed()` resolves null with no `PROFILE.md`, and seven tool definitions
     *   among dozens are not an instruction.
     */
    systemSection(id): string {
      const navigate =
        "## Memory\n\n" +
        "This workspace has a memory wiki of what past runs learned: `PROFILE.md` " +
        "(workspace-wide compilation) → `<topic>/TOPIC.md` (domain compilation) → " +
        "`<topic>/<sub>/MEMORY.md` (full detail). Navigate it with query_memories, " +
        "list_memories and read_memory. It may be stale — treat a procedure as a " +
        "hypothesis and verify it cheaply before relying on it.";
      const identity = `\n\n<!-- memory-provider:${resolvedProviderDigest} -->`;
      if (!id.entry || provider.writeTools === undefined) return `${navigate}${identity}`;
      return (
        `${navigate}\n\n` +
        "Do NOT call write_memory, edit_memory or delete_memory on your own initiative. " +
        "The wiki is maintained by a dedicated pass after the work is finished, and you " +
        "will be told explicitly when that is what you are doing. Before then, write only " +
        "when the user asks you to remember, record or correct something — their request " +
        "is the authorisation, and you do not need to ask again for it." +
        identity
      );
    },
    forAgent(scope): AgentCapability | null {
      return {
        attach(bc) {
          const base = handlerBaseOf(bc);
          const tools = [...readToolset.defs];
          const handlers = [buildMemoryToolsHandler({ base, toolset: readToolset })];
          if (scope.entry) {
            tools.push(...writeToolset.defs);
            handlers.push(buildMemoryToolsHandler({ base, toolset: writeToolset }));
          }
          return { tools, handlers, advertised: true };
        },
      };
    },
    ...(opts.enqueueOnRunEnd === false || memory === undefined
      ? {}
      : provider.writeTools === undefined
        ? {
            onRunEnd(record: ExecutionRecord): Promise<void> {
              ctx.emit({
                capability: MEMORY_CAPABILITY_NAME,
                kind: MEMORY_INGEST_EVENT,
                detail: {
                  execution_id: record.id,
                  phase: "done",
                  skipped: true,
                  note: "provider-read-only",
                } satisfies MemoryIngestNotice,
              });
              return Promise.resolve();
            },
          }
        : {
            /**
             * Subscribes to the run's eventual index-job settlement *before*
             * enqueueing it, since the durable queue's worker can drain a job on
             * its own recurring timer — subscribing afterward risks missing an
             * already-settled result.
             *
             * @remarks The subscription closes over
             * {@link RunCapabilityContext.emit} directly rather than `ctx`
             * itself, so a slow-settling job's async notification does not keep
             * the whole run context (messages, env, model) reachable for as long
             * as it is pending. Unsubscribes immediately when the enqueue write
             * itself fails (no job then exists to ever settle); otherwise the
             * broker's own leak-guard timeout is what eventually cleans it up.
             * Awaited: one bounded write is what makes the run's learning survive
             * a crash, and it is cheap enough to sit on the response path.
             * `factory.poke(ctx.owner)` is not awaited — draining costs an inference call,
             * and the subscription is what surfaces its eventual outcome,
             * asynchronously, off this path.
             *
             * Absent entirely when {@link MemoryCapabilityOptions.enqueueOnRunEnd}
             * is `false`, which is how an indexing pass avoids enqueueing itself.
             */
            async onRunEnd(record: ExecutionRecord): Promise<void> {
              const emit = ctx.emit;
              const emitNotice = (notice: MemoryIngestNotice): void =>
                emit({
                  capability: MEMORY_CAPABILITY_NAME,
                  kind: MEMORY_INGEST_EVENT,
                  detail: notice,
                });
              const unsubscribe = factory?.subscribeToRun(ctx.owner, record.id, emitNotice);
              await enqueueFinishedRun({
                memory,
                providerKey,
                record,
                workspaceRoot: ctx.workspaceRoot,
                ...(ctx.logger !== undefined ? { logger: ctx.logger } : {}),
                onNotice: (notice: MemoryIngestNotice) => {
                  emitNotice(notice);
                  if (notice.phase === "failed") unsubscribe?.();
                },
              });
              factory?.poke(ctx.owner);
            },
          }),
  };
}
