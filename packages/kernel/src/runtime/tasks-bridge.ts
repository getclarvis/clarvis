import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
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
  type TaskProvider,
  type TaskProviderResolution,
  type TaskProviderResolver,
} from "@clarvis/tasks";
import type { RunRequest } from "@clarvis/capability";
import { taskCapabilityStateV2Schema } from "@clarvis/tasks/capability";
import type { HostCapabilityGrant } from "./authority-brokers.ts";
import type { GuestExecutionBridge } from "./execution-worker.ts";

export const RUNTIME_TASKS_METHOD = "runtime.tasks";
const REVISION = "v1";
const requestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("resolve"),
      expectedProviderKey: taskIdentifierSchema.optional(),
    })
    .strict(),
  z.object({ operation: z.literal("capabilities") }).strict(),
  z
    .object({ operation: z.literal("listContainers"), input: listTaskContainersInputSchema })
    .strict(),
  z.object({ operation: z.literal("search"), input: searchTasksInputSchema }).strict(),
  z.object({ operation: z.literal("get"), input: taskRefSchema }).strict(),
  z.object({ operation: z.literal("searchActors"), input: searchTaskActorsInputSchema }).strict(),
  z.object({ operation: z.literal("create"), input: createTaskInputSchema }).strict(),
  z.object({ operation: z.literal("assign"), input: assignTaskInputSchema }).strict(),
  z.object({ operation: z.literal("transition"), input: transitionTaskInputSchema }).strict(),
  z.object({ operation: z.literal("comment"), input: commentTaskInputSchema }).strict(),
  z
    .object({ operation: z.literal("attachArtifact"), input: attachTaskArtifactInputSchema })
    .strict(),
]);
type Request = z.infer<typeof requestSchema>;
type Descriptor = Omit<TaskProviderResolution, "provider"> & {
  provider: Pick<TaskProvider, "kind" | "key">;
};

/** Keep the admitted Tasks provider and credentials on the host, with canonical input validation. */
export function createHostTasksGrant(
  resolver: TaskProviderResolver,
  owner: string,
  runId: string,
  rawBody: unknown,
  priorState?: unknown,
): HostCapabilityGrant {
  const raw = rawBody as RunRequest & {
    task?: { id: string; mode?: string; provider_key?: string };
  };
  const grants = new Set(raw.profiles.flatMap((profile) => profile.grants ?? []));
  const prior =
    priorState === undefined ? undefined : taskCapabilityStateV2Schema.parse(priorState);
  const binding =
    prior !== undefined && "taskId" in prior
      ? { id: prior.taskId, mode: prior.mode, provider_key: prior.providerKey }
      : raw.task;
  const claimExecutionId =
    prior !== undefined && "claim" in prior ? (prior.claim?.executionId ?? runId) : runId;
  const retryContexts = [
    ...(prior?.pendingMutations?.map((pending) => pending.context) ?? []),
    ...(prior !== undefined && "pendingReviews" in prior
      ? (prior.pendingReviews?.flatMap((review) => review.contexts.map(({ context }) => context)) ??
        [])
      : []),
  ];
  const needsTasks =
    binding !== undefined ||
    prior !== undefined ||
    [...grants].some((grant) => grant.startsWith("tasks."));
  let resolution: Promise<TaskProviderResolution> | undefined;
  const resolve = (key?: string, signal?: AbortSignal): Promise<TaskProviderResolution> =>
    (resolution ??= resolver.resolve(
      owner,
      prior?.providerKey ?? binding?.provider_key ?? key,
      signal,
    ));
  return {
    method: RUNTIME_TASKS_METHOD,
    revision: REVISION,
    idempotent: false,
    validateArguments: (value) => requestSchema.safeParse(value).success,
    async invoke(value, signal) {
      const request = requestSchema.parse(value);
      try {
        if (!needsTasks)
          throw new TaskProviderError(
            "task_forbidden",
            "Tasks are outside this run's admitted capabilities.",
          );
        if (
          (request.operation === "search" || request.operation === "listContainers") &&
          !grants.has("tasks.read")
        ) {
          throw new TaskProviderError(
            "task_forbidden",
            "Tasks search is outside this run's admitted grants.",
          );
        }
        const selected = await resolve(
          request.operation === "resolve" ? request.expectedProviderKey : undefined,
          signal,
        );
        if (request.operation === "resolve") {
          if (
            request.expectedProviderKey !== undefined &&
            selected.provider.key !== request.expectedProviderKey
          ) {
            throw new TaskProviderError(
              "task_provider_mismatch",
              "Tasks provider differs from the admitted binding.",
            );
          }
          const descriptor: Descriptor = {
            capabilities: selected.capabilities,
            writes: selected.writes,
            server: selected.server,
            ...(selected.defaultContainer === undefined
              ? {}
              : { defaultContainer: selected.defaultContainer }),
            provider: { kind: selected.provider.kind, key: selected.provider.key },
          };
          return { ok: true, value: descriptor };
        }
        const provider = selected.provider;
        if (
          ("input" in request &&
            "ref" in request.input &&
            request.input.ref.providerKey !== provider.key) ||
          (request.operation === "get" && request.input.providerKey !== provider.key)
        ) {
          throw new TaskProviderError(
            "task_provider_mismatch",
            "Tasks reference is outside the admitted provider.",
          );
        }
        if ("input" in request && "mutation" in request.input) {
          const mutation = request.input.mutation;
          const grant =
            request.operation === "transition"
              ? request.input.intent === "complete" || request.input.intent === "reopen"
                ? "tasks.complete"
                : request.input.intent === "submit_review"
                  ? "tasks.review"
                  : "tasks.progress"
              : request.operation === "attachArtifact"
                ? "tasks.review"
                : `tasks.${request.operation}`;
          const reviewComment =
            request.operation === "comment" &&
            grants.has("tasks.review") &&
            request.input.ref.id === binding?.id;
          const retry = retryContexts.some(
            (context) => JSON.stringify(context) === JSON.stringify(mutation),
          );
          const current =
            mutation.executionId === runId &&
            mutation.claimExecutionId === claimExecutionId &&
            mutation.actor.id.startsWith(`clarvis-agent:${runId}:`);
          if (
            selected.writes !== "enabled" ||
            (binding !== undefined && binding.mode !== "work") ||
            (!grants.has(grant) && !reviewComment) ||
            mutation.owner !== owner ||
            (!current && !retry) ||
            mutation.actor.kind !== "agent" ||
            ((request.operation === "transition" || request.operation === "attachArtifact") &&
              request.input.ref.id !== binding?.id)
          ) {
            throw new TaskProviderError(
              "task_forbidden",
              "Tasks mutation exceeds the admitted run authority.",
            );
          }
          const advertised =
            request.operation === "transition"
              ? selected.capabilities.write.intents.includes(request.input.intent)
              : selected.capabilities.write[
                  request.operation as "create" | "assign" | "comment" | "attachArtifact"
                ];
          if (!advertised)
            throw new TaskProviderError(
              "task_unsupported",
              "Tasks operation is not advertised by the admitted provider.",
            );
        }
        if (provider[request.operation] === undefined)
          throw new TaskProviderError("task_unsupported", "Tasks operation is unavailable.");
        let result: unknown;
        switch (request.operation) {
          case "capabilities":
            result = selected.capabilities;
            break;
          case "listContainers":
            result = await provider.listContainers(request.input, signal);
            break;
          case "search":
            result = await provider.search(request.input, signal);
            break;
          case "get":
            result = await provider.get(request.input, signal);
            break;
          case "searchActors":
            result = await provider.searchActors!(request.input, signal);
            break;
          case "create":
            result = await provider.create!(request.input, signal);
            break;
          case "assign":
            result = await provider.assign!(
              { ...request.input, assigneeId: request.input.assigneeId },
              signal,
            );
            break;
          case "transition":
            result = await provider.transition!(request.input, signal);
            break;
          case "comment":
            result = await provider.comment!(request.input, signal);
            break;
          case "attachArtifact":
            result = await provider.attachArtifact!(request.input, signal);
            break;
        }
        return { ok: true, value: result };
      } catch (error) {
        if (!(error instanceof TaskProviderError)) throw error;
        return {
          ok: false,
          code: error.code,
          message: error.message,
          currentRevision: error.currentRevision,
          currentTask: error.currentTask,
        };
      }
    },
  };
}

