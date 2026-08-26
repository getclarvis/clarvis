/**
 * `@clarvis/llm` — the provider layer: the Vercel AI SDK backend behind
 * `@clarvis/capability`'s {@link LLMProvider} port, its retry/logging/prompt-cache
 * decorators, the error classifier, and message conversion.
 *
 * @remarks This entry deliberately does **not** re-export the adapter. Doing so
 * would statically pull `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`
 * and `@ai-sdk/openai-compatible` into every consumer that only wanted a
 * decorator, which is exactly the cost {@link createAiSdkProvider} exists to
 * defer. A caller that genuinely wants the adapter itself imports
 * `@clarvis/llm/adapter` and pays for it on purpose.
 * `packages/llm/tests/architecture/lazy-entry.test.ts` is what keeps that true.
 */

export { createAiSdkProvider, type AiSdkProviderOptions } from "./lazy.ts";
export * from "./classify-provider-error.ts";
export * from "./logging-llm-provider.ts";
export * from "./model-call-admission.ts";
export * from "./prompt-cache-provider.ts";
export * from "./retry-llm-provider.ts";
export * from "./to-model-messages.ts";
