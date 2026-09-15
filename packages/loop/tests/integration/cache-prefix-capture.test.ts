import { describe, it, expect, afterEach } from "../bun-test.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { Capability, LLMCallParams } from "@clarvis/capability";
import { contentToText } from "@clarvis/capability";
import { AiSdkAdapter } from "@clarvis/llm/adapter";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** Everything a provider's implicit prefix cache keys on, in wire order. */
function renderPrefix(p: LLMCallParams): string {
  const tools = (p.tools ?? [])
    .map(
      (t) =>
        `<tool>${t.wireName ?? (t as { name?: string }).name}|${JSON.stringify(t.inputSchema)}|${t.description}\n`,
    )
    .join("");
  const msgs = p.messages.map((m) => `<${m.role}>${contentToText(m.content)}\n`).join("");
  return `TOOLS\n${tools}MESSAGES\n${msgs}`;
}

function firstDivergence(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

describe("what a provider's prefix cache actually sees", () => {
  it("preserves every serialized historical item across reminders and revisions", async () => {
    const requests: Array<{ messages: unknown[]; tools: unknown; stream?: boolean }> = [];
    let steps = 0;
    const reminders: Capability = {
      name: "cache-reminders",
      forRun: () => ({
        name: "cache-reminders",
        forAgent: () => ({
          attach: (bc) => ({
            hooks: {
              beforeIteration: () => {
                bc.ctx.setStableBlock(
                  "test-document",
                  `Document revision ${Math.floor(steps / 2)}`,
                );
                bc.ctx.setCanonicalState(`Plan reminder revision ${Math.floor(steps / 2)}`);
              },
            },
            tools: [
              {
                fullName: "cache_step",
                wireName: "cache_step",
                mcpName: "",
                toolName: "cache_step",
                description: "Read the next synthetic cursor.",
                inputSchema: { type: "object", properties: {} },
              },
            ],
            handlers: [
              {
                matches: (call) => call.name === "cache_step",
                handle: () => {
                  steps += 1;
                  return Promise.resolve({
                    kind: "result" as const,
                    text: `cursor ${steps}`,
                    progress: true,
                  });
                },
              },
            ],
          }),
        }),
      }),
    };
    const transport = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== "string") throw new Error("expected serialized SDK body");
        const body = JSON.parse(init.body) as (typeof requests)[number];
        requests.push(body);
        const name = steps < 4 ? "cache_step" : "submit_result";
        const args = name === "submit_result" ? { result: "complete" } : {};
        const tool = {
          index: 0,
          id: `call-${requests.length}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        };
        const chunk = {
          id: `response-${requests.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "cache-test",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", tool_calls: [tool] },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 20000 + steps * 1000,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    harness = await makeHarness({
      llm: new AiSdkAdapter({ fetch: transport }),
      mcpFactory: mockMCPFactory({}),
      capabilities: [reminders],
    });
    const result = await harness.run({
      messages: [{ role: "user", content: "Follow all four cursors then submit the result." }],
      servers: [],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "openai-compatible/cache-test",
          tools: [],
          can_spawn: ["worker"],
          iteration_limit: 8,
        },
        { name: "worker", model: "openai-compatible/cache-test", tools: [], iteration_limit: 4 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 300000 },
      output_schema: {
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
        additionalProperties: false,
      },
    });
    expect(result).toMatchObject({ status: "completed" });
    expect(steps).toBe(4);
    expect(requests).toHaveLength(5);
    for (let index = 1; index < requests.length; index += 1) {
      const previous = requests[index - 1]!;
      const current = requests[index]!;
      expect(current.tools).toEqual(previous.tools);
      expect(
        current.messages.slice(0, previous.messages.length),
        `serialized request ${index + 1}`,
      ).toEqual(previous.messages);
    }
  });

  it("captures every request and reports where consecutive ones diverge", async () => {
    const ws = mkdtempSync(join(tmpdir(), "cache-capture-"));
    /**
     * Stands in for a capability's canonical reminder: each revision appends
     * while earlier publications remain in the serialized history. The real
     * product composition belongs to the kernel tests, because
     * `@clarvis/loop` may not depend on product capabilities;
     * `check:graph` enforces that ownership boundary.
     */
    let blockRevision = 0;
    const canonicalBlock: Capability = {
      name: "fake-plan-block",
      forRun: () => ({
        name: "fake-plan-block",
        forAgent: () => ({
          attach: (bc) => ({
            handlers: [
              {
                matches: (c) => c.name === "note_progress",
                handle: () => {
                  blockRevision += 1;
                  bc.ctx.setCanonicalState(
                    `Plan file: plan.md\nRevision ${blockRevision}. Pass these uncompleted tasks on.`,
                  );
                  return Promise.resolve({
                    kind: "result" as const,
                    text: `noted ${blockRevision}`,
                    progress: true,
                  });
                },
              },
            ],
            tools: [
              {
                fullName: "note_progress",
                wireName: "note_progress",
                mcpName: "",
                toolName: "note_progress",
                description: "Record progress and refresh the canonical block.",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          }),
        }),
      }),
    };

    const call = (name: string, args: Record<string, unknown> = {}) => ({
      toolCalls: [{ name, arguments: args }],
    });
    const llm = new MockLLM({
      script: [
        call("list_dir"),
        call("write_file", { path: "a.js", content: "1" }),
        call("note_progress"),
        call("note_progress"),
        call("write_file", { path: "b.js", content: "2" }),
        call("transition_plan_task", {
          transitions: [{ task_id: "t1", to: "done", result: "ok" }],
        }),
        call("write_file", { path: "c.js", content: "3" }),
        /* A result far past the truncation threshold: the append path that
           rewrites content into a head/tail marker and spills the rest. */
        call("write_file", { path: "big.txt", content: "x".repeat(200_000) }),
        call("read_file", { path: "big.txt" }),
        call("shell", { command: "echo hello" }),
        call("monitor_start", { command: "sleep 30", ready_when: "never" }),
        call("monitor_list"),
        call("edit_file", { path: "a.js", old_string: "1", new_string: "9" }),
        call("transition_plan_task", {
          transitions: [{ task_id: "t2", to: "done", result: "ok" }],
        }),
        { toolCalls: [{ name: "submit_result", arguments: { result: "done" } }] },
      ],
    });

    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: ws,
      agentTools: true,
      capabilities: [canonicalBlock],
    });

    await harness.run({
      messages: [{ role: "user", content: "build it" }],
      servers: [],
      entry: "coder",
      profiles: [
        {
          name: "coder",
          model: "openai-compatible/deepseek",
          tools: [],
          grants: ["edit_workspace", "read_workspace", "run_commands"],
          iteration_limit: 20,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 400_000 },
    });

    const renders = llm.calls.map(renderPrefix);
    expect(renders.length).toBeGreaterThan(10);

    /**
     * What a provider actually bills. An append survives 100%; the canonical
     * block is the one deliberate exception — it is rewritten every iteration
     * and lives in the trailing volatile run, so a new tool result inserted
     * ahead of it shifts it and re-charges its own length and nothing more.
     *
     * The floor is what makes this a regression test rather than a
     * description: a block that drifted earlier in the transcript, or a
     * mutation of any durable entry, collapses survival far below it, and no
     * ordinary assertion on message *contents* would notice.
     */
    const survival = renders.slice(1).map((cur, i) => {
      const prev = renders[i]!;
      return { request: i + 2, ratio: firstDivergence(prev, cur) / prev.length };
    });
    const damaging = survival.filter((s) => s.ratio <= 0.99);
    expect(damaging).toEqual([]);

    /* The tool array is part of the cached prefix. It is bound once per run in
       `run-agent.ts`; a capability that recomputed it per iteration would cost
       the whole prefix on every call and nothing else would report it. */
    const toolSets = new Set(
      llm.calls.map((c) => JSON.stringify((c.tools ?? []).map((t) => t.wireName))),
    );
    expect(toolSets.size).toBe(1);

    /* The one cache-affecting request field: it must not wander per call. */
    expect(new Set(llm.calls.map((c) => c.promptCacheKey)).size).toBe(1);
  });
});
