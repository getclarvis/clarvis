import { describe, expect, it } from "bun:test";
import { createGoalFileHostFixture } from "../helpers/goal-file-host.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("Goal Steward through the native host and SDK", () => {
  it("reviews completion without receiving repository instructions", async () => {
    const f = await createGoalFileHostFixture({ plansMode: "off" });
    try {
      await writeFile(join(f.root, "global", "AGENTS.md"), "Global fallback: verify results.");
      await writeFile(join(f.root, "global", "CLARVIS.md"), "Global policy: verify results.");
      await writeFile(
        join(f.workspaceRoot, "AGENTS.md"),
        "Workspace policy: return the concrete answer.",
      );
      await writeFile(join(f.workspaceRoot, "answer.txt"), "The answer is 42.\n");
      f.setResponder(async () => {
        if (f.requests.length === 1)
          return {
            name: "read_file",
            arguments: { path: "answer.txt" },
            commentary: "Inspecting the answer",
          };
        if (f.requests.length === 2) {
          await writeFile(
            join(f.workspaceRoot, "AGENTS.md"),
            "Later policy must wait for a new work run.",
          );
          return {
            name: "update_goal",
            arguments: {
              update: {
                action: "candidate",
                summary: "Answer ready",
                assessments: [
                  {
                    criterion_id: "objective",
                    kind: "qualitative",
                    justification: "Answer inspected",
                    evidence_ids: [],
                  },
                ],
              },
            },
          };
        }
        return { text: "The answer is 42." };
      });
      f.setStewardResponder(async (request) => {
        const frame = JSON.parse(
          String(request.messages.findLast((message) => message.role === "user")!.content),
        );
        expect(frame.evidence[0].id).toMatch(/^evidence-[a-f0-9]{32}$/u);
        return {
          name: "submit_result",
          arguments: {
            decision: "completion",
            verdict: "achieved",
            summary: "Answer provided",
            assessments: ["definition", "objective"].map((scope) => ({
              scope,
              verdict: "satisfied",
              rationale: "Answer observed",
              evidence_ids: [frame.evidence[0].id],
            })),
          },
        };
      });
      await f.client.goals.control({
        session_id: "conversation",
        expected_revision: 0,
        operation_id: "create",
        action: {
          kind: "create",
          objective: "Provide the answer",
          limits: { max_net_tokens: 10000 },
        },
      });
      await f.until(
        async () => (await f.client.goals.get("conversation")).state.current?.status === "complete",
      );
      await f.until(() => f.host.stats().runs === 0);
      const goal = (await f.client.goals.get("conversation")).state.current!;
      expect(
        f.host.kernel
          .readRunTrace(goal.runs[0]!.execution_id)
          ?.some((event) => event.type === "user_steering"),
      ).toBe(false);
      expect(f.stewardRequests).toHaveLength(1);
      for (const request of f.stewardRequests) {
        const configuration = request.messages.filter((message) =>
          String(message.content).startsWith('{"goal_steward_configuration_v1":'),
        );
        expect(configuration).toHaveLength(0);
        expect(JSON.stringify(request.messages)).not.toContain("Global policy: verify results.");
        expect(JSON.stringify(request.messages)).not.toContain(
          "Workspace policy: return the concrete answer.",
        );
      }
      expect(JSON.stringify(f.requests[0]!.messages)).toContain(
        "Workspace policy: return the concrete answer.",
      );
    } finally {
      await f.close();
    }
  });
  it("reviews host-provided context without receiving exploration tools", async () => {
    const f = await createGoalFileHostFixture({ plansMode: "off" });
    try {
      await writeFile(join(f.workspaceRoot, "answer.txt"), "42\n");
      f.setResponder(async () => {
        if (f.requests.length === 1)
          return {
            name: "read_file",
            arguments: { path: "answer.txt" },
            commentary: "Checking the answer",
          };
        if (f.requests.length === 2) {
          return {
            name: "update_goal",
            arguments: {
              update: {
                action: "candidate",
                summary: "Answer ready",
                assessments: [
                  {
                    criterion_id: "objective",
                    kind: "qualitative",
                    justification: "Read answer",
                    evidence_ids: [],
                  },
                ],
              },
            },
          };
        }
        return { text: "42" };
      });
      let completionCalls = 0;
      f.setStewardResponder(async (request) => {
        completionCalls++;
        expect(request.tools!.map((tool) => tool.function.name)).toEqual(["submit_result"]);
        return {
          name: "submit_result",
          arguments: {
            decision: "completion",
            verdict: "achieved",
            summary: "Answer delivered",
            assessments: ["definition", "objective"].map((scope) => ({
              scope,
              verdict: "satisfied",
              rationale: "Read answer",
              evidence_ids: [],
            })),
          },
        };
      });
      await f.client.goals.control({
        session_id: "conversation",
        expected_revision: 0,
        operation_id: "create",
        action: {
          kind: "create",
          objective: "Read answer.txt and report the answer",
          limits: { max_net_tokens: 10000 },
        },
      });
      await f.until(
        async () => (await f.client.goals.get("conversation")).state.current?.status === "complete",
      );
      await f.until(() => f.host.stats().runs === 0);
      expect(completionCalls).toBe(1);
      const goal = (await f.client.goals.get("conversation")).state.current!;
      expect(goal.runs[0]!.steward_review_count).toBe(1);
      expect(goal.steward!.consumption.net_tokens).toBeGreaterThan(0);
      expect(goal.runs[0]!.steward_reviews!.at(-1)!.decision).toBe("achieved");
      for (let index = 1; index < f.stewardRequests.length; index++) {
        const previous = f.stewardRequests[index - 1]!;
        const next = f.stewardRequests[index]!;
        expect(next.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
        expect(next.tools).toEqual(previous.tools);
        expect(next.prompt_cache_key).toBe(previous.prompt_cache_key);
      }
    } finally {
      await f.close();
    }
  });
  it("returns unfinished work to the same run and preserves the private serialized prefix", async () => {
    const f = await createGoalFileHostFixture({ plansMode: "off" });
    try {
      const command = `"${process.execPath}" -e "process.stdout.write('CHECK_EXECUTED_OK')"`;
      f.setResponder(async () => {
        if (f.requests.length === 1) return { name: "shell", arguments: { command, cwd: "." } };
        if (f.requests.length === 2)
          return {
            name: "update_goal",
            arguments: {
              update: {
                action: "candidate",
                summary: "Answer prepared",
                assessments: [
                  {
                    criterion_id: "objective",
                    kind: "qualitative",
                    justification: "Answer available",
                    evidence_ids: [],
                  },
                ],
              },
            },
          };
        return { text: f.requests.length === 3 ? "Draft answer" : "Complete answer" };
      });
      f.setStewardResponder(async () => {
        const achieved = f.stewardRequests.length > 1;
        return {
          name: "submit_result",
          arguments: {
            decision: "completion",
            verdict: achieved ? "achieved" : "needs_work",
            summary: achieved ? "Delivered" : "Draft is incomplete",
            ...(achieved ? {} : { next_step: "Provide the complete answer" }),
            assessments: [
              {
                scope: "definition",
                verdict: "satisfied",
                rationale: "Definition is current",
                evidence_ids: [],
              },
              {
                scope: "objective",
                verdict: achieved ? "satisfied" : "unsatisfied",
                rationale: "Read the proposed answer",
                evidence_ids: [],
              },
            ],
          },
        };
      });
      await f.client.goals.control({
        session_id: "conversation",
        expected_revision: 0,
        operation_id: "create",
        action: {
          kind: "create",
          objective: "Provide the complete answer",
          limits: { max_net_tokens: 10000 },
        },
      });
      await f.until(
        async () => (await f.client.goals.get("conversation")).state.current?.status === "complete",
      );
      await f.until(() => f.host.stats().runs === 0);
      expect(f.errors).toEqual([]);
      expect(f.requests).toHaveLength(4);
      expect(f.stewardRequests).toHaveLength(2);
      const [first, second] = f.stewardRequests;
      expect(second!.messages.slice(0, first!.messages.length)).toEqual(first!.messages);
      expect(second!.tools).toEqual(first!.tools);
      expect(first!.prompt_cache_key).toBe("conversation_goal-steward");
      expect(second!.prompt_cache_key).toBe(first!.prompt_cache_key);
      expect(first!.tools!.map((tool) => tool.function.name)).toEqual(["submit_result"]);
      const firstFrame = JSON.parse(
        String(first!.messages.findLast((message) => message.role === "user")!.content),
      ) as { evidence: Array<{ id: string }> };
      const secondFrame = JSON.parse(
        String(second!.messages.findLast((message) => message.role === "user")!.content),
      ) as { evidence: Array<{ id: string }> };
      expect(firstFrame.evidence[0]!.id).toMatch(/^evidence-[a-f0-9]{32}$/u);
      expect(secondFrame.evidence[0]!.id).toBe(firstFrame.evidence[0]!.id);
      const goal = (await f.client.goals.get("conversation")).state.current!;
      expect(goal.runs).toHaveLength(1);
      expect(goal.runs[0]!.steward_reviews!.map((review) => review.decision)).toEqual([
        "needs_work",
        "achieved",
      ]);
      expect(goal.steward!.consumption.net_tokens).toBeGreaterThan(0);
      const frame = String(
        second!.messages.findLast((message) => message.role === "user")!.content,
      );
      expect(frame).not.toContain('"definition":');
      expect(frame).not.toContain(goal.goal_id);
      expect(frame).not.toContain(goal.runs[0]!.execution_id);
    } finally {
      await f.close();
    }
  });
});

