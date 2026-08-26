import { describe, expect, it } from "bun:test";
import type {
  LLMCallParams,
  LLMCallResult,
  LLMProvider,
  Logger,
  RunRequest,
} from "@clarvis/capability";
import {
  generateWorkflowTitle,
  WORKFLOW_TITLE_TIMEOUT_MS,
} from "../../src/workflows/workflow-title.ts";

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    messages: [
      { role: "user", content: "old task" },
      { role: "assistant", content: "acknowledged" },
      { role: "user", content: "Implementar títulos curtos nos workflows" },
    ],
    servers: [],
    profiles: [{ name: "manager", model: "anthropic/claude", tools: [] }],
    entry: "manager",
    budget: { on_exceed: "stop" },
    providers: [{ name: "anthropic", kind: "anthropic" }],
    ...overrides,
  };
}

function provider(result: LLMCallResult | Error): { llm: LLMProvider; calls: LLMCallParams[] } {
  const calls: LLMCallParams[] = [];
  return {
    calls,
    llm: {
      call: async (params) => {
        calls.push(params);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cache_write_tokens: 0,
};

describe("generateWorkflowTitle", () => {
  it("uses the manager model and latest user task in a forced, bounded metadata call", async () => {
    const fake = provider({
      toolCalls: [
        {
          id: "title",
          name: "set_title",
          arguments: { title: "  Implementar   títulos curtos  " },
        },
      ],
      usage: ZERO_USAGE,
    });
    const signal = new AbortController().signal;

    await expect(
      generateWorkflowTitle({ request: request(), llm: fake.llm, signal }),
    ).resolves.toBe("Implementar títulos curtos");

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.model).toBe("claude");
    expect(call.provider).toBe("anthropic");
    expect(call.messages.at(-1)).toEqual({
      role: "user",
      content: "Implementar títulos curtos nos workflows",
    });
    expect(call.tools?.map((tool) => tool.wireName)).toEqual(["set_title"]);
    expect(call.toolChoice).toEqual({ type: "function", function: { name: "set_title" } });
    expect(call.reasoningEffort).toBe("off");
    expect(call.maxOutputTokens).toBe(64);
    expect(call.timeoutMs).toBe(WORKFLOW_TITLE_TIMEOUT_MS);
    expect(call.maxRetries).toBe(0);
    expect(call.signal).toBe(signal);
  });

  it("keeps the provisional title when the call fails or returns malformed metadata", async () => {
    for (const result of [
      new Error("provider unavailable"),
      { toolCalls: [], usage: ZERO_USAGE },
      {
        toolCalls: [{ id: "title", name: "set_title", arguments: { title: "line one\nline two" } }],
        usage: ZERO_USAGE,
      },
      {
        toolCalls: [{ id: "title", name: "set_title", arguments: { title: "x".repeat(61) } }],
        usage: ZERO_USAGE,
      },
    ] satisfies Array<LLMCallResult | Error>) {
      const fake = provider(result);
      await expect(
        generateWorkflowTitle({ request: request(), llm: fake.llm }),
      ).resolves.toBeNull();
    }
  });

  it("accepts provider JSON arguments and rejects malformed JSON", async () => {
    const valid = provider({
      toolCalls: [
        {
          id: "title",
          name: "set_title",
          arguments: JSON.stringify({ title: "Implementar titulo serializado" }),
        },
      ],
      usage: ZERO_USAGE,
    });
    await expect(generateWorkflowTitle({ request: request(), llm: valid.llm })).resolves.toBe(
      "Implementar titulo serializado",
    );

    const malformed = provider({
      toolCalls: [{ id: "title", name: "set_title", arguments: "{" }],
      usage: ZERO_USAGE,
    });
    await expect(
      generateWorkflowTitle({ request: request(), llm: malformed.llm }),
    ).resolves.toBeNull();
  });

  it("logs and skips generation when the manager provider is unavailable", async () => {
    const warnings: Array<[unknown, string]> = [];
    const logger = {
      warn: (context: unknown, message: string) => warnings.push([context, message]),
    } as unknown as Logger;
    const fake = provider({ usage: ZERO_USAGE });

    await expect(
      generateWorkflowTitle({
        request: request({
          profiles: [{ name: "manager", model: "openai/gpt", tools: [] }],
        }),
        llm: fake.llm,
        logger,
      }),
    ).resolves.toBeNull();

    expect(fake.calls).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toContain("keeping the provisional title");
  });

  it("does not call the provider without a usable entry profile or user task", async () => {
    const fake = provider({ usage: ZERO_USAGE });

    await expect(
      generateWorkflowTitle({ request: request({ entry: "missing" }), llm: fake.llm }),
    ).resolves.toBeNull();
    await expect(
      generateWorkflowTitle({
        request: request({ messages: [{ role: "assistant", content: "no task" }] }),
        llm: fake.llm,
      }),
    ).resolves.toBeNull();
    expect(fake.calls).toEqual([]);
  });
});
