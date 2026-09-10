import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  loadEnv,
  NOOP_LOGGER,
  type Capability,
  type LLMCallParams,
  type LLMProvider,
  type RunRequest,
} from "@clarvis/capability";
import { executeRun, type ExecuteRunArgs, type ExecuteRunOutcome } from "@clarvis/loop";
import { AiSdkAdapter } from "@clarvis/llm/adapter";
import { createFilePlanRepository, createPlanStore } from "@clarvis/plan";
import { globalPaths } from "@clarvis/paths";
import type { StartRunParams } from "@clarvis/protocol";
import {
  createFileKernel,
  type FileKernel,
  SubscriptionManager,
  createOpenAICodexAdapter,
} from "@clarvis/kernel/bootstrap";
import { createCacheFixture, CACHE_FIXTURE_VERSION, type CursorState } from "./fixture.ts";
import { CacheEvidenceWriter, auditCacheTrial, auditCacheReport } from "./evidence.ts";
import { runMemoryCacheFixture } from "./memory.ts";
import { CacheBudget } from "./limits.ts";
import { createCacheRecorder } from "./recorder.ts";
import { evaluateCacheAgents } from "./evaluation.ts";
import { cacheHash } from "./wire.ts";
import {
  CACHE_REPORT_VERSION,
  type CacheCall,
  type CacheLimits,
  type CachePurpose,
  type CacheReport,
  type CacheScenario,
  type CacheTrial,
} from "./types.ts";

export const CACHE_MODELS = ["gpt-6-astra", "gpt-5.6-sol"] as const;
export const CACHE_SCENARIOS: CacheScenario[] = [
  "C01",
  "C02",
  "C03",
  "C04",
  "C05",
  "C06",
  "C07",
  "C08",
  "C09",
  "C10",
  "C11",
];
export function trialLimits(scenario: CacheScenario): CacheLimits {
  return {
    calls: scenario === "C03" || scenario === "C10" ? 100 : 60,
    input: scenario === "C10" ? 6_000_000 : scenario === "C03" ? 4_000_000 : 2_500_000,
    output: 80_000,
    durationMs: 30 * 60_000,
  };
}
export const GLOBAL_CACHE_LIMITS: CacheLimits = {
  calls: 2700,
  input: 110_000_000,
  output: 3_500_000,
  durationMs: 12 * 60 * 60_000,
};

interface RestartState {
  root: string;
  leaderId: string;
  sessionId: string;
  nonce: string;
  previousExecutionId: string;
  states: Array<[string, CursorState]>;
  calls: CacheCall[];
  checkpoints: CacheTrial["checkpoints"];
  settled: Array<[string, { input: number; cached: number; output: number }]>;
  startedAt: number;
  pid: number;
}
export interface CacheTrialArgs {
  scenario: CacheScenario;
  trial: number;
  model: string;
  globalBudget: CacheBudget;
  outputDirectory: string;
  sdkVersion: string;
  restart?: { phase: 1 | 2; stateFile: string };
}

