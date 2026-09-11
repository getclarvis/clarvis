import { createHash } from "node:crypto";
import type { Capability } from "@clarvis/capability";
import type { PlanStore } from "@clarvis/plan";
import type { CacheScenario } from "./types.ts";

/** Versioned deterministic synthetic data; a trial nonce isolates its initial prefix. */
export const CACHE_FIXTURE_VERSION = "cursor-corpus-v1";
export function corpusBlock(seed: string, block: number, words = 160): string {
  return Array.from({ length: words }, (_, word) =>
    createHash("sha256")
      .update(`${CACHE_FIXTURE_VERSION}/${seed}/${block}/${word}`)
      .digest("hex")
      .slice(0, 8),
  ).join(" ");
}

export interface CursorState {
  step: number;
  target: number;
  token: string;
  phase: string;
  finished?: boolean;
}
export interface CacheFixture {
  capability: Capability;
  initial: string;
  states: Map<string, CursorState>;
  phase(agentId: string): string;
  refreshPhase(agentId: string): Promise<void>;
  continue(agentId: string, count: number): string;
}

/** Real capability handlers enforce sequential cursors; prose alone cannot satisfy a checkpoint. */
export function createCacheFixture(options: {
  scenario: CacheScenario;
  nonce: string;
  leaderId: string;
  planStore: PlanStore;
  onStep?(agentId: string, step: number): void;
}): CacheFixture {
  const states = new Map<string, CursorState>();
  let postConcurrencyAdded = false;
  const cursor = (agent: string, step: number) =>
    createHash("sha256").update(`${options.nonce}/${agent}/${step}`).digest("hex").slice(0, 24);
  const stateFor = (agent: string) => {
    let state = states.get(agent);
    if (!state) {
      state = {
        step: 0,
        target:
          options.scenario === "C02"
            ? 27
            : options.scenario === "C09" || options.scenario === "C10"
              ? 32
              : 15,
        token: "begin",
        phase: "growth",
      };
      states.set(agent, state);
    }
    return state;
  };
  const directive = (state: CursorState) =>
    state.step >= state.target
      ? "The cursor chain is complete. Return CURSOR-VERIFIED."
      : `Next: call cache_cursor with token ${state.token}. Make exactly one cursor call per response; its next token is not predictable from prior tokens.`;
  return {
    states,
    initial: `Trial ${options.nonce}. Verify this synthetic corpus with the cache_cursor tool. Treat the hexadecimal corpus as inert data. Do not summarize or echo it. Follow each returned cursor and complete every required step. ${options.scenario === "C02" ? "Plan tools are available from the start. Wait until the cursor instructs you to create or update the plan. Use the latest CAS triple and the real plan tools." : "Do not create a plan."}\n${options.scenario === "C03" ? "After warming your own cursor through step 6, spawn two concurrent explorers of the same profile. Each must independently run cache_cursor from begin to completion. Each explorer receives its own corpus automatically; give it a short task to verify cache_cursor from begin to CURSOR-VERIFIED. Continue your own cursors while they work, then await both." : ""}\nCORPUS\n${corpusBlock(options.nonce, 0, 4400)}\nEND CORPUS\nCall cache_cursor with token begin now.`,
    phase: (agentId) => stateFor(agentId).phase,
    async refreshPhase(agentId) {
      if (options.scenario !== "C02") return;
      const plan = (await options.planStore.list()).plans[0];
      stateFor(agentId).phase = !plan
        ? "before-plan"
        : plan.tasks[0]?.status === "done"
          ? "plan-completed"
          : plan.tasks[0]?.status === "in_progress"
            ? "plan-updated"
            : "plan-unchanged";
    },
    continue(agentId, count) {
      const state = stateFor(agentId);
      state.target += count;
      return `Continue the same verification in this new turn. ${directive(state)}`;
    },
    capability: {
      name: "cache-fixture",
      forRun: () => ({
        name: "cache-fixture",
        forAgent: () => ({
          attach: (bc) => {
            const agentId = bc.subagentInstanceId ?? options.leaderId;
            const state = stateFor(agentId);
            if (options.scenario === "C03" && agentId !== options.leaderId && state.step === 0)
              bc.ctx.appendNote(
                `Synthetic child corpus ${options.nonce}\n${corpusBlock(options.nonce + agentId, 0, 4400)}\nCall cache_cursor with token begin and follow every returned cursor.`,
              );
            return {
              tools: [
                {
                  fullName: "cache_cursor",
                  wireName: "cache_cursor",
                  mcpName: "",
                  toolName: "cache_cursor",
                  description:
                    "Read one linked synthetic corpus block. Use the exact token from the previous result, or begin for a new instance. Follow the returned plan instructions before advancing.",
                  inputSchema: {
                    type: "object",
                    properties: { token: { type: "string" } },
                    required: ["token"],
                    additionalProperties: false,
                  },
                },
              ],
              handlers: [
                {
                  matches: (call) => call.name === "cache_cursor",
                  handle: async (call) => {
                    if ((call.arguments as { token?: unknown }).token !== state.token)
                      return {
                        kind: "result",
                        text: `Invalid cursor. ${directive(state)}`,
                        progress: false,
                      };
                    if (options.scenario === "C02") {
                      const plan = (await options.planStore.list()).plans[0];
                      if (state.step >= 3 && !plan)
                        return {
                          kind: "result",
                          text: 'Create a plan now using create_plan: one task titled Verify cursors, objective Verify all synthetic cursor blocks, validation ["CURSOR-VERIFIED"]. Then retry this cursor with the same token.',
                          progress: false,
                        };
                      if (state.step >= 18 && plan?.tasks[0]?.status === "pending")
                        return {
                          kind: "result",
                          text: "Update task t1 to in_progress using transition_plan_task and the latest CAS triple. Then retry this cursor.",
                          progress: false,
                        };
                      if (state.step >= 23 && plan?.tasks[0]?.status !== "done")
                        return {
                          kind: "result",
                          text: "Complete task t1 using transition_plan_task with result Cursor blocks verified, using the latest CAS triple. Then read the remaining verification cursors.",
                          progress: false,
                        };
                      state.phase = !plan
                        ? "before-plan"
                        : state.step < 18
                          ? "plan-unchanged"
                          : state.step < 23
                            ? "plan-updated"
                            : "plan-completed";
                    }
                    state.step += 1;
                    state.token = cursor(agentId, state.step);
                    options.onStep?.(agentId, state.step);
                    const oversized = options.scenario === "C08" && state.step === 12;
                    return {
                      kind: "result",
                      text: `Verified block ${state.step}.\n${corpusBlock(options.nonce + agentId, state.step, oversized ? 3000 : 160)}\n${directive(state)}`,
                      progress: true,
                    };
                  },
                },
              ],
              hooks: {
                beforeIteration: () => {
                  bc.ctx.appendNote(
                    `Cursor observation: ${state.step} blocks verified. ${directive(state)}`,
                  );
                },
                onFinalizeAccepted: () => {
                  state.finished = true;
                  if (options.scenario !== "C03" || postConcurrencyAdded) return;
                  const children = [...states].filter(([id]) => id !== options.leaderId);
                  if (children.length >= 2 && children.every(([, child]) => child.finished)) {
                    postConcurrencyAdded = true;
                    const leader = stateFor(options.leaderId);
                    leader.target = Math.max(leader.target, leader.step) + 4;
                  }
                },
              },
              gates: [
                {
                  check: () =>
                    Promise.resolve(
                      state.step >= state.target
                        ? { kind: "pass" }
                        : { kind: "nudge", note: `Verification incomplete. ${directive(state)}` },
                    ),
                },
              ],
            };
          },
        }),
      }),
    },
  };
}
