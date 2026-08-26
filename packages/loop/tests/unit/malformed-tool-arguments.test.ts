import { describe, expect, it } from "../bun-test.ts";
import type { LLMToolCall, TraceKind, TracePort } from "@clarvis/capability";
import { executeAgentToolCall } from "../../src/runtime/tools/builtin/execute-agent-tool-call.ts";
import { executeMcpToolCall, createToolArgValidator } from "../../src/runtime/tools/index.ts";
import { buildRegistry } from "../../src/runtime/tools/mcp-registry.ts";
import type { AgentToolset } from "../../src/runtime/tools/builtin/toolset.ts";
import type { ConvergenceGuards } from "../../src/runtime/guards/convergence-guards.ts";
import type { MCPConnection, ToolResult } from "@clarvis/capability";

interface Recorded {
  kind: TraceKind;
  detail: Record<string, unknown>;
}

function makeTrace(): { port: TracePort; entries: Recorded[] } {
  const entries: Recorded[] = [];
  const port = {
    now: () => 0,
    record: (kind: TraceKind, detail: unknown) => {
      entries.push({ kind, detail: detail as Record<string, unknown> });
    },
    signal: () => undefined,
  } as unknown as TracePort;
  return { port, entries };
}

function makeGuards(): { guards: ConvergenceGuards; signatures: string[] } {
  const signatures: string[] = [];
  const guards = {
    record: (signature: string) => {
      signatures.push(signature);
    },
    takeSoft: () => [],
    tripped: () => null,
    reset: () => undefined,
  } as unknown as ConvergenceGuards;
  return { guards, signatures };
}

function makeToolset(): { toolset: AgentToolset; dispatched: unknown[] } {
  const dispatched: unknown[] = [];
  const toolset: AgentToolset = {
    defs: [],
    names: new Set(["shell"]),
    dispatch: (_name, args) => {
      dispatched.push(args);
      return Promise.resolve({ isError: false, text: "ran" });
    },
  };
  return { toolset, dispatched };
}

function call(over: Partial<LLMToolCall> = {}): LLMToolCall {
  return { id: "c1", name: "shell", arguments: {}, ...over };
}

/**
 * The defect this pins: a provider returned `shell` arguments as a JSON string
 * cut mid-value, the engine replaced any non-object payload with `{}` and
 * dispatched it, and @clarvis/tools answered "data must have required property
 * 'command'" — a statement about a property the model had in fact sent. The
 * model re-sent the identical call and the run died in the convergence guard.
 */
describe("a tool call whose arguments did not survive the provider round-trip", () => {
  it("is refused rather than dispatched with fabricated empty arguments", async () => {
    const { port } = makeTrace();
    const { guards } = makeGuards();
    const { toolset, dispatched } = makeToolset();

    const res = await executeAgentToolCall({
      call: call({ malformedArguments: '{"command":"npm test 2>' }),
      toolset,
      guards,
      trace: port,
      agent: "lead",
      iteration: 1,
    });

    expect(dispatched).toEqual([]);
    expect(res.errText).not.toBeNull();
    expect(res.productive).toBe(false);
  });

  it("tells the model what arrived instead of naming a property it did send", async () => {
    const { port } = makeTrace();
    const { guards } = makeGuards();
    const { toolset } = makeToolset();

    const res = await executeAgentToolCall({
      call: call({ malformedArguments: '{"command":"npm test 2>' }),
      toolset,
      guards,
      trace: port,
      agent: "lead",
      iteration: 1,
    });

    expect(res.errText).toContain('{"command":"npm test 2>');
    expect(res.errText).not.toContain("required property");
  });

  it("persists what arrived, so the trace does not disagree with the run", async () => {
    const { port, entries } = makeTrace();
    const { guards } = makeGuards();
    const { toolset } = makeToolset();

    await executeAgentToolCall({
      call: call({ malformedArguments: '{"command":"npm test 2>' }),
      toolset,
      guards,
      trace: port,
      agent: "lead",
      iteration: 1,
    });

    const toolCall = entries.find((e) => e.kind === "tool_call");
    expect(toolCall?.detail.arguments).toEqual({
      malformed_arguments: '{"command":"npm test 2>',
    });
  });

  // With `arguments` normalized to `{}` upstream, a signature built from it alone
  // would read every malformed call as the same call, and the doom-loop guard
  // (identicalThreshold 3) would terminate the run faster than before rather than
  // slower. The payload has to be what distinguishes them.
  it("keeps two differently-truncated payloads distinct to the convergence guard", async () => {
    const { port } = makeTrace();
    const { guards, signatures } = makeGuards();
    const { toolset } = makeToolset();

    for (const preview of ['{"command":"npm test 2>', '{"command":"npm test -- src/domain 2>']) {
      await executeAgentToolCall({
        call: call({ malformedArguments: preview }),
        toolset,
        guards,
        trace: port,
        agent: "lead",
        iteration: 1,
      });
    }

    expect(signatures).toHaveLength(2);
    expect(signatures[0]).not.toBe(signatures[1]);
  });

  it("dispatches a well-formed call untouched", async () => {
    const { port } = makeTrace();
    const { guards } = makeGuards();
    const { toolset, dispatched } = makeToolset();

    const res = await executeAgentToolCall({
      call: call({ arguments: { command: "bun test" } }),
      toolset,
      guards,
      trace: port,
      agent: "lead",
      iteration: 1,
    });

    expect(dispatched).toEqual([{ command: "bun test" }]);
    expect(res.errText).toBeNull();
    expect(res.productive).toBe(true);
  });
});