/** Capture production host subscription requests without putting credentials in fixture state. */
export async function runCacheTrial(args: CacheTrialArgs): Promise<CacheTrial> {
  const { scenario, trial, model } = args;
  const limits = trialLimits(scenario);
  const result: CacheTrial = {
    scenario,
    trial,
    model,
    limits,
    checkpoints: [],
    calls: [],
    agents: [],
    verdict: "incomplete",
    diagnostics: [],
  };
  if (!["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10"].includes(scenario)) {
    result.diagnostics.push("scenario_driver_pending");
    return result;
  }
  const restored: RestartState | undefined =
    args.restart?.phase === 2
      ? JSON.parse(await readFile(args.restart.stateFile, "utf8"))
      : undefined;
  const root = restored?.root ?? (await mkdtemp(join(tmpdir(), `clarvis-cache-${scenario}-`)));
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "global");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(globalDir, { recursive: true });
  const leaderId = restored?.leaderId ?? randomUUID();
  const sessionId = restored?.sessionId ?? randomUUID();
  const nonce = restored?.nonce ?? randomUUID();
  const leaders = new Set<string>([leaderId]);
  const memoryAgents = new Set<string>();
  let seedExecution: ExecuteRunArgs | undefined;
  const abort = new AbortController();
  const planStore = createPlanStore({ repository: createFilePlanRepository({ workspaceRoot }) });
  let controlRequested = false;
  const fixture = createCacheFixture({
    scenario,
    nonce,
    leaderId,
    planStore,
    onStep: (agentId, step) => {
      if (agentId !== leaderId || step !== 12 || controlRequested) return;
      if (scenario === "C05") {
        controlRequested = true;
        active?.cancel().catch(() => result.diagnostics.push("cancellation_failed"));
      }
      if (scenario === "C09") {
        controlRequested = true;
        active
          ?.compact(
            "Preserve the current cursor token and verification instructions. Summarize prior corpus blocks compactly.",
          )
          .catch(() => result.diagnostics.push("compaction_request_failed"));
      }
    },
  });
  for (const [id, state] of restored?.states ?? []) fixture.states.set(id, state);
  result.checkpoints.push(...(restored?.checkpoints ?? []));
  const context = new AsyncLocalStorage<{
    purpose: CachePurpose;
    agentId: string;
    executionId?: string;
    effort?: string;
  }>();
  const settled = new Map<
    string,
    {
      input: number;
      cached: number;
      output: number;
      plan?: { status?: string; retention?: string };
    }
  >(restored?.settled ?? []);
  const transitions = new Map<string, string>();
  const phases = new Map<string, string>();
  let base = 0;
  const budget = new CacheBudget(limits, restored?.calls, restored?.startedAt);
  const writer = new CacheEvidenceWriter();
  const recorder = createCacheRecorder(globalThis.fetch, {
    scenario,
    trial,
    sdkVersion: args.sdkVersion,
    requestedModel: model,
    effort: () => context.getStore()?.effort,
    leaderId,
    budget,
    globalBudget: args.globalBudget,
    previousCalls: restored?.calls,
    phase: () =>
      context.getStore()?.purpose === "memory"
        ? "memory-indexing"
        : fixture.phase(context.getStore()?.agentId ?? leaderId),
    base: () => base,
    purpose: () => context.getStore()?.purpose ?? "auxiliary",
    executionId: () => context.getStore()?.executionId,
    transition: () => {
      const id = context.getStore()?.agentId ?? leaderId;
      const value = transitions.get(id);
      transitions.delete(id);
      return value;
    },
    completed: () => {
      writer.write(
        join(args.outputDirectory, `${model}-${scenario}-${trial}-calls.json`),
        recorder.calls,
      );
    },
  });
  const subscriptions = new SubscriptionManager({
    adapters: [createOpenAICodexAdapter({ fetch: recorder.fetch })],
  });
  const sdk = new AiSdkAdapter({
    resolveSubscription: (scheme, signal, affinity) =>
      subscriptions.resolve(scheme, signal, affinity),
  });
  const paths = globalPaths(globalDir);
  const settings = {
    default_model: `chatgpt/${model}`,
    default_reasoning_effort: "medium",
    providers: [{ name: "chatgpt", kind: "openai-codex" }],
    runtime: { backend: "native" },
    budget: {
      on_exceed: "stop",
      total_token_limit: limits.input + limits.output,
      timeout_ms: limits.durationMs,
    },
    plans: { mode: "on", pending_task_nudges: 0 },
  };
  await writeFile(paths.settingsFile, JSON.stringify(settings));
  await mkdir(paths.agentsDir, { recursive: true });
  const common = `model: chatgpt/${model}\nreasoning_effort: medium\ntools: []\ngrants: ${scenario === "C05" ? "[read_workspace]" : "[]"}\niteration_limit: 60\ncall_timeout_ms: 180000\n${scenario === "C08" ? "compaction:\n  max_result_chars: 1800\n" : scenario === "C09" ? "compaction:\n  preserve_recent_tokens: 2000\n" : ""}`;
  await writeFile(
    join(paths.agentsDir, "leader.md"),
    `---\n${common}${scenario === "C03" ? "can_spawn: [explorer]\n" : ""}---\nYou verify a synthetic cursor corpus. Follow tool instructions exactly.\n`,
  );
  await writeFile(
    join(paths.agentsDir, "explorer.md"),
    `---\n${common}---\nYou independently verify your assigned cursor corpus.\n`,
  );
  const observe = async (
    execution: ExecuteRunArgs,
    extra?: Capability,
    inspect?: (params: LLMCallParams) => void,
  ): Promise<ExecuteRunOutcome> => {
    seedExecution ??= execution;
    const request = execution.rawBody as RunRequest;
    const llm: LLMProvider = {
      call: async (params) => {
        const agentId = params.agentInstanceId ?? request.agent_instance_id ?? leaderId;
        const purpose: CachePurpose =
          params.callPurpose === "compaction"
            ? "compaction"
            : params.callPurpose === "memory" || memoryAgents.has(agentId)
              ? "memory"
              : leaders.has(agentId)
                ? "leader"
                : "child";
        inspect?.(params);
        if (purpose !== "memory") await fixture.refreshPhase(agentId);
        const phase = purpose === "memory" ? "memory-indexing" : fixture.phase(agentId);
        if (phases.has(agentId) && phases.get(agentId) !== phase) transitions.set(agentId, phase);
        phases.set(agentId, phase);
        let effective = params;
        if (
          scenario === "C10" &&
          agentId === leaderId &&
          (fixture.states.get(agentId)?.step ?? 0) >= 6
        ) {
          const index = params.messages.findIndex((message) => message.role === "user");
          effective = {
            ...params,
            messages: params.messages.map((message, position) =>
              position === index
                ? {
                    ...message,
                    content: `DELIBERATE CACHE CONTROL MUTATION\n${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`,
                  }
                : message,
            ),
          };
        }
        return context.run(
          {
            agentId,
            purpose,
            executionId: request.execution_id,
            effort: effective.reasoningEffort,
          },
          () => sdk.call(effective),
        );
      },
    };
    const outcome = await executeRun({
      ...execution,
      deps: {
        ...execution.deps,
        llm,
        capabilities: [
          ...(execution.deps.capabilities ?? []),
          ...(extra ? [extra] : [fixture.capability]),
        ],
      },
    });
    const stored = execution.deps.traceStore.getById(execution.owner, outcome.executionId);
    if (stored)
      settled.set(outcome.executionId, {
        input: stored.total_input_tokens ?? 0,
        cached: stored.total_cached_tokens ?? 0,
        output: stored.total_output_tokens ?? 0,
        plan: stored.capability_state?.plans,
      });
    return outcome;
  };
  const open = (): Promise<FileKernel> =>
    createFileKernel({
      workspaceRoot,
      globalDir,
      traceDir: join(root, "traces"),
      memory: false,
      subscriptions: false,
      planStoreFor: () => planStore,
      logger: NOOP_LOGGER,
      env: loadEnv({
        CLARVIS_LOG_LEVEL: "silent",
        CLARVIS_AGENT_TOOLS_ENABLED: scenario === "C05" ? "1" : "0",
        CLARVIS_TIMEOUT_CEILING_MS: String(limits.durationMs),
      }),
      builtins: { tools: scenario === "C05", hooks: false, tasks: false },
      executeRun: (execution) => observe(execution),
    });
  let kernel: FileKernel | undefined;
  let active: Awaited<ReturnType<FileKernel["runs"]["start"]>> | undefined;
  const deadline = setTimeout(
    () => {
      result.diagnostics.push("trial_duration_limit");
      abort.abort();
      active?.cancel().catch(() => result.diagnostics.push("deadline_cancellation_failed"));
    },
    Math.max(1, limits.durationMs - (Date.now() - budget.startedAt)),
  );
  let latestExecutionId = restored?.previousExecutionId;
  try {
    kernel = await open();
    const run = async (params: StartRunParams) => {
      active = await kernel.runs.start(params);
      for await (const event of active.events) {
        if (event.type === "compaction" && event.operation !== "truncation") base += 1;
      }
      const done = await active.done;
      if (done.error) result.diagnostics.push(`${done.error.code}: ${done.error.message}`);
      result.checkpoints.push({
        name: `run/${done.execution_id}`,
        verdict:
          done.status === "completed" || (scenario === "C05" && done.status === "cancelled")
            ? "pass"
            : "incomplete",
        evidence: done.status,
      });
      return done;
    };
    if (restored) transitions.set(leaderId, "process-restart");
    const first = await run(
      restored
        ? {
            agent: "leader",
            continue_from: restored.previousExecutionId,
            messages: [{ role: "user", content: fixture.continue(leaderId, 4) }],
          }
        : {
            agent: "leader",
            session_id: sessionId,
            agent_instance_id: leaderId,
            messages: [{ role: "user", content: fixture.initial }],
          },
    );
    latestExecutionId = first.execution_id;
    if (scenario === "C04" || scenario === "C05") {
      transitions.set(leaderId, scenario === "C05" ? "cancel-resume-guard" : "new-turn");
      await run({
        agent: "leader",
        continue_from: first.execution_id,
        ...(scenario === "C05" ? { guard_mode: "on" as const } : {}),
        messages: [{ role: "user", content: fixture.continue(leaderId, 4) }],
      });
    }
    if (scenario === "C06") {
      if (!seedExecution) throw new Error("memory_seed_execution_missing");
      const memory = await runMemoryCacheFixture({
        root,
        workspaceRoot,
        seed: seedExecution,
        executionId: first.execution_id,
        model,
        signal: abort.signal,
        observe,
        register: (id) => memoryAgents.add(id),
      });
      result.checkpoints.push({
        name: "durable-memory-indexing",
        verdict: memory.completed ? "pass" : "incomplete",
        evidence: JSON.stringify(memory),
      });
    }
    if (scenario === "C10") {
      const controlId = randomUUID();
      leaders.add(controlId);
      await run({
        agent: "leader",
        session_id: randomUUID(),
        agent_instance_id: controlId,
        messages: [{ role: "user", content: fixture.initial }],
      });
    }
    for (const [agent, state] of fixture.states)
      result.checkpoints.push({
        name: `cursor/${agent}`,
        verdict: state.step >= state.target ? "pass" : "incomplete",
        evidence: `${state.step}/${state.target}`,
      });
    if (scenario === "C02") {
      const plan = (await planStore.list()).plans[0];
      const finalized = settled.get(first.execution_id)?.plan;
      const complete =
        (plan?.status === "completed" && plan.tasks[0]?.status === "done") ||
        (finalized?.status === "completed" && finalized.retention === "discard");
      result.checkpoints.push({
        name: "plan-completed",
        verdict: complete ? "pass" : "incomplete",
        evidence: finalized ? `persisted:${finalized.status}/${finalized.retention}` : undefined,
      });
    }
    if (scenario === "C03")
      result.checkpoints.push({
        name: "two-distinct-children",
        verdict: fixture.states.size >= 3 ? "pass" : "incomplete",
      });
    if (scenario === "C05")
      result.checkpoints.push({
        name: "cancellation-and-guard-resume",
        verdict: controlRequested && first.status === "cancelled" ? "pass" : "incomplete",
      });
    if (scenario === "C07" && restored)
      result.checkpoints.push({
        name: "process-restart",
        verdict: restored.pid !== process.pid ? "pass" : "incomplete",
        evidence: `pid:${restored.pid}->${process.pid}`,
      });
    if (scenario === "C09")
      result.checkpoints.push({
        name: "actual-compaction",
        verdict: base > 0 ? "pass" : "incomplete",
      });
  } catch (error) {
    result.diagnostics.push(
      error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : "execution_failed",
    );
  } finally {
    clearTimeout(deadline);
    await kernel?.close();
    await recorder.drain();
    await writer.drain();
    await subscriptions.close();
  }
  result.calls = recorder.calls;
  if (args.restart?.phase === 1 && latestExecutionId) {
    const state: RestartState = {
      root,
      leaderId,
      sessionId,
      nonce,
      previousExecutionId: latestExecutionId,
      states: [...fixture.states],
      calls: result.calls,
      checkpoints: result.checkpoints,
      settled: [...settled],
      startedAt: budget.startedAt,
      pid: process.pid,
    };
    writer.write(args.restart.stateFile, state);
    await writer.drain();
  }
  result.accounting = [...settled].map(([executionId, usage]) => {
    const calls = result.calls.filter((call) => call.executionId === executionId);
    const unknownUsageCalls = calls.filter((call) => call.usage === undefined).length;
    const totals = calls.reduce(
      (sum, call) => ({
        input: sum.input + (call.usage?.input ?? 0),
        cached: sum.cached + (call.usage?.cached ?? 0),
        output: sum.output + (call.usage?.output ?? 0),
      }),
      { input: 0, cached: 0, output: 0 },
    );
    const reconciled =
      unknownUsageCalls === 0 &&
      totals.input === usage.input &&
      totals.cached === usage.cached &&
      totals.output === usage.output;
    result.checkpoints.push({
      name: `usage/${executionId}`,
      verdict: reconciled ? "pass" : "incomplete",
    });
    return {
      executionId,
      usage: { input: usage.input, cached: usage.cached, output: usage.output },
      physicalCalls: calls.length,
      unknownUsageCalls,
      reconciled,
    };
  });
  result.agents = evaluateCacheAgents(result.calls);
  if (scenario === "C03") {
    const children = [
      ...new Set(
        result.calls.filter((call) => call.purpose === "child").map((call) => call.agentInstanceId),
      ),
    ];
    const periods = children.map((id) => {
      const calls = result.calls.filter((call) => call.agentInstanceId === id);
      return {
        start: Math.min(...calls.map((call) => call.startedAt)),
        end: Math.max(...calls.map((call) => call.endedAt)),
      };
    });
    const overlap =
      periods.length === 2 &&
      Math.max(...periods.map((period) => period.start)) <
        Math.min(...periods.map((period) => period.end));
    const after = result.calls.filter(
      (call) =>
        call.purpose === "leader" &&
        call.startedAt > Math.max(...periods.map((period) => period.end)),
    ).length;
    result.checkpoints.push({
      name: "concurrent-children-and-leader-continuation",
      verdict: overlap && after >= 4 ? "pass" : "incomplete",
      evidence: `overlap:${overlap};leader_after:${after}`,
    });
  }
  if (scenario === "C08")
    result.checkpoints.push({
      name: "new-result-truncated-before-request",
      verdict: result.calls.some((call) => call.truncatedNewResult) ? "pass" : "incomplete",
    });
  if (scenario === "C09") {
    const leadCalls = result.calls.filter((call) => call.purpose === "leader");
    const boundary = leadCalls.findIndex((call) => call.compaction);
    const saved =
      boundary > 0
        ? (leadCalls[boundary - 1]?.usage?.input ?? 0) - (leadCalls[boundary]?.usage?.input ?? 0)
        : 0;
    result.checkpoints.push({
      name: "measured-compaction-input-saving",
      verdict: saved > 0 ? "pass" : "incomplete",
      evidence: `input_tokens_saved:${saved}`,
    });
  }
  if (scenario === "C10")
    result.checkpoints.push({
      name: "mutation-and-append-control",
      verdict:
        result.agents.length === 2 &&
        result.calls.some((call) => call.divergence?.surface === "history")
          ? "pass"
          : "incomplete",
    });
  auditCacheTrial(result);
  result.diagnostics.push(`evidence_directory:${root}`);
  await writeFile(
    join(args.outputDirectory, `${model}-${scenario}-${trial}.json`),
    JSON.stringify(result, null, 2),
  );
  return result;
}

