import { expect, test } from "bun:test";
import {
  TaskProviderError,
  type TaskDocument,
  type TaskMutationContext,
  type TaskProviderCapabilities,
  type TaskProviderResolution,
  type TaskProviderResolver,
} from "@clarvis/tasks";
import type { GuestExecutionBridge } from "../../src/runtime/execution-worker.ts";
import { createGuestTaskResolver, createHostTasksGrant } from "../../src/runtime/tasks-bridge.ts";

function taskBridgeFixture(priorState?: unknown) {
  const calls: Array<{ operation: string; input: unknown; signal: AbortSignal | undefined }> = [];
  const task: TaskDocument = {
    ref: { providerKey: "fixture", id: "T-1" },
    container: { id: "project", label: "Project" },
    title: "Bridge contract",
    stage: "ready",
    nativeState: { id: "ready", label: "Ready" },
    revision: "rev-2",
    labels: [],
    acceptanceCriteria: [],
    availableIntents: ["start", "block", "submit_review", "complete", "reopen"],
  };
  const mutation: TaskMutationContext = {
    owner: "owner",
    executionId: "run",
    claimExecutionId: "run",
    idempotencyKey: "call",
    actor: { id: "clarvis-agent:run:lead", kind: "agent", label: "Lead" },
  };
  const capabilities: TaskProviderCapabilities = {
    protocolVersion: 2,
    providerInstanceId: "fixture",
    providerKind: "fixture",
    concurrency: "revision",
    read: { containers: true, search: true, get: true, actors: true },
    write: {
      create: true,
      assign: true,
      comment: true,
      attachArtifact: true,
      intents: task.availableIntents,
    },
  };
  const record =
    <T>(operation: string, result: T) =>
    async (input: unknown, signal?: AbortSignal): Promise<T> => {
      calls.push({ operation, input, signal });
      return result;
    };
  const resolution: TaskProviderResolution = {
    capabilities,
    writes: "enabled",
    server: "host",
    defaultContainer: "project",
    provider: {
      kind: "fixture",
      key: "fixture",
      capabilities: async () => capabilities,
      listContainers: record("listContainers", { items: [task.container] }),
      search: record("search", { items: [task] }),
      get: record("get", task),
      searchActors: record("searchActors", { items: [mutation.actor] }),
      create: record("create", task),
      assign: record("assign", task),
      transition: record("transition", task),
      comment: record("comment", task),
      attachArtifact: record("attachArtifact", task),
    },
  };
  const resolutions: Array<{ owner: string; key: string | undefined }> = [];
  const grant = createHostTasksGrant(
    {
      async resolve(owner, key) {
        resolutions.push({ owner, key });
        return resolution;
      },
    },
    "owner",
    "run",
    {
      profiles: [
        {
          grants: [
            "tasks.read",
            "tasks.create",
            "tasks.assign",
            "tasks.comment",
            "tasks.progress",
            "tasks.review",
            "tasks.complete",
          ],
        },
      ],
      task: { id: "T-1", mode: "work", provider_key: "fixture" },
    },
    priorState,
  );
  const signal = new AbortController().signal;
  const requestIds = new Set<string>();
  const bridge: GuestExecutionBridge = {
    model: async () => {
      throw new Error("unexpected model request");
    },
    event: async () => {
      throw new Error("unexpected event");
    },
    checkpoint: async () => {
      throw new Error("unexpected checkpoint");
    },
    async capability(callId, request, requestSignal) {
      expect(requestIds.has(callId)).toBe(false);
      requestIds.add(callId);
      expect(request.method).toBe(grant.method);
      expect(request.revision).toBe(grant.revision);
      expect(grant.validateArguments(request.arguments)).toBe(true);
      return JSON.parse(
        JSON.stringify(await grant.invoke(request.arguments, requestSignal ?? signal)),
      );
    },
  };
  return {
    calls,
    task,
    mutation,
    resolution,
    resolutions,
    grant,
    signal,
    guest: createGuestTaskResolver(bridge),
  };
}

