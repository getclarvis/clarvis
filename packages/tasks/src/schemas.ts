import { z } from "zod";

export const TASK_LIMITS = Object.freeze({
  id: 512,
  providerKey: 512,
  title: 500,
  description: 32_768,
  comment: 16_384,
  summary: 4_096,
  reason: 4_096,
  criteria: 100,
  criterion: 2_048,
  labels: 100,
  label: 128,
  evidence: 50,
  evidenceItem: 2_048,
  artifacts: 25,
  artifactLabel: 256,
  url: 2_048,
  cursor: 4_096,
  query: 1_024,
  seedBytes: 12_288,
  pageDefault: 50,
  pageMax: 100,
});

export const taskIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(TASK_LIMITS.id)
  // eslint-disable-next-line no-control-regex -- provider IDs are untrusted wire data.
  .refine((value) => !/[\u0000-\u001F\u007F-\u009F]/u.test(value), {
    message: "identifier contains control characters",
  });
const id = taskIdentifierSchema;
const label = z.string().trim().min(1).max(TASK_LIMITS.label);
const cursor = z.string().min(1).max(TASK_LIMITS.cursor);
const query = z.string().max(TASK_LIMITS.query);
const rfc3339 = z.string().datetime({ offset: true });
const httpUrl = z
  .string()
  .max(TASK_LIMITS.url)
  .url()
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "URL must use http or https",
  });

export const taskStageSchema = z.enum([
  "backlog",
  "ready",
  "active",
  "blocked",
  "review",
  "done",
  "cancelled",
  "other",
]);

export const taskTransitionIntentSchema = z.enum([
  "start",
  "block",
  "submit_review",
  "complete",
  "reopen",
]);

export const taskActorSchema = z
  .object({
    id,
    label: z.string().trim().min(1).max(500),
    kind: z.enum(["human", "team", "agent", "service", "unknown"]),
  })
  .strict();

export const taskContainerRefSchema = z
  .object({
    id,
    label: z.string().trim().min(1).max(500),
    kind: z.enum(["project", "board", "space", "other"]).optional(),
  })
  .strict();

export const taskRefSchema = z
  .object({
    providerKey: taskIdentifierSchema,
    id,
  })
  .strict();

export const taskNativeStateSchema = z.object({ id, label }).strict();

export const taskClaimSchema = z
  .object({ claimant: taskActorSchema, executionId: id, claimedAt: rfc3339 })
  .strict();

const summaryShape = {
  ref: taskRefSchema,
  container: taskContainerRefSchema,
  title: z.string().trim().min(1).max(TASK_LIMITS.title),
  stage: taskStageSchema,
  nativeState: taskNativeStateSchema,
  priority: label.optional(),
  assignee: taskActorSchema.optional(),
  claim: taskClaimSchema.optional(),
  labels: z.array(label).max(TASK_LIMITS.labels),
  updatedAt: rfc3339.optional(),
  revision: id.optional(),
  url: httpUrl.optional(),
};

export const taskSummarySchema = z.object(summaryShape).strict();
export const taskDocumentSchema = z
  .object({
    ...summaryShape,
    description: z.string().max(TASK_LIMITS.description).optional(),
    acceptanceCriteria: z.array(z.string().max(TASK_LIMITS.criterion)).max(TASK_LIMITS.criteria),
    availableIntents: z.array(taskTransitionIntentSchema).max(5),
  })
  .strict();

export const taskProviderCapabilitiesSchema = z
  .object({
    protocolVersion: z.literal(2),
    providerInstanceId: id,
    providerKind: id,
    read: z
      .object({
        containers: z.literal(true),
        search: z.literal(true),
        get: z.literal(true),
        actors: z.boolean(),
      })
      .strict(),
    write: z
      .object({
        create: z.boolean(),
        assign: z.boolean(),
        comment: z.boolean(),
        attachArtifact: z.boolean(),
        intents: z.array(taskTransitionIntentSchema).max(5),
      })
      .strict(),
    concurrency: z.enum(["none", "revision", "exclusive_claim"]),
  })
  .strict();

const pageFields = {
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(TASK_LIMITS.pageMax).optional(),
};

