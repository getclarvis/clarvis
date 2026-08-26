/**
 * The operator-facing events `@clarvis/tasks` emits. Each case pins one
 * decision the package used to make with no error, no trace entry and no
 * message anywhere: a tool withheld from the toolset, a provider that did not
 * resolve, an adapter answer that did not project, and a write whose outcome
 * nobody knows.
 */
import { describe, expect, it } from "bun:test";
import type { AgentScope, RunCapability } from "@clarvis/capability";

import { TASK_GRANTS, TASK_TOOL_NAMES, createTasksCapability } from "../../src/capability.ts";
import {
  TASK_MCP_TOOLS,
  TaskProviderError,
  createMcpTaskProvider,
  probeMcpTaskCapabilities,
  type TaskProvider,
  type TaskProviderCapabilities,
  type TaskProviderResolution,
  type TaskServerPort,
} from "../../src/index.ts";
import { fullCapabilities, makeProvider, PROVIDER_KEY } from "../helpers/provider.ts";
import { buildContext, runContext, runRequest } from "../helpers/context.ts";
import { recordingLogger, type RecordingLogger } from "../helpers/recording-logger.ts";

const ALL_GRANTS = Object.values(TASK_GRANTS);

function resolutionOf(
  over: Partial<TaskProviderResolution> = {},
): TaskProviderResolution & { provider: ReturnType<typeof makeProvider> } {
  const capabilities = (over.capabilities ?? fullCapabilities) as TaskProviderCapabilities;
  return {
    provider: makeProvider({ capabilities }),
    capabilities,
    writes: "enabled",
    defaultContainer: "CLAR",
    server: "jira:tasks",
    ...over,
  } as TaskProviderResolution & { provider: ReturnType<typeof makeProvider> };
}

async function activate(options: {
  log: RecordingLogger;
  grants?: string[];
  task?: unknown;
  resolution?: TaskProviderResolution;
  resolveError?: Error;
}): Promise<RunCapability | null> {
  const selected = options.resolution ?? resolutionOf();
  const capability = createTasksCapability({
    logger: options.log.logger,
    resolver: {
      resolve: () =>
        options.resolveError ? Promise.reject(options.resolveError) : Promise.resolve(selected),
    },
  });
  const grants = options.grants ?? ALL_GRANTS;
  return capability.forRun(
    runContext({
      request: runRequest(grants),
      task: Object.hasOwn(options, "task")
        ? options.task
        : { id: "CLAR-42", provider_key: PROVIDER_KEY, mode: "work" },
    }),
  );
}

function scopeOf(grants: string[] = ALL_GRANTS): AgentScope {
  return { agent: "lead", entry: true, grants } as AgentScope;
}

/** Activate, attach the entry agent, and return the tool names it was given. */
async function selectTools(options: Parameters<typeof activate>[0]): Promise<Set<string>> {
  const run = await activate(options);
  if (run === null) throw new Error("expected Tasks activation");
  const agent = run.forAgent(scopeOf(options.grants ?? ALL_GRANTS));
  if (agent === null) return new Set();
  const contribution = agent.attach(buildContext());
  return new Set((contribution.tools ?? []).map((tool) => tool.wireName));
}

function gate(log: RecordingLogger, tool: string): Record<string, unknown> {
  const found = log.of("tasks.tool.gated").filter((record) => record.fields.tool === tool);
  if (found.length !== 1) {
    throw new Error(`expected exactly one gate for ${tool}, got ${String(found.length)}`);
  }
  return found[0]!.fields;
}

