import { describe, it, expect, vi } from "../bun-test.ts";
import { mockConnections, mockMCPFactory } from "./_fixtures.ts";
import { makeTestTraceStore } from "../contract/_helpers.ts";
import { loadEnv } from "@clarvis/capability";
import { executeRun, type ExecuteRunDeps } from "../../src/runtime/execute-run.ts";

function depsWith(): { deps: ExecuteRunDeps; llmCall: ReturnType<typeof vi.fn> } {
  const llmCall = vi.fn(async () => ({
    usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
  }));
  return {
    llmCall,
    deps: {
      env: loadEnv({}),
      llm: { call: llmCall },
      connections: mockConnections(mockMCPFactory({})),
      traceStore: makeTestTraceStore(),
      workspaceRoot: process.cwd(),
    },
  };
}

function bodyFor(model: string, providers?: unknown): Record<string, unknown> {
  return {
    messages: [{ role: "user", content: "hi" }],
    servers: [],
    profiles: [{ name: "solo", model, tools: [], iteration_limit: 5 }],
    entry: "solo",
    budget: { on_exceed: "stop", total_token_limit: 1000 },
    ...(providers !== undefined ? { providers } : {}),
  };
}

describe("reject unknown_provider", () => {
  it("rejects when providers[] omits the model's provider token", async () => {
    const { deps, llmCall } = depsWith();

    await expect(
      executeRun({
        rawBody: bodyFor("google/gemini-2.5-pro", [{ name: "anthropic", kind: "anthropic" }]),
        owner: "test",
        deps,
      }),
    ).rejects.toMatchObject({
      code: "unknown_provider",
      details: { provider: "google" },
    });
    expect(llmCall).not.toHaveBeenCalled();
  });

  it("rejects an openai-compatible model token that is not declared in providers[]", async () => {
    const { deps, llmCall } = depsWith();

    await expect(
      executeRun({
        rawBody: bodyFor("openai-compatible/test-model", [
          { name: "anthropic", kind: "anthropic" },
        ]),
        owner: "test",
        deps,
      }),
    ).rejects.toMatchObject({
      code: "unknown_provider",
      details: { provider: "openai-compatible" },
    });
    expect(llmCall).not.toHaveBeenCalled();
  });
});

describe("reject invalid_provider_config before any model call", () => {
  it("rejects when providers[] is absent (now a required field)", async () => {
    const { deps, llmCall } = depsWith();

    await expect(
      executeRun({ rawBody: bodyFor("google/gemini-2.5-pro"), owner: "test", deps }),
    ).rejects.toMatchObject({
      code: "invalid_provider_config",
    });
    expect(llmCall).not.toHaveBeenCalled();
  });

  it("rejects a malformed base_url on an openai-compatible provider", async () => {
    const { deps, llmCall } = depsWith();

    await expect(
      executeRun({
        rawBody: bodyFor("oc/test-model", [
          { name: "oc", kind: "openai-compatible", base_url: "api.openai.com/v1" },
        ]),
        owner: "test",
        deps,
      }),
    ).rejects.toMatchObject({
      code: "invalid_provider_config",
      details: { name: "oc", reason: "malformed_base_url" },
    });
    expect(llmCall).not.toHaveBeenCalled();
  });

  it("rejects a malformed base_url on a first-party kind (validated for all kinds)", async () => {
    const { deps, llmCall } = depsWith();

    await expect(
      executeRun({
        rawBody: bodyFor("oai/gpt-4", [
          { name: "oai", kind: "openai", base_url: "not a url", api_key_env: "OPENAI_API_KEY" },
        ]),
        owner: "test",
        deps,
      }),
    ).rejects.toMatchObject({
      code: "invalid_provider_config",
      details: { name: "oai", reason: "malformed_base_url" },
    });
    expect(llmCall).not.toHaveBeenCalled();
  });
});
