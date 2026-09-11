import { randomUUID } from "node:crypto";
import { z } from "zod";
import { composePromptCacheKey, type Capability, type RunRequest } from "@clarvis/capability";
import {
  GOAL_STATE_MAX_BYTES,
  createGoalCapability,
  goalCandidateInputSchema,
  goalCheckpointInputSchema,
  goalCheckpointSchema,
  goalEvidenceRefSchema,
  goalProgressInputSchema,
  goalRecordSchema,
  type GoalRuntimePort,
} from "@clarvis/goal";
import type { HostCapabilityGrant } from "./authority-brokers.ts";
import type { GuestExecutionBridge } from "./execution-worker.ts";
import { RuntimeLaunchError } from "./types.ts";

export const RUNTIME_GOAL_METHOD = "runtime.goal";
const REVISION = "v1";

/** One bounded current record plus the host's discovery catalog; archives and receipts never cross. */
export const RUNTIME_GOAL_MAX_BYTES = GOAL_STATE_MAX_BYTES + 128 * 1024;
const bindingSchema = z
  .object({
    session_id: goalRecordSchema.shape.session_id,
    agent_instance_id: goalRecordSchema.shape.session_id,
    execution_id: goalEvidenceRefSchema.shape.execution_id,
    goal_id: goalRecordSchema.shape.goal_id,
    objective_revision: goalRecordSchema.shape.objective_revision,
  })
  .strict();
const descriptorSchema = z
  .object({ revision: z.literal(REVISION), binding: bindingSchema })
  .strict();
export type RuntimeGoalDescriptor = z.infer<typeof descriptorSchema>;
const scopeSchema = bindingSchema.extend({ role: z.literal("entry") });
const requestSchema = z.discriminatedUnion("operation", [
  z.object({ scope: scopeSchema, operation: z.literal("read") }).strict(),
  z
    .object({
      scope: scopeSchema,
      operation: z.literal("progress"),
      input: goalProgressInputSchema,
    })
    .strict(),
  z
    .object({
      scope: scopeSchema,
      operation: z.literal("checkpoint"),
      input: goalCheckpointInputSchema,
    })
    .strict(),
  z
    .object({
      scope: scopeSchema,
      operation: z.literal("candidate"),
      input: goalCandidateInputSchema,
    })
    .strict(),
  z.object({ scope: scopeSchema, operation: z.literal("validateCompletion") }).strict(),
  z
    .object({
      scope: scopeSchema,
      operation: z.literal("blocked"),
      reason: goalProgressInputSchema.shape.summary,
    })
    .strict(),
]);
type Request = z.infer<typeof requestSchema>;
const snapshotSchema = z
  .object({
    goal: goalRecordSchema,
    evidence: z.array(goalEvidenceRefSchema.extend({ description: z.string().max(512) })).max(32),
  })
  .strict();
const validationSchema = z
  .object({
    valid: z.boolean(),
    reasons: z.array(z.string().max(8192)).max(512),
    qualitative_criteria: z.array(goalEvidenceRefSchema.shape.id).max(32),
    revision: z.number().int().nonnegative(),
  })
  .strict();

function refused(code: "unauthorized" | "invalid_request" | "resource_exhausted"): Error {
  return Object.assign(new Error("Goal bridge operation is outside its admitted contract"), {
    code,
  });
}

/** Strict response parsing also bounds native host implementations before any guest publication. */
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > RUNTIME_GOAL_MAX_BYTES)
    throw refused("resource_exhausted");
  const result = schema.safeParse(value);
  if (!result.success) throw refused("invalid_request");
  return result.data;
}

/** Descriptor and request identities must match; an absent/malformed projection cannot drop goal gates. */
export function validRuntimeGoalDescriptor(
  value: unknown,
  rawBody: unknown,
): value is RuntimeGoalDescriptor {
  const parsed = descriptorSchema.safeParse(value);
  if (!parsed.success || typeof rawBody !== "object" || rawBody === null) return false;
  const body = rawBody as Partial<RunRequest>;
  const binding = parsed.data.binding;
  try {
    composePromptCacheKey({
      sessionId: binding.session_id,
      agentInstanceId: binding.agent_instance_id,
    });
    return (
      body.execution_id === binding.execution_id &&
      body.session_id === binding.session_id &&
      body.agent_instance_id === binding.agent_instance_id
    );
  } catch {
    return false;
  }
}

