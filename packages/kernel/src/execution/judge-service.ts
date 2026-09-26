import {
  contentToText,
  parseModelRef,
  resolveProvider,
  type ModelExecutionInfo,
  type ModelExecutionResolver,
  type RunCapabilityContext,
} from "@clarvis/capability";
import { createJudgeService } from "@clarvis/judge";
import type { JudgeSettings } from "../config/judge-settings.ts";
import { createJudgeRunner } from "./judge-runner.ts";

/** Resolve one model from the run's closed execution catalog before auto admission. */
export function createRunJudge(
  ctx: RunCapabilityContext,
  settings: JudgeSettings,
  catalog: ModelExecutionResolver | undefined,
  runnerOptions: Parameters<typeof createJudgeRunner>[0],
) {
  const parent = ctx.request.profiles.find((profile) => profile.name === ctx.request.entry);
  const reference = settings.model ?? parent?.model;
  if (!reference) throw new Error("auto approval requires a resolved parent model");
  const { provider, modelId } = parseModelRef(reference);
  const declared = ctx.request.providers?.find((candidate) => candidate.name === provider);
  const model =
    catalog?.resolve(provider, modelId) ??
    (declared?.models?.[modelId]
      ? ({
          provider,
          model: modelId,
          kind: declared.kind,
          contextWindowTokens: declared.models[modelId].context_window_tokens,
          maxOutputTokens: declared.models[modelId].max_output_tokens,
          capabilities: declared.models[modelId].capabilities,
          reasoningEfforts: declared.models[modelId].reasoning_efforts,
          promptCache: declared.models[modelId].prompt_cache,
        } satisfies ModelExecutionInfo)
      : undefined);
  if (!model || model.provider !== provider || model.model !== modelId)
    throw new Error(`auto approval model is not in the execution catalog: ${reference}`);
  const resolution = resolveProvider(provider, ctx.request.providers, modelId);
  return createJudgeService({
    llm: ctx.llm,
    model,
    ...(resolution.ok ? { providerConfig: resolution.config } : {}),
    ...(settings.guidance === undefined ? {} : { guidance: settings.guidance }),
    timeoutMs: settings.timeout_ms ?? 90_000,
    maxAttempts: settings.max_attempts ?? 3,
    runner: () => createJudgeRunner(runnerOptions),
  });
}

/** Preserve original user turns as authority; tool and assistant turns remain data. */
export function runAuthorizationEvidence(ctx: RunCapabilityContext) {
  return (ctx.request?.messages ?? []).map((message) => ({
    role:
      message.role === "user"
        ? ("user" as const)
        : message.role === "system"
          ? ("host" as const)
          : ("assistant" as const),
    content: contentToText(message.content),
  }));
}
