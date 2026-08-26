import { createHash, randomUUID } from "node:crypto";
import { sanitizeErrorMessage } from "@clarvis/capability";
import {
  TASK_LIMITS,
  TaskProviderError,
  assignTaskInputSchema,
  attachTaskArtifactInputSchema,
  commentTaskInputSchema,
  createTaskInputSchema,
  listTaskContainersInputSchema,
  searchTaskActorsInputSchema,
  searchTasksInputSchema,
  taskIdentifierSchema,
  taskRefSchema,
  transitionTaskInputSchema,
  type TaskActor,
  type TaskDocument,
  type TaskMutationContext,
  type TaskProviderResolution,
  type TaskRef,
} from "@clarvis/tasks";
import type {
  TaskCallOptions,
  TaskProviderStatusDto,
  TasksService,
  TransitionTaskDto,
} from "@clarvis/protocol";
import { z } from "zod";
import { KernelException, kernelError } from "../core/errors.ts";
import {
  taskActorPageDto,
  taskCapabilitiesDto,
  taskContainerPageDto,
  taskDocumentDto,
  taskPageDto,
  taskRefFromDto,
} from "./map-task-dtos.ts";
import type { TaskProviderFactory } from "./task-provider-factory.ts";

const PREVIEW_TTL_MS = 5 * 60_000;
const PREVIEW_MAX = 256;
const COMPLETED_MUTATION_TTL_MS = 24 * 60 * 60_000;
const MUTATION_RECORD_MAX = 1_024;

const dtoId = z.string().trim().min(1).max(TASK_LIMITS.id);
const dtoRequestId = z.string().trim().min(1).max(512);
const dtoCursor = z.string().min(1).max(TASK_LIMITS.cursor);
const dtoQuery = z.string().max(TASK_LIMITS.query);
const dtoPage = {
  cursor: dtoCursor.optional(),
  limit: z.number().int().min(1).max(TASK_LIMITS.pageMax).optional(),
};
const dtoRef = z.object({ provider_key: dtoId, id: dtoId }).strict();
const dtoStages = z
  .array(z.enum(["backlog", "ready", "active", "blocked", "review", "done", "cancelled", "other"]))
  .max(8);
const dtoListContainers = z.object({ query: dtoQuery.optional(), ...dtoPage }).strict();
const dtoSearch = z
  .object({
    container_id: dtoId.optional(),
    query: dtoQuery.optional(),
    stages: dtoStages.optional(),
    assignee_id: dtoId.optional(),
    labels: z
      .array(z.string().trim().min(1).max(TASK_LIMITS.label))
      .max(TASK_LIMITS.labels)
      .optional(),
    claim: z.enum(["any", "free", "claimed"]).optional(),
    updated_after: z.string().datetime({ offset: true }).optional(),
    ...dtoPage,
  })
  .strict();
const dtoSearchActors = z
  .object({ container_id: dtoId.optional(), query: dtoQuery.optional(), ...dtoPage })
  .strict();
const dtoCreate = z
  .object({
    request_id: dtoRequestId,
    provider_key: taskIdentifierSchema,
    container_id: dtoId,
    title: z.string().trim().min(1).max(TASK_LIMITS.title),
    description: z.string().max(TASK_LIMITS.description).optional(),
    acceptance_criteria: z
      .array(z.string().max(TASK_LIMITS.criterion))
      .max(TASK_LIMITS.criteria)
      .optional(),
    priority: z.string().trim().min(1).max(TASK_LIMITS.label).optional(),
    assignee_id: dtoId.optional(),
    labels: z
      .array(z.string().trim().min(1).max(TASK_LIMITS.label))
      .max(TASK_LIMITS.labels)
      .optional(),
  })
  .strict();
const dtoAssign = z
  .object({
    request_id: dtoRequestId,
    ref: dtoRef,
    assignee_id: dtoId.nullable(),
    expected_revision: dtoId.optional(),
  })
  .strict();
