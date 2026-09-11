import { expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { createGoalFileHostFixture } from "./goal-file-host.ts";

/** The same complete automatic journey is asserted for native and real container file hosts. */
export async function runGoalFileHostJourney(
  f: Awaited<ReturnType<typeof createGoalFileHostFixture>>,
  options: { guestProbe?: boolean } = {},
) {
  let leadStep = 0;
  let childStep = 0;
  const stageSnapshots: unknown[] = [];
  f.setResponder(async (request) => {
    const isLeader = request.tools?.some((tool) => tool.function.name === "get_goal");
    if (!isLeader) {
      childStep++;
      expect(request.tools?.some((tool) => tool.function.name === "update_goal")).toBe(false);
      if (childStep === 1 && options.guestProbe === true)
        return {
          name: "shell",
          arguments: {
            command:
              "printf 'GOAL-FILE-HOST\\n' > result.txt; uname -s; pwd; sha256sum /usr/local/bin/clarvis-runtime",
            timeout_ms: 5000,
          },
        };
      if (childStep === 1)
        return {
          name: "write_file",
          arguments: { path: "result.txt", content: "GOAL-FILE-HOST\n" },
        };
      if (childStep === 2) return { text: "Created result.txt with the synthetic result." };
      throw new Error("Unexpected child continuation");
    }
    leadStep++;
    switch (leadStep) {
      case 1:
        return {
          name: "create_plan",
          arguments: {
            title: "Delegated goal",
            objective: "Create and verify a synthetic result",
            tasks: [{ title: "Create the result" }],
            validation: [],
          },
        };
      case 2:
        return {
          name: "delegate_task",
          arguments: {
            task_id: "t1",
            title: "Create the result",
            task: "Write GOAL-FILE-HOST followed by a newline to result.txt, then finish.",
            profile: "helper",
          },
        };
      case 3:
        expect(await readFile(join(f.workspaceRoot, "result.txt"), "utf8")).toBe(
          "GOAL-FILE-HOST\n",
        );
        expect((await f.planStore.list()).plans[0]!.tasks[0]!.status).toBe("returned");
        return {
          name: "update_goal",
          arguments: {
            update: {
              action: "checkpoint",
              summary: "Delegated result ready",
              next_step: "Verify it",
            },
          },
        };
      case 4:
        stageSnapshots.push((await f.client.goals.get("conversation")).state.current);
        expect((await f.planStore.list()).plans[0]!.tasks[0]!.status).toBe("returned");
        return { name: "read_file", arguments: { path: "result.txt" } };
      case 5:
        return {
          name: "update_goal",
          arguments: {
            update: {
              action: "checkpoint",
              summary: "Result read back",
              next_step: "Accept and finish",
            },
          },
        };
      case 6: {
        stageSnapshots.push((await f.client.goals.get("conversation")).state.current);
        const plan = (await f.planStore.list()).plans[0]!;
        return {
          name: "transition_plan_task",
          arguments: {
            expected_revision: plan.revision,
            expected_digest: plan.digest,
            expected_spec_digest: plan.spec_digest,
            task_id: "t1",
            status: "done",
            result: "The leader read back and verified GOAL-FILE-HOST",
          },
        };
      }
      case 7:
        return {
          name: "update_goal",
          arguments: {
            update: {
              action: "candidate",
              summary: "Synthetic result verified",
              assessments: [
                {
                  criterion_id: "objective",
                  kind: "qualitative",
                  justification: "Delegated output was read back and the plan was completed",
                },
              ],
            },
          },
        };
      case 8:
        return { text: "GOAL-FILE-HOST verified. All plan tasks are complete." };
      default:
        throw new Error(`Unexpected leader continuation ${leadStep}`);
    }
  });
  const create = {
    session_id: "conversation",
    expected_revision: 0,
    operation_id: "create",
    action: {
      kind: "create" as const,
      objective: "Create and verify the synthetic result with a delegated plan",
      limits: { max_net_tokens: 20000 },
    },
  };
  const receipt = await f.client.goals.control(create);
  await f.until(
    async () => (await f.client.goals.get("conversation")).state.current?.status === "complete",
  );
  await f.until(() => f.host.stats().runs === 0);
  const view = await f.client.goals.get("conversation");
  const goal = view.state.current!;
  expect(view.physical_run).toBeUndefined();
  expect(goal).toMatchObject({ status: "complete", auto_continuations: 2 });
  expect(goal.runs).toHaveLength(3);
  expect(goal.runs.map((run) => run.phase)).toEqual(["closed", "closed", "closed"]);
  expect(goal.runs.map((run) => run.disposition)).toEqual(["checkpoint", "checkpoint", "final"]);
  expect(goal.runs.map((run) => run.automatic)).toEqual([false, true, true]);
  expect(goal.runs[0]!.execution_id).toBe(receipt.execution_id!);
  expect(stageSnapshots).toMatchObject([
    {
      status: "active",
      auto_continuations: 1,
      runs: [{ phase: "closed" }, { phase: "running" }],
    },
    {
      status: "active",
      auto_continuations: 2,
      runs: [{ phase: "closed" }, { phase: "closed" }, { phase: "running" }],
    },
  ]);
  expect(leadStep).toBe(8);
  expect(childStep).toBe(2);
  expect(f.errors).toEqual([]);
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
    net_tokens: totals.input + totals.output - totals.cached,
    usage_unknown: false,
  });
  const session = (await f.client.sessions.get("conversation"))!;
  expect(session.turns.map((turn) => turn.execution_id)).toEqual(
    goal.runs.map((run) => run.execution_id),
  );
  expect(session.totals).toEqual(totals);
  const leaderKey = `conversation_${session.agent_instance_id!}`;
  expect(new Set(f.requests.map((request) => request.prompt_cache_key)).size).toBe(2);
  const lead = f.requests.filter((request) => request.prompt_cache_key === leaderKey);
  expect(lead).toHaveLength(8);
  for (let index = 1; index < lead.length; index++) {
    expect(lead[index]!.messages.slice(0, lead[index - 1]!.messages.length)).toEqual(
      lead[index - 1]!.messages,
    );
    expect(lead[index]!.tools).toEqual(lead[0]!.tools);
  }
  expect((await f.planStore.list()).plans[0]!.tasks[0]!.status).toBe("done");
  expect(await f.client.goals.control(create)).toEqual(receipt);
  expect(f.requests).toHaveLength(10);

  return { goal, session, requests: f.requests, stageSnapshots };
}
