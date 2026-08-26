/**
 * The memory capabilities an indexer pass runs with — one per pass shape.
 *
 * {@link createIndexerMemoryCapability} is the **cold** shape: it replaces the
 * host's whole capability list, advertises the wiki tools itself, and is what a
 * pass uses when it cannot reuse the indexed run's prompt prefix.
 *
 * {@link createIndexingPassCapability} is the **hot** shape: it is *prepended*
 * to the host's list and advertises nothing at all, because the pass continues
 * the indexed run and every byte of that run's tool array has to survive
 * untouched for the provider's prefix cache to serve it.
 *
 * Both stamp `{ kind: "indexer", run_id }` provenance, carry the pass's own call
 * budgets, contribute the pyramid finalize gate, and have **no `onRunEnd`** — so
 * there is no boolean whose wrong value makes a pass index itself forever.
 */
import type {
  AgentCapability,
  Capability,
  HandlerBase,
  HandlerVerdict,
  RunCapability,
  ToolHandler,
} from "@clarvis/capability";
import { handlerBaseOf, openCallEnvelope } from "@clarvis/capability";
import { SUBMIT_RESULT_TOOL_NAME } from "@clarvis/loop/host";
import { buildMemoryToolsHandler } from "../handler.ts";
import { reindex as reindexTree } from "../reindex.ts";
import { MEMORY_CAPABILITY_NAME } from "../settings.ts";
import { createMemoryTools } from "../tools.ts";
import { buildMemoryToolset, type MemoryToolset } from "../toolset.ts";
import { WIKI_PROVIDER_KIND, type MemoryProvider } from "../provider.ts";
import type {
  MemoryBudgets,
  MemoryMutationFence,
  MemoryStore,
  MemoryToolDef,
  MemoryToolResult,
} from "../types.ts";
import { buildPyramidGate, createTouchedLedger, type TouchedLedger } from "./pyramid.ts";

/** The read-only navigation half of the memory toolset. */
const READ_TOOLS = new Set(["list_memories", "query_memories", "read_memory", "grep_memories"]);
const LOST_INDEX_CLAIM = "The memory index claim is no longer current; stale mutation refused.";

/** Collaborators both indexer capability shapes need. */
export interface IndexerCapabilityArgs {
  /** The wiki this pass maintains. */
  store: MemoryStore;
  /** Selected provider. Omitted only by built-in-wiki callers and older hosts. */
  provider?: MemoryProvider;
  /** The id of the run being indexed — the provenance stamped on every revision. */
  runId: string;
  /** Budgets; `max_index_ops` becomes the write toolset's call limit. */
  budgets: MemoryBudgets;
  /** Receives every mutation that lands, so the caller can report what changed. */
  ledger?: TouchedLedger;
  /** Queue-claim fence supplied by the durable drain. */
  mutationFence?: MemoryMutationFence;
}

/** The toolsets and ledger a pass runs over, shared by both capability shapes. */
interface IndexerParts {
  ledger: TouchedLedger;
  readToolset: MemoryToolset;
  writeToolset: MemoryToolset;
}

/**
 * Hold the queue/tree unit of work across one external provider write.
 *
 * @remarks Unlike the built-in wiki, an external provider does not receive the
 * unit-of-work handle. The wrapper therefore owns the critical section and
 * keeps it until the remote call returns, preventing a reclaim from replacing
 * the token while the provider is executing the mutation.
 */
function fenceProviderWrites(
  store: MemoryStore,
  tools: readonly MemoryToolDef[],
  fence: MemoryMutationFence | undefined,
): MemoryToolDef[] {
  if (fence === undefined) return [...tools];
  const lost = (): MemoryToolResult => ({ text: LOST_INDEX_CLAIM, isError: true });
  return tools.map((tool) => ({
    ...tool,
    execute: (args, signal) =>
      store.exclusive(async (tx) => {
        if (!(await fence.before(tx))) return lost();
        try {
          const result = await tool.execute(args, signal);
          if (!(await fence.after(tx))) return lost();
          return result;
        } catch (error) {
          await fence.after(tx);
          throw error;
        }
      }),
  }));
}

