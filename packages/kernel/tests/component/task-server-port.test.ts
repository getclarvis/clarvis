import { describe, expect, it } from "bun:test";
import type { McpServerConfig, ToolResult } from "@clarvis/capability";
import { createTaskServerPort, type TaskServerPortDeps } from "../../src/tasks/task-server-port.ts";

const SERVER = {
  name: "jira-work:tasks",
  transport: "http",
  url: "https://tasks.example/mcp",
  headers: { Authorization: "Bearer shared-service-credential" },
} as McpServerConfig;

function pool(answer: ToolResult | Error) {
  const acquisitions: Parameters<TaskServerPortDeps["connections"]["acquire"]>[0][] = [];
  const calls: { tool: string; args: unknown; signal?: AbortSignal }[] = [];
  let released = 0;
  const connections: TaskServerPortDeps["connections"] = {
    async acquire(options) {
      acquisitions.push(options);
      return {
        conn: {
          async callTool(tool, args, signal) {
            calls.push({ tool, args, ...(signal === undefined ? {} : { signal }) });
            if (answer instanceof Error) throw answer;
            return answer;
          },
        },
        release: async () => {
          released += 1;
        },
      };
    },
  };
  return { connections, acquisitions, calls, released: () => released };
}

describe("createTaskServerPort", () => {
  it("acquires and releases an owner-isolated lease for every call", async () => {
    const p = pool({
      ok: true,
      data: { structuredContent: { protocol_version: 2, ok: true, result: {} }, text: "ignored" },
    });
    const resolver = createTaskServerPort({ connections: p.connections });

    await resolver
      .forOwner("alice", { server: "jira-work:tasks", declaration: SERVER })
      .callTool("tasks_get", { id: "A" });
    await resolver
      .forOwner("bob", { server: "jira-work:tasks", declaration: SERVER })
      .callTool("tasks_get", { id: "B" });

    expect(p.acquisitions.map(({ owner, poolSharing }) => ({ owner, poolSharing }))).toEqual([
      { owner: "alice", poolSharing: "owner" },
      { owner: "bob", poolSharing: "owner" },
    ]);
    expect(p.calls.map(({ args }) => args)).toEqual([{ id: "A" }, { id: "B" }]);
    expect(p.released()).toBe(2);
  });

  it("forwards only structured content and the cancellation signal", async () => {
    const p = pool({
      ok: true,
      data: {
        content: [{ type: "text", text: "do not parse me" }],
        structuredContent: { protocol_version: 2, ok: true, result: { id: "CLAR-42" } },
      },
    });
    const controller = new AbortController();
    const result = await createTaskServerPort({ connections: p.connections })
      .forOwner("alice", { server: "jira-work:tasks", declaration: SERVER })
      .callTool("tasks_get", {}, controller.signal);

    expect(result).toEqual({
      data: { protocol_version: 2, ok: true, result: { id: "CLAR-42" } },
      isError: false,
    });
    expect(p.acquisitions[0]?.signal).toBe(controller.signal);
    expect(p.calls[0]?.signal).toBe(controller.signal);
  });

  it("preserves operational failure classes and unknown mutation outcomes", async () => {
    const p = pool({
      ok: false,
      error: {
        code: "mcp_timeout",
        message: "timed out after send",
        kind: "timeout",
        outcome: "unknown",
      },
    });
    const result = await createTaskServerPort({ connections: p.connections })
      .forOwner("alice", { server: "jira-work:tasks", declaration: SERVER })
      .callTool("tasks_comment", {});

    expect(result).toEqual({
      isError: true,
      message: "timed out after send",
      failure: { kind: "timeout", outcome: "unknown" },
    });
    expect(p.released()).toBe(1);
  });

  it("fails closed for an invalid captured binding and releases after a thrown call", async () => {
    const absent = pool({ ok: true });
    await expect(
      createTaskServerPort({ connections: absent.connections })
        .forOwner("alice", { server: "missing", declaration: null })
        .callTool("tasks_get", {}),
    ).resolves.toEqual({
      isError: true,
      message: "the MCP binding for 'missing' is invalid",
      failure: { kind: "unavailable" },
    });
    expect(absent.acquisitions).toEqual([]);

    const thrown = pool(new Error("connection reset"));
    const result = await createTaskServerPort({ connections: thrown.connections })
      .forOwner("alice", { server: "jira-work:tasks", declaration: SERVER })
      .callTool("tasks_get", {});
    expect(result).toMatchObject({
      isError: true,
      failure: { kind: "unavailable", outcome: "unknown" },
    });
    expect(thrown.released()).toBe(1);
  });

  it("does not replace a known tool result with a secondary lease-release failure", async () => {
    const resolver = createTaskServerPort({
      connections: {
        async acquire() {
          return {
            conn: {
              async callTool() {
                return {
                  ok: true,
                  data: { structuredContent: { protocol_version: 2, ok: true, result: {} } },
                };
              },
            },
            release: async () => {
              throw new Error("release failed");
            },
          };
        },
      },
    });

    await expect(
      resolver
        .forOwner("alice", { server: "jira-work:tasks", declaration: SERVER })
        .callTool("tasks_comment", {}),
    ).resolves.toEqual({
      data: { protocol_version: 2, ok: true, result: {} },
      isError: false,
    });
  });
});
