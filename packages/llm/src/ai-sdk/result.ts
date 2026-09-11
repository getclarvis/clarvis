import type { LanguageModelUsage, ModelMessage } from "ai";
import type {
  AssistantMessagePhase,
  AssistantReasoningPart,
  AssistantTextPart,
  LLMCallResult,
  LLMUsage,
} from "@clarvis/capability";
import { normalizeToolArguments } from "@clarvis/capability";

// Deliberately identifies the control range this boundary strips.
const MODEL_CONTROL_BYTES = new RegExp(
  // eslint-disable-next-line no-control-regex
  "[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F-\\x9F]",
  "g",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * Projects the AI SDK's usage onto our provider-neutral {@link LLMUsage}.
 *
 * @param usage - the SDK's usage object, possibly partial.
 * @returns the four numeric tallies with explicit uncertainty for unreported counters.
 * @remarks `inputTokenDetails` is optional at runtime even though the SDK types
 * declare it required: a provider that answers with a bare
 * `{inputTokens, outputTokens}` — or a test double — would otherwise throw on
 * the property access. That matters more now this is also read on the *failure*
 * path, where the shape is least trustworthy and a throw would replace a real
 * provider error with a `TypeError`.
 */
export function normalizeUsage(usage: Partial<LanguageModelUsage> | undefined): LLMUsage {
  const details = usage?.inputTokenDetails;
  return {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    cached_tokens: details?.cacheReadTokens ?? 0,
    cache_write_tokens: details?.cacheWriteTokens ?? 0,
    ...([usage?.inputTokens, usage?.outputTokens].every(
      (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    )
      ? {}
      : { usage_unknown: true as const }),
    ...(typeof details?.cacheReadTokens === "number" &&
    Number.isSafeInteger(details.cacheReadTokens) &&
    details.cacheReadTokens >= 0
      ? {}
      : { cache_unknown: true as const }),
  };
}

/**
 * Maps the AI SDK's aggregate output (identical shape for `generateText` and a
 * fully-drained `streamText`) into our provider-neutral `LLMCallResult`.
 *
 * @remarks Tool arguments are normalized here, at the one place the SDK's output
 *   becomes an {@link LLMToolCall}, so no downstream layer ever sees a
 *   non-object in `arguments`. That matters beyond dispatch: the assistant turn
 *   is appended to the run context from this same array, and
 *   {@link toModelMessages} forwards `arguments` verbatim as a tool-call
 *   `input`, which `@ai-sdk/openai-compatible` then serializes with
 *   `JSON.stringify`. A raw string therefore comes back **double-encoded** on the
 *   next request, so the model's own history demonstrates the malformed shape
 *   and it reproduces it — the payload is not merely lost once, it is taught.
 *
 *   The SDK cannot catch this itself: `toAiSdkTools` builds each tool with a
 *   bare `jsonSchema(...)` and no `validate`, and `safeValidateTypes`
 *   short-circuits to success whenever `validate` is absent, so tool-input
 *   validation there is a no-op for any value.
 */
export function buildCallResult(raw: {
  text: string;
  toolCalls: ReadonlyArray<{
    toolCallId: string;
    toolName: string;
    input: unknown;
    providerMetadata?: Record<string, Record<string, unknown>>;
  }>;
  usage: LanguageModelUsage;
  reasoningText: string | undefined;
  content?: readonly unknown[];
  response?: { messages?: readonly ModelMessage[] };
  responseMessages?: readonly ModelMessage[];
  finishReason?: string;
}): LLMCallResult {
  const text = normalizeModelText(raw.text);
  const toolCalls = raw.toolCalls.length
    ? raw.toolCalls.map((tc) => {
        const norm = normalizeToolArguments(tc.input);
        return {
          id: tc.toolCallId,
          name: tc.toolName,
          arguments: norm.ok ? norm.args : {},
          ...(tc.providerMetadata === undefined ? {} : { providerOptions: tc.providerMetadata }),
          ...(norm.ok ? {} : { malformedArguments: norm.preview }),
        };
      })
    : undefined;
  const reasoning =
    raw.reasoningText && raw.reasoningText.length > 0 ? raw.reasoningText : undefined;
  const responseMessages = raw.response?.messages ?? raw.responseMessages;
  const assistantResponse = responseMessages
    ?.slice()
    .reverse()
    .find((message) => message.role === "assistant");
  const aggregateParts = raw.content?.filter(isRecord);
  const reasoningParts: AssistantReasoningPart[] | undefined =
    assistantResponse !== undefined && Array.isArray(assistantResponse.content)
      ? assistantResponse.content.flatMap((part) =>
          part.type === "reasoning"
            ? [
                {
                  text: part.text,
                  ...(part.providerOptions !== undefined
                    ? { providerOptions: part.providerOptions }
                    : {}),
                },
              ]
            : [],
        )
      : undefined;
  const responseTextParts =
    assistantResponse !== undefined && Array.isArray(assistantResponse.content)
      ? assistantResponse.content.flatMap((part) =>
          part.type === "text"
            ? [
                {
                  type: part.type,
                  text: part.text,
                  providerOptions: part.providerOptions,
                },
              ]
            : [],
        )
      : undefined;
  const textParts: AssistantTextPart[] | undefined = (
    responseTextParts ??
    aggregateParts?.flatMap((part) =>
      part.type === "text" && typeof part.text === "string"
        ? [
            {
              type: "text" as const,
              text: part.text,
              providerOptions:
                part.providerMetadata !== null && typeof part.providerMetadata === "object"
                  ? (part.providerMetadata as Record<string, Record<string, unknown>>)
                  : undefined,
            },
          ]
        : [],
    )
  )?.flatMap((part) => {
    const partText = normalizeModelText(part.text);
    if (partText === undefined) return [];
    const phaseValue = part.providerOptions?.openai?.phase;
    const phase: AssistantMessagePhase | undefined =
      phaseValue === "commentary" || phaseValue === "final_answer" ? phaseValue : undefined;
    return [
      {
        text: partText,
        ...(phase !== undefined ? { phase } : {}),
        ...(part.providerOptions !== undefined ? { providerOptions: part.providerOptions } : {}),
      },
    ];
  });
  return {
    ...(text !== undefined ? { text } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    usage: normalizeUsage(raw.usage),
    cacheUsageKnown: [
      raw.usage.inputTokens,
      raw.usage.outputTokens,
      raw.usage.inputTokenDetails?.cacheReadTokens,
    ].every((value) => typeof value === "number" && Number.isFinite(value)),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(reasoningParts !== undefined && reasoningParts.length > 0 ? { reasoningParts } : {}),
    ...(textParts !== undefined && textParts.length > 0 ? { textParts } : {}),
    ...(raw.finishReason !== undefined ? { finishReason: raw.finishReason } : {}),
  };
}

/**
 * Strips disallowed control characters from model text and collapses empty
 * output to `undefined`.
 *
 * @param raw - the model's raw text output.
 * @returns the text with C0/C1 control characters removed (keeping tab, newline,
 *   and carriage return), or `undefined` when nothing but whitespace remains.
 * @remarks Guards the UI and downstream parsers from stray control bytes a model
 *   occasionally emits; the un-trimmed cleaned text is preserved on success —
 *   only the emptiness check trims.
 */
export function normalizeModelText(raw: string): string | undefined {
  // A codepoint array makes a large response vastly larger than its source
  // string (one JS slot per character). A single linear replacement keeps the
  // peak proportional to the provider's bounded response body.
  const stripped = raw.replace(MODEL_CONTROL_BYTES, "");
  return stripped.trim().length > 0 ? stripped : undefined;
}