describe("tasks.tool.gated", () => {
  it("names the operator's disabled writes rather than silently omitting them", async () => {
    const log = recordingLogger();
    const tools = await selectTools({ log, resolution: resolutionOf({ writes: "disabled" }) });

    expect(tools).toEqual(new Set([TASK_TOOL_NAMES.list, TASK_TOOL_NAMES.read]));
    const record = log.of("tasks.tool.gated")[0]!;
    expect(record.level).toBe("info");
    expect(gate(log, TASK_TOOL_NAMES.create)).toMatchObject({
      gate: "writes_disabled",
      grant: TASK_GRANTS.create,
    });
    expect(gate(log, TASK_TOOL_NAMES.complete)).toMatchObject({
      gate: "writes_disabled",
      grant: TASK_GRANTS.complete,
      intent: "complete",
    });
  });

  it("names an inspect-mode binding as the reason a write is absent", async () => {
    const log = recordingLogger();
    const tools = await selectTools({
      log,
      task: { id: "CLAR-42", provider_key: PROVIDER_KEY, mode: "inspect" },
    });

    expect(tools.has(TASK_TOOL_NAMES.comment)).toBeFalse();
    expect(gate(log, TASK_TOOL_NAMES.comment).gate).toBe("inspect_mode");
    expect(gate(log, TASK_TOOL_NAMES.start).gate).toBe("inspect_mode");
  });

  it("names the missing grant, for reads as well as writes", async () => {
    const log = recordingLogger();
    const tools = await selectTools({ log, grants: [TASK_GRANTS.create] });

    expect(tools).toEqual(new Set([TASK_TOOL_NAMES.create]));
    expect(gate(log, TASK_TOOL_NAMES.read)).toMatchObject({
      gate: "missing_grant",
      grant: TASK_GRANTS.read,
    });
    expect(gate(log, TASK_TOOL_NAMES.list).gate).toBe("missing_grant");
    expect(gate(log, TASK_TOOL_NAMES.assign).gate).toBe("missing_grant");
  });

  it("names an operation the provider never advertised, and the intent behind it", async () => {
    const log = recordingLogger();
    const capabilities: TaskProviderCapabilities = {
      ...fullCapabilities,
      write: { ...fullCapabilities.write, create: false, intents: ["start"] },
    };
    const tools = await selectTools({ log, resolution: resolutionOf({ capabilities }) });

    expect(tools.has(TASK_TOOL_NAMES.create)).toBeFalse();
    expect(tools.has(TASK_TOOL_NAMES.start)).toBeTrue();
    expect(gate(log, TASK_TOOL_NAMES.create).gate).toBe("not_advertised");
    expect(gate(log, TASK_TOOL_NAMES.review)).toMatchObject({
      gate: "not_advertised",
      intent: "submit_review",
    });
  });

  it("says nothing about a lifecycle tool when no task is bound at all", async () => {
    const log = recordingLogger();
    await selectTools({ log, task: undefined, grants: [TASK_GRANTS.read, TASK_GRANTS.create] });

    expect(log.of("tasks.tool.gated").map((record) => record.fields.tool)).not.toContain(
      TASK_TOOL_NAMES.start,
    );
  });
});

describe("tasks.provider.unresolved", () => {
  it("reports the resolution failure that silently keeps Tasks inactive", async () => {
    const log = recordingLogger();
    const run = await activate({
      log,
      task: undefined,
      resolveError: new TaskProviderError("task_provider_unavailable", "the server is down"),
    });

    expect(run).toBeNull();
    const record = log.one("tasks.provider.unresolved");
    expect(record.level).toBe("warn");
    expect(record.fields.owner).toBe("owner-a");
    expect(record.fields.code).toBe("task_provider_unavailable");
    expect(record.fields.cause).toContain("the server is down");
    expect(record.fields.requested_key).toBeUndefined();
  });

  it("classifies a non-provider throw under the unavailable code", async () => {
    const log = recordingLogger();
    expect(await activate({ log, task: undefined, resolveError: new Error("boom") })).toBeNull();
    expect(log.one("tasks.provider.unresolved").fields.code).toBe("task_provider_unavailable");
  });

  it("stays silent when the run asked for a task, because the error is raised instead", async () => {
    const log = recordingLogger();
    await expect(
      activate({ log, resolveError: new TaskProviderError("task_forbidden", "no") }),
    ).rejects.toThrow("no");
    expect(log.of("tasks.provider.unresolved")).toHaveLength(0);
  });
});

