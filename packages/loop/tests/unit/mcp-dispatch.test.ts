import { describe, it, expect } from "../bun-test.ts";
import { createTrace } from "@clarvis/trace";
import { buildRegistry } from "../../src/runtime/tools/mcp-registry.ts";
import { createConvergenceGuards } from "../../src/runtime/guards/convergence-guards.ts";
import { executeMcpToolCall, createToolArgValidator } from "../../src/runtime/tools/index.ts";
import { buildMcpHandler } from "../../src/runtime/loop/mcp-handler.ts";
import type { LLMToolCall } from "@clarvis/capability";
import type { NamespacedRegistry, MCPConnection, ToolResult } from "@clarvis/capability";

function call(over: Partial<LLMToolCall> = {}): LLMToolCall {
  return { id: "c1", name: "srv.tool", arguments: {}, ...over };
}

function conn(status: MCPConnection["status"], result: ToolResult): MCPConnection {
  return {
    name: "srv",
    transport: "stdio",
    status,
    callTool: async (): Promise<ToolResult> => result,
    close: async (): Promise<void> => {},
  };
}

function registry(status: MCPConnection["status"], result: ToolResult): NamespacedRegistry {
  return buildRegistry(
    [{ conn: conn(status, result), tools: [{ name: "tool", inputSchema: { type: "object" } }] }],
    [],
  );
}

function dispatchArgs(over: Partial<Parameters<typeof executeMcpToolCall>[0]>) {
  return {
    call: call(),
    registry: registry("connected", { ok: true, data: "ok" }),
    availableWireNames: ["srv.tool"],
    argValidator: createToolArgValidator(),
    guards: createConvergenceGuards(),
    trace: createTrace(),
    agent: "subagent" as const,
    iteration: 1,
    ...over,
  };
}

