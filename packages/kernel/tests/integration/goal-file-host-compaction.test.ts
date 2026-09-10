import { afterEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent } from "@clarvis/protocol";
import { createGoalFileHostFixture } from "../helpers/goal-file-host.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("goal compaction through the real file host and SDK", () => {
  it("keeps one summary anchor, goal and plan across compaction and automatic continuation", async () => {
    const f = await createGoalFileHostFixture({ preserveRecentTokens: 0 });
    cleanups.push(f.close);
    const corpus = Array.from(
      { length: 120 },
      (_, index) => `CORPUS-${index}: ${"Synthetic historical detail. ".repeat(4)}`,
    ).join("\n");
    await writeFile(join(f.workspaceRoot, "corpus.txt"), corpus);
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    cleanups.push(async () => release.resolve());
    const summary =
      "GOAL-COMPACT-GIST: Read the corpus and wrote result.txt with 42; verification is pending.";
    let leadStep = 0;
    let summaryCalls = 0;
    f.setResponder(async (request) => {
      if (!request.tools?.length) {
        expect(JSON.stringify(request.messages)).toContain("Transcript to compact:");
        expect(JSON.stringify(request.messages)).toContain("CORPUS-0");
        summaryCalls++;
        return { text: summary };
      }
      leadStep++;
      switch (leadStep) {
        case 1:
          return {
            name: "create_plan",
            arguments: {
              title: "Preserve the plan across compaction",
              objective: "Read the corpus and verify result.txt",
              tasks: [{ title: "Verify result.txt" }],
              validation: [],
            },
          };
        case 2:
          return { name: "read_file", arguments: { path: "corpus.txt" } };
        case 3:
          return { name: "write_file", arguments: { path: "result.txt", content: "42\n" } };
        case 4:
          arrived.resolve();
          await release.promise;
          return { name: "read_file", arguments: { path: "result.txt" } };
        case 5:
          expect(summaryCalls).toBe(1);
          expect((await f.planStore.list()).plans[0]!.tasks[0]!.status).toBe("pending");
          return {
            name: "update_goal",
            arguments: {
              update: {
                action: "checkpoint",
                summary: "Compacted the earlier corpus and preserved the result",
                next_step: "Verify and accept the result",
              },
            },
          };
        case 6:
          return { name: "read_file", arguments: { path: "result.txt" } };
        case 7: {
          const plan = (await f.planStore.list()).plans[0]!;
          return {
            name: "transition_plan_task",
            arguments: {
              expected_revision: plan.revision,
              expected_digest: plan.digest,
              expected_spec_digest: plan.spec_digest,
              task_id: "t1",
              status: "done",
              result: "Read back 42 after automatic continuation",
            },
          };
        }
        case 8:
          return {
            name: "update_goal",
            arguments: {
              update: {
                action: "candidate",
                summary: "Verified the compacted task",
                assessments: [
                  {
                    criterion_id: "objective",
                    kind: "qualitative",
                    justification:
                      "The result survived compaction and was verified in the next stage",
                  },
                ],
              },
            },
          };
        case 9:
          return { text: "Verified 42 after compaction and continuation." };
        default:
          throw new Error("Unexpected goal compaction continuation");
      }
    });
    const receipt = await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Preserve GOAL-COMPACT through compaction and verify result.txt",
        limits: { max_net_tokens: 20000 },
      },
    });
    await arrived.promise;
    const attached = await f.client.hosting!.attach({
      execution_id: receipt.execution_id!,
      host_generation: "generation",
      control: "acquire",
    });
    const events: RunEvent[] = [];
    const drained = (async () => {
      for await (const frame of attached.handle.events) events.push(frame.event);
    })().then(
      () => undefined,
      (error: unknown) => error,
    );
    await attached.handle.compact("Retain the result and open plan for the next goal stage");
    release.resolve();
    await f.until(
      async () => (await f.client.goals.get("conversation")).state.current?.status === "complete",
    );
    await f.until(() => f.host.stats().runs === 0);
    expect(await drained).toBeUndefined();
    const goal = (await f.client.goals.get("conversation")).state.current!;
    expect(goal).toMatchObject({ status: "complete", auto_continuations: 1 });
    expect(goal.runs.map((run) => run.disposition)).toEqual(["checkpoint", "final"]);
    expect(goal.runs.every((run) => run.phase === "closed")).toBe(true);
    expect(summaryCalls).toBe(1);
    expect(f.requests).toHaveLength(10);
    expect(f.errors).toEqual([]);
    const compactions = events.filter((event) => event.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]).toMatchObject({ operation: "summarization", requested: true });
    const lead = f.requests.filter((request) => request.tools?.length);
    expect(lead).toHaveLength(9);
    expect(new Set(f.requests.map((request) => request.prompt_cache_key)).size).toBe(1);
    for (let index = 1; index < lead.length; index++) {
      const before = lead[index - 1]!;
      const after = lead[index]!;
      if (index === 4) {
        expect(after.messages.slice(0, before.messages.length)).not.toEqual(before.messages);
        expect(JSON.stringify(after.messages)).not.toContain("CORPUS-0");
      } else {
        expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
      }
      expect(after.tools).toEqual(lead[0]!.tools);
      if (index >= 4) {
        const text = JSON.stringify(after.messages);
        expect(text).toContain(summary);
        expect(text.match(/rolling summary of earlier context/gu)).toHaveLength(1);
        expect(text).toContain("GOAL-COMPACT through compaction");
        expect(text).toContain("Read the corpus and verify result.txt");
        expect(text).toContain("Verify result.txt");
        expect(text).toContain("expected_spec_digest:");
      }
    }
    const totals = f.usages.reduce(
      (sum, usage) => ({
        input: sum.input + usage.input,
        output: sum.output + usage.output,
        cached: sum.cached + usage.cached,
      }),
      { input: 0, output: 0, cached: 0 },
    );
    expect(goal.consumption).toMatchObject({
      ...totals,
      net_tokens: totals.input - totals.cached + totals.output,
      usage_unknown: false,
    });
    const session = (await f.client.sessions.get("conversation"))!;
    expect(session.totals).toEqual(totals);
    expect((await f.planStore.list()).plans[0]!.tasks[0]!.status).toBe("done");
  });
});