it.each([false, true])(
  "completion review receives authenticated checkpoint history without repository instructions (changed=%s)",
  async (changed) => {
    const f = await createGoalFileHostFixture({ plansMode: "off" });
    const stewardFrames: Array<Record<string, unknown>> = [];
    try {
      await writeFile(join(f.workspaceRoot, "CLARVIS.md"), "Original persistent policy");
      await writeFile(join(f.workspaceRoot, "stage.txt"), "stage prepared\n");
      f.setResponder(async () => {
        switch (f.requests.length) {
          case 1:
            return {
              name: "read_file",
              arguments: { path: "stage.txt" },
              commentary: "The first stage is prepared",
            };
          case 2:
            if (changed)
              await writeFile(join(f.workspaceRoot, "CLARVIS.md"), "Updated persistent policy");
            return {
              name: "update_goal",
              arguments: {
                update: {
                  action: "checkpoint",
                  summary: "Stage inspected",
                  next_step: "Return the final answer",
                },
              },
            };
          case 3:
            return {
              name: "update_goal",
              arguments: {
                update: {
                  action: "candidate",
                  summary: "Answer prepared",
                  assessments: [
                    {
                      criterion_id: "objective",
                      kind: "qualitative",
                      justification: "The final answer is available",
                    },
                  ],
                },
              },
            };
          default:
            return { text: "The final answer" };
        }
      });
      f.setStewardResponder(async (request) => {
        const frame = JSON.parse(
          String(request.messages.findLast((message) => message.role === "user")!.content),
        );
        stewardFrames.push(frame);
        return {
          name: "submit_result",
          arguments: {
            decision: "completion",
            verdict: "achieved",
            summary: "Delivered",
            assessments: ["definition", "objective"].map((scope) => ({
              scope,
              verdict: "satisfied",
              rationale: "Answer observed",
              evidence_ids: [],
            })),
          },
        };
      });
      await f.client.goals.control({
        session_id: "conversation",
        expected_revision: 0,
        operation_id: "create",
        action: {
          kind: "create",
          objective: "Inspect the stage and return the final answer",
          limits: { max_net_tokens: 20000 },
        },
      });
      await f.until(
        async () => (await f.client.goals.get("conversation")).state.current?.status === "complete",
      );
      await f.until(() => f.host.stats().runs === 0);
      const goal = (await f.client.goals.get("conversation")).state.current!;
      expect(goal.runs).toHaveLength(2);
      expect(goal.auto_continuations).toBe(1);
      expect(goal.runs[0]!.checkpoint?.next_step).toBe("Return the final answer");
      expect(stewardFrames[0]!.workflow_history).toEqual([
        {
          stage: 1,
          automatic: false,
          disposition: "checkpoint",
          outcome: "completed",
          checkpoint: {
            summary: "Stage inspected",
            next_step: "Return the final answer",
            progress_accepted: expect.any(Boolean),
          },
        },
        { stage: 2, automatic: true },
      ]);
      expect(JSON.stringify(f.requests[2]!.messages)).toContain(
        "Continue the current goal from its accepted checkpoint",
      );
      expect(JSON.stringify(f.requests[2]!.messages)).not.toContain("[goal steward]");
      expect(f.stewardRequests).toHaveLength(1);
      expect(JSON.stringify(f.stewardRequests[0]!.messages)).not.toContain(
        "Original persistent policy",
      );
      expect(JSON.stringify(f.stewardRequests[0]!.messages)).not.toContain(
        "Updated persistent policy",
      );
    } finally {
      await f.close();
    }
  },
);

