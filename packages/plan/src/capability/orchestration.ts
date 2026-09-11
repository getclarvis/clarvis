/**
 * The `plans` capability's agent-loop contribution: the plan runtime tools, the
 * human review gate, the open-task finalization gate, the review blocker, the
 * canonical-state anchor, and the port `delegation` consults.
 *
 * It owns the run's {@link PlanSession} and every piece of state derived from
 * it. Delegation reaches none of that directly — it holds a
 * {@link PlanDelegationPort} and nothing else — which is what allows this whole
 * module to move into `@clarvis/plan` without delegation moving with it.
 */
import { NOOP_LOGGER, projected, type Logger } from "@clarvis/capability";
import { renderPlan } from "../format.ts";
import type { PlanDocument, PlanRef, PlanRetention } from "../schemas.ts";
import type { PlanStore } from "../store.ts";
import type {
  AgentLoopContribution,
  CapabilityEventListener,
  PlanReviewDetail,
  ToolEffectPort,
} from "@clarvis/capability";
import { partialStructOf, type AgentResult } from "@clarvis/capability";
import type { AgentBuildContext } from "@clarvis/capability";
import type { FinalizeGate, GateOutcome, HandlerVerdict, ToolHandler } from "@clarvis/capability";
import {
  planNotApprovedRejection,
  type PlanReviewAsk,
  type PlanReviewDecision,
} from "./review-gate.ts";
import {
  PLAN_REVIEW_AWAITING_APPROVAL_BLOCK,
  PLAN_REVIEW_BYPASS_NOTE,
  PLAN_REVIEW_BYPASS_MSG,
  PLAN_REVIEW_EXECUTE_NOTE,
  PENDING_TASKS_NOTE,
  buildDelegateTaskPlanAugmentation,
  duplicateBatchTaskId,
  planReviewSpawnBlock,
  planReviewUnplannedBlock,
} from "./messages.ts";
import { PlanSession, type MissingPlanState } from "./session.ts";
import {
  CREATE_PLAN_TOOL_NAME,
  REVISE_PLAN_TOOL_NAME,
  handlePlanRuntimeCall,
  buildPlanRuntimeTools,
} from "./runtime-tools.ts";
import { createDelegationPlanPort } from "./delegation-port.ts";
import {
  missingPlanCanonicalState,
  missingPlanHeader,
  missingPlanSpecBlock,
  planCanonicalState,
  planCasHeader,
  planSpecBlock,
} from "./canonical-state.ts";
import type { DelegateTaskAugmentation, PlanDelegationPort, SpawnGate } from "./task-port.ts";

/**
 * Hard ceiling on plan-review change-request rounds before the run terminates
 * with `plan_review_revision_limit` (see {@link buildPlansOrchestration}).
 *
 * @remarks A backstop against a non-converging revise/reject cycle, not a
 * budget anyone is meant to spend. Every round costs a full plan rewrite and a
 * human decision, so a person reviewing in good faith stops long before this —
 * which is why it only has to sit past any plausible genuine back-and-forth.
 * What it really guards is the case where the answers stop being considered:
 * an automated or repeated rejection that the model keeps responding to, which
 * would otherwise revise forever inside a gate that never opens.
 */
const MAX_PLAN_REVIEW_REVISIONS = 10;

/**
 * Project a {@link PlanDocument} into the flat, wire-friendly detail carried on
 * `plans` capability events (plan created/updated/review).
 *
 * @param document - the live plan document.
 * @returns the plan's identity, status, both revisions, prose sections, and its
 *   tasks reduced to id/title/status plus only the optional fields
 *   (`detail`/`exit`/`assignee`/`result`/`error`/`reason`) that are actually
 *   present.
 */
export function planProjection(document: PlanDocument) {
  return {
    id: document.id,
    ...(document.path === undefined ? {} : { path: document.path }),
    title: document.title,
    status: document.status,
    retention: document.retention,
    revision: document.revision,
    spec_revision: document.spec_revision,
    objective: document.objective,
    context: document.context,
    validation: document.validation,
    tasks: document.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      ...(task.detail === undefined ? {} : { detail: task.detail }),
      ...(task.exit === undefined ? {} : { exit: task.exit }),
      ...(task.assignee === undefined ? {} : { assignee: task.assignee }),
      ...(task.result === undefined ? {} : { result: task.result }),
      ...(task.error === undefined ? {} : { error: task.error }),
      ...(task.reason === undefined ? {} : { reason: task.reason }),
    })),
  };
}

