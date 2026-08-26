import { createHash } from "node:crypto";
import {
  NOOP_LOGGER,
  bind,
  elicitWithClockPause,
  handlerBaseOf,
  openCallEnvelope,
  sanitizeErrorMessage,
  type AgentBuildContext,
  type AgentCapability,
  type AgentScope,
  type Capability,
  type ElicitRawResult,
  type HandlerBase,
  type HandlerVerdict,
  type Logger,
  type NamespacedTool,
  type RunCapability,
  type ToolHandler,
} from "@clarvis/capability";
import { z } from "zod";
import {
  ACTIVE_TASK_BLOCK_KIND,
  ACTIVE_TASK_MARKER,
  ACTIVE_TASK_SYSTEM_SECTION,
  activeTaskBlock,
} from "./active-task.ts";
import { TaskProviderError } from "./provider-errors.ts";
import type {
  TaskActor,
  TaskArtifact,
  AssignTaskInput,
  CommentTaskInput,
  CreateTaskInput,
  TaskDocument,
  TaskMutationContext,
  TaskProvider,
  TaskProviderResolution,
  TaskProviderResolver,
  TaskRef,
  TaskStage,
  TaskSummary,
  TaskTransitionIntent,
  TransitionTaskInput,
} from "./provider.ts";
import { TASK_LIMITS, taskIdentifierSchema, taskMutationContextSchema } from "./schemas.ts";
import { activeTaskRequestSchema, TASKS_CAPABILITY_NAME } from "./settings.ts";
import {
  TASK_GRANTS,
  TASK_TOOL_EFFECTS,
  TASK_TOOL_NAMES,
  TASK_TOOL_WIRE_NAMES,
  TASK_TOOLS,
  taskToolInputSchemas,
} from "./toolset.ts";
import {
  TASK_PERSISTED_TRACE_PROJECTORS,
  recordTaskTrace,
  type TaskTraceDetail,
  type TaskTraceKind,
} from "./trace.ts";

export { TASK_GRANTS, TASK_TOOL_NAMES, TASK_TOOL_WIRE_NAMES } from "./toolset.ts";
export { ACTIVE_TASK_MARKER } from "./active-task.ts";

const MAX_REVIEW_COMMENTS = 16;
const MAX_PENDING_MUTATIONS = 16;

export type TaskOrdinaryMutationOperationV2 =
  "create" | "assign" | "comment" | "start" | "block" | "complete" | "reopen";

export interface TaskOrdinaryMutationProgressStateV2 {
  signature: string;
  operation: TaskOrdinaryMutationOperationV2;
  inputDigest: string;
  context: TaskMutationContext;
  targetId?: string;
  containerId?: string;
}

export interface TaskReviewProgressStateV2 {
  signature: string;
  root: string;
  plan: TaskReviewPlanStateV2;
  completedArtifacts: number[];
  completedComments: number[];
  unknownSteps: string[];
  attempts: Array<{ step: string; attempt: number }>;
  contexts: Array<{ key: string; context: TaskMutationContext }>;
}

/**
 * Content-free description of the exact remote writes prepared for one review.
 *
 * The caller must repeat the original tool input to resume the review. Digests
 * prove that reconstruction still produces the same payloads, while the
 * persisted publication strategy prevents capability drift from changing a
 * child write underneath an already-used idempotency key.
 */
export interface TaskReviewPlanStateV2 {
  version: 1;
  artifactStrategies: Array<"attach" | "inline">;
  artifactDigests: string[];
  commentDigests: string[];
}

export interface TaskRunStateV2 {
  version: 2;
  providerKey: string;
  taskId: string;
  mode: "inspect" | "work";
  lastRevision?: string;
  lastStage: TaskStage;
  claim?: { executionId: string; claimantId: string };
  /** Durable idempotency progress for explicit retries after an uncertain review write. */
  pendingReviews?: TaskReviewProgressStateV2[];
  /** Content-free replay metadata for ordinary writes whose outcome remains unknown. */
  pendingMutations?: TaskOrdinaryMutationProgressStateV2[];
}

/**
 * Durable replay state for a run that used non-lifecycle task writes without
 * binding an active task.
 *
 * The distinct, strict shape is intentional: kernel projections can continue
 * accepting only {@link TaskRunStateV2}, while the capability can carry the
 * minimum authority needed to retry an uncertain create/assign/comment.
 */
export interface TaskUnboundRunStateV2 {
  version: 2;
  providerKey: string;
  pendingMutations: TaskOrdinaryMutationProgressStateV2[];
}

export type TaskCapabilityStateV2 = TaskRunStateV2 | TaskUnboundRunStateV2;

