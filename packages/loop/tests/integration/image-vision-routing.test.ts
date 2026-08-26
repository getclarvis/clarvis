import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { LiveMessage, Usage } from "@clarvis/capability";

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

  it("offers image_refs to a blind lead even when no vision_model is configured", async () => {
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
    // No pre-pass ran (no vision_model), so this is the only route to the image.
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

describe("image routing — automatic vision pre-pass", () => {
  const blindSolo = [
    { name: "solo", model: "anthropic/blind-lead", iteration_limit: 10, tools: [] },
  ];

  function imageTurn(text?: string) {
    return [
      {
        role: "user" as const,
        content:
          text === undefined
            ? [{ type: "image" as const, image: IMG, mediaType: "image/png" }]
            : [
                { type: "text" as const, text },
                { type: "image" as const, image: IMG, mediaType: "image/png" },
              ],
      },
    ];
  }

  function injected(messages: LiveMessage[], needle: string): boolean {
    return messages.some(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("[image analysis]") &&
        m.content.includes(needle),
    );
  }

  it("reads the turn's images with vision_model and injects the reading", async () => {
    const llm = new MockLLM({
      script: [
        { text: "The image shows a cat sitting on a mat." },
        { text: "Final answer based on the analysis." },
      ],
    });

    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: imageTurn("summarize the image"),
      servers: [],
      entry: "solo",
      providers,
      profiles: blindSolo,
      vision_model: "anthropic/vision-subagent",
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const body = res as unknown as { status: string; result: string };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("Final answer based on the analysis.");

    const readerCalls = llm.calls.filter((c) => c.model === "vision-subagent");
    expect(readerCalls.length).toBe(1);
    expect(hasImagePart(readerCalls[0]!.messages, IMG)).toBe(true);
    expect(
      injected(llm.calls.find((c) => c.model === "blind-lead")!.messages, "cat sitting on a mat"),
    ).toBe(true);
  });

  it("reads with no tools and no agent identity — it is a call, not a sub-agent", async () => {
    const llm = new MockLLM({ script: [{ text: "A cat." }, { text: "Final." }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    await harness.run({
      messages: imageTurn("look"),
      servers: [],
      entry: "solo",
      providers,
      profiles: blindSolo,
      vision_model: "anthropic/vision-subagent",
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const reader = llm.calls.find((c) => c.model === "vision-subagent")!;
    expect(reader.tools).toEqual([]);
    expect(llm.calls.length).toBe(2);
  });

  it("does not pre-pass when the run names no vision_model", async () => {
    const llm = new MockLLM({ script: [{ text: "Final without vision." }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: imageTurn("what is this?"),
      servers: [],
      entry: "solo",
      providers,
      profiles: blindSolo,
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });
    const body = res as unknown as { status: string; result: string };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("Final without vision.");
    expect(llm.calls.length).toBe(1);
  });

  it("does not pre-pass when the entry model can see the images itself", async () => {
    const llm = new MockLLM({ script: [{ text: "Final, seen directly." }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: imageTurn("what is this?"),
      servers: [],
      entry: "solo",
      providers,
      profiles: [{ name: "solo", model: "anthropic/vision-lead", iteration_limit: 10, tools: [] }],
      vision_model: "anthropic/vision-subagent",
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });
    const body = res as unknown as { status: string; result: string };
    expect(body.status).toBe("completed");
    expect(llm.calls.length).toBe(1);
    expect(hasImagePart(llm.calls[0]!.messages, IMG)).toBe(true);
  });

  it("survives a failing vision call: no injection, the run still completes", async () => {
    const llm = new MockLLM({
      script: [{ throw: new Error("vision boom") }, { text: "Final after failure." }],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: imageTurn("describe"),
      servers: [],
      entry: "solo",
      providers,
      profiles: blindSolo,
      vision_model: "anthropic/vision-subagent",
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });
    const body = res as unknown as { status: string; result: string };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("Final after failure.");
    const entryCall = llm.calls.find((c) => c.model === "blind-lead")!;
    expect(
      entryCall.messages.some(
        (m) => typeof m.content === "string" && m.content.includes("[image analysis]"),
      ),
    ).toBe(false);
  });

  it("injects nothing when the vision model returns blank text", async () => {
    const llm = new MockLLM({ script: [{ text: "   " }, { text: "Final after blank." }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: imageTurn("describe"),
      servers: [],
      entry: "solo",
      providers,
      profiles: blindSolo,
      vision_model: "anthropic/vision-subagent",
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });
    const body = res as unknown as { status: string; result: string };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("Final after blank.");
    const entryCall = llm.calls.find((c) => c.model === "blind-lead")!;
    expect(
      entryCall.messages.some(
        (m) => typeof m.content === "string" && m.content.includes("[image analysis]"),
      ),
    ).toBe(false);
  });

  it("reads an image-only turn (no accompanying text)", async () => {
    const llm = new MockLLM({
      script: [{ text: "It is a diagram of a data pipeline." }, { text: "Final." }],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: imageTurn(),
      servers: [],
      entry: "solo",
      providers,
      profiles: blindSolo,
      vision_model: "anthropic/vision-subagent",
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });
    const body = res as unknown as { status: string; result: string };
    expect(body.status).toBe("completed");
    expect(
      injected(llm.calls.find((c) => c.model === "blind-lead")!.messages, "data pipeline"),
    ).toBe(true);
  });

  it("refuses a vision_model that declares capabilities without vision, and never claims a reading", async () => {
    const llm = new MockLLM({ script: [{ text: "Final." }] });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: imageTurn("what is this?"),
      servers: [],
      entry: "solo",
      providers,
      profiles: blindSolo,
      // declares tool_calling only — the provider boundary would strip the
      // images and it would answer from placeholders.
      vision_model: "anthropic/blind-lead",
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });
    expect((res as unknown as { status: string }).status).toBe("completed");

    // No call was made at all, and nothing told the entry agent an image was read.
    expect(llm.calls.length).toBe(1);
    const entryCall = llm.calls[0]!;
    expect(
      entryCall.messages.some(
        (m) => typeof m.content === "string" && m.content.includes("[image analysis]"),
      ),
    ).toBe(false);
  });

  it("keeps a reading the provider cut off, but labels it as cut off", async () => {
    const llm = new MockLLM({
      script: [{ text: "A cat sitting on a", finishReason: "length" }, { text: "Final." }],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    await harness.run({
      messages: imageTurn("describe"),
      servers: [],
      entry: "solo",
      providers,
      profiles: blindSolo,
      vision_model: "anthropic/vision-subagent",
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });
    const entryCall = llm.calls.find((c) => c.model === "blind-lead")!;
    const injected = entryCall.messages
      .map((m) => m.content)
      .filter((c): c is string => typeof c === "string")
      .find((c) => c.includes("[image analysis]"));
    expect(injected).toBeDefined();
    expect(injected).toContain("CUT OFF");
    expect(injected).toContain("A cat sitting on a");
  });

  it("reports the reading as its own usage row, never as a spawned sub-agent", async () => {
    const llm = new MockLLM({
      script: [
        { text: "A cat.", usage: { input_tokens: 500, output_tokens: 80 } },
        { text: "Final.", usage: { input_tokens: 100, output_tokens: 20 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: imageTurn("summarize"),
      servers: [],
      entry: "lead",
      providers,
      profiles: [
        {
          name: "lead",
          model: "anthropic/blind-lead",
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
      vision_model: "anthropic/vision-subagent",
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });

    const usage = (res as unknown as { usage: Usage }).usage;
    const reader = usage.by_agent.find((a) => a.model === "anthropic/vision-subagent");
    expect(reader).toBeDefined();
    expect(reader!.type).toBe("vision");
    expect(reader!.input_tokens).toBe(500);

    // The lead spawned nothing. Reporting the pre-pass as a sub-agent claimed a
    // child no client could poll, steer or stop.
    const lead = usage.by_agent.find((a) => a.type === "lead");
    expect(lead?.subagents_spawned).toBe(0);
    expect(usage.by_agent.some((a) => a.type === "subagent" && a.instances! > 0)).toBe(false);
  });

  it("reads for a blind lead too, without spawning any sub-agent", async () => {
    const llm = new MockLLM({
      script: [{ text: "A cat on a mat." }, { text: "Final from the lead." }],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });
    const res = await harness.run({
      messages: imageTurn("summarize"),
      servers: [],
      entry: "lead",
      providers,
      profiles: [
        {
          name: "lead",
          model: "anthropic/blind-lead",
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
      vision_model: "anthropic/vision-subagent",
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    });
    const body = res as unknown as { status: string; result: string };
    expect(body.status).toBe("completed");
    expect(body.result).toBe("Final from the lead.");
    expect(llm.calls.filter((c) => c.model === "vision-subagent").length).toBe(1);
    expect(
      injected(llm.calls.find((c) => c.model === "blind-lead")!.messages, "cat on a mat"),
    ).toBe(true);
  });
});