/** Project a missing-plan tombstone onto the protocol's `plan_removed` detail. */
export function removedPlanProjection(missing: MissingPlanState) {
  const document = missing.document;
  return {
    id: missing.id,
    ...(missing.path === undefined ? {} : { path: missing.path }),
    revision: missing.revision,
    spec_revision: missing.specRevision,
    ...(document === undefined
      ? {}
      : {
          title: document.title,
          status: document.status,
          retention: document.retention,
          tasks: planProjection(document).tasks,
        }),
  };
}

/**
 * Compose the nudge shown to the model after the human requested plan changes.
 *
 * @param isSubmit - whether the blocked attempt was a `submit_result` (versus an
 *   ordinary finalize); a submit gets the stronger "not approved, submit again"
 *   phrasing.
 * @param feedback - optional human feedback appended to the note.
 * @returns the rejection note to feed back as a tool/gate result.
 */
function planReviewRejectionNote(isSubmit: boolean, feedback: string | undefined): string {
  return isSubmit
    ? planNotApprovedRejection(feedback, "submit_result again")
    : `[runtime: the human requested changes${feedback !== undefined ? `: ${feedback}` : ""}. Revise the plan with revise_plan, then continue.]`;
}

/**
 * What {@link buildPlansOrchestration} needs: the agent build context, the plan
 * data plane and the run's identity, the review ask and retention, the
 * pending-task nudge policy, and the optional session/event sinks.
 *
 * @remarks `planReviewAsk` being present is what turns the review gate on;
 *   `pendingTaskNudges` is the consecutive-stall cap before an open-tasks
 *   termination. Forcing a tool after a nudge is the loop's own behaviour and no
 *   longer this capability's to arrange.
 */
export interface PlansOrchestrationDeps {
  bc: AgentBuildContext;
  planStore: PlanStore;
  providerKey: string;
  executionId: string;
  planReviewAsk?: PlanReviewAsk;
  /** Retention the plan is created with; the store's default applies when absent. */
  planRetention?: PlanRetention;
  pendingTaskNudges: number;
  initialRef?: PlanRef;
  /** Preloaded run session, used to reconcile a continuation before the agent starts. */
  planSession?: PlanSession;
  /**
   * Classifies a tool by workspace effect; the review blocker gates on it.
   *
   * @remarks Required rather than optional on purpose. Absent, every tool reads
   * as `unknown` and a `review` run is refused everything but planning — a
   * silent, total regression of the gate's scope. Making it mandatory turns a
   * forgotten wire into a compile error.
   */
  toolEffect: ToolEffectPort;
  onPlanSession?: (session: PlanSession) => void;
  emitCapabilityEvent?: CapabilityEventListener;
  /**
   * Operator diagnostics, forwarded to the session it builds and to every plan
   * tool call it dispatches.
   *
   * @remarks Optional only because the property cannot carry a default; it is
   * resolved to {@link NOOP_LOGGER} once when the orchestration is built.
   */
  logger?: Logger;
}

/**
 * What planning contributes to one agent: its {@link AgentLoopContribution} and
 * the {@link PlanDelegationPort} the delegation capability consults.
 */
export interface PlansOrchestration {
  contribution: AgentLoopContribution;
  port: PlanDelegationPort;
  /** The live session, so the capability can seal the plan at run end. */
  session: PlanSession;
}

/**
 * The result of presenting the plan-review gate to the human: `approved` to
 * proceed, `revise` (with optional feedback) to loop back for edits, or
 * `terminal` to end the run with the given {@link AgentResult} (cancelled, or the
 * revision-limit error).
 */
type PlanReviewGateOutcome =
  | { kind: "approved" }
  | { kind: "revise"; feedback?: string }
  | { kind: "terminal"; result: AgentResult };