const dtoTransition = z
  .object({
    request_id: dtoRequestId,
    ref: dtoRef,
    intent: z.enum(["block", "submit_review", "complete", "reopen"]),
    reason: z.string().max(TASK_LIMITS.reason).optional(),
    expected_revision: dtoId.optional(),
    confirmation_token: dtoId.optional(),
  })
  .strict();
const dtoPreviewTransition = z
  .object({
    ref: dtoRef,
    intent: z.enum(["complete", "reopen"]),
    expected_revision: dtoId.optional(),
  })
  .strict();
const dtoComment = z
  .object({
    request_id: dtoRequestId,
    ref: dtoRef,
    body: z.string().trim().min(1).max(TASK_LIMITS.comment),
    expected_revision: dtoId.optional(),
  })
  .strict();
const dtoArtifact = z
  .object({
    kind: z.enum(["pull_request", "run", "document", "url"]),
    label: z.string().trim().min(1).max(TASK_LIMITS.artifactLabel),
    url: z
      .string()
      .max(TASK_LIMITS.url)
      .url()
      .refine((value) => value.startsWith("http://") || value.startsWith("https://"))
      .optional(),
    execution_id: dtoId.optional(),
  })
  .strict();
const dtoAttachArtifact = z
  .object({
    request_id: dtoRequestId,
    ref: dtoRef,
    artifact: dtoArtifact,
    expected_revision: dtoId.optional(),
  })
  .strict();

function validateDto(schema: z.ZodType, value: unknown): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw kernelError(
      "invalid_request",
      parsed.error.issues[0]?.message ?? "Invalid Tasks request.",
      parsed.error.issues,
    );
  }
}

interface PreviewRecord {
  providerKey: string;
  taskId: string;
  intent: "complete" | "reopen";
  revision?: string;
  expiresAt: number;
  boundRequestId?: string;
}

interface MutationRecord {
  providerKey: string;
  fingerprint: string;
  providerInput?: unknown;
  result?: TaskDocument;
  error?: Error;
  pending?: Promise<TaskDocument>;
  controller?: AbortController;
  waiters: number;
  dispatched: boolean;
  /** A caller has already observed that this exact prepared write may have committed. */
  outcomeUnknown: boolean;
  completedAt?: number;
  lastUsedAt: number;
}

export interface TaskServiceOptions {
  factory?: TaskProviderFactory;
  owner: string;
  enabled: boolean;
  /** Test seam for deterministic retention behavior. */
  now?: () => number;
}

function signalOf(options?: TaskCallOptions): AbortSignal | undefined {
  return options?.signal as AbortSignal | undefined;
}

function idempotencyKey(
  providerKey: string,
  owner: string,
  requestId: string,
  operation: string,
): string {
  return `tasks:control:${createHash("sha256")
    .update([providerKey, owner, requestId, operation].join("\u0000"))
    .digest("hex")}`;
}