describe("tasks.outcome_unknown", () => {
  async function commentAgainst(log: RecordingLogger, provider: TaskProvider): Promise<void> {
    const selected = { ...resolutionOf(), provider } as TaskProviderResolution;
    const run = await activate({ log, resolution: selected });
    const contribution = run!.forAgent(scopeOf())!.attach(buildContext());
    await contribution.handlers![0]!.handle(
      { id: "call-1", name: TASK_TOOL_NAMES.comment, arguments: { body: "once" } },
      1,
    );
  }

  it("is loud, and says the recovery re-read succeeded", async () => {
    const log = recordingLogger();
    const provider = makeProvider();
    provider.failNext("comment", new TaskProviderError("task_outcome_unknown", "response lost"));
    await commentAgainst(log, provider);

    const record = log.one("tasks.outcome_unknown");
    expect(record.level).toBe("error");
    expect(record.fields.task_id).toBe("CLAR-42");
    expect(record.fields.operation).toBe("comment");
    expect(String(record.fields.idempotency_digest)).toHaveLength(16);
    expect(record.fields.reread_ok).toBe(true);
    expect(record.fields.reread_error).toBeUndefined();
  });

  it("carries the recovery re-read's own failure, which was swallowed entirely", async () => {
    const log = recordingLogger();
    const inner = makeProvider();
    inner.failNext("comment", new TaskProviderError("task_outcome_unknown", "response lost"));
    let written = false;
    const provider: TaskProvider = {
      ...inner,
      comment: async (input) => {
        written = true;
        return inner.comment!(input);
      },
      get: async (ref) => {
        if (written) throw new TaskProviderError("task_provider_unavailable", "re-read refused");
        return inner.get(ref);
      },
    };
    await commentAgainst(log, provider);

    const record = log.one("tasks.outcome_unknown");
    expect(record.fields.reread_ok).toBe(false);
    expect(record.fields.reread_error).toContain("re-read refused");
    expect(record.message).toContain("a human must check");
  });

  it("is loud for a create, which has no id to re-read by", async () => {
    const log = recordingLogger();
    const provider = makeProvider();
    provider.failNext("create", new TaskProviderError("task_outcome_unknown", "response lost"));
    const run = await activate({ log, resolution: { ...resolutionOf(), provider } });
    const contribution = run!.forAgent(scopeOf())!.attach(buildContext());
    await contribution.handlers![0]!.handle(
      {
        id: "call-create",
        name: TASK_TOOL_NAMES.create,
        arguments: { title: "New work", container_id: "CLAR" },
      },
      1,
    );

    const record = log.one("tasks.outcome_unknown");
    expect(record.level).toBe("error");
    expect(record.fields.operation).toBe("create");
    expect(record.fields.task_id).toBe("new");
    expect(record.fields.reread_ok).toBe(false);
    expect(record.message).toContain("no id to re-read");
  });

  it("stays silent for a plain conflict, whose outcome is known", async () => {
    const log = recordingLogger();
    const provider = makeProvider();
    provider.failNext("comment", new TaskProviderError("task_conflict", "moved on"));
    await commentAgainst(log, provider);

    expect(log.of("tasks.outcome_unknown")).toHaveLength(0);
  });
});

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
  container: { id: "CLAR", label: "Clarvis", kind: "project" },
  title: "Implement Tasks",
  stage: "ready",
  native_state: { id: "todo", label: "To do" },
  labels: ["feature"],
  updated_at: "2026-08-09T12:00:00Z",
  revision: "1",
  description: "Description",
  acceptance_criteria: ["works"],
  available_intents: ["start", "block", "submit_review", "complete", "reopen"],
};

function envelope(result: unknown): unknown {
  return {
    protocol_version: 2,
    provider_instance_id: wireCapabilities.provider_instance_id,
    ok: true,
    result,
  };
}

function portWith(over: Record<string, unknown> = {}): TaskServerPort {
  const results: Record<string, unknown> = {
    [TASK_MCP_TOOLS.capabilities]: envelope(wireCapabilities),
    [TASK_MCP_TOOLS.get]: envelope(wireDocument),
    ...over,
  };
  return {
    callTool: (tool) => Promise.resolve({ data: results[tool], isError: false }),
  };
}

