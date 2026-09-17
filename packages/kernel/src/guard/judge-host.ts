import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import { createJudgeCapability, JudgeArchitectureError } from "@clarvis/judge";
import { JUDGE_DEFAULTS, judgeRequestConfig } from "@clarvis/judge/settings";
import {
  NOOP_LOGGER,
  OPERATOR_AUTHORITY_PORT,
  RUN_TRACE_PORT,
  type CapabilityRequestView,
  type EnvConfig,
  type Logger,
} from "@clarvis/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";
import type { TraceStore } from "@clarvis/trace";
import type { GuardSettingsLoader } from "./resolver.ts";
import { createJudgeTraceStore } from "./judge-trace-store.ts";
import { callReviewerWithTrace, reviewerFailureKind } from "./reviewer-trace.ts";

/** Conservative, synchronous request predicate: off still permits automatic configuration review. */
export function judgeRequiredFor(
  view: CapabilityRequestView,
  env: EnvConfig,
  toolsEnabled: boolean,
): boolean {
  if (!toolsEnabled || !env.CLARVIS_AGENT_TOOLS_ENABLED || view.request.guard_mode === "on")
    return false;
  if (env.CLARVIS_AGENT_TOOLS_MAX_GRANT !== "edit" && env.CLARVIS_AGENT_TOOLS_MAX_GRANT !== "exec")
    return false;
  return view.request.profiles.some((profile) =>
    profile.grants?.some((grant) => grant === "edit_workspace" || grant === "run_commands"),
  );
}

/** Compose private persistence and empty MCP machinery once over the host's physical store. */
export function createHostJudge(options: {
  deps: ExecuteRunDeps;
  physicalStore: TraceStore;
  loadSettings: GuardSettingsLoader;
  toolsEnabled: boolean;
  audit?: Logger;
}) {
  const store = createJudgeTraceStore(options.physicalStore);
  const connections = createConnectionManager({
    workspace: options.deps.workspaceRoot,
    factory: defaultMCPClientFactory,
    connectTimeoutMs: options.deps.env.CLARVIS_MCP_CONNECT_TIMEOUT_MS,
    callTimeoutMs: options.deps.env.CLARVIS_MCP_TOOL_CALL_TIMEOUT_MS,
  });
  return {
    close: () => connections.closeAll(),
    capability: createJudgeCapability({
      requiredFor: (view) => judgeRequiredFor(view, options.deps.env, options.toolsEnabled),
      bind(ctx) {
        const settings = options.loadSettings();
        const override = judgeRequestConfig(ctx);
        const config = { ...settings.effect_review, ...override };
        const trace = ctx.services.get(RUN_TRACE_PORT);
        const authority = ctx.services.get(OPERATOR_AUTHORITY_PORT);
        if (trace === undefined || authority === undefined) throw new JudgeArchitectureError();
        return {
          model: config.model ?? settings.defaultModel,
          providers:
            options.deps.modelExecutionResolver === undefined
              ? (settings.providers ?? ctx.request.providers)
              : [],
          timeoutMs: config.timeout_ms ?? JUDGE_DEFAULTS.timeoutMs,
          maxRetries: config.max_retries ?? JUDGE_DEFAULTS.maxRetries,
          createServices(descriptor) {
            const observation = descriptor.observation;
            if (observation === undefined) throw new JudgeArchitectureError();
            return {
              env: ctx.env,
              workspaceRoot: ctx.workspaceRoot,
              logger: NOOP_LOGGER,
              connections,
              traceStore: store,
              modelExecutionResolver: options.deps.modelExecutionResolver,
              extensionAdmission: options.deps.extensionAdmission,
              llm: {
                call(params) {
                  if (observation.path === "effect_review")
                    options.audit?.info(
                      {
                        event: "effect_review.reviewer.started",
                        consumer: observation.consumer,
                        stage: descriptor.stage(),
                        model: params.model,
                        provider: params.provider,
                        revision: authority.snapshot().revision,
                        effect_id: observation.effectId ?? "external.unknown",
                      },
                      "effect review started",
                    );
                  return callReviewerWithTrace(descriptor.executionBaseLlm, params, {
                    trace,
                    path: observation.path,
                    consumer: observation.consumer,
                    stage: descriptor.stage(),
                    judge_execution_id: descriptor.executionId,
                    authority_revision: authority?.snapshot().revision,
                    effect_id: observation.effectId,
                    failureKind: (error) =>
                      reviewerFailureKind(
                        error,
                        params.signal?.aborted === true && descriptor.signal?.aborted !== true,
                        descriptor.signal,
                      ),
                  });
                },
              },
            };
          },
        };
      },
    }),
  };
}