test("round-trips every admitted Tasks provider operation with exact inputs and cancellation", async () => {
  const fixture = taskBridgeFixture();
  const { guest, task, mutation, signal, calls, resolutions } = fixture;
  const selected = await guest.resolve("owner", "fixture", signal);
  expect(selected.defaultContainer).toBe("project");
  expect(await selected.provider.capabilities(signal)).toEqual(fixture.resolution.capabilities);
  const containers = { query: "project", limit: 5 };
  expect(await selected.provider.listContainers(containers, signal)).toEqual({
    items: [task.container],
  });
  expect(calls.at(-1)).toEqual({ operation: "listContainers", input: containers, signal });
  const search = { query: "bridge", limit: 10 };
  expect(await selected.provider.search(search, signal)).toEqual({ items: [task] });
  expect(calls.at(-1)).toEqual({ operation: "search", input: search, signal });
  const actors = { query: "lead" };
  expect(await selected.provider.searchActors!(actors, signal)).toEqual({
    items: [mutation.actor],
  });
  expect(calls.at(-1)).toEqual({ operation: "searchActors", input: actors, signal });
  expect(await selected.provider.get(task.ref, signal)).toEqual(task);
  expect(calls.at(-1)).toEqual({ operation: "get", input: task.ref, signal });
  const create = { containerId: "project", title: "New task", mutation };
  expect(await selected.provider.create!(create, signal)).toEqual(task);
  expect(calls.at(-1)).toEqual({ operation: "create", input: create, signal });
  const assign = { ref: task.ref, assigneeId: null, mutation };
  expect(await selected.provider.assign!(assign, signal)).toEqual(task);
  expect(calls.at(-1)).toEqual({ operation: "assign", input: assign, signal });
  for (const intent of task.availableIntents) {
    const input = { ref: task.ref, intent, mutation };
    expect(await selected.provider.transition!(input, signal)).toEqual(task);
    expect(calls.at(-1)).toEqual({ operation: "transition", input, signal });
  }
  const comment = { ref: task.ref, body: "Evidence", mutation };
  expect(await selected.provider.comment!(comment, signal)).toEqual(task);
  expect(calls.at(-1)).toEqual({ operation: "comment", input: comment, signal });
  const artifact = {
    ref: task.ref,
    artifact: { kind: "run" as const, label: "Result", executionId: "run" },
    mutation,
  };
  expect(await selected.provider.attachArtifact!(artifact, signal)).toEqual(task);
  expect(calls.at(-1)).toEqual({ operation: "attachArtifact", input: artifact, signal });
  expect(resolutions).toEqual([{ owner: "owner", key: "fixture" }]);
});

test("preserves provider refusals, revision conflicts and unsupported operations through the guest resolver", async () => {
  const { guest, resolution, task, mutation, signal, calls } = taskBridgeFixture();
  await expect(guest.resolve("owner", "other", signal)).rejects.toMatchObject({
    code: "task_provider_mismatch",
  });
  const { provider } = await guest.resolve("owner", undefined, signal);
  resolution.capabilities.write.create = false;
  await expect(
    provider.create!({ containerId: "project", title: "Denied", mutation }, signal),
  ).rejects.toMatchObject({ code: "task_unsupported" });
  delete resolution.provider.searchActors;
  await expect(provider.searchActors!({}, signal)).rejects.toMatchObject({
    code: "task_unsupported",
  });
  resolution.writes = "disabled";
  await expect(
    provider.comment!({ ref: task.ref, body: "Denied", mutation }, signal),
  ).rejects.toMatchObject({ code: "task_forbidden" });
  expect(calls).toEqual([]);
  resolution.provider.get = async () => {
    throw new TaskProviderError("task_conflict", "Revision changed", {
      currentRevision: "rev-2",
      currentTask: task,
    });
  };
  await expect(provider.get(task.ref, signal)).rejects.toMatchObject({
    code: "task_conflict",
    message: "Revision changed",
    currentRevision: "rev-2",
    currentTask: task,
  });
  resolution.provider.get = async () => {
    throw new TaskProviderError("task_not_found", "Gone");
  };
  await expect(provider.get(task.ref, signal)).rejects.toMatchObject({
    code: "task_not_found",
    message: "Gone",
    currentRevision: undefined,
    currentTask: undefined,
  });
});

