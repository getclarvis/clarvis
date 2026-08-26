import { describe, it, expect, afterEach, vi } from "../bun-test.ts";
import { AiSdkAdapter } from "@clarvis/llm/adapter";
import { mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

const BASE = "http://localhost:11434/v1";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const okCompletion = {
  choices: [{ message: { content: "ok, no auth needed" } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
};

describe("no API key required for unauthenticated endpoints", () => {
  it("completes against an endpoint that rejects any Authorization header (no key configured)", async () => {
    let sawAuthHeader = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: { headers?: Record<string, string> }) => {
        const headers = init?.headers ?? {};
        const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
        if (hasAuth) {
          sawAuthHeader = true;
          return new Response("auth not accepted", { status: 401 });
        }
        return jsonResponse(okCompletion);
      }),
    );

    harness = await makeHarness({
      llm: new AiSdkAdapter(),
      env: { CLARVIS_STREAM: "false" },
      mcpFactory: mockMCPFactory({}),
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      entry: "solo",
      providers: [{ name: "openai-compatible", kind: "openai-compatible", base_url: BASE }],
      profiles: [
        { name: "solo", model: "openai-compatible/local-model", tools: [], iteration_limit: 5 },
      ],
      budget: { on_exceed: "stop", total_token_limit: 1000 },
    });

    expect(res).toMatchObject({ status: "completed", result: "ok, no auth needed" });
    expect(sawAuthHeader).toBe(false);
  });
});