export const listTaskContainersInputSchema = z
  .object({ query: query.optional(), ...pageFields })
  .strict();
export const searchTasksInputSchema = z
  .object({
    containerId: id.optional(),
    query: query.optional(),
    stages: z.array(taskStageSchema).max(8).optional(),
    assigneeId: id.optional(),
    labels: z.array(label).max(TASK_LIMITS.labels).optional(),
    claim: z.enum(["any", "free", "claimed"]).optional(),
    updatedAfter: rfc3339.optional(),
    ...pageFields,
  })
  .strict();
export const searchTaskActorsInputSchema = z
  .object({ containerId: id.optional(), query: query.optional(), ...pageFields })
  .strict();

export const taskMutationContextSchema = z
  .object({
    owner: id,
    actor: taskActorSchema,
    executionId: id.optional(),
    claimExecutionId: id.optional(),
    idempotencyKey: z.string().trim().min(1).max(1_024),
    expectedRevision: id.optional(),
  })
  .strict();

export const createTaskInputSchema = z
  .object({
    containerId: id,
    title: z.string().trim().min(1).max(TASK_LIMITS.title),
    description: z.string().max(TASK_LIMITS.description).optional(),
    acceptanceCriteria: z
      .array(z.string().max(TASK_LIMITS.criterion))
      .max(TASK_LIMITS.criteria)
      .optional(),
    priority: label.optional(),
    assigneeId: id.optional(),
    labels: z.array(label).max(TASK_LIMITS.labels).optional(),
    mutation: taskMutationContextSchema,
  })
  .strict();

export const assignTaskInputSchema = z
  .object({ ref: taskRefSchema, assigneeId: id.nullable(), mutation: taskMutationContextSchema })
  .strict();
export const transitionTaskInputSchema = z
  .object({
    ref: taskRefSchema,
    intent: taskTransitionIntentSchema,
    claimant: taskActorSchema.optional(),
    reason: z.string().max(TASK_LIMITS.reason).optional(),
    mutation: taskMutationContextSchema,
  })
  .strict();
export const commentTaskInputSchema = z
  .object({
    ref: taskRefSchema,
    body: z.string().trim().min(1).max(TASK_LIMITS.comment),
    mutation: taskMutationContextSchema,
  })
  .strict();

export const taskArtifactSchema = z
  .object({
    kind: z.enum(["pull_request", "run", "document", "url"]),
    label: z.string().trim().min(1).max(TASK_LIMITS.artifactLabel),
    url: httpUrl.optional(),
    executionId: id.optional(),
  })
  .strict();
export const attachTaskArtifactInputSchema = z
  .object({ ref: taskRefSchema, artifact: taskArtifactSchema, mutation: taskMutationContextSchema })
  .strict();

export const taskContainerPageSchema = z
  .object({
    items: z.array(taskContainerRefSchema).max(TASK_LIMITS.pageMax),
    nextCursor: cursor.optional(),
  })
  .strict();
export const taskPageSchema = z
  .object({
    items: z.array(taskSummarySchema).max(TASK_LIMITS.pageMax),
    nextCursor: cursor.optional(),
  })
  .strict();
export const taskActorPageSchema = z
  .object({
    items: z.array(taskActorSchema).max(TASK_LIMITS.pageMax),
    nextCursor: cursor.optional(),
  })
  .strict();

/** Convert a strict zod input schema into the JSON Schema a model tool consumes. */
export function zodTaskInputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _document, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return { ...rest, additionalProperties: false };
}

/* MCP wire schemas intentionally omit provider_key from task references. */
const wireTaskRefSchema = z.object({ id }).strict();
export const wireTaskActorSchema = z
  .object({ id, label: z.string().trim().min(1).max(500), kind: taskActorSchema.shape.kind })
  .strict();
const wireTaskContainerRefSchema = taskContainerRefSchema;
const wireTaskNativeStateSchema = z.object({ id, label }).strict();
export const wireTaskClaimSchema = z
  .object({ claimant: wireTaskActorSchema, execution_id: id, claimed_at: rfc3339 })
  .strict();

