/**
 * The **command-approval** guard: how a `Guard` resolver is wired into a run and
 * what a shell call sees when it rules.
 *
 * @remarks Named `command-guard-wiring` rather than `guard-wiring` because
 * "guard" is two unrelated things in this engine. The other is the *convergence*
 * guards — doom-loop and stagnation — which live in `src/runtime/guards/` and
 * are not exercised here at all.
 */
import { describe, it, expect, afterEach } from "../bun-test.ts";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { Guard, GuardContext, GuardDecision, ElicitRequest } from "../../src/lib.ts";
import { workspaceStatePaths } from "@clarvis/paths";

let harness: TestHarness | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await harness?.close();
  harness = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), "clarvis-guard-it-"));
  dirs.push(d);
  return d;
}

type ToolEvt = {
  type: string;
  mcp_name?: string;
  result?: string;
  error?: string | null;
  guard?: { mode: string; outcome: string; answerer: string };
};

async function toolEvents(h: TestHarness, id: string): Promise<ToolEvt[]> {
  const detail = await h.getRun(id);
  return (detail!.trace.events as unknown as ToolEvt[]).filter((e) => e.type === "tool_call");
}

function body(grants?: string[]): unknown {
  return {
    messages: [{ role: "user", content: "do it" }],
    servers: [],
    profiles: [
      {
        name: "solo",
        model: "anthropic/claude-haiku-4-5",
        tools: [],
        ...(grants ? { grants } : {}),
        iteration_limit: 5,
      },
    ],
    entry: "solo",
    budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
  };
}

