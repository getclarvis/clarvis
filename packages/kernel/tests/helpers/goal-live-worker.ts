import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isBuiltinTraceEvent, loadEnv, NOOP_LOGGER, type LLMCallParams } from "@clarvis/capability";
import { executeRun } from "@clarvis/loop";
import {
  createFileRunHost,
  createKernelEnvironment,
  type FileRunHost,
} from "@clarvis/kernel/bootstrap";
import { createFilePlanRepository, createPlanStore } from "@clarvis/plan";
import { localHostPaths, writeFileDurableSync } from "@clarvis/paths";
import type { KernelClient } from "@clarvis/protocol";
import { openHostedProjection } from "../../src/hosting/projection.ts";
import { connectKernelClient } from "../../src/transport/client.ts";
import { connectLocalKernelTransport, listenLocalKernel } from "../../src/transport/local.ts";
import { CacheBudget } from "../../../../tooling/cache/limits.ts";
import { createCacheRecorder } from "../../../../tooling/cache/recorder.ts";
import type { CachePurpose } from "../../../../tooling/cache/types.ts";
import type { GoalLiveJob, GoalLiveResult } from "../../../../tooling/goal/types.ts";
import {
  goalArgumentShape,
  goalChatGptAffinity,
  goalToolFailure,
} from "../../../../tooling/goal/evidence.ts";
import {
  GOAL_GLOBAL_LIMITS,
  GOAL_OBJECTIVE,
  GOAL_TEST_SOURCE,
  GOAL_TRIAL_LIMITS,
  type GoalScenario,
} from "../../../../tooling/goal/fixture.ts";

