/**
 * The per-run indexer: one finished run folded into the wiki by a real agent run.
 *
 * @remarks This replaced a single completion that returned a JSON array of
 * whole-document writes. The change that matters is not the plumbing but the
 * primitive: updating one fact in a 3 KB `TOPIC.md` used to mean re-emitting all
 * 3 KB of it — plus every ancestor and `PROFILE.md`, in one array — which is
 * what produced truncated JSON, and why "preserve everything still true" was
 * instruction rather than mechanism. The pass now edits through `edit_memory`.
 *
 * **What the critical section used to buy, and what replaced it.** The old pass
 * ran wholly inside one `store.exclusive` and applied every change in one
 * all-or-nothing batch that also carried the `mark_indexed` commit. As a run,
 * each tool call takes its own lock and its own batch, so:
 *
 * - Serialization across the pass is gone, and that is a gain: the tree lock no
 *   longer spans an inference, during which `query_memories`, the memory panel
 *   and every concurrent run's `seed()` were blocked.
 * - Cross-document atomicity is gone, but it protected less than it appeared to.
 *   Every mutating tool runs the deterministic reindex in its own batch, and the
 *   reindex scaffolds missing `PROFILE.md`/`TOPIC.md` — so "a PROFILE describing
 *   a leaf that was never written" was already structurally impossible. What the
 *   batch protected is compiled *prose* consistency. Three things replace it: the
 *   finalize gate refuses to let the agent stop mid-pyramid, a crashed pass is
 *   retried against a tree it can now *read* and so converges instead of
 *   restarting, and the base prompt's leaf-then-ancestors order bounds the worst
 *   surviving state to one a hand-written `write_memory` already produces.
 * - Exactly-once per run is re-established explicitly: `markIndexed` is its own
 *   durable write, made only after a `completed` run. `MemoryBatchCommit.mark_indexed`
 *   keeps its mechanism and loses its only producer — recovery still replays a
 *   planted commit, which is what `journal-recovery.test.ts` covers.
 *
 * **Never start a pass from inside `store.exclusive`.** The file store's lock is
 * re-entrant (an `AsyncLocalStorage` check), so doing so would not deadlock — the
 * tool calls would silently join the outer handle and hold the tree lock for the
 * whole run. Nothing enforces this; it is why the recovery probe below takes and
 * releases its own section rather than wrapping the run.
 */
import {
  NOOP_LOGGER,
  sanitizeDeep,
  sanitizeText,
  type Elicit,
  type Logger,
  type RunRequest,
} from "@clarvis/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";
import { BUILTIN_GRANT_NAMES } from "@clarvis/loop/host";
import type { MemoryJobPhase } from "../jobs.ts";
import type { MemoryBudgets, MemoryMutationFence, MemoryStore, RunSnapshot } from "../types.ts";
import type { IndexReport } from "../memory-contract.ts";
import type { IndexerRuntime } from "../types.ts";
import { createIndexerMemoryCapability, createIndexingPassCapability } from "./capability.ts";
import { createTouchedLedger, pyramidIssue, type TouchedLedger } from "./pyramid.ts";
import {
  buildIndexerContinuationRequest,
  buildIndexerRequest,
  continuationBlocker,
  type ContinuationBlocker,
} from "./request.ts";
import { buildIndexerTask } from "./task.ts";

/**
 * A failed index pass, tagged with the stage that failed.
 *
 * @remarks The drain decides retry policy per stage — a pass that cannot close
 * the pyramid twice will not on the fifth try, while a transport blip deserves
 * full backoff — so the phase has to survive as data rather than as prose in a
 * note string.
 */
export class MemoryIndexError extends Error {
  /** Stable machine-readable discriminator. */
  readonly code = "memory_index_failed";

  /** Which stage failed. */
  readonly phase: MemoryJobPhase;

  /** Set when retrying cannot help. */
  readonly terminal: boolean;

  /** The indexer run's own id, when one was started — so a failed pass is inspectable. */
  readonly indexerRunId: string | undefined;