/**
 * Build the pass's toolsets over the wiki.
 *
 * @param args - see {@link IndexerCapabilityArgs}.
 * @returns the read and write toolsets plus the ledger they report to.
 * @remarks Navigation is deliberately unbudgeted: `CLARVIS_MEMORY_TOOL_CALL_LIMIT`
 *   defaults to a figure sized for a coding run that happens to consult memory,
 *   whereas reading the tree *is* this run's job — its real bound is the
 *   iteration limit. The write half keeps `max_index_ops`, which is where the
 *   "report, don't truncate" behaviour lives: the (N+1)th mutating call is
 *   refused with a message the model can act on, rather than silently dropped.
 */
function buildIndexerParts(args: IndexerCapabilityArgs): IndexerParts {
  const { store, runId, budgets, provider, mutationFence } = args;
  const usesWiki = provider === undefined || provider.kind === WIKI_PROVIDER_KIND;
  const tools = usesWiki
    ? createMemoryTools({
        store,
        reindex: (tx) => reindexTree(tx),
        source: { kind: "indexer", run_id: runId },
        intent: "indexer",
        ...(mutationFence !== undefined ? { mutationFence } : {}),
      })
    : [
        ...provider.readTools,
        ...fenceProviderWrites(store, provider.writeTools ?? [], mutationFence),
      ];
  return {
    ledger: args.ledger ?? createTouchedLedger(),
    readToolset: buildMemoryToolset(
      tools.filter((tool) => READ_TOOLS.has(tool.name)),
      Number.MAX_SAFE_INTEGER,
    ),
    writeToolset: buildMemoryToolset(
      tools.filter((tool) => !READ_TOOLS.has(tool.name)),
      budgets.max_index_ops,
    ),
  };
}

/**
 * Build the indexer's memory capability for a pass that runs on its own.
 *
 * @param args - see {@link IndexerCapabilityArgs}.
 * @returns a {@link Capability} contributing the seven wiki tools and the
 *   pyramid finalize gate, and nothing else.
 * @remarks An isolated pass's `deps.capabilities` is **replaced** by a list
 *   containing only this, rather than filtered from the host's. Two reasons,
 *   both concrete. A filter inherits every capability the host registers
 *   *later*, and workspace hooks in particular are not gated by grants — a
 *   user's `PreToolUse` hook would fire on the pass's own `write_memory` calls.
 *   And the enqueue half is not *withheld* here, it does not exist.
 */
export function createIndexerMemoryCapability(args: IndexerCapabilityArgs): Capability {
  const { ledger, readToolset, writeToolset } = buildIndexerParts(args);

  return {
    name: MEMORY_CAPABILITY_NAME,
    forRun(): RunCapability {
      return {
        name: MEMORY_CAPABILITY_NAME,
        forAgent(): AgentCapability {
          return {
            attach(bc) {
              const base = handlerBaseOf(bc);
              const handlers: ToolHandler[] = [
                buildMemoryToolsHandler({ base, toolset: readToolset }),
                buildMemoryToolsHandler({
                  base,
                  toolset: writeToolset,
                  onMutation: (m) => ledger.record(m),
                }),
              ];
              return {
                tools: [...readToolset.defs, ...writeToolset.defs],
                handlers,
                gates: [buildPyramidGate(ledger)],
                advertised: true,
              };
            },
          };
        },
      };
    },
  };
}

/**
 * The wire names a pass over an indexed run's prefix is allowed to call.
 *
 * @param parts - the pass's toolsets.
 * @returns the seven wiki tools plus `submit_result`.
 * @remarks `submit_result` is not optional. The engine appends its own handler
 *   for it *after* every capability handler
 *   (`runtime/loop/run-agent.ts`: `[...folded.handlers, submitHandler]`), and
 *   dispatch takes the **first** match — so a refusal handler that swallowed it
 *   would leave the pass unable to finish at all.
 */
