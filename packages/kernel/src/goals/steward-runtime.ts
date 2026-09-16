import type { ModelExecutionInfo, ProviderConfig, TraceEvent } from "@clarvis/capability";
import { buildGoalStewardRequest, runGoalSteward, GoalStewardRunFailure } from "@clarvis/goal";
import { goalAgentSettingsSchema } from "@clarvis/goal/settings";
import type { ExecuteRunDeps } from "@clarvis/loop";
import { readOnlyTools } from "@clarvis/tools";
import type { RunExecutor } from "../runs/run-service.ts";
import type { StewardExecutionRuntime } from "./steward-coordinator.ts";
import { stewardDigest } from "./steward-input.ts";
import { createGoalUsageTracker } from "./usage.ts";
import { createStewardResultGate } from "./steward-result-gate.ts";

/** Captured host configuration, isolated capabilities and a fresh ledger for each evaluation. */
export function createStewardExecutionRuntime(options: {
  owner: string;
  model: string;
  providers: ProviderConfig[];
  deps: ExecuteRunDeps;
  executeRun: RunExecutor;
  settings: unknown;
  workTokenLimit: number;
  promptCacheTtl: "5m" | "1h";
  configurationGeneration: string;
}): StewardExecutionRuntime {
  const settings = goalAgentSettingsSchema.parse(options.settings).steward;
  const tools = (options.deps.capabilities ?? []).filter(
    (capability) => capability.name === "tools",
  );
  const env = options.deps.env;
  const budget = {
    max_net_tokens: Math.min(
      settings?.max_net_tokens ?? options.workTokenLimit,
      env.CLARVIS_TOKEN_CEILING,
    ),
    timeout_ms: Math.min(settings?.timeout_ms ?? 120_000, env.CLARVIS_TIMEOUT_CEILING_MS),
    max_iterations: Math.min(settings?.max_iterations ?? 8, env.CLARVIS_ITERATION_CEILING),
    call_timeout_ms: Math.min(
      settings?.call_timeout_ms ?? 60_000,
      env.CLARVIS_TIMEOUT_CEILING_MS,
      env.CLARVIS_RETRY_AFTER_CEILING_MS,
    ),
    max_retries: Math.min(settings?.max_retries ?? 1, env.CLARVIS_RETRY_CEILING),
  };
  const slash = options.model.indexOf("/");
  const providerName = options.model.slice(0, slash);
  const modelName = options.model.slice(slash + 1);
  const provider = options.providers.find((provider) => provider.name === providerName);
  const model = provider?.models?.[modelName];
  const info: ModelExecutionInfo | undefined =
    options.deps.modelExecutionResolver?.resolve(providerName, modelName) ??
    (options.deps.modelExecutionResolver === undefined && provider
      ? {
          provider: providerName,
          model: modelName,
          kind: provider.kind,
          contextWindowTokens:
            model?.context_window_tokens ?? env.CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS,
          maxOutputTokens: model?.max_output_tokens,
          capabilities: model?.capabilities,
          reasoningEfforts: model?.reasoning_efforts,
          promptCache: model?.prompt_cache,
        }
      : undefined);
  if (!info) throw new Error("Goal Steward model is unavailable");
  const runtime = {
    owner: options.owner,
    model_ref: options.model,
    providers: options.providers,
    execute_run: options.executeRun,
    deps: { ...options.deps, capabilities: tools },
  };
  const canonical = buildGoalStewardRequest(runtime, {
    execution_id: "identity",
    session_id: "identity",
    projection: "frame",
    budget,
    prompt_cache_ttl: options.promptCacheTtl,
  });
  return {
    fingerprint: stewardDigest({
      info,
      generation: options.configurationGeneration,
      profiles: canonical.profiles,
      shared_prompt: canonical.shared_prompt,
      output_schema: canonical.output_schema,
      ttl: options.promptCacheTtl,
      tools: tools.map((capability) => ({
        name: capability.name,
        effects: capability.toolEffects,
      })),
      tool_catalog: readOnlyTools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
      compaction: {
        fraction: env.CLARVIS_DEFAULT_COMPACTION_CONTEXT_FRACTION,
        target: env.CLARVIS_DEFAULT_COMPACTION_TARGET_FRACTION,
        recent: env.CLARVIS_DEFAULT_COMPACTION_PRESERVE_RECENT_TOKENS,
        max_result: env.CLARVIS_DEFAULT_COMPACTION_MAX_RESULT_CHARS,
      },
      enabled: env.CLARVIS_AGENT_TOOLS_ENABLED,
      ceiling: env.CLARVIS_AGENT_TOOLS_MAX_GRANT,
    }),
    workspaceReadAvailable:
      env.CLARVIS_AGENT_TOOLS_ENABLED === true &&
      tools.length === 1 &&
      env.CLARVIS_AGENT_TOOLS_MAX_GRANT !== "none",
    budget,
    promptCacheTtl: options.promptCacheTtl,
    maxReviews: settings?.max_reviews_per_work_run ?? 8,
    maxInterventions: settings?.max_interventions_per_work_run ?? 3,
    maxCompletionReviews: settings?.max_completion_reviews_per_attempt ?? 1,
    async run(input) {
      const tracker = createGoalUsageTracker();
      const trace: TraceEvent[] = [];
      const gate = createStewardResultGate((value) => input.validateResult(value, trace));
      try {
        const result = await runGoalSteward(
          {
            ...runtime,
            execute_run: (args) =>
              runtime.execute_run({
                ...args,
                onEvent(event) {
                  trace.push(event);
                  args.onEvent?.(event);
                },
              }),
            deps: {
              ...runtime.deps,
              capabilities: [...tools, gate],
              llm: tracker.wrap(runtime.deps.llm),
            },
          },
          input,
        );
        return { ...result, usage: tracker.measure(), accounting: tracker.accounting() };
      } catch (error) {
        throw new GoalStewardRunFailure(
          input.execution_id,
          tracker.measure(),
          error instanceof GoalStewardRunFailure ? error.code : "goal_steward_failed",
          tracker.accounting(),
        );
      }
    },
  };
}
