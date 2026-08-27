import { describe, it, expect } from "../bun-test.ts";
import { runAgent, type RunAgentInput } from "../../src/runtime/loop/run-agent.ts";
import type { AgentBuildContext } from "../../src/runtime/loop/run-agent.ts";
import type { AgentCapability, AgentLoopContribution } from "@clarvis/capability";
import { createTrace, type TraceHandle } from "@clarvis/trace";
import { createTokenLedger, createIterationCounter } from "../../src/runtime/budget/index.ts";
import { buildRegistry } from "../../src/runtime/tools/mcp-registry.ts";
import { compileResultContract } from "../../src/runtime/tools/index.ts";
import { DISABLED_COMPACTION } from "../../src/runtime/context/index.ts";
import type { GateVerdict, LifecycleHook } from "@clarvis/capability";
import { MockLLM } from "../helpers/fixtures.ts";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { name: { type: "string" } },
  required: ["name"],
};

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

function noopTool(name: string) {
  return {
    fullName: name,
    wireName: name,
    mcpName: "",
    toolName: name,
    inputSchema: { type: "object" as const, properties: {} },
  };
}

function makeInput(
  llm: MockLLM,
  opts: {
    hooks?: LifecycleHook[];
    buildContribution?: (bc: AgentBuildContext) => AgentLoopContribution;
    noProgressLimit?: number;
    trace?: TraceHandle;
    agent?: "lead" | "subagent";
  } = {},
): RunAgentInput {
  return {
    agent: opts.agent ?? "subagent",
    subagentInstanceId: "w1",
    messages: [{ role: "user", content: "go" }],
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    target: {
      llm,
      model: "m",
      provider: "anthropic",
      capabilities: new Set(["tool_calling", "vision"]),
    },
    budget: {
      ledger: createTokenLedger(1_000_000),
      counter: createIterationCounter(50),
      usage: { input: 0, output: 0, cached: 0, cache_write: 0 },
    },
    runtime: { trace: opts.trace ?? createTrace() },
    compaction: DISABLED_COMPACTION,
    registry: buildRegistry([], []),
    contract: compileResultContract(SCHEMA),
    mcpProgress: (r) => r.errText === null,
    allToolsUnavailable: () => false,
    noProgressLimit: opts.noProgressLimit ?? 6,
    noProgressMessage: (streak) => `no progress for ${streak}.`,
    emptyResponseAgent: "LLM",
    ...(opts.buildContribution
      ? {
          agentCapabilities: [
            {
              attach: (bc: AgentBuildContext): AgentLoopContribution => ({
                ...opts.buildContribution!(bc),
                advertised: false,
              }),
            } as AgentCapability,
          ],
        }
      : {}),
  };
}

function toolResults(messages: WireMessage[]): string[] {
  return messages.filter((m) => m.role === "tool").map((m) => m.content as string);
}

function deny(message: string): GateVerdict {
  return { kind: "deny", message };
}

function advise(message: string): GateVerdict {
  return { kind: "advise", message };
}