describe("tasks.provider.call", () => {
  it("reports a successful call, with its provider instance and no arguments", async () => {
    const log = recordingLogger();
    const provider = await createMcpTaskProvider({
      owner: "owner-a",
      key: PROVIDER_KEY,
      port: portWith(),
      logger: log.logger,
    });
    await provider.get({ providerKey: PROVIDER_KEY, id: "CLAR-42" });

    const record = log.of("tasks.provider.call").at(-1)!;
    expect(record.level).toBe("debug");
    expect(record.fields.tool).toBe(TASK_MCP_TOOLS.get);
    expect(record.fields.ok).toBe(true);
    expect(record.fields.provider_instance_id).toBe("fixture-instance");
    expect(typeof record.fields.duration_ms).toBe("number");
    expect(JSON.stringify(record.fields)).not.toContain("clarvis_context");
  });

  it("samples a repeated call rather than writing one line each", async () => {
    const log = recordingLogger();
    const provider = await createMcpTaskProvider({
      owner: "owner-a",
      key: PROVIDER_KEY,
      port: portWith(),
      logger: log.logger,
      capabilities: { ...fullCapabilities, providerKind: "jira" },
    });
    for (let i = 0; i < 20; i += 1) {
      await provider.get({ providerKey: PROVIDER_KEY, id: "CLAR-42" });
    }

    const emitted = log
      .of("tasks.provider.call")
      .filter((r) => r.fields.tool === TASK_MCP_TOOLS.get);
    expect(emitted).toHaveLength(9);
  });

  it("reports a domain refusal and a transport throw with their codes", async () => {
    const log = recordingLogger();
    const provider = await createMcpTaskProvider({
      owner: "owner-a",
      key: PROVIDER_KEY,
      capabilities: { ...fullCapabilities, providerKind: "jira" },
      logger: log.logger,
      port: {
        callTool: (tool) =>
          tool === TASK_MCP_TOOLS.get
            ? Promise.resolve({
                data: {
                  protocol_version: 2,
                  provider_instance_id: "fixture-instance",
                  ok: false,
                  error: { code: "task_not_found", message: "gone" },
                },
                isError: false,
              })
            : Promise.reject(new Error("socket closed")),
      },
    });

    await expect(provider.get({ providerKey: PROVIDER_KEY, id: "CLAR-42" })).rejects.toThrow(
      "gone",
    );
    expect(log.of("tasks.provider.call").at(-1)!.fields).toMatchObject({
      ok: false,
      code: "task_not_found",
    });

    await expect(provider.search({ query: "x" })).rejects.toThrow("socket closed");
    expect(log.of("tasks.provider.call").at(-1)!.fields).toMatchObject({
      ok: false,
      code: "transport_error",
    });
  });

  it("reports an isError response, whose code the transport decides", async () => {
    const log = recordingLogger();
    const provider = await createMcpTaskProvider({
      owner: "owner-a",
      key: PROVIDER_KEY,
      capabilities: { ...fullCapabilities, providerKind: "jira" },
      logger: log.logger,
      port: {
        callTool: () =>
          Promise.resolve({
            isError: true,
            message: "tool failed",
            failure: { kind: "operational" },
          }),
      },
    });

    await expect(provider.get({ providerKey: PROVIDER_KEY, id: "CLAR-42" })).rejects.toThrow();
    expect(log.of("tasks.provider.call").at(-1)!.fields.code).toBe("task_provider_unavailable");
  });

  it("reports a provider instance that changed under a live binding", async () => {
    const log = recordingLogger();
    let first = true;
    const provider = await createMcpTaskProvider({
      owner: "owner-a",
      key: PROVIDER_KEY,
      logger: log.logger,
      port: {
        callTool: (tool) => {
          if (tool === TASK_MCP_TOOLS.capabilities) {
            return Promise.resolve({ data: envelope(wireCapabilities), isError: false });
          }
          const id = first ? "fixture-instance" : "someone-else";
          first = false;
          return Promise.resolve({
            data: { protocol_version: 2, provider_instance_id: id, ok: true, result: wireDocument },
            isError: false,
          });
        },
      },
    });
    await provider.get({ providerKey: PROVIDER_KEY, id: "CLAR-42" });

    await expect(provider.get({ providerKey: PROVIDER_KEY, id: "CLAR-42" })).rejects.toThrow(
      "instance changed",
    );
    expect(log.of("tasks.provider.call").at(-1)!.fields).toMatchObject({
      ok: false,
      code: "task_provider_mismatch",
      provider_instance_id: "someone-else",
    });
  });
});

