/**
 * File-backed planning, packaged as a loop capability.
 *
 * The engine gains planning by registering this, not by knowing about it: the
 * plan tools, the human review gate, the open-task finalization gate, the
 * review blocker and the canonical-state anchor all arrive through
 * {@link Capability}, and the only thing another capability may reach is the
 * task port published on the run's service registry.
 *
 * This entry must never import `@clarvis/loop`. The engine consumes planning's
 * seam structurally — `delegate_task` takes a port shaped like
 * {@link PlanDelegationPort} without naming this package — which is what keeps
 * the dependency edge pointing one way.
 */
import type {
  AgentBuildContext,
  AgentCapability,
  AgentScope,
  Capability,
  ExecutionRecord,
  RunCapability,
  RunCapabilityContext,
  ToolEffect,
} from "@clarvis/capability";
import {
  NOOP_LOGGER,
  TOOL_EFFECT_PORT,
  bestEffort,
  bind,
  projected,
  type Logger,
} from "@clarvis/capability";
import { PlanProviderMismatchError, type PlanFactory } from "../provider.ts";
import { PLANS_CAPABILITY_NAME, type PlanRef, type PlanRetention } from "../schemas.ts";
import { PLANS_DEFAULTS, plansParamSchema } from "../settings.ts";
import {
  buildPlansOrchestration,
  planProjection,
  removedPlanProjection,
  type PlansOrchestration,
} from "./orchestration.ts";
import { PlanSession } from "./session.ts";
import { buildPlanReviewAsk } from "./review-gate.ts";
import {
  buildPlanRuntimeTools,
  LIST_PLANS_TOOL_NAME,
  READ_PLAN_TOOL_NAME,
} from "./runtime-tools.ts";
import { PLAN_PORT, type PlanDelegationPort } from "./task-port.ts";
import { createPlanCatalogRun } from "./catalog.ts";

export { PLAN_PORT } from "./task-port.ts";
export type { PlanDelegationPort, DelegateTaskAugmentation, SpawnGate } from "./task-port.ts";
export { PlanSession } from "./session.ts";
export { planProjection } from "./orchestration.ts";

/**
 * The five wire names this capability owns, derived from the tools themselves so
 * the reservation cannot drift from what is advertised.
 */
const PLAN_RUNTIME_TOOLS = buildPlanRuntimeTools(false);
export const PLAN_TOOL_WIRE_NAMES: readonly string[] = PLAN_RUNTIME_TOOLS.map(
  (tool) => tool.wireName,
);
const PLAN_READ_TOOL_WIRE_NAMES: ReadonlySet<string> = new Set([
  READ_PLAN_TOOL_NAME,
  LIST_PLANS_TOOL_NAME,
]);
const PLAN_TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = Object.fromEntries(
  PLAN_RUNTIME_TOOLS.map(
    (tool) =>
      [tool.wireName, PLAN_READ_TOOL_WIRE_NAMES.has(tool.wireName) ? "read" : "mutate"] as const,
  ),
);

const PLAN_CAPABILITY_METADATA: Pick<
  Capability,
  "name" | "reservedWireNames" | "toolEffects" | "requiresUserInput"
> = {
  name: PLANS_CAPABILITY_NAME,
  reservedWireNames: PLAN_TOOL_WIRE_NAMES,
  toolEffects: PLAN_TOOL_EFFECTS,
  requiresUserInput: (view) => readPlansSettings(view.requestParam("plans")).mode === "review",
};

/**
 * How the host supplies planning's data plane and defaults.
 *
 * @remarks `factory` is the same settings-sensitive resolver the host's control
 * plane uses, so a run and the plans service read one provider store.
 */
export interface PlansCapabilityOptions {
  factory: PlanFactory;
  /** Fallback nudge budget when the request's `plans` block sets none. */
  defaultPendingTaskNudges: number;
  /** Fallback human-wait bound for the review gate, in ms. */
  defaultElicitWaitMs: number;
  /**
   * Operator diagnostics for what planning does to a run without telling it:
   * the continuation reset, retention deleting the document, an unmodelled tool
   * failure, and the absence of the tracking port.
   *
   * @remarks Optional only because the property cannot carry a default; it is
   * resolved to {@link NOOP_LOGGER} once per capability, and bound with the
   * run's `execution_id` once per run.
   */
  logger?: Logger;
}

/** The `plans` request param, normalized from its terse and block forms. */
interface PlansSettings {
  mode: "off" | "on" | "review";
  retention?: PlanRetention;
  pendingTaskNudges?: number;
}