describe("tool hooks", () => {
  it("PreToolUse deny blocks the tool and returns a denial message without invoking the handler", async () => {
    let handled = false;
    const contribution: AgentLoopContribution = {
      tools: [noopTool("noop")],
      handlers: [
        {
          matches: (c) => c.name === "noop",
          handle: async () => {
            handled = true;
            return { kind: "result", text: "ok", progress: true };
          },
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const hooks: LifecycleHook[] = [
      { beforeToolUse: async (c) => (c.tool === "noop" ? deny("blocked") : { kind: "pass" }) },
    ];
    const res = await runAgent(makeInput(llm, { hooks, buildContribution: () => contribution }));
    expect(res.status).toBe("completed");
    expect(handled).toBe(false);
    const results = toolResults(llm.snapshots[1]!);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe("DENIED by a workspace hook: blocked");
  });

  it("PreToolUse advise still invokes the handler and appends the advisor message to the result", async () => {
    let handled = false;
    const contribution: AgentLoopContribution = {
      tools: [noopTool("noop")],
      handlers: [
        {
          matches: (c) => c.name === "noop",
          handle: async () => {
            handled = true;
            return { kind: "result", text: "ok", progress: true };
          },
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const hooks: LifecycleHook[] = [{ beforeToolUse: async () => advise("be careful") }];
    const res = await runAgent(makeInput(llm, { hooks, buildContribution: () => contribution }));
    expect(res.status).toBe("completed");
    expect(handled).toBe(true);
    const results = toolResults(llm.snapshots[1]!);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe("ok\n\n[advisor] be careful");
  });

  it("preserves a handler's canonical tool identity across before and after hooks", async () => {
    const seen: Array<{ tool: string; toolFullName?: string }> = [];
    const contribution: AgentLoopContribution = {
      tools: [noopTool("remote_search")],
      handlers: [
        {
          matches: (call) => call.name === "remote_search",
          canonicalName: () => "remote.search",
          handle: async () => ({ kind: "result", text: "ok", progress: true }),
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "remote_search", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const hooks: LifecycleHook[] = [
      {
        beforeToolUse: async ({ tool, toolFullName }) => {
          if (tool === "remote_search") {
            seen.push({ tool, ...(toolFullName === undefined ? {} : { toolFullName }) });
          }
          return { kind: "pass" };
        },
        afterToolUse: async ({ tool, toolFullName }) => {
          if (tool === "remote_search") {
            seen.push({ tool, ...(toolFullName === undefined ? {} : { toolFullName }) });
          }
          return { kind: "pass" };
        },
      },
    ];

    const result = await runAgent(makeInput(llm, { hooks, buildContribution: () => contribution }));
    expect(result.status).toBe("completed");
    expect(seen).toEqual([
      { tool: "remote_search", toolFullName: "remote.search" },
      { tool: "remote_search", toolFullName: "remote.search" },
    ]);
  });

  it("PostToolUse advise modifies the result by appending an advisory message", async () => {
    const contribution: AgentLoopContribution = {
      tools: [noopTool("noop")],
      handlers: [
        {
          matches: (c) => c.name === "noop",
          handle: async () => ({ kind: "result", text: "ok", progress: true }),
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const hooks: LifecycleHook[] = [{ afterToolUse: async () => advise("noted") }];
    const res = await runAgent(makeInput(llm, { hooks, buildContribution: () => contribution }));
    expect(res.status).toBe("completed");
    const results = toolResults(llm.snapshots[1]!);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe("ok\n\n[advisor] noted");
  });

  it("a beforeToolUse hook that throws fails CLOSED: the call is denied, the run continues", async () => {
    let handled = false;
    const contribution: AgentLoopContribution = {
      tools: [noopTool("noop")],
      handlers: [
        {
          matches: (c) => c.name === "noop",
          handle: async () => {
            handled = true;
            return { kind: "result", text: "ok", progress: true };
          },
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const hooks: LifecycleHook[] = [
      {
        beforeToolUse: async (c) => {
          if (c.tool === "noop") throw new Error("boom");
          return { kind: "pass" };
        },
      },
    ];
    const res = await runAgent(makeInput(llm, { hooks, buildContribution: () => contribution }));
    expect(res.status).toBe("completed");
    expect(handled).toBe(false);
    const results = toolResults(llm.snapshots[1]!);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe("DENIED by a workspace hook: the hook itself failed (boom)");
  });

  it("an afterToolUse hook that throws fails OPEN: the executed tool's result passes through", async () => {
    const contribution: AgentLoopContribution = {
      tools: [noopTool("noop")],
      handlers: [
        {
          matches: (c) => c.name === "noop",
          handle: async () => ({ kind: "result", text: "ok", progress: true }),
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const hooks: LifecycleHook[] = [
      {
        afterToolUse: async () => {
          throw new Error("post boom");
        },
      },
    ];
    const res = await runAgent(makeInput(llm, { hooks, buildContribution: () => contribution }));
    expect(res.status).toBe("completed");
    const results = toolResults(llm.snapshots[1]!);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe("ok");
  });

  it("afterToolUse and advise cover deferred verdicts (the delegate_task path)", async () => {
    const seenByAfter: string[] = [];
    const contribution: AgentLoopContribution = {
      tools: [noopTool("defer")],
      handlers: [
        {
          matches: (c) => c.name === "defer",
          handle: async () => ({
            kind: "deferred",
            run: async () => ({ text: "spawned ok", progress: false }),
          }),
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "defer", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const hooks: LifecycleHook[] = [
      {
        beforeToolUse: async () => advise("heads up"),
        afterToolUse: async (context) => {
          seenByAfter.push(`${context.tool}:${context.result.text}`);
          return advise("noted");
        },
      },
    ];
    const res = await runAgent(makeInput(llm, { hooks, buildContribution: () => contribution }));
    expect(res.status).toBe("completed");
    expect(seenByAfter).toEqual(["defer:spawned ok"]);
    const results = toolResults(llm.snapshots[1]!);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe("spawned ok\n\n[advisor] heads up\n\n[advisor] noted");
  });

  it("afterToolUse deny replaces a deferred result", async () => {
    const contribution: AgentLoopContribution = {
      tools: [noopTool("defer")],
      handlers: [
        {
          matches: (c) => c.name === "defer",
          handle: async () => ({
            kind: "deferred",
            run: async () => ({ text: "spawned ok", progress: false }),
          }),
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "defer", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const hooks: LifecycleHook[] = [{ afterToolUse: async () => deny("not like that") }];
    const res = await runAgent(makeInput(llm, { hooks, buildContribution: () => contribution }));
    expect(res.status).toBe("completed");
    const results = toolResults(llm.snapshots[1]!);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe("DENIED by a workspace hook: not like that");
  });

  it("without hooks the behavior is identical to the current run (regression-safe)", async () => {
    const contribution: AgentLoopContribution = {
      tools: [noopTool("noop")],
      handlers: [
        {
          matches: (c) => c.name === "noop",
          handle: async () => ({ kind: "result", text: "ok", progress: true }),
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const res = await runAgent(makeInput(llm, { buildContribution: () => contribution }));
    expect(res.status).toBe("completed");
    const results = toolResults(llm.snapshots[1]!);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe("ok");
  });

  it("PreToolUse deny also works in the Lead agent", async () => {
    let handled = false;
    const contribution: AgentLoopContribution = {
      tools: [noopTool("noop")],
      handlers: [
        {
          matches: (c) => c.name === "noop",
          handle: async () => {
            handled = true;
            return { kind: "result", text: "ok", progress: true };
          },
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const hooks: LifecycleHook[] = [
      { beforeToolUse: async (c) => (c.tool === "noop" ? deny("blocked") : { kind: "pass" }) },
    ];
    const res = await runAgent(
      makeInput(llm, {
        hooks,
        buildContribution: () => contribution,
        agent: "lead",
      }),
    );
    expect(res.status).toBe("completed");
    expect(handled).toBe(false);
    const results = toolResults(llm.snapshots[1]!);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe("DENIED by a workspace hook: blocked");
  });

  it("PostToolUse deny does NOT count as progress: repeated denials terminate via no_progress", async () => {
    let handled = 0;
    const contribution: AgentLoopContribution = {
      tools: [noopTool("noop")],
      handlers: [
        {
          matches: (c) => c.name === "noop",
          handle: async () => {
            handled += 1;
            return { kind: "result", text: "ok", progress: true, taskId: "t1" };
          },
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "noop", arguments: {} }] },
      ],
    });
    const hooks: LifecycleHook[] = [{ afterToolUse: async () => deny("blocked") }];
    const res = await runAgent(
      makeInput(llm, { hooks, buildContribution: () => contribution, noProgressLimit: 2 }),
    );
    expect(res.status).toBe("error");
    expect(res.error?.code).toBe("no_progress");
    expect(handled).toBe(2);
    const results = toolResults(llm.snapshots[1]!);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe("DENIED by a workspace hook: blocked");
  });

  it("PostToolUse deny drops the tool's images so a DLP deny actually suppresses image content", async () => {
    const contribution: AgentLoopContribution = {
      tools: [noopTool("shot")],
      handlers: [
        {
          matches: (c) => c.name === "shot",
          handle: async () => ({
            kind: "result",
            text: "screenshot captured",
            progress: true,
            images: [{ data: "AAAA", mediaType: "image/png" }],
          }),
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "shot", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const hooks: LifecycleHook[] = [{ afterToolUse: async () => deny("contains secrets") }];
    const res = await runAgent(makeInput(llm, { hooks, buildContribution: () => contribution }));
    expect(res.status).toBe("completed");
    const toolMsg = llm.snapshots[1]!.find((m) => m.role === "tool") as WireMessage & {
      images?: unknown[];
    };
    expect(toolMsg.content).toBe("DENIED by a workspace hook: contains secrets");
    expect(toolMsg.images ?? []).toEqual([]);
  });

  it("mutating AfterToolUseContext.result does not affect the result returned to the LLM", async () => {
    const contribution: AgentLoopContribution = {
      tools: [noopTool("noop")],
      handlers: [
        {
          matches: (c) => c.name === "noop",
          handle: async () => ({ kind: "result", text: "original", progress: true }),
        },
      ],
      gates: [],
      hooks: {},
    };
    const llm = new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "noop", arguments: {} }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    const hooks: LifecycleHook[] = [
      {
        afterToolUse: async (context) => {
          (context.result as { text: string }).text = "MUTATED";
          return { kind: "pass" };
        },
      },
    ];
    const res = await runAgent(makeInput(llm, { hooks, buildContribution: () => contribution }));
    expect(res.status).toBe("completed");
    const results = toolResults(llm.snapshots[1]!);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe("original");
    expect(results[0]).not.toContain("MUTATED");
  });
});

describe("PreToolUse rewrite", () => {
  function rewritingContribution(seen: unknown[]): AgentLoopContribution {
    return {
      tools: [noopTool("noop")],
      handlers: [
        {
          matches: (c) => c.name === "noop",
          handle: async (c) => {
            seen.push(c.arguments);
            return { kind: "result", text: "ok", progress: true };
          },
        },
      ],
      gates: [],
      hooks: {},
    };
  }

  function scripted(): SnapshotLLM {
    return new SnapshotLLM({
      script: [
        { toolCalls: [{ name: "noop", arguments: { command: "rm -rf build" } }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
  }

  it("hands the handler the replacement arguments, not the ones the model sent", async () => {
    const seen: unknown[] = [];
    const llm = scripted();
    const hooks: LifecycleHook[] = [
      {
        beforeToolUse: async (c) =>
          c.tool === "noop"
            ? { kind: "rewrite", arguments: { command: "rm -rf build --dry-run" } }
            : { kind: "pass" },
      },
    ];
    const res = await runAgent(
      makeInput(llm, { hooks, buildContribution: () => rewritingContribution(seen) }),
    );
    expect(res.status).toBe("completed");
    expect(seen).toEqual([{ command: "rm -rf build --dry-run" }]);
  });

  it("tells the model what actually ran", async () => {
    const seen: unknown[] = [];
    const llm = scripted();
    const hooks: LifecycleHook[] = [
      {
        beforeToolUse: async (c) =>
          c.tool === "noop"
            ? { kind: "rewrite", arguments: { command: "safe" } }
            : { kind: "pass" },
      },
    ];
    await runAgent(makeInput(llm, { hooks, buildContribution: () => rewritingContribution(seen) }));
    const results = toolResults(llm.snapshots[1]!);
    expect(results[0]).toContain("[advisor]");
    expect(results[0]).toContain("replaced this call's arguments");
    expect(results[0]).toContain('{"command":"safe"}');
  });

  it("bounds rewritten arguments before appending them to the model context", async () => {
    const seen: unknown[] = [];
    const llm = scripted();
    const hooks: LifecycleHook[] = [
      {
        beforeToolUse: async (c) =>
          c.tool === "noop"
            ? { kind: "rewrite", arguments: { command: `${"x".repeat(5_000)}TAIL` } }
            : { kind: "pass" },
      },
    ];

    await runAgent(makeInput(llm, { hooks, buildContribution: () => rewritingContribution(seen) }));

    const result = toolResults(llm.snapshots[1]!)[0]!;
    const marker = "What actually ran: ";
    const rendered = result.slice(result.indexOf(marker) + marker.length);
    expect(rendered.indexOf("...")).toBe(2_000);
    expect(rendered).not.toContain("TAIL");
  });

  it("leaves the assistant message the model produced untouched", async () => {
    const seen: unknown[] = [];
    const llm = scripted();
    const hooks: LifecycleHook[] = [
      {
        beforeToolUse: async (c) =>
          c.tool === "noop"
            ? { kind: "rewrite", arguments: { command: "safe" } }
            : { kind: "pass" },
      },
    ];
    await runAgent(makeInput(llm, { hooks, buildContribution: () => rewritingContribution(seen) }));
    const assistant = llm.snapshots[1]!.find(
      (m) => m.role === "assistant" && "tool_calls" in m,
    ) as unknown as { tool_calls: { arguments: unknown }[] };
    expect(assistant.tool_calls[0]!.arguments).toEqual({ command: "rm -rf build" });
  });

  it("threads replacements so a later hook rules on what the earlier one left", async () => {
    const seen: unknown[] = [];
    const observed: unknown[] = [];
    const llm = scripted();
    const hooks: LifecycleHook[] = [
      {
        beforeToolUse: async (c) => {
          observed.push(c.arguments);
          return c.tool === "noop"
            ? { kind: "rewrite", arguments: { command: "first" } }
            : { kind: "pass" };
        },
      },
      {
        beforeToolUse: async (c) => {
          observed.push(c.arguments);
          return c.tool === "noop"
            ? { kind: "rewrite", arguments: { command: "second" } }
            : { kind: "pass" };
        },
      },
    ];
    await runAgent(makeInput(llm, { hooks, buildContribution: () => rewritingContribution(seen) }));
    expect(observed.slice(0, 2)).toEqual([{ command: "rm -rf build" }, { command: "first" }]);
    expect(seen).toEqual([{ command: "second" }]);
  });

  it("carries a message offered alongside the replacement", async () => {
    const seen: unknown[] = [];
    const llm = scripted();
    const hooks: LifecycleHook[] = [
      {
        beforeToolUse: async (c) =>
          c.tool === "noop"
            ? { kind: "rewrite", arguments: { command: "safe" }, message: "added --dry-run" }
            : { kind: "pass" },
      },
    ];
    await runAgent(makeInput(llm, { hooks, buildContribution: () => rewritingContribution(seen) }));
    const results = toolResults(llm.snapshots[1]!);
    expect(results[0]).toContain("added --dry-run");
  });

  it("does not run the handler at all when a later hook denies after an earlier rewrote", async () => {
    const seen: unknown[] = [];
    const llm = scripted();
    const hooks: LifecycleHook[] = [
      {
        beforeToolUse: async (c) =>
          c.tool === "noop"
            ? { kind: "rewrite", arguments: { command: "safe" } }
            : { kind: "pass" },
      },
      { beforeToolUse: async (c) => (c.tool === "noop" ? deny("still no") : { kind: "pass" }) },
    ];
    await runAgent(makeInput(llm, { hooks, buildContribution: () => rewritingContribution(seen) }));
    expect(seen).toEqual([]);
    expect(toolResults(llm.snapshots[1]!)[0]).toBe("DENIED by a workspace hook: still no");
  });
});
