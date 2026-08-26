import { describe, expect, it } from "bun:test";
import {
  TaskProviderError,
  type AssignTaskInput,
  type AttachTaskArtifactInput,
  type CommentTaskInput,
  type CreateTaskInput,
  type TaskDocument,
  type TaskProvider,
  type TaskProviderCapabilities,
  type TaskProviderResolution,
  type TransitionTaskInput,
} from "@clarvis/tasks";
import type { TaskProviderFactory } from "../../src/tasks/task-provider-factory.ts";
import { createTasksService } from "../../src/tasks/task-service.ts";

const KEY = "tasks:mcp:v2:sha256:test";
const REF = { provider_key: KEY, id: "CLAR-42" };

const CAPABILITIES: TaskProviderCapabilities = {
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
  concurrency: "revision",
};

function document(over: Partial<TaskDocument> = {}): TaskDocument {
  return {
    ref: { providerKey: KEY, id: "CLAR-42" },
    container: { id: "CLAR", label: "Clarvis", kind: "project" },
    title: "Implement Tasks",
    stage: "ready",
    nativeState: { id: "todo", label: "To do" },
    labels: ["feature"],
    revision: "7",
    description: "Requirements",
    acceptanceCriteria: ["works"],
    availableIntents: ["start", "block", "submit_review", "complete", "reopen"],
    ...over,
  };
}

type MutationInput =
  | CreateTaskInput
  | AssignTaskInput
  | TransitionTaskInput
  | CommentTaskInput
  | AttachTaskArtifactInput;

function fakeProvider(options: { error?: { operation: string; value: TaskProviderError } } = {}) {
  const calls: { operation: string; input: unknown; signal?: AbortSignal }[] = [];
  const mutations: MutationInput[] = [];
  const mutationResults = new Map<string, { signature: string; document: TaskDocument }>();
  let current = document();
  const record = (operation: string, input: unknown, signal?: AbortSignal): void => {
    calls.push({ operation, input, ...(signal === undefined ? {} : { signal }) });
    if (options.error?.operation === operation) throw options.error.value;
  };
  const mutate = (operation: string, input: MutationInput, signal?: AbortSignal): TaskDocument => {
    record(operation, input, signal);
    mutations.push(input);
    const key = input.mutation.idempotencyKey;
    const signature = JSON.stringify(input);
    const prior = mutationResults.get(key);
    if (prior !== undefined) {
      if (prior.signature !== signature) {
        throw new TaskProviderError(
          "task_invalid_input",
          "idempotency key was reused with different input",
        );
      }
      return structuredClone(prior.document);
    }
    const nextRevision = String(Number(current.revision ?? "0") + 1);
    current = { ...current, revision: nextRevision };
    if (operation === "transition") {
      const intent = (input as TransitionTaskInput).intent;
      current = {
        ...current,
        stage:
          intent === "block"
            ? "blocked"
            : intent === "submit_review"
              ? "review"
              : intent === "complete"
                ? "done"
                : intent === "reopen"
                  ? "ready"
                  : "active",
      };
    }
    mutationResults.set(key, { signature, document: structuredClone(current) });
    return structuredClone(current);
  };
  const provider: TaskProvider = {
    kind: "fake",
    key: KEY,
    capabilities: async () => structuredClone(CAPABILITIES),
    async listContainers(input, signal) {
      record("listContainers", input, signal);
      return { items: [current.container], nextCursor: "containers-next" };
    },
    async search(input, signal) {
      record("search", input, signal);
      const {
        description: _description,
        acceptanceCriteria: _criteria,
        availableIntents: _intents,
        ...summary
      } = current;
      return { items: [summary], nextCursor: "tasks-next" };
    },
    async get(ref, signal) {
      record("get", ref, signal);
      return structuredClone(current);
    },
    async searchActors(input, signal) {
      record("searchActors", input, signal);
      return { items: [{ id: "ana", label: "Ana", kind: "human" }] };
    },
    create: async (input, signal) => mutate("create", input, signal),
    assign: async (input, signal) => mutate("assign", input, signal),
    transition: async (input, signal) => mutate("transition", input, signal),
    comment: async (input, signal) => mutate("comment", input, signal),
    attachArtifact: async (input, signal) => mutate("attachArtifact", input, signal),
  };
  return { provider, calls, mutations, current: () => structuredClone(current) };
}

