import { afterEach, describe, expect, it } from "../bun-test.ts";
import type { Elicit } from "../../src/runtime/tools/ask-user-tool.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("the integration harness capability default", () => {
  it("offers no opt-in tool capability when the request merely carries its grants", async () => {
    const llm = new MockLLM({ script: [{ text: "done" }] });
    const elicit: Elicit = async () => ({ action: "decline" });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}), elicit });

    const result = await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [],
      profiles: [
        {
          name: "solo",
          model: "anthropic/x",
          tools: [],
          grants: ["ask_user", "read_workspace", "edit_workspace", "run_commands"],
          iteration_limit: 2,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 1_000 },
    });

    expect(result.status).toBe("completed");
    expect(llm.calls[0]!.tools.map((tool) => tool.wireName)).toEqual([]);
  });
});