  constructor(
    phase: MemoryJobPhase,
    message: string,
    opts: { terminal?: boolean; indexerRunId?: string } = {},
  ) {
    super(message);
    this.name = "MemoryIndexError";
    this.phase = phase;
    this.terminal = opts.terminal === true;
    this.indexerRunId = opts.indexerRunId;
  }
}

/** Everything one pass needs beyond its runtime. */
export interface IndexRunArgs {
  run: RunSnapshot;
  store: MemoryStore;
  budgets: MemoryBudgets;
  /** Resolves the deps, owner, model and providers this pass runs with. */
  indexer: IndexerRuntime;
  signal?: AbortSignal;
  /** Durable queue-claim fence; direct/manual index calls omit it. */
  mutationFence?: MemoryMutationFence;
  /**
   * Where the pass reports which form it took, and what it cost.
   *
   * @remarks The queue is durable and drains in the background, so nothing on
   * the response path can observe a pass at all. `continuation_blocker` in
   * particular was computed on every pass and read by no `src` file.
   */
  logger?: Logger;
}

/**
 * Every elicitation an indexing pass raises is declined.
 *
 * @remarks Supplying this is what lets a pass **continue** a run whose entry
 * profile carries an `ask_user` grant. `executeRun` refuses such a request
 * outright when no `elicit` is wired (`elicitation_not_supported`), and a
 * continuation inherits the coder's profile verbatim — grants included — because
 * grants decide the tool array and the system head, so stripping them to avoid
 * the check would break the very prefix the pass exists to reuse.
 *
 * Declining is the honest answer rather than a workaround: the pass runs
 * unattended on a background drain, so there is no human to reach. `ask_user`
 * never actually executes either — it is outside the pass capability's allowed
 * wire names and is refused at dispatch — so this only satisfies the pre-flight
 * check that fires before any tool runs.
 */
const declineElicit: Elicit = () => Promise.resolve({ action: "decline" });

/** A pass that did nothing, and why. */
function emptyReport(runId: string, note: string): IndexReport {
  return { run_id: runId, skipped: true, note, written: [], deleted: [], reindexed: false };
}

/**
 * Fold one finished run into the wiki.
 *
 * @param args - see {@link IndexRunArgs}.
 * @returns what the pass changed, or a skipped report with a note.
 * @throws {@link MemoryIndexError} classified by phase: `generate` when the run
 *   could not be produced or ended in error, `validate` when it finished without
 *   closing the pyramid, `commit` when the tree writes landed but marking the run
 *   indexed failed, `apply` for a store fault.
 */