/**
 * Project factory-owned entry authority into six closed operations. The broker additionally fences
 * generation, execution, physical call identity and revocation. No guest operation selects an owner,
 * user control, next run or budget. The host port revalidates persisted revision inside every write.
 */
export function createHostGoalBridge(
  port: GoalRuntimePort,
  rawBody: unknown,
  runId: string,
): { descriptor: RuntimeGoalDescriptor; grant: HostCapabilityGrant } {
  const descriptor = decode(descriptorSchema, { revision: REVISION, binding: port.binding });
  if (!validRuntimeGoalDescriptor(descriptor, rawBody) || descriptor.binding.execution_id !== runId)
    throw new RuntimeLaunchError("unsupported_policy", "Goal requires its admitted entry identity");
  const binding = Object.freeze(descriptor.binding);
  return {
    descriptor,
    grant: {
      method: RUNTIME_GOAL_METHOD,
      revision: REVISION,
      idempotent: false,
      validateArguments: (value) => requestSchema.safeParse(value).success,
      async invoke(value, signal) {
        const request = decode(requestSchema, value);
        signal.throwIfAborted();
        if (
          Object.entries(binding).some(
            ([key, value]) => request.scope[key as keyof typeof binding] !== value,
          )
        )
          throw refused("unauthorized");
        let result: unknown;
        switch (request.operation) {
          case "read":
            result = decode(snapshotSchema, await port.read(signal));
            break;
          case "progress":
            await port.progress(request.input, signal);
            result = null;
            break;
          case "checkpoint":
            result = decode(goalCheckpointSchema, await port.checkpoint(request.input, signal));
            break;
          case "candidate":
            result = decode(validationSchema, await port.candidate(request.input, signal));
            break;
          case "validateCompletion":
            result = decode(validationSchema, await port.validateCompletion(signal));
            break;
          case "blocked":
            await port.blocked(request.reason, signal);
            result = null;
            break;
        }
        signal.throwIfAborted();
        return result;
      },
    },
  };
}

/** Run the canonical entry capability in the guest; its port carries only the host-admitted scope. */
export function createGuestGoalCapability(
  descriptor: RuntimeGoalDescriptor,
  bridge: GuestExecutionBridge,
  executionSignal: AbortSignal,
): Capability {
  const { binding } = decode(descriptorSchema, descriptor);
  const scope = { ...binding, role: "entry" as const };
  const call = async <T>(
    request: Request,
    schema: z.ZodType<T>,
    operationSignal?: AbortSignal,
  ): Promise<T> => {
    const signal =
      operationSignal === undefined
        ? executionSignal
        : AbortSignal.any([executionSignal, operationSignal]);
    signal.throwIfAborted();
    const response = await bridge.capability(
      randomUUID(),
      {
        method: RUNTIME_GOAL_METHOD,
        revision: REVISION,
        arguments: request,
      },
      signal,
    );
    signal.throwIfAborted();
    return decode(schema, response);
  };
  return createGoalCapability({
    binding,
    read: (signal) => call({ scope, operation: "read" }, snapshotSchema, signal),
    async progress(input, signal) {
      await call({ scope, operation: "progress", input }, z.null(), signal);
    },
    checkpoint: (input, signal) =>
      call({ scope, operation: "checkpoint", input }, goalCheckpointSchema, signal),
    candidate: (input, signal) =>
      call({ scope, operation: "candidate", input }, validationSchema, signal),
    validateCompletion: (signal) =>
      call({ scope, operation: "validateCompletion" }, validationSchema, signal),
    async blocked(reason, signal) {
      await call({ scope, operation: "blocked", reason }, z.null(), signal);
    },
  });
}
