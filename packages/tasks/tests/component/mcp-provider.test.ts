import { describe, expect, it } from "bun:test";
import {
  TASK_MCP_TOOLS,
  TaskProviderError,
  createMcpTaskProvider,
  probeMcpTaskCapabilities,
  type TaskServerPort,
} from "../../src/index.ts";
import { fullCapabilities, PROVIDER_KEY } from "../helpers/provider.ts";

const wireCapabilities = {
  protocol_version: 2,
  provider_kind: "jira",
  provider_instance_id: "fixture-instance",
  read: { containers: true, search: true, get: true, actors: true },
  write: {
    create: true,
    assign: true,
    comment: true,
    attach_artifact: true,
    intents: ["start", "block", "submit_review", "complete", "reopen"],
  },
  concurrency: "exclusive_claim",
};

const wireDocument = {
  ref: { id: "CLAR-42" },
  container: { id: "CLAR", label: "\u001b[31m\u009bClarvis", kind: "project" },
  title: "\u001b[2J\u0085Implement Tasks",
  stage: "ready",
  native_state: { id: "todo", label: "To do\u0007\u009f" },
  priority: "high\u0000",
  assignee: { id: "ana", label: "Ana\u001b[2J", kind: "human" },
  claim: {
    claimant: { id: "agent", label: "Agent\u001b[31m", kind: "agent" },
    execution_id: "exec-1",
    claimed_at: "2026-08-09T12:00:00Z",
  },
  labels: ["feature\u0007"],
  updated_at: "2026-08-09T12:00:00Z",
  revision: "1",
  url: "https://tasks.example/CLAR-42",
  description: "Description\u001b[2J",
  acceptance_criteria: ["works\u0007"],
  available_intents: ["start", "block", "submit_review", "complete", "reopen"],
};

const {
  description: _description,
  acceptance_criteria: _acceptanceCriteria,
  available_intents: _availableIntents,
  ...wireSummary
} = wireDocument;

function success(
  result: unknown,
  providerInstanceId = wireCapabilities.provider_instance_id,
): unknown {
  return { protocol_version: 2, provider_instance_id: providerInstanceId, ok: true, result };
}

interface Call {
  tool: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}

function canonicalPort(over: Partial<Record<string, unknown>> = {}): TaskServerPort & {
  calls: Call[];
} {
  const calls: Call[] = [];
  const results: Record<string, unknown> = {
    [TASK_MCP_TOOLS.capabilities]: success(wireCapabilities),
    [TASK_MCP_TOOLS.listContainers]: success({
      items: [{ id: "CLAR", label: "\u001b[31mClarvis", kind: "project" }],
      next_cursor: "containers-next",
    }),
    [TASK_MCP_TOOLS.search]: success({
      items: [wireSummary],
      next_cursor: "tasks-next",
    }),
    [TASK_MCP_TOOLS.get]: success(wireDocument),
    [TASK_MCP_TOOLS.searchActors]: success({
      items: [{ id: "ana", label: "Ana\u001b[31m", kind: "human" }],
    }),
    [TASK_MCP_TOOLS.create]: success(wireDocument),
    [TASK_MCP_TOOLS.assign]: success(wireDocument),
    [TASK_MCP_TOOLS.transition]: success(wireDocument),
    [TASK_MCP_TOOLS.comment]: success(wireDocument),
    [TASK_MCP_TOOLS.attachArtifact]: success(wireDocument),
    ...over,
  };
  return {
    calls,
    async callTool(tool, args, signal) {
      calls.push({ tool, args, ...(signal === undefined ? {} : { signal }) });
      return { data: results[tool], isError: false };
    },
  };
}

const mutation = {
  owner: "owner-a",
  actor: { id: "agent", label: "Agent", kind: "agent" as const },
  executionId: "exec-2",
  claimExecutionId: "exec-1",
  idempotencyKey: "idem",
  expectedRevision: "1",
};