/** Actual FileRunHost execution and provider, with bounded observation outside the host's usage tracker. */
export async function runGoalLiveWorker(job: GoalLiveJob): Promise<GoalLiveResult> {
  const workspaceRoot = join(job.root, "workspace");
  const planStore = createPlanStore({
    repository: createFilePlanRepository({ workspaceRoot, lockDir: join(job.root, "plan-locks") }),
  });
  const result: GoalLiveResult = {
    schema_version: 2,
    model: job.model,
    trial: job.trial,
    started_at: Date.now(),
    runtime: "native",
    verdict: "incomplete",
    diagnostics: [],
    calls: [],
    tool_events: [],
    stages: [],
    checkpoints: {},
    agents: [],
  };
  const save = () => writeFileDurableSync(job.outputFile, JSON.stringify(result, null, 2));
  const context = new AsyncLocalStorage<{
    executionId: string;
    purpose: CachePurpose;
    effort?: string;
  }>();
  const budget = new CacheBudget<GoalScenario>(GOAL_TRIAL_LIMITS);
  const globalBudget = new CacheBudget<GoalScenario>(
    GOAL_GLOBAL_LIMITS,
    job.globalCalls,
    job.globalStartedAt,
  );
  const originalFetch = globalThis.fetch;
  const recorder = createCacheRecorder<GoalScenario>(originalFetch, {
    scenario: "goal-continuation",
    trial: job.trial,
    sdkVersion: job.sdkVersion,
    requestedModel: job.model,
    effort: () => context.getStore()?.effort,
    leaderId: "host-assigned",
    budget,
    globalBudget,
    phase: () => context.getStore()?.executionId ?? "unknown",
    base: () => 0,
    purpose: () => context.getStore()?.purpose ?? "auxiliary",
    executionId: () => context.getStore()?.executionId,
    completed(call) {
      result.calls.push(call);
      save();
    },
  });
  globalThis.fetch = recorder.fetch;
  const cleanups: Array<() => Promise<unknown>> = [];
  let host: FileRunHost | undefined;
  let client: KernelClient | undefined;
  let sessionId = "";
  const cancel = () => {
    if (!client || !sessionId) return;
    void client.goals
      .get(sessionId)
      .then(async (view) => {
        if (view.state.current?.status === "active")
          await client!.goals.control({
            session_id: sessionId,
            expected_revision: view.state.revision,
            operation_id: randomUUID(),
            action: { kind: "pause", running: true },
          });
      })
      .catch(() => result.diagnostics.push("limit_cancellation_failed"));
  };
  budget.signal.addEventListener("abort", cancel, { once: true });
  globalBudget.signal.addEventListener("abort", cancel, { once: true });
  try {
    const paths = localHostPaths({
      globalDir: job.globalDir,
      workspaceRoot,
      owner: "operator",
      operatorId: "goal-live",
    });
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    if (paths.endpointDirectory)
      cleanups.push(() => rm(paths.endpointDirectory!, { recursive: true, force: true }));
    host = await createFileRunHost({
      kernel: {
        workspaceRoot,
        globalDir: job.globalDir,
        traceDir: join(job.root, "traces"),
        defaultOwner: "operator",
        memory: false,
        logger: NOOP_LOGGER,
        env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" }),
        environment: createKernelEnvironment({ PATH: process.env.PATH }),
        builtins: { tools: true, skills: false, hooks: false, tasks: false },
        planStoreFor: () => planStore,
        executeRun: (args) => {
          const request = args.rawBody as { execution_id: string; agent_instance_id: string };
          const original = args.deps.llm;
          return executeRun({
            ...args,
            onEvent(event) {
              args.onEvent?.(event);
              if (!isBuiltinTraceEvent(event) || event.type !== "tool_call") return;
              if (result.tool_events.length >= 512) {
                if (!result.diagnostics.includes("tool_evidence_limit"))
                  result.diagnostics.push("tool_evidence_limit");
                return;
              }
              const action = (event.arguments as { update?: { action?: unknown } }).update?.action;
              result.tool_events.push({
                execution_id: request.execution_id,
                call_id: event.call_id,
                tool: event.tool_name || event.mcp_name,
                ok: event.error === null,
                ...(action === "progress" ||
                action === "checkpoint" ||
                action === "candidate" ||
                action === "blocked"
                  ? { action }
                  : {}),
                argument_shape: goalArgumentShape(event.arguments),
                error: goalToolFailure(event.error),
              });
              save();
            },
            deps: {
              ...args.deps,
              llm: {
                call: (params: LLMCallParams) =>
                  context.run(
                    {
                      executionId: request.execution_id,
                      purpose:
                        params.callPurpose === "compaction"
                          ? "compaction"
                          : params.agentInstanceId === request.agent_instance_id
                            ? "leader"
                            : "child",
                      effort: params.reasoningEffort,
                    },
                    () => original.call(params),
                  ),
              },
            },
          });
        },
      },
      hostGeneration: "goal-live-generation",
      authenticate: (token) => (token === "synthetic-operator" ? "operator" : undefined),
      storage: {
        projection: (id) =>
          openHostedProjection(paths.projectionFile("goal-live-generation", id), {
            host_generation: "goal-live-generation",
            execution_id: id,
          }),
        removeProjection: (id) => rm(paths.projectionFile("goal-live-generation", id)),
        commit(state) {
          writeFileDurableSync(paths.registryFile, JSON.stringify(state));
          return Promise.resolve();
        },
      },
    });
    cleanups.push(() => host!.close());
    const listener = await listenLocalKernel(host.server, paths.endpoint);
    cleanups.push(() => listener.close());
    const transport = await connectLocalKernelTransport(paths.endpoint);
    cleanups.push(() => transport.close());
    client = await connectKernelClient(transport, { auth: "synthetic-operator" });
    sessionId = randomUUID();
    await client.sessions.save({
      id: sessionId,
      title: "Synthetic goal qualification",
      project_id: client.project.id,
      workspace: client.workspace.id,
      created_at: Date.now(),
      updated_at: Date.now(),
      turns: [],
      totals: { input: 0, output: 0, cached: 0 },
      agent_profile: "goal-leader",
    });
    const control = {
      session_id: sessionId,
      expected_revision: 0,
      operation_id: randomUUID(),
      action: {
        kind: "create" as const,
        objective: GOAL_OBJECTIVE,
        limits: { max_net_tokens: 30000, max_auto_continuations: 3 },
      },
    };
    const receipt = await client.goals.control(control);
    save();
    for (;;) {
      const view = await client.goals.get(sessionId);
      result.goal = view.state.current;
      save();
      if (host.stats().runs === 0 && view.state.current?.status !== "active") break;
      if (budget.signal.aborted || globalBudget.signal.aborted) {
        result.diagnostics.push("physical_limit_reached");
        break;
      }
      await Bun.sleep(100);
    }
    if (host.stats().runs > 0) {
      await host.close();
      throw new Error("physical_limit_reached_before_settlement");
    }
    await recorder.drain();
    const session = await host.kernel.sessions.get(sessionId);
    result.goal = session?.goal_state?.current;
    const goal = result.goal;
    if (!goal) throw new Error("missing_goal_state");
    for (const run of goal.runs) {
      const detail = await host.kernel.runs.get(run.execution_id);
      result.stages.push({
        execution_id: detail.execution_id,
        status: detail.status,
        continue_from: detail.continue_from,
        plan_ref: detail.plan_ref,
        result: detail.result,
      });
    }
    const plans = (await planStore.list()).plans;
    const verification = Bun.spawn(
      [process.execPath, "test", "solution.test.ts", "--timeout", "5000"],
      {
        cwd: workspaceRoot,
        env: { PATH: process.env.PATH },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(verification.stdout).text(),
      new Response(verification.stderr).text(),
      verification.exited,
    ]);
    await writeFile(job.outputFile + ".verification.txt", stdout + stderr);
    const tools = result.calls.flatMap((call) => call.toolCalls.map((tool) => tool.name));
    const totals = result.calls.reduce(
      (sum, call) => ({
        input: sum.input + (call.usage?.input ?? 0),
        output: sum.output + (call.usage?.output ?? 0),
        cached: sum.cached + (call.usage?.cached ?? 0),
      }),
      { input: 0, output: 0, cached: 0 },
    );
    result.checkpoints = {
      completed: goal.status === "complete",
      automatic_continuation: goal.auto_continuations >= 1 && goal.runs.length >= 2,
      checkpoint_before_final:
        goal.runs[0]?.disposition === "checkpoint" && goal.runs.at(-1)?.disposition === "final",
      physically_closed:
        goal.runs.every((run) => run.phase === "closed") && host.stats().runs === 0,
      delegation:
        tools.includes("delegate_task") && result.calls.some((call) => call.purpose === "child"),
      plan_complete:
        plans.length === 1 &&
        plans[0].status === "completed" &&
        plans[0].tasks.every((task) => task.status === "done"),
      independent_verification: exitCode === 0,
      tests_unchanged:
        (await readFile(join(workspaceRoot, "solution.test.ts"), "utf8")) === GOAL_TEST_SOURCE,
      valid_usage:
        result.calls.length > 0 &&
        result.calls.every(
          (call) =>
            call.usage !== undefined &&
            call.usage.cached <= call.usage.input &&
            call.usage.cached >= 0 &&
            call.status === "completed",
        ),
      accounting:
        !goal.consumption.usage_unknown &&
        totals.input === goal.consumption.input &&
        totals.output === goal.consumption.output &&
        totals.cached === goal.consumption.cached &&
        session?.totals.input === totals.input &&
        session?.totals.output === totals.output &&
        session?.totals.cached === totals.cached,
      prefix: result.calls.every((call) => call.divergence === undefined),
      model: result.calls.every(
        (call) =>
          call.serializedModel === job.model &&
          call.resolvedModel === job.model &&
          call.endpoint === "https://chatgpt.com/backend-api/codex/responses" &&
          call.serializedEffort === "medium",
      ),
      affinity: result.calls.every((call) => goalChatGptAffinity(call, sessionId)),
      receipt_bound: receipt.execution_id === goal.runs[0]?.execution_id,
    };
    for (const id of new Set(result.calls.map((call) => call.agentInstanceId))) {
      const calls = result.calls.filter((call) => call.agentInstanceId === id);
      const total = calls.reduce(
        (sum, call) => ({
          input: sum.input + (call.usage?.input ?? 0),
          output: sum.output + (call.usage?.output ?? 0),
          cached: sum.cached + (call.usage?.cached ?? 0),
          unknown: sum.unknown + (call.usage === undefined ? 1 : 0),
        }),
        { input: 0, output: 0, cached: 0, unknown: 0 },
      );
      result.agents.push({
        id,
        purpose: calls[0].purpose,
        calls: calls.length,
        ...total,
        ...(total.input === 0 || total.unknown ? {} : { weighted_hit: total.cached / total.input }),
      });
    }
    result.verdict = result.diagnostics.length
      ? "incomplete"
      : Object.values(result.checkpoints).every(Boolean)
        ? "pass"
        : "fail";
    await writeFile(
      job.outputFile + ".solution.ts",
      await readFile(join(workspaceRoot, "solution.ts")),
    );
  } catch (error) {
    result.diagnostics.push(error instanceof Error ? error.message : "goal_live_failed");
  } finally {
    const failures: unknown[] = [];
    for (const close of cleanups.reverse()) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    await recorder.drain();
    globalThis.fetch = originalFetch;
    budget.signal.removeEventListener("abort", cancel);
    globalBudget.signal.removeEventListener("abort", cancel);
    result.cleanup = failures.length === 0;
    if (failures.length) {
      result.diagnostics.push("cleanup_failed");
      result.verdict = "incomplete";
    }
    result.ended_at = Date.now();
    save();
  }
  return result;
}

if (import.meta.main) {
  const job = JSON.parse(await readFile(process.argv[2], "utf8")) as GoalLiveJob;
  const result = await runGoalLiveWorker(job);
  process.stdout.write(
    JSON.stringify({
      model: job.model,
      trial: job.trial,
      verdict: result.verdict,
      calls: result.calls.length,
      diagnostics: result.diagnostics,
      checkpoints: result.checkpoints,
    }) + "\n",
  );
  process.exitCode = result.verdict === "pass" ? 0 : 1;
}