function factoryFor(
  provider: TaskProvider,
  options: { writes?: "disabled" | "enabled"; ownerLog?: string[] } = {},
): TaskProviderFactory {
  return {
    async resolve(owner: string, _expected?: string, _signal?: AbortSignal) {
      options.ownerLog?.push(owner);
      return {
        provider,
        capabilities: CAPABILITIES,
        writes: options.writes ?? "enabled",
        defaultContainer: "CLAR",
        server: "fake:tasks",
      } satisfies TaskProviderResolution;
    },
    async status() {
      return {
        state: "ready" as const,
        providerKey: KEY,
        providerKind: "fake",
        server: "fake:tasks",
        writes: options.writes ?? "enabled",
      };
    },
  } as unknown as TaskProviderFactory;
}

describe("Tasks control plane", () => {
  it("is stable but unavailable when the host did not wire Tasks", async () => {
    const service = createTasksService({ owner: "alice", enabled: false });
    expect(await service.status()).toEqual({
      state: "not_configured",
      writes: "disabled",
      reason: "Tasks are disabled in this host.",
    });
    await expect(service.search({})).rejects.toMatchObject({ code: "capability_disabled" });
  });

  it("maps every read projection, pagination and cancellation through one owner", async () => {
    const fake = fakeProvider();
    const owners: string[] = [];
    const service = createTasksService({
      factory: factoryFor(fake.provider, { ownerLog: owners }),
      owner: "alice",
      enabled: true,
    });
    const controller = new AbortController();

    expect(await service.status()).toMatchObject({ state: "ready", provider_key: KEY });
    expect(await service.capabilities()).toMatchObject({
      protocol_version: 2,
      provider_instance_id: "fixture-instance",
      write: { attach_artifact: true },
    });
    expect(await service.listContainers({ query: "clar", cursor: "a", limit: 10 })).toEqual({
      items: [{ id: "CLAR", label: "Clarvis", kind: "project" }],
      next_cursor: "containers-next",
    });
    expect(
      await service.search(
        { container_id: "CLAR", stages: ["ready"], cursor: "b", limit: 20 },
        { signal: controller.signal },
      ),
    ).toMatchObject({ items: [{ ref: REF, native_state: { label: "To do" } }] });
    expect(await service.get(REF)).toMatchObject({
      ref: REF,
      acceptance_criteria: ["works"],
      available_intents: expect.arrayContaining(["complete"]),
    });
    expect(await service.searchActors({ query: "Ana" })).toEqual({
      items: [{ id: "ana", label: "Ana", kind: "human" }],
    });
    expect(owners).toEqual(["alice", "alice", "alice", "alice", "alice"]);
    expect(fake.calls.find(({ operation }) => operation === "search")?.signal).toBe(
      controller.signal,
    );
  });

  it("maps a provider claim as a distinct execution projection", async () => {
    const fake = fakeProvider();
    fake.provider.get = async () =>
      document({
        claim: {
          claimant: { id: "agent-1", label: "Clarvis agent", kind: "agent" },
          executionId: "exec-1",
          claimedAt: "2026-08-10T12:00:00Z",
        },
      });
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
    });

    expect(await service.get(REF)).toMatchObject({
      claim: {
        claimant: { id: "agent-1", kind: "agent" },
        execution_id: "exec-1",
        claimed_at: "2026-08-10T12:00:00Z",
      },
    });
  });

  it("derives authority and stable idempotency while supplying the current revision", async () => {
    const fake = fakeProvider();
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
    });

    await service.create({
      request_id: "create-1",
      provider_key: KEY,
      container_id: "CLAR",
      title: "New",
    });
    await service.assign({ request_id: "assign-1", ref: REF, assignee_id: "ana" });
    await service.comment({ request_id: "comment-1", ref: REF, body: "Evidence" });
    await service.attachArtifact({
      request_id: "artifact-1",
      ref: REF,
      artifact: { kind: "url", label: "Build", url: "https://ci.example/run/1" },
    });

    for (const input of fake.mutations) {
      expect(input.mutation).toMatchObject({
        owner: "alice",
        actor: { id: "alice", label: "alice", kind: "human" },
      });
      expect(input.mutation.idempotencyKey).toMatch(/^tasks:control:[a-f0-9]{64}$/);
      expect(input.mutation.executionId).toBeUndefined();
    }
    expect(fake.mutations[1]?.mutation.expectedRevision).toBe("8");
    expect(fake.mutations[2]?.mutation.expectedRevision).toBe("9");
    expect(fake.mutations[3]?.mutation.expectedRevision).toBe("10");

    const bobFake = fakeProvider();
    const bob = createTasksService({
      factory: factoryFor(bobFake.provider),
      owner: "bob",
      enabled: true,
    });
    await bob.comment({ request_id: "comment-1", ref: REF, body: "Evidence" });
    expect(bobFake.mutations[0]?.mutation.idempotencyKey).not.toBe(
      fake.mutations[2]?.mutation.idempotencyKey,
    );
  });

  it("requires confirmation for complete/reopen while preserving idempotent retries", async () => {
    const fake = fakeProvider();
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
    });

    await expect(
      service.transition({ request_id: "complete-missing", ref: REF, intent: "complete" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const preview = await service.previewTransition({ ref: REF, intent: "complete" });
    expect(preview.task.revision).toBe("7");
    expect(
      await service.transition({
        request_id: "complete-1",
        ref: REF,
        intent: "complete",
        confirmation_token: preview.confirmation_token,
      }),
    ).toMatchObject({ stage: "done" });
    expect(
      await service.transition({
        request_id: "complete-1",
        ref: REF,
        intent: "complete",
        confirmation_token: preview.confirmation_token,
      }),
    ).toMatchObject({ stage: "done" });
    expect(fake.calls.filter(({ operation }) => operation === "transition")).toHaveLength(1);
    await expect(
      service.transition({
        request_id: "complete-2",
        ref: REF,
        intent: "complete",
        confirmation_token: preview.confirmation_token,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      service.transition({ request_id: "start-1", ref: REF, intent: "start" } as never),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("atomically binds one confirmation token to its first request ID", async () => {
    const fake = fakeProvider();
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
    });
    const preview = await service.previewTransition({ ref: REF, intent: "complete" });
    const outcomes = await Promise.allSettled([
      service.transition({
        request_id: "complete-first",
        ref: REF,
        intent: "complete",
        confirmation_token: preview.confirmation_token,
      }),
      service.transition({
        request_id: "complete-second",
        ref: REF,
        intent: "complete",
        confirmation_token: preview.confirmation_token,
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({ code: "conflict" });
    expect(fake.calls.filter(({ operation }) => operation === "transition")).toHaveLength(1);
  });

  it("fails writes closed and reports unsupported methods before invocation", async () => {
    const fake = fakeProvider();
    const disabled = createTasksService({
      factory: factoryFor(fake.provider, { writes: "disabled" }),
      owner: "alice",
      enabled: true,
    });
    await expect(
      disabled.comment({ request_id: "comment", ref: REF, body: "no" }),
    ).rejects.toMatchObject({ code: "capability_disabled" });
    expect(fake.mutations).toEqual([]);

    const readonly: TaskProvider = {
      ...fake.provider,
      searchActors: undefined,
      create: undefined,
      assign: undefined,
      transition: undefined,
      comment: undefined,
      attachArtifact: undefined,
    };
    const unsupported = createTasksService({
      factory: factoryFor(readonly),
      owner: "alice",
      enabled: true,
    });
    await expect(unsupported.searchActors({})).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      unsupported.create({
        request_id: "create",
        provider_key: KEY,
        container_id: "CLAR",
        title: "No",
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("re-reads conflicts and unknown outcomes without replaying a mutation", async () => {
    for (const code of ["task_conflict", "task_outcome_unknown"] as const) {
      const error = new TaskProviderError(code, `write failed: Bearer secret-token`);
      const fake = fakeProvider({ error: { operation: "comment", value: error } });
      const service = createTasksService({
        factory: factoryFor(fake.provider),
        owner: "alice",
        enabled: true,
      });
      const caught = await service
        .comment({ request_id: code, ref: REF, body: "once", expected_revision: "7" })
        .catch((value: unknown) => value);
      expect(caught).toMatchObject({
        code: code === "task_conflict" ? "conflict" : "unavailable",
        message: "write failed: Bearer [redacted]",
        details: {
          task_code: code,
          current_revision: "7",
          current_task: { ref: REF },
          ...(code === "task_outcome_unknown" ? { outcome_unknown: true } : {}),
        },
      });
      expect(fake.calls.filter(({ operation }) => operation === "comment")).toHaveLength(1);
      expect(fake.calls.filter(({ operation }) => operation === "get")).toHaveLength(1);
    }
  });

  it("reuses a derived revision and exact provider input after an unknown outcome", async () => {
    const fake = fakeProvider();
    const original = fake.provider.comment!.bind(fake.provider);
    let loseResponse = true;
    fake.provider.comment = async (input, signal) => {
      const result = await original(input, signal);
      if (loseResponse) {
        loseResponse = false;
        throw new TaskProviderError("task_outcome_unknown", "response lost");
      }
      return result;
    };
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
    });
    const request = { request_id: "stable-comment", ref: REF, body: "once" } as const;

    await expect(service.comment(request)).rejects.toMatchObject({
      details: { outcome_unknown: true },
    });
    expect(await service.comment(request)).toMatchObject({ revision: "8" });

    const comments = fake.mutations.filter(
      (input): input is CommentTaskInput => "body" in input && input.body === "once",
    );
    expect(comments).toHaveLength(2);
    expect(comments[1]).toEqual(comments[0]);
    expect(fake.calls.filter(({ operation }) => operation === "get")).toHaveLength(2);
    await expect(service.comment({ ...request, body: "different" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fake.calls.filter(({ operation }) => operation === "comment")).toHaveLength(2);
  });

  it("keeps an uncertain provider input across a transient retry failure", async () => {
    const fake = fakeProvider();
    const original = fake.provider.comment!.bind(fake.provider);
    const prepared: CommentTaskInput[] = [];
    fake.provider.comment = async (input, signal) => {
      prepared.push(input);
      if (prepared.length === 1) {
        await original(input, signal);
        throw new TaskProviderError("task_outcome_unknown", "response lost");
      }
      if (prepared.length === 2) {
        throw new TaskProviderError("task_provider_unavailable", "provider restarting");
      }
      return await original(input, signal);
    };
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
    });
    const request = { request_id: "stable-transient", ref: REF, body: "once" } as const;

    await expect(service.comment(request)).rejects.toMatchObject({
      details: { outcome_unknown: true },
    });
    await expect(service.comment(request)).rejects.toMatchObject({ code: "unavailable" });
    await expect(service.comment(request)).resolves.toMatchObject({ ref: REF });

    expect(prepared).toHaveLength(3);
    expect(prepared[1]).toEqual(prepared[0]);
    expect(prepared[2]).toEqual(prepared[0]);
  });

  it("does not dispatch when the last caller cancels during revision preparation", async () => {
    const fake = fakeProvider();
    const originalComment = fake.provider.comment!.bind(fake.provider);
    let getStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      getStarted = resolve;
    });
    let releaseGet!: () => void;
    const getReleased = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    let commentCalls = 0;
    fake.provider.get = async () => {
      getStarted();
      await getReleased;
      return document();
    };
    fake.provider.comment = async (input, signal) => {
      commentCalls += 1;
      return await originalComment(input, signal);
    };
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
    });
    const controller = new AbortController();
    const request = { request_id: "cancel-during-prepare", ref: REF, body: "once" } as const;
    const pending = service.comment(request, { signal: controller.signal });

    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    releaseGet();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commentCalls).toBe(0);

    await expect(service.comment(request)).resolves.toMatchObject({ ref: REF });
    expect(commentCalls).toBe(1);
  });

  it("binds a create request id to its original provider selection", async () => {
    const first = fakeProvider();
    const originalCreate = first.provider.create!.bind(first.provider);
    let loseResponse = true;
    first.provider.create = async (input, signal) => {
      const result = await originalCreate(input, signal);
      if (loseResponse) {
        loseResponse = false;
        throw new TaskProviderError("task_outcome_unknown", "response lost");
      }
      return result;
    };
    const secondBase = fakeProvider();
    const secondKey = `${KEY}:replacement`;
    const second: TaskProvider = { ...secondBase.provider, key: secondKey };
    let selected = first.provider;
    const factory = {
      async resolve() {
        return {
          provider: selected,
          capabilities: CAPABILITIES,
          writes: "enabled" as const,
          defaultContainer: "CLAR",
          server: "fake:tasks",
        };
      },
      async status() {
        return { state: "ready" as const, writes: "enabled" as const };
      },
    } as unknown as TaskProviderFactory;
    const service = createTasksService({ factory, owner: "alice", enabled: true });
    const request = {
      request_id: "provider-bound-create",
      provider_key: KEY,
      container_id: "CLAR",
      title: "One",
    };

    await expect(service.create(request)).rejects.toMatchObject({
      details: { outcome_unknown: true },
    });
    selected = second;
    await expect(service.create(request)).rejects.toMatchObject({
      details: { task_code: "task_provider_mismatch" },
    });
    expect(secondBase.calls.filter(({ operation }) => operation === "create")).toHaveLength(0);
  });

  it("retains confirmation and transition input until an uncertain write resolves", async () => {
    const fake = fakeProvider();
    const original = fake.provider.transition!.bind(fake.provider);
    let loseResponse = true;
    fake.provider.transition = async (input, signal) => {
      const result = await original(input, signal);
      if (loseResponse) {
        loseResponse = false;
        throw new TaskProviderError("task_outcome_unknown", "response lost");
      }
      return result;
    };
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
    });
    const preview = await service.previewTransition({ ref: REF, intent: "complete" });
    const request = {
      request_id: "stable-complete",
      ref: REF,
      intent: "complete" as const,
      confirmation_token: preview.confirmation_token,
    };

    await expect(service.transition(request)).rejects.toMatchObject({
      details: { outcome_unknown: true },
    });
    expect(await service.transition(request)).toMatchObject({ stage: "done", revision: "8" });
    expect(await service.transition(request)).toMatchObject({ stage: "done", revision: "8" });

    const transitions = fake.mutations.filter(
      (input): input is TransitionTaskInput => "intent" in input && input.intent === "complete",
    );
    expect(transitions).toHaveLength(2);
    expect(transitions[1]).toEqual(transitions[0]);
    expect(fake.calls.filter(({ operation }) => operation === "transition")).toHaveLength(2);
  });

  it("bounds unresolved mutation replay state without evicting stable retry inputs", async () => {
    const fake = fakeProvider({
      error: {
        operation: "comment",
        value: new TaskProviderError("task_outcome_unknown", "response lost"),
      },
    });
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
    });

    for (let index = 0; index < 1_024; index += 1) {
      await expect(
        service.comment({ request_id: `failed-${index}`, ref: REF, body: "once" }),
      ).rejects.toMatchObject({ code: "unavailable" });
    }
    const writesAtCapacity = fake.calls.filter(({ operation }) => operation === "comment").length;

    await expect(
      service.comment({ request_id: "one-too-many", ref: REF, body: "once" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fake.calls.filter(({ operation }) => operation === "comment")).toHaveLength(
      writesAtCapacity,
    );

    // An existing request remains retryable with its original prepared input.
    await expect(
      service.comment({ request_id: "failed-0", ref: REF, body: "once" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fake.calls.filter(({ operation }) => operation === "comment")).toHaveLength(
      writesAtCapacity + 1,
    );
  });

  it("does not let pre-dispatch validation failures exhaust mutation replay state", async () => {
    const fake = fakeProvider();
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
    });

    for (let index = 0; index < 1_025; index += 1) {
      await expect(
        service.transition({
          request_id: `missing-confirmation-${index}`,
          ref: REF,
          intent: "complete",
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }

    expect(
      await service.comment({ request_id: "after-invalid", ref: REF, body: "still writable" }),
    ).toMatchObject({ revision: "8" });
  });

  it("detaches a cancelled waiter without cancelling another caller for the same request", async () => {
    const fake = fakeProvider();
    const original = fake.provider.comment!.bind(fake.provider);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let sharedSignal: AbortSignal | undefined;
    let started!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    fake.provider.comment = async (input, signal) => {
      sharedSignal = signal;
      started();
      await writeGate;
      return original(input, signal);
    };
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const request = { request_id: "shared", ref: REF, body: "once" } as const;

    const first = service.comment(request, { signal: firstController.signal });
    await writeStarted;
    const second = service.comment(request, { signal: secondController.signal });
    await Promise.resolve();
    await Promise.resolve();
    firstController.abort();

    await expect(first).rejects.toMatchObject({
      code: "cancelled",
      details: { outcome_unknown: true },
    });
    expect(sharedSignal?.aborted).toBe(false);
    releaseWrite();
    expect(await second).toMatchObject({ revision: "8" });
    expect(fake.calls.filter(({ operation }) => operation === "comment")).toHaveLength(1);
  });

  it("reconciles an aborted in-flight mutation with an independent signal", async () => {
    const fake = fakeProvider();
    const controller = new AbortController();
    fake.provider.comment = async () => {
      controller.abort();
      throw new TaskProviderError("task_outcome_unknown", "response lost");
    };
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
    });

    await expect(
      service.comment(
        { request_id: "cancelled-write", ref: REF, body: "once" },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "cancelled", details: { outcome_unknown: true } });
    await Promise.resolve();
    await Promise.resolve();

    const reads = fake.calls.filter(({ operation }) => operation === "get");
    expect(reads).toHaveLength(2);
    expect(reads[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(reads[1]?.signal).toBeUndefined();
  });

  it("rejects arbitrary provider references and extra authority fields", async () => {
    const fake = fakeProvider();
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
    });
    await expect(service.get({ provider_key: "other", id: "CLAR-42" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      service.comment({
        request_id: "bad",
        ref: REF,
        body: "x",
        owner: "mallory",
      } as never),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("maps unexpected provider and factory failures at the service boundary", async () => {
    const fake = fakeProvider();
    fake.provider.search = async () => {
      throw new Error("provider exploded");
    };
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
    });
    await expect(service.search({})).rejects.toMatchObject({
      code: "unavailable",
      message: "provider exploded",
    });

    const failedFactory = {
      async resolve() {
        throw new TaskProviderError("task_provider_unavailable", "factory unavailable");
      },
    } as unknown as TaskProviderFactory;
    await expect(
      createTasksService({
        factory: failedFactory,
        owner: "alice",
        enabled: true,
      }).capabilities(),
    ).rejects.toMatchObject({ code: "unavailable", message: "factory unavailable" });
  });

  it("bounds confirmation previews and rejects stale preview state", async () => {
    const fake = fakeProvider();
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
      now: () => 1_000,
    });
    let firstToken: string | undefined;
    for (let index = 0; index < 257; index += 1) {
      const preview = await service.previewTransition({ ref: REF, intent: "complete" });
      firstToken ??= preview.confirmation_token;
    }
    await expect(
      service.transition({
        request_id: "evicted-preview",
        ref: REF,
        intent: "complete",
        confirmation_token: firstToken!,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await expect(
      service.previewTransition({ ref: REF, intent: "complete", expected_revision: "6" }),
    ).rejects.toMatchObject({ code: "conflict", details: { current_revision: "7" } });

    const unavailable = fakeProvider();
    unavailable.provider.get = async () =>
      document({ availableIntents: ["start", "block", "submit_review", "reopen"] });
    const unavailableService = createTasksService({
      factory: factoryFor(unavailable.provider),
      owner: "alice",
      enabled: true,
    });
    await expect(
      unavailableService.previewTransition({ ref: REF, intent: "complete" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      unavailableService.transition({ request_id: "illegal-block", ref: REF, intent: "block" }),
    ).resolves.toMatchObject({ stage: "blocked" });
    unavailable.provider.get = async () => document({ availableIntents: ["start"] });
    await expect(
      unavailableService.transition({
        request_id: "illegal-review",
        ref: REF,
        intent: "submit_review",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("evicts completed mutation records by LRU and retention time", async () => {
    const fake = fakeProvider();
    let currentTime = 1_000;
    const service = createTasksService({
      factory: factoryFor(fake.provider),
      owner: "alice",
      enabled: true,
      now: () => currentTime,
    });
    for (let index = 0; index < 1_025; index += 1) {
      currentTime += 1;
      await service.comment({
        request_id: `completed-${index}`,
        ref: REF,
        body: "done",
        expected_revision: "7",
      });
    }
    expect(fake.calls.filter(({ operation }) => operation === "comment")).toHaveLength(1_025);

    currentTime += 1;
    await service.comment({
      request_id: "completed-0",
      ref: REF,
      body: "done",
      expected_revision: "7",
    });
    expect(fake.calls.filter(({ operation }) => operation === "comment")).toHaveLength(1_026);

    currentTime += 24 * 60 * 60_000 + 1;
    await service.comment({
      request_id: "completed-1",
      ref: REF,
      body: "done",
      expected_revision: "7",
    });
    expect(fake.calls.filter(({ operation }) => operation === "comment")).toHaveLength(1_027);
  });

  it("releases known unavailable writes and handles both cancellation checkpoints", async () => {
    const unavailable = fakeProvider({
      error: {
        operation: "comment",
        value: new TaskProviderError("task_provider_unavailable", "temporarily down"),
      },
    });
    const service = createTasksService({
      factory: factoryFor(unavailable.provider),
      owner: "alice",
      enabled: true,
    });
    const request = { request_id: "retry-known", ref: REF, body: "once" } as const;
    await expect(service.comment(request)).rejects.toMatchObject({ code: "unavailable" });
    await expect(service.comment(request)).rejects.toMatchObject({ code: "unavailable" });
    expect(unavailable.calls.filter(({ operation }) => operation === "comment")).toHaveLength(2);

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      service.comment(
        { request_id: "already-cancelled", ref: REF, body: "once" },
        { signal: cancelled.signal },
      ),
    ).rejects.toMatchObject({ code: "cancelled" });

    const race = fakeProvider();
    const raceService = createTasksService({
      factory: factoryFor(race.provider),
      owner: "alice",
      enabled: true,
    });
    let abortReads = 0;
    const racedSignal = {
      get aborted() {
        abortReads += 1;
        return abortReads > 1;
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    await expect(
      raceService.comment(
        { request_id: "cancelled-between-checks", ref: REF, body: "once" },
        { signal: racedSignal },
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(abortReads).toBe(2);
  });

  it("reports every absent write method as unsupported", async () => {
    const fake = fakeProvider();
    const readonly: TaskProvider = {
      ...fake.provider,
      assign: undefined,
      transition: undefined,
      comment: undefined,
      attachArtifact: undefined,
    };
    const service = createTasksService({
      factory: factoryFor(readonly),
      owner: "alice",
      enabled: true,
    });

    await expect(
      service.assign({ request_id: "assign", ref: REF, assignee_id: "ana" }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      service.transition({ request_id: "transition", ref: REF, intent: "block" }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      service.comment({ request_id: "comment", ref: REF, body: "comment" }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      service.attachArtifact({
        request_id: "artifact",
        ref: REF,
        artifact: { kind: "url", label: "Build", url: "https://example.test/build" },
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });
});