/** Repository/build inputs are content-addressed, including dirty and newly added source files. */
export async function cacheSourceIdentity(config: unknown): Promise<CacheReport["source"]> {
  const git = (argv: string[]) => {
    const result = Bun.spawnSync(["git", ...argv]);
    if (result.exitCode !== 0) throw new Error("cache_source_identity_failed");
    return result.stdout.toString().trim();
  };
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").sort();
  const hashes = await Promise.all(
    files.map(async (file) => {
      try {
        return [file, cacheHash(await readFile(file))];
      } catch {
        return [file, "missing"];
      }
    }),
  );
  const sdkVersion = JSON.parse(await readFile("node_modules/@ai-sdk/openai/package.json", "utf8"))
    .version as string;
  return {
    commit: git(["rev-parse", "HEAD"]),
    inputsHash: cacheHash(hashes),
    lockfileHash: cacheHash(await readFile("bun.lock")),
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    sdkVersion,
    fixtureHash: cacheHash([
      CACHE_FIXTURE_VERSION,
      ...(await Promise.all(
        ["fixture.ts", "memory.ts", "artifact.ts"].map(async (file) => [
          file,
          await readFile(join("tooling/cache", file), "utf8"),
        ]),
      )),
    ]),
    configHash: cacheHash(config),
  };
}

