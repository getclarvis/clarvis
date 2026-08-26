import { describe, it, expect, afterEach, vi } from "../bun-test.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { GateLLM } from "./_gate-llm.ts";
import type { MCPClientFactory } from "@clarvis/mcp-client";
import type { Elicit } from "../../src/runtime/tools/ask-user-tool.ts";
import type { Logger } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

function countingFactory(): { factory: MCPClientFactory; connects: () => number } {
  let connects = 0;
  const base = mockMCPFactory({
    docs: { tools: [{ name: "fetch", inputSchema: {}, call: () => "ok" }] },
  });
  const factory: MCPClientFactory = (tool, relay, opts) => {
    connects += 1;
    return base(tool, relay, opts);
  };
  return { factory, connects: () => connects };
}

function body(shared: boolean): unknown {
  return {
    messages: [{ role: "user", content: "hi" }],
    servers: [
      {
        name: "docs",
        transport: "stdio",
        command: "node",
        args: ["-e", ""],
        ...(shared ? { shared: true } : {}),
      },
    ],
    profiles: [{ name: "solo", model: "anthropic/x", tools: ["docs.fetch"], iteration_limit: 2 }],
    entry: "solo",
    budget: { on_exceed: "stop", total_token_limit: 1000 },
  };
}

describe("Stage 1 — shared stdio server reuse across sequential runs", () => {
  it("opens the subprocess once for two sequential runs when shared: true", async () => {
    const { factory, connects } = countingFactory();
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }, { text: "done" }] }),
      mcpFactory: factory,
    });
    const r1 = await harness.run(body(true));
    const r2 = await harness.run(body(true));
    expect(r1.status).toBe("completed");
    expect(r2.status).toBe("completed");
    expect(connects()).toBe(1);
  });

  it("opens a fresh subprocess per run when shared is absent", async () => {
    const { factory, connects } = countingFactory();
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }, { text: "done" }] }),
      mcpFactory: factory,
    });
    await harness.run(body(false));
    await harness.run(body(false));
    expect(connects()).toBe(2);
  });
});

describe("Stage 2 — concurrent sharing across overlapping runs", () => {
  function sharedBody(executionId: string): unknown {
    return { ...(body(true) as Record<string, unknown>), execution_id: executionId };
  }

  it("two OVERLAPPING runs share one subprocess when shared: true", async () => {
    const { factory, connects } = countingFactory();
    const llm = new GateLLM(() => ({ toolCalls: [], text: "done" }));
    harness = await makeHarness({ llm, mcpFactory: factory });

    const pA = harness.run(sharedBody("ccA"));
    await llm.started(0);
    const pB = harness.run(sharedBody("ccB"));
    await llm.started(1);

    llm.release(0);
    llm.release(1);
    const [rA, rB] = await Promise.all([pA, pB]);

    expect(rA.status).toBe("completed");
    expect(rB.status).toBe("completed");
    expect(connects()).toBe(1);
  });
});

// Pooling was dead code in production. `poolable` required `relay === undefined`,
// but the orchestrator builds a relay whenever `userInputEnabled && elicit`, and
// `userInputEnabled` is true for any run whose budget escalates — which is the
// kernel's own default. The suites above never noticed because they run without
// an elicit channel, so no relay is ever built.
describe("Stage 3 — a run that can ask questions still pools", () => {
  const elicit: Elicit = () => Promise.resolve({ action: "cancel" });

  function askingBody(shared: boolean, executionId?: string): unknown {
    const base = body(shared) as Record<string, unknown>;
    return {
      ...base,
      budget: { on_exceed: "escalate", total_token_limit: 1000 },
      ...(executionId !== undefined ? { execution_id: executionId } : {}),
    };
  }

  function relayCountingFactory(): {
    factory: MCPClientFactory;
    connects: () => number;
    relays: () => (unknown | undefined)[];
  } {
    const seen: (unknown | undefined)[] = [];
    const base = mockMCPFactory({
      docs: { tools: [{ name: "fetch", inputSchema: {}, call: () => "ok" }] },
    });
    const factory: MCPClientFactory = (tool, relay, opts) => {
      seen.push(relay);
      return base(tool, relay, opts);
    };
    return { factory, connects: () => seen.length, relays: () => seen };
  }

  it("reuses one subprocess across two sequential runs that carry a relay", async () => {
    const { factory, connects } = relayCountingFactory();
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }, { text: "done" }] }),
      mcpFactory: factory,
      elicit,
    });
    const r1 = await harness.run(askingBody(true));
    const r2 = await harness.run(askingBody(true));
    expect(r1.status).toBe("completed");
    expect(r2.status).toBe("completed");
    expect(connects()).toBe(1);
  });

  it("shares one subprocess across two OVERLAPPING runs that carry a relay", async () => {
    const { factory, connects } = relayCountingFactory();
    const llm = new GateLLM(() => ({ toolCalls: [], text: "done" }));
    harness = await makeHarness({ llm, mcpFactory: factory, elicit });

    const pA = harness.run(askingBody(true, "relayA"));
    await llm.started(0);
    const pB = harness.run(askingBody(true, "relayB"));
    await llm.started(1);
    llm.release(0);
    llm.release(1);
    const [rA, rB] = await Promise.all([pA, pB]);

    expect(rA.status).toBe("completed");
    expect(rB.status).toBe("completed");
    expect(connects()).toBe(1);
  });

  // A pooled subprocess may serve several runs at once, so there is no single
  // human a server-initiated prompt could be routed to; not advertising the
  // capability is what stops a server from asking into the void.
  it("opens a pooled connection without the relay, and an unshared one with it", async () => {
    const shared = relayCountingFactory();
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }] }),
      mcpFactory: shared.factory,
      elicit,
    });
    await harness.run(askingBody(true));
    expect(shared.relays()).toEqual([undefined]);
    await harness.close();

    const solo = relayCountingFactory();
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }] }),
      mcpFactory: solo.factory,
      elicit,
    });
    await harness.run(askingBody(false));
    expect(solo.relays()[0]).toBeDefined();
  });

  it("warns once per pool key that a shared server cannot elicit", async () => {
    const warnings: unknown[] = [];
    const logger = {
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      warn: (obj: unknown, msg: unknown) => warnings.push({ obj, msg }),
    } as unknown as Logger;
    const { factory } = relayCountingFactory();
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }, { text: "done" }] }),
      mcpFactory: factory,
      elicit,
      logger,
    });
    await harness.run(askingBody(true));
    await harness.run(askingBody(true));

    const elicitationWarnings = warnings.filter((w) =>
      String((w as { msg: unknown }).msg).includes("cannot prompt a human"),
    );
    expect(elicitationWarnings).toHaveLength(1);
  });

  it("does not hand one owner's warm subprocess to another", async () => {
    const { factory, connects } = relayCountingFactory();
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }, { text: "done" }] }),
      mcpFactory: factory,
      elicit,
    });
    await harness.run(askingBody(true), { owner: "alice" });
    await harness.run(askingBody(true), { owner: "bob" });
    expect(connects()).toBe(2);
  });
});
