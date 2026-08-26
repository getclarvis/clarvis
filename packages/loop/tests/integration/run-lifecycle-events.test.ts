import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import { ProviderError } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

type Ev = {
  type: string;
  reason?: string;
  code?: string;
  mode?: string;
  lead_model?: string;
  subagent_model?: string;
  subagent_instance_id?: string;
  kind?: string;
  status?: number;
  agent?: string;
};

async function eventsOf(h: TestHarness, id: string): Promise<Ev[]> {
  const detail = await h.getRun(id);
  return detail!.trace.events as unknown as Ev[];
}

const toolsCfg = [{ name: "tools", transport: "stdio", command: "node", args: ["-e", ""] }];
const soloProfile = (tools: string[]) => [
  { name: "solo", model: "anthropic/x", tools, iteration_limit: 10 },
];
const okTool = () =>
  mockMCPFactory({ tools: { tools: [{ name: "shell", inputSchema: {}, call: () => "ok" }] } });

describe("run boundary (run_started / run_ended)", () => {
  it("emits exactly one run_started first and one run_ended last (reason completed) for a subagent-only run", async () => {
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "tools.shell", arguments: {} }] }, { text: "done" }],
    });
    harness = await makeHarness({ llm, mcpFactory: okTool() });
    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: toolsCfg,
      entry: "solo",
      profiles: soloProfile(["tools.shell"]),
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });
    expect(res.status).toBe("completed");

    const ev = await eventsOf(harness, res.execution_id);
    expect(ev.filter((e) => e.type === "run_started")).toHaveLength(1);
    expect(ev.filter((e) => e.type === "run_ended")).toHaveLength(1);
    expect(ev[0]!.type).toBe("run_started");
    expect(ev[ev.length - 1]!.type).toBe("run_ended");
    expect(ev[0]!.mode).toBe("subagent-only");
    expect(ev[0]!.subagent_model).toBe("anthropic/x");
    expect(ev[0]!.lead_model).toBeUndefined();
    expect(ev[ev.length - 1]!.reason).toBe("completed");
    expect(ev[ev.length - 1]!.code).toBeUndefined();
  });

  it("carries lead_model + subagent_model + mode lead-subagent on run_started in a Lead+Subagent run", async () => {
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
          model: "anthropic/lead",
          tools: [],
          iteration_limit: 10,
          can_spawn: ["subagent"],
        },
        { name: "subagent", model: "anthropic/wrk", tools: ["tools.shell"], iteration_limit: 10 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 200000, timeout_ms: 30000 },
    });
    expect(res.status).toBe("completed");

    const ev = await eventsOf(harness, res.execution_id);
    const started = ev.find((e) => e.type === "run_started")!;
    expect(started.mode).toBe("lead-subagent");
    expect(started.lead_model).toBe("anthropic/lead");
    expect(started.subagent_model).toBe("anthropic/wrk");
  });

  it("reason=timeout when the stall deadline fires on a hung model call", async () => {
    const llm = new MockLLM({ script: [{ text: "…hung…", delayMs: 5000 }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      entry: "solo",
      profiles: soloProfile([]),
      budget: { on_exceed: "stop", total_token_limit: 400000, timeout_ms: 150 },
    });
    expect(res.status).toBe("error");

    const ev = await eventsOf(harness, res.execution_id);
    const ended = ev.find((e) => e.type === "run_ended")!;
    expect(ended.reason).toBe("timeout");
    expect(ended.code).toBe("timeout");
  });

  it("reason=guard_trip (code tool_failure_loop) when a doom loop trips", async () => {
    const fail = { toolCalls: [{ name: "tools.shell", arguments: { x: 1 } }] };
    const llm = new MockLLM({ script: [fail, fail, fail, fail, fail] });
    const mcp = mockMCPFactory({
      tools: {
        tools: [
          {
            name: "shell",
            inputSchema: {},
            call: () => {
              throw new Error("boom");
            },
          },
        ],
      },
    });
    harness = await makeHarness({ llm, mcpFactory: mcp });
    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: toolsCfg,
      entry: "solo",
      profiles: soloProfile(["tools.shell"]),
      budget: { on_exceed: "stop", total_token_limit: 400000, timeout_ms: 30000 },
    });
    expect(res.status).toBe("error");

    const ev = await eventsOf(harness, res.execution_id);
    const ended = ev.find((e) => e.type === "run_ended")!;
    expect(ended.reason).toBe("guard_trip");
    expect(ended.code).toBe("tool_failure_loop");
  });

  it("reason=guard_trip (code empty_response) when the model returns nothing usable", async () => {
    const llm = new MockLLM({ script: [{}, {}] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      entry: "solo",
      profiles: soloProfile([]),
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });
    expect(res.status).toBe("error");

    const ev = await eventsOf(harness, res.execution_id);
    const ended = ev.find((e) => e.type === "run_ended")!;
    expect(ended.reason).toBe("guard_trip");
    expect(ended.code).toBe("empty_response");
  });
});

describe("delegation_started", () => {
  it("emits delegation_started for the subagent-only implicit Subagent (no delegation_created), before the first subagent_iteration_started", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      entry: "solo",
      profiles: soloProfile([]),
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });
    expect(res.status).toBe("completed");

    const ev = await eventsOf(harness, res.execution_id);
    expect(ev.filter((e) => e.type === "delegation_started")).toHaveLength(1);
    expect(ev.filter((e) => e.type === "delegation_created")).toHaveLength(0);
    expect(ev.findIndex((e) => e.type === "delegation_started")).toBeLessThan(
      ev.findIndex((e) => e.type === "subagent_iteration_started"),
    );
  });

  it("emits delegation_started for a spawned Subagent, paired with delegation_created by subagent_instance_id", async () => {
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
    const spawned = ev.filter((e) => e.type === "delegation_created");
    const started = ev.filter((e) => e.type === "delegation_started");
    expect(spawned).toHaveLength(1);
    expect(started).toHaveLength(1);
    expect(started[0]!.subagent_instance_id).toBe(spawned[0]!.subagent_instance_id);
    expect(ev.indexOf(spawned[0]!)).toBeLessThan(ev.indexOf(started[0]!));
  });
});

describe("model_call_error", () => {
  it("records a classified model_call_error before the run ends in a provider error", async () => {
    const llm = new MockLLM({
      script: [
        {
          throw: new ProviderError("rate limited", {
            kind: "transient",
            status: 429,
            retryAfterMs: 1000,
          }),
        },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      entry: "solo",
      profiles: soloProfile([]),
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });
    expect(res.status).toBe("error");

    const ev = await eventsOf(harness, res.execution_id);
    const mce = ev.filter((e) => e.type === "model_call_error");
    expect(mce).toHaveLength(1);
    expect(mce[0]!.agent).toBe("subagent");
    expect(mce[0]!.kind).toBe("transient");
    expect(mce[0]!.status).toBe(429);
    const ended = ev.find((e) => e.type === "run_ended")!;
    expect(ended.reason).toBe("error");
    expect(ended.code).toBe("provider_error");
    expect(ev.findIndex((e) => e.type === "model_call_error")).toBeLessThan(
      ev.findIndex((e) => e.type === "run_ended"),
    );
  });
});