export async function indexRun(args: IndexRunArgs): Promise<IndexReport> {
  const { run, store, budgets, indexer, signal, mutationFence } = args;
  const logger = args.logger ?? NOOP_LOGGER;
  const startedAt = Date.now();

  if (indexer.memoryProvider !== undefined && indexer.memoryProvider.writeTools === undefined) {
    return emptyReport(run.run_id, "provider-read-only");
  }

  if (await store.exclusive((tx) => tx.wasIndexed(run.run_id))) {
    return emptyReport(run.run_id, "already-indexed");
  }

  // A frozen tree would otherwise surface as every mutating tool failing inside
  // its own batch, where the tool wrapper turns a throw into an ordinary error
  // result — so the model would burn its whole iteration budget on tools that
  // cannot succeed. The probe lets the drain refund the claim and report
  // `blocked`, exactly as it did when the error propagated out of a single call.
  const recovery = await store.recover();
  if (recovery.required) {
    const blocked = recovery.entries.find((e) => e.outcome === "required");
    throw new MemoryIndexError(
      "apply",
      `memory is awaiting recovery${blocked === undefined ? "" : `: batch ${blocked.batch_id}`}`,
    );
  }

  const ledger = createTouchedLedger();
  const { executeRun, generateExecutionId } = await import("@clarvis/loop");
  const indexerRunId = generateExecutionId();
  const plan = planPass({
    run,
    indexer,
    indexerRunId,
    store,
    budgets,
    ledger,
    ...(mutationFence !== undefined ? { mutationFence } : {}),
  });

  let outcome;
  try {
    outcome = await executeRun({
      rawBody: plan.rawBody,
      owner: indexer.owner,
      deps: plan.deps,
      elicit: declineElicit,
      ...(signal !== undefined ? { externalSignal: signal } : {}),
    });
  } catch (err) {
    throw new MemoryIndexError("generate", `index-run-failed: ${message(err)}`, {
      terminal: isTerminalRunFailure(err),
      indexerRunId,
    });
  }

  const mutations = ledger.all();
  const status = outcome.response.status;
  if (status === "error") {
    const terminal = outcome.response.error.code === "no_progress";
    throw new MemoryIndexError(
      "generate",
      `index-run-errored: ${outcome.response.error.code}: ${outcome.response.error.message}`,
      { indexerRunId, terminal },
    );
  }

  // Only a run that genuinely finished may mark its subject indexed. A pass that
  // was cancelled, or that ran out of budget, has not decided there is nothing to
  // learn — it simply stopped, and marking it would discard that run's learning
  // for good. `budget_exhausted` and `soft_limit_declined` are the shapes an open
  // pyramid takes when the gate keeps sending the agent back until it runs out.
  if (status !== "completed") {
    throw new MemoryIndexError("validate", `index-run-${status}`, { indexerRunId });
  }

  const open = pyramidIssue(mutations);
  if (open !== null) {
    throw new MemoryIndexError("validate", `pyramid-not-closed: ${open}`, { indexerRunId });
  }

  try {
    const committed = await store.exclusive(async (tx) => {
      if (mutationFence !== undefined && !(await mutationFence.before(tx))) return false;
      try {
        await tx.markIndexed(run.run_id);
        return mutationFence === undefined || (await mutationFence.after(tx));
      } catch (error) {
        if (mutationFence !== undefined) await mutationFence.after(tx);
        throw error;
      }
    });
    if (!committed) {
      throw new MemoryIndexError("commit", "index claim lost before mark-indexed settled", {
        indexerRunId,
      });
    }
  } catch (err) {
    throw new MemoryIndexError("commit", `mark-indexed-failed: ${message(err)}`, { indexerRunId });
  }

  const writtenPaths = new Set<string>();
  const deletedPaths = new Set<string>();
  for (const mutation of mutations) {
    (mutation.tool === "delete_memory" ? deletedPaths : writtenPaths).add(mutation.path);
  }
  const written = [...writtenPaths];
  const deleted = [...deletedPaths];
  logger.info(
    {
      event: "memory.index.pass",
      run_id: run.run_id,
      indexer_run_id: indexerRunId,
      pass: plan.blocker === null ? "continuation" : "isolated",
      continuation_blocker: plan.blocker,
      written: written.length,
      deleted: deleted.length,
      ms: Date.now() - startedAt,
    },
    plan.blocker === null
      ? "an index pass continued the run it indexes, so the provider served its transcript from the prefix cache"
      : "an index pass ran from a digest instead of continuing the run it indexes, and paid full price for the transcript",
  );
  return {
    run_id: run.run_id,
    skipped: mutations.length === 0,
    ...(mutations.length === 0 ? { note: "nothing-to-record" } : {}),
    written,
    deleted,
    reindexed: mutations.length > 0,
    indexer_run_id: indexerRunId,
    continuation_blocker: plan.blocker,
  };
}

/** How one pass will run, and why. */
export interface PassPlan {
  rawBody: RunRequest;
  deps: ExecuteRunDeps;
  /** Why the pass is not continuing the indexed run, or `null` when it is. */
  blocker: ContinuationBlocker | "no-pass-deps" | null;
}

/**
 * Choose between continuing the indexed run and indexing it from a digest.
 *
 * @returns the request and deps for whichever path applies, with the reason.
 * @remarks The **hot** path resumes the indexed run's persisted context, so the
 *   provider serves everything up to the appended instruction from its prefix
 *   cache. Its capability list is the host's with the pass capability
 *   *prepended*: contributions fold in registration order and dispatch takes the
 *   first match, so the pass's handlers shadow the host memory capability's
 *   without removing a single advertised tool. Nothing is filtered here — the
 *   host already handed over deps with hooks absent and the enqueue suppressed,
 *   because it is the host that owns capability composition.
 *
 *   The **cold** path replaces the list outright and pushes a digest, which is
 *   correct under every condition and merely costs more. It is what runs when
 *   the indexed run left no resumable context, declared MCP servers, or was
 *   answered by a different model than the one indexing it.
 */