describe("tasks.provider.invalid_response", () => {
  it("names the field paths that failed, and never the values behind them", async () => {
    const log = recordingLogger();
    const provider = await createMcpTaskProvider({
      owner: "owner-a",
      key: PROVIDER_KEY,
      capabilities: { ...fullCapabilities, providerKind: "jira" },
      logger: log.logger,
      port: portWith({
        [TASK_MCP_TOOLS.get]: envelope({
          ...wireDocument,
          title: 17,
          url: "gopher://leaks.example/secret-token",
        }),
      }),
    });

    await expect(provider.get({ providerKey: PROVIDER_KEY, id: "CLAR-42" })).rejects.toThrow(
      "invalid response",
    );
    const record = log.one("tasks.provider.invalid_response");
    expect(record.level).toBe("warn");
    expect(record.fields.tool).toBe(TASK_MCP_TOOLS.get);
    expect(record.fields.zod_issues).toContain("result.title");
    expect(JSON.stringify(record.fields)).not.toContain("secret-token");
    expect(record.fields.outcome).toBeUndefined();
  });

  it("says a write's outcome is unknown when its answer did not project", async () => {
    const log = recordingLogger();
    const provider = await createMcpTaskProvider({
      owner: "owner-a",
      key: PROVIDER_KEY,
      capabilities: { ...fullCapabilities, providerKind: "jira" },
      logger: log.logger,
      port: portWith({ [TASK_MCP_TOOLS.comment]: { not: "an envelope" } }),
    });

    await expect(
      provider.comment!({
        ref: { providerKey: PROVIDER_KEY, id: "CLAR-42" },
        body: "hello",
        mutation: {
          owner: "owner-a",
          actor: { id: "agent", label: "Agent", kind: "agent" },
          idempotencyKey: "idem",
        },
      }),
    ).rejects.toThrow("invalid response");

    const record = log.one("tasks.provider.invalid_response");
    expect(record.fields.outcome).toBe("unknown");
    expect(record.fields.zod_issues).toContain("ok");
  });

  it("reports the envelope root when the answer is not an object at all", async () => {
    const log = recordingLogger();
    const provider = await createMcpTaskProvider({
      owner: "owner-a",
      key: PROVIDER_KEY,
      capabilities: { ...fullCapabilities, providerKind: "jira" },
      logger: log.logger,
      port: portWith({ [TASK_MCP_TOOLS.get]: "not even an object" }),
    });

    await expect(provider.get({ providerKey: PROVIDER_KEY, id: "CLAR-42" })).rejects.toThrow(
      "invalid response",
    );
    expect(log.one("tasks.provider.invalid_response").fields.zod_issues).toEqual(["<root>"]);
  });

  it("reports a probe whose capability envelope does not project", async () => {
    const log = recordingLogger();
    await expect(
      probeMcpTaskCapabilities({
        owner: "owner-a",
        logger: log.logger,
        port: portWith({
          [TASK_MCP_TOOLS.capabilities]: envelope({ ...wireCapabilities, protocol_version: 3 }),
        }),
      }),
    ).rejects.toThrow("invalid response");
    expect(log.one("tasks.provider.invalid_response").fields.tool).toBe(
      TASK_MCP_TOOLS.capabilities,
    );
  });
});
