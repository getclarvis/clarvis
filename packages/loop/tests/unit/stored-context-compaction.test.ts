import { expect, test } from "../bun-test.ts";
import { loadEnv, type ContextSnapshotEntry, type RunRequest } from "@clarvis/capability";
import { MockLLM } from "../../src/testing/mock-llm.ts";
import {
  compactStoredContext,
  estimateStoredContextTokens,
  fitStoredContextToWindow,
} from "../../src/runtime/context/stored-context-compaction.ts";

const REQUEST = {
  messages: [{ role: "user", content: "continue" }],
  servers: [],
  profiles: [
    {
      name: "solo",
      model: "anthropic/x",
      tools: [],
      iteration_limit: 3,
      compaction: {
        enabled: true,
        context_fraction: 0.8,
        target_fraction: 0.5,
        preserve_recent_tokens: 0,
      },
    },
  ],
  entry: "solo",
  providers: [
    {
      name: "anthropic",
      kind: "anthropic",
      models: { x: { context_window_tokens: 1000 } },
    },
  ],
  budget: { on_exceed: "stop", total_token_limit: 10000 },
} satisfies RunRequest;

const CONTEXT: ContextSnapshotEntry[] = Array.from({ length: 8 }, (_, index) => ({
  message: {
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `turn ${index}: ${"x".repeat(700)}`,
  },
  evictable: true,
  summary: false,
  canonical: false,
}));

test("settled compaction uses user guidance and returns a smaller replacement snapshot", async () => {
  const llm = new MockLLM({
    script: [{ text: "Keep the auth decision and current failing test." }],
  });
  const result = await compactStoredContext({
    context: CONTEXT,
    request: REQUEST,
    guidance: "preserve auth decisions",
    env: loadEnv({}),
    llm,
  });
  expect(result.status).toBe("compacted");
  if (result.status !== "compacted") return;
  expect(estimateStoredContextTokens(result.context)).toBeLessThan(
    estimateStoredContextTokens(CONTEXT),
  );
  expect(JSON.stringify(llm.calls[0]?.messages)).toContain("preserve auth decisions");
  expect(JSON.stringify(result.context)).toContain("Keep the auth decision");
});

test("smaller-model fitting is mechanical and reaches the target high-water mark", () => {
  const env = loadEnv({ CLARVIS_DEFAULT_COMPACTION_PRESERVE_RECENT_TOKENS: "0" });
  const opaqueTail: ContextSnapshotEntry = {
    message: {
      role: "assistant",
      content: "latest answer",
      reasoning: [
        {
          text: "latest reasoning",
          providerOptions: {
            openai: { itemId: "rs_latest", reasoningEncryptedContent: "cipher_latest" },
          },
        },
      ],
      text_parts: [
        {
          text: "latest answer",
          phase: "final_answer",
          providerOptions: { openai: { itemId: "msg_latest" } },
        },
      ],
    },
    evictable: false,
    summary: false,
    canonical: true,
  };
  const result = fitStoredContextToWindow([...CONTEXT, opaqueTail], 1000, env);
  expect(result.status).toBe("compacted");
  if (result.status !== "compacted") return;
  expect(estimateStoredContextTokens(result.context)).toBeLessThanOrEqual(800);
  expect(result.freedChars).toBeGreaterThan(0);
  expect(result.context.at(-1)).toEqual(opaqueTail);
});