function mutationRecordKey(owner: string, requestId: string, operation: string): string {
  return createHash("sha256").update([owner, requestId, operation].join("\u0000")).digest("hex");
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

function requestFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function mapTaskError(error: unknown): Error {
  if (error instanceof KernelException) return error;
  if (!(error instanceof TaskProviderError)) {
    return kernelError(
      "unavailable",
      sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    );
  }
  const code =
    error.code === "task_not_found"
      ? "not_found"
      : error.code === "task_forbidden"
        ? "unauthorized"
        : error.code === "task_unsupported"
          ? "unsupported"
          : error.code === "task_invalid_input" || error.code === "task_invalid_transition"
            ? "invalid_request"
            : error.code === "task_conflict" ||
                error.code === "task_already_claimed" ||
                error.code === "task_provider_mismatch"
              ? "conflict"
              : error.code === "task_not_configured" || error.code === "task_writes_disabled"
                ? "capability_disabled"
                : error.code === "task_cancelled"
                  ? "cancelled"
                  : "unavailable";
  return kernelError(code, sanitizeErrorMessage(error.message), {
    task_code: error.code,
    ...(error.currentRevision === undefined ? {} : { current_revision: error.currentRevision }),
    ...(error.currentTask === undefined
      ? {}
      : { current_task: taskDocumentDto(error.currentTask) }),
    ...(error.code === "task_outcome_unknown" ? { outcome_unknown: true } : {}),
  });
}

/** Provider-neutral human control plane over the same factory a run capability uses. */
export function createTasksService(options: TaskServiceOptions): TasksService {
  const previews = new Map<string, PreviewRecord>();
  const mutationRecords = new Map<string, MutationRecord>();
  const actor: TaskActor = { id: options.owner, label: options.owner, kind: "human" };
  const now = (): number => options.now?.() ?? Date.now();

  const sweepPreviews = (): void => {
    const current = now();
    for (const [token, preview] of previews) {
      if (preview.expiresAt <= current) previews.delete(token);
    }
    while (previews.size > PREVIEW_MAX) {
      let oldestToken: string | undefined;
      let oldestExpiry = Number.POSITIVE_INFINITY;
      for (const [token, preview] of previews) {
        if (preview.expiresAt < oldestExpiry) {
          oldestExpiry = preview.expiresAt;
          oldestToken = token;
        }
      }
      if (oldestToken === undefined) break;
      previews.delete(oldestToken);
    }
  };

  const sweepMutations = (): void => {
    const current = now();
    const completed: Array<[string, MutationRecord]> = [];
    for (const [key, record] of mutationRecords) {
      if (
        (record.result !== undefined || record.error !== undefined) &&
        record.completedAt !== undefined &&
        record.completedAt + COMPLETED_MUTATION_TTL_MS <= current
      ) {
        mutationRecords.delete(key);
      } else if (record.result !== undefined || record.error !== undefined) {
        completed.push([key, record]);
      }
    }
    completed.sort((left, right) => right[1].lastUsedAt - left[1].lastUsedAt);
    for (const [key] of completed.slice(MUTATION_RECORD_MAX)) mutationRecords.delete(key);
  };

  /**
   * Reserve bounded replay state without evicting an unresolved write.
   *
   * @remarks Unresolved state owns the only exact provider input safe for an
   * explicit retry. Completed records may instead be discarded least-recently
   * used because durable idempotency remains the provider's responsibility.
   */
  const reserveMutationRecord = (): void => {
    if (mutationRecords.size < MUTATION_RECORD_MAX) return;
    let oldestCompleted: [string, MutationRecord] | undefined;
    for (const entry of mutationRecords) {
      if (entry[1].result === undefined && entry[1].error === undefined) continue;
      if (oldestCompleted === undefined || entry[1].lastUsedAt < oldestCompleted[1].lastUsedAt) {
        oldestCompleted = entry;
      }
    }
    if (oldestCompleted !== undefined) {
      mutationRecords.delete(oldestCompleted[0]);
      return;
    }

    throw new TaskProviderError(
      "task_provider_unavailable",
      "Too many unresolved task mutations are awaiting a stable retry.",
    );
  };

  const resolve = async (
    signal?: AbortSignal,
    expectedProviderKey?: string,
  ): Promise<TaskProviderResolution> => {
    if (!options.enabled || options.factory === undefined) {
      throw kernelError("capability_disabled", "Tasks are disabled in this host.");
    }
    try {
      return await options.factory.resolve(options.owner, expectedProviderKey, signal);
    } catch (error) {
      throw mapTaskError(error);
    }
  };

  const checkedRef = (resolution: TaskProviderResolution, ref: TaskRef): void => {
    if (ref.providerKey !== resolution.provider.key) {
      throw new TaskProviderError(
        "task_provider_mismatch",
        `Task belongs to provider '${ref.providerKey}', not '${resolution.provider.key}'.`,
      );
    }
  };

  const writable = (resolution: TaskProviderResolution): void => {
    if (resolution.writes !== "enabled") {
      throw new TaskProviderError("task_writes_disabled", "Task writes are disabled by settings.");
    }
  };

  const mutation = (
    resolution: TaskProviderResolution,
    requestId: string,
    operation: string,
    expectedRevision?: string,
  ): TaskMutationContext => ({
    owner: options.owner,
    actor,
    idempotencyKey: idempotencyKey(resolution.provider.key, options.owner, requestId, operation),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });

  const currentRevision = async (
    resolution: TaskProviderResolution,
    ref: TaskRef,
    supplied: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> => {
    if (supplied !== undefined || resolution.capabilities.concurrency === "none") return supplied;
    return (await resolution.provider.get(ref, signal)).revision;
  };

  const invoke = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      throw mapTaskError(error);
    }
  };

  /**
   * Execute one provider mutation and reconcile conflicts or unknown outcomes.
   *
   * @remarks Reconciliation deliberately omits the caller's potentially
   * aborted write signal. The provider boundary retains its own timeout, so the
   * independent read remains bounded while preserving the original outcome if
   * it also fails.
   */
  const mutate = async (
    resolution: TaskProviderResolution,
    ref: TaskRef | undefined,
    action: () => Promise<TaskDocument>,
  ): Promise<TaskDocument> => {
    try {
      return await action();
    } catch (error) {
      if (
        ref !== undefined &&
        error instanceof TaskProviderError &&
        (error.code === "task_conflict" || error.code === "task_outcome_unknown")
      ) {
        let current: TaskDocument | undefined;
        try {
          current = await resolution.provider.get(ref);
        } catch {
          /* Preserve the original write outcome if reconciliation also fails. */
        }
        throw new TaskProviderError(error.code, error.message, {
          ...(error.currentRevision === undefined
            ? current?.revision === undefined
              ? {}
              : { currentRevision: current.revision }
            : { currentRevision: error.currentRevision }),
          ...(current === undefined ? {} : { currentTask: current }),
          cause: error,
        });
      }
      throw error;
    }
  };

  /**
   * Run one idempotent mutation shared by equal concurrent request ids.
   *
   * @remarks Pre-dispatch failures release their slot. Proven domain outcomes
   * are cached; unavailable/cancelled calls may prepare again only before any
   * unknown outcome; uncertain writes retain their exact provider input. Caller
   * cancellation detaches one waiter and aborts shared work only after the final
   * waiter leaves.
   */
  const runMutation = async <ProviderInput>(input: {
    resolution: TaskProviderResolution;
    requestId: string;
    operation: string;
    fingerprint: string;
    ref?: TaskRef;
    signal?: AbortSignal;
    prepare: (signal: AbortSignal) => Promise<ProviderInput> | ProviderInput;
    perform: (providerInput: ProviderInput, signal: AbortSignal) => Promise<TaskDocument>;
    onSuccess?: () => void;
  }): Promise<TaskDocument> => {
    if (input.signal?.aborted) {
      throw kernelError("cancelled", "Task mutation request was cancelled.");
    }
    sweepMutations();
    const key = mutationRecordKey(options.owner, input.requestId, input.operation);
    let record = mutationRecords.get(key);
    if (record === undefined) {
      reserveMutationRecord();
      record = {
        providerKey: input.resolution.provider.key,
        fingerprint: input.fingerprint,
        waiters: 0,
        dispatched: false,
        outcomeUnknown: false,
        lastUsedAt: now(),
      };
      mutationRecords.set(key, record);
    } else if (record.providerKey !== input.resolution.provider.key) {
      throw new TaskProviderError(
        "task_provider_mismatch",
        "The request ID is bound to a different task provider selection.",
      );
    } else if (record.fingerprint !== input.fingerprint) {
      throw new TaskProviderError(
        "task_invalid_input",
        "The request ID was already used with different task mutation input.",
      );
    }
    record.lastUsedAt = now();
    if (record.result !== undefined) return record.result;
    if (record.error !== undefined) throw record.error;

    const currentRecord = record;
    if (currentRecord.pending === undefined) {
      const controller = new AbortController();
      currentRecord.controller = controller;
      const work = (async (): Promise<TaskDocument> => {
        let providerInput = currentRecord.providerInput as ProviderInput | undefined;
        try {
          if (providerInput === undefined) {
            providerInput = await input.prepare(controller.signal);
            currentRecord.providerInput = providerInput;
          }
          if (controller.signal.aborted) {
            throw new TaskProviderError(
              "task_cancelled",
              "Task mutation was cancelled before dispatch.",
            );
          }
          currentRecord.dispatched = true;
          const result = await mutate(input.resolution, input.ref, () =>
            input.perform(providerInput as ProviderInput, controller.signal),
          );
          currentRecord.result = result;
          currentRecord.completedAt = now();
          currentRecord.lastUsedAt = currentRecord.completedAt;
          input.onSuccess?.();
          return result;
        } catch (error) {
          if (providerInput === undefined) {
            if (mutationRecords.get(key) === currentRecord) mutationRecords.delete(key);
          } else if (error instanceof TaskProviderError && error.code === "task_outcome_unknown") {
            currentRecord.outcomeUnknown = true;
          } else if (
            error instanceof TaskProviderError &&
            error.code !== "task_provider_unavailable" &&
            error.code !== "task_cancelled"
          ) {
            currentRecord.error = error;
            currentRecord.completedAt = now();
            currentRecord.lastUsedAt = currentRecord.completedAt;
          } else if (
            error instanceof TaskProviderError &&
            (error.code === "task_provider_unavailable" || error.code === "task_cancelled")
          ) {
            if (!currentRecord.outcomeUnknown && mutationRecords.get(key) === currentRecord) {
              mutationRecords.delete(key);
            }
          }
          throw error;
        }
      })();
      const pending = work.then(
        (value) => {
          if (currentRecord.pending === pending) {
            delete currentRecord.pending;
            delete currentRecord.controller;
          }
          return value;
        },
        (error: unknown) => {
          if (currentRecord.pending === pending) {
            delete currentRecord.pending;
            delete currentRecord.controller;
          }
          throw error;
        },
      );
      currentRecord.pending = pending;
      void pending.catch(() => undefined);
    }

    const pending = currentRecord.pending;
    currentRecord.waiters += 1;
    return await new Promise<TaskDocument>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        input.signal?.removeEventListener("abort", onAbort);
        currentRecord.waiters -= 1;
        action();
      };
      const onAbort = (): void => {
        finish(() => {
          if (currentRecord.dispatched) currentRecord.outcomeUnknown = true;
          if (currentRecord.waiters === 0 && currentRecord.pending === pending) {
            currentRecord.controller?.abort();
          }
          reject(
            kernelError("cancelled", "Task mutation request was cancelled.", {
              ...(currentRecord.dispatched ? { outcome_unknown: true } : {}),
            }),
          );
        });
      };
      if (input.signal?.aborted) {
        onAbort();
        return;
      }
      input.signal?.addEventListener("abort", onAbort, { once: true });
      void pending.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(mapTaskError(error))),
      );
    });
  };

  const status = async (optionsArg?: TaskCallOptions): Promise<TaskProviderStatusDto> => {
    if (!options.enabled || options.factory === undefined) {
      return {
        state: "not_configured",
        writes: "disabled",
        reason: "Tasks are disabled in this host.",
      };
    }
    const value = await options.factory.status(options.owner, signalOf(optionsArg));
    return {
      state: value.state,
      writes: value.writes,
      ...(value.providerKey === undefined ? {} : { provider_key: value.providerKey }),
      ...(value.providerKind === undefined ? {} : { provider_kind: value.providerKind }),
      ...(value.server === undefined ? {} : { server: value.server }),
      ...(value.reason === undefined ? {} : { reason: value.reason }),
    };
  };

  return {
    status,
    async capabilities(optionsArg) {
      const resolution = await resolve(signalOf(optionsArg));
      return taskCapabilitiesDto(resolution.capabilities);
    },
    async listContainers(input, optionsArg) {
      validateDto(dtoListContainers, input);
      const resolution = await resolve(signalOf(optionsArg));
      const providerInput = listTaskContainersInputSchema.parse(input);
      return invoke(async () =>
        taskContainerPageDto(
          await resolution.provider.listContainers(providerInput, signalOf(optionsArg)),
        ),
      );
    },
    async search(input, optionsArg) {
      validateDto(dtoSearch, input);
      const resolution = await resolve(signalOf(optionsArg));
      const providerInput = searchTasksInputSchema.parse({
        ...(input.container_id === undefined ? {} : { containerId: input.container_id }),
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.stages === undefined ? {} : { stages: input.stages }),
        ...(input.assignee_id === undefined ? {} : { assigneeId: input.assignee_id }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        ...(input.claim === undefined ? {} : { claim: input.claim }),
        ...(input.updated_after === undefined ? {} : { updatedAfter: input.updated_after }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return invoke(async () =>
        taskPageDto(await resolution.provider.search(providerInput, signalOf(optionsArg))),
      );
    },
    async get(refDto, optionsArg) {
      validateDto(dtoRef, refDto);
      const resolution = await resolve(signalOf(optionsArg));
      const ref = taskRefSchema.parse(taskRefFromDto(refDto));
      return invoke(async () => {
        checkedRef(resolution, ref);
        return taskDocumentDto(await resolution.provider.get(ref, signalOf(optionsArg)));
      });
    },
    async searchActors(input, optionsArg) {
      validateDto(dtoSearchActors, input);
      const resolution = await resolve(signalOf(optionsArg));
      const providerInput = searchTaskActorsInputSchema.parse({
        ...(input.container_id === undefined ? {} : { containerId: input.container_id }),
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return invoke(async () => {
        if (resolution.provider.searchActors === undefined) {
          throw new TaskProviderError("task_unsupported", "Actor search is unsupported.");
        }
        return taskActorPageDto(
          await resolution.provider.searchActors(providerInput, signalOf(optionsArg)),
        );
      });
    },
    async create(input, optionsArg) {
      validateDto(dtoCreate, input);
      const signal = signalOf(optionsArg);
      const resolution = await resolve(signal, input.provider_key);
      return invoke(async () => {
        writable(resolution);
        if (resolution.provider.create === undefined) {
          throw new TaskProviderError("task_unsupported", "Task creation is unsupported.");
        }
        const document = await runMutation({
          resolution,
          requestId: input.request_id,
          operation: "create",
          fingerprint: requestFingerprint(input),
          ...(signal === undefined ? {} : { signal }),
          prepare: () =>
            createTaskInputSchema.parse({
              containerId: input.container_id,
              title: input.title,
              ...(input.description === undefined ? {} : { description: input.description }),
              ...(input.acceptance_criteria === undefined
                ? {}
                : { acceptanceCriteria: input.acceptance_criteria }),
              ...(input.priority === undefined ? {} : { priority: input.priority }),
              ...(input.assignee_id === undefined ? {} : { assigneeId: input.assignee_id }),
              ...(input.labels === undefined ? {} : { labels: input.labels }),
              mutation: mutation(resolution, input.request_id, "create"),
            }),
          perform: (providerInput, operationSignal) =>
            resolution.provider.create!(providerInput, operationSignal),
        });
        return taskDocumentDto(document);
      });
    },
    async assign(input, optionsArg) {
      validateDto(dtoAssign, input);
      const signal = signalOf(optionsArg);
      const resolution = await resolve(signal);
      return invoke(async () => {
        writable(resolution);
        if (resolution.provider.assign === undefined) {
          throw new TaskProviderError("task_unsupported", "Task assignment is unsupported.");
        }
        const ref = taskRefSchema.parse(taskRefFromDto(input.ref));
        checkedRef(resolution, ref);
        return taskDocumentDto(
          await runMutation({
            resolution,
            ref,
            requestId: input.request_id,
            operation: "assign",
            fingerprint: requestFingerprint(input),
            ...(signal === undefined ? {} : { signal }),
            prepare: async (operationSignal) => {
              const expectedRevision = await currentRevision(
                resolution,
                ref,
                input.expected_revision,
                operationSignal,
              );
              return assignTaskInputSchema.parse({
                ref,
                assigneeId: input.assignee_id,
                mutation: mutation(resolution, input.request_id, "assign", expectedRevision),
              });
            },
            perform: (providerInput, operationSignal) =>
              resolution.provider.assign!(providerInput, operationSignal),
          }),
        );
      });
    },
    async previewTransition(input, optionsArg) {
      validateDto(dtoPreviewTransition, input);
      const signal = signalOf(optionsArg);
      const resolution = await resolve(signal);
      return invoke(async () => {
        writable(resolution);
        const ref = taskRefSchema.parse(taskRefFromDto(input.ref));
        checkedRef(resolution, ref);
        const task = await resolution.provider.get(ref, signal);
        if (!task.availableIntents.includes(input.intent)) {
          throw new TaskProviderError(
            "task_invalid_transition",
            `Intent '${input.intent}' is not currently available.`,
          );
        }
        if (input.expected_revision !== undefined && task.revision !== input.expected_revision) {
          throw new TaskProviderError("task_conflict", "Task revision changed.", {
            ...(task.revision === undefined ? {} : { currentRevision: task.revision }),
            currentTask: task,
          });
        }
        const token = randomUUID();
        sweepPreviews();
        const expiresAt = now() + PREVIEW_TTL_MS;
        previews.set(token, {
          providerKey: ref.providerKey,
          taskId: ref.id,
          intent: input.intent,
          ...(task.revision === undefined ? {} : { revision: task.revision }),
          expiresAt,
        });
        sweepPreviews();
        return {
          confirmation_token: token,
          expires_at: new Date(expiresAt).toISOString(),
          task: taskDocumentDto(task),
        };
      });
    },
    async transition(input, optionsArg) {
      validateDto(dtoTransition, input);
      const signal = signalOf(optionsArg);
      const resolution = await resolve(signal);
      return invoke(async () => {
        writable(resolution);
        if (resolution.provider.transition === undefined) {
          throw new TaskProviderError("task_unsupported", "Task transitions are unsupported.");
        }
        const ref = taskRefSchema.parse(taskRefFromDto(input.ref));
        checkedRef(resolution, ref);
        return taskDocumentDto(
          await runMutation({
            resolution,
            ref,
            requestId: input.request_id,
            operation: `transition:${input.intent}`,
            fingerprint: requestFingerprint(input),
            ...(signal === undefined ? {} : { signal }),
            prepare: async (operationSignal) => {
              const current = await resolution.provider.get(ref, operationSignal);
              if (!current.availableIntents.includes(input.intent)) {
                throw new TaskProviderError(
                  "task_invalid_transition",
                  `Intent '${input.intent}' is not currently available.`,
                );
              }
              if (input.intent === "complete" || input.intent === "reopen") {
                confirm(previews, input, current, now());
              }
              const expectedRevision = input.expected_revision ?? current.revision;
              return transitionTaskInputSchema.parse({
                ref,
                intent: input.intent,
                ...(input.reason === undefined ? {} : { reason: input.reason }),
                mutation: mutation(
                  resolution,
                  input.request_id,
                  `transition:${input.intent}`,
                  expectedRevision,
                ),
              });
            },
            perform: (providerInput, operationSignal) =>
              resolution.provider.transition!(providerInput, operationSignal),
            ...(input.intent === "complete" || input.intent === "reopen"
              ? {
                  onSuccess: () => {
                    if (input.confirmation_token !== undefined) {
                      previews.delete(input.confirmation_token);
                    }
                  },
                }
              : {}),
          }),
        );
      });
    },
    async comment(input, optionsArg) {
      validateDto(dtoComment, input);
      const signal = signalOf(optionsArg);
      const resolution = await resolve(signal);
      return invoke(async () => {
        writable(resolution);
        if (resolution.provider.comment === undefined) {
          throw new TaskProviderError("task_unsupported", "Task comments are unsupported.");
        }
        const ref = taskRefSchema.parse(taskRefFromDto(input.ref));
        checkedRef(resolution, ref);
        return taskDocumentDto(
          await runMutation({
            resolution,
            ref,
            requestId: input.request_id,
            operation: "comment",
            fingerprint: requestFingerprint(input),
            ...(signal === undefined ? {} : { signal }),
            prepare: async (operationSignal) => {
              const expectedRevision = await currentRevision(
                resolution,
                ref,
                input.expected_revision,
                operationSignal,
              );
              return commentTaskInputSchema.parse({
                ref,
                body: input.body,
                mutation: mutation(resolution, input.request_id, "comment", expectedRevision),
              });
            },
            perform: (providerInput, operationSignal) =>
              resolution.provider.comment!(providerInput, operationSignal),
          }),
        );
      });
    },
    async attachArtifact(input, optionsArg) {
      validateDto(dtoAttachArtifact, input);
      const signal = signalOf(optionsArg);
      const resolution = await resolve(signal);
      return invoke(async () => {
        writable(resolution);
        if (resolution.provider.attachArtifact === undefined) {
          throw new TaskProviderError("task_unsupported", "Task artifacts are unsupported.");
        }
        const ref = taskRefSchema.parse(taskRefFromDto(input.ref));
        checkedRef(resolution, ref);
        return taskDocumentDto(
          await runMutation({
            resolution,
            ref,
            requestId: input.request_id,
            operation: "attach_artifact",
            fingerprint: requestFingerprint(input),
            ...(signal === undefined ? {} : { signal }),
            prepare: async (operationSignal) => {
              const expectedRevision = await currentRevision(
                resolution,
                ref,
                input.expected_revision,
                operationSignal,
              );
              return attachTaskArtifactInputSchema.parse({
                ref,
                artifact: {
                  kind: input.artifact.kind,
                  label: input.artifact.label,
                  ...(input.artifact.url === undefined ? {} : { url: input.artifact.url }),
                  ...(input.artifact.execution_id === undefined
                    ? {}
                    : { executionId: input.artifact.execution_id }),
                },
                mutation: mutation(
                  resolution,
                  input.request_id,
                  "attach_artifact",
                  expectedRevision,
                ),
              });
            },
            perform: (providerInput, operationSignal) =>
              resolution.provider.attachArtifact!(providerInput, operationSignal),
          }),
        );
      });
    },
  };
}

function confirm(
  previews: Map<string, PreviewRecord>,
  input: TransitionTaskDto,
  current: TaskDocument,
  now: number,
): void {
  const token = input.confirmation_token;
  if (token === undefined) {
    throw new TaskProviderError(
      "task_invalid_input",
      `${input.intent} requires a confirmation token from previewTransition.`,
    );
  }
  const preview = previews.get(token);
  if (
    preview === undefined ||
    preview.expiresAt < now ||
    preview.providerKey !== current.ref.providerKey ||
    preview.taskId !== current.ref.id ||
    preview.intent !== input.intent ||
    preview.revision !== current.revision
  ) {
    throw new TaskProviderError(
      "task_conflict",
      "Task transition confirmation is missing, expired, or stale.",
      {
        ...(current.revision === undefined ? {} : { currentRevision: current.revision }),
        currentTask: current,
      },
    );
  }
  if (preview.boundRequestId !== undefined && preview.boundRequestId !== input.request_id) {
    throw new TaskProviderError(
      "task_conflict",
      "Task transition confirmation is already bound to another request.",
      {
        ...(current.revision === undefined ? {} : { currentRevision: current.revision }),
        currentTask: current,
      },
    );
  }
  preview.boundRequestId = input.request_id;
}
