import {
  TaskProviderError,
  type AssignTaskInput,
  type AttachTaskArtifactInput,
  type CommentTaskInput,
  type CreateTaskInput,
  type TaskDocument,
  type TaskProvider,
  type TaskProviderCapabilities,
  type TaskSummary,
  type TransitionTaskInput,
} from "../../src/index.ts";

export const PROVIDER_KEY = "tasks:mcp:v2:sha256:test";

export function taskDocument(over: Partial<TaskDocument> = {}): TaskDocument {
  return {
    ref: { providerKey: PROVIDER_KEY, id: "CLAR-42" },
    container: { id: "CLAR", label: "Clarvis", kind: "project" },
    title: "Implement Tasks",
    stage: "ready",
    nativeState: { id: "todo", label: "To do" },
    labels: ["feature"],
    revision: "1",
    description: "Provider-neutral requirements",
    acceptanceCriteria: ["works"],
    availableIntents: ["start", "block", "submit_review", "complete", "reopen"],
    ...over,
  };
}

export function taskSummary(document: TaskDocument = taskDocument()): TaskSummary {
  const {
    description: _description,
    acceptanceCriteria: _acceptanceCriteria,
    availableIntents: _availableIntents,
    ...summary
  } = document;
  return summary;
}

export const fullCapabilities: TaskProviderCapabilities = {
  protocolVersion: 2,
  providerKind: "fake",
  providerInstanceId: "fixture-instance",
  read: { containers: true, search: true, get: true, actors: true },
  write: {
    create: true,
    assign: true,
    comment: true,
    attachArtifact: true,
    intents: ["start", "block", "submit_review", "complete", "reopen"],
  },
  concurrency: "exclusive_claim",
};

export interface ProviderCall {
  operation: string;
  input: unknown;
}

export interface FakeProvider extends TaskProvider {
  calls: ProviderCall[];
  current(): TaskDocument;
  failNext(operation: string, error: Error): void;
}

function signature(input: unknown): string {
  return JSON.stringify(input);
}

export function makeProvider(
  options: {
    capabilities?: TaskProviderCapabilities;
    document?: TaskDocument;
  } = {},
): FakeProvider {
  const capabilities = structuredClone(options.capabilities ?? fullCapabilities);
  let current = structuredClone(options.document ?? taskDocument());
  let revision = Number(current.revision ?? "1");
  const calls: ProviderCall[] = [];
  const failures = new Map<string, Error>();
  const results = new Map<string, { signature: string; document: TaskDocument }>();

  const record = (operation: string, input: unknown): void => {
    calls.push({ operation, input: structuredClone(input) });
    const failure = failures.get(operation);
    if (failure) {
      failures.delete(operation);
      throw failure;
    }
  };

  const mutate = <T extends { mutation: { idempotencyKey: string } }>(
    operation: string,
    input: T,
    apply: () => TaskDocument,
  ): TaskDocument => {
    record(operation, input);
    const key = input.mutation.idempotencyKey;
    const encoded = signature(input);
    const prior = results.get(key);
    if (prior) {
      if (prior.signature !== encoded) {
        throw new TaskProviderError(
          "task_invalid_input",
          "idempotency key was reused with different input",
        );
      }
      return structuredClone(prior.document);
    }
    const document = apply();
    results.set(key, { signature: encoded, document: structuredClone(document) });
    return structuredClone(document);
  };

  const bump = (over: Partial<TaskDocument> = {}): TaskDocument => {
    revision += 1;
    current = { ...current, ...over, revision: String(revision) };
    return current;
  };

  const provider: FakeProvider = {
    kind: capabilities.providerKind,
    key: PROVIDER_KEY,
    calls,
    current: () => structuredClone(current),
    failNext: (operation, error) => failures.set(operation, error),
    capabilities: async () => structuredClone(capabilities),
    async listContainers(input) {
      record("listContainers", input);
      return { items: [structuredClone(current.container)] };
    },
    async search(input) {
      record("search", input);
      return { items: [structuredClone(taskSummary(current))], nextCursor: "next" };
    },
    async get(ref) {
      record("get", ref);
      if (ref.providerKey !== PROVIDER_KEY || ref.id !== current.ref.id) {
        throw new TaskProviderError("task_not_found", "task not found");
      }
      return structuredClone(current);
    },
    ...(capabilities.read.actors
      ? {
          async searchActors(input) {
            record("searchActors", input);
            return { items: [{ id: "ana", label: "Ana", kind: "human" as const }] };
          },
        }
      : {}),
    ...(capabilities.write.create
      ? {
          async create(input: CreateTaskInput) {
            return mutate("create", input, () =>
              taskDocument({
                ref: { providerKey: PROVIDER_KEY, id: "CLAR-99" },
                container: { id: input.containerId, label: input.containerId },
                title: input.title,
                revision: "1",
              }),
            );
          },
        }
      : {}),
    ...(capabilities.write.assign
      ? {
          async assign(input: AssignTaskInput) {
            return mutate("assign", input, () =>
              bump({
                assignee:
                  input.assigneeId === null
                    ? undefined
                    : { id: input.assigneeId, label: input.assigneeId, kind: "human" },
              }),
            );
          },
        }
      : {}),
    ...(capabilities.write.comment
      ? {
          async comment(input: CommentTaskInput) {
            return mutate("comment", input, () => bump());
          },
        }
      : {}),
    ...(capabilities.write.attachArtifact
      ? {
          async attachArtifact(input: AttachTaskArtifactInput) {
            return mutate("attachArtifact", input, () => bump());
          },
        }
      : {}),
    ...(capabilities.write.intents.length > 0
      ? {
          async transition(input: TransitionTaskInput) {
            return mutate("transition", input, () => {
              if (!capabilities.write.intents.includes(input.intent)) {
                throw new TaskProviderError("task_invalid_transition", "intent unavailable");
              }
              if (
                input.intent === "start" &&
                capabilities.concurrency === "exclusive_claim" &&
                current.claim !== undefined &&
                current.claim.executionId !== input.mutation.claimExecutionId
              ) {
                throw new TaskProviderError("task_already_claimed", "claimed elsewhere");
              }
              const stage =
                input.intent === "start"
                  ? "active"
                  : input.intent === "block"
                    ? "blocked"
                    : input.intent === "submit_review"
                      ? "review"
                      : input.intent === "complete"
                        ? "done"
                        : "ready";
              return bump({
                stage,
                nativeState: { id: stage, label: stage },
                ...(input.intent === "start"
                  ? {
                      claim: {
                        claimant: input.claimant!,
                        executionId: input.mutation.claimExecutionId ?? input.mutation.executionId!,
                        claimedAt: "2026-08-09T12:00:00Z",
                      },
                    }
                  : input.intent === "submit_review" ||
                      input.intent === "complete" ||
                      input.intent === "reopen"
                    ? { claim: undefined }
                    : {}),
              });
            });
          },
        }
      : {}),
  };
  return provider;
}
