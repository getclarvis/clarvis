import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilityRegistry, loadEnv, type Capability } from "@clarvis/capability";
import {
  applyGoalControl,
  type GoalControl,
  type GoalCriterion,
  type GoalRecord,
} from "@clarvis/goal";
import { executeRun, type RunRequest } from "@clarvis/loop";
import { MockLLM, type MockLLMScriptStep } from "@clarvis/loop/testing";
import { AiSdkAdapter } from "@clarvis/llm/adapter";
import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import type { RunHandle, Session } from "@clarvis/protocol";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { prepareHostedGoalTurn } from "../../src/goals/hosted-turn.ts";
import { createGoalEvidenceSource } from "../../src/goals/evidence.ts";
import { createGoalRepository } from "../../src/goals/repository.ts";
import { createHostedRegistry } from "../../src/hosting/registry.ts";
import { createHostedProjection } from "../../src/hosting/projection.ts";
import {
  createHostedSessionCoordinator,
  type HostedPreparationContext,
} from "../../src/hosting/sessions.ts";
import { createSessionService } from "../../src/sessions/session-service.ts";
import { createRunService } from "../../src/runs/run-service.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const checkpoint = (step: number): MockLLMScriptStep => ({
  toolCalls: [
    {
      name: "update_goal",
      arguments: {
        update: {
          action: "checkpoint",
          summary: `Stage ${step}`,
          next_step: "Continue the fixture",
        },
      },
    },
  ],
});
const candidate: MockLLMScriptStep = {
  toolCalls: [
    {
      name: "update_goal",
      arguments: {
        update: {
          action: "candidate",
          summary: "Fixture finished",
          assessments: [
            {
              criterion_id: "objective",
              kind: "qualitative",
              justification: "All requested stages finished",
            },
          ],
        },
      },
    },
  ],
};