test("pins Tasks authority, filters host descriptors and preserves review writes without a comment grant", async () => {
  const calls: string[] = [];
  const capabilities: TaskProviderCapabilities = {
    protocolVersion: 2,
    providerInstanceId: "fixture",
    providerKind: "fixture",
    concurrency: "revision",
    read: { containers: true, search: true, get: true, actors: false },
    write: { create: false, assign: false, comment: true, attachArtifact: false, intents: [] },
  };
  const resolver: TaskProviderResolver = {
    async resolve() {
      return {
        capabilities,
        writes: "enabled",
        server: "host",
        secret: "MUST_NOT_CROSS",
        provider: {
          key: "fixture",
          kind: "fixture",
          capabilities: async () => capabilities,
          listContainers: async () => ({ items: [] }),
          search: async () => ({ items: [] }),
          get: async () => {
            throw new Error("unused");
          },
          comment: async () => {
            calls.push("comment");
            throw Object.assign(new Error("provider reached"), { code: "fixture" });
          },
        },
      };
    },
  };
  const raw = {
    profiles: [{ grants: ["tasks.review"] }],
    task: { id: "T-1", mode: "work", provider_key: "fixture" },
  };
  const grant = createHostTasksGrant(resolver, "owner", "run", raw);
  const signal = new AbortController().signal;
  expect(grant.validateArguments({ operation: "resolve", surprise: true })).toBe(false);
  expect(JSON.stringify(await grant.invoke({ operation: "resolve" }, signal))).not.toContain(
    "MUST_NOT_CROSS",
  );
  expect(await grant.invoke({ operation: "search", input: {} }, signal)).toMatchObject({
    ok: false,
    code: "task_forbidden",
  });
  expect(
    await grant.invoke({ operation: "get", input: { providerKey: "other", id: "T-1" } }, signal),
  ).toMatchObject({ ok: false, code: "task_provider_mismatch" });
  const request = {
    operation: "comment",
    input: {
      ref: { providerKey: "fixture", id: "T-1" },
      body: "Review evidence",
      mutation: {
        owner: "owner",
        executionId: "run",
        claimExecutionId: "run",
        idempotencyKey: "call",
        actor: { id: "clarvis-agent:run:lead", kind: "agent", label: "Lead" },
      },
    },
  };
  expect(grant.validateArguments(request)).toBe(true);
  await expect(grant.invoke(request, signal)).rejects.toMatchObject({ code: "fixture" });
  expect(calls).toEqual(["comment"]);
  const forged = structuredClone(request);
  forged.input.mutation.owner = "other";
  expect(await grant.invoke(forged, signal)).toMatchObject({ ok: false, code: "task_forbidden" });
  const continued = createHostTasksGrant(
    resolver,
    "owner",
    "run",
    { profiles: [{ grants: ["tasks.comment"] }], continue_from: "previous" },
    {
      version: 2,
      providerKey: "fixture",
      taskId: "T-1",
      mode: "inspect",
      lastStage: "ready",
    },
  );
  expect(await continued.invoke(request, signal)).toMatchObject({
    ok: false,
    code: "task_forbidden",
  });
  const unadmitted = createHostTasksGrant(resolver, "owner", "run", { profiles: [{ grants: [] }] });
  expect(await unadmitted.invoke({ operation: "resolve" }, signal)).toMatchObject({
    ok: false,
    code: "task_forbidden",
  });
});