describe("executeMcpToolCall", () => {
  it("reports an unknown tool with the available list and is non-productive", async () => {
    const res = await executeMcpToolCall(dispatchArgs({ call: call({ name: "nope" }) }));
    expect(res.productive).toBe(false);
    expect(res.errText).toContain("Unknown tool 'nope'");
    expect(res.errText).toContain("srv.tool");
  });

  it("surfaces a validation error as a NON-productive failure (no tool ran, so no progress)", async () => {
    const reg = buildRegistry(
      [
        {
          conn: conn("connected", { ok: true, data: "ok" }),
          tools: [
            {
              name: "tool",
              inputSchema: {
                type: "object",
                properties: { p: { type: "string" } },
                required: ["p"],
              },
            },
          ],
        },
      ],
      [],
    );
    const res = await executeMcpToolCall(
      dispatchArgs({ registry: reg, call: call({ arguments: {} }) }),
    );
    expect(res.productive).toBe(false);
    expect(res.errText).toContain("InputValidationError");
  });

  it("returns the stringified data on a successful call", async () => {
    const trace = createTrace();
    const res = await executeMcpToolCall(
      dispatchArgs({ trace, registry: registry("connected", { ok: true, data: { a: 1 } }) }),
    );
    expect(res.productive).toBe(true);
    expect(res.errText).toBeNull();
    expect(res.resultText).toContain('"a":1');
    expect(res.images).toBeUndefined();
    expect(trace.entries().some((e) => e.kind === "tool_call_started")).toBe(true);
  });

  it("extracts an MCP image content block and keeps its base64 out of the model-facing text", async () => {
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQ";
    const data = {
      content: [
        { type: "text", text: "here is the chart" },
        { type: "image", data: b64, mimeType: "image/png" },
      ],
    };
    const res = await executeMcpToolCall(
      dispatchArgs({ registry: registry("connected", { ok: true, data }) }),
    );
    expect(res.productive).toBe(true);
    expect(res.images).toEqual([{ data: b64, mediaType: "image/png" }]);
    expect(res.resultText).toContain("here is the chart");
    expect(res.resultText).not.toContain(b64);
    expect(res.resultText).toContain("delivered as an image block");
  });

  it("treats an mcp_unavailable error as non-productive", async () => {
    const res = await executeMcpToolCall(
      dispatchArgs({
        registry: registry("connected", {
          ok: false,
          error: { code: "mcp_unavailable", message: "down" },
        }),
      }),
    );
    expect(res.productive).toBe(false);
    expect(res.errText).toBe("down");
  });

  it("treats other tool errors as productive and defaults a missing message", async () => {
    const res = await executeMcpToolCall(
      dispatchArgs({
        registry: registry("connected", {
          ok: false,
          error: { code: "mcp_runtime_error" },
        } as unknown as ToolResult),
      }),
    );
    expect(res.productive).toBe(true);
    expect(res.errText).toBe("tool execution failed");
  });

  it("synthesises a call id when the call has none", async () => {
    const trace = createTrace();
    await executeMcpToolCall(dispatchArgs({ trace, call: call({ id: "" }) }));
    const started = trace.entries().find((e) => e.kind === "tool_call_started")?.detail as
      Record<string, unknown> | undefined;
    expect(typeof started?.call_id).toBe("string");
    expect((started?.call_id as string).length).toBeGreaterThan(0);
  });

  it("includes a subagent_instance_id in records when supplied", async () => {
    const trace = createTrace();
    await executeMcpToolCall(dispatchArgs({ trace, subagentInstanceId: "wk" }));
    const detail = trace.entries().find((e) => e.kind === "tool_call")?.detail as unknown as Record<
      string,
      unknown
    >;
    expect(detail.subagent_instance_id).toBe("wk");
  });

  it("routes a resource_read tool to conn.readResource (not callTool) with the uri", async () => {
    let readUri: string | undefined;
    const resourceConn: MCPConnection = {
      name: "srv",
      transport: "stdio",
      status: "connected",
      callTool: async (): Promise<ToolResult> => {
        throw new Error("callTool must not be used for a resource tool");
      },
      readResource: async (uri: string): Promise<ToolResult> => {
        readUri = uri;
        return { ok: true, data: { content: [{ type: "text", text: "resource body" }] } };
      },
      close: async (): Promise<void> => {},
    };
    const reg = buildRegistry(
      [
        {
          conn: resourceConn,
          tools: [
            {
              name: "read_resource",
              inputSchema: {
                type: "object",
                properties: { uri: { type: "string" } },
                required: ["uri"],
              },
              kind: "resource_read",
            },
          ],
        },
      ],
      [],
    );
    const res = await executeMcpToolCall(
      dispatchArgs({
        registry: reg,
        availableWireNames: ["srv.read_resource"],
        call: call({ name: "srv.read_resource", arguments: { uri: "docs://x" } }),
      }),
    );
    expect(readUri).toBe("docs://x");
    expect(res.productive).toBe(true);
    expect(res.resultText).toContain("resource body");
  });

  it("routes a resource_list tool to conn.listResources (not callTool)", async () => {
    let listed = false;
    const resourceConn: MCPConnection = {
      name: "srv",
      transport: "stdio",
      status: "connected",
      callTool: async (): Promise<ToolResult> => {
        throw new Error("callTool must not be used for a resource tool");
      },
      listResources: async (): Promise<ToolResult> => {
        listed = true;
        return { ok: true, data: { content: [{ type: "text", text: "the catalog" }] } };
      },
      close: async (): Promise<void> => {},
    };
    const reg = buildRegistry(
      [
        {
          conn: resourceConn,
          tools: [
            { name: "list_resources", inputSchema: { type: "object" }, kind: "resource_list" },
          ],
        },
      ],
      [],
    );
    const res = await executeMcpToolCall(
      dispatchArgs({
        registry: reg,
        availableWireNames: ["srv.list_resources"],
        call: call({ name: "srv.list_resources", arguments: {} }),
      }),
    );
    expect(listed).toBe(true);
    expect(res.resultText).toContain("the catalog");
  });
});

describe("buildMcpHandler", () => {
  it("derives the unknown-tool availability list from the registry", async () => {
    const available = registry("connected", { ok: true, data: "ok" });
    const handler = buildMcpHandler({
      base: { trace: createTrace(), agent: "subagent" },
      registry: available,
      argValidator: createToolArgValidator(),
      guards: createConvergenceGuards(),
      progress: (result) => result.errText === null,
    });

    const verdict = await handler.handle(call({ name: "nope" }), 1);
    expect(verdict.kind).toBe("result");
    if (verdict.kind === "result") {
      expect(verdict.text).toContain("Unknown tool 'nope'");
      expect(verdict.text).toContain("Available tools: tool");
    }
  });
});

describe("executeMcpToolCall trace", () => {
  function toolCallDetail(trace: ReturnType<typeof createTrace>): Record<string, unknown> {
    const entry = trace.entries().find((e) => e.kind === "tool_call");
    return (entry?.detail ?? {}) as Record<string, unknown>;
  }

  it("records what ran and what the model asked, when a hook rewrote the call", async () => {
    const trace = createTrace();
    await executeMcpToolCall(
      dispatchArgs({ call: call({ arguments: { a: 2 }, rewrittenFrom: { a: 1 } }), trace }),
    );
    expect(toolCallDetail(trace)).toMatchObject({
      arguments: { a: 2 },
      arguments_original: { a: 1 },
    });
  });

  it("omits arguments_original when nothing rewrote the call", async () => {
    const trace = createTrace();
    await executeMcpToolCall(dispatchArgs({ call: call({ arguments: { a: 1 } }), trace }));
    expect(toolCallDetail(trace)).not.toHaveProperty("arguments_original");
  });
});
