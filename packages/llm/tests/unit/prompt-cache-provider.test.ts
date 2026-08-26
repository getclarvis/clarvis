import { describe, it, expect } from "../helpers/bun-test.ts";
import { withPromptCacheDefaults } from "../../src/prompt-cache-provider.ts";
import type { LLMCallParams, LLMCallResult, LLMProvider } from "@clarvis/capability";

function captureProvider(): { provider: LLMProvider; seen: LLMCallParams[] } {
  const seen: LLMCallParams[] = [];
  const provider: LLMProvider = {
    async call(params: LLMCallParams): Promise<LLMCallResult> {
      seen.push(params);
      return {
        usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
      };
    },
  };
  return { provider, seen };
}

function params(over: Partial<LLMCallParams> = {}): LLMCallParams {
  return {
    provider: "openai-compatible",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    ...over,
  };
}

const RUN_DEFAULTS = { promptCacheKey: "sess-1", promptCacheTtl: "1h" } as const;

describe("withPromptCacheDefaults", () => {
  it("injects both run defaults when the call carries neither", async () => {
    const { provider, seen } = captureProvider();
    await withPromptCacheDefaults(provider, RUN_DEFAULTS).call(params());
    expect(seen[0]!.promptCacheKey).toBe("sess-1");
    expect(seen[0]!.promptCacheTtl).toBe("1h");
  });

  // The two default independently. Sub-agent and compaction calls pin their own
  // key and flow through this same decorator; defaulting as a unit would drop
  // the run's TTL for every one of them.
  it("keeps a per-call key while still applying the run TTL", async () => {
    const { provider, seen } = captureProvider();
    await withPromptCacheDefaults(provider, RUN_DEFAULTS).call(
      params({ promptCacheKey: "explicit" }),
    );
    expect(seen[0]!.promptCacheKey).toBe("explicit");
    expect(seen[0]!.promptCacheTtl).toBe("1h");
  });

  it("keeps a per-call TTL while still applying the run key", async () => {
    const { provider, seen } = captureProvider();
    await withPromptCacheDefaults(provider, RUN_DEFAULTS).call(params({ promptCacheTtl: "5m" }));
    expect(seen[0]!.promptCacheKey).toBe("sess-1");
    expect(seen[0]!.promptCacheTtl).toBe("5m");
  });

  it("leaves both alone when the call pins them itself", async () => {
    const { provider, seen } = captureProvider();
    await withPromptCacheDefaults(provider, RUN_DEFAULTS).call(
      params({ promptCacheKey: "explicit", promptCacheTtl: "5m" }),
    );
    expect(seen[0]!.promptCacheKey).toBe("explicit");
    expect(seen[0]!.promptCacheTtl).toBe("5m");
  });
});