/** Reuse the native Tasks capability over a provider-opaque, per-run host port. */
export function createGuestTaskResolver(bridge: GuestExecutionBridge): TaskProviderResolver {
  const call = async <T>(request: Request, signal?: AbortSignal): Promise<T> => {
    const response = (await bridge.capability(
      randomUUID(),
      { method: RUNTIME_TASKS_METHOD, revision: REVISION, arguments: request },
      signal,
    )) as
      | { ok: true; value: T }
      | {
          ok: false;
          code: TaskProviderError["code"];
          message: string;
          currentRevision?: string;
          currentTask?: TaskProviderError["currentTask"];
        };
    if (response.ok === false)
      throw new TaskProviderError(response.code, response.message, {
        ...(response.currentRevision === undefined
          ? {}
          : { currentRevision: response.currentRevision }),
        ...(response.currentTask === undefined ? {} : { currentTask: response.currentTask }),
      });
    return response.value;
  };
  return {
    async resolve(_owner, expectedProviderKey, signal) {
      const descriptor = await call<Descriptor>(
        {
          operation: "resolve",
          ...(expectedProviderKey === undefined ? {} : { expectedProviderKey }),
        },
        signal,
      );
      return {
        ...descriptor,
        provider: {
          ...descriptor.provider,
          capabilities: (signal) => call({ operation: "capabilities" }, signal),
          listContainers: (input, signal) => call({ operation: "listContainers", input }, signal),
          search: (input, signal) => call({ operation: "search", input }, signal),
          get: (input, signal) => call({ operation: "get", input }, signal),
          searchActors: (input, signal) => call({ operation: "searchActors", input }, signal),
          create: (input, signal) => call({ operation: "create", input }, signal),
          assign: (input, signal) => call({ operation: "assign", input }, signal),
          transition: (input, signal) => call({ operation: "transition", input }, signal),
          comment: (input, signal) => call({ operation: "comment", input }, signal),
          attachArtifact: (input, signal) => call({ operation: "attachArtifact", input }, signal),
        },
      };
    },
  };
}
