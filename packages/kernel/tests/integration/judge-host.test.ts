import { createHostEffectReview } from "../../src/guard/effect-review.ts";
import { createGuardEffectRegistry } from "../../src/guard/effects/registry.ts";
import type { GuardEffectBatch } from "../../src/guard/effects/types.ts";
import { withHostValidatedEffectReview } from "../helpers/effect-review-llm.ts";
import { recordingLogger } from "../helpers/logger.ts";
import { createGoalUsageTracker } from "../../src/goals/usage.ts";
import { withTransportRetry } from "@clarvis/llm";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPersistedTraceProjectorRegistry,
  loadEnv,
  OPERATOR_AUTHORITY_PORT,
  PersistenceError,
  ProviderError,
  ModelCallInactivityError,
  type Capability,
  type LLMProvider,
  type RunRequest,
} from "@clarvis/capability";
import { JUDGE_PORT } from "@clarvis/judge";
import { executeRun, type ElicitRequest } from "@clarvis/loop";
import { createCommandReview } from "../../src/guard/command-review.ts";
import { createTestRunInfrastructure } from "@clarvis/loop/testing";
import { createJsonTraceStore, createTraceVisibilityView } from "@clarvis/trace";
import { createHostJudge, judgeRequiredFor } from "../../src/guard/judge-host.ts";
import { createOperatorAuthorityRuntime } from "../../src/guard/operator-authority.ts";
import { guardReviewerModelCallProjector } from "../../src/guard/reviewer-trace.ts";
import {
  captureRunInstructions,
  seedRunInstructions,
} from "../../src/runs/instruction-snapshot.ts";
import { configurationFact } from "../helpers/configuration-mutation.ts";

const instructionSeed = seedRunInstructions(
  {
    binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
    evidence: [{ id: "operator", source: "start", text: "Run checks", execution_id: "parent" }],
  },
  captureRunInstructions({}, [
    {
      scope: "global",
      path: "/operator/AGENTS.md",
      content: "Run routine validation autonomously.",
    },
    {
      scope: "workspace",
      path: "/repo/CLARVIS.md",
      content: "Update develop by fast-forward before research.",
    },
  ]),
);

const request: RunRequest = {
  execution_id: "parent",
  session_id: "session",
  messages: [{ role: "user", content: "work" }],
  servers: [],
  entry: "work",
  profiles: [
    {
      name: "work",
      model: "anthropic/test",
      tools: [],
      grants: ["edit_workspace"],
      iteration_limit: 1,
    },
  ],
  providers: [{ name: "anthropic", kind: "anthropic" }],
  budget: { on_exceed: "stop", total_token_limit: 10000 },
  prompt_cache_ttl: "1h",
};

