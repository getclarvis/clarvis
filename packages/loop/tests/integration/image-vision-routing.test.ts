import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { LiveMessage } from "@clarvis/capability";

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
      "vision-lead": { context_window_tokens: 200000, capabilities: ["tool_calling", "vision"] },
      "vision-subagent": {
        context_window_tokens: 200000,
        capabilities: ["tool_calling", "vision"],
      },
      "blind-lead": { context_window_tokens: 200000, capabilities: ["tool_calling"] },
    },
  },
];

function hasImagePart(messages: LiveMessage[], image: string): boolean {
  return messages.some(
    (m) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === "image" && p.image === image),
  );
}

describe("image routing — lead-driven image_refs", () => {
  it.each([
    ["vision-lead", true],
    ["blind-lead", false],
  ])("uses only the selected %s model for an image turn", async (model, sighted) => {
    const llm = new MockLLM({ script: [{ text: "Done." }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this." },
            { type: "image", image: IMG, mediaType: "image/png" },
          ],
        },
      ],
      servers: [],
      entry: "lead",
      providers,
      profiles: [{ name: "lead", model: `anthropic/${model}`, iteration_limit: 10, tools: [] }],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    expect((res as unknown as { status: string }).status).toBe("completed");
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.model).toBe(model);
    expect(llm.calls[0]?.capabilities?.has("vision") ?? false).toBe(sighted);
  });

  it("hands the turn's pasted image to the spawned Subagent's model via image_refs", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              name: "spawn_subagent",
              arguments: {
                title: "see",
                task: "Describe the attached image.",
                profile: "vision_agent",
                image_refs: [0],
              },
            },
          ],
        },
        { text: "A cat." },
        { text: "Final: it is a cat." },
      ],
    });

    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", image: IMG, mediaType: "image/png" },
          ],
        },
      ],
      servers: [],
      entry: "lead",
      providers,
      profiles: [
        {
          name: "lead",
          model: "anthropic/vision-lead",
          iteration_limit: 10,
          tools: [],
          can_spawn: ["vision_agent"],
        },
        {
          name: "vision_agent",
          model: "anthropic/vision-subagent",
          iteration_limit: 10,
          tools: [],
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as { status: string; result: string };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("Final: it is a cat.");

    const subagentCalls = llm.calls.filter((c) => c.model === "vision-subagent");
    expect(subagentCalls.length).toBe(1);
    expect(hasImagePart(subagentCalls[0]!.messages, IMG)).toBe(true);

    const leadCall = llm.calls.find((c) => c.model === "vision-lead")!;
    expect(
      (
        leadCall.tools.find((t) => t.fullName === "spawn_subagent")!.inputSchema as {
          properties: Record<string, unknown>;
        }
      ).properties.image_refs,
    ).toBeDefined();
  });

  it("omits image_refs when no profile's model can receive an image", async () => {
    const llm = new MockLLM({ script: [{ text: "Final without vision." }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", image: IMG, mediaType: "image/png" },
          ],
        },
      ],
      servers: [],
      entry: "lead",
      providers,
      profiles: [
        {
          name: "lead",
          model: "anthropic/vision-lead",
          iteration_limit: 10,
          tools: [],
          can_spawn: ["plain_subagent"],
        },
        {
          name: "plain_subagent",
          model: "anthropic/blind-lead",
          iteration_limit: 10,
          tools: [],
          grants: ["read_workspace"],
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });
    expect((res as unknown as { status: string }).status).toBe("completed");
    const leadCall = llm.calls.find((c) => c.model === "vision-lead")!;
    expect(
      (
        leadCall.tools.find((t) => t.fullName === "spawn_subagent")!.inputSchema as {
          properties: Record<string, unknown>;
        }
      ).properties.image_refs,
    ).toBeUndefined();
  });

  it("a blind lead routes images it cannot see to a vision-capable Sub-agent", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              name: "spawn_subagent",
              arguments: {
                title: "see",
                task: "Describe the attached image.",
                profile: "vision_agent",
                image_refs: [0],
              },
            },
          ],
        },
        { text: "A cat." },
        { text: "Final: the Sub-agent saw a cat." },
      ],
    });

    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", image: IMG, mediaType: "image/png" },
          ],
        },
      ],
      servers: [],
      entry: "lead",
      providers,
      profiles: [
        {
          name: "lead",
          model: "anthropic/blind-lead",
          iteration_limit: 10,
          tools: [],
          can_spawn: ["vision_agent"],
        },
        {
          name: "vision_agent",
          model: "anthropic/vision-subagent",
          iteration_limit: 10,
          tools: [],
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as { status: string; result: string };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("Final: the Sub-agent saw a cat.");

    // The parameter is offered on the strength of the *child's* model, never the
    // lead's: a lead that cannot see is still the one that decides who looks.
    const leadCall = llm.calls.find((c) => c.model === "blind-lead")!;
    expect(
      (
        leadCall.tools.find((t) => t.fullName === "spawn_subagent")!.inputSchema as {
          properties: Record<string, unknown>;
        }
      ).properties.image_refs,
    ).toBeDefined();

    // The bytes reach the child, addressed by the index of the `[image #k]`
    // marker the lead saw.
    const subagentCall = llm.calls.find((c) => c.model === "vision-subagent")!;
    expect(hasImagePart(subagentCall.messages, IMG)).toBe(true);

    // The lead never *sees* them: its call declares no `vision`, which is what
    // makes the provider boundary replace each image with a numbered
    // placeholder. That substitution is `@clarvis/llm`'s (`toModelMessages`),
    // below the port this mock records, so the assertion here is on the flag
    // that drives it rather than on the rendered content.
    expect(leadCall.capabilities?.has("vision") ?? false).toBe(false);
    expect(subagentCall.capabilities?.has("vision")).toBe(true);
  });

  it("offers image_refs to a blind lead", async () => {
    const llm = new MockLLM({ script: [{ text: "Final." }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    await harness.run({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", image: IMG, mediaType: "image/png" },
          ],
        },
      ],
      servers: [],
      entry: "lead",
      providers,
      profiles: [
        {
          name: "lead",
          model: "anthropic/blind-lead",
          iteration_limit: 10,
          tools: [],
          can_spawn: ["vision_agent"],
        },
        {
          name: "vision_agent",
          model: "anthropic/vision-subagent",
          iteration_limit: 10,
          tools: [],
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });
    // The lead can pass the image to a sighted child.
    expect(llm.calls.length).toBe(1);
    const leadCall = llm.calls[0]!;
    expect(
      (
        leadCall.tools.find((t) => t.fullName === "spawn_subagent")!.inputSchema as {
          properties: Record<string, unknown>;
        }
      ).properties.image_refs,
    ).toBeDefined();
  });
});
