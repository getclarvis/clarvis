import { describe, it, expect, afterEach, vi } from "../helpers/bun-test.ts";
import { createAiSdkProvider } from "@clarvis/llm";
import type { LLMCallParams } from "@clarvis/capability";

const BASE = "http://endpoint.local/v1";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Captured {
  url: string;
  authorization: string | null;
}

function stubFetch(): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown, init: { headers?: Record<string, string> }) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  return calls;
}

function params(): LLMCallParams {
  return {
    provider: "openai-compatible",
    providerConfig: { kind: "openai-compatible", baseUrl: BASE, apiKeyEnv: "SOME_KEY_ENV" },
    model: "deepseek-ai/DeepSeek-V4-Pro",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  };
}

describe("createAiSdkProvider", () => {
  it("builds nothing until the first call", () => {
    const resolveRegistryKey = vi.fn(() => "sk-test-value");
    createAiSdkProvider({ resolveRegistryKey });
    expect(resolveRegistryKey).not.toHaveBeenCalled();
  });

  it("answers through the lazily built adapter and threads its credential resolver", async () => {
    const calls = stubFetch();
    const resolveRegistryKey = vi.fn(() => "sk-threaded-value");
    const provider = createAiSdkProvider({ resolveRegistryKey });

    const result = await provider.call(params());

    expect(result.text).toBe("ok");
    expect(calls[0]!.url).toStartWith(BASE);
    expect(resolveRegistryKey).toHaveBeenCalledWith("SOME_KEY_ENV");
    expect(calls[0]!.authorization).toBe("Bearer sk-threaded-value");
  });
});
