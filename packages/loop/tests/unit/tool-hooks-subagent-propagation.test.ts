import { describe, it, expect } from "../bun-test.ts";
import { runSubagent } from "../../src/runtime/subagents/run-subagent.ts";
import { createTrace } from "@clarvis/trace";
import { createTokenLedger } from "../../src/runtime/budget/index.ts";
import { buildRegistry } from "../../src/runtime/tools/mcp-registry.ts";
import type { MCPConnection, ToolResult } from "@clarvis/capability";
import type { LifecycleHook, HookVerdict } from "@clarvis/capability";
import { MockLLM } from "../helpers/fixtures.ts";

interface WireMessage {
  role: string;
  content: unknown;
  tool_call_id?: string;
}

class SnapshotLLM extends MockLLM {
  readonly snapshots: WireMessage[][] = [];
  override async call(params: Parameters<MockLLM["call"]>[0]): ReturnType<MockLLM["call"]> {
    this.snapshots.push([...(params.messages as WireMessage[])]);
    return super.call(params);
  }
}

function deny(message: string): HookVerdict {
  return { kind: "deny", message };
}

function fakeConn(result: ToolResult): MCPConnection {
  return {
    name: "srv",
    transport: "stdio",
    status: "connected",
    callTool: async (): Promise<ToolResult> => result,
    close: async (): Promise<void> => {},
  };
}

function toolResults(messages: WireMessage[]): string[] {
  return messages.filter((m) => m.role === "tool").map((m) => m.content as string);
}

describe("tool hooks propagation to spawned subagents", () => {
  it("a beforeToolUse deny hook passed to runSubagent blocks a tool inside the subagent", async () => {
    let handled = false;
    const registry = buildRegistry(
      [
        {
          conn: {
            ...fakeConn({ ok: true, data: "ok" }),
            callTool: async (): Promise<ToolResult> => {
              handled = true;
              return { ok: true, data: "ok" };
            },
          },
          tools: [{ name: "tool", inputSchema: { type: "object" } }],
        },
      ],
      [],
    );
    const llm = new SnapshotLLM({
      script: [{ toolCalls: [{ name: "srv.tool", arguments: {} }] }, { text: "done" }],
    });
    const hooks: LifecycleHook[] = [{ beforeToolUse: async () => deny("subagent-blocked") }];
    const res = await runSubagent({
      task: "go",
      model: "m",
      provider: "anthropic",
      subagentInstanceId: "w1",
      llm,
      registry,
      ledger: createTokenLedger(1_000_000),
      maxIterations: 5,
      trace: createTrace(),
      hooks,
    });
    expect(res.outcome.status).toBe("completed");
    expect(handled).toBe(false);
    const results = toolResults(llm.snapshots[1]!);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe("DENIED by a workspace hook: subagent-blocked");
  });

  it("an afterToolUse advise hook passed to runSubagent appends an advisor message to the tool result", async () => {
    const registry = buildRegistry(
      [
        {
          conn: fakeConn({ ok: true, data: "ok" }),
          tools: [{ name: "tool", inputSchema: { type: "object" } }],
        },
      ],
      [],
    );
    const llm = new SnapshotLLM({
      script: [{ toolCalls: [{ name: "srv.tool", arguments: {} }] }, { text: "done" }],
    });
    const hooks: LifecycleHook[] = [
      { afterToolUse: async () => ({ kind: "advise", message: "noted" }) },
    ];
    const res = await runSubagent({
      task: "go",
      model: "m",
      provider: "anthropic",
      subagentInstanceId: "w2",
      llm,
      registry,
      ledger: createTokenLedger(1_000_000),
      maxIterations: 5,
      trace: createTrace(),
      hooks,
    });
    expect(res.outcome.status).toBe("completed");
    const results = toolResults(llm.snapshots[1]!);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe("Tool 'srv.tool' result: ok\n\n[advisor] noted");
  });
});
