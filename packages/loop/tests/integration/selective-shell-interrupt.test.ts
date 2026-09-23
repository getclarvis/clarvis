import { afterEach, describe, expect, it } from "../bun-test.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBuiltinTraceEvent, type TraceEvent } from "@clarvis/capability";
import type {
  ToolInterruptDelivery,
  ToolInterruptSettleStatus,
  ToolInterruptSource,
} from "../../src/runtime/tools/tool-interrupt.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { GateLLM } from "./_gate-llm.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

const posixShell = process.platform !== "win32";
const roots: string[] = [];
let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "selective-shell-"));
  roots.push(root);
  return root;
}

function channel() {
  let listener: ((delivery: ToolInterruptDelivery) => void) | undefined;
  let unsubscribed = false;
  const source: ToolInterruptSource = {
    subscribe(next) {
      listener = next;
      // Retain the receiver to test delivery to the closed run registry too.
      return () => {
        unsubscribed = true;
      };
    },
  };
  return {
    source,
    request(toolExecutionId: string): ToolInterruptSettleStatus | undefined {
      let status: ToolInterruptSettleStatus | undefined;
      listener?.({
        toolExecutionId,
        settle(value) {
          status = value;
        },
        fail(error) {
          throw error;
        },
      });
      return status;
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

function body() {
  return {
    messages: [{ role: "user", content: "run the command" }],
    servers: [],
    entry: "solo",
    profiles: [
      {
        name: "solo",
        model: "anthropic/x",
        tools: [],
        iteration_limit: 5,
        grants: ["read_workspace", "edit_workspace", "run_commands"],
      },
    ],
    budget: { on_exceed: "stop", total_token_limit: 100_000, timeout_ms: 15_000 },
  };
}

function shellScript(command = "printf 'partial-out\\n'; printf 'partial-err\\n' >&2; sleep 10") {
  return new MockLLM({
    script: [
      { toolCalls: [{ id: "shell-call", name: "shell", arguments: { command } }] },
      { text: "continued after shell" },
    ],
  });
}

describe.skipIf(!posixShell)("selective interrupt through executeRun and the real shell", () => {
  it("stops a yielded session through its original hosted interrupt token", async () => {
    const control = channel();
    const events: TraceEvent[] = [];
    const llm = new GateLLM((index) =>
      index === 0
        ? {
            toolCalls: [
              {
                id: "yielded",
                name: "shell",
                arguments: {
                  command: "printf ready; sleep 3; printf leaked > leak.txt",
                  yield_time_ms: 100,
                },
              },
            ],
          }
        : { text: "done", toolCalls: [] },
    );
    const root = workspace();
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      env: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
      agentTools: true,
      toolInterrupts: control.source,
      onEvent(event) {
        events.push(event);
      },
    });
    const run = harness.run(body());
    await llm.started(0);
    llm.release(0);
    await llm.started(1);
    try {
      const terminal = events.find(
        (event): event is Extract<TraceEvent, { type: "tool_call" }> => event.type === "tool_call",
      );
      expect(terminal?.control?.tool_execution_id).toBeDefined();
      const token = terminal!.control!.tool_execution_id;
      expect(control.request(token)).toBe("accepted");
      const deadline = Date.now() + 2000;
      while (control.request(token) !== "not_running" && Date.now() < deadline) await Bun.sleep(10);
      expect(control.request(token)).toBe("not_running");
    } finally {
      llm.release(1);
    }
    expect((await run).status).toBe("completed");
    expect(await Bun.file(join(root, "leak.txt")).exists()).toBe(false);
  });

  it("retains both partial streams, settles receipts, records one terminal and continues", async () => {
    const control = channel();
    const events: TraceEvent[] = [];
    const receipts: Array<ToolInterruptSettleStatus | undefined> = [];
    let token: string | undefined;
    let output = "";
    const llm = shellScript();
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: workspace(),
      env: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
      agentTools: true,
      toolInterrupts: control.source,
      onEvent(event) {
        events.push(event);
        if (isBuiltinTraceEvent(event) && event.type === "tool_call_started" && event.control)
          token = event.control.tool_execution_id;
        if (isBuiltinTraceEvent(event) && event.type === "tool_output_delta") {
          output += event.chunk;
          if (
            token &&
            receipts.length === 0 &&
            output.includes("partial-out") &&
            output.includes("partial-err")
          ) {
            receipts.push(control.request(token), control.request(token));
          }
        }
        if (event.type === "subagent_iteration_started" && token && receipts.length === 2) {
          receipts.push(control.request(token));
        }
      },
    });
    const result = await harness.run(body());
    expect(result.status).toBe("completed");
    expect(receipts).toEqual(["accepted", "already_requested", "not_running"]);
    expect(llm.calls).toHaveLength(2);
    const toolMessages = JSON.stringify(
      llm.calls[1]?.messages.filter((message) => message.role === "tool"),
    );
    expect(toolMessages).toContain("Shell interrupted by the operator.");
    expect(toolMessages).toContain("partial-out");
    expect(toolMessages).toContain("partial-err");
    expect(control.unsubscribed).toBe(true);
    expect(control.request(token!)).toBe("not_running");
    const starts = events.filter((e) => e.type === "tool_call_started");
    const terminals = events.filter(
      (e): e is Extract<TraceEvent, { type: "tool_call" }> => e.type === "tool_call",
    );
    expect(starts).toHaveLength(1);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      call_id: "shell-call",
      interruption: { source: "operator" },
    });
    const terminal = terminals[0]!;
    expect(terminal.result).toContain("Shell interrupted by the operator.");
    expect(terminal.result).toContain('"stdout":"partial-out\\n"');
    expect(terminal.result).toContain('"stderr":"partial-err\\n"');
    expect(
      events
        .slice(events.indexOf(terminal) + 1)
        .filter((e) => e.type === "tool_output_delta" || e.type === "tool_call_started"),
    ).toEqual([]);
    const stored = await harness.getRun(result.execution_id);
    expect(
      stored?.trace.events.filter(
        (e): e is Extract<TraceEvent, { type: "tool_call" }> => e.type === "tool_call",
      ),
    ).toHaveLength(1);
  });

  it("pending and denied guard never advertise a control or a started execution", async () => {
    const control = channel();
    const events: TraceEvent[] = [];
    let entered!: () => void;
    const reviewing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let deny!: () => void;
    const reviewed = new Promise<void>((resolve) => {
      deny = resolve;
    });
    harness = await makeHarness({
      llm: shellScript("echo forbidden"),
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: workspace(),
      env: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
      toolInterrupts: control.source,
      agentTools: {
        guard: async () => {
          entered();
          await reviewed;
          return { verdict: "deny", reason: "test denied" };
        },
      },
      onEvent: (event) => {
        events.push(event);
      },
    });
    const pending = harness.run(body());
    await reviewing;
    expect(events.filter((e) => e.type === "tool_call_started")).toEqual([]);
    expect(control.request("unpublished-token")).toBe("not_running");
    deny();
    expect((await pending).status).toBe("completed");
    expect(events.filter((e) => e.type === "tool_call_started")).toEqual([]);
    const terminals = events.filter(
      (e): e is Extract<TraceEvent, { type: "tool_call" }> => e.type === "tool_call",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.error).toContain("test denied");
    expect(terminals[0]?.interruption).toBeUndefined();
  });

  it("global cancellation concurrent with selective abort wins classification and stops iterations", async () => {
    const control = channel();
    const cancel = new AbortController();
    const events: TraceEvent[] = [];
    let receipt: ToolInterruptSettleStatus | undefined;
    let cancelTime = 0;
    harness = await makeHarness({
      llm: shellScript(),
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: workspace(),
      env: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
      agentTools: true,
      toolInterrupts: control.source,
      externalSignal: cancel.signal,
      onEvent(event) {
        events.push(event);
        if (isBuiltinTraceEvent(event) && event.type === "tool_call_started" && event.control) {
          receipt = control.request(event.control.tool_execution_id);
          cancelTime = performance.now();
          cancel.abort({ source: "test" });
        }
      },
    });
    const result = await harness.run(body());
    expect(result.status).toBe("cancelled");
    expect(receipt).toBe("accepted");
    expect(performance.now() - cancelTime).toBeLessThan(1500);
    const terminals = events.filter(
      (e): e is Extract<TraceEvent, { type: "tool_call" }> => e.type === "tool_call",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.interruption).toBeUndefined();
    expect(events.filter((e) => e.type === "subagent_iteration_started")).toHaveLength(1);
  });
});
