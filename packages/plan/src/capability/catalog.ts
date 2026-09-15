import {
  handlerBaseOf,
  openCallEnvelope,
  type AgentBuildContext,
  type RunCapability,
  type RunCapabilityContext,
} from "@clarvis/capability";
import { PLANS_CAPABILITY_NAME } from "../schemas.ts";
import { buildDelegateTaskPlanAugmentation } from "./messages.ts";
import { buildPlanRuntimeTools } from "./runtime-tools.ts";
import { PLAN_PORT, type PlanDelegationPort } from "./task-port.ts";

const REFUSAL = "Plan execution is not available in this auxiliary pass.";

/**
 * Supply the source catalog and a closed task port without constructing a plan
 * session. Merely attaching or reconciling delegation cannot reach a provider.
 * The port exists only for the entry agent, as in ordinary planning.
 */
export function createPlanCatalogRun(ctx: RunCapabilityContext, review: boolean): RunCapability {
  const tools = buildPlanRuntimeTools(review);
  const names = new Set(tools.map((tool) => tool.wireName));
  const attached = new WeakSet<AgentBuildContext>();
  const port: PlanDelegationPort = {
    openTasks: () => [],
    getTask: () => undefined,
    markSpawned: () => false,
    markFailed: () => false,
    markReturned: () => false,
    beforeSpawn: () => Promise.resolve({ kind: "refuse", text: REFUSAL }),
    noteSpawned: () => undefined,
    augmentDelegateTask: () => buildDelegateTaskPlanAugmentation(review),
  };
  ctx.services.provide(PLAN_PORT, { forAgent: (bc) => (attached.has(bc) ? port : undefined) });
  return {
    name: PLANS_CAPABILITY_NAME,
    order: -100,
    forAgent: (scope) =>
      scope.entry
        ? {
            attach(bc) {
              attached.add(bc);
              const base = handlerBaseOf(bc);
              return {
                tools,
                handlers: [
                  {
                    matches: (call) => names.has(call.name),
                    handle(call, iteration) {
                      const envelope = openCallEnvelope({
                        call,
                        name: call.name,
                        trace: base.trace,
                        agent: base.agent,
                        ...(base.subagentInstanceId === undefined
                          ? {}
                          : { subagentInstanceId: base.subagentInstanceId }),
                        iteration,
                      });
                      return Promise.resolve({
                        kind: "result",
                        text: envelope.fail(REFUSAL),
                        progress: false,
                      });
                    },
                  },
                ],
              };
            },
          }
        : null,
  };
}
