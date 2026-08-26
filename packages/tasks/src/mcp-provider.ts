import type { z } from "zod";
import { NOOP_LOGGER, createSampler, type Logger, type Sampler } from "@clarvis/capability";
import { TaskProviderError } from "./provider-errors.ts";
import type {
  AssignTaskInput,
  AttachTaskArtifactInput,
  CommentTaskInput,
  CreateTaskInput,
  ListTaskContainersInput,
  SearchTaskActorsInput,
  SearchTasksInput,
  TaskActor,
  TaskActorPage,
  TaskClaim,
  TaskContainerPage,
  TaskDocument,
  TaskMutationContext,
  TaskPage,
  TaskProvider,
  TaskProviderCapabilities,
  TaskRef,
  TaskSummary,
  TransitionTaskInput,
} from "./provider.ts";
import {
  TASK_LIMITS,
  taskActorPageSchema,
  taskContainerPageSchema,
  taskDocumentSchema,
  taskPageSchema,
  wireEnvelopeSchema,
  wireTaskActorPageSchema,
  wireTaskContainerPageSchema,
  wireTaskDocumentSchema,
  wireTaskPageSchema,
  wireTaskProviderCapabilitiesSchema,
} from "./schemas.ts";
import type { wireTaskActorSchema, wireTaskClaimSchema, wireTaskSummarySchema } from "./schemas.ts";
import type { TaskServerPort } from "./server-port.ts";
import { sanitizeTaskText } from "./active-task.ts";

export const TASK_MCP_TOOLS = Object.freeze({
  capabilities: "tasks_capabilities",
  listContainers: "tasks_list_containers",
  search: "tasks_search",
  get: "tasks_get",
  searchActors: "tasks_search_actors",
  create: "tasks_create",
  assign: "tasks_assign",
  transition: "tasks_transition",
  comment: "tasks_comment",
  attachArtifact: "tasks_attach_artifact",
});

export interface McpTaskProviderOptions {
  owner: string;
  key: string;
  port: TaskServerPort;
  /** Avoid a second capabilities probe when the kernel already performed it for provider-key calculation. */
  capabilities?: TaskProviderCapabilities;
  /**
   * Operator diagnostics for the adapter boundary.
   *
   * @remarks Optional only because the property cannot carry a default; it is
   * resolved to {@link NOOP_LOGGER} once and every call below is unconditional.
   * Nothing here logs `clarvis_context`, an argument object or a response body:
   * the declaration this port was built from carries `${VAR}`-interpolated
   * credentials, and a task's own text is model-visible prose.
   */
  logger?: Logger;
}

/** What one provider call reports about itself, whatever its outcome. */
interface CallOutcome {
  ok: boolean;
  code?: string;
  providerInstanceId?: string;
}

/**
 * Report one completed provider call, sampled.
 *
 * @param context - the logger and sampler resolved for this provider.
 * @param tool - the canonical `tasks_*` tool that was called.
 * @param startedAt - the millisecond clock reading taken before dispatch.
 * @param outcome - whether the call succeeded, and the stable code if not.
 * @remarks Sampled with {@link createSampler} — first eight per tool, then
 *   powers of two — because a search-heavy run calls one tool repeatedly and an
 *   unsampled line per call would be the log's dominant volume. The sample key
 *   is the tool, so a rarely-used mutation is never crowded out by a frequent
 *   read.
 */
function reportCall(
  context: McpCallContext,
  tool: string,
  startedAt: number,
  outcome: CallOutcome,
): void {
  if (!context.sample(tool)) return;
  context.logger.debug(
    {
      event: "tasks.provider.call",
      tool,
      duration_ms: Date.now() - startedAt,
      ok: outcome.ok,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
      ...(outcome.providerInstanceId === undefined
        ? {}
        : { provider_instance_id: outcome.providerInstanceId }),
    },
    outcome.ok
      ? "the task provider answered"
      : "the task provider call did not produce a task; the caller decides whether to re-read",
  );
}