function allowedWireNames(parts: IndexerParts): ReadonlySet<string> {
  return new Set([
    ...parts.readToolset.names,
    ...parts.writeToolset.names,
    SUBMIT_RESULT_TOOL_NAME,
  ]);
}

/**
 * Refuse every tool the pass inherited from the run it is continuing.
 *
 * @param deps - the handler base and the names that stay callable.
 * @returns a {@link ToolHandler} matching everything outside `allowed`.
 * @remarks Refusal happens at *dispatch*, never by withholding the tool from the
 *   advertised array: the array is what the provider cached, and dropping one
 *   entry from it re-bills the whole request. So the pass is offered the indexed
 *   run's full toolset and permitted only its own — advertised, then denied.
 *   `delegate_task` is the reason this cannot be skipped when the profile looks
 *   harmless: a continuation inherits the *coder's* profile, which may well
 *   carry `can_spawn`.
 */
function buildRefusalHandler(deps: {
  base: HandlerBase;
  allowed: ReadonlySet<string>;
}): ToolHandler {
  const { base, allowed } = deps;
  return {
    matches: (call) => !allowed.has(call.name),
    handle(call, iteration): Promise<HandlerVerdict> {
      const envelope = openCallEnvelope({
        call,
        name: call.name,
        trace: base.trace,
        agent: base.agent,
        ...(base.subagentInstanceId !== undefined
          ? { subagentInstanceId: base.subagentInstanceId }
          : {}),
        iteration,
      });
      return Promise.resolve({
        kind: "result",
        text: envelope.fail(
          `'${call.name}' is not available in this pass. You are updating the memory wiki for a ` +
            "run that has already finished: the only tools that work here are the memory ones, " +
            "and submit_result when you are done.",
        ),
        progress: false,
      });
    },
  };
}

/**
 * Build the memory capability for a pass that continues the run it indexes.
 *
 * @param args - see {@link IndexerCapabilityArgs}.
 * @returns a {@link Capability} to **prepend** to the host's list.
 * @remarks It advertises **no tools, no system section and no seed block**, and
 *   that emptiness is the whole point. The pass is a `continue_from` of the
 *   indexed run, so it is served from the provider's prefix cache only while the
 *   request is byte-identical up to the appended instruction — and all three of
 *   those surfaces sit ahead of it. Contributing one tool reorders the array;
 *   contributing a system section changes the head at byte 0; failing to
 *   contribute a seed block would drop the marker from `liveMarkers` and delete
 *   the carried block out of the middle of the transcript
 *   (`runtime/entry-seed.ts`). Only handlers and a finalize gate are invisible
 *   on the wire, so only those are used.
 *
 *   Prepending is what makes it win: contributions fold in registration order
 *   and dispatch takes the first match, so these handlers shadow the host memory
 *   capability's without either one knowing about the other.
 */
export function createIndexingPassCapability(args: IndexerCapabilityArgs): Capability {
  const parts = buildIndexerParts(args);
  const { ledger, readToolset, writeToolset } = parts;
  const allowed = allowedWireNames(parts);

  return {
    name: MEMORY_CAPABILITY_NAME,
    forRun(): RunCapability {
      return {
        name: MEMORY_CAPABILITY_NAME,
        forAgent(): AgentCapability {
          return {
            attach(bc) {
              const base = handlerBaseOf(bc);
              const handlers: ToolHandler[] = [
                buildMemoryToolsHandler({ base, toolset: readToolset }),
                buildMemoryToolsHandler({
                  base,
                  toolset: writeToolset,
                  onMutation: (m) => ledger.record(m),
                }),
                buildRefusalHandler({ base, allowed }),
              ];
              return { handlers, gates: [buildPyramidGate(ledger)] };
            },
          };
        },
      };
    },
  };
}
