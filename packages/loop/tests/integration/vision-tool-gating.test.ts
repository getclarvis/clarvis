import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const providers = [
  {
    name: "anthropic",
    kind: "anthropic" as const,
    models: {
      "vision-model": { context_window_tokens: 200000, capabilities: ["tool_calling", "vision"] },
      "blind-model": { context_window_tokens: 200000, capabilities: ["tool_calling"] },
      uncatalogued: { context_window_tokens: 200000 },
    },
  },
];

async function toolNamesFor(model: string): Promise<string[]> {
  const llm = new MockLLM({ script: [{ text: "done." }] });
  harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}), agentTools: true });
  await harness.run({
    messages: [{ role: "user", content: "list the files" }],
    servers: [],
    entry: "solo",
    providers,
    profiles: [
      {
        name: "solo",
        model: `anthropic/${model}`,
        iteration_limit: 5,
        tools: [],
        grants: ["read_workspace"],
      },
    ],
    budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
  });
  return llm.calls[0]!.tools.map((t) => t.wireName);
}

describe("read_image is offered only to a model that can consume its result", () => {
  it("offers read_image to a vision-capable model", async () => {
    const names = await toolNamesFor("vision-model");
    expect(names).toContain("read_image");
    expect(names).toContain("read_file");
  });

  it("withholds read_image from a model that declares no vision", async () => {
    const names = await toolNamesFor("blind-model");
    expect(names).not.toContain("read_image");
    expect(names).toContain("read_file");
  });

  it("offers read_image when the model declares no capabilities at all", async () => {
    const names = await toolNamesFor("uncatalogued");
    expect(names).toContain("read_image");
  });
});
