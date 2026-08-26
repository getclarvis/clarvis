import { describe, it, expect, afterEach } from "../bun-test.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { Capability, LLMCallParams } from "@clarvis/capability";
import { contentToText } from "@clarvis/capability";

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
  it("captures every request and reports where consecutive ones diverge", async () => {
    const ws = mkdtempSync(join(tmpdir(), "cache-capture-"));
    /**
     * Stands in for the planning capability's canonical block: a volatile entry
     * rewritten in place after every mutating call. It is the one thing in a
     * run that is *not* an append, so it is the thing a prefix-stability check
     * has to exercise. Written here rather than imported, because
     * `@clarvis/loop` may not depend on `@clarvis/plan` — that edge would close
     * a cycle, and `check:graph` enforces it.
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
