import { afterEach, describe, expect, it } from "bun:test";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ElicitationRequest } from "@clarvis/protocol";
import { runGoalFileHostJourney } from "../helpers/goal-file-host-journey.ts";
import { createGoalFileHostFixture } from "../helpers/goal-file-host.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("goal plan review through the file host and IPC", () => {
  it.each(["cancel", "request_changes"] as const)(
    "preserves the unapproved plan and stops automatic work after %s",
    async (decision) => {
      const f = await createGoalFileHostFixture({ plansMode: "review", planRetention: "discard" });
      cleanups.push(f.close);
      f.setResponder(async () => {
        switch (f.requests.length) {
          case 1:
            return {
              name: "create_plan",
              arguments: {
                title: "Review before work",
                objective: "Create an approved result",
                tasks: [{ title: "Write result.txt" }],
                validation: [],
              },
            };
          case 2:
            return {
              name: "write_file",
              arguments: { path: "result.txt", content: "Must require approval" },
            };
          case 3:
            return {
              name: "update_goal",
              arguments: {
                update: {
                  action: "checkpoint",
                  summary: "Plan proposed",
                  next_step: "Perform the work",
                },
              },
            };
          case 4:
            expect(decision).toBe("request_changes");
            return {
              name: "update_goal",
              arguments: {
                update: { action: "blocked", reason: "The human requested plan changes" },
              },
            };
          default:
            throw new Error("Unexpected model call after refused review");
        }
      });
      const receipt = await f.client.goals.control({
        session_id: "conversation",
        expected_revision: 0,
        operation_id: "create",
        action: {
          kind: "create",
          objective: "Wait for approval before writing result.txt",
          limits: { max_net_tokens: 10000 },
        },
      });
      const attached = await f.client.hosting!.attach({
        execution_id: receipt.execution_id!,
        host_generation: "generation",
        control: "acquire",
      });
      const questions: ElicitationRequest[] = [];
      attached.handle.onElicit((question) => questions.push(question));
      await f.until(() => questions.length === 1);
      expect(questions[0]!.kind).toBe("plan_review");
      expect(f.requests).toHaveLength(3);
      await expect(access(join(f.workspaceRoot, "result.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await f.client.goals.get("conversation")).state.current!.auto_continuations).toBe(0);
      await attached.handle.respond({
        id: questions[0]!.id,
        action: "accept",
        content: { decision, feedback: "Do not execute this plan" },
      });
      await attached.handle.closed;
      await f.until(() => f.host.stats().runs === 0);
      const goal = (await f.client.goals.get("conversation")).state.current!;
      expect(goal.status).toBe("blocked");
      expect(goal.auto_continuations).toBe(0);
      expect(goal.runs).toHaveLength(1);
      expect(goal.runs[0]!.phase).toBe("closed");
      expect(goal.runs[0]!.disposition).not.toBe("checkpoint");
      expect(f.requests).toHaveLength(decision === "cancel" ? 3 : 4);
      expect(f.errors).toEqual([]);
      expect(questions).toHaveLength(1);
      const plans = (await f.planStore.list()).plans;
      expect(plans).toHaveLength(1);
      expect(plans[0]!.tasks[0]!.status).toBe("pending");
      expect(plans[0]!.status).not.toBe("completed");
      expect(plans[0]!.approved_spec_revision).toBeUndefined();
      await expect(access(join(f.workspaceRoot, "result.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("retains human approval across delegated work and two automatic checkpoints", async () => {
    const f = await createGoalFileHostFixture({ plansMode: "review" });
    cleanups.push(f.close);
    const journey = runGoalFileHostJourney(f).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await f.until(
      async () => (await f.client.goals.get("conversation")).physical_run !== undefined,
    );
    const view = await f.client.goals.get("conversation");
    const attached = await f.client.hosting!.attach({
      execution_id: view.physical_run!.execution_id,
      host_generation: "generation",
      control: "acquire",
    });
    const questions: ElicitationRequest[] = [];
    attached.handle.onElicit((question) => questions.push(question));
    await f.until(() => questions.length === 1);
    expect(questions[0]!.kind).toBe("plan_review");
    await expect(access(join(f.workspaceRoot, "result.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await attached.handle.respond({
      id: questions[0]!.id,
      action: "accept",
      content: { decision: "approve" },
    });
    const outcome = await journey;
    if ("error" in outcome) throw outcome.error;
    expect(outcome.value.goal.status).toBe("complete");
    expect(questions).toHaveLength(1);
    const plan = (await f.planStore.list()).plans[0]!;
    expect(plan.approved_spec_revision).toBe(plan.spec_revision);
  });
});
