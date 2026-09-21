import { describe, expect, it } from "bun:test";
import { createGoalFileHostFixture, imposesToolChoice } from "../helpers/goal-file-host.ts";
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
        expect(frame.definition.objective).toBe("Provide the answer");
        expect(frame.operator_request.origin).toBe("operator");
        expect(frame.evidence).toBeUndefined();
        expect(frame.command_evidence).toBeUndefined();
        expect(frame.evidence_details).toBeUndefined();
        expect(frame.workflow_history).toBeUndefined();
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
      ) as { definition?: unknown; report?: { summary: string }; dialogue?: unknown[] };
      const secondFrame = JSON.parse(
        String(second!.messages.findLast((message) => message.role === "user")!.content),
      ) as { definition?: unknown; report?: { summary: string }; dialogue?: unknown[] };
      expect(firstFrame.definition).toBeDefined();
      expect(firstFrame.report?.summary).toBeDefined();
      expect(secondFrame.report?.summary).toBeDefined();
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
      expect(stewardFrames[0]!.workflow_history).toBeUndefined();
      expect(stewardFrames[0]!.command_evidence).toBeUndefined();
      expect(stewardFrames[0]).toEqual(
        expect.objectContaining({
          definition: expect.objectContaining({ objective: expect.any(String) }),
        }),
      );
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