const ordinaryMutationProgressSchema = z
  .object({
    signature: z.string().length(64),
    operation: z.enum(["create", "assign", "comment", "start", "block", "complete", "reopen"]),
    inputDigest: z.string().length(64),
    context: taskMutationContextSchema,
    targetId: taskIdentifierSchema.optional(),
    containerId: taskIdentifierSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.operation === "create"
        ? value.containerId !== undefined && value.targetId === undefined
        : value.targetId !== undefined && value.containerId === undefined,
    { message: "ordinary mutation retry target does not match its operation" },
  );

export const taskRunStateV2Schema = z
  .object({
    version: z.literal(2),
    providerKey: taskIdentifierSchema,
    taskId: taskIdentifierSchema,
    mode: z.enum(["inspect", "work"]),
    lastRevision: taskIdentifierSchema.optional(),
    lastStage: z.enum([
      "backlog",
      "ready",
      "active",
      "blocked",
      "review",
      "done",
      "cancelled",
      "other",
    ]),
    claim: z
      .object({ executionId: z.string().min(1), claimantId: z.string().min(1) })
      .strict()
      .optional(),
    pendingReviews: z
      .array(
        z
          .object({
            signature: z.string().min(1),
            root: z.string().min(1),
            plan: z
              .object({
                version: z.literal(1),
                artifactStrategies: z
                  .array(z.enum(["attach", "inline"]))
                  .max(TASK_LIMITS.artifacts),
                artifactDigests: z.array(z.string().length(64)).max(TASK_LIMITS.artifacts),
                commentDigests: z.array(z.string().length(64)).max(MAX_REVIEW_COMMENTS),
              })
              .strict(),
            completedArtifacts: z
              .array(
                z
                  .number()
                  .int()
                  .min(0)
                  .max(TASK_LIMITS.artifacts - 1),
              )
              .max(TASK_LIMITS.artifacts),
            completedComments: z
              .array(
                z
                  .number()
                  .int()
                  .min(0)
                  .max(MAX_REVIEW_COMMENTS - 1),
              )
              .max(MAX_REVIEW_COMMENTS),
            unknownSteps: z.array(z.string().min(1)).max(64),
            attempts: z
              .array(
                z.object({ step: z.string().min(1), attempt: z.number().int().min(0) }).strict(),
              )
              .max(64),
            contexts: z
              .array(
                z.object({ key: z.string().min(1), context: taskMutationContextSchema }).strict(),
              )
              .max(64),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    pendingMutations: z.array(ordinaryMutationProgressSchema).max(MAX_PENDING_MUTATIONS).optional(),
  })
  .strict();

export const taskUnboundRunStateV2Schema = z
  .object({
    version: z.literal(2),
    providerKey: taskIdentifierSchema,
    pendingMutations: z.array(ordinaryMutationProgressSchema).min(1).max(MAX_PENDING_MUTATIONS),
  })
  .strict()
  .refine(
    (value) =>
      value.pendingMutations.every(
        (mutation) =>
          mutation.operation === "create" ||
          mutation.operation === "assign" ||
          mutation.operation === "comment",
      ),
    { message: "an unbound run cannot retain lifecycle task mutations" },
  );

export const taskCapabilityStateV2Schema = z.union([
  taskRunStateV2Schema,
  taskUnboundRunStateV2Schema,
]);

export interface TasksCapabilityOptions {
  resolver?: TaskProviderResolver;
  /** Builtin gate. The capability remains registered when false. */
  enabled?: boolean;
  /**
   * Operator diagnostics for the three facts this capability decides in
   * silence: which gate withheld a tool, why the provider did not resolve, and
   * that a write's outcome is unknown.
   *
   * @remarks Optional only because the property cannot carry a default; it is
   * resolved to {@link NOOP_LOGGER} once and bound with the run's
   * `execution_id`. Nothing here logs a task's title, description or comment
   * body, nor the provider declaration those credentials are interpolated into.
   */
  logger?: Logger;
}

interface ActiveBinding {
  mode: "inspect" | "work";
  document: TaskDocument;
  claimExecutionId: string;
}

interface RunRuntime {
  resolution: TaskProviderResolution;
  active?: ActiveBinding;
  contexts: Set<AgentBuildContext["ctx"]>;
  mutationTail: Promise<void>;
  reviewRetries: Map<string, ReviewProgress>;
  mutationRetries: Map<string, TaskOrdinaryMutationProgressStateV2>;
}

interface ReviewProgress {
  root: string;
  plan: TaskReviewPlanStateV2;
  completedArtifacts: Set<number>;
  completedComments: Set<number>;
  unknownSteps: Set<string>;
  attempts: Map<string, number>;
  contexts: Map<string, TaskMutationContext>;
}

interface ReviewInput {
  summary: string;
  evidence: string[];
  artifacts: TaskArtifact[];
  noEvidenceReason?: string;
}

interface MaterializedReviewPlan {
  plan: TaskReviewPlanStateV2;
  comments: string[];
}

const TASK_GRANT_SET = new Set<string>(Object.values(TASK_GRANTS));

function hasAnyTaskGrant(grants: readonly string[] | undefined): boolean {
  return grants?.some((grant) => TASK_GRANT_SET.has(grant)) ?? false;
}

function ref(provider: TaskProvider, id: string): TaskRef {
  return { providerKey: provider.key, id };
}

function safeTaskProjection(document: TaskSummary): Record<string, unknown> {
  return {
    provider_key: document.ref.providerKey,
    task_id: document.ref.id,
    stage: document.stage,
    native_state: document.nativeState.label,
    ...(document.revision === undefined ? {} : { revision: document.revision }),
    ...(document.assignee === undefined ? {} : { assignee: document.assignee.label }),
    ...(document.claim === undefined
      ? {}
      : {
          claim: {
            claimant_id: document.claim.claimant.id,
            execution_id: document.claim.executionId,
          },
        }),
  };
}

function modelTaskProjection(document: TaskSummary): Record<string, unknown> {
  return {
    ref: { provider_key: document.ref.providerKey, id: document.ref.id },
    container: document.container,
    title: document.title,
    stage: document.stage,
    native_state: document.nativeState,
    ...(document.priority === undefined ? {} : { priority: document.priority }),
    ...(document.assignee === undefined ? {} : { assignee: document.assignee }),
    ...(document.claim === undefined
      ? {}
      : {
          claim: {
            claimant: document.claim.claimant,
            execution_id: document.claim.executionId,
            claimed_at: document.claim.claimedAt,
          },
        }),
    labels: document.labels,
    ...(document.updatedAt === undefined ? {} : { updated_at: document.updatedAt }),
    ...(document.revision === undefined ? {} : { revision: document.revision }),
    ...(document.url === undefined ? {} : { url: document.url }),
  };
}

function traceArguments(
  name: string,
  args: Record<string, unknown>,
  active?: ActiveBinding,
): unknown {
  return {
    operation: name,
    task_id: typeof args.id === "string" ? args.id : active?.document.ref.id,
    ...(typeof args.container_id === "string" ? { container_id: args.container_id } : {}),
    ...(Array.isArray(args.evidence) ? { evidence_count: args.evidence.length } : {}),
    ...(Array.isArray(args.artifacts) ? { artifact_count: args.artifacts.length } : {}),
    ...(typeof args.body === "string" ? { body_chars: args.body.length } : {}),
    ...(typeof args.summary === "string" ? { summary_chars: args.summary.length } : {}),
  };
}

function hash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function valueDigest(value: unknown): string {
  return hash(JSON.stringify(canonicalValue(value)) ?? "undefined");
}

function splitReviewComment(body: string): string[] {
  if (body.length <= TASK_LIMITS.comment) return [body];
  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push(current);
    current = "";
  };
  for (const sourceLine of body.split("\n")) {
    let line = sourceLine;
    while (line.length > TASK_LIMITS.comment) {
      flush();
      chunks.push(line.slice(0, TASK_LIMITS.comment));
      line = line.slice(TASK_LIMITS.comment);
    }
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length > TASK_LIMITS.comment) flush();
    current = current.length === 0 ? line : `${current}\n${line}`;
  }
  flush();
  return chunks;
}

function reviewArtifactDigest(artifact: TaskArtifact): string {
  return hash(artifact.kind, artifact.label, artifact.url ?? "", artifact.executionId ?? "");
}

function reviewComments(
  input: ReviewInput,
  artifactStrategies: readonly ("attach" | "inline")[],
): string[] {
  const fallbackLinks = input.artifacts.flatMap((artifact, index) =>
    artifactStrategies[index] === "inline"
      ? [`${artifact.label}${artifact.url === undefined ? "" : `: ${artifact.url}`}`]
      : [],
  );
  return splitReviewComment(
    [
      `Summary: ${input.summary}`,
      ...(input.evidence.length === 0
        ? []
        : ["Evidence:", ...input.evidence.map((item) => `- ${item}`)]),
      ...(input.noEvidenceReason === undefined ? [] : [`No evidence: ${input.noEvidenceReason}`]),
      ...(fallbackLinks.length === 0
        ? []
        : ["Artifacts:", ...fallbackLinks.map((item) => `- ${item}`)]),
    ].join("\n"),
  );
}

function prepareReviewPlan(input: ReviewInput, canAttach: boolean): MaterializedReviewPlan {
  const artifactStrategies = input.artifacts.map<"attach" | "inline">(() =>
    canAttach ? "attach" : "inline",
  );
  const comments = reviewComments(input, artifactStrategies);
  if (comments.length > MAX_REVIEW_COMMENTS) {
    throw new TaskProviderError(
      "task_invalid_input",
      "The prepared review exceeds the maximum number of comment parts.",
    );
  }
  const plan: TaskReviewPlanStateV2 = {
    version: 1,
    artifactStrategies,
    artifactDigests: input.artifacts.map(reviewArtifactDigest),
    commentDigests: comments.map((body) => hash(body)),
  };
  return { plan, comments };
}

function materializeReviewPlan(
  input: ReviewInput,
  plan: TaskReviewPlanStateV2,
): MaterializedReviewPlan {
  const artifactDigests = input.artifacts.map(reviewArtifactDigest);
  if (
    plan.artifactStrategies.length !== input.artifacts.length ||
    plan.artifactDigests.length !== artifactDigests.length ||
    plan.artifactDigests.some((digest, index) => digest !== artifactDigests[index])
  ) {
    throw new TaskProviderError(
      "task_invalid_input",
      "The persisted review plan no longer matches the requested artifacts.",
    );
  }
  const comments = reviewComments(input, plan.artifactStrategies);
  if (comments.length > MAX_REVIEW_COMMENTS) {
    throw new TaskProviderError(
      "task_invalid_input",
      "The persisted review exceeds the maximum number of comment parts.",
    );
  }
  const commentDigests = comments.map((body) => hash(body));
  if (
    plan.commentDigests.length !== commentDigests.length ||
    plan.commentDigests.some((digest, index) => digest !== commentDigests[index])
  ) {
    throw new TaskProviderError(
      "task_invalid_input",
      "The persisted review plan no longer matches the requested review comment.",
    );
  }
  return { plan, comments };
}

function modelResult(document: TaskDocument): string {
  return JSON.stringify({
    ...modelTaskProjection(document),
    ...(document.description === undefined ? {} : { description: document.description }),
    acceptance_criteria: document.acceptanceCriteria,
    available_intents: document.availableIntents,
    ...(document.url === undefined ? {} : { url: document.url }),
  });
}

function handlerResult(text: string, progress: boolean): HandlerVerdict {
  return { kind: "result", text, progress };
}

function activeOrThrow(runtime: RunRuntime): ActiveBinding {
  if (runtime.active === undefined) {
    throw new TaskProviderError("task_invalid_input", "This run has no active task.");
  }
  return runtime.active;
}

function legal(active: ActiveBinding, intent: TaskTransitionIntent): void {
  if (!active.document.availableIntents.includes(intent)) {
    throw new TaskProviderError(
      "task_invalid_transition",
      `Intent '${intent}' is not currently available for task '${active.document.ref.id}'.`,
    );
  }
}

function updateActive(runtime: RunRuntime, document: TaskDocument): void {
  if (runtime.active?.document.ref.id !== document.ref.id) return;
  runtime.active.document = document;
  const block = activeTaskBlock(document);
  for (const context of runtime.contexts) context.setStableBlock(ACTIVE_TASK_BLOCK_KIND, block);
}

function actorFor(executionId: string, base: HandlerBase): TaskActor {
  const suffix = base.subagentInstanceId ?? base.agent;
  return {
    id: `clarvis-agent:${executionId}:${suffix}`,
    label: base.agent === "lead" ? "Clarvis lead agent" : `Clarvis subagent ${suffix}`,
    kind: "agent",
  };
}

function taskState(
  active: ActiveBinding,
  reviews: ReadonlyMap<string, ReviewProgress>,
  mutations: ReadonlyMap<string, TaskOrdinaryMutationProgressStateV2>,
): TaskRunStateV2 {
  const claim = active.document.claim;
  const pendingReviews: TaskReviewProgressStateV2[] = [...reviews].map(([signature, progress]) => ({
    signature,
    root: progress.root,
    plan: progress.plan,
    completedArtifacts: [...progress.completedArtifacts],
    completedComments: [...progress.completedComments],
    unknownSteps: [...progress.unknownSteps],
    attempts: [...progress.attempts].map(([step, attempt]) => ({ step, attempt })),
    contexts: [...progress.contexts].map(([key, context]) => ({ key, context })),
  }));
  const pendingMutations = [...mutations.values()];
  return taskRunStateV2Schema.parse({
    version: 2,
    providerKey: active.document.ref.providerKey,
    taskId: active.document.ref.id,
    mode: active.mode,
    ...(active.document.revision === undefined ? {} : { lastRevision: active.document.revision }),
    lastStage: active.document.stage,
    ...(claim === undefined || claim.executionId !== active.claimExecutionId
      ? {}
      : { claim: { executionId: claim.executionId, claimantId: claim.claimant.id } }),
    ...(pendingReviews.length === 0 ? {} : { pendingReviews }),
    ...(pendingMutations.length === 0 ? {} : { pendingMutations }),
  });
}

function unboundTaskState(
  providerKey: string,
  mutations: ReadonlyMap<string, TaskOrdinaryMutationProgressStateV2>,
): TaskUnboundRunStateV2 | undefined {
  if (mutations.size === 0) return undefined;
  return taskUnboundRunStateV2Schema.parse({
    version: 2,
    providerKey,
    pendingMutations: [...mutations.values()],
  });
}

function hasTaskBinding(state: TaskCapabilityStateV2): state is TaskRunStateV2 {
  return "taskId" in state;
}

function isTransientReplayFailure(error: unknown): boolean {
  return (
    error instanceof TaskProviderError &&
    (error.code === "task_provider_unavailable" || error.code === "task_cancelled")
  );
}

function restoreReviews(
  reviews: readonly TaskReviewProgressStateV2[] | undefined,
): Map<string, ReviewProgress> {
  return new Map(
    (reviews ?? []).map((progress) => [
      progress.signature,
      {
        root: progress.root,
        plan: progress.plan,
        completedArtifacts: new Set(progress.completedArtifacts),
        completedComments: new Set(progress.completedComments),
        unknownSteps: new Set(progress.unknownSteps),
        attempts: new Map(progress.attempts.map(({ step, attempt }) => [step, attempt])),
        contexts: new Map(progress.contexts.map(({ key, context }) => [key, context])),
      },
    ]),
  );
}

/**
 * Why a task tool is not in the agent's toolset.
 *
 * @remarks Resolved in this order, because the earlier answers subsume the
 * later ones: an operator who has not enabled writes cannot usefully be told
 * that the provider does not advertise `assign`.
 */
type TaskToolGate = "writes_disabled" | "inspect_mode" | "missing_grant" | "not_advertised";

/**
 * Select the task tools one agent gets, reporting each one that is withheld.
 *
 * @param scope - the agent, for its grants.
 * @param runtime - the resolved provider, its advertised capabilities and the
 *   run's active binding.
 * @param logger - operator diagnostics; every omission is logged, none is an
 *   error the model or the trace ever sees.
 * @returns the selected descriptors and their wire names.
 * @remarks The four write gates refuse by **omitting the tool from the
 *   toolset**. There is no error, no trace entry and no message anywhere — a
 *   model that never calls `complete_task` because the operator left
 *   `writes: "disabled"` looks exactly like a model that chose not to, and the
 *   question "why did the agent not have that tool" was unanswerable from
 *   outside. One line per withheld tool, once per agent, is bounded by the
 *   nine-tool surface.
 */
function toolsFor(
  scope: AgentScope,
  runtime: RunRuntime,
  logger: Logger = NOOP_LOGGER,
): { descriptors: NamespacedTool[]; names: Set<string> } {
  const names = new Set<string>();
  const caps = runtime.resolution.capabilities;
  const active = runtime.active;

  /** Report one withheld tool. */
  const withheld = (tool: string, gate: TaskToolGate, grant: string, intent?: string): void => {
    logger.info(
      {
        event: "tasks.tool.gated",
        tool,
        gate,
        grant,
        ...(intent === undefined ? {} : { intent }),
      },
      "a task tool is withheld from this agent, so the model is never offered it and reports no refusal",
    );
  };

  /** Admit a write tool, or report the first gate that refuses it. */
  const write = (tool: string, grant: string, advertised: boolean, intent?: string): void => {
    if (runtime.resolution.writes !== "enabled")
      return withheld(tool, "writes_disabled", grant, intent);
    if (active?.mode === "inspect") return withheld(tool, "inspect_mode", grant, intent);
    if (!scope.grants.includes(grant)) return withheld(tool, "missing_grant", grant, intent);
    if (!advertised) return withheld(tool, "not_advertised", grant, intent);
    names.add(tool);
  };

  if (scope.grants.includes(TASK_GRANTS.read)) {
    names.add(TASK_TOOL_NAMES.list);
    names.add(TASK_TOOL_NAMES.read);
  } else {
    withheld(TASK_TOOL_NAMES.list, "missing_grant", TASK_GRANTS.read);
    withheld(TASK_TOOL_NAMES.read, "missing_grant", TASK_GRANTS.read);
  }
  write(TASK_TOOL_NAMES.create, TASK_GRANTS.create, caps.write.create);
  write(TASK_TOOL_NAMES.assign, TASK_GRANTS.assign, caps.write.assign);
  write(TASK_TOOL_NAMES.comment, TASK_GRANTS.comment, caps.write.comment);
  if (active !== undefined) {
    const transitions = runtime.resolution.provider.transition !== undefined;
    const intent = (name: TaskTransitionIntent): boolean =>
      transitions && caps.write.intents.includes(name);
    write(TASK_TOOL_NAMES.start, TASK_GRANTS.progress, intent("start"), "start");
    write(TASK_TOOL_NAMES.block, TASK_GRANTS.progress, intent("block"), "block");
    write(TASK_TOOL_NAMES.review, TASK_GRANTS.review, intent("submit_review"), "submit_review");
    write(TASK_TOOL_NAMES.complete, TASK_GRANTS.complete, intent("complete"), "complete");
    write(TASK_TOOL_NAMES.reopen, TASK_GRANTS.complete, intent("reopen"), "reopen");
  }
  return {
    descriptors: [...names].map((name) => TASK_TOOLS[name as keyof typeof TASK_TOOLS]),
    names,
  };
}

async function serialized<T>(runtime: RunRuntime, action: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = runtime.mutationTail;
  runtime.mutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

async function approval(scope: AgentScope, message: string): Promise<boolean> {
  if (scope.elicit === undefined) return false;
  const ask = () =>
    scope.elicit!(
      {
        kind: "tasks_review_bypass",
        message,
        requestedSchema: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              enum: ["approve", "deny"],
              description: "Approve or deny transition without publishing all evidence.",
            },
          },
          required: ["decision"],
        },
      },
      { ...(scope.signal === undefined ? {} : { signal: scope.signal }) },
    );
  const raw =
    scope.clock === undefined
      ? await ask()
      : await elicitWithClockPause<ElicitRawResult>(scope.clock, scope.signal, ask, {
          onResult: (value) => value,
          onNoResponse: () => ({ action: "decline" as const }),
        });
  return raw.action === "accept" && raw.content?.decision === "approve";
}

