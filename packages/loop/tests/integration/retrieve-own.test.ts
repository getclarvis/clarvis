import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("owner retrieves the full record", () => {
  it("returns the full record with status, ISO timestamps, owner, request, response, trace", async () => {
    const llm = new MockLLM({ script: [{ text: "the answer" }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const created = await harness.run({
      messages: [{ role: "user", content: "ask" }],
      servers: [],
      entry: "solo",
      profiles: [
        { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 10000 },
    });
    const id = created.execution_id;

    const res = await harness.getRun(id);
    expect(res).not.toBeNull();
    const body = res! as {
      execution_id: string;
      status: string;
      started_at: string;
      ended_at: string;
      owner_key_name: string;
      request: { messages: { content: string }[] };
      response: { status: string };
      trace: { events: unknown[] };
    };
    expect(body.execution_id).toBe(id);
    expect(body.status).toBe("completed");
    expect(body.owner_key_name).toBe("test");
    expect(body.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(new Date(body.ended_at).getTime()).toBeGreaterThanOrEqual(
      new Date(body.started_at).getTime(),
    );
    expect(body.request.messages[0]!.content).toBe("ask");
    expect(body.response.status).toBe("completed");
    expect(Array.isArray(body.trace.events)).toBe(true);
  });
});
