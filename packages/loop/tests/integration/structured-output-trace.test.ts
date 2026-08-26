import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { plaintiff_name: { type: "string" } },
  required: ["plaintiff_name"],
};

interface ToolCallEvent {
  type: string;
  mcp_name?: string;
  tool_name?: string;
  result?: string;
  error?: string | null;
}

describe("submit_result calls and validation failures are in the trace", () => {
  it("records both the rejected and the accepted submit_result invocations", async () => {
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "submit_result", arguments: { age: 42 } }] },
        { toolCalls: [{ name: "submit_result", arguments: { plaintiff_name: "Jane" } }] },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const post = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
      output_schema: SCHEMA,
    });
    const executionId = post.execution_id;

    const detail = await harness.getRun(executionId);
    expect(detail).not.toBeNull();
    const events = (detail! as { trace: { events: ToolCallEvent[] } }).trace.events;

    const submitEvents = events.filter(
      (e) => e.type === "tool_call" && e.mcp_name === "submit_result",
    );
    expect(submitEvents).toHaveLength(2);
    expect(submitEvents.some((e) => e.error && /rejected/.test(e.error))).toBe(true);
    expect(submitEvents.some((e) => e.error === null && e.result === "accepted")).toBe(true);
  });
});