it("gives the tool-free Steward actual command receipts instead of only catalog labels", async () => {
  const f = await createGoalFileHostFixture({ plansMode: "off" });
  try {
    const command = `"${process.execPath}" -e "process.stdout.write('CHECK_EXECUTED_OK')"`;
    f.setResponder(async () => {
      if (f.requests.length === 1) return { name: "shell", arguments: { command, cwd: "." } };
      if (f.requests.length === 2)
        return {
          name: "update_goal",
          arguments: {
            update: {
              action: "candidate",
              summary: "Check executed",
              assessments: [
                {
                  criterion_id: "objective",
                  kind: "qualitative",
                  justification: "Command passed",
                  evidence_ids: [],
                },
              ],
            },
          },
        };
      return { text: "Check executed successfully." };
    });
    f.setStewardResponder(async (request) => {
      const frame = JSON.parse(
        String(request.messages.findLast((message) => message.role === "user")!.content),
      );
      expect(frame.command_evidence).toHaveLength(1);
      const receipt = frame.command_evidence[0];
      expect(receipt).toMatchObject({
        tool: "shell",
        exit_code: 0,
        stdout_excerpt: "CHECK_EXECUTED_OK",
        truncated: false,
      });
      expect(JSON.parse(receipt.arguments_excerpt).command).toBe(command);
      expect(frame.evidence.some((entry: { id: string }) => entry.id === receipt.id)).toBe(true);
      expect(frame.evidence_details).toHaveLength(1);
      expect(frame.evidence_details[0]).toMatchObject({
        id: receipt.id,
        kind: "command",
        status: "succeeded",
        command: { stdout_excerpt: "CHECK_EXECUTED_OK" },
      });
      expect(receipt.id).toMatch(/^evidence-[a-f0-9]{32}$/u);
      expect(receipt.id).not.toMatch(/^tool-/u);
      expect(request.tools!.map((tool) => tool.function.name)).not.toContain("shell");
      return {
        name: "submit_result",
        arguments: {
          decision: "completion",
          verdict: "achieved",
          summary: "Execution verified from the host receipt",
          assessments: ["definition", "objective"].map((scope) => ({
            scope,
            verdict: "satisfied",
            rationale: "Host-recorded command and exit zero establish execution",
            evidence_ids: [receipt.id],
          })),
        },
      };
    });
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Execute the check and report success",
        limits: { max_net_tokens: 10000 },
      },
    });
    await f.until(
      async () => (await f.client.goals.get("conversation")).state.current?.status === "complete",
    );
    await f.until(() => f.host.stats().runs === 0);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