async function fixture(
  options: {
    script?: MockLLMScriptStep[];
    configure?(body: RunRequest): void;
    beforeEvidence?(goal: GoalRecord): Promise<void>;
    beforePrepare?(index: number, context: HostedPreparationContext): Promise<void>;
    beforeAnswer?(index: number): Promise<void>;
    capabilities?: Capability[];
    now?: () => number;
    deadlineAt?: number;
    criteria?: GoalCriterion[];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "clarvis-goal-hosted-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const traces = createMemoryTraceStore();
  const connections = createConnectionManager({
    workspace: root,
    factory: defaultMCPClientFactory,
    connectTimeoutMs: 1000,
    callTimeoutMs: 1000,
  });
  cleanup.push(() => connections.closeAll());
  const scripted = new MockLLM({
    script: options.script ?? [checkpoint(1), checkpoint(2), candidate, { text: "Done" }],
  });
  const wire: Array<{ messages: unknown[]; tools: unknown[]; prompt_cache_key: string }> = [];
  const starts: RunHandle[] = [];
  const closedIndex = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
  const started = Array.from({ length: 4 }, () => Promise.withResolvers<RunHandle>());
  const bounded: RunRequest[] = [];
  const writes: Session[] = [];
  const base = createSessionService({
    dir: root,
    owner: "owner",
    projectId: "project",
    workspaceId: "workspace",
  });
  const store = {
    ...base,
    async saveHost(session: Session) {
      await base.saveHost(session);
      writes.push(structuredClone(session));
    },
  };
  let preparations = 0;
  const coordinator = createHostedSessionCoordinator({
    sessions: store,
    projectId: "project",
    workspaceId: "workspace",
    occupied: (id) => registry?.occupied(id) ?? false,
    redact: (text) => text,
    async prepareExecution(params, context) {
      const index = preparations++;
      await options.beforePrepare?.(index, context);
      const evidence = createGoalEvidenceSource({
        executionId: params.execution_id!,
        workspaceRoot: root,
        readTrace: (id) => traces.getById("owner", id)?.trace.events,
      });
      return prepareHostedGoalTurn({
        params,
        context,
        now: options.now,
        repository,
        sessions: coordinator.sessions,
        evidence: {
          get generation() {
            return evidence.generation;
          },
          observe: (event) => evidence.observe(event),
          async snapshot(goal) {
            await options.beforeEvidence?.(goal);
            return evidence.snapshot(goal);
          },
        },
        async prepareExecution(policy) {
          const raw: RunRequest = {
            execution_id: params.execution_id,
            session_id: params.session_id,
            agent_instance_id: params.agent_instance_id,
            continue_from: params.continue_from,
            messages: params.messages as RunRequest["messages"],
            entry: "solo",
            profiles: [
              { name: "solo", model: "test/model", tools: [], grants: [], iteration_limit: 6 },
            ],
            servers: [],
            providers: [
              { name: "test", kind: "openai-compatible", base_url: "https://fixture.invalid/v1" },
            ],
            budget: { total_token_limit: 100000, on_exceed: "escalate" },
          };
          options.configure?.(raw);
          const body = policy.constrain(raw);
          bounded.push(body);
          const service = createRunService({
            owner: "owner",
            assembleRunRequest: () => body,
            async executeRun(args) {
              return executeRun({
                ...args,
              });
            },
            deps: {
              env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_AGENT_TOOLS_ENABLED: "0" }),
              workspaceRoot: root,
              connections,
              traceStore: traces,
              capabilityRegistry: createCapabilityRegistry(),
              capabilities: options.capabilities ?? [],
              llm: {
                async call(call) {
                  const answer = await scripted.call(call);
                  const adapter = new AiSdkAdapter({
                    fetch: Object.assign(
                      async (_url: string | URL | Request, init?: RequestInit) => {
                        wire.push(JSON.parse(init!.body as string) as (typeof wire)[number]);
                        await options.beforeAnswer?.(wire.length - 1);
                        const calls = answer.toolCalls ?? [];
                        const chunk = {
                          id: `answer-${wire.length}`,
                          object: "chat.completion.chunk",
                          created: 1,
                          model: "model",
                          choices: [
                            {
                              index: 0,
                              delta: {
                                role: "assistant",
                                ...(calls.length === 0
                                  ? { content: answer.text }
                                  : {
                                      tool_calls: calls.map((tool, index) => ({
                                        index,
                                        id: tool.id,
                                        type: "function",
                                        function: {
                                          name: tool.name,
                                          arguments: JSON.stringify(tool.arguments),
                                        },
                                      })),
                                    }),
                              },
                              finish_reason: calls.length === 0 ? "stop" : "tool_calls",
                            },
                          ],
                          usage: {
                            prompt_tokens: 1000,
                            completion_tokens: 20,
                            prompt_tokens_details: { cached_tokens: 800 },
                          },
                        };
                        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
                          headers: { "content-type": "text/event-stream" },
                        });
                      },
                      { preconnect: globalThis.fetch.preconnect },
                    ),
                  });
                  return adapter.call(call);
                },
              },
            },
          });
          return {
            config: { agent: "solo", model: "test/model" },
            detachable: true,
            async start() {
              const handle = await service.start(params, {
                kind: "ordinary",
                rawBody: body,
                goal: policy,
              });
              starts.push(handle);
              started[index]!.resolve(handle);
              return handle;
            },
          };
        },
      });
    },
  });
  const registry = createHostedRegistry({
    owner: "owner",
    workspaceId: "workspace",
    hostGeneration: "generation",
    prepare: coordinator.prepare,
    async projection(id) {
      let data = Buffer.alloc(0);
      return createHostedProjection(
        {
          async write(bytes, offset) {
            data = Buffer.concat([data.subarray(0, offset), bytes]);
          },
          async read(offset, count) {
            return data.subarray(offset, offset + count);
          },
          async sync() {},
          async close() {},
        },
        { execution_id: id, host_generation: "generation" },
      );
    },
    async commit(state) {
      const count = state.runs.filter((item) => item.run.execution_state === "closed").length;
      if (count > 0) closedIndex[count - 1]?.resolve();
    },
    async removeProjection() {},
    retireConfigurationSession() {},
  });
  await coordinator.sessions.save({
    id: "session",
    title: "Goal fixture",
    project_id: "project",
    workspace: "workspace",
    created_at: 1,
    updated_at: 1,
    turns: [],
    totals: { input: 0, output: 0, cached: 0 },
  });
  const repository = createGoalRepository(coordinator.sessions, coordinator);
  let operation = 0;
  const control = (action: GoalControl["action"]) =>
    repository.transact("session", (state) => {
      const result = applyGoalControl(
        state,
        { expected_revision: state?.revision ?? 0, operation_id: `op-${operation++}`, action },
        {
          session_id: "session",
          new_goal_id: "goal",
          now: options.now?.() ?? Date.now(),
          physically_busy: registry?.occupied("session") ?? false,
        },
      );
      return { state: result.state, result };
    });
  await control({
    kind: "create",
    objective: "Complete the synthetic stages",
    criteria: options.criteria ?? [],
    limits: {
      max_net_tokens: 10000,
      max_auto_continuations: 8,
      max_no_progress_checkpoints: 3,
      deadline_at: options.deadlineAt,
    },
  });
  cleanup.push(() => registry.close());
  const peer = registry.connect("operator");
  const start = async (id = "first", continuation?: string) =>
    peer.service.start({
      session_id: "session",
      session_revision: (await base.get("session"))!.revision!,
      kind: "conversation",
      user_preview: "Work on the goal",
      params: {
        execution_id: id,
        continue_from: continuation,
        messages: [{ role: "user", content: "Start the bounded goal" }],
      },
    });
  return {
    start,
    started,
    starts,
    closedIndex,
    registry,
    peer,
    base,
    repository,
    control,
    wire,
    bounded,
    writes,
    state: () => repository.read("session"),
  };
}

