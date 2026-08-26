import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

type Ev = {
  type: string;
  call_id?: string;
  agent?: string;
  subagent_instance_id?: string;
  mcp_name?: string;
  tool_name?: string;
  iteration?: number;
};

async function eventsOf(h: TestHarness, id: string): Promise<Ev[]> {
  const detail = await h.getRun(id);
  return detail!.trace.events as unknown as Ev[];
}

const toolsCfg = [{ name: "tools", transport: "stdio", command: "node", args: ["-e", ""] }];
const subagentProfiles = (tools: string[]) => [
  { name: "solo", model: "anthropic/x", tools, iteration_limit: 10 },
];
const okTool = () =>
  mockMCPFactory({ tools: { tools: [{ name: "shell", inputSchema: {}, call: () => "ok" }] } });

describe("tool_call_started + call_id pairing", () => {
  it("emits tool_call_started before the terminal tool_call with the SAME call_id (persisted)", async () => {
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "tools.shell", arguments: { cmd: "x" } }] }, { text: "done" }],
    });
    harness = await makeHarness({ llm, mcpFactory: okTool() });
    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: toolsCfg,
      profiles: subagentProfiles(["tools.shell"]),
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });
    expect(res.status).toBe("completed");

    const ev = await eventsOf(harness, res.execution_id);
    const started = ev.filter((e) => e.type === "tool_call_started");
    const finished = ev.filter((e) => e.type === "tool_call");
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(started[0]!.call_id).toBeTruthy();
    expect(finished[0]!.call_id).toBe(started[0]!.call_id);
    expect(started[0]!.agent).toBe("subagent");
    expect(started[0]!.mcp_name).toBe("tools");
    expect(started[0]!.tool_name).toBe("shell");
    expect(ev.findIndex((e) => e.type === "tool_call_started")).toBeLessThan(
      ev.findIndex((e) => e.type === "tool_call"),
    );
  });

  it("pairs concurrent tool calls unambiguously by call_id (unique ids)", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { name: "tools.shell", id: "a", arguments: { n: 1 } },
            { name: "tools.shell", id: "b", arguments: { n: 2 } },
          ],
        },
        { text: "done" },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: okTool() });
    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: toolsCfg,
      profiles: subagentProfiles(["tools.shell"]),
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });

    const ev = await eventsOf(harness, res.execution_id);
    const started = ev.filter((e) => e.type === "tool_call_started");
    const finished = ev.filter((e) => e.type === "tool_call");
    expect(started).toHaveLength(2);
    expect(finished).toHaveLength(2);
    const startIds = new Set(started.map((e) => e.call_id));
    expect(startIds).toEqual(new Set(["a", "b"]));
    for (const f of finished) expect(startIds.has(f.call_id)).toBe(true);
    expect(new Set(finished.map((e) => e.call_id))).toEqual(startIds);
  });

  it("emits NO tool_call_started for a pre-dispatch rejection (unknown tool); the error tool_call still carries the model's call_id", async () => {
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "tools.nope", arguments: {} }] }, { text: "done" }],
    });
    harness = await makeHarness({ llm, mcpFactory: okTool() });
    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: toolsCfg,
      profiles: subagentProfiles(["tools.shell"]),
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });

    const ev = await eventsOf(harness, res.execution_id);
    expect(ev.filter((e) => e.type === "tool_call_started")).toHaveLength(0);
    const finished = ev.filter((e) => e.type === "tool_call");
    expect(finished).toHaveLength(1);
    expect(finished[0]!.call_id).toBeTruthy();
  });

  it("synthesizes a unique call_id when the provider supplies no native tool-call id", async () => {
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "tools.shell", id: "", arguments: {} }] }, { text: "done" }],
    });
    harness = await makeHarness({ llm, mcpFactory: okTool() });
    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: toolsCfg,
      profiles: subagentProfiles(["tools.shell"]),
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });

    const ev = await eventsOf(harness, res.execution_id);
    const started = ev.filter((e) => e.type === "tool_call_started");
    const finished = ev.filter((e) => e.type === "tool_call");
    expect(started).toHaveLength(1);
    expect(typeof started[0]!.call_id).toBe("string");
    expect(started[0]!.call_id!.length).toBeGreaterThan(0);
    expect(finished[0]!.call_id).toBe(started[0]!.call_id);
  });

  it("submit_result runs in the shared envelope: tool_call_started paired to its tool_call by call_id", async () => {
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] }],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: [{ role: "user", content: "extract" }],
      servers: [],
      profiles: subagentProfiles([]),
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
      output_schema: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    });
    expect(res.status).toBe("completed");

    const ev = await eventsOf(harness, res.execution_id);
    const started = ev.filter((e) => e.type === "tool_call_started");
    expect(started).toHaveLength(1);
    expect(started[0]!.mcp_name).toBe("submit_result");
    const submit = ev.filter((e) => e.type === "tool_call" && e.mcp_name === "submit_result");
    expect(submit).toHaveLength(1);
    expect(submit[0]!.call_id).toBeTruthy();
    expect(submit[0]!.call_id).toBe(started[0]!.call_id);
  });
});

describe("a timed-out run records what cancellation interrupted", () => {
  it("keeps the in-flight marker while joining the abort-aware provider before return", async () => {
    const llm = new MockLLM({
      script: [{ text: "…thinking forever…", delayMs: 5000 }],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const startedAt = Date.now();
    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: subagentProfiles([]),
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 400000, timeout_ms: 150 },
    });
    expect(res.status).toBe("error");
    expect((res as { error?: { code?: string } }).error?.code).toBe("timeout");
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    const ev = await eventsOf(harness, res.execution_id);
    const started = ev.filter((e) => e.type === "subagent_iteration_started");
    const finished = ev.filter((e) => e.type === "subagent_iteration");
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(finished.length).toBeLessThan(started.length);
  });
});

describe("iteration started edges", () => {
  it("emits subagent_iteration_started before each subagent_iteration; a subagent-only run emits no lead_iteration_started", async () => {
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "tools.shell", arguments: {} }] }, { text: "done" }],
    });
    harness = await makeHarness({ llm, mcpFactory: okTool() });
    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: toolsCfg,
      profiles: subagentProfiles(["tools.shell"]),
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });

    const ev = await eventsOf(harness, res.execution_id);
    expect(ev.filter((e) => e.type === "subagent_iteration_started").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(ev.filter((e) => e.type === "lead_iteration_started")).toHaveLength(0);
    expect(ev.findIndex((e) => e.type === "subagent_iteration_started")).toBeLessThan(
      ev.findIndex((e) => e.type === "subagent_iteration"),
    );
  });

  it("emits lead_iteration_started before each lead_iteration in a Lead+Subagent run", async () => {
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "do it" } }] },
        { text: "subagent done" },
        { text: "final" },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: okTool() });
    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: toolsCfg,
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/x",
          tools: [],
          iteration_limit: 10,
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/x", tools: ["tools.shell"], iteration_limit: 10 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 200000, timeout_ms: 30000 },
    });
    expect(res.status).toBe("completed");

    const ev = await eventsOf(harness, res.execution_id);
    expect(ev.filter((e) => e.type === "lead_iteration_started").length).toBeGreaterThanOrEqual(1);
    expect(ev.findIndex((e) => e.type === "lead_iteration_started")).toBeLessThan(
      ev.findIndex((e) => e.type === "lead_iteration"),
    );
    expect(ev.filter((e) => e.type === "subagent_iteration_started").length).toBeGreaterThanOrEqual(
      1,
    );
  });
});
