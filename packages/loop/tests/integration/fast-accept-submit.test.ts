import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import { contentToText } from "@clarvis/capability";
import type { LifecycleHook } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { name: { type: "string" } },
  required: ["name"],
};

const FS_SERVER = [
  { name: "filesystem", transport: "stdio" as const, command: "node", args: ["-e", ""] },
];

/**
 * The one tool-result text an accepted `submit_result` writes into the context,
 * whichever path accepted it. Shared by the fast-accept and the gated test so the
 * two can never drift apart again.
 */
const ACCEPTED_RESULT_TEXT = "Tool 'submit_result' result: accepted";

const BASE_REQUEST = {
  messages: [{ role: "user", content: "go" }],
  servers: [],
  profiles: [{ name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [], iteration_limit: 5 }],
  entry: "solo",
  budget: { on_exceed: "stop", total_token_limit: 100000 },
  output_schema: OUTPUT_SCHEMA,
};

describe("submit_result fast-accept gating", () => {
  it("a batch of [edit-tool, submit_result] takes the slow path and executes the sibling", async () => {
    const written: unknown[] = [];
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { name: "filesystem.write", arguments: { path: "/x", content: "done" } },
            { name: "submit_result", arguments: { name: "Ada" } },
          ],
        },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({
        filesystem: {
          tools: [
            {
              name: "write",
              inputSchema: {
                type: "object",
                properties: { path: { type: "string" }, content: { type: "string" } },
              },
              call: (args) => {
                written.push(args);
                return "written";
              },
            },
          ],
        },
      }),
    });

    const res = await harness.run({
      ...BASE_REQUEST,
      servers: FS_SERVER,
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["filesystem.write"],
          iteration_limit: 5,
        },
      ],
    });

    const body = res as unknown as { status: string; result: unknown };
    expect(body.status).toBe("completed");
    expect(body.result).toEqual({ name: "Ada" });
    expect(written).toEqual([{ path: "/x", content: "done" }]);
  });

  it("a beforeToolUse hook that denies submit_result is honored (no fast-accept bypass)", async () => {
    let denials = 0;
    const seen: string[] = [];
    const hooks: LifecycleHook[] = [
      {
        beforeToolUse: async (ctx) => {
          seen.push(ctx.tool);
          if (ctx.tool === "submit_result" && denials === 0) {
            denials += 1;
            return { kind: "deny", message: "not yet" };
          }
          return { kind: "pass" };
        },
      },
    ];
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
        { toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}), hooks });

    const res = await harness.run(BASE_REQUEST);
    const body = res as unknown as { status: string; result: unknown };
    expect(body.status).toBe("completed");
    expect(body.result).toEqual({ name: "Ada" });
    expect(seen).toContain("submit_result");
    expect(denials).toBe(1);
    expect(llm.calls).toHaveLength(2);
    const secondCallMsgs = llm.calls[1]!.messages.map((m) => contentToText(m.content)).join("\n");
    expect(secondCallMsgs).toContain("DENIED by a workspace hook: not yet");
  });

  it("a plain single valid submit_result still completes (fast path intact)", async () => {
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] }],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run(BASE_REQUEST);
    const body = res as unknown as { status: string; result: unknown };
    expect(body.status).toBe("completed");
    expect(body.result).toEqual({ name: "Ada" });
    expect(llm.calls).toHaveLength(1);
  });

  it("a fast-accepted run's final_context ends with the submit exchange (assistant call + accepted)", async () => {
    const llm = new MockLLM({
      script: [{ toolCalls: [{ name: "submit_result", arguments: { name: "Ada" } }] }],
    });
    harness = await makeHarness({ llm, mcpFactory: mockMCPFactory({}) });

    const res = await harness.run(BASE_REQUEST);
    expect(res.status).toBe("completed");

    const stored = harness.traceStore.getById("test", res.execution_id)!;
    const snap = stored.final_context!;
    expect(snap.length).toBeGreaterThanOrEqual(2);
    const assistantEntry = snap[snap.length - 2]!.message;
    const toolEntry = snap[snap.length - 1]!.message;
    expect(assistantEntry.role).toBe("assistant");
    expect(
      "tool_calls" in assistantEntry ? assistantEntry.tool_calls.map((tc) => tc.name) : [],
    ).toEqual(["submit_result"]);
    expect(toolEntry.role).toBe("tool");
    expect(contentToText(toolEntry.content)).toBe(ACCEPTED_RESULT_TEXT);
  });

  it("a gated submit_result's final_context records the acceptance, not a fabricated failure", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { name: "filesystem.write", arguments: { path: "/x", content: "done" } },
            { name: "submit_result", arguments: { name: "Ada" } },
          ],
        },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({
        filesystem: {
          tools: [
            {
              name: "write",
              inputSchema: {
                type: "object",
                properties: { path: { type: "string" }, content: { type: "string" } },
              },
              call: () => "written",
            },
          ],
        },
      }),
    });

    const res = await harness.run({
      ...BASE_REQUEST,
      servers: FS_SERVER,
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["filesystem.write"],
          iteration_limit: 5,
        },
      ],
    });
    expect(res.status).toBe("completed");

    const stored = harness.traceStore.getById("test", res.execution_id)!;
    const snap = stored.final_context!;
    const toolEntry = snap[snap.length - 1]!.message;
    expect(toolEntry.role).toBe("tool");
    expect(contentToText(toolEntry.content)).toBe(ACCEPTED_RESULT_TEXT);
    expect(contentToText(toolEntry.content)).not.toContain("was not completed");
  });
});
