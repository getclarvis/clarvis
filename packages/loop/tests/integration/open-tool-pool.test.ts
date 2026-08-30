import { describe, it, expect, afterEach } from "../bun-test.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import {
  MCPAuthorizationPendingError,
  MCPBackgroundConnectDeferredError,
  type MCPClientFactory,
} from "@clarvis/mcp-client";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("openToolPool — profile references a tool absent from the opened pool", () => {
  it("rejects with invalid_profile naming the missing tool ref and the actual pool", async () => {
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }] }),
      mcpFactory: mockMCPFactory({ docs: { tools: [{ name: "fetch", call: () => "ok" }] } }),
    });
    const res = await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [{ name: "docs", transport: "stdio", command: "node", args: ["-e", ""] }],
      profiles: [
        { name: "solo", model: "anthropic/x", tools: ["docs.missing"], iteration_limit: 2 },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 1000 },
    });
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.error.code).toBe("invalid_profile");
      expect(res.error.message).toContain("docs.missing");
      expect(res.error.message).toContain("docs.fetch");
    }
  });
});

describe("openToolPool — host-composed automatic server tools", () => {
  it("lets a profile with no persisted MCP tools call every tool of an automatic server", async () => {
    harness = await makeHarness({
      llm: new MockLLM({
        script: [{ toolCalls: [{ name: "docs.fetch", arguments: {} }] }, { text: "done" }],
      }),
      mcpFactory: mockMCPFactory({
        docs: { tools: [{ name: "fetch", call: () => "official docs" }] },
      }),
    });
    const res = await harness.run({
      messages: [{ role: "user", content: "use the docs plugin" }],
      servers: [
        {
          name: "docs",
          transport: "stdio",
          command: "node",
          args: ["-e", ""],
          auto_tools: true,
        },
      ],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 10_000 },
    });

    expect(res.status).toBe("completed");
    if (res.status === "completed") expect(res.result).toBe("done");
  });
});

describe("openToolPool — degraded startup when some servers fail to connect", () => {
  it("continues with no MCP tools when every browser authorization is pending", async () => {
    const authorizationWaits: Array<string | undefined> = [];
    const mcpFactory: MCPClientFactory = async (_server, _relay, options) => {
      authorizationWaits.push(options?.authorizationWait);
      throw new MCPAuthorizationPendingError();
    };
    const events: { type: string }[] = [];
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "run continued" }] }),
      mcpFactory,
      onEvent: (event) => events.push(event),
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "continue without oauth" }],
      servers: [
        { name: "expo", transport: "http", url: "https://example.test/expo" },
        { name: "supabase", transport: "http", url: "https://example.test/supabase" },
      ],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 2 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 1_000 },
    });

    expect(res.status).toBe("completed");
    if (res.status === "completed") expect(res.result).toBe("run continued");
    expect(authorizationWaits).toEqual(["background", "background"]);
    expect(events.some((event) => event.type === "mcp_degraded")).toBe(true);
  });

  it("degrades an empty pool when browser authorization is pending beside a terminal failure", async () => {
    const authorizationWaits: Array<string | undefined> = [];
    const mcpFactory: MCPClientFactory = async (server, _relay, options) => {
      authorizationWaits.push(options?.authorizationWait);
      if (server.name === "oauth") throw new MCPAuthorizationPendingError();
      throw new Error("connection refused");
    };
    const events: Array<{ type: string; servers?: Array<{ name: string }> }> = [];
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "run continued" }] }),
      mcpFactory,
      onEvent: (event) => events.push(event as (typeof events)[number]),
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "continue despite mixed MCP failures" }],
      servers: [
        { name: "oauth", transport: "http", url: "https://example.test/oauth" },
        { name: "broken", transport: "stdio", command: "node", args: ["-e", ""] },
      ],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 2 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 1_000 },
    });

    expect(res.status).toBe("completed");
    expect(authorizationWaits).toEqual(["background", "background"]);
    expect(
      events
        .find((event) => event.type === "mcp_degraded")
        ?.servers?.map((server) => server.name)
        .sort(),
    ).toEqual(["broken", "oauth"]);
  });

  it("continues when background connection admission is already occupied", async () => {
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "run continued" }] }),
      mcpFactory: async () => {
        throw new MCPBackgroundConnectDeferredError(1);
      },
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "continue without the busy MCP" }],
      servers: [{ name: "busy", transport: "http", url: "https://example.test/busy" }],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 2 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 1_000 },
    });

    expect(res.status).toBe("completed");
    if (res.status === "completed") expect(res.result).toBe("run continued");
  });

  it("keeps a second run alive while the first run's OAuth owns connection capacity", async () => {
    let finishAuthorization!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishAuthorization = resolve;
    });
    let physicalAttempts = 0;
    const events: Array<{ type: string }> = [];
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "first continued" }, { text: "second continued" }] }),
      mcpFactory: async () => {
        physicalAttempts += 1;
        throw new MCPAuthorizationPendingError(completion);
      },
      mcpLimits: { maxConnections: 1, maxParallelConnects: 4 },
      onEvent: (event) => events.push(event),
    });
    const request = {
      messages: [{ role: "user", content: "continue while OAuth is ignored" }],
      servers: [{ name: "oauth", transport: "http", url: "https://example.test/oauth" }],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 2 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 1_000 },
    };

    const first = await harness.run(request);
    const second = await harness.run(request);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(physicalAttempts).toBe(1);
    expect(events.filter((event) => event.type === "mcp_degraded")).toHaveLength(2);
    finishAuthorization();
  });

  it("proceeds with the servers that connected and records an mcp_degraded event", async () => {
    const events: { type: string }[] = [];
    harness = await makeHarness({
      llm: new MockLLM({
        script: [{ toolCalls: [{ name: "good.fetch", arguments: {} }] }, { text: "done" }],
      }),
      mcpFactory: mockMCPFactory({
        good: { tools: [{ name: "fetch", call: () => "ok" }] },
        broken: { tools: [], connectError: new Error("connection refused") },
      }),
      onEvent: (e) => events.push(e),
    });
    const res = await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [
        { name: "good", transport: "stdio", command: "node", args: ["-e", ""] },
        { name: "broken", transport: "stdio", command: "node", args: ["-e", ""] },
      ],
      profiles: [{ name: "solo", model: "anthropic/x", tools: ["good.fetch"], iteration_limit: 3 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });
    expect(res.status).toBe("completed");
    const degraded = events.find((e) => e.type === "mcp_degraded") as
      | { type: "mcp_degraded"; servers: { name: string; transport: string; reason: string }[] }
      | undefined;
    expect(degraded).toBeDefined();
    expect(degraded!.servers.map((s) => s.name)).toEqual(["broken"]);
    expect(degraded!.servers[0]!.transport).toBe("stdio");
    const detail = await harness.getRun(res.execution_id);
    expect(detail?.trace.events.some((e) => e.type === "mcp_degraded")).toBe(true);
  });

  it("treats a profile ref to a FAILED server's tool as unavailable, not invalid_profile", async () => {
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }] }),
      mcpFactory: mockMCPFactory({
        good: { tools: [{ name: "fetch", call: () => "ok" }] },
        broken: { tools: [], connectError: new Error("connection refused") },
      }),
    });
    const res = await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [
        { name: "good", transport: "stdio", command: "node", args: ["-e", ""] },
        { name: "broken", transport: "stdio", command: "node", args: ["-e", ""] },
      ],
      profiles: [
        { name: "solo", model: "anthropic/x", tools: ["broken.gone"], iteration_limit: 3 },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });
    expect(res.status).toBe("completed");
  });
});