describe("clarvis.tasks.v2 MCP provider", () => {
  it("strictly parses capabilities and every canonical operation", async () => {
    const port = canonicalPort();
    const probed = await probeMcpTaskCapabilities({
      owner: "owner-a",
      port,
    });
    expect(probed).toEqual({ ...fullCapabilities, providerKind: "jira" });
    const provider = await createMcpTaskProvider({
      owner: "owner-a",
      key: PROVIDER_KEY,
      port,
      capabilities: probed,
    });
    expect(await provider.capabilities()).toEqual(probed);
    expect(await provider.listContainers({ query: "clar" })).toEqual({
      items: [{ id: "CLAR", label: "Clarvis", kind: "project" }],
      nextCursor: "containers-next",
    });
    const page = await provider.search({
      containerId: "CLAR",
      query: "task",
      stages: ["ready"],
      assigneeId: "ana",
      labels: ["feature"],
      claim: "claimed",
      updatedAfter: "2026-08-09T12:00:00Z",
      cursor: "opaque",
      limit: 20,
    });
    expect(page.nextCursor).toBe("tasks-next");
    expect(page.items[0]).toMatchObject({
      ref: { providerKey: PROVIDER_KEY, id: "CLAR-42" },
      title: "Implement Tasks",
      nativeState: { label: "To do" },
      priority: "high",
      labels: ["feature"],
      assignee: { label: "Ana" },
      claim: { claimant: { label: "Agent" } },
    });
    const ref = { providerKey: PROVIDER_KEY, id: "CLAR-42" };
    expect(await provider.get(ref)).toMatchObject({
      description: "Description",
      acceptanceCriteria: ["works"],
    });
    expect(await provider.searchActors!({ query: "Ana" })).toEqual({
      items: [{ id: "ana", label: "Ana", kind: "human" }],
    });
    await provider.create!({
      containerId: "CLAR",
      title: "Task",
      description: "Description",
      acceptanceCriteria: ["done"],
      priority: "high",
      assigneeId: "ana",
      labels: ["feature"],
      mutation,
    });
    await provider.assign!({ ref, assigneeId: null, mutation });
    await provider.transition!({
      ref,
      intent: "start",
      claimant: mutation.actor,
      reason: "begin",
      mutation,
    });
    await provider.comment!({ ref, body: "Evidence", mutation });
    await provider.attachArtifact!({
      ref,
      artifact: {
        kind: "pull_request",
        label: "PR",
        url: "https://example.test/pr/1",
        executionId: "exec-2",
      },
      mutation,
    });

    expect(
      port.calls.every(
        (call) =>
          (call.args.clarvis_context as { owner?: string }).owner === "owner-a" &&
          !JSON.stringify(call.args).includes(PROVIDER_KEY),
      ),
    ).toBeTrue();
    expect(port.calls[0]?.args).toEqual({ clarvis_context: { owner: "owner-a" } });
    expect(
      port.calls
        .slice(1)
        .every(
          (call) =>
            (call.args.clarvis_context as { provider_instance_id?: string })
              .provider_instance_id === wireCapabilities.provider_instance_id,
        ),
    ).toBeTrue();
    expect(
      port.calls.find((call) => call.tool === TASK_MCP_TOOLS.listContainers)?.args,
    ).toMatchObject({ query: "clar", limit: 50 });
    expect(port.calls.find((call) => call.tool === TASK_MCP_TOOLS.search)?.args).toMatchObject({
      container_id: "CLAR",
      updated_after: "2026-08-09T12:00:00Z",
      cursor: "opaque",
      limit: 20,
    });
    expect(port.calls.find((call) => call.tool === TASK_MCP_TOOLS.transition)?.args).toMatchObject({
      ref: { id: "CLAR-42" },
      intent: "start",
      mutation: {
        owner: "owner-a",
        execution_id: "exec-2",
        claim_execution_id: "exec-1",
        idempotency_key: "idem",
        expected_revision: "1",
      },
    });
  });

  it("creates only methods that capabilities advertise", async () => {
    const port = canonicalPort({
      [TASK_MCP_TOOLS.capabilities]: success({
        ...wireCapabilities,
        read: { ...wireCapabilities.read, actors: false },
        write: {
          create: false,
          assign: false,
          comment: false,
          attach_artifact: false,
          intents: [],
        },
        concurrency: "none",
      }),
    });
    const provider = await createMcpTaskProvider({
      owner: "owner",
      key: PROVIDER_KEY,
      port,
    });
    expect(typeof provider.searchActors).toBe("undefined");
    expect(typeof provider.create).toBe("undefined");
    expect(typeof provider.assign).toBe("undefined");
    expect(typeof provider.transition).toBe("undefined");
    expect(typeof provider.comment).toBe("undefined");
    expect(typeof provider.attachArtifact).toBe("undefined");
  });

  it("fails closed for malformed, operational, cancelled and domain errors without replay", async () => {
    await expect(
      probeMcpTaskCapabilities({
        owner: "owner",
        port: canonicalPort({ [TASK_MCP_TOOLS.capabilities]: undefined }),
      }),
    ).rejects.toMatchObject({ code: "task_invalid_response" });
    await expect(
      probeMcpTaskCapabilities({
        owner: "owner",
        port: canonicalPort({
          [TASK_MCP_TOOLS.capabilities]: {
            protocol_version: 2,
            provider_instance_id: wireCapabilities.provider_instance_id,
            ok: false,
            error: { code: "task_forbidden", message: "not allowed" },
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "task_forbidden" });

    const malformed = canonicalPort({ [TASK_MCP_TOOLS.get]: { protocol_version: 2, ok: true } });
    const provider = await createMcpTaskProvider({
      owner: "owner",
      key: PROVIDER_KEY,
      port: malformed,
      capabilities: fullCapabilities,
    });
    await expect(provider.get({ providerKey: PROVIDER_KEY, id: "CLAR-42" })).rejects.toMatchObject({
      code: "task_invalid_response",
    });
    await expect(provider.get({ providerKey: "other", id: "CLAR-42" })).rejects.toMatchObject({
      code: "task_provider_mismatch",
    });

    const mutationMalformed = canonicalPort({ [TASK_MCP_TOOLS.comment]: undefined });
    const mutationProvider = await createMcpTaskProvider({
      owner: "owner",
      key: PROVIDER_KEY,
      port: mutationMalformed,
      capabilities: fullCapabilities,
    });
    await expect(
      mutationProvider.comment!({
        ref: { providerKey: PROVIDER_KEY, id: "CLAR-42" },
        body: "once",
        mutation,
      }),
    ).rejects.toMatchObject({ code: "task_outcome_unknown" });
    expect(
      mutationMalformed.calls.filter((call) => call.tool === TASK_MCP_TOOLS.comment),
    ).toHaveLength(1);

    const domain = canonicalPort({
      [TASK_MCP_TOOLS.get]: {
        protocol_version: 2,
        provider_instance_id: wireCapabilities.provider_instance_id,
        ok: false,
        error: {
          code: "task_conflict",
          message: "\u001b[2Jchanged\u0007",
          current_revision: "18",
        },
      },
    });
    const domainProvider = await createMcpTaskProvider({
      owner: "owner",
      key: PROVIDER_KEY,
      port: domain,
      capabilities: fullCapabilities,
    });
    await expect(
      domainProvider.get({ providerKey: PROVIDER_KEY, id: "CLAR-42" }),
    ).rejects.toMatchObject({
      code: "task_conflict",
      message: "changed",
      currentRevision: "18",
    });

    for (const failure of [
      { kind: "cancelled", expected: "task_cancelled" },
      { kind: "unavailable", expected: "task_provider_unavailable" },
    ] as const) {
      const port: TaskServerPort = {
        callTool: async () => ({
          isError: true,
          message: "\u001b[2Jdown\u0007",
          failure: { kind: failure.kind },
        }),
      };
      const error = await probeMcpTaskCapabilities({ owner: "o", port }).catch((caught) => caught);
      expect(error).toBeInstanceOf(TaskProviderError);
      expect((error as TaskProviderError).code).toBe(failure.expected);
      expect((error as TaskProviderError).message).toBe("down");
    }

    for (const kind of ["timeout", "cancelled"] as const) {
      const unknownPort: TaskServerPort = {
        callTool: async () => ({
          isError: true,
          message: "request ended after send",
          failure: { kind, outcome: "unknown" },
        }),
      };
      const unknownProvider = await createMcpTaskProvider({
        owner: "o",
        key: PROVIDER_KEY,
        port: unknownPort,
        capabilities: fullCapabilities,
      });
      await expect(
        unknownProvider.assign!({
          ref: { providerKey: PROVIDER_KEY, id: "CLAR-42" },
          assigneeId: null,
          mutation,
        }),
      ).rejects.toMatchObject({ code: "task_outcome_unknown" });
    }
  });

  it("revalidates sanitized projections and keeps invalid mutation results uncertain", async () => {
    const emptiedDocument = { ...wireDocument, title: "\u009b" };
    const port = canonicalPort({
      [TASK_MCP_TOOLS.listContainers]: success({
        items: [{ id: "CLAR", label: "\u009b", kind: "project" }],
      }),
      [TASK_MCP_TOOLS.search]: success({
        items: [{ ...wireSummary, title: "\u009b" }],
      }),
      [TASK_MCP_TOOLS.get]: success(emptiedDocument),
      [TASK_MCP_TOOLS.searchActors]: success({
        items: [{ id: "ana", label: "\u009b", kind: "human" }],
      }),
      [TASK_MCP_TOOLS.comment]: success(emptiedDocument),
    });
    const provider = await createMcpTaskProvider({
      owner: "owner",
      key: PROVIDER_KEY,
      port,
      capabilities: fullCapabilities,
    });

    await expect(provider.listContainers({})).rejects.toMatchObject({
      code: "task_invalid_response",
    });
    await expect(provider.search({})).rejects.toMatchObject({ code: "task_invalid_response" });
    await expect(provider.get({ providerKey: PROVIDER_KEY, id: "CLAR-42" })).rejects.toMatchObject({
      code: "task_invalid_response",
    });
    await expect(provider.searchActors!({})).rejects.toMatchObject({
      code: "task_invalid_response",
    });
    await expect(
      provider.comment!({
        ref: { providerKey: PROVIDER_KEY, id: "CLAR-42" },
        body: "once",
        mutation,
      }),
    ).rejects.toMatchObject({ code: "task_outcome_unknown" });
  });

  it("pins the selected provider instance and validates requested task identity", async () => {
    await expect(
      probeMcpTaskCapabilities({
        owner: "owner",
        port: canonicalPort({
          [TASK_MCP_TOOLS.capabilities]: success(wireCapabilities, "different-instance"),
        }),
      }),
    ).rejects.toMatchObject({ code: "task_invalid_response" });

    const changedRead = canonicalPort({
      [TASK_MCP_TOOLS.get]: success(wireDocument, "replacement-instance"),
    });
    const readProvider = await createMcpTaskProvider({
      owner: "owner",
      key: PROVIDER_KEY,
      port: changedRead,
      capabilities: fullCapabilities,
    });
    await expect(
      readProvider.get({ providerKey: PROVIDER_KEY, id: "CLAR-42" }),
    ).rejects.toMatchObject({ code: "task_provider_mismatch" });

    const changedMutation = canonicalPort({
      [TASK_MCP_TOOLS.comment]: success(wireDocument, "replacement-instance"),
    });
    const mutationProvider = await createMcpTaskProvider({
      owner: "owner",
      key: PROVIDER_KEY,
      port: changedMutation,
      capabilities: fullCapabilities,
    });
    await expect(
      mutationProvider.comment!({
        ref: { providerKey: PROVIDER_KEY, id: "CLAR-42" },
        body: "once",
        mutation,
      }),
    ).rejects.toMatchObject({ code: "task_outcome_unknown" });

    const foreignDocument = { ...wireDocument, ref: { id: "OTHER-9" } };
    const wrongRef = canonicalPort({
      [TASK_MCP_TOOLS.get]: success(foreignDocument),
      [TASK_MCP_TOOLS.assign]: success(foreignDocument),
    });
    const wrongRefProvider = await createMcpTaskProvider({
      owner: "owner",
      key: PROVIDER_KEY,
      port: wrongRef,
      capabilities: fullCapabilities,
    });
    await expect(
      wrongRefProvider.get({ providerKey: PROVIDER_KEY, id: "CLAR-42" }),
    ).rejects.toMatchObject({ code: "task_invalid_response" });
    await expect(
      wrongRefProvider.assign!({
        ref: { providerKey: PROVIDER_KEY, id: "CLAR-42" },
        assigneeId: null,
        mutation,
      }),
    ).rejects.toMatchObject({ code: "task_outcome_unknown" });

    const callsBefore = wrongRef.calls.length;
    await expect(
      wrongRefProvider.assign!({
        ref: { providerKey: "another-provider", id: "CLAR-42" },
        assigneeId: null,
        mutation,
      }),
    ).rejects.toMatchObject({ code: "task_provider_mismatch" });
    expect(wrongRef.calls).toHaveLength(callsBefore);
  });

  it("rejects provider pages larger than the canonical maximum", async () => {
    const port = canonicalPort({
      [TASK_MCP_TOOLS.search]: success({
        items: Array.from({ length: 101 }, () => wireSummary),
      }),
    });
    const provider = await createMcpTaskProvider({
      owner: "owner",
      key: PROVIDER_KEY,
      port,
      capabilities: fullCapabilities,
    });

    await expect(provider.search({ limit: 100 })).rejects.toMatchObject({
      code: "task_invalid_response",
    });
  });

  it("forwards cancellation to the narrow port", async () => {
    const port = canonicalPort();
    const provider = await createMcpTaskProvider({
      owner: "owner",
      key: PROVIDER_KEY,
      port,
      capabilities: fullCapabilities,
    });
    const controller = new AbortController();
    await provider.search({}, controller.signal);
    expect(port.calls.at(-1)?.signal).toBe(controller.signal);
  });
});