function mcpCall(over: Partial<LLMToolCall> = {}): LLMToolCall {
  return { id: "c1", name: "srv.tool", arguments: {}, ...over };
}

function makeConnection(): { conn: MCPConnection; dispatched: unknown[] } {
  const dispatched: unknown[] = [];
  const conn: MCPConnection = {
    name: "srv",
    transport: "stdio",
    status: "connected",
    callTool: async (_tool, args): Promise<ToolResult> => {
      dispatched.push(args);
      return { ok: true, data: "ran" };
    },
    close: async (): Promise<void> => {},
  };
  return { conn, dispatched };
}

/**
 * The MCP mirror of the defect above. `specs/foundations/capability.md` §4.6 states that *both*
 * dispatchers refuse a malformed call and build the guard signature from the
 * preview; only the built-in one did. With `arguments` normalized to `{}`
 * upstream, every truncated MCP payload collapsed to the same signature and the
 * doom-loop guard ended the run faster than the bug it was reporting, while the
 * trace claimed the model had sent nothing at all.
 */
describe("an MCP tool call whose arguments did not survive the provider round-trip", () => {
  const dispatchArgs = (
    conn: MCPConnection,
    guards: ConvergenceGuards,
    trace: TracePort,
    over: Partial<Parameters<typeof executeMcpToolCall>[0]> = {},
  ) => ({
    call: mcpCall(),
    registry: buildRegistry(
      [
        {
          conn,
          tools: [
            {
              name: "tool",
              inputSchema: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
              },
            },
          ],
        },
      ],
      [],
    ),
    availableWireNames: ["srv.tool"],
    argValidator: createToolArgValidator(),
    guards,
    trace,
    agent: "lead" as const,
    iteration: 1,
    ...over,
  });

  it("is refused rather than dispatched with fabricated empty arguments", async () => {
    const { port } = makeTrace();
    const { guards } = makeGuards();
    const { conn, dispatched } = makeConnection();

    const res = await executeMcpToolCall(
      dispatchArgs(conn, guards, port, {
        call: mcpCall({ malformedArguments: '{"command":"npm test 2>' }),
      }),
    );

    expect(dispatched).toEqual([]);
    expect(res.errText).not.toBeNull();
    expect(res.productive).toBe(false);
  });

  it("tells the model what arrived instead of naming a property it did send", async () => {
    const { port } = makeTrace();
    const { guards } = makeGuards();
    const { conn } = makeConnection();

    const res = await executeMcpToolCall(
      dispatchArgs(conn, guards, port, {
        call: mcpCall({ malformedArguments: '{"command":"npm test 2>' }),
      }),
    );

    expect(res.errText).toContain('{"command":"npm test 2>');
    expect(res.errText).not.toContain("required property");
  });

  it("persists what arrived, so the trace does not disagree with the run", async () => {
    const { port, entries } = makeTrace();
    const { guards } = makeGuards();
    const { conn } = makeConnection();

    await executeMcpToolCall(
      dispatchArgs(conn, guards, port, {
        call: mcpCall({ malformedArguments: '{"command":"npm test 2>' }),
      }),
    );

    const toolCall = entries.find((e) => e.kind === "tool_call");
    expect(toolCall?.detail.arguments).toEqual({
      malformed_arguments: '{"command":"npm test 2>',
    });
  });

  it("keeps two differently-truncated payloads distinct to the convergence guard", async () => {
    const { port } = makeTrace();
    const { guards, signatures } = makeGuards();
    const { conn } = makeConnection();

    for (const preview of ['{"command":"npm test 2>', '{"command":"npm test -- src/domain 2>']) {
      await executeMcpToolCall(
        dispatchArgs(conn, guards, port, { call: mcpCall({ malformedArguments: preview }) }),
      );
    }

    expect(signatures).toHaveLength(2);
    expect(signatures[0]).not.toBe(signatures[1]);
  });

  it("dispatches a well-formed call untouched", async () => {
    const { port } = makeTrace();
    const { guards } = makeGuards();
    const { conn, dispatched } = makeConnection();

    const res = await executeMcpToolCall(
      dispatchArgs(conn, guards, port, { call: mcpCall({ arguments: { command: "bun test" } }) }),
    );

    expect(dispatched).toEqual([{ command: "bun test" }]);
    expect(res.errText).toBeNull();
    expect(res.productive).toBe(true);
  });
});
