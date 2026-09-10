import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import type { LiveMessage } from "@clarvis/capability";

const open: TestHarness[] = [];
afterEach(async () => {
  await Promise.all(open.map((h) => h.close()));
  open.length = 0;
});

const IMG_OLD = "data:image/png;base64,OLD";
const IMG_A = "data:image/png;base64,AAA";
const IMG_B = "data:image/png;base64,BBB";

const providers = [
  {
    name: "anthropic",
    kind: "anthropic" as const,
    models: {
      "blind-lead": { context_window_tokens: 200000, capabilities: ["tool_calling"] },
      "vision-subagent": {
        context_window_tokens: 200000,
        capabilities: ["tool_calling", "vision"],
      },
    },
  },
];

const profiles = [
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
];

function imageParts(messages: LiveMessage[]): string[] {
  return messages.flatMap((m) =>
    m.role === "user" && Array.isArray(m.content)
      ? m.content.filter((p) => p.type === "image").map((p) => (p as { image: string }).image)
      : [],
  );
}

describe("continue_from — image marker alignment for a no-vision entry", () => {
  it("preserves prior-turn images while current-turn delegation references remain local", async () => {
    const store = createMemoryTraceStore();

    const llm1 = new MockLLM({
      script: [{ text: "prior image reading" }, { text: "turn 1 done" }],
    });
    const h1 = await makeHarness({ llm: llm1, mcpFactory: mockMCPFactory({}), traceStore: store });
    open.push(h1);
    const run1 = await h1.run({
      messages: [
        { role: "user", content: [{ type: "text", text: "some background" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image", image: IMG_OLD, mediaType: "image/png" },
          ],
        },
      ],
      servers: [],
      entry: "lead",
      providers,
      profiles,
      vision_model: "anthropic/vision-subagent",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });
    expect((run1 as { status: string }).status).toBe("completed");
    const priorId = (run1 as { execution_id: string }).execution_id;

    const llm2 = new MockLLM({
      script: [{ text: "current image reading" }, { text: "turn 2 done" }],
    });
    const h2 = await makeHarness({ llm: llm2, mcpFactory: mockMCPFactory({}), traceStore: store });
    open.push(h2);
    const run2 = await h2.run({
      continue_from: priorId,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "now these two" },
            { type: "image", image: IMG_A, mediaType: "image/png" },
            { type: "image", image: IMG_B, mediaType: "image/png" },
          ],
        },
      ],
      servers: [],
      entry: "lead",
      providers,
      profiles,
      vision_model: "anthropic/vision-subagent",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });
    expect((run2 as { status: string }).status).toBe("completed");

    const leadCall = llm2.calls.find((c) => c.model === "blind-lead")!;
    const imgs = imageParts(leadCall.messages);
    expect(imgs).toContain(IMG_A);
    expect(imgs).toContain(IMG_B);
    expect(imgs).toContain(IMG_OLD);
    const hasHistoricalMarker = leadCall.messages.some(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === "text" && p.text.includes("earlier turn")),
    );
    expect(hasHistoricalMarker).toBe(false);
  });

  it("preserves prior-turn images verbatim when the entry model CAN see them (no collapse)", async () => {
    const store = createMemoryTraceStore();
    const visionProviders = [
      {
        name: "anthropic",
        kind: "anthropic" as const,
        models: {
          "vision-lead": {
            context_window_tokens: 200000,
            capabilities: ["tool_calling", "vision"],
          },
        },
      },
    ];
    const visionProfiles = [
      { name: "solo", model: "anthropic/vision-lead", iteration_limit: 10, tools: [] },
    ];

    const llm1 = new MockLLM({ script: [{ text: "turn 1 done" }] });
    const h1 = await makeHarness({ llm: llm1, mcpFactory: mockMCPFactory({}), traceStore: store });
    open.push(h1);
    const run1 = await h1.run({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", image: IMG_OLD, mediaType: "image/png" },
          ],
        },
      ],
      servers: [],
      entry: "solo",
      providers: visionProviders,
      profiles: visionProfiles,
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });
    expect((run1 as { status: string }).status).toBe("completed");

    const llm2 = new MockLLM({ script: [{ text: "turn 2 done" }] });
    const h2 = await makeHarness({ llm: llm2, mcpFactory: mockMCPFactory({}), traceStore: store });
    open.push(h2);
    await h2.run({
      continue_from: (run1 as { execution_id: string }).execution_id,
      messages: [
        { role: "user", content: [{ type: "image", image: IMG_A, mediaType: "image/png" }] },
      ],
      servers: [],
      entry: "solo",
      providers: visionProviders,
      profiles: visionProfiles,
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });

    const call = llm2.calls.find((c) => c.model === "vision-lead")!;
    const imgs = imageParts(call.messages);
    expect(imgs).toContain(IMG_OLD);
    expect(imgs).toContain(IMG_A);
  });
});
