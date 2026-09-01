import type {
  EnvConfig,
  ExtensionAdmissionController,
  LifecycleHook,
  Logger,
  RunCapability,
} from "@clarvis/capability";
import {
  ExtensionCallUnavailableError,
  createExtensionAdmissionController,
} from "@clarvis/capability";

const operation = (capability: string, phase: string): string =>
  `capability:${capability}:${phase}`;

function admittedLifecycleHook(
  capability: string,
  hook: LifecycleHook,
  hookIndex: number,
  admission: ExtensionAdmissionController,
): LifecycleHook {
  const lane = (method: string): string =>
    operation(capability, `lifecycle:${hookIndex}:${method}`);
  return {
    ...(hook.beforeToolUse === undefined
      ? {}
      : {
          beforeToolUse: (context) =>
            admission.call(lane("beforeToolUse"), "normal", () =>
              hook.beforeToolUse!.call(hook, context),
            ),
        }),
    ...(hook.afterToolUse === undefined
      ? {}
      : {
          afterToolUse: (context) =>
            admission.call(lane("afterToolUse"), "normal", () =>
              hook.afterToolUse!.call(hook, context),
            ),
        }),
    ...(hook.preFinalize === undefined
      ? {}
      : {
          preFinalize: (context) =>
            admission.call(lane("preFinalize"), "normal", () =>
              hook.preFinalize!.call(hook, context),
            ),
        }),
    ...(hook.preDelegateTask === undefined
      ? {}
      : {
          preDelegateTask: (context) =>
            admission.call(lane("preDelegateTask"), "normal", () =>
              hook.preDelegateTask!.call(hook, context),
            ),
        }),
    ...(hook.onRunStart === undefined
      ? {}
      : {
          onRunStart: (context) =>
            admission.call(lane("onRunStart"), "normal", () =>
              hook.onRunStart!.call(hook, context),
            ),
        }),
    ...(hook.onRunEnd === undefined
      ? {}
      : {
          onRunEnd: (context) =>
            admission.call(lane("onRunEnd"), "run_end", () => hook.onRunEnd!.call(hook, context)),
        }),
    ...(hook.onSubagentComplete === undefined
      ? {}
      : {
          onSubagentComplete: (context) =>
            admission.call(lane("onSubagentComplete"), "normal", () =>
              hook.onSubagentComplete!.call(hook, context),
            ),
        }),
    ...(hook.onSubagentStart === undefined
      ? {}
      : {
          onSubagentStart: (context) =>
            admission.call(lane("onSubagentStart"), "normal", () =>
              hook.onSubagentStart!.call(hook, context),
            ),
        }),
    ...(hook.onPostCompact === undefined
      ? {}
      : {
          onPostCompact: (context) =>
            admission.call(lane("onPostCompact"), "normal", () =>
              hook.onPostCompact!.call(hook, context),
            ),
        }),
    ...(hook.onPreCompact === undefined
      ? {}
      : {
          onPreCompact: (context) =>
            admission.call(lane("onPreCompact"), "normal", () =>
              hook.onPreCompact!.call(hook, context),
            ),
        }),
    ...(hook.onModelCallError === undefined
      ? {}
      : {
          onModelCallError: (context) =>
            admission.call(lane("onModelCallError"), "normal", () =>
              hook.onModelCallError!.call(hook, context),
            ),
        }),
    ...(hook.onBudgetExhausted === undefined
      ? {}
      : {
          onBudgetExhausted: (context) =>
            admission.call(lane("onBudgetExhausted"), "normal", () =>
              hook.onBudgetExhausted!.call(hook, context),
            ),
        }),
    ...(hook.onUserSteer === undefined
      ? {}
      : {
          onUserSteer: (context) =>
            admission.call(lane("onUserSteer"), "normal", () =>
              hook.onUserSteer!.call(hook, context),
            ),
        }),
  };
}

/**
 * Bind one per-run activation to its host's physical extension admission.
 *
 * @remarks `capabilityName` is the stable registration name rather than the
 * returned object's identity. Session-bound hosts may construct a fresh object
 * on every run; keying by identity would let exactly that iterative path bypass
 * the per-operation ceiling.
 */