/**
 * Run-lifetime plan/review bookkeeping that persists across loop iterations: the
 * review-round counter and one-shot bypass-nudge flag, the spec digest the human
 * last rejected (with their feedback), and the pending-task nudge tallies
 * (`pendingStall` consecutive no-progress rounds, `pendingNudgesTotal`, and the
 * open-task count at the last nudge for progress detection).
 *
 * @remarks `rejectedSpecDigest` is keyed by the plan's *substance*, not by the
 *   iteration, so an unrevised plan is never re-presented to the human while a
 *   genuinely revised one always is. Holding it per iteration re-asked the human
 *   to approve a byte-identical plan on every subsequent finalize attempt.
 */
interface SessionState {
  planReviewRevision: number;
  planReviewNudged: boolean;
  rejectedSpecDigest: string | undefined;
  rejectionFeedback: string | undefined;
  pendingStall: number;
  pendingNudgesTotal: number;
  lastNudgeOpenCount: number | null;
}

/**
 * Per-iteration flags, reset each `beforeIteration` (see {@link freshIter}):
 * whether plan content changed, whether the review gate requested changes this
 * iteration, and the task ids actually delegated this batch (`spawnedTaskIds`),
 * which drive both duplicate refusal and progress detection.
 *
 * @remarks The rejection itself lives in {@link SessionState}, keyed by spec
 *   digest; only the progress signal is per-iteration. `planReviewChangeRequested`
 *   is set when the human is actually asked and answers, never when a retry is
 *   turned away against an unchanged plan — a model re-attempting without
 *   revising has made no progress, and reporting otherwise would leave it
 *   looping until the iteration limit instead of tripping no-progress.
 *
 *   `spawnedTaskIds` is written through {@link PlanDelegationPort.noteSpawned}
 *   rather than shared with delegation as a closure variable, which is the
 *   whole point of the port.
 */
interface IterState {
  planContentChanged: boolean;
  planReviewChangeRequested: boolean;
  spawnedTaskIds: Set<string>;
}

/** Build a zeroed {@link IterState} for a fresh loop iteration. */
const freshIter = (): IterState => ({
  planContentChanged: false,
  planReviewChangeRequested: false,
  spawnedTaskIds: new Set(),
});

/**
 * Assemble the `plans` capability's contribution over a fresh {@link PlanSession}.
 *
 * The contribution carries the plan runtime tools, a review blocker (nothing
 * that could change the workspace runs until a human approves a plan: before one
 * exists the read-only coding tools are allowed alongside planning and
 * elicitation, and once it exists only planning and elicitation remain), the
 * plan-call handlers that emit created/updated events, two finalize gates (the
 * review gate and the open-task pending gate), the canonical-state anchor, and a
 * `beforeIteration` hook that republishes the plan as canonical context.
 *
 * @param deps - the wiring and settings; see {@link PlansOrchestrationDeps}.
 * @returns the {@link PlansOrchestration}: the contribution plus the port
 *   delegation consults.
 * @remarks The review gate terminates the run with `plan_review_revision_limit`
 *   after {@link MAX_PLAN_REVIEW_REVISIONS} change-request rounds, and the
 *   pending gate terminates with `pending_tasks_unfinished` once open tasks make
 *   no progress across `deps.pendingTaskNudges` consecutive nudges. Capability
 *   events (`plan_created`/`plan_updated`/`plan_review_*`) are emitted through
 *   `deps.emitCapabilityEvent` when supplied.
 */