/**
 * Read the run's planning settings off the request.
 *
 * @param raw - the request's `plans` param, as handed over by the engine.
 * @returns the normalized block. An absent param means unconfigured, for which
 *   the product default applies; `mode: "off"` is the explicit opt-out.
 * @remarks Parsed with this capability's own schema — the same one it registers
 *   for `settings.json` — because the engine validates the request's shape but
 *   cannot know what any one capability's param means.
 */
function readPlansSettings(raw: unknown): PlansSettings {
  const parsed = plansParamSchema.safeParse(raw);
  if (!parsed.success || parsed.data === undefined) return { mode: PLANS_DEFAULTS.mode };
  const value = parsed.data;
  if (typeof value === "string") return { mode: value };
  return {
    mode: value.mode,
    ...(value.retention === undefined ? {} : { retention: value.retention }),
    ...(value.pending_task_nudges === undefined
      ? {}
      : { pendingTaskNudges: value.pending_task_nudges }),
  };
}

/**
 * Build the planning capability.
 *
 * @param options - the host's data plane and defaults; see
 *   {@link PlansCapabilityOptions}.
 * @returns a {@link Capability} that activates for a run whose `plans` mode is
 *   not `off`, contributes to that run's entry agent only, publishes its task
 *   port on the run's registry, seals the plan into the record and honours
 *   `retention: discard` afterwards.
 * @remarks Ordered ahead of every other capability (`order: -100`) because its
 *   review blocker has to be the run's first handler: dispatch is first-match,
 *   and a blocker consulted after the coding toolset guards nothing.
 */