function operationTrace(
  base: HandlerBase,
  kind: TaskTraceKind,
  document: TaskDocument,
  operation: string,
  fields: Partial<TaskTraceDetail> = {},
): void {
  recordTaskTrace(base.trace, kind, {
    provider_key: document.ref.providerKey,
    task_id: document.ref.id,
    operation,
    ...fields,
  });
}

interface HandlerOptions {
  base: HandlerBase;
  scope: AgentScope;
  executionId: string;
  owner: string;
  runtime: RunRuntime;
  allowed: ReadonlySet<string>;
  /** The run-bound operator logger; {@link NOOP_LOGGER} when the host supplied none. */
  logger: Logger;
}

function buildHandler(options: HandlerOptions): ToolHandler {
  const { runtime } = options;
  const provider = runtime.resolution.provider;
  const logger = options.logger;

  const mutation = (
    callId: string,
    operation: string,
    target: TaskDocument | undefined,
    rootOverride?: string,
  ): TaskMutationContext => {
    const actor = actorFor(options.executionId, options.base);
    const root = rootOverride ?? hash(provider.key, options.executionId, callId, operation);
    return {
      owner: options.owner,
      actor,
      executionId: options.executionId,
      claimExecutionId: runtime.active?.claimExecutionId ?? options.executionId,
      idempotencyKey: root,
      ...(target?.revision === undefined ? {} : { expectedRevision: target.revision }),
    };
  };

  const performMutation = async (
    operation: string,
    target: TaskDocument,
    context: TaskMutationContext,
    action: () => Promise<TaskDocument>,
  ): Promise<TaskDocument> => {
    const started = options.base.trace.now();
    const traceBase = {
      execution_id: options.executionId,
      actor_id: context.actor.id,
      actor_kind: context.actor.kind,
      started_at: started,
      ...(context.expectedRevision === undefined
        ? target.revision === undefined
          ? {}
          : { previous_revision: target.revision }
        : { previous_revision: context.expectedRevision }),
      idempotency_digest: hash(context.idempotencyKey).slice(0, 16),
    };
    operationTrace(options.base, "task_operation_started", target, operation, traceBase);
    try {
      const result = await action();
      updateActive(runtime, result);
      operationTrace(options.base, "task_operation_completed", result, operation, {
        ...traceBase,
        ended_at: options.base.trace.now(),
        ...(result.revision === undefined ? {} : { new_revision: result.revision }),
        result: "ok",
      });
      if (operation === "start" && result.claim !== undefined) {
        operationTrace(options.base, "task_claimed", result, operation, {
          execution_id: result.claim.executionId,
          actor_id: result.claim.claimant.id,
          result: "claimed",
        });
      }
      return result;
    } catch (error) {
      const taskError =
        error instanceof TaskProviderError
          ? error
          : new TaskProviderError(
              "task_provider_unavailable",
              error instanceof Error ? error.message : String(error),
              { cause: error },
            );
      let current: TaskDocument | undefined;
      let rereadError: string | undefined;
      if (taskError.code === "task_conflict" || taskError.code === "task_outcome_unknown") {
        try {
          current = await provider.get(target.ref);
          updateActive(runtime, current);
        } catch (error) {
          rereadError = sanitizeErrorMessage(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      if (taskError.code === "task_outcome_unknown") {
        logger.error(
          {
            event: "tasks.outcome_unknown",
            task_id: target.ref.id,
            operation,
            idempotency_digest: traceBase.idempotency_digest,
            reread_ok: current !== undefined,
            ...(rereadError === undefined ? {} : { reread_error: rereadError }),
          },
          current === undefined
            ? "a task write may or may not have applied and the recovery re-read also failed; Clarvis will never replay it, so a human must check the remote task"
            : "a task write may or may not have applied; the current remote task was re-read for inspection and nothing is replayed automatically",
        );
      }
      const kind =
        taskError.code === "task_conflict"
          ? "task_conflict"
          : taskError.code === "task_outcome_unknown"
            ? "task_outcome_unknown"
            : "task_operation_failed";
      operationTrace(options.base, kind, current ?? target, operation, {
        ...traceBase,
        ended_at: options.base.trace.now(),
        result: "failed",
        code: taskError.code,
        message: taskError.message,
        ...(current?.revision === undefined ? {} : { new_revision: current.revision }),
      });
      throw new TaskProviderError(taskError.code, taskError.message, {
        ...(taskError.currentRevision === undefined
          ? current?.revision === undefined
            ? {}
            : { currentRevision: current.revision }
          : { currentRevision: taskError.currentRevision }),
        ...(current === undefined ? {} : { currentTask: current }),
        cause: taskError,
      });
    }
  };

  const withMutation = (
    operation: string,
    target: TaskDocument,
    context: TaskMutationContext,
    action: () => Promise<TaskDocument>,
  ): Promise<TaskDocument> =>
    serialized(runtime, () => performMutation(operation, target, context, action));

  const performCreate = async (
    context: TaskMutationContext,
    action: () => Promise<TaskDocument>,
  ): Promise<TaskDocument> => {
    const traceBase: TaskTraceDetail = {
      provider_key: provider.key,
      task_id: "new",
      operation: "create",
      execution_id: options.executionId,
      actor_id: context.actor.id,
      actor_kind: context.actor.kind,
      started_at: options.base.trace.now(),
      idempotency_digest: hash(context.idempotencyKey).slice(0, 16),
    };
    recordTaskTrace(options.base.trace, "task_operation_started", traceBase);
    try {
      const result = await action();
      operationTrace(options.base, "task_operation_completed", result, "create", {
        ...traceBase,
        task_id: result.ref.id,
        ended_at: options.base.trace.now(),
        ...(result.revision === undefined ? {} : { new_revision: result.revision }),
        result: "ok",
      });
      return result;
    } catch (error) {
      const taskError =
        error instanceof TaskProviderError
          ? error
          : new TaskProviderError(
              "task_provider_unavailable",
              error instanceof Error ? error.message : String(error),
              { cause: error },
            );
      recordTaskTrace(
        options.base.trace,
        taskError.code === "task_outcome_unknown"
          ? "task_outcome_unknown"
          : "task_operation_failed",
        {
          ...traceBase,
          ended_at: options.base.trace.now(),
          result: "failed",
          code: taskError.code,
          message: taskError.message,
        },
      );
      if (taskError.code === "task_outcome_unknown") {
        logger.error(
          {
            event: "tasks.outcome_unknown",
            task_id: traceBase.task_id,
            operation: "create",
            idempotency_digest: traceBase.idempotency_digest,
            reread_ok: false,
          },
          "a task may or may not have been created and there is no id to re-read it by; Clarvis will never replay it, so a human must check the remote board",
        );
      }
      throw taskError;
    }
  };

  interface OrdinaryTarget {
    target?: TaskDocument;
    targetId?: string;
    containerId?: string;
  }

  const ordinaryMutation = <ProviderInput>(input: {
    callId: string;
    signature: string;
    operation: TaskOrdinaryMutationOperationV2;
    resolveTarget: (
      previous: TaskOrdinaryMutationProgressStateV2 | undefined,
    ) => Promise<OrdinaryTarget> | OrdinaryTarget;
    prepare: (context: TaskMutationContext, target: OrdinaryTarget) => ProviderInput;
    perform: (providerInput: ProviderInput) => Promise<TaskDocument>;
  }): Promise<TaskDocument> =>
    serialized(runtime, async () => {
      const previous = runtime.mutationRetries.get(input.signature);
      if (previous !== undefined && previous.operation !== input.operation) {
        throw new TaskProviderError(
          "task_invalid_input",
          "The uncertain task mutation does not match this retry operation.",
        );
      }
      if (previous === undefined && runtime.mutationRetries.size >= MAX_PENDING_MUTATIONS) {
        throw new TaskProviderError(
          "task_conflict",
          "This run already has sixteen unresolved task mutations; retry one before starting another.",
        );
      }
      const target = await input.resolveTarget(previous);
      const context = previous?.context ?? mutation(input.callId, input.operation, target.target);
      const providerInput = input.prepare(context, target);
      const inputDigest = valueDigest(providerInput);
      if (previous !== undefined && previous.inputDigest !== inputDigest) {
        throw new TaskProviderError(
          "task_invalid_input",
          "The explicit retry no longer reconstructs the original provider mutation.",
        );
      }
      const progress: TaskOrdinaryMutationProgressStateV2 =
        previous ??
        (input.operation === "create"
          ? {
              signature: input.signature,
              operation: input.operation,
              inputDigest,
              context,
              containerId: target.containerId!,
            }
          : {
              signature: input.signature,
              operation: input.operation,
              inputDigest,
              context,
              targetId: target.targetId!,
            });
      try {
        const result =
          input.operation === "create"
            ? await performCreate(context, () => input.perform(providerInput))
            : await performMutation(input.operation, target.target!, context, () =>
                input.perform(providerInput),
              );
        runtime.mutationRetries.delete(input.signature);
        return result;
      } catch (error) {
        if (error instanceof TaskProviderError && error.code === "task_outcome_unknown") {
          runtime.mutationRetries.set(input.signature, progress);
        } else if (previous === undefined || !isTransientReplayFailure(error)) {
          runtime.mutationRetries.delete(input.signature);
        }
        throw error;
      }
    });

  return {
    matches: (call) => options.allowed.has(call.name),
    async handle(call, iteration): Promise<HandlerVerdict> {
      const toolName = call.name as keyof typeof taskToolInputSchemas;
      const schema = taskToolInputSchemas[toolName];
      const descriptor = TASK_TOOLS[toolName];
      const args = (call.arguments ?? {}) as Record<string, unknown>;
      const envelope = openCallEnvelope({
        call,
        name: call.name,
        trace: options.base.trace,
        agent: options.base.agent,
        ...(options.base.subagentInstanceId === undefined
          ? {}
          : { subagentInstanceId: options.base.subagentInstanceId }),
        iteration,
        ...(schema === undefined || descriptor === undefined
          ? {}
          : { schema: descriptor.inputSchema }),
        ...(options.base.validateArgs === undefined ? {} : { validate: options.base.validateArgs }),
        traceArguments: traceArguments(call.name, args, runtime.active),
      });
      if (envelope.invalid !== null) {
        return handlerResult(
          envelope.fail(envelope.invalid, `invalid ${call.name} arguments`),
          false,
        );
      }
      envelope.start();
      try {
        if (call.name === TASK_TOOL_NAMES.list) {
          const page = await provider.search(
            {
              ...(typeof args.container_id === "string" ? { containerId: args.container_id } : {}),
              ...(typeof args.query === "string" ? { query: args.query } : {}),
              ...(Array.isArray(args.stages) ? { stages: args.stages as TaskStage[] } : {}),
              ...(typeof args.assignee_id === "string" ? { assigneeId: args.assignee_id } : {}),
              ...(Array.isArray(args.labels) ? { labels: args.labels as string[] } : {}),
              ...(args.claim === "any" || args.claim === "free" || args.claim === "claimed"
                ? { claim: args.claim }
                : {}),
              ...(typeof args.updated_after === "string"
                ? { updatedAfter: args.updated_after }
                : {}),
              ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
              ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
            },
            options.base.signal,
          );
          const output = JSON.stringify({
            items: page.items.map(modelTaskProjection),
            ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }),
          });
          return handlerResult(
            envelope.ok(output, JSON.stringify({ count: page.items.length })),
            true,
          );
        }
        if (call.name === TASK_TOOL_NAMES.read) {
          const document = await provider.get(
            ref(provider, args.id as string),
            options.base.signal,
          );
          return handlerResult(
            envelope.ok(modelResult(document), JSON.stringify(safeTaskProjection(document))),
            true,
          );
        }
        if (call.name === TASK_TOOL_NAMES.create) {
          if (provider.create === undefined) {
            throw new TaskProviderError("task_unsupported", "Task creation is unavailable.");
          }
          const document = await ordinaryMutation<CreateTaskInput>({
            callId: envelope.callId,
            signature: hash(provider.key, call.name, valueDigest(args)),
            operation: "create",
            resolveTarget(previous) {
              const containerId =
                previous?.containerId ??
                (typeof args.container_id === "string"
                  ? args.container_id
                  : runtime.resolution.defaultContainer);
              if (containerId === undefined) {
                throw new TaskProviderError(
                  "task_invalid_input",
                  "create_task requires container_id because no default container is configured.",
                );
              }
              return { containerId };
            },
            prepare: (context, target) => ({
              containerId: target.containerId!,
              title: args.title as string,
              ...(typeof args.description === "string" ? { description: args.description } : {}),
              ...(Array.isArray(args.acceptance_criteria)
                ? { acceptanceCriteria: args.acceptance_criteria as string[] }
                : {}),
              ...(typeof args.priority === "string" ? { priority: args.priority } : {}),
              ...(typeof args.assignee_id === "string" ? { assigneeId: args.assignee_id } : {}),
              ...(Array.isArray(args.labels) ? { labels: args.labels as string[] } : {}),
              mutation: context,
            }),
            perform: (providerInput) => provider.create!(providerInput, options.base.signal),
          });
          return handlerResult(
            envelope.ok(modelResult(document), JSON.stringify(safeTaskProjection(document))),
            true,
          );
        }
        if (call.name === TASK_TOOL_NAMES.assign || call.name === TASK_TOOL_NAMES.comment) {
          const active = runtime.active;
          const signature = hash(provider.key, call.name, valueDigest(args));
          const resolveTarget = async (
            previous: TaskOrdinaryMutationProgressStateV2 | undefined,
          ): Promise<OrdinaryTarget> => {
            const targetId =
              previous?.targetId ??
              (typeof args.id === "string" ? args.id : active?.document.ref.id);
            if (targetId === undefined) {
              throw new TaskProviderError(
                "task_invalid_input",
                `${call.name} requires id when no task is active.`,
              );
            }
            const target =
              active?.document.ref.id === targetId
                ? active.document
                : await provider.get(ref(provider, targetId), options.base.signal);
            return { target, targetId };
          };
          const document =
            call.name === TASK_TOOL_NAMES.assign
              ? await ordinaryMutation<AssignTaskInput>({
                  callId: envelope.callId,
                  signature,
                  operation: "assign",
                  resolveTarget,
                  prepare: (context, target) => ({
                    ref: target.target!.ref,
                    assigneeId: args.assignee_id as string | null,
                    mutation: context,
                  }),
                  perform: (providerInput) => {
                    if (provider.assign === undefined) {
                      throw new TaskProviderError(
                        "task_unsupported",
                        "Task assignment is unavailable.",
                      );
                    }
                    return provider.assign(providerInput, options.base.signal);
                  },
                })
              : await ordinaryMutation<CommentTaskInput>({
                  callId: envelope.callId,
                  signature,
                  operation: "comment",
                  resolveTarget,
                  prepare: (context, target) => ({
                    ref: target.target!.ref,
                    body: args.body as string,
                    mutation: context,
                  }),
                  perform: (providerInput) => {
                    if (provider.comment === undefined) {
                      throw new TaskProviderError(
                        "task_unsupported",
                        "Task comments are unavailable.",
                      );
                    }
                    return provider.comment(providerInput, options.base.signal);
                  },
                });
          return handlerResult(
            envelope.ok(modelResult(document), JSON.stringify(safeTaskProjection(document))),
            true,
          );
        }

        const active = activeOrThrow(runtime);
        if (provider.transition === undefined)
          throw new TaskProviderError("task_unsupported", "Task transitions are unavailable.");
        const transition = async (
          intent: TaskTransitionIntent,
          reason?: string,
        ): Promise<TaskDocument> => {
          if (intent === "submit_review") {
            throw new TaskProviderError(
              "task_invalid_input",
              "Review transitions require the composite review operation.",
            );
          }
          return ordinaryMutation<TransitionTaskInput>({
            callId: envelope.callId,
            signature: hash(provider.key, call.name, valueDigest(args)),
            operation: intent,
            resolveTarget(previous) {
              if (previous === undefined) legal(active, intent);
              if (
                previous?.targetId !== undefined &&
                previous.targetId !== active.document.ref.id
              ) {
                throw new TaskProviderError(
                  "task_provider_mismatch",
                  "The uncertain lifecycle mutation belongs to another active task.",
                );
              }
              return { target: active.document, targetId: active.document.ref.id };
            },
            prepare: (context, target) => ({
              ref: target.target!.ref,
              intent,
              ...(intent === "start" ? { claimant: context.actor } : {}),
              ...(reason === undefined ? {} : { reason }),
              mutation: context,
            }),
            perform: (providerInput) => provider.transition!(providerInput, options.base.signal),
          });
        };

        let document: TaskDocument;
        if (call.name === TASK_TOOL_NAMES.start) document = await transition("start");
        else if (call.name === TASK_TOOL_NAMES.block)
          document = await transition("block", args.reason as string);
        else if (call.name === TASK_TOOL_NAMES.complete)
          document = await transition("complete", args.reason as string | undefined);
        else if (call.name === TASK_TOOL_NAMES.reopen)
          document = await transition("reopen", args.reason as string | undefined);
        else if (call.name === TASK_TOOL_NAMES.review) {
          const evidence = Array.isArray(args.evidence) ? (args.evidence as string[]) : [];
          const artifacts = Array.isArray(args.artifacts) ? (args.artifacts as TaskArtifact[]) : [];
          const reviewInput: ReviewInput = {
            summary: args.summary as string,
            evidence,
            artifacts,
            ...(typeof args.no_evidence_reason === "string"
              ? { noEvidenceReason: args.no_evidence_reason }
              : {}),
          };
          const retrySignature = hash(
            provider.key,
            active.document.ref.id,
            JSON.stringify({
              summary: args.summary,
              evidence,
              artifacts,
              no_evidence_reason: args.no_evidence_reason,
            }),
          );
          const existingProgress = runtime.reviewRetries.get(retrySignature);
          // A final transition may have committed remotely before its response
          // was lost. In that one case the reconciled snapshot can legitimately
          // stop advertising submit_review; the exact persisted child key must
          // still reach the provider so it can deduplicate the uncertain write.
          if (existingProgress?.unknownSteps.has("transition") !== true) {
            legal(active, "submit_review");
          }
          if (existingProgress === undefined && runtime.reviewRetries.size >= 4) {
            throw new TaskProviderError(
              "task_conflict",
              "This run already has four unresolved review submissions; retry or resolve one before starting another.",
            );
          }
          const prepared =
            existingProgress === undefined
              ? prepareReviewPlan(reviewInput, provider.attachArtifact !== undefined)
              : materializeReviewPlan(reviewInput, existingProgress.plan);
          const progress = existingProgress ?? {
            root: hash(provider.key, options.executionId, envelope.callId, "submit_review"),
            plan: prepared.plan,
            completedArtifacts: new Set<number>(),
            completedComments: new Set<number>(),
            unknownSteps: new Set<string>(),
            attempts: new Map<string, number>(),
            contexts: new Map<string, TaskMutationContext>(),
          };
          runtime.reviewRetries.set(retrySignature, progress);
          const childKey = (step: string): string => {
            const attempt = progress.attempts.get(step) ?? 0;
            return `${progress.root}:${step}${attempt === 0 ? "" : `:retry:${attempt}`}`;
          };
          const childContext = (
            step: string,
            operation: string,
            target: TaskDocument,
          ): TaskMutationContext => {
            const key = childKey(step);
            const existing = progress.contexts.get(key);
            if (existing !== undefined) return existing;
            const context = mutation(envelope.callId, operation, target, key);
            progress.contexts.set(key, context);
            return context;
          };
          const retryableStep = async <T>(step: string, action: () => Promise<T>): Promise<T> => {
            const key = childKey(step);
            try {
              const result = await action();
              progress.unknownSteps.delete(step);
              progress.attempts.delete(step);
              progress.contexts.delete(key);
              return result;
            } catch (error) {
              if (error instanceof TaskProviderError) {
                if (error.code === "task_outcome_unknown") {
                  progress.unknownSteps.add(step);
                } else if (!progress.unknownSteps.has(step) || !isTransientReplayFailure(error)) {
                  // A transient failure of an already-uncertain retry cannot
                  // prove the original child write was not applied.
                  progress.unknownSteps.delete(step);
                  progress.contexts.delete(key);
                  progress.attempts.set(step, (progress.attempts.get(step) ?? 0) + 1);
                }
              }
              throw error;
            }
          };
          const publish = async (): Promise<TaskDocument> => {
            let snapshot = runtime.active?.document ?? active.document;
            for (let index = 0; index < artifacts.length; index += 1) {
              const artifact = artifacts[index]!;
              if (progress.plan.artifactStrategies[index] === "inline") continue;
              if (progress.completedArtifacts.has(index)) continue;
              if (provider.attachArtifact === undefined) {
                throw new TaskProviderError(
                  "task_unsupported",
                  "The prepared review requires artifact attachment, but that provider operation is no longer available.",
                );
              }
              const step = `artifact:${index}`;
              const context = childContext(step, step, snapshot);
              snapshot = await retryableStep(step, () =>
                withMutation(step, snapshot, context, () =>
                  provider.attachArtifact!(
                    { ref: snapshot.ref, artifact, mutation: context },
                    options.base.signal,
                  ),
                ),
              );
              progress.completedArtifacts.add(index);
            }
            const comments = prepared.comments;
            for (let index = 0; index < comments.length; index += 1) {
              if (progress.completedComments.has(index)) continue;
              if (provider.comment === undefined) {
                throw new TaskProviderError(
                  "task_unsupported",
                  "The provider cannot publish the prepared review summary as a comment.",
                );
              }
              const step = comments.length === 1 ? "comment" : `comment:${index}`;
              const commentContext = childContext(step, "review_comment", snapshot);
              snapshot = await retryableStep(step, () =>
                withMutation("review_comment", snapshot, commentContext, () =>
                  provider.comment!(
                    { ref: snapshot.ref, body: comments[index]!, mutation: commentContext },
                    options.base.signal,
                  ),
                ),
              );
              progress.completedComments.add(index);
            }
            return snapshot;
          };
          let published: TaskDocument;
          try {
            published = await publish();
          } catch (error) {
            if (
              error instanceof TaskProviderError &&
              (error.code === "task_conflict" ||
                error.code === "task_outcome_unknown" ||
                progress.unknownSteps.size > 0)
            )
              throw error;
            if (args.allow_without_artifacts !== true) throw error;
            const approved = await approval(
              options.scope,
              `Evidence for task ${active.document.ref.id} could not be fully published. Allow the agent to submit it for review anyway?`,
            );
            if (!approved) {
              throw new TaskProviderError(
                "task_forbidden",
                "Review transition without published evidence was not approved.",
              );
            }
            published = runtime.active?.document ?? active.document;
          }
          const context = childContext("transition", "submit_review", published);
          document = await retryableStep("transition", () =>
            withMutation("submit_review", published, context, () =>
              provider.transition!(
                { ref: published.ref, intent: "submit_review", mutation: context },
                options.base.signal,
              ),
            ),
          );
          runtime.reviewRetries.delete(retrySignature);
        } else {
          throw new TaskProviderError(
            "task_unsupported",
            `Task tool '${call.name}' is unavailable.`,
          );
        }
        return handlerResult(
          envelope.ok(modelResult(document), JSON.stringify(safeTaskProjection(document))),
          true,
        );
      } catch (error) {
        const taskError =
          error instanceof TaskProviderError
            ? error
            : new TaskProviderError(
                "task_provider_unavailable",
                error instanceof Error ? error.message : String(error),
                { cause: error },
              );
        const response = {
          code: taskError.code,
          message: sanitizeErrorMessage(taskError.message),
          ...(taskError.currentRevision === undefined
            ? {}
            : { current_revision: taskError.currentRevision }),
          ...(taskError.currentTask === undefined
            ? {}
            : { current_task: safeTaskProjection(taskError.currentTask) }),
        };
        return handlerResult(
          envelope.fail(JSON.stringify(response), JSON.stringify({ code: taskError.code })),
          false,
        );
      }
    },
  };
}

/** Build the always-registered Tasks capability. */
export function createTasksCapability(options: TasksCapabilityOptions = {}): Capability {
  const rootLogger = options.logger ?? NOOP_LOGGER;
  return {
    name: TASKS_CAPABILITY_NAME,
    grants: Object.values(TASK_GRANTS).map((name) => ({ name })),
    seedMarker: ACTIVE_TASK_MARKER,
    persistedTraceProjectors: TASK_PERSISTED_TRACE_PROJECTORS,
    reservedWireNames: TASK_TOOL_WIRE_NAMES,
    toolEffects: TASK_TOOL_EFFECTS,
    async forRun(ctx): Promise<RunCapability | null> {
      const logger = bind(rootLogger, { execution_id: ctx.executionId });
      const rawTask = ctx.requestParam("task");
      const parsedTask = rawTask === undefined ? undefined : activeTaskRequestSchema.parse(rawTask);
      const priorRaw = ctx.priorState?.[TASKS_CAPABILITY_NAME];
      if (
        priorRaw !== undefined &&
        typeof priorRaw === "object" &&
        priorRaw !== null &&
        (priorRaw as { version?: unknown }).version === 1
      ) {
        throw new TaskProviderError(
          "task_invalid_input",
          "This continuation contains a Tasks v1 binding and cannot be resumed by Tasks v2.",
        );
      }
      const prior =
        priorRaw === undefined ? undefined : taskCapabilityStateV2Schema.parse(priorRaw);
      const priorBinding = prior === undefined || !hasTaskBinding(prior) ? undefined : prior;
      const continuation = ctx.request.continue_from !== undefined;
      if (continuation && parsedTask !== undefined && priorBinding === undefined) {
        throw new TaskProviderError(
          "task_invalid_input",
          "A continuation cannot bind a task when the original run had none.",
        );
      }
      if (priorBinding !== undefined && parsedTask !== undefined) {
        if (
          parsedTask.id !== priorBinding.taskId ||
          parsedTask.mode !== priorBinding.mode ||
          (parsedTask.provider_key !== undefined &&
            parsedTask.provider_key !== priorBinding.providerKey)
        ) {
          throw new TaskProviderError(
            "task_provider_mismatch",
            "A continuation cannot change its task, mode, or provider.",
          );
        }
      }
      const requested =
        priorBinding === undefined
          ? parsedTask
          : {
              id: priorBinding.taskId,
              provider_key: priorBinding.providerKey,
              mode: priorBinding.mode,
            };
      const profilesNeedTasks = ctx.request.profiles.some((profile) =>
        hasAnyTaskGrant(profile.grants),
      );
      if (requested === undefined && prior === undefined && !profilesNeedTasks) return null;
      if (options.enabled === false || options.resolver === undefined) {
        if (requested !== undefined || prior !== undefined) {
          throw new TaskProviderError("task_not_configured", "Tasks are disabled in this host.");
        }
        return null;
      }
      let resolution: TaskProviderResolution;
      const requestedKey = prior?.providerKey ?? requested?.provider_key;
      try {
        resolution = await options.resolver.resolve(ctx.owner, requestedKey, ctx.signal);
      } catch (error) {
        if (requested !== undefined || prior !== undefined) throw error;
        logger.warn(
          {
            event: "tasks.provider.unresolved",
            owner: ctx.owner,
            ...(requestedKey === undefined ? {} : { requested_key: requestedKey }),
            code: error instanceof TaskProviderError ? error.code : "task_provider_unavailable",
            cause: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
          },
          "the task provider did not resolve and nothing requested one, so Tasks does not activate and the run has no task tools",
        );
        return null;
      }
      if (prior !== undefined && prior.providerKey !== resolution.provider.key) {
        throw new TaskProviderError(
          "task_provider_mismatch",
          `Task retries expect provider '${prior.providerKey}', but '${resolution.provider.key}' is selected.`,
        );
      }
      let active: ActiveBinding | undefined;
      if (requested !== undefined) {
        if (
          requested.provider_key !== undefined &&
          requested.provider_key !== resolution.provider.key
        ) {
          throw new TaskProviderError(
            "task_provider_mismatch",
            `Task expects provider '${requested.provider_key}', but '${resolution.provider.key}' is selected.`,
          );
        }
        const document = await resolution.provider.get(
          ref(resolution.provider, requested.id),
          ctx.signal,
        );
        active = {
          mode: requested.mode,
          document,
          claimExecutionId: priorBinding?.claim?.executionId ?? ctx.executionId,
        };
      }
      const runtime: RunRuntime = {
        resolution,
        ...(active === undefined ? {} : { active }),
        contexts: new Set(),
        mutationTail: Promise.resolve(),
        reviewRetries: restoreReviews(priorBinding?.pendingReviews),
        mutationRetries: new Map(
          (prior?.pendingMutations ?? []).map((progress) => [progress.signature, progress]),
        ),
      };
      let boundRecorded = false;
      return {
        name: TASKS_CAPABILITY_NAME,
        ...(active === undefined ? {} : { seedBlock: () => activeTaskBlock(active.document) }),
        systemSection(identity): string | undefined {
          return hasAnyTaskGrant(identity.grants) || active !== undefined
            ? ACTIVE_TASK_SYSTEM_SECTION
            : undefined;
        },
        forAgent(scope): AgentCapability | null {
          if (!hasAnyTaskGrant(scope.grants)) return null;
          const selected = toolsFor(scope, runtime, logger);
          if (selected.descriptors.length === 0) return null;
          return {
            attach(build) {
              runtime.contexts.add(build.ctx);
              if (!boundRecorded && runtime.active !== undefined) {
                boundRecorded = true;
                operationTrace(
                  handlerBaseOf(build),
                  "task_bound",
                  runtime.active.document,
                  "bind",
                  {
                    execution_id: ctx.executionId,
                    result: runtime.active.mode,
                  },
                );
              }
              return {
                tools: selected.descriptors,
                handlers: [
                  buildHandler({
                    base: handlerBaseOf(build),
                    scope,
                    executionId: ctx.executionId,
                    owner: ctx.owner,
                    runtime,
                    allowed: selected.names,
                    logger,
                  }),
                ],
                advertised: true,
              };
            },
          };
        },
        finalizeRun(): TaskCapabilityStateV2 | undefined {
          return runtime.active === undefined
            ? unboundTaskState(runtime.resolution.provider.key, runtime.mutationRetries)
            : taskState(runtime.active, runtime.reviewRetries, runtime.mutationRetries);
        },
      };
    },
  };
}
