/**
 * The core contract of `@clarvis/workflows`: what the manager LLM controls when
 * it fires a leader ({@link LeaderSpec}), what comes back ({@link LeaderResult}),
 * the injected request-assembly port ({@link LeaderRequestAssembler}), and the
 * per-workflow context ({@link WorkflowCtx}) shared by every leader spawn.
 */
import type { Elicit, RunRequest, SteerSource, TraceEvent, Usage } from "@clarvis/capability";
import type { ExecuteRunArgs, ExecuteRunDeps, ExecuteRunOutcome } from "@clarvis/loop";
import type { WorkflowDefinition } from "./artifact.ts";
import type { WorkflowSemaphore } from "./concurrency.ts";
import type { WorkflowLedger } from "./ledger.ts";
import type { LeaderProfileInfo } from "./tool.ts";

/**
 * The curated subset of a run request the manager LLM controls when it issues a
 * `run_leader` call: a short human-facing `title`, the `prompt` (the leader's
 * full task), an optional `profile` to run the leader as, and an optional
 * `expectSchema` (a JSON Schema) that forces a structured leader result.
 */
export interface LeaderSpec {
  /** Short label shown in the agent list and transcript while the leader runs. */
  title: string;
  prompt: string;
  profile?: string;
  expectSchema?: Record<string, unknown>;
}

/**
 * A leader run's terminal status, projected verbatim from the loop's
 * {@link import("@clarvis/capability").RunResponse | RunResponse} status so the manager
 * sees the true outcome (a host may later collapse this to a coarser wire status).
 */
export type LeaderStatus =
  "completed" | "budget_exhausted" | "cancelled" | "soft_limit_declined" | "interrupted" | "error";

/**
 * The outcome of one leader run: its own execution `runId`, terminal `status`,
 * the `result` (text or the structured object when `expectSchema` was set),
 * summed `usage`, and a structured `error` on the `error` status.
 */
export interface LeaderResult {
  runId: string;
  status: LeaderStatus;
  result: unknown;
  usage: Usage;
  error?: { code: string; message: string };
}

/**
 * Expands a {@link LeaderSpec} into a full {@link RunRequest} for the leader's
 * isolated `executeRun`.
 *
 * @remarks Implementations MUST exclude the `workflow`
 *   {@link import("@clarvis/capability").Grant | Grant} (so a leader can never receive
 *   `run_leader` and become a manager) and force `plans: "off"` (parallel leaders
 *   share one workspace, whose plan store admits one active plan at a time). The
 *   leader keeps `can_spawn`, so it can still delegate its own sub-agents, but
 *   forces `memory: "off"` because only the primary manager run may enqueue a
 *   memory job for the workflow.
 */
export type LeaderRequestAssembler = (spec: LeaderSpec, ctx: { parentRunId: string }) => RunRequest;

/**
 * The two loop operations workflow orchestration needs at runtime.
 *
 * @remarks A host supplies the real implementation at its composition root;
 * tests can provide a per-context fake without replacing the process-wide
 * `@clarvis/loop` module. Keeping this port narrower than {@link ExecuteRunDeps}
 * also makes the workflow package's execution boundary explicit.
 */
export interface WorkflowRunDeps {
  generateExecutionId(): string;
  executeRun(args: ExecuteRunArgs): Promise<ExecuteRunOutcome>;
}

/**
 * The tree-wide context, created once per workflow (on the manager run) and shared
 * with every leader spawn.
 *
 * @remarks `semaphore` and `ledger` bound the fan-out's width and cost; `assemble`
 *   builds each leader's isolated request; `elicitForLeader` supplies the
 *   serialized elicit channel for a given leader (so concurrent leaders never
 *   prompt the user at once); `onLeaderEvent` forwards a leader's structural trace
 *   events up to the workflow's event stream; `signal` cancels the whole tree.
 */
export interface WorkflowCtx {
  deps: ExecuteRunDeps;
  runDeps: WorkflowRunDeps;
  owner: string;
  semaphore: WorkflowSemaphore;
  ledger: WorkflowLedger;
  /** The run's concurrency cap (the same limit `semaphore` enforces), passed to
   * {@link WorkflowLedger.reserve} so a budget reservation is sized fairly. */
  maxConcurrency: number;
  assemble: LeaderRequestAssembler;
  managerRunId: string;
  signal: AbortSignal;
  /** Manager-selectable leader profiles, used to populate the `run_leader` tool's
   * `profile` enum. */
  leaderProfiles?: readonly LeaderProfileInfo[];
  /**
   * The built-in and operator-authored workflow definitions available to this run.
   *
   * @remarks Supplied by the host, which owns the directory vocabulary; this
   * package never reads a root itself. Absent or empty means `run_workflow` is
   * not contributed at all, rather than contributed with an empty `name` enum.
   */
  workflowDefs?: readonly WorkflowDefinition[];
  /** Supplies a leader's serialized elicit channel; absent when the run has no
   * user-input channel. */
  elicitForLeader?: (runId: string) => Elicit | undefined;
  /** Forwards a leader's structural trace events (delegation, iteration, status)
   * up to the workflow's event stream, tagged with the origin `runId`. */
  onLeaderEvent?: (runId: string, event: TraceEvent) => void;
  /** Marks the workflow incomplete when a leader could not start for lack of
   * output-token headroom. */
  onBudgetExhausted?: () => void;
  /**
   * Supplies a leader's own steer channel, so its manager can redirect it
   * mid-flight through `agent_steer`.
   *
   * @remarks Mirrors {@link WorkflowCtx.elicitForLeader}. The host never sets it:
   * the capability populates it on a per-call clone of this context, where the
   * `agent_id` ↔ `run_id` correspondence is known. A run-level steer still
   * reaches only the entry agent.
   */
  steerForLeader?: (runId: string) => SteerSource | undefined;
}
