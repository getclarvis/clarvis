import { describe, expect, it } from "bun:test";
import { isBuiltinTraceEvent } from "@clarvis/capability";
import { readOnlyTools } from "@clarvis/tools";
import { createGoalFileHostFixture } from "../helpers/goal-file-host.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("Goal Steward through the native host and SDK", () => {
  it("observes completed dispatch and delivers an internal correction without human steering", async () => {
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
          await f.until(
            async () =>
              (await f.client.goals.get("conversation")).state.current?.steward?.status ===
              "intervened",
          );
          return { name: "get_goal", arguments: {} };
        }
        if (f.requests.length === 3)
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
      f.setStewardResponder(async (request) => {
        const frame = JSON.parse(
          String(request.messages.findLast((message) => message.role === "user")!.content),
        );
        if (frame.goal_header.mode === "observation")
          return {
            name: "submit_result",
            arguments: {
              decision: "steer",
              summary: "Keep the response concrete",
              guidance: "Include the answer, not only a progress report",
            },
          };
        expect(frame.evidence[0].id).toMatch(/^tool-[a-f0-9]{64}$/u);
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
              inspected_paths: [],
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
      expect(goal.runs[0]!.steward_intervention_count).toBe(1);
      expect(JSON.stringify(f.requests[2]!.messages)).toContain(
        "[goal steward] Include the answer",
      );
      expect(
        f.host.kernel
          .readRunTrace(goal.runs[0]!.execution_id)
          ?.some((event) => event.type === "user_steering"),
      ).toBe(false);
      expect(f.stewardRequests).toHaveLength(2);
      for (const request of f.stewardRequests) {
        const configuration = request.messages.filter((message) =>
          String(message.content).startsWith('{"goal_steward_configuration_v1":'),
        );
        expect(configuration).toHaveLength(1);
        expect(configuration[0]!.content).toContain("Global policy: verify results.");
        expect(configuration[0]!.content).toContain(
          "Workspace policy: return the concrete answer.",
        );
        expect(configuration[0]!.content).not.toContain("Global fallback");
        expect(configuration[0]!.content).not.toContain("Later policy");
        expect(configuration[0]!.content).not.toContain(f.root);
      }
      expect(JSON.stringify(f.requests[0]!.messages)).toContain(
        "Workspace policy: return the concrete answer.",
      );
      expect(
        f.stewardRequests[1]!.messages.slice(0, f.stewardRequests[0]!.messages.length),
      ).toEqual(f.stewardRequests[0]!.messages);
    } finally {
      await f.close();
    }
  });
  for (const readMode of ["single", "batch", "none"]) {
    const repair = readMode !== "none";
    it(`rejects historical artifact reads and ${repair ? "repairs in the same evaluation" : "stops after one correction"} (${readMode})`, async () => {
      const f = await createGoalFileHostFixture({ plansMode: "off" });
      try {
        await writeFile(
          join(f.workspaceRoot, "answer.txt"),
          readMode === "batch"
            ? Array.from(
                { length: 180 },
                (_, index) =>
                  `Answer ${index}: 42 with supporting detail for complete batch attestation.`,
              ).join("\n")
            : "42\n",
        );
        await writeFile(join(f.workspaceRoot, "metadata.txt"), "Supporting evidence\n");
        f.setResponder(async () => {
          if (f.requests.length === 1)
            return {
              name: "read_file",
              arguments: { path: "answer.txt" },
              commentary: "Checking the answer",
            };
          if (f.requests.length === 2) {
            await f.until(
              async () =>
                (await f.client.goals.get("conversation")).state.current?.steward?.status ===
                "aligned",
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
        let observationCalls = 0;
        let completionCalls = 0;
        f.setStewardResponder(async (request) => {
          const frameMessage = request.messages.findLast(
            (message) =>
              message.role === "user" && String(message.content).startsWith('{"policy":'),
          )!;
          const frame = JSON.parse(String(frameMessage.content));
          if (frame.goal_header.mode === "observation") {
            observationCalls++;
            return observationCalls === 1
              ? { name: "read_file", arguments: { path: "answer.txt" } }
              : {
                  name: "submit_result",
                  arguments: { decision: "aligned", summary: "Answer inspected" },
                };
          }
          completionCalls++;
          if (completionCalls === 2) {
            expect(JSON.stringify(request.messages)).toContain(
              "Read every cited inspected_path completely in THIS evaluation",
            );
            if (readMode === "batch")
              return { name: "read_files", arguments: { paths: ["answer.txt", "metadata.txt"] } };
            if (repair) return { name: "read_file", arguments: { path: "answer.txt" } };
          }
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
                inspected_paths: ["answer.txt"],
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
          async () =>
            (await f.client.goals.get("conversation")).state.current?.status ===
            (repair ? "complete" : "blocked"),
        );
        await f.until(() => f.host.stats().runs === 0);
        expect(observationCalls).toBe(2);
        expect(completionCalls).toBe(repair ? 3 : 2);
        const goal = (await f.client.goals.get("conversation")).state.current!;
        expect(goal.runs[0]!.steward_review_count).toBe(2);
        if (readMode === "batch") {
          const review = goal.runs[0]!.steward_reviews!.at(-1)!;
          const trace = f.host.kernel.readRunTrace(review.steward_execution_id)!;
          const batch = trace.find(
            (event) =>
              isBuiltinTraceEvent(event) &&
              event.type === "tool_call" &&
              event.mcp_name === "read_files",
          );
          expect(
            batch !== undefined &&
              isBuiltinTraceEvent(batch) &&
              batch.type === "tool_call" &&
              batch.result,
          ).toContain("[truncated]");
          expect(review.inspected_artifacts.map((artifact) => artifact.path)).toContain(
            "answer.txt",
          );
        }
        expect(goal.steward!.consumption.net_tokens).toBeGreaterThan(0);
        expect(goal.runs[0]!.steward_reviews!.at(-1)!.decision).toBe(
          repair ? "achieved" : "aligned",
        );
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
  }
  it("returns unfinished work to the same run and preserves the private serialized prefix", async () => {
    const f = await createGoalFileHostFixture({ plansMode: "off" });
    try {
      f.setResponder(async () =>
        f.requests.length === 1
          ? {
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
            }
          : { text: f.requests.length === 2 ? "Draft answer" : "Complete answer" },
      );
      f.setStewardResponder(async () => {
        const achieved = f.stewardRequests.length > 1;
        return {
          name: "submit_result",
          arguments: {
            decision: "completion",
            verdict: achieved ? "achieved" : "not_achieved",
            summary: achieved ? "Delivered" : "Draft is incomplete",
            ...(achieved ? {} : { next_step: "Provide the complete answer" }),
            assessments: [
              {
                scope: "definition",
                verdict: "satisfied",
                rationale: "Definition is current",
                evidence_ids: [],
                inspected_paths: [],
              },
              {
                scope: "objective",
                verdict: achieved ? "satisfied" : "unsatisfied",
                rationale: "Read the proposed answer",
                evidence_ids: [],
                inspected_paths: [],
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
      expect(f.requests).toHaveLength(3);
      expect(f.stewardRequests).toHaveLength(2);
      const [first, second] = f.stewardRequests;
      expect(second!.messages.slice(0, first!.messages.length)).toEqual(first!.messages);
      expect(second!.tools).toEqual(first!.tools);
      expect(first!.prompt_cache_key).toBe("conversation_goal-steward");
      expect(second!.prompt_cache_key).toBe(first!.prompt_cache_key);
      expect(first!.tools!.map((tool) => tool.function.name).sort()).toEqual(
        [...readOnlyTools.map((tool) => tool.name), "submit_result"].sort(),
      );
      const goal = (await f.client.goals.get("conversation")).state.current!;
      expect(goal.runs).toHaveLength(1);
      expect(goal.runs[0]!.steward_reviews!.map((review) => review.decision)).toEqual([
        "not_achieved",
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
  "a Steward checkpoint preserves its prefix unless captured instructions change (changed=%s)",
  async (changed) => {
    const f = await createGoalFileHostFixture({ plansMode: "off" });
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
            await f.until(
              async () =>
                (await f.client.goals.get("conversation")).state.current?.steward?.status ===
                "new_run_recommended",
            );
            return { name: "get_goal", arguments: {} };
          case 3:
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
          case 4:
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
        return {
          name: "submit_result",
          arguments:
            frame.goal_header.mode === "observation"
              ? {
                  decision: "new_run",
                  summary: "Stage ready",
                  next_step: "Return the final answer",
                }
              : {
                  decision: "completion",
                  verdict: "achieved",
                  summary: "Delivered",
                  assessments: ["definition", "objective"].map((scope) => ({
                    scope,
                    verdict: "satisfied",
                    rationale: "Answer observed",
                    evidence_ids: [],
                    inspected_paths: [],
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
      expect(JSON.stringify(f.requests[2]!.messages)).toContain(
        "[goal steward] Request update_goal checkpoint",
      );
      expect(f.stewardRequests).toHaveLength(2);
      const [first, second] = f.stewardRequests;
      expect(first!.messages[1]!.content).toContain("Original persistent policy");
      expect(second!.messages[0]).toEqual(first!.messages[0]);
      expect(second!.tools).toEqual(first!.tools);
      if (changed) {
        expect(second!.messages[1]!.content).toContain("Updated persistent policy");
        expect(JSON.stringify(second!.messages)).not.toContain("Original persistent policy");
        expect(second!.messages.at(-1)!.content).toContain('"definition":');
      } else {
        expect(second!.messages.slice(0, first!.messages.length)).toEqual(first!.messages);
        expect(
          second!.messages.filter((message) =>
            String(message.content).startsWith('{"goal_steward_configuration_v1":'),
          ),
        ).toHaveLength(1);
      }
      expect(f.stewardRequests[1]!.prompt_cache_key).toBe(f.stewardRequests[0]!.prompt_cache_key);
    } finally {
      await f.close();
    }
  },
);

it("gives the read-only Steward actual command receipts instead of only catalog labels", async () => {
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
            inspected_paths: [],
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