describe("goals through real hosted continuation, loop and SDK", () => {
  it("stops new SDK calls when the absolute goal deadline expires within a stage", async () => {
    let now = 100;
    const f = await fixture({
      now: () => now,
      deadlineAt: 200,
      script: [{ toolCalls: [{ name: "get_goal", arguments: {} }] }, candidate, { text: "Done" }],
      beforeAnswer() {
        now = 200;
        return Promise.resolve();
      },
    });
    const first = await f.start();
    expect(await first.handle.done).toMatchObject({ status: "failed" });
    await first.handle.closed;
    expect(f.wire).toHaveLength(1);
    expect(f.starts).toHaveLength(1);
    expect((await f.state())!.current).toMatchObject({
      status: "usage_limited",
      reason: "Goal deadline reached",
      consumption: { net_tokens: 220, usage_unknown: false },
      auto_continuations: 0,
      runs: [{ phase: "closed", outcome: "failed" }],
    });
  });

  it("delivers an external pause before another model call without polling a goal tool", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const step: Capability = {
      name: "fixture_step",
      forRun: () => ({
        name: "fixture_step",
        forAgent: () => ({
          attach: () => ({
            tools: [
              {
                fullName: "fixture_step",
                wireName: "fixture_step",
                mcpName: "",
                toolName: "fixture_step",
                description: "Read one synthetic task step",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              },
            ],
            handlers: [
              {
                matches: (call) => call.name === "fixture_step",
                handle: async () => ({
                  kind: "result",
                  text: "Synthetic step read",
                  progress: true,
                }),
              },
            ],
          }),
        }),
      }),
    };
    const f = await fixture({
      capabilities: [step],
      script: [{ toolCalls: [{ name: "fixture_step", arguments: {} }] }, checkpoint(1)],
      async beforeAnswer(index) {
        if (index === 0) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    try {
      const first = await f.start();
      await entered.promise;
      await f.control({ kind: "pause", running: false });
      release.resolve();
      expect(await first.handle.done).toMatchObject({
        status: "completed",
        disposition: "checkpoint",
      });
      await first.handle.closed;
      expect(f.starts).toHaveLength(1);
      expect(f.wire).toHaveLength(2);
      const previous = f.wire[0]!;
      const next = f.wire[1]!;
      expect(next.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
      expect(next.tools).toEqual(previous.tools);
      expect(next.prompt_cache_key).toBe(previous.prompt_cache_key);
      const messages = next.messages as Array<{
        role: string;
        content: string;
        tool_calls?: unknown[];
      }>;
      const called = messages.findIndex(
        (message) => message.role === "assistant" && message.tool_calls,
      );
      expect(messages[called + 1]).toMatchObject({ role: "tool", content: "Synthetic step read" });
      expect(messages.at(-1)!.content).toContain('"status":"paused"');
      expect((await f.state())!.current).toMatchObject({ status: "paused", auto_continuations: 0 });
    } finally {
      release.resolve();
    }
  });

  it("resumes a paused checkpoint with its complete tool exchange before the changed reminder", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture({
      async beforeAnswer(index) {
        if (index !== 0) return;
        entered.resolve();
        await release.promise;
      },
    });
    try {
      const first = await f.start();
      await entered.promise;
      await f.control({ kind: "pause", running: false });
      release.resolve();
      expect(await first.handle.done).toMatchObject({
        status: "completed",
        disposition: "checkpoint",
      });
      await first.handle.closed;
      expect((await f.state())!.current).toMatchObject({ status: "paused", auto_continuations: 0 });
      expect(f.starts).toHaveLength(1);
      await f.control({ kind: "resume" });
      const resumed = await f.start("resumed", "first");
      expect(await resumed.handle.done).toMatchObject({
        status: "completed",
        disposition: "checkpoint",
      });
      await resumed.handle.closed;
      const last = await f.started[2]!.promise;
      expect(await last.done).toMatchObject({ status: "completed" });
      const observed = await f.peer.service.attach({
        execution_id: last.execution_id,
        host_generation: "generation",
        control: "observe",
      });
      await observed.handle.closed;
      expect((await f.state())!.current).toMatchObject({
        status: "complete",
        auto_continuations: 1,
      });
      expect(f.wire).toHaveLength(4);
      expect(f.wire[1]!.messages.slice(0, f.wire[0]!.messages.length)).toEqual(f.wire[0]!.messages);
      expect(new Set(f.wire.map((call) => call.prompt_cache_key)).size).toBe(1);
      expect(f.wire[1]!.tools).toEqual(f.wire[0]!.tools);
      const messages = f.wire[1]!.messages as Array<{
        role: string;
        content: string;
        tool_calls?: unknown[];
      }>;
      const called = messages.findIndex(
        (message) => message.role === "assistant" && message.tool_calls !== undefined,
      );
      expect(called).toBeGreaterThanOrEqual(0);
      expect(messages[called + 1]!.role).toBe("tool");
      expect(messages[called + 2]!.content).toContain('"status":"paused"');
    } finally {
      release.resolve();
    }
  });

  it.each(["workflow", "iteration", "tokens", "identity"] as const)(
    "refuses incompatible %s preparation before inference and records blocking",
    async (kind) => {
      const f = await fixture({
        configure(body) {
          if (kind === "workflow") body.profiles[0]!.grants = ["workflow"];
          else if (kind === "iteration")
            body.profiles[0]!.iteration_limit = Number.POSITIVE_INFINITY;
          else if (kind === "tokens") body.budget.total_token_limit = Number.POSITIVE_INFINITY;
          else body.agent_instance_id = "foreign";
        },
      });
      const outcome = await f.start().then(
        () => "started",
        () => "refused",
      );
      expect(outcome).toBe("refused");
      expect(f.wire).toEqual([]);
      expect(f.starts).toEqual([]);
      expect((await f.state())!.current).toMatchObject({ status: "blocked", runs: [] });
    },
  );

  it.each(["pause", "cancel"] as const)(
    "preserves %s during terminal evidence validation and still reconciles consumption",
    async (action) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const f = await fixture({
        script: [candidate, { text: "Done" }],
        async beforeEvidence(goal) {
          if (goal.runs.at(-1)?.phase === "settling") {
            entered.resolve();
            await release.promise;
          }
        },
      });
      try {
        const first = await f.start();
        expect(await first.handle.done).toMatchObject({ status: "completed" });
        await entered.promise;
        await f.control(
          action === "pause" ? { kind: "pause", running: false } : { kind: "cancel" },
        );
        release.resolve();
        await first.handle.closed;
        expect((await f.state())!.current).toMatchObject({
          status: action === "pause" ? "paused" : "cancelled",
          consumption: { net_tokens: 440 },
          runs: [{ phase: "closed", outcome: "completed" }],
        });
        expect((await f.base.get("session"))!.totals).toMatchObject({
          input: 2000,
          cached: 1600,
          output: 40,
        });
        expect(f.registry.stats().runs).toBe(0);
      } finally {
        release.resolve();
      }
    },
  );

  it("stops after three checkpoints without useful activity instead of admitting a fourth stage", async () => {
    const f = await fixture({ script: [checkpoint(1), checkpoint(2), checkpoint(3)] });
    const first = await f.start();
    expect((await first.handle.done).disposition).toBe("checkpoint");
    await first.handle.closed;
    const third = await f.started[2]!.promise;
    await third.done;
    const view = await f.peer.service.attach({
      execution_id: third.execution_id,
      host_generation: "generation",
      control: "observe",
    });
    await view.handle.closed;
    expect((await f.state())!.current).toMatchObject({
      status: "blocked",
      no_progress_checkpoints: 3,
      auto_continuations: 2,
    });
    expect(f.starts).toHaveLength(3);
    expect(f.wire).toHaveLength(3);
  });

  it("admits two automatic stages and commits completion, usage and history in the private session", async () => {
    const f = await fixture();
    const first = await f.start();
    expect((await first.handle.done).disposition).toBe("checkpoint");
    await first.handle.closed;
    const second = await f.started[1]!.promise;
    expect((await second.done).disposition).toBe("checkpoint");
    const third = await f.started[2]!.promise;
    expect(await third.done).toMatchObject({ status: "completed", result: "Done" });
    const finalView = await f.peer.service.attach({
      execution_id: third.execution_id,
      host_generation: "generation",
      control: "observe",
    });
    await finalView.handle.closed;
    await f.registry.close();
    const state = (await f.state())!;
    expect(state.current).toMatchObject({
      status: "complete",
      auto_continuations: 2,
      consumption: { input: 4000, cached: 3200, output: 80, net_tokens: 880, usage_unknown: false },
    });
    expect(state.current!.runs.map((run) => run.phase)).toEqual(["closed", "closed", "closed"]);
    expect(state.current!.runs.map((run) => run.automatic)).toEqual([false, true, true]);
    expect(f.starts).toHaveLength(3);
    expect(f.bounded.map((body) => body.budget)).toEqual([
      { total_token_limit: 10000, on_exceed: "stop" },
      { total_token_limit: 9780, on_exceed: "stop" },
      { total_token_limit: 9560, on_exceed: "stop" },
    ]);
    const saved = (await f.base.get("session"))!;
    expect(saved.totals).toMatchObject({ input: 4000, cached: 3200, output: 80 });
    expect(saved.turns.map((turn) => turn.status)).toEqual(["done", "done", "done"]);
    for (const write of f.writes) {
      for (const turn of write.turns)
        expect(
          write.goal_state!.current!.runs.some((run) => run.execution_id === turn.execution_id),
        ).toBe(true);
      if (write.goal_state?.current?.status === "complete")
        expect(write.turns.at(-1)?.status).toBe("done");
    }
    expect(new Set(f.wire.map((call) => call.prompt_cache_key)).size).toBe(1);
    for (let index = 1; index < f.wire.length; index++) {
      expect(f.wire[index]!.tools).toEqual(f.wire[0]!.tools);
      expect(f.wire[index]!.messages.slice(0, f.wire[index - 1]!.messages.length)).toEqual(
        f.wire[index - 1]!.messages,
      );
    }
  });

  it("settles the exact revision validated after a non-revoking human confirmation", async () => {
    let confirmed = false;
    const f = await fixture({
      criteria: [{ id: "review", kind: "human", description: "Operator approval" }],
      script: [
        {
          toolCalls: [
            {
              name: "update_goal",
              arguments: {
                update: {
                  action: "candidate",
                  summary: "Approved result",
                  assessments: [
                    {
                      criterion_id: "review",
                      kind: "human",
                      justification: "Operator approved",
                    },
                  ],
                },
              },
            },
          ],
        },
        { text: "Done" },
      ],
      async beforeEvidence(goal) {
        if (goal.runs.at(-1)?.phase !== "settling" || confirmed) return;
        confirmed = true;
        await f.control({ kind: "accept", criterion_id: "review", objective_revision: 1 });
      },
    });
    await f.control({ kind: "accept", criterion_id: "review", objective_revision: 1 });
    const run = await f.start();
    expect(await run.handle.done).toMatchObject({ status: "completed" });
    await run.handle.closed;
    expect(confirmed).toBe(true);
    expect((await f.state())!.current).toMatchObject({ status: "complete" });
  });

  it("persists pause during continuation preparation and refuses the stale start", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture({
      async beforePrepare(index) {
        if (index === 1) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    try {
      const first = await f.start();
      await first.handle.closed;
      await entered.promise;
      await f.control({ kind: "pause", running: false });
      release.resolve();
      await f.closedIndex[1]!.promise;
      await f.registry.close();
      expect(f.starts).toHaveLength(1);
      expect((await f.state())!.current).toMatchObject({
        status: "paused",
        auto_continuations: 0,
        consumption: { net_tokens: 220 },
      });
      expect((await f.base.get("session"))!.turns).toHaveLength(1);
    } finally {
      release.resolve();
    }
  });
});