test.each([
  "command",
  "effects",
  "persistence_failure",
  "provider_failure",
  "provider_retry",
  "inactivity_retry",
  "journal_failure",
] as const)(
  "host-owned %s Judge links provider events to one projected private run",
  async (kind) => {
    const retries = kind === "provider_retry" || kind === "inactivity_retry";
    const root = mkdtempSync(join(tmpdir(), "judge-host-"));
    const env = loadEnv({
      CLARVIS_LOG_LEVEL: "silent",
      CLARVIS_AGENT_TOOLS_ENABLED: "true",
      CLARVIS_AGENT_TOOLS_MAX_GRANT: "edit",
      CLARVIS_DEFAULT_CALL_TIMEOUT_MS: "234567",
      CLARVIS_DEFAULT_MAX_RETRIES: "4",
    });
    const infrastructure = createTestRunInfrastructure({ env, workspaceRoot: root });
    const physical = createJsonTraceStore({ dir: join(root, "traces") });
    const persistenceFailure = new Error("private persistence unavailable");
    let failedAppends = 0;
    const privatePhysical = new Proxy(physical, {
      get(target, property) {
        if (kind === "journal_failure" && property === "openJournal")
          return (options: Parameters<typeof physical.openJournal>[0]) => {
            const journal = target.openJournal(options);
            return {
              ...journal,
              append() {
                failedAppends++;
                throw persistenceFailure;
              },
            };
          };
        if (kind === "persistence_failure" && property === "insert")
          return () => {
            throw persistenceFailure;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const publicStore = createTraceVisibilityView(physical, "public");
    const secret = "PRIVATE_JUDGE_CASE_AND_PROVIDER_REASON";
    const audit = recordingLogger();
    const effectProvider = withHostValidatedEffectReview({
      async call() {
        throw new Error("Unexpected agent call");
      },
    });
    let childCalls = 0;
    let childId: string | undefined;
    const base: LLMProvider = {
      async call(params) {
        if (params.agentInstanceId === "judge") {
          childCalls++;
          expect(params.timeoutMs).toBe(234567);
          expect(params.maxRetries).toBe(4);
          childId = params.executionId;
          expect(params.promptCacheKey).toBe("session_judge");
          const configuration = params.messages[1]!.content as string;
          expect(configuration).toContain("Run routine validation autonomously.");
          expect(configuration).toContain("Update develop by fast-forward before research.");
          if (kind === "provider_failure" || (retries && childCalls === 1)) {
            const usage = {
              input_tokens: 10,
              output_tokens: 3,
              cached_tokens: 5,
              cache_write_tokens: 1,
            };
            const error =
              kind === "inactivity_retry"
                ? new ModelCallInactivityError(params.timeoutMs!, true, usage)
                : new ProviderError(secret, {
                    kind: retries ? "transient" : "quota",
                    partialUsage: usage,
                  });
            throw error;
          }
          if (kind === "effects")
            return {
              ...(await effectProvider.call(params)),
              usage: {
                input_tokens: 10,
                output_tokens: 3,
                cached_tokens: 5,
                cache_write_tokens: 1,
              },
            };
          return {
            toolCalls: [
              {
                id: "private",
                name: "judge_step",
                arguments: { action: "decide_command", decision: "allow", reason: secret },
              },
            ],
            usage: { input_tokens: 10, output_tokens: 3, cached_tokens: 5, cache_write_tokens: 1 },
          };
        }
        return {
          text: "done",
          usage: { input_tokens: 4, output_tokens: 2, cached_tokens: 0, cache_write_tokens: 0 },
        };
      },
    };
    const goalUsage = createGoalUsageTracker();
    const deps = {
      ...infrastructure,
      env,
      llm: goalUsage.wrap(
        withTransportRetry(base, { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 }),
      ),
      traceStore: publicStore,
      operatorAuthority: createOperatorAuthorityRuntime,
      persistedTraceProjectors: createPersistedTraceProjectorRegistry([
        guardReviewerModelCallProjector,
      ]),
    };
    const host = createHostJudge({
      deps,
      physicalStore: privatePhysical,
      audit,
      toolsEnabled: true,
      loadSettings: () => ({ providers: request.providers, defaultModel: "anthropic/test" }),
    });
    const consumer: Capability = {
      name: "consumer",
      forRun(ctx) {
        return {
          name: "consumer",
          forAgent() {
            return {
              attach() {
                return {
                  hooks: {
                    async beforeIteration() {
                      if (kind === "effects") {
                        const review = createHostEffectReview({
                          judge: () => ctx.services.get(JUDGE_PORT),
                          authority: ctx.services.get(OPERATOR_AUTHORITY_PORT),
                          registry: createGuardEffectRegistry(),
                          audit,
                        });
                        const batch: GuardEffectBatch = {
                          reviewability: "static",
                          facts: [
                            configurationFact(createGuardEffectRegistry(), {
                              surface: "authoring",
                              canonicalPath: ".clarvis/agents/helper.md",
                            }),
                          ],
                        };
                        const concurrent = await Promise.all(
                          Array.from({ length: 8 }, () =>
                            review.review(batch, { command: secret }, "configure_clarvis"),
                          ),
                        );
                        expect(concurrent.map((receipt) => receipt.decision)).toEqual(
                          Array.from({ length: 8 }, () => "allow"),
                        );
                        expect(
                          await review.review(batch, { command: secret }, "configure_clarvis"),
                        ).toMatchObject({ decision: "allow", attempts: 0 });
                        return;
                      }
                      const review = createCommandReview(
                        {
                          judge: () => ctx.services.get(JUDGE_PORT),
                          authority: ctx.services.get(OPERATOR_AUTHORITY_PORT),
                          signal: ctx.signal,
                        },
                        { on_unsure: "ask" },
                      );
                      const input = { tool: "shell", args: { command: secret } } as ElicitRequest;
                      if (kind === "persistence_failure") {
                        const outcomes = await Promise.allSettled(
                          Array.from({ length: 8 }, () => review(input)),
                        );
                        expect(outcomes).toEqual(
                          Array.from({ length: 8 }, () => ({
                            status: "rejected",
                            reason: expect.any(PersistenceError),
                          })),
                        );
                        return;
                      }
                      expect(
                        await Promise.all(Array.from({ length: 8 }, () => review(input))),
                      ).toEqual(
                        Array.from({ length: 8 }, () => ({
                          allowed: kind !== "provider_failure",
                          answerer: "judge",
                          review:
                            kind === "provider_failure"
                              ? { failure_kind: "quota", reviewer_decision: "failed" }
                              : { reviewer_decision: "allow" },
                        })),
                      );
                      if (kind === "provider_failure") return;
                      expect(await review(input)).toEqual({
                        allowed: true,
                        answerer: "judge",
                        review: { reviewer_decision: "allow" },
                      });
                    },
                  },
                };
              },
            };
          },
        };
      },
    };
    try {
      expect(
        (
          await executeRun({
            owner: "owner",
            operatorAuthoritySeed: instructionSeed,
            rawBody: request,
            deps: { ...deps, capabilities: [consumer, host.capability] },
          })
        ).response.status,
      ).toBe("completed");
      const expectedCalls = kind === "effects" ? 2 : 1;
      const billedCalls = expectedCalls + (retries ? 1 : 0);
      expect(childCalls).toBe(billedCalls);
      expect(failedAppends).toBe(kind === "journal_failure" ? 1 : 0);
      expect(childId).toBeDefined();
      const parent = physical.getById("owner", "parent")!;
      const events = parent.trace.events.filter(
        (event) => event.type === "guard_reviewer_model_call",
      );
      expect(events).toHaveLength(expectedCalls);
      expect(events[0]).toMatchObject({
        judge_execution_id: childId,
        path: kind === "effects" ? "effect_review" : "call_local",
        consumer: kind === "effects" ? "configure_clarvis" : "command_guard",
        stage: kind === "effects" ? "compile" : "decide",
        input_tokens: retries ? 20 : 10,
        output_tokens: retries ? 6 : 3,
        attempts: retries ? 2 : 1,
      });
      if (kind === "provider_failure")
        expect(events[0]).toMatchObject({ status: "failed", failure_kind: "quota" });
      if (kind === "effects") {
        expect(events[1]).toMatchObject({
          judge_execution_id: childId,
          stage: "decide",
          input_tokens: 10,
          output_tokens: 3,
        });
        expect(audit.events("effect_review.reviewer.started").map((entry) => entry.stage)).toEqual([
          "compile",
          "decide",
        ]);
        expect(JSON.stringify(audit.records)).not.toContain(secret);
      }
      expect(parent.total_input_tokens).toBe(4);
      expect(parent.total_output_tokens).toBe(2);
      expect(goalUsage.measure()).toEqual({
        kind: "measured",
        input: 4 + 10 * billedCalls,
        output: 2 + 3 * billedCalls,
        cached: 5 * billedCalls,
      });
      expect(goalUsage.accounting()).toHaveLength(1 + billedCalls);
      if (kind === "persistence_failure") {
        expect(physical.getById("owner", childId!)).toBeNull();
        expect(publicStore.list("owner", 10, 0).total).toBe(1);
        return;
      }
      const child = physical.getById("owner", childId!)!;
      expect(child.visibility).toBe("internal");
      expect(child.total_input_tokens).toBe(10 * billedCalls);
      expect(JSON.stringify(parent)).not.toContain(secret);
      expect(JSON.stringify(child)).not.toContain(secret);
      expect(publicStore.list("owner", 10, 0).total).toBe(1);
      expect(publicStore.getById("owner", childId!)).toBeNull();
    } finally {
      await host.close();
      await infrastructure.connections.closeAll();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("eligibility includes configure_clarvis with guard off and excludes explicit human-only mode", () => {
  const env = loadEnv({
    CLARVIS_AGENT_TOOLS_ENABLED: "true",
    CLARVIS_AGENT_TOOLS_MAX_GRANT: "edit",
  });
  const view = (mode: "on" | "off" | "auto") => ({
    request: { ...request, guard_mode: mode },
    requestParam: () => undefined,
  });
  expect(judgeRequiredFor(view("off"), env, true)).toBe(true);
  expect(judgeRequiredFor(view("auto"), env, true)).toBe(true);
  expect(judgeRequiredFor(view("on"), env, true)).toBe(false);
  expect(judgeRequiredFor(view("off"), env, false)).toBe(false);
  expect(
    judgeRequiredFor(
      {
        ...view("auto"),
        request: {
          ...request,
          profiles: [{ ...request.profiles[0]!, grants: ["read_workspace"] }],
        },
      },
      env,
      true,
    ),
  ).toBe(false);
});

test.each(["read", "edit", "exec"] as const)(
  "Judge eligibility respects the %s host ceiling across modes and tool grants",
  (ceiling) => {
    for (const guard_mode of [undefined, "on", "off", "auto"] as const) {
      for (const grant of [
        undefined,
        "read_workspace",
        "edit_workspace",
        "run_commands",
      ] as const) {
        for (const toolsEnabled of [false, true]) {
          for (const envEnabled of [false, true]) {
            const env = loadEnv({
              CLARVIS_AGENT_TOOLS_ENABLED: String(envEnabled),
              CLARVIS_AGENT_TOOLS_MAX_GRANT: ceiling,
            });
            const enabled = judgeRequiredFor(
              {
                request: {
                  ...request,
                  guard_mode,
                  profiles: [
                    { ...request.profiles[0]!, grants: grant === undefined ? [] : [grant] },
                  ],
                },
                requestParam: () => undefined,
              },
              env,
              toolsEnabled,
            );
            expect({ ceiling, guard_mode, grant, toolsEnabled, envEnabled, enabled }).toEqual({
              ceiling,
              guard_mode,
              grant,
              toolsEnabled,
              envEnabled,
              enabled:
                ceiling !== "read" &&
                guard_mode !== "on" &&
                (grant === "edit_workspace" || grant === "run_commands") &&
                toolsEnabled &&
                envEnabled,
            });
          }
        }
      }
    }
  },
);
