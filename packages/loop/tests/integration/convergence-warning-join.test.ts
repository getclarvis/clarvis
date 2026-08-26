/**
 * Two soft warnings in one iteration become one runtime note, not two.
 *
 * @remarks `appendRuntimeNote` replaces any earlier note of the same kind, which
 * is what keeps a stale warning from accumulating across iterations. The
 * consequence is that calling it twice in a *single* iteration would silently
 * delete the first warning before the model ever saw it — so the loop joins the
 * messages and appends once. The trace still records one entry per warning:
 * the note is what the model reads, the entries are the account of what fired.
 *
 * Making both guards warn in the same iteration is not incidental to the test.
 * The batch first repeats one failure enough to warn, then repeats one successful
 * call consecutively enough to warn. The later success clears the doom counters,
 * but not the warning already queued for the iteration.
 */
import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { TraceEvent } from "@clarvis/capability";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const mixed = mockMCPFactory({
  fs: {
    tools: [
      {
        name: "bad",
        inputSchema: { type: "object", properties: {} },
        call: () => {
          throw new Error("nope");
        },
      },
      { name: "same", inputSchema: { type: "object", properties: {} }, call: () => "constant" },
    ],
  },
});

/** Two failures feed the doom guard; two consecutive constant successes feed stagnation. */
const bothGuards = (): MockLLM =>
  new MockLLM({
    script: Array.from({ length: 30 }, () => ({
      toolCalls: [
        { name: "fs.bad", arguments: {} },
        { name: "fs.bad", arguments: {} },
        { name: "fs.same", arguments: {} },
        { name: "fs.same", arguments: {} },
      ],
      usage: { input_tokens: 10, output_tokens: 2 },
    })),
  });

const body = {
  messages: [{ role: "user", content: "go" }],
  servers: [{ name: "fs", transport: "stdio", command: "node", args: ["-e", ""] }],
  profiles: [
    {
      name: "solo",
      model: "anthropic/claude-sonnet-4-5",
      tools: ["fs.bad", "fs.same"],
      iteration_limit: 20,
    },
  ],
  entry: "solo",
  budget: { on_exceed: "stop", total_token_limit: 100_000, timeout_ms: 30_000 },
};

/** Every distinct `[runtime: …]` note the model was shown. */
function notesShown(llm: MockLLM): string[] {
  const seen = new Set<string>();
  for (const call of llm.calls) {
    for (const message of call.messages as { content: unknown }[]) {
      if (typeof message.content === "string" && message.content.startsWith("[runtime:")) {
        seen.add(message.content);
      }
    }
  }
  return [...seen];
}

describe("both convergence guards warning in one iteration", () => {
  it("joins them into a single note rather than letting the second erase the first", async () => {
    const llm = bothGuards();
    harness = await makeHarness({ llm, mcpFactory: mixed });

    await harness.run(body);

    const joined = notesShown(llm).filter((note) => note.includes(" Also: "));
    expect(joined).toHaveLength(1);
    expect(joined[0]).toContain("the identical tool call has now failed");
    expect(joined[0]).toContain("has returned the identical result");
  });

  it("never shows the stagnation warning without the doom warning it shared an iteration with", async () => {
    const llm = bothGuards();
    harness = await makeHarness({ llm, mcpFactory: mixed });

    await harness.run(body);

    const stagnationOnly = notesShown(llm).filter(
      (note) =>
        note.includes("has returned the identical result") &&
        !note.includes("the identical tool call has now failed"),
    );
    expect(stagnationOnly).toEqual([]);
  });

  it("still records one trace entry per warning, so the account is not joined too", async () => {
    const events: TraceEvent[] = [];
    harness = await makeHarness({
      llm: bothGuards(),
      mcpFactory: mixed,
      onEvent: (e) => events.push(e),
    });

    await harness.run(body);

    const codes = events
      .filter((e) => e.type === "convergence_warning")
      .map((e) => (e as { code: string }).code);
    expect(codes).toContain("tool_failure_loop");
    expect(codes).toContain("stagnation_detected");
  });
});