/** How many distinct projection failures one line names before it stops. */
const MAX_LOGGED_ISSUE_PATHS = 16;

/**
 * The field paths a projection failure names, without any of the values.
 *
 * @param error - the strict envelope schema's rejection.
 * @returns deduplicated dotted paths, capped at {@link MAX_LOGGED_ISSUE_PATHS};
 *   the envelope root is reported as `<root>`.
 * @remarks Paths only, deliberately. An issue's `message` and `input` quote the
 *   provider's own payload — a task title, a description, a comment body — which
 *   is model-authored prose the standard forbids logging. The path is what an
 *   operator needs to tell an adapter bug from a protocol-version mismatch.
 */
function issuePaths(error: { issues: ReadonlyArray<{ path: PropertyKey[] }> }): string[] {
  const paths = new Set<string>();
  for (const issue of error.issues) {
    if (paths.size >= MAX_LOGGED_ISSUE_PATHS) break;
    paths.add(issue.path.length === 0 ? "<root>" : issue.path.map(String).join("."));
  }
  return [...paths];
}

/** Everything one provider call needs beyond its own arguments. */
interface McpCallContext {
  owner: string;
  port: TaskServerPort;
  logger: Logger;
  sample: Sampler;
}

/**
 * Resolve one provider's call context, including its own sampler.
 *
 * @param options - the owner, port and optional logger.
 * @returns the {@link McpCallContext} every call through this provider shares.
 * @remarks The sampler is per provider rather than per module: two providers
 *   sharing one counter would sample each other's calls, and a second provider's
 *   first eight calls would be invisible.
 */
function callContext(
  options: Pick<McpTaskProviderOptions, "owner" | "port" | "logger">,
): McpCallContext {
  return {
    owner: options.owner,
    port: options.port,
    logger: options.logger ?? NOOP_LOGGER,
    sample: createSampler(),
  };
}

type WireActor = z.output<typeof wireTaskActorSchema>;
type WireClaim = z.output<typeof wireTaskClaimSchema>;
type WireSummary = z.output<typeof wireTaskSummarySchema>;
type WireDocument = z.output<typeof wireTaskDocumentSchema>;

function actor(value: WireActor): TaskActor {
  return { id: value.id, label: sanitizeTaskText(value.label), kind: value.kind };
}

function claim(value: WireClaim): TaskClaim {
  return {
    claimant: actor(value.claimant),
    executionId: value.execution_id,
    claimedAt: value.claimed_at,
  };
}

function summary(value: WireSummary, providerKey: string): TaskSummary {
  return {
    ref: { providerKey, id: value.ref.id },
    container: { ...value.container, label: sanitizeTaskText(value.container.label) },
    title: sanitizeTaskText(value.title),
    stage: value.stage,
    nativeState: {
      ...value.native_state,
      label: sanitizeTaskText(value.native_state.label),
    },
    ...(value.priority === undefined ? {} : { priority: sanitizeTaskText(value.priority) }),
    ...(value.assignee === undefined ? {} : { assignee: actor(value.assignee) }),
    ...(value.claim === undefined ? {} : { claim: claim(value.claim) }),
    labels: value.labels.map(sanitizeTaskText),
    ...(value.updated_at === undefined ? {} : { updatedAt: value.updated_at }),
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    ...(value.url === undefined ? {} : { url: value.url }),
  };
}

function document(value: WireDocument, providerKey: string): TaskDocument {
  return {
    ...summary(value, providerKey),
    ...(value.description === undefined
      ? {}
      : { description: sanitizeTaskText(value.description) }),
    acceptanceCriteria: value.acceptance_criteria.map(sanitizeTaskText),
    availableIntents: [...value.available_intents],
  };
}

