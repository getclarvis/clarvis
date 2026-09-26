import type {
  LLMProvider,
  LiveMessage,
  ModelExecutionInfo,
  ResolvedProviderConfig,
} from "@clarvis/capability";
import { parseAssessment } from "./assessment.ts";
import { JUDGE_POLICY } from "./policy.ts";
import { reviewPayload } from "./prompt.ts";
import { reviewDeadline } from "./retry.ts";
import type { ReviewInput, ReviewResult, ReviewRunner } from "./types.ts";

export interface JudgeOptions {
  readonly llm: LLMProvider;
  readonly model: ModelExecutionInfo;
  readonly providerConfig?: ResolvedProviderConfig;
  readonly runner?: () => ReviewRunner;
  readonly guidance?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly maxPayloadCharacters?: number;
}

/** Review a current action without caching a previous model verdict. */
export function createJudgeService(options: JudgeOptions): {
  review(input: ReviewInput, signal?: AbortSignal): Promise<ReviewResult>;
} {
  return {
    async review(input, signal) {
      const payload = reviewPayload(
        input,
        options.maxPayloadCharacters ?? Math.max(4096, options.model.contextWindowTokens * 3),
      );
      if (payload === undefined) return { kind: "context_overflow" };
      const deadline = reviewDeadline(options.timeoutMs ?? 90_000, signal);
      let runner: ReviewRunner | undefined;
      try {
        runner = options.runner?.();
        const messages: LiveMessage[] = [
          { role: "system", content: `${JUDGE_POLICY}\n${options.guidance ?? ""}` },
          { role: "user", content: payload },
        ];
        let inspections = 0;
        for (let attempt = 0; attempt < (options.maxAttempts ?? 3); attempt++) {
          if (deadline.signal.aborted)
            return signal?.aborted
              ? { kind: "cancelled" }
              : { kind: "technical_failure", reason: "deadline_exceeded" };
          try {
            const result = await options.llm.call({
              callPurpose: "generation",
              executionId: input.action.identity.executionId,
              provider: options.model.provider,
              model: options.model.model,
              ...(options.providerConfig === undefined
                ? {}
                : { providerConfig: options.providerConfig }),
              capabilities: new Set(options.model.capabilities ?? []),
              signal: deadline.signal,
              timeoutMs: deadline.remaining(),
              maxRetries: 0,
              maxOutputTokens: Math.min(options.model.maxOutputTokens ?? 512, 512),
              reasoningEffort: options.model.reasoningEfforts?.includes("low") ? "low" : undefined,
              messages,
              tools: [...(runner?.tools ?? [])],
            });
            if (deadline.signal.aborted)
              return signal?.aborted
                ? { kind: "cancelled" }
                : { kind: "technical_failure", reason: "deadline_exceeded" };
            if (result.toolCalls?.length) {
              if (!runner || inspections + result.toolCalls.length > 8)
                return { kind: "technical_failure", reason: "inspection_limit" };
              messages.push({
                role: "assistant",
                content: result.text ?? "",
                tool_calls: result.toolCalls.map((call) => ({
                  id: call.id,
                  name: call.name,
                  arguments: call.arguments,
                })),
              });
              for (const call of result.toolCalls) {
                inspections++;
                const args =
                  typeof call.arguments === "object" &&
                  call.arguments !== null &&
                  !Array.isArray(call.arguments)
                    ? (call.arguments as Record<string, unknown>)
                    : {};
                const output = await runner.run(call.name, args, deadline.signal);
                if (deadline.signal.aborted)
                  return signal?.aborted
                    ? { kind: "cancelled" }
                    : { kind: "technical_failure", reason: "deadline_exceeded" };
                messages.push({
                  role: "tool",
                  content: output.text,
                  tool_call_id: call.id,
                  ...(output.images ? { images: output.images } : {}),
                });
              }
              attempt--;
              continue;
            }
            const assessment = parseAssessment(result.text ?? "");
            if (assessment) return { kind: "assessment", assessment };
            messages.push({ role: "assistant", content: result.text ?? "" });
            messages.push({ role: "user", content: "Return a valid assessment JSON object." });
          } catch {
            if (deadline.signal.aborted) break;
          }
        }
        return signal?.aborted
          ? { kind: "cancelled" }
          : {
              kind: "technical_failure",
              reason: deadline.signal.aborted ? "deadline_exceeded" : "review_failed",
            };
      } catch {
        return signal?.aborted
          ? { kind: "cancelled" }
          : { kind: "technical_failure", reason: "inspection_failed" };
      } finally {
        deadline.close();
        await runner?.close();
      }
    },
  };
}
