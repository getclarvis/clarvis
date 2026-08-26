import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { Usage } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const IMG = "data:image/png;base64,CAT";

const providers = [
  {
    name: "anthropic",
    kind: "anthropic" as const,
    models: {
      "blind-reader": { context_window_tokens: 200000, capabilities: ["tool_calling"] },
      "vision-subagent": {
        context_window_tokens: 200000,
        capabilities: ["tool_calling", "vision"],
      },
    },
  },
];

describe("subagent-only mode — vision pre-pass usage is reported", () => {
  it("folds the reading model's tokens and iteration into usage.by_agent (no under-count)", async () => {
    const llm = new MockLLM({
      script: [
        { text: "The image shows a cat.", usage: { input_tokens: 500, output_tokens: 80 } },
        { text: "Final answer.", usage: { input_tokens: 100, output_tokens: 20 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "summarize the image" },
            { type: "image", image: IMG, mediaType: "image/png" },
          ],
        },
      ],
      servers: [],
      entry: "reader",
      providers,
      profiles: [
        { name: "reader", model: "anthropic/blind-reader", iteration_limit: 10, tools: [] },
      ],
      vision_model: "anthropic/vision-subagent",
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as { status: string; result: string; usage: Usage };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("Final answer.");

    const reader = body.usage.by_agent.find((a) => a.model.includes("vision-subagent"));
    expect(reader).toBeDefined();
    expect(reader!.type).toBe("vision");
    expect(reader!.input_tokens).toBe(500);
    expect(reader!.output_tokens).toBe(80);
    expect(body.usage.by_agent.length).toBe(2);

    // The pre-pass is one call, not an agent loop: it contributes no iteration,
    // and — the defect this pins — it must never be reported as a sub-agent.
    // The one `subagent` row here is the solo entry agent itself, not the pass.
    expect(body.usage.iterations_used).toBe(1);
    const subagentRows = body.usage.by_agent.filter((a) => a.type === "subagent");
    expect(subagentRows.map((a) => a.model)).toEqual(["anthropic/blind-reader"]);
  });
});