function validatedProjection<Result>(
  schema: z.ZodType<Result>,
  value: unknown,
  mutation: boolean,
  projection: string,
): Result {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new TaskProviderError(
    mutation ? "task_outcome_unknown" : "task_invalid_response",
    `Task provider returned an invalid sanitized ${projection} projection.`,
    { cause: parsed.error },
  );
}

function wireActor(value: TaskActor): Record<string, unknown> {
  return { id: value.id, label: value.label, kind: value.kind };
}

function wireMutation(value: TaskMutationContext): Record<string, unknown> {
  return {
    owner: value.owner,
    actor: wireActor(value.actor),
    ...(value.executionId === undefined ? {} : { execution_id: value.executionId }),
    ...(value.claimExecutionId === undefined ? {} : { claim_execution_id: value.claimExecutionId }),
    idempotency_key: value.idempotencyKey,
    ...(value.expectedRevision === undefined ? {} : { expected_revision: value.expectedRevision }),
  };
}

function ref(value: TaskRef): { id: string } {
  return { id: value.id };
}

function pageArgs(input: { cursor?: string; limit?: number }): Record<string, unknown> {
  return {
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    limit: input.limit ?? TASK_LIMITS.pageDefault,
  };
}

interface CallOptions<Result> {
  tool: string;
  args: Record<string, unknown>;
  schema: z.ZodType<Result>;
  mutation?: boolean;
  signal?: AbortSignal;
  expectedProviderInstanceId?: string;
  observeProviderInstanceId?: (providerInstanceId: string) => void;
}

function providerErrorMessage(value: string | undefined, fallback: string): string {
  const sanitized = sanitizeTaskText(value ?? fallback).trim();
  if (sanitized.length === 0) return fallback;
  return sanitized.slice(0, TASK_LIMITS.reason);
}

/** Single strict parser/error mapper shared by probing and normal provider calls. */
async function callMcpTaskTool<Result>(
  context: McpCallContext,
  input: CallOptions<Result>,
): Promise<Result> {
  const startedAt = Date.now();
  const clarvisContext = {
    owner: context.owner,
    ...(input.expectedProviderInstanceId === undefined
      ? {}
      : { provider_instance_id: input.expectedProviderInstanceId }),
  };
  let response;
  try {
    response = await context.port.callTool(
      input.tool,
      { clarvis_context: clarvisContext, ...input.args },
      input.signal,
    );
  } catch (error) {
    reportCall(context, input.tool, startedAt, { ok: false, code: "transport_error" });
    throw error;
  }
  if (response.isError) {
    const code =
      response.failure?.outcome === "unknown" && input.mutation === true
        ? "task_outcome_unknown"
        : response.failure?.kind === "cancelled"
          ? "task_cancelled"
          : "task_provider_unavailable";
    reportCall(context, input.tool, startedAt, { ok: false, code });
    throw new TaskProviderError(
      code,
      providerErrorMessage(response.message, `Task provider tool '${input.tool}' failed`),
    );
  }
  const parsed = wireEnvelopeSchema(input.schema).safeParse(response.data);
  if (!parsed.success) {
    const code = input.mutation === true ? "task_outcome_unknown" : "task_invalid_response";
    reportCall(context, input.tool, startedAt, { ok: false, code });
    context.logger.warn(
      {
        event: "tasks.provider.invalid_response",
        tool: input.tool,
        zod_issues: issuePaths(parsed.error),
        ...(input.mutation === true ? { outcome: "unknown" } : {}),
      },
      input.mutation === true
        ? "the task provider's answer to a write did not project, so whether the write applied is unknown; re-read the task"
        : "the task provider's answer did not project and the call fails closed; no partial task is used",
    );
    throw new TaskProviderError(
      code,
      `Task provider returned an invalid response for '${input.tool}'`,
      {
        cause: parsed.error,
      },
    );
  }
  const envelope = parsed.data as
    | { protocol_version: 2; provider_instance_id: string; ok: true; result: Result }
    | {
        protocol_version: 2;
        provider_instance_id: string;
        ok: false;
        error: {
          code: ConstructorParameters<typeof TaskProviderError>[0];
          message: string;
          current_revision?: string;
        };
      };
  input.observeProviderInstanceId?.(envelope.provider_instance_id);
  if (
    input.expectedProviderInstanceId !== undefined &&
    envelope.provider_instance_id !== input.expectedProviderInstanceId
  ) {
    reportCall(context, input.tool, startedAt, {
      ok: false,
      code: input.mutation === true ? "task_outcome_unknown" : "task_provider_mismatch",
      providerInstanceId: envelope.provider_instance_id,
    });
    throw new TaskProviderError(
      input.mutation === true ? "task_outcome_unknown" : "task_provider_mismatch",
      "Task provider instance changed after this binding was selected.",
    );
  }
  if (!envelope.ok) {
    reportCall(context, input.tool, startedAt, {
      ok: false,
      code: envelope.error.code,
      providerInstanceId: envelope.provider_instance_id,
    });
    throw new TaskProviderError(
      envelope.error.code,
      providerErrorMessage(envelope.error.message, "Task provider rejected the operation"),
      {
        ...(envelope.error.current_revision === undefined
          ? {}
          : { currentRevision: envelope.error.current_revision }),
      },
    );
  }
  reportCall(context, input.tool, startedAt, {
    ok: true,
    providerInstanceId: envelope.provider_instance_id,
  });
  return envelope.result;
}