/** Two fresh OS processes reopen the same durable conversation and retain the shared budgets. */
export async function runRestartCacheTrial(args: CacheTrialArgs): Promise<CacheTrial> {
  const stateFile = join(args.outputDirectory, args.model + "-C07-" + args.trial + "-restart.json");
  let previous: CacheTrial | undefined;
  for (const phase of [1, 2] as const) {
    const worker = join(
      args.outputDirectory,
      args.model + "-C07-" + args.trial + "-worker-" + phase + ".json",
    );
    await writeFile(
      worker,
      JSON.stringify({
        ...args,
        globalBudget: undefined,
        globalCalls: args.globalBudget.calls,
        globalStartedAt: args.globalBudget.startedAt,
        restart: { phase, stateFile },
      }),
    );
    const child = Bun.spawn([process.execPath, import.meta.path, "--worker", worker], {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    const timeout = setTimeout(() => child.kill(), Math.max(1, trialLimits("C07").durationMs));
    const status = await child.exited;
    clearTimeout(timeout);
    if (status !== 0) throw new Error("cache_restart_worker_failed");
    const current = JSON.parse(await readFile(worker + ".result.json", "utf8")) as CacheTrial;
    args.globalBudget.reconcile(current.calls);
    previous = current;
    if (phase === 1 && current.checkpoints.some((checkpoint) => checkpoint.verdict !== "pass"))
      break;
  }
  return previous;
}

if (import.meta.main && process.argv.includes("--worker")) {
  const path = process.argv[process.argv.indexOf("--worker") + 1];
  const job = JSON.parse(await readFile(path, "utf8")) as Omit<CacheTrialArgs, "globalBudget"> & {
    globalCalls: CacheCall[];
    globalStartedAt: number;
  };
  const result = await runCacheTrial({
    ...job,
    globalBudget: new CacheBudget(GLOBAL_CACHE_LIMITS, job.globalCalls, job.globalStartedAt),
  });
  await writeFile(`${path}.result.json`, JSON.stringify(result, null, 2));
} else if (import.meta.main) {
  const option = (name: string, fallback: string) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
  };
  const scenarios = option("--scenarios", "C01,C02").split(",") as CacheScenario[];
  const models = option("--models", "gpt-6-astra").split(",");
  const trials = Number(option("--trials", "3"));
  if (
    !Number.isInteger(trials) ||
    trials < 1 ||
    trials > 3 ||
    scenarios.some((id) => !CACHE_SCENARIOS.includes(id)) ||
    models.some((model) => !CACHE_MODELS.includes(model as (typeof CACHE_MODELS)[number]))
  )
    throw new Error("Invalid cache matrix");
  const outputDirectory = resolve(option("--output", "specs/proposals/cache-evidence"));
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    join(outputDirectory, "invocation.json"),
    JSON.stringify({
      startedAt: Date.now(),
      argv: process.argv.slice(2),
      limits: GLOBAL_CACHE_LIMITS,
    }),
    { flag: "wx", mode: 0o600 },
  );
  const full = process.argv.includes("--full");
  const manifestPath = option("--artifact-manifest", "");
  if (full && !manifestPath) throw new Error("full_qualification_requires_sealed_artifact");
  const sealed = manifestPath
    ? (JSON.parse(await readFile(manifestPath, "utf8")) as Pick<CacheReport, "source" | "artifact">)
    : undefined;
  const source = await cacheSourceIdentity({ scenarios, models, trials, full });
  if (
    sealed &&
    (sealed.source.inputsHash !== source.inputsHash ||
      sealed.source.lockfileHash !== source.lockfileHash ||
      sealed.source.commit !== source.commit ||
      sealed.source.bun !== source.bun ||
      sealed.source.platform !== source.platform ||
      sealed.source.arch !== source.arch ||
      !sealed.artifact)
  )
    throw new Error("sealed_artifact_inputs_changed");
  const globalBudget = new CacheBudget(GLOBAL_CACHE_LIMITS);
  const report: CacheReport = {
    schemaVersion: CACHE_REPORT_VERSION,
    source,
    ...(sealed?.artifact ? { artifact: sealed.artifact } : {}),
    limits: GLOBAL_CACHE_LIMITS,
    expected: full
      ? [
          ...CACHE_SCENARIOS.map((scenario) => ({ scenario, model: "gpt-6-astra", trials: 3 })),
          ...(["C01", "C02", "C04"] as const).map((scenario) => ({
            scenario,
            model: "gpt-5.6-sol",
            trials: 3,
          })),
        ]
      : models.flatMap((model) => scenarios.map((scenario) => ({ scenario, model, trials }))),
    trials: [],
    verdict: "incomplete",
    diagnostics: [],
  };
  process.stdout.write(
    JSON.stringify({
      event: "cache.limits",
      global: GLOBAL_CACHE_LIMITS,
      trials: [...new Set(report.expected.map((entry) => entry.scenario))].map((scenario) => ({
        scenario,
        limits: trialLimits(scenario),
      })),
    }) + "\n",
  );
  for (const expected of report.expected)
    for (let trial = 1; trial <= expected.trials; trial += 1) {
      if (globalBudget.exhausted()) {
        report.diagnostics.push("global_limit_reached");
        break;
      }
      if ((await cacheSourceIdentity({})).inputsHash !== report.source.inputsHash) {
        report.diagnostics.push("source_inputs_changed_during_qualification");
        break;
      }
      process.stdout.write(
        JSON.stringify({ event: "cache.trial_started", ...expected, trial }) + "\n",
      );
      const trialArgs = {
        ...expected,
        trial,
        globalBudget,
        outputDirectory,
        sdkVersion: report.source.sdkVersion,
      };
      let result: CacheTrial;
      try {
        if (expected.scenario === "C11") {
          const { runCacheArtifact } = await import("./artifact.ts");
          const installed = await runCacheArtifact({
            outputDirectory,
            globalDir: resolve(
              option("--artifact-global-dir", join(outputDirectory, "installed-global")),
            ),
            archiveDirectory: resolve(option("--archive-directory", "build/release")),
            model: expected.model,
            trial,
            globalBudget,
            ...(process.argv.includes("--use-global-oauth")
              ? { authenticationRoot: globalPaths().root }
              : {}),
          });
          result = installed.trial;
          if (
            report.artifact &&
            (installed.artifact.archiveHash !== report.artifact.archiveHash ||
              installed.artifact.bundleHash !== report.artifact.bundleHash)
          )
            result.diagnostics.push("installed_artifact_mismatch");
          else report.artifact = installed.artifact;
        } else
          result =
            expected.scenario === "C07"
              ? await runRestartCacheTrial(trialArgs)
              : await runCacheTrial(trialArgs);
      } catch (error) {
        const captured = await readFile(
          join(outputDirectory, `${expected.model}-${expected.scenario}-${trial}-calls.json`),
          "utf8",
        ).catch(() => "[]");
        const recovered = JSON.parse(captured) as CacheCall[];
        globalBudget.reconcile(recovered);
        result = {
          scenario: expected.scenario,
          model: expected.model,
          trial,
          limits: trialLimits(expected.scenario),
          calls: globalBudget.calls.filter(
            (call) =>
              call.scenario === expected.scenario &&
              call.trial === trial &&
              call.requestedModel === expected.model,
          ),
          agents: [],
          checkpoints: [],
          verdict: "incomplete",
          diagnostics: [
            error instanceof Error ? error.message.slice(0, 300) : "scenario_execution_failed",
          ],
        };
      }
      if (report.artifact) result.artifactHash = report.artifact.archiveHash;
      auditCacheTrial(result);
      report.trials.push(result);
      process.stdout.write(
        JSON.stringify({
          event: "cache.trial_completed",
          scenario: result.scenario,
          model: result.model,
          trial,
          verdict: result.verdict,
          calls: result.calls.length,
        }) + "\n",
      );
      await writeFile(join(outputDirectory, "report.json"), JSON.stringify(report, null, 2));
    }
  auditCacheReport(report, full);
  await writeFile(join(outputDirectory, "report.json"), JSON.stringify(report, null, 2));
  process.exitCode = report.verdict === "pass" ? 0 : 1;
}