export function createPlansCapability(options: PlansCapabilityOptions): Capability {
  const rootLogger = options.logger ?? NOOP_LOGGER;
  return {
    ...PLAN_CAPABILITY_METADATA,
    async forRun(ctx: RunCapabilityContext): Promise<RunCapability | null> {
      const settings = readPlansSettings(ctx.requestParam("plans"));
      if (settings.mode === "off") return null;

      const logger = bind(rootLogger, { execution_id: ctx.executionId });
      const resolved = await options.factory.storeFor(ctx.owner);
      const store = resolved.store;
      const review = settings.mode === "review";
      const priorRef = ctx.priorState?.[PLANS_CAPABILITY_NAME] as PlanRef | undefined;
      const initialRef =
        priorRef === undefined || priorRef.provider_key === resolved.key
          ? priorRef
          : priorRef.status === "completed"
            ? undefined
            : (() => {
                throw new PlanProviderMismatchError(priorRef.provider_key, resolved.key);
              })();
      const elicitWaitMs = ctx.request.elicit_wait_ms ?? options.defaultElicitWaitMs;
      const planSession = new PlanSession({
        store,
        providerKey: resolved.key,
        executionId: ctx.executionId,
        review,
        logger,
        ...(settings.retention === undefined ? {} : { retention: settings.retention }),
        ...(initialRef === undefined ? {} : { initialRef }),
      });

      /**
       * One orchestration per agent build context, and the live session behind
       * it. Two capability halves used to attach to the same context and had to
       * agree; now only this one does, but the memo still matters — `attach` is
       * called once per agent and the port provider is read separately.
       */
      const built = new WeakMap<object, PlansOrchestration>();
      let liveSession: PlansOrchestration["session"] | undefined;

      const buildFor = (scope: AgentScope, bc: AgentBuildContext): PlansOrchestration => {
        const existing = built.get(bc);
        if (existing !== undefined) return existing;
        const reviewAsk =
          review && scope.elicit !== undefined && scope.clock !== undefined
            ? buildPlanReviewAsk(scope.elicit, scope.clock, scope.signal, elicitWaitMs)
            : undefined;
        const created = buildPlansOrchestration({
          bc,
          planStore: store,
          providerKey: resolved.key,
          executionId: ctx.executionId,
          ...(reviewAsk === undefined ? {} : { planReviewAsk: reviewAsk }),
          ...(settings.retention === undefined ? {} : { planRetention: settings.retention }),
          pendingTaskNudges: settings.pendingTaskNudges ?? options.defaultPendingTaskNudges,
          ...(initialRef === undefined ? {} : { initialRef }),
          planSession,
          toolEffect: ctx.services.get(TOOL_EFFECT_PORT) ?? { effect: () => "unknown" },
          emitCapabilityEvent: ctx.emit,
          logger,
        });
        built.set(bc, created);
        liveSession = created.session;
        return created;
      };

      const ports = new WeakMap<object, PlanDelegationPort>();
      let absenceReported = false;
      ctx.services.provide(PLAN_PORT, {
        forAgent: (bc) => {
          const port = ports.get(bc);
          if (port === undefined && !absenceReported) {
            absenceReported = true;
            logger.debug(
              { event: "plan.tracking_port.absent", execution_id: ctx.executionId },
              "an agent asked for the plan task port and this run publishes none for it, so only spawn_subagent is available",
            );
          }
          return port;
        },
      });

      return {
        name: PLANS_CAPABILITY_NAME,
        order: -100,
        lifecycle:
          initialRef === undefined
            ? undefined
            : [
                {
                  async onRunStart(): Promise<void> {
                    const recovered = await planSession.reconcile();
                    const removed = planSession.takeRemoval();
                    if (removed !== undefined) {
                      ctx.emit(
                        projected({
                          capability: PLANS_CAPABILITY_NAME,
                          kind: "plan_removed",
                          detail: removedPlanProjection(removed),
                        }),
                      );
                      return;
                    }
                    if (recovered !== undefined)
                      ctx.emit(
                        projected({
                          capability: PLANS_CAPABILITY_NAME,
                          kind: "plan_updated",
                          detail: { change: "recovery", ...planProjection(recovered) },
                        }),
                      );
                  },
                },
              ],
        guardTripCodes: [
          "plan_review_unreviewed",
          "plan_review_revision_limit",
          "pending_tasks_unfinished",
        ],
        forAgent(scope): AgentCapability | null {
          if (!scope.entry) return null;
          return {
            attach(bc) {
              const orchestration = buildFor(scope, bc);
              ports.set(bc, orchestration.port);
              return orchestration.contribution;
            },
          };
        },
        async finalizeRun({ status, disposition, preserveState }): Promise<PlanRef | undefined> {
          if (liveSession === undefined) return undefined;
          if (disposition === "checkpoint" || preserveState === true) {
            await liveSession.reconcile();
            return liveSession.ref();
          }
          const planStatus =
            status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed";
          const ref = await liveSession.finalize(planStatus);
          const finalized = liveSession.cached();
          if (finalized !== undefined) {
            ctx.emit(
              projected({
                capability: PLANS_CAPABILITY_NAME,
                kind: "plan_updated",
                detail: { change: "status", ...planProjection(finalized) },
              }),
            );
          }
          return ref;
        },
        async onRunEnd(record: ExecutionRecord): Promise<void> {
          const ref = record.capability_state?.[PLANS_CAPABILITY_NAME] as PlanRef | undefined;
          if (
            record.status !== "completed" ||
            record.response.disposition === "checkpoint" ||
            ref?.retention !== "discard"
          )
            return;
          let deleted = false;
          await bestEffort(
            async () => {
              deleted = await store.delete(ref.id);
            },
            { operation: "plan_retention_discard", logger },
          );
          logger.info(
            {
              event: "plan.retention.discarded",
              plan_id: ref.id,
              revision: ref.final_revision,
              deleted,
            },
            deleted
              ? "the plan was deleted as its retention asked; the terminal record still names it"
              : "the plan asked to be discarded and no document was removed; nothing else will retry",
          );
          if (!deleted) return;
          ctx.emit(
            projected({
              capability: PLANS_CAPABILITY_NAME,
              kind: "plan_removed",
              detail: {
                id: ref.id,
                ...(ref.path === undefined ? {} : { path: ref.path }),
                revision: ref.final_revision,
                spec_revision: ref.final_spec_revision,
              },
            }),
          );
        },
      };
    },
  };
}

/**
 * Preserve planning's advertised surface in an auxiliary continuation without
 * taking ownership of the source plan. The host selects this projection; it is
 * not a model-controlled request mode. It opens no provider, runs no review or
 * task gates, publishes no context, and never reconciles, finalizes or deletes
 * a plan. Plan calls and tracked delegation are refused even without an outer
 * dispatch restriction. The source request's planning mode still controls the
 * catalog, including its review descriptions and explicit opt-out.
 */
export function createPlansCatalogCapability(): Capability {
  return {
    ...PLAN_CAPABILITY_METADATA,
    forRun(ctx) {
      const settings = readPlansSettings(ctx.requestParam("plans"));
      return settings.mode === "off" ? null : createPlanCatalogRun(ctx, settings.mode === "review");
    },
  };
}