/**
 * Probe the canonical server without constructing a provider.
 *
 * @param options - owner, port and the optional `tasks` component logger.
 * @param signal - aborts the handshake.
 * @returns the advertised {@link TaskProviderCapabilities}.
 */
export async function probeMcpTaskCapabilities(
  options: Pick<McpTaskProviderOptions, "owner" | "port" | "logger">,
  signal?: AbortSignal,
): Promise<TaskProviderCapabilities> {
  return probeWith(callContext(options), signal);
}

/** The probe, over an already-resolved call context. */
async function probeWith(
  context: McpCallContext,
  signal?: AbortSignal,
): Promise<TaskProviderCapabilities> {
  let envelopeInstanceId: string | undefined;
  const wire = await callMcpTaskTool(context, {
    tool: TASK_MCP_TOOLS.capabilities,
    args: {},
    schema: wireTaskProviderCapabilitiesSchema,
    observeProviderInstanceId: (providerInstanceId) => {
      envelopeInstanceId = providerInstanceId;
    },
    ...(signal === undefined ? {} : { signal }),
  });
  if (envelopeInstanceId !== wire.provider_instance_id) {
    throw new TaskProviderError(
      "task_invalid_response",
      "Task provider capability identity does not match its response envelope.",
    );
  }
  return {
    protocolVersion: wire.protocol_version,
    providerInstanceId: wire.provider_instance_id,
    providerKind: wire.provider_kind,
    read: wire.read,
    write: {
      create: wire.write.create,
      assign: wire.write.assign,
      comment: wire.write.comment,
      attachArtifact: wire.write.attach_artifact,
      intents: [...wire.write.intents],
    },
    concurrency: wire.concurrency,
  };
}

