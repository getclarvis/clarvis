import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

function run(executionId?: string): {
  execution_id?: string;
  messages: { role: "user"; content: string }[];
  servers: never[];
  profiles: { name: string; model: string; tools: string[]; iteration_limit: number }[];
  entry: string;
  budget: { on_exceed: "stop"; total_token_limit: number };
} {
  const body = {
    messages: [{ role: "user" as const, content: "go" }],
    servers: [] as never[],
    profiles: [
      {
        name: "solo",
        model: "anthropic/claude-sonnet-4-5",
        tools: [] as string[],
        iteration_limit: 5,
      },
    ],
    entry: "solo",
    budget: { on_exceed: "stop" as const, total_token_limit: 10000 },
  };
  return executionId ? { execution_id: executionId, ...body } : body;
}

describe("caller-supplied execution_id", () => {
  it("uses the caller id verbatim and makes it retrievable", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run(run("my-app:task-001"));
    expect(res.execution_id).toBe("my-app:task-001");

    expect(await harness.getRun("my-app:task-001")).not.toBeNull();
  });

  it("rejects a duplicate id for the same owner BEFORE running", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const first = await harness.run(run("dup-id"));
    expect(first.execution_id).toBe("dup-id");
    expect(llm.calls).toHaveLength(1);

    await expect(harness.run(run("dup-id"))).rejects.toMatchObject({
      code: "execution_id_conflict",
    });
    expect(llm.calls).toHaveLength(1);
  });

  it("reserves an id while its first run is still in flight", async () => {
    const llm = new MockLLM({ script: [{ text: "done", delayMs: 30 }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const first = harness.run(run("in-flight-id"));
    await expect(harness.run(run("in-flight-id"))).rejects.toMatchObject({
      code: "execution_id_conflict",
    });
    expect((await first).execution_id).toBe("in-flight-id");
    expect(llm.calls).toHaveLength(1);
  });

  it("rejects a malformed execution_id with invalid_execution_id", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    await expect(harness.run(run("bad id with spaces"))).rejects.toMatchObject({
      code: "invalid_execution_id",
    });
    expect(llm.calls).toHaveLength(0);
  });

  it("permits the same id across distinct owners", async () => {
    const llm = new MockLLM({ script: [{ text: "a" }, { text: "b" }] });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      owner: "alice",
    });

    const asAlice = await harness.run(run("shared-task"));
    expect(asAlice.execution_id).toBe("shared-task");

    const asBob = await harness.run(run("shared-task"), { owner: "bob" });
    expect(asBob.execution_id).toBe("shared-task");
  });
});