export function admittedRunCapability(
  capabilityName: string,
  activated: RunCapability,
  admission: ExtensionAdmissionController,
  logger?: Logger,
): RunCapability {
  const lifecycle = activated.lifecycle?.map((hook, index) =>
    admittedLifecycleHook(capabilityName, hook, index, admission),
  );
  return {
    name: activated.name,
    ...(activated.order === undefined ? {} : { order: activated.order }),
    ...(activated.seedBlock === undefined
      ? {}
      : {
          seedBlock: async () => {
            try {
              return await admission.call(operation(capabilityName, "seedBlock"), "normal", () =>
                activated.seedBlock!.call(activated),
              );
            } catch (error) {
              if (!(error instanceof ExtensionCallUnavailableError)) throw error;
              logger?.warn(
                {
                  event: "capability.extension_saturated",
                  capability: capabilityName,
                  operation: error.operation,
                  reason: error.reason,
                },
                "the host's extension gate is saturated; seedBlock is omitted before invocation",
              );
              return undefined;
            }
          },
        }),
    ...(activated.systemSection === undefined
      ? {}
      : { systemSection: (identity) => activated.systemSection!.call(activated, identity) }),
    ...(lifecycle === undefined ? {} : { lifecycle }),
    forAgent: (scope) => activated.forAgent.call(activated, scope),
    ...(activated.onRunEnd === undefined
      ? {}
      : {
          onRunEnd: (record) =>
            admission.call(operation(capabilityName, "onRunEnd"), "run_end", () =>
              activated.onRunEnd!.call(activated, record),
            ),
        }),
    ...(activated.finalizeRun === undefined
      ? {}
      : {
          finalizeRun: (outcome) =>
            admission.call(operation(capabilityName, "finalizeRun"), "run_end", () =>
              activated.finalizeRun!.call(activated, outcome),
            ),
        }),
    ...(activated.guardTripCodes === undefined ? {} : { guardTripCodes: activated.guardTripCodes }),
  };
}

export function isExtensionAdmissionRefusal(
  error: unknown,
): error is ExtensionCallUnavailableError {
  return error instanceof ExtensionCallUnavailableError;
}

export function capabilityActivationOperation(capabilityName: string): string {
  return operation(capabilityName, "forRun");
}

/**
 * The deps this resolver reads: an optionally supplied controller, and the env
 * caps a fallback is sized from.
 */
export interface ExtensionAdmissionHost {
  extensionAdmission?: ExtensionAdmissionController;
  env: EnvConfig;
}

const fallbacks = new WeakMap<ExtensionAdmissionHost, ExtensionAdmissionController>();

/**
 * Resolve the {@link ExtensionAdmissionController} for one deps object.
 *
 * @param deps - the run deps; a supplied `extensionAdmission` always wins.
 * @returns the supplied controller, or one memoized against `deps` so repeated
 *   calls with the same deps share a single set of concurrency counters.
 * @remarks Two entry points may be called without a controller: `executeRun`,
 *   and `runOrchestrator`, which `executeRun` always hands one — so the
 *   orchestrator's fallback fires only when the orchestrator is driven directly,
 *   as the integration tests drive it. Both used to carry a byte-identical
 *   `WeakMap` and resolver, differing only in the key's type, with nothing
 *   pinning them together.
 */
export function extensionAdmissionFor(deps: ExtensionAdmissionHost): ExtensionAdmissionController {
  if (deps.extensionAdmission !== undefined) return deps.extensionAdmission;
  let admission = fallbacks.get(deps);
  if (admission === undefined) {
    admission = createExtensionAdmissionController({
      maxActiveNormal: deps.env.CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS,
      maxActiveRunEnd: deps.env.CLARVIS_MAX_CONCURRENT_EXTENSION_RUN_END_CALLS,
      maxActivePerOperation: deps.env.CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS_PER_OPERATION,
    });
    fallbacks.set(deps, admission);
  }
  return admission;
}