const wireSummaryShape = {
  ref: wireTaskRefSchema,
  container: wireTaskContainerRefSchema,
  title: z.string().trim().min(1).max(TASK_LIMITS.title),
  stage: taskStageSchema,
  native_state: wireTaskNativeStateSchema,
  priority: label.optional(),
  assignee: wireTaskActorSchema.optional(),
  claim: wireTaskClaimSchema.optional(),
  labels: z.array(label).max(TASK_LIMITS.labels),
  updated_at: rfc3339.optional(),
  revision: id.optional(),
  url: httpUrl.optional(),
};

export const wireTaskSummarySchema = z.object(wireSummaryShape).strict();
export const wireTaskDocumentSchema = z
  .object({
    ...wireSummaryShape,
    description: z.string().max(TASK_LIMITS.description).optional(),
    acceptance_criteria: z.array(z.string().max(TASK_LIMITS.criterion)).max(TASK_LIMITS.criteria),
    available_intents: z.array(taskTransitionIntentSchema).max(5),
  })
  .strict();
export const wireTaskProviderCapabilitiesSchema = z
  .object({
    protocol_version: z.literal(2),
    provider_instance_id: id,
    provider_kind: id,
    read: taskProviderCapabilitiesSchema.shape.read,
    write: z
      .object({
        create: z.boolean(),
        assign: z.boolean(),
        comment: z.boolean(),
        attach_artifact: z.boolean(),
        intents: z.array(taskTransitionIntentSchema).max(5),
      })
      .strict(),
    concurrency: taskProviderCapabilitiesSchema.shape.concurrency,
  })
  .strict();
export const wireTaskContainerPageSchema = z
  .object({
    items: z.array(wireTaskContainerRefSchema).max(TASK_LIMITS.pageMax),
    next_cursor: cursor.optional(),
  })
  .strict();
export const wireTaskPageSchema = z
  .object({
    items: z.array(wireTaskSummarySchema).max(TASK_LIMITS.pageMax),
    next_cursor: cursor.optional(),
  })
  .strict();
export const wireTaskActorPageSchema = z
  .object({
    items: z.array(wireTaskActorSchema).max(TASK_LIMITS.pageMax),
    next_cursor: cursor.optional(),
  })
  .strict();

/**
 * The failures a provider may report on the wire.
 *
 * @remarks Eight of {@link TASK_PROVIDER_ERROR_CODES}' fourteen, and the split is
 * exact rather than a subset someone chose: this union is what a *remote system*
 * can assert about a task, while the six it omits are what *Clarvis* concludes
 * about the exchange, which no provider is in a position to say.
 *
 * Those six, and why each cannot come from a provider:
 * `task_invalid_response` means the provider's own answer failed this schema;
 * `task_outcome_unknown` means the transport died after the write was sent, so
 * by construction nobody is there to report it; `task_provider_mismatch` means
 * the run is bound to a different provider, which this one cannot know;
 * `task_not_configured` means there is no provider to speak at all; and
 * `task_writes_disabled` and `task_cancelled` are local decisions — an
 * operator's setting and a caller's abort.
 *
 * Accepting one of the six here would let a provider claim an outcome only
 * Clarvis can determine — most damagingly `task_outcome_unknown`, which exists
 * precisely to mark the case where no answer arrived.
 */
const wireTaskErrorSchema = z
  .object({
    code: z.enum([
      "task_not_found",
      "task_forbidden",
      "task_unsupported",
      "task_invalid_transition",
      "task_conflict",
      "task_already_claimed",
      "task_invalid_input",
      "task_provider_unavailable",
    ]),
    message: z.string().min(1).max(4_096),
    current_revision: id.optional(),
  })
  .strict();

export function wireEnvelopeSchema<Result extends z.ZodType>(result: Result): z.ZodType {
  return z.discriminatedUnion("ok", [
    z
      .object({
        protocol_version: z.literal(2),
        provider_instance_id: id,
        ok: z.literal(true),
        result,
      })
      .strict(),
    z
      .object({
        protocol_version: z.literal(2),
        provider_instance_id: id,
        ok: z.literal(false),
        error: wireTaskErrorSchema,
      })
      .strict(),
  ]);
}