export function buildPlansOrchestration(deps: PlansOrchestrationDeps): PlansOrchestration {
  const { bc } = deps;
  const { ctx, state, trace } = bc;
  const logger = deps.logger ?? NOOP_LOGGER;
  const planSession =
    deps.planSession ??
    new PlanSession({
      store: deps.planStore,
      providerKey: deps.providerKey,
      executionId: deps.executionId,
      review: deps.planReviewAsk !== undefined,
      logger,
      ...(deps.planRetention === undefined ? {} : { retention: deps.planRetention }),
      ...(deps.initialRef === undefined ? {} : { initialRef: deps.initialRef }),
    });
  deps.onPlanSession?.(planSession);
  const planReview = deps.planReviewAsk !== undefined;
  const planTools = buildPlanRuntimeTools(planReview);
  const pendingNudgeCap = deps.pendingTaskNudges;

  const session: SessionState = {
    planReviewRevision: 0,
    planReviewNudged: false,
    rejectedSpecDigest: undefined,
    rejectionFeedback: undefined,
    pendingStall: 0,
    pendingNudgesTotal: 0,
    lastNudgeOpenCount: null,
  };
  let iter = freshIter();

  /** Publish either the live document or an explicit tombstone for a removed one. */
  const publishPlanContext = (): void => {
    const document = planSession.cached();
    if (document !== undefined) {
      ctx.setStableBlock("plan_document", planSpecBlock(document));
      ctx.setCanonicalState(planCasHeader(document, planReview));
      return;
    }
    const missing = planSession.missing();
    if (missing === undefined) return;
    ctx.setStableBlock("plan_document", missingPlanSpecBlock(missing));
    ctx.setCanonicalState(missingPlanHeader(missing));
  };

  const recordPlanReview = (outcome: PlanReviewDetail["outcome"]): void => {
    trace.record("plan_review", { outcome, revision_index: session.planReviewRevision });
  };

  const partialStruct = (): { partialStructured: { value: unknown } } | Record<string, never> =>
    partialStructOf(state.lastSubmitAttempt);

  const isPlanApproved = (): boolean => {
    const document = planSession.cached();
    return document !== undefined && document.approved_spec_revision === document.spec_revision;
  };

  /**
   * Whether the human has already rejected the plan *as it currently stands*.
   * Keyed by spec digest, so revising the plan clears the rejection implicitly
   * and re-presents the gate, while retrying with an unchanged plan does not.
   */
  const isRejectedAtCurrentSpec = (): boolean => {
    const document = planSession.cached();
    return document !== undefined && session.rejectedSpecDigest === document.spec_digest;
  };

  /** Record the human's change request against the plan's current substance. */
  const recordRejection = (feedback: string | undefined): void => {
    session.rejectedSpecDigest = planSession.cached()?.spec_digest;
    session.rejectionFeedback = feedback;
    iter.planReviewChangeRequested = true;
  };

  const presentPlanReviewGate = async (): Promise<PlanReviewGateOutcome> => {
    const presented = await planSession.reconcile();
    if (presented !== undefined)
      deps.emitCapabilityEvent?.(
        projected({
          capability: "plans",
          kind: "plan_review_requested",
          detail: planProjection(presented),
        }),
      );
    recordPlanReview("presented");
    let decision: PlanReviewDecision;
    try {
      decision = await deps.planReviewAsk!();
    } catch (err) {
      const c = bc.maybeCancelled();
      if (c) return { kind: "terminal", result: c };
      throw err;
    }
    if (decision.kind === "approve") {
      await planSession.approve();
      const approved = planSession.cached();
      if (approved !== undefined)
        deps.emitCapabilityEvent?.(
          projected({
            capability: "plans",
            kind: "plan_review_resolved",
            detail: { outcome: "approved", ...planProjection(approved) },
          }),
        );
      recordPlanReview("approved");
      return { kind: "approved" };
    }
    if (decision.kind === "request_changes") {
      const current = planSession.cached();
      if (current !== undefined)
        deps.emitCapabilityEvent?.(
          projected({
            capability: "plans",
            kind: "plan_review_resolved",
            detail: { outcome: "changes_requested", ...planProjection(current) },
          }),
        );
      session.planReviewRevision += 1;
      recordPlanReview("changes_requested");
      if (session.planReviewRevision > MAX_PLAN_REVIEW_REVISIONS) {
        trace.record("terminate", { reason: "plan_review_revision_limit" });
        return {
          kind: "terminal",
          result: {
            status: "error",
            partialText: renderPlan(planSession.cached()!),
            error: {
              code: "plan_review_revision_limit",
              message: `The plan review gate requested changes ${session.planReviewRevision} times without an approval (cap ${MAX_PLAN_REVIEW_REVISIONS}); terminating with the latest plan as the partial.`,
            },
          },
        };
      }
      return {
        kind: "revise",
        ...(decision.feedback !== undefined ? { feedback: decision.feedback } : {}),
      };
    }
    const noHuman = decision.kind === "no_human";
    recordPlanReview(noHuman ? "no_human_fallback" : "cancelled");
    const current = planSession.cached();
    if (current !== undefined)
      deps.emitCapabilityEvent?.(
        projected({
          capability: "plans",
          kind: "plan_review_resolved",
          detail: { outcome: "cancelled", ...planProjection(current) },
        }),
      );
    trace.record("terminate", { reason: "plan_review_cancelled" });
    return {
      kind: "terminal",
      result: { status: "cancelled", partialText: renderPlan(planSession.cached()!) },
    };
  };

  const planReviewBypassTerminal = (): AgentResult => {
    trace.record("terminate", { reason: "plan_review_unreviewed" });
    return {
      status: "error",
      partialText: state.lastAssistantText,
      error: { code: "plan_review_unreviewed", message: PLAN_REVIEW_BYPASS_MSG },
      ...partialStruct(),
    };
  };

  const pendingTasksUnfinishedTerminal = (ids: string[]): AgentResult => {
    trace.record("terminate", { reason: "pending_tasks_unfinished" });
    return {
      status: "error",
      partialText: state.lastAssistantText,
      error: {
        code: "pending_tasks_unfinished",
        message:
          `Run terminated with ${ids.length} plan task(s) still open (${ids.join(", ")}): the Lead ` +
          `finalized without transitioning them (transition_plan_task), delegating them ` +
          `(delegate_task), or abandoning them (transition_plan_task), making no progress across ` +
          `${pendingNudgeCap} consecutive nudge(s).`,
      },
      ...partialStruct(),
    };
  };

  type PendingTaskGate =
    { kind: "ok" } | { kind: "nudge"; note: string } | { kind: "terminal"; result: AgentResult };
  const pendingTaskGate = async (): Promise<PendingTaskGate> => {
    if (pendingNudgeCap === 0) return { kind: "ok" };
    const open = await planSession.openTasks();
    if (open.length === 0) return { kind: "ok" };
    const ids = open.map((t) => t.id);
    const allOpenSpawnedThisBatch = ids.every((id) => iter.spawnedTaskIds.has(id));
    const madeProgress =
      allOpenSpawnedThisBatch ||
      (session.lastNudgeOpenCount !== null && open.length < session.lastNudgeOpenCount);
    if (madeProgress) session.pendingStall = 0;
    if (session.pendingStall < pendingNudgeCap) {
      session.pendingStall += 1;
      session.pendingNudgesTotal += 1;
      session.lastNudgeOpenCount = open.length;
      trace.record("task_nudge", {
        outcome: "nudged",
        pending_task_ids: ids,
        nudge_index: session.pendingNudgesTotal,
        progressed: madeProgress,
      });
      return { kind: "nudge", note: PENDING_TASKS_NOTE(ids) };
    }
    trace.record("task_nudge", {
      outcome: "terminated",
      pending_task_ids: ids,
      nudge_index: session.pendingNudgesTotal + 1,
      progressed: madeProgress,
    });
    return { kind: "terminal", result: pendingTasksUnfinishedTerminal(ids) };
  };

  const reviewGate: FinalizeGate = {
    fastAcceptOk: () => !planReview || isPlanApproved(),
    async check(attempt): Promise<GateOutcome> {
      await planSession.reconcile();
      if (!planReview || isPlanApproved()) return { kind: "pass" };
      if (planSession.cached() !== undefined) {
        if (isRejectedAtCurrentSpec())
          return {
            kind: "nudge",
            note: planReviewRejectionNote(attempt.mode === "submit", session.rejectionFeedback),
          };
        const g = await presentPlanReviewGate();
        if (g.kind === "terminal") return { kind: "terminal", result: g.result };
        if (g.kind === "approved") {
          if (attempt.mode !== "text") return { kind: "pass" };
          return { kind: "nudge", note: PLAN_REVIEW_EXECUTE_NOTE };
        }
        recordRejection(g.feedback);
        return {
          kind: "nudge",
          note: planReviewRejectionNote(attempt.mode === "submit", g.feedback),
        };
      }
      if (!session.planReviewNudged) {
        session.planReviewNudged = true;
        recordPlanReview("bypass_detected");
        return {
          kind: "nudge",
          note: attempt.mode === "submit" ? PLAN_REVIEW_BYPASS_MSG : PLAN_REVIEW_BYPASS_NOTE,
        };
      }
      return { kind: "terminal", result: planReviewBypassTerminal() };
    },
  };

  const pendingGate: FinalizeGate = {
    fastAcceptOk: () =>
      !(
        pendingNudgeCap > 0 &&
        (planSession
          .cached()
          ?.tasks.some((task) => task.status !== "done" && task.status !== "abandoned") ??
          false)
      ),
    async check(attempt): Promise<GateOutcome> {
      if (attempt.disposition === "checkpoint") return { kind: "pass" };
      const pg = await pendingTaskGate();
      if (pg.kind === "terminal") return { kind: "terminal", result: pg.result };
      if (pg.kind === "nudge") {
        return { kind: "nudge", note: pg.note };
      }
      return { kind: "pass" };
    },
  };

  const ensurePlanReviewGate = async (): Promise<AgentResult | null> => {
    await planSession.reconcile();
    if (!deps.planReviewAsk || planSession.cached() === undefined) return null;
    if (isPlanApproved() || isRejectedAtCurrentSpec()) return null;
    const g = await presentPlanReviewGate();
    if (g.kind === "terminal") return g.result;
    if (g.kind === "revise") recordRejection(g.feedback);
    return null;
  };

  const planTargets = new Set(planTools.map((tool) => tool.wireName));
  const toolEffect = deps.toolEffect;
  /**
   * Whether a call is allowed to run while the plan awaits approval.
   *
   * @remarks Asks what the tool *does* rather than matching a list of names the
   *   planning capability had to be told. `unknown` — every MCP tool, whose
   *   effects the engine cannot know — is refused in both phases by
   *   construction, and `spawn_run` with it: a tool that starts an independent
   *   run hands the work to a toolset this gate never sees, which is the one
   *   way to do the whole job without the gate ever being consulted.
   */
  const allowedInPhase = (name: string, phase: "unplanned" | "awaiting"): boolean => {
    if (planTargets.has(name)) return true;
    const effect = toolEffect.effect(name);
    if (effect === "control") return true;
    return phase === "unplanned" && effect === "read";
  };
  const reviewPhase = (): "unplanned" | "awaiting" | "open" => {
    if (!planReview || isPlanApproved()) return "open";
    return planSession.cached() === undefined ? "unplanned" : "awaiting";
  };
  /**
   * Refuses every call that could change the workspace until the human has
   * approved a plan.
   *
   * @remarks It is the run's *first* handler, and `entry-inputs.ts` layers the
   *   plans capability ahead of the run's others, so it is consulted before the
   *   coding toolset and before the MCP catch-all. Both allow-lists are closed
   *   sets, which is what makes an MCP tool — whose effects the engine cannot
   *   know — refused by construction rather than by enumeration.
   *
   *   The `unplanned` phase guards the window before any plan exists. Without
   *   it a Lead that never called `delegate_task` could write its way to a
   *   finished feature and meet the gate only at its finalize attempt — which is
   *   not a review, it is a retrospective.
   */
  /**
   * The reason a refused call is given, which is not the same reason in all
   * three cases: a spawn is refused for what it hands off, and a workspace tool
   * for what it changes.
   */
  const refusalFor = (name: string): string => {
    if (toolEffect.effect(name) === "spawn_run") return planReviewSpawnBlock(name);
    return reviewPhase() === "unplanned"
      ? planReviewUnplannedBlock(name)
      : PLAN_REVIEW_AWAITING_APPROVAL_BLOCK;
  };

  const reviewBlocker: ToolHandler = {
    matches: (call) => {
      const phase = reviewPhase();
      if (phase === "open") return false;
      return !allowedInPhase(call.name, phase);
    },
    handle: (call): Promise<HandlerVerdict> =>
      Promise.resolve({
        kind: "result",
        text: `Tool '${call.name}' result: ${refusalFor(call.name)}`,
        progress: false,
      }),
  };

  /**
   * Dispatch one plan runtime tool, recording it on the trace.
   *
   * @remarks The trace record is not decoration. Every other tool a run makes
   *   reaches the trace through its dispatcher, but a plan call is handled here
   *   and used to reach none — so `create_plan` and `transition_plan_task` were
   *   absent from the persisted trace entirely while being present in the run's
   *   own context. Reading the trace, a run that authored a plan and claimed a
   *   task looked like a run that had never touched the plan at all, which is
   *   exactly the wrong evidence when the question being asked is "why did
   *   nothing close this task".
   */
  const planCallHandler = (name: string): ToolHandler => ({
    matches: (call) => call.name === name,
    async handle(call, iteration): Promise<HandlerVerdict> {
      const startedAt = trace.now();
      const r = await handlePlanRuntimeCall(name, call.arguments, planSession, logger);
      trace.record("tool_call", {
        agent: "lead",
        iteration_ref: iteration,
        started_at: startedAt,
        ended_at: trace.now(),
        name,
        arguments: call.arguments,
        result: r.result,
        error: r.error ?? null,
        ...(call.id.length > 0 ? { call_id: call.id } : {}),
      });
      if (r.removed !== undefined) {
        deps.emitCapabilityEvent?.(
          projected({
            capability: "plans",
            kind: "plan_removed",
            detail: removedPlanProjection(r.removed),
          }),
        );
        publishPlanContext();
      }
      if (r.changed) iter.planContentChanged = true;
      if (r.document !== undefined)
        deps.emitCapabilityEvent?.(
          projected({
            capability: "plans",
            kind: name === CREATE_PLAN_TOOL_NAME ? "plan_created" : "plan_updated",
            detail: {
              ...(name === CREATE_PLAN_TOOL_NAME
                ? {}
                : {
                    change: name === REVISE_PLAN_TOOL_NAME ? "content" : ("task" as const),
                  }),
              ...planProjection(r.document),
            },
          }),
        );
      return { kind: "result", text: r.result, progress: false };
    },
  });

  const taskPort = createDelegationPlanPort(planSession, (document, change) => {
    deps.emitCapabilityEvent?.(
      projected({
        capability: "plans",
        kind: "plan_updated",
        detail: { change, ...planProjection(document) },
      }),
    );
  });

  const port: PlanDelegationPort = {
    ...taskPort,
    async beforeSpawn(taskId): Promise<SpawnGate> {
      const gateTerminal = await ensurePlanReviewGate();
      if (gateTerminal) return { kind: "terminal", result: gateTerminal };
      if (taskId !== undefined && iter.spawnedTaskIds.has(taskId)) {
        return { kind: "refuse", text: duplicateBatchTaskId(taskId) };
      }
      if (isRejectedAtCurrentSpec()) {
        return {
          kind: "refuse",
          text: planNotApprovedRejection(session.rejectionFeedback, "spawn sub-agents again"),
        };
      }
      return { kind: "ok" };
    },
    noteSpawned(taskId): void {
      iter.spawnedTaskIds.add(taskId);
    },
    augmentDelegateTask(): DelegateTaskAugmentation {
      return buildDelegateTaskPlanAugmentation(planReview);
    },
  };

  return {
    port,
    session: planSession,
    contribution: {
      tools: planTools,
      handlers: [reviewBlocker, ...planTools.map((tool) => planCallHandler(tool.wireName))],
      gates: [reviewGate, pendingGate],
      anchor: () => {
        const document = planSession.cached();
        if (document !== undefined)
          return { label: "Current plan", body: planCanonicalState(document, planReview) };
        const missing = planSession.missing();
        return missing === undefined
          ? undefined
          : { label: "Plan unavailable", body: missingPlanCanonicalState(missing) };
      },
      hooks: {
        beforeIteration: () => {
          iter = freshIter();
          publishPlanContext();
        },
        contributesProgress: () => iter.planContentChanged || iter.planReviewChangeRequested,
      },
    },
  };
}