it("keeps raw command receipts out of the conversational Steward frame", async () => {
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
      expect(frame.command_evidence).toBeUndefined();
      expect(frame.evidence_details).toBeUndefined();
      expect(frame.evidence).toBeUndefined();
      expect(frame.workflow_history).toBeUndefined();
      expect(JSON.stringify(frame)).not.toContain("CHECK_EXECUTED_OK");
      expect(frame.report.summary).toBe("Check executed");
      expect(request.tools!.map((tool) => tool.function.name)).not.toContain("shell");
      return {
        name: "submit_result",
        arguments: {
          decision: "completion",
          verdict: "achieved",
          summary: "Execution verified from the declared report",
          assessments: ["definition", "objective"].map((scope) => ({
            scope,
            verdict: "satisfied",
            rationale: "Work-agent report describes the executed check",
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

/**
 * The Steward review is a normal run of the real loop, and its result gate may
 * refuse a submission and nudge it. That nudge used to be answered by forcing a
 * tool choice on the very next iteration — the recovery the gate exists for then
 * became an HTTP 400 on any provider that refuses a forced choice, which is what
 * a thinking model does. Every request these fixtures receive is checked for an
 * imposed choice, and the fixture itself answers one with that 400, so this file
 * is also the canary against reintroducing the imposition.
 */
/**
 * Whether every request left the tool choice to the model.
 *
 * @remarks The catalog itself makes the provider layer send `"auto"`, so this is
 *   stated as "nothing was imposed": `"required"` or a named function would both
 *   fail the check, exactly as the fixture's own provider refuses them.
 */
function requestsImposeNothing(f: {
  requests: Array<{ tool_choice?: unknown }>;
  stewardRequests: Array<{ tool_choice?: unknown }>;
}): boolean {
  return [...f.requests, ...f.stewardRequests].every(
    ({ tool_choice: choice }) => choice === undefined || choice === "auto" || choice === "none",
  );
}

describe("Goal Steward review protocol recovery", () => {
  const definition = {
    scope: "definition",
    verdict: "satisfied",
    rationale: "Definition is current",
    evidence_ids: [],
  };
  const objective = {
    scope: "objective",
    verdict: "satisfied",
    rationale: "Answer observed",
    evidence_ids: [],
  };

  it("completes after the host rejects a reserved target and the Steward corrects", async () => {
    const f = await createGoalFileHostFixture({ plansMode: "off" });
    try {
      await writeFile(join(f.workspaceRoot, "answer.txt"), "The answer is 42.\n");
      f.setResponder(async () => {
        if (f.requests.length === 1)
          return {
            name: "read_file",
            arguments: { path: "answer.txt" },
            commentary: "Inspecting the answer",
          };
        if (f.requests.length === 2)
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
        return { text: "The answer is 42." };
      });
      f.setStewardResponder(async () => {
        if (f.stewardRequests.length === 1)
          return {
            name: "submit_result",
            arguments: {
              decision: "completion",
              verdict: "achieved",
              summary: "Claimed",
              assessments: [
                definition,
                objective,
                {
                  scope: "criterion",
                  criterion_id: "a-host-reserved-target",
                  verdict: "satisfied",
                  rationale: "Judged a target the host never supplied",
                  evidence_ids: [],
                },
              ],
            },
          };
        return {
          name: "submit_result",
          arguments: {
            decision: "completion",
            verdict: "achieved",
            summary: "Verified against the supplied targets",
            assessments: [definition, objective],
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

      expect(f.errors).toEqual([]);
      expect(requestsImposeNothing(f)).toBe(true);
      // Every request that carried tools also carries the provider layer's own
      // `"auto"`, so the check above observes something real rather than a field
      // nobody sends; an imposed `"required"` or a named function lands here.
      expect([
        ...new Set(
          [...f.requests, ...f.stewardRequests]
            .map((request) => request.tool_choice)
            .filter((choice) => choice !== undefined),
        ),
      ]).toEqual(["auto"]);
      expect(f.stewardRequests).toHaveLength(2);
      const correction = JSON.stringify(f.stewardRequests[1]!.messages);
      expect(correction).toContain("Review rejected");
      const goal = (await f.client.goals.get("conversation")).state.current!;
      expect(goal.runs[0]!.steward_reviews!.map((review) => review.decision)).toEqual(["achieved"]);
      expect(goal.steward!.status).toBe("verified");
      expect(goal.steward!.consumption.usage_unknown ?? false).toBe(false);
      expect(goal.steward!.consumption.net_tokens).toBeGreaterThan(0);
    } finally {
      await f.close();
    }
  });

  it("blocks completion when the provider never reports the review's consumption", async () => {
    const f = await createGoalFileHostFixture({ plansMode: "off" });
    try {
      await writeFile(join(f.workspaceRoot, "answer.txt"), "The answer is 42.\n");
      f.setResponder(async () => {
        if (f.requests.length === 1)
          return { name: "read_file", arguments: { path: "answer.txt" } };
        if (f.requests.length === 2)
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
        return { text: "The answer is 42." };
      });
      f.setStewardResponder(async () => ({
        name: "submit_result",
        arguments: {
          decision: "completion",
          verdict: "achieved",
          summary: "Verified, but billed by nobody",
          assessments: [definition, objective],
        },
        usage: "missing",
      }));
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
      await f.until(() => f.host.stats().runs === 0);

      const goal = (await f.client.goals.get("conversation")).state.current!;
      // An `achieved` review the host cannot charge still cannot conclude the Goal,
      // and the record says why: unknown consumption, not a transport fault.
      expect(goal.status).not.toBe("complete");
      expect(goal.runs.at(-1)!.steward_reviews!.at(-1)).toMatchObject({
        decision: "interrupted",
        interruption_cause: "usage_unknown",
      });
      expect(goal.steward!.consumption.usage_unknown).toBe(true);
      expect(requestsImposeNothing(f)).toBe(true);
      // The same cause reaches the client, live and on replay, instead of the run
      // category it was filed under.
      const ended = f.host.kernel
        .readRunTrace(goal.runs.at(-1)!.execution_id)
        ?.findLast((event) => event.type === "run_ended");
      expect(ended).toMatchObject({
        type: "run_ended",
        reason: "guard_trip",
        code: "goal_steward_failed",
        message: "the Steward review's token consumption could not be determined",
      });
    } finally {
      await f.close();
    }
  });
});

it("the fixture's provider refuses exactly an imposed tool choice", () => {
  const base = { messages: [], prompt_cache_key: "conversation_goal-steward" };
  expect(imposesToolChoice(base)).toBe(false);
  expect(imposesToolChoice({ ...base, tool_choice: "auto" })).toBe(false);
  expect(imposesToolChoice({ ...base, tool_choice: "none" })).toBe(false);
  expect(imposesToolChoice({ ...base, tool_choice: "required" })).toBe(true);
  expect(
    imposesToolChoice({
      ...base,
      tool_choice: { type: "function", function: { name: "set_title" } },
    }),
  ).toBe(true);
});

it("gives the review exactly one correction before the Goal is left unresolved", async () => {
  const f = await createGoalFileHostFixture({ plansMode: "off" });
  try {
    await writeFile(join(f.workspaceRoot, "answer.txt"), "The answer is 42.\n");
    f.setResponder(async () => {
      if (f.requests.length === 1) return { name: "read_file", arguments: { path: "answer.txt" } };
      if (f.requests.length === 2)
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
      return { text: "The answer is 42." };
    });
    // The reserved target is never a valid assessment, so the one correction the
    // gate grants cannot rescue the review and its second refusal is terminal.
    f.setStewardResponder(async () => ({
      name: "submit_result",
      arguments: {
        decision: "completion",
        verdict: "achieved",
        summary: "Judged a target the host supplies no way to verify",
        assessments: [
          {
            scope: "definition",
            verdict: "satisfied",
            rationale: "Definition is current",
            evidence_ids: [],
          },
          {
            scope: "objective",
            verdict: "satisfied",
            rationale: "Answer observed",
            evidence_ids: [],
          },
          {
            scope: "criterion",
            criterion_id: "a-host-reserved-target",
            verdict: "satisfied",
            rationale: "Judged a target outside the supplied set",
            evidence_ids: [],
          },
        ],
      },
    }));
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
    await f.until(() => f.host.stats().runs === 0);

    const goal = (await f.client.goals.get("conversation")).state.current!;
    expect(goal.status).not.toBe("complete");
    expect(f.stewardRequests).toHaveLength(2);
    expect(requestsImposeNothing(f)).toBe(true);
    expect(goal.runs.at(-1)!.steward_reviews!.at(-1)!.decision).toBe("interrupted");
  } finally {
    await f.close();
  }
});
