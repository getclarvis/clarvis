import { describe, it, expect, afterEach, vi } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { TraceStore } from "@clarvis/trace";
import type { Logger } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

function failingStore(): TraceStore {
  return {
    insert() {
      throw new Error("attempt to write a readonly database");
    },
    getById: () => null,
    replaceFinalContext: async () => false,
    list: () => ({ items: [], total: 0 }),
    deleteById: () => false,
    deleteOwner: () => 0,
    existsForOwner: () => false,
    cleanup: () => 0,
  };
}

describe("persistence failure surfaces, never silent", () => {
  it("rejects with persistence_failure and logs the result for recovery", async () => {
    const errorLog = vi.fn();
    const logger = {
      error: errorLog,
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
    const llm = new MockLLM({ script: [{ text: "done" }] });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      traceStore: failingStore(),
      logger,
    });

    await expect(
      harness.run({
        messages: [{ role: "user", content: "go" }],
        servers: [],
        profiles: [
          { name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 },
        ],
        entry: "solo",
        budget: { on_exceed: "stop", total_token_limit: 10000 },
      }),
    ).rejects.toMatchObject({ code: "persistence_failure" });

    expect(errorLog).toHaveBeenCalledTimes(1);
    const [logObj] = errorLog.mock.calls[0] as [Record<string, unknown>, string];
    expect(logObj).toMatchObject({ event: "run.persist_failed", status: "completed" });
    expect(typeof logObj.cause).toBe("string");
  });
});
