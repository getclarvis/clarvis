import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { TraceEvent } from "@clarvis/capability";
import type { Elicit } from "../../src/runtime/tools/ask-user-tool.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const failing = mockMCPFactory({
  filesystem: {
    tools: [
      {
        name: "read",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        call: () => {
          throw new Error("nope");
        },
      },
    ],
  },
});

const body = (over: Record<string, unknown> = {}) => ({
  messages: [{ role: "user", content: "read it" }],
  servers: [{ name: "filesystem", transport: "stdio", command: "node", args: ["-e", ""] }],
  profiles: [
    {
      name: "solo",
      model: "anthropic/claude-sonnet-4-5",
      tools: ["filesystem.read"],
      iteration_limit: 20,
    },
  ],
  entry: "solo",
  budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
  ...over,
});

/** Repeats the same failing call forever, so the doom-loop guard is guaranteed to fire. */
const loopingLlm = (): MockLLM =>
  new MockLLM({
    script: Array.from({ length: 30 }, () => ({
      toolCalls: [{ name: "filesystem.read", arguments: { path: "/x" } }],
      usage: { input_tokens: 10, output_tokens: 2 },
    })),
  });

describe("convergence guards — soft warning tier", () => {
  it("warns the model once before the run dies, and records it", async () => {
    const events: TraceEvent[] = [];
    harness = await makeHarness({
      llm: loopingLlm(),
      mcpFactory: failing,
      onEvent: (e) => events.push(e),
    });

    const res = await harness.run(body());

    expect(res.status).toBe("error");
    const warnings = events.filter((e) => e.type === "convergence_warning");
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { code: string }).code).toBe("tool_failure_loop");
  });

  it("persists the warning alongside the terminate it preceded", async () => {
    harness = await makeHarness({ llm: loopingLlm(), mcpFactory: failing });
    const res = await harness.run(body());

    const detail = await harness.getRun(res.execution_id);
    const kinds = (detail?.trace.events ?? []).map((e) => e.type);
    expect(kinds).toContain("convergence_warning");
  });
});

describe("convergence guards — escalation is opt-in", () => {
  /**
   * The behaviour every existing caller depends on: without the opt-in, a hard
   * trip ends the run outright with the guard's own error code, and nobody is
   * asked anything — even though an elicit channel is present.
   */
  it("never asks when guard_escalation is absent, even with an elicit channel", async () => {
    let asked = 0;
    const elicit: Elicit = () => {
      asked += 1;
      return Promise.resolve({ action: "accept", content: { guard_continue: "continue" } });
    };
    harness = await makeHarness({ llm: loopingLlm(), mcpFactory: failing, elicit });

    const res = await harness.run(body());

    expect(asked).toBe(0);
    expect(res.status).toBe("error");
    if (res.status !== "error") return;
    expect(res.error.code).toBe("tool_failure_loop");
  });

  it("asks and resets the guard when the user says continue", async () => {
    const events: TraceEvent[] = [];
    let asked = 0;
    const elicit: Elicit = () => {
      asked += 1;
      return Promise.resolve({ action: "accept", content: { guard_continue: "continue" } });
    };
    harness = await makeHarness({
      llm: loopingLlm(),
      mcpFactory: failing,
      elicit,
      onEvent: (e) => events.push(e),
    });

    const res = await harness.run(body({ guard_escalation: true }));

    expect(asked).toBeGreaterThan(0);
    const escalations = events.filter((e) => e.type === "guard_escalation");
    expect(escalations.length).toBeGreaterThan(0);
    expect((escalations[0] as { outcome: string }).outcome).toBe("continued");
    expect(res.status).toBe("error");
  });

  it("keeps the guard's own error code when the user declines", async () => {
    const elicit: Elicit = () =>
      Promise.resolve({ action: "accept", content: { guard_continue: "stop" } });
    harness = await makeHarness({ llm: loopingLlm(), mcpFactory: failing, elicit });

    const res = await harness.run(body({ guard_escalation: true }));

    expect(res.status).toBe("error");
    if (res.status !== "error") return;
    expect(res.error.code).toBe("tool_failure_loop");
  });

  it("stops asking once the escalation cap is spent", async () => {
    let asked = 0;
    const elicit: Elicit = () => {
      asked += 1;
      return Promise.resolve({ action: "accept", content: { guard_continue: "continue" } });
    };
    harness = await makeHarness({
      llm: loopingLlm(),
      mcpFactory: failing,
      elicit,
      env: { CLARVIS_GUARD_MAX_ESCALATIONS: "1" },
    });

    const res = await harness.run(body({ guard_escalation: true }));

    expect(asked).toBe(1);
    expect(res.status).toBe("error");
  });

  it("restores terminate-on-trip when the cap is zero", async () => {
    let asked = 0;
    const elicit: Elicit = () => {
      asked += 1;
      return Promise.resolve({ action: "accept", content: { guard_continue: "continue" } });
    };
    harness = await makeHarness({
      llm: loopingLlm(),
      mcpFactory: failing,
      elicit,
      env: { CLARVIS_GUARD_MAX_ESCALATIONS: "0" },
    });

    const res = await harness.run(body({ guard_escalation: true }));

    expect(asked).toBe(0);
    expect(res.status).toBe("error");
  });
});
