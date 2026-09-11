import type { createOpenAICompatible } from "@ai-sdk/openai-compatible";

type UsageConverter = NonNullable<Parameters<typeof createOpenAICompatible>[0]["convertUsage"]>;

/** Preserve absent provider counters before the SDK's default compatible conversion zero-fills them. */
export const convertCompatibleUsage: UsageConverter = (usage) => {
  const input = usage?.prompt_tokens ?? undefined;
  const output = usage?.completion_tokens ?? undefined;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? undefined;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? undefined;
  return {
    inputTokens: {
      total: input,
      noCache: input === undefined || cached === undefined ? undefined : input - cached,
      cacheRead: cached,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: output,
      text: output === undefined || reasoning === undefined ? undefined : output - reasoning,
      reasoning,
    },
    raw:
      usage == null
        ? undefined
        : {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            prompt_tokens_details: usage.prompt_tokens_details,
            completion_tokens_details: usage.completion_tokens_details,
          },
  };
};
