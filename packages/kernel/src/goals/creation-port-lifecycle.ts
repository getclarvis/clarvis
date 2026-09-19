import type { GoalCreationInput, GoalRuntimePort } from "@clarvis/goal";
import type { GoalCreationPortOptions, CreationLifecycle } from "./creation-port-types.ts";
import { assertCreationAlive, bindCreatedGoalRuntime } from "./creation-port-runtime.ts";
import { creationFingerprint, persistCreation } from "./creation-port-transaction.ts";

/** Idempotent lifecycle for one authenticated entry execution. */
export function createCreationLifecycle(
  options: GoalCreationPortOptions,
  now: () => number,
): {
  lifecycle: CreationLifecycle;
  create(input: GoalCreationInput, signal?: AbortSignal): Promise<GoalRuntimePort>;
} {
  let runtime: GoalRuntimePort | undefined;
  let inFlight: Promise<GoalRuntimePort> | undefined;

  const create = async (
    input: GoalCreationInput,
    signal?: AbortSignal,
  ): Promise<GoalRuntimePort> => {
    if (runtime !== undefined) return runtime;
    assertCreationAlive(options, signal);
    if (inFlight !== undefined) return inFlight;
    const fingerprint = creationFingerprint({
      sessionId: options.session.id,
      executionId: options.executionId,
      seed: options.seed,
      input,
    });
    const operation = (async () => {
      await persistCreation(options.repository, options.session, input, {
        executionId: options.executionId,
        seed: options.seed,
        defaultLimits: options.defaultLimits,
        entryTokenLimit: options.entryTokenLimit,
        now,
        fingerprint,
      });
      assertCreationAlive(options, signal);
      const bound = await bindCreatedGoalRuntime(options, now);
      runtime = bound;
      return bound;
    })();
    inFlight = operation;
    void operation.then(
      () => {
        if (inFlight === operation) inFlight = undefined;
      },
      () => {
        if (inFlight === operation) inFlight = undefined;
      },
    );
    return operation;
  };

  return {
    lifecycle: {
      get runtime() {
        return runtime;
      },
      get inFlight() {
        return inFlight;
      },
    },
    create,
  };
}