/** Build a provider whose optional methods exactly match the advertised capabilities. */
export async function createMcpTaskProvider(
  options: McpTaskProviderOptions,
): Promise<TaskProvider> {
  const context = callContext(options);
  const advertised = options.capabilities ?? (await probeWith(context));

  const call = <Result>(input: CallOptions<Result>): Promise<Result> =>
    callMcpTaskTool(context, {
      ...input,
      expectedProviderInstanceId: advertised.providerInstanceId,
    });

  const assertRef = (taskRef: TaskRef): void => {
    if (taskRef.providerKey !== options.key) {
      throw new TaskProviderError(
        "task_provider_mismatch",
        `Task belongs to provider '${taskRef.providerKey}', not '${options.key}'`,
      );
    }
  };

  const checkedDocument = (
    value: WireDocument,
    expectedId: string | undefined,
    mutation: boolean,
  ): TaskDocument => {
    if (expectedId !== undefined && value.ref.id !== expectedId) {
      throw new TaskProviderError(
        mutation ? "task_outcome_unknown" : "task_invalid_response",
        `Task provider returned '${value.ref.id}' while operating on '${expectedId}'.`,
      );
    }
    return validatedProjection(taskDocumentSchema, document(value, options.key), mutation, "task");
  };

  const get = async (taskRef: TaskRef, signal?: AbortSignal): Promise<TaskDocument> => {
    assertRef(taskRef);
    const wire = await call({
      tool: TASK_MCP_TOOLS.get,
      args: { ref: ref(taskRef) },
      schema: wireTaskDocumentSchema,
      ...(signal === undefined ? {} : { signal }),
    });
    return checkedDocument(wire, taskRef.id, false);
  };

  const provider: TaskProvider = {
    kind: advertised.providerKind,
    key: options.key,
    capabilities: () => Promise.resolve(advertised),
    async listContainers(
      input: ListTaskContainersInput,
      signal?: AbortSignal,
    ): Promise<TaskContainerPage> {
      const wire = await call({
        tool: TASK_MCP_TOOLS.listContainers,
        args: {
          ...(input.query === undefined ? {} : { query: input.query }),
          ...pageArgs(input),
        },
        schema: wireTaskContainerPageSchema,
        ...(signal === undefined ? {} : { signal }),
      });
      return validatedProjection(
        taskContainerPageSchema,
        {
          items: wire.items.map((item) => ({
            ...item,
            label: sanitizeTaskText(item.label),
          })),
          ...(wire.next_cursor === undefined ? {} : { nextCursor: wire.next_cursor }),
        },
        false,
        "container page",
      );
    },
    async search(input: SearchTasksInput, signal?: AbortSignal): Promise<TaskPage> {
      const wire = await call({
        tool: TASK_MCP_TOOLS.search,
        args: {
          ...(input.containerId === undefined ? {} : { container_id: input.containerId }),
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.stages === undefined ? {} : { stages: input.stages }),
          ...(input.assigneeId === undefined ? {} : { assignee_id: input.assigneeId }),
          ...(input.labels === undefined ? {} : { labels: input.labels }),
          ...(input.claim === undefined ? {} : { claim: input.claim }),
          ...(input.updatedAfter === undefined ? {} : { updated_after: input.updatedAfter }),
          ...pageArgs(input),
        },
        schema: wireTaskPageSchema,
        ...(signal === undefined ? {} : { signal }),
      });
      return validatedProjection(
        taskPageSchema,
        {
          items: wire.items.map((item) => summary(item, options.key)),
          ...(wire.next_cursor === undefined ? {} : { nextCursor: wire.next_cursor }),
        },
        false,
        "task page",
      );
    },
    get,
    ...(advertised.read.actors
      ? {
          async searchActors(
            input: SearchTaskActorsInput,
            signal?: AbortSignal,
          ): Promise<TaskActorPage> {
            const wire = await call({
              tool: TASK_MCP_TOOLS.searchActors,
              args: {
                ...(input.containerId === undefined ? {} : { container_id: input.containerId }),
                ...(input.query === undefined ? {} : { query: input.query }),
                ...pageArgs(input),
              },
              schema: wireTaskActorPageSchema,
              ...(signal === undefined ? {} : { signal }),
            });
            return validatedProjection(
              taskActorPageSchema,
              {
                items: wire.items.map(actor),
                ...(wire.next_cursor === undefined ? {} : { nextCursor: wire.next_cursor }),
              },
              false,
              "actor page",
            );
          },
        }
      : {}),
    ...(advertised.write.create
      ? {
          async create(input: CreateTaskInput, signal?: AbortSignal): Promise<TaskDocument> {
            const wire = await call({
              tool: TASK_MCP_TOOLS.create,
              args: {
                container_id: input.containerId,
                title: input.title,
                ...(input.description === undefined ? {} : { description: input.description }),
                ...(input.acceptanceCriteria === undefined
                  ? {}
                  : { acceptance_criteria: input.acceptanceCriteria }),
                ...(input.priority === undefined ? {} : { priority: input.priority }),
                ...(input.assigneeId === undefined ? {} : { assignee_id: input.assigneeId }),
                ...(input.labels === undefined ? {} : { labels: input.labels }),
                mutation: wireMutation(input.mutation),
              },
              schema: wireTaskDocumentSchema,
              mutation: true,
              ...(signal === undefined ? {} : { signal }),
            });
            return checkedDocument(wire, undefined, true);
          },
        }
      : {}),
    ...(advertised.write.assign
      ? {
          async assign(input: AssignTaskInput, signal?: AbortSignal): Promise<TaskDocument> {
            assertRef(input.ref);
            const wire = await call({
              tool: TASK_MCP_TOOLS.assign,
              args: {
                ref: ref(input.ref),
                assignee_id: input.assigneeId,
                mutation: wireMutation(input.mutation),
              },
              schema: wireTaskDocumentSchema,
              mutation: true,
              ...(signal === undefined ? {} : { signal }),
            });
            return checkedDocument(wire, input.ref.id, true);
          },
        }
      : {}),
    ...(advertised.write.intents.length > 0
      ? {
          async transition(
            input: TransitionTaskInput,
            signal?: AbortSignal,
          ): Promise<TaskDocument> {
            assertRef(input.ref);
            const wire = await call({
              tool: TASK_MCP_TOOLS.transition,
              args: {
                ref: ref(input.ref),
                intent: input.intent,
                ...(input.claimant === undefined ? {} : { claimant: wireActor(input.claimant) }),
                ...(input.reason === undefined ? {} : { reason: input.reason }),
                mutation: wireMutation(input.mutation),
              },
              schema: wireTaskDocumentSchema,
              mutation: true,
              ...(signal === undefined ? {} : { signal }),
            });
            return checkedDocument(wire, input.ref.id, true);
          },
        }
      : {}),
    ...(advertised.write.comment
      ? {
          async comment(input: CommentTaskInput, signal?: AbortSignal): Promise<TaskDocument> {
            assertRef(input.ref);
            const wire = await call({
              tool: TASK_MCP_TOOLS.comment,
              args: {
                ref: ref(input.ref),
                body: input.body,
                mutation: wireMutation(input.mutation),
              },
              schema: wireTaskDocumentSchema,
              mutation: true,
              ...(signal === undefined ? {} : { signal }),
            });
            return checkedDocument(wire, input.ref.id, true);
          },
        }
      : {}),
    ...(advertised.write.attachArtifact
      ? {
          async attachArtifact(
            input: AttachTaskArtifactInput,
            signal?: AbortSignal,
          ): Promise<TaskDocument> {
            assertRef(input.ref);
            const wire = await call({
              tool: TASK_MCP_TOOLS.attachArtifact,
              args: {
                ref: ref(input.ref),
                artifact: {
                  kind: input.artifact.kind,
                  label: input.artifact.label,
                  ...(input.artifact.url === undefined ? {} : { url: input.artifact.url }),
                  ...(input.artifact.executionId === undefined
                    ? {}
                    : { execution_id: input.artifact.executionId }),
                },
                mutation: wireMutation(input.mutation),
              },
              schema: wireTaskDocumentSchema,
              mutation: true,
              ...(signal === undefined ? {} : { signal }),
            });
            return checkedDocument(wire, input.ref.id, true);
          },
        }
      : {}),
  };
  return provider;
}