describe("tools guard wiring", () => {
  it("shares one run-owned temporary root between shell and native tools, then removes it", async () => {
    const root = workspace();
    const executionId = "exec_run_owned_tmp";
    const temporaryRoot = workspaceStatePaths(root).runTempDir(executionId);
    const explicitPrefix = `clarvis-loop-explicit-${process.pid}-${Date.now()}-`;
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              id: "c1",
              name: "shell",
              arguments: {
                command:
                  `made=$(mktemp -d /tmp/${explicitPrefix}XXXXXX) && ` +
                  'printf alpha > "$made/a.txt" && mkdir -p "$TMPDIR/research"',
              },
            },
          ],
        },
        { text: "done" },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      agentTools: true,
      env: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
    });
    const res = await harness.run({
      ...(body(["run_commands"]) as Record<string, unknown>),
      execution_id: executionId,
    });

    expect(res.status).toBe("completed");
    const calls = await toolEvents(harness, executionId);
    expect(calls.find((event) => event.mcp_name === "shell")?.error).toBeNull();
    expect(existsSync(temporaryRoot)).toBe(false);
    expect(existsSync(workspaceStatePaths(root).runsDir)).toBe(false);
    expect(readdirSync(tmpdir()).some((name) => name.startsWith(explicitPrefix))).toBe(false);
  });

  it("a guard that denies bash blocks the tool and the file is not written", async () => {
    const root = workspace();
    const denyBash: Guard = (ctx: GuardContext): GuardDecision => {
      if (ctx.tool === "shell" && ctx.shell) {
        return { verdict: "deny", reason: "bash is blocked by test guard" };
      }
      return { verdict: "allow" };
    };
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ id: "c1", name: "shell", arguments: { command: "echo hi > out.txt" } }],
        },
        { text: "done" },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      agentTools: { guard: denyBash },
      env: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
    });
    const res = await harness.run(body(["run_commands"]));

    expect(res.status).toBe("completed");
    expect(existsSync(join(root, "out.txt"))).toBe(false);
    const calls = await toolEvents(harness, res.execution_id);
    const bash = calls.find((e) => e.mcp_name === "shell");
    expect(bash!.error).toContain("bash is blocked by test guard");
  });

  it("a guard that returns ask with an elicit that allows lets the tool proceed", async () => {
    const root = workspace();
    const askBash: Guard = (ctx: GuardContext): GuardDecision => {
      if (ctx.tool === "shell") {
        return { verdict: "ask", reason: "bash requires confirmation", mode: "auto" };
      }
      return { verdict: "allow" };
    };
    const allowElicit = async (_req: ElicitRequest) => ({
      allowed: true,
      answerer: "judge" as const,
    });
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ id: "c1", name: "shell", arguments: { command: "echo hi > out.txt" } }],
        },
        { text: "done" },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      agentTools: { guard: askBash, guardElicit: allowElicit },
      env: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
    });
    const res = await harness.run(body(["run_commands"]));

    expect(res.status).toBe("completed");
    expect(existsSync(join(root, "out.txt"))).toBe(true);
    const calls = await toolEvents(harness, res.execution_id);
    const bash = calls.find((e) => e.mcp_name === "shell");
    expect(bash!.error).toBeNull();
    expect(bash!.guard).toEqual({ mode: "auto", outcome: "allowed", answerer: "judge" });
  });

  it("a guard that returns ask with an elicit that denies blocks the tool", async () => {
    const root = workspace();
    const askBash: Guard = (ctx: GuardContext): GuardDecision => {
      if (ctx.tool === "shell") {
        return { verdict: "ask", reason: "bash requires confirmation" };
      }
      return { verdict: "allow" };
    };
    const denyElicit = async (_req: ElicitRequest): Promise<boolean> => false;
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ id: "c1", name: "shell", arguments: { command: "echo hi > out.txt" } }],
        },
        { text: "done" },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      agentTools: { guard: askBash, guardElicit: denyElicit },
      env: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
    });
    const res = await harness.run(body(["run_commands"]));

    expect(res.status).toBe("completed");
    expect(existsSync(join(root, "out.txt"))).toBe(false);
    const calls = await toolEvents(harness, res.execution_id);
    const bash = calls.find((e) => e.mcp_name === "shell");
    expect(bash!.error).toContain("bash requires confirmation");
  });

  it("without a guard, tools work as before (regression)", async () => {
    const root = workspace();
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ id: "c1", name: "shell", arguments: { command: "echo hi > out.txt" } }],
        },
        { text: "done" },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      agentTools: true,
      env: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
    });
    const res = await harness.run(body(["run_commands"]));

    expect(res.status).toBe("completed");
    expect(existsSync(join(root, "out.txt"))).toBe(true);
    const calls = await toolEvents(harness, res.execution_id);
    const bash = calls.find((e) => e.mcp_name === "shell");
    expect(bash!.error).toBeNull();
  });

  it("a guard deny on a write_file tool blocks the file write", async () => {
    const root = workspace();
    const denyWrite: Guard = (ctx: GuardContext): GuardDecision => {
      if (ctx.tool === "write_file") {
        return { verdict: "deny", reason: "writes blocked by test guard" };
      }
      return { verdict: "allow" };
    };
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { id: "c1", name: "write_file", arguments: { path: "blocked.txt", content: "x" } },
          ],
        },
        { text: "done" },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      agentTools: { guard: denyWrite },
    });
    const res = await harness.run(body(["edit_workspace"]));

    expect(res.status).toBe("completed");
    expect(existsSync(join(root, "blocked.txt"))).toBe(false);
    const calls = await toolEvents(harness, res.execution_id);
    const write = calls.find((e) => e.mcp_name === "write_file");
    expect(write!.error).toContain("writes blocked by test guard");
  });

  it("a guard applies to Lead-spawned subagents too", async () => {
    const root = workspace();
    const denyBash: Guard = (ctx: GuardContext): GuardDecision => {
      if (ctx.tool === "shell") {
        return { verdict: "deny", reason: "bash blocked in subagents too" };
      }
      return { verdict: "allow" };
    };
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              id: "s1",
              name: "spawn_subagent",
              arguments: { title: "runner", task: "run bash", profile: "subagent" },
            },
          ],
        },
        {
          toolCalls: [{ id: "c1", name: "shell", arguments: { command: "echo hi > w.txt" } }],
        },
        { text: "subagent done" },
        { text: "done" },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      agentTools: { guard: denyBash },
      env: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
    });
    const res = await harness.run({
      messages: [{ role: "user", content: "delegate" }],
      servers: [],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: [],
          can_spawn: ["subagent"],
          iteration_limit: 10,
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: [],
          grants: ["run_commands"],
          iteration_limit: 10,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });

    expect(res.status).toBe("completed");
    expect(existsSync(join(root, "w.txt"))).toBe(false);
    const calls = await toolEvents(harness, res.execution_id);
    const bash = calls.find((e) => e.mcp_name === "shell");
    expect(bash!.error).toContain("bash blocked in subagents too");
  });
});