export function planPass(args: {
  run: RunSnapshot;
  indexer: IndexerRuntime;
  indexerRunId: string;
  store: MemoryStore;
  budgets: MemoryBudgets;
  ledger: TouchedLedger;
  mutationFence?: MemoryMutationFence;
}): PassPlan {
  const { run, indexer, indexerRunId, store, budgets, ledger, mutationFence } = args;
  const capabilityArgs = {
    store,
    runId: run.run_id,
    budgets,
    ledger,
    ...(mutationFence !== undefined ? { mutationFence } : {}),
    ...(indexer.memoryProvider !== undefined ? { provider: indexer.memoryProvider } : {}),
  };
  const passDeps = indexer.passDeps;

  if (passDeps !== undefined) {
    const subject = indexer.deps.traceStore.getById(indexer.owner, run.run_id);
    const blocker = continuationBlocker(subject, indexer.modelRef, knownGrants(passDeps));
    if (blocker === null && subject !== null) {
      return {
        rawBody: buildIndexerContinuationRequest({
          executionId: indexerRunId,
          subject,
          providers: indexer.providers,
          policy: indexer.policy,
        }),
        deps: {
          ...passDeps,
          capabilities: [
            createIndexingPassCapability(capabilityArgs),
            ...(passDeps.capabilities ?? []),
          ],
        },
        blocker: null,
      };
    }
    return { ...isolatedPass(args), blocker };
  }
  return { ...isolatedPass(args), blocker: "no-pass-deps" };
}

/** Every grant the continuation deps can validate without changing their wire surface. */
function knownGrants(deps: ExecuteRunDeps): ReadonlySet<string> {
  return new Set([
    ...BUILTIN_GRANT_NAMES,
    ...(deps.capabilityRegistry?.grants() ?? []).map((grant) => grant.name),
    ...(deps.capabilities ?? []).flatMap((capability) =>
      (capability.grants ?? []).map((grant) => grant.name),
    ),
  ]);
}

/**
 * The request and deps for a pass that runs on its own.
 *
 * @remarks The capability list is REPLACED, not filtered: an isolated pass must
 * not inherit whatever else the host has registered on the shared deps. Hooks in
 * particular are not gated by grants, so a workspace `PreToolUse` hook would
 * otherwise fire on the pass's own writes. And that capability has no
 * `onRunEnd`, which is what makes indexing itself structurally impossible rather
 * than a flag away.
 */
function isolatedPass(args: {
  run: RunSnapshot;
  indexer: IndexerRuntime;
  indexerRunId: string;
  store: MemoryStore;
  budgets: MemoryBudgets;
  ledger: TouchedLedger;
  mutationFence?: MemoryMutationFence;
}): { rawBody: RunRequest; deps: ExecuteRunDeps } {
  const { run, indexer, indexerRunId, store, budgets, ledger, mutationFence } = args;
  return {
    rawBody: buildIndexerRequest({
      executionId: indexerRunId,
      task: buildIndexerTask(sanitizeDeep(run, sanitizeText), budgets),
      modelRef: indexer.modelRef,
      providers: indexer.providers,
      policy: indexer.policy,
    }),
    deps: {
      ...indexer.deps,
      capabilities: [
        createIndexerMemoryCapability({
          store,
          runId: run.run_id,
          budgets,
          ledger,
          ...(mutationFence !== undefined ? { mutationFence } : {}),
          ...(indexer.memoryProvider !== undefined ? { provider: indexer.memoryProvider } : {}),
        }),
      ],
    },
  };
}

/** An error's message, however it was thrown. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether a failed `executeRun` is worth retrying.
 *
 * @remarks A malformed assembled request or an undeclared provider is a defect
 * in what this package builds, not a transient fault — retrying it five times
 * buys nothing but latency. Everything else rides the ordinary budget.
 */
function isTerminalRunFailure(err: unknown): boolean {
  return err instanceof Error && err.name === "ValidationError";
}
