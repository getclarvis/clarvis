import { describe, expect, it, vi } from "bun:test";
import type {
  LLMCallParams,
  LLMCallResult,
  LLMProvider,
  LiveMessage,
  Logger,
  RunRequest,
} from "@clarvis/capability";
import { contentToText } from "@clarvis/capability";
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

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cache_write_tokens: 0,
};

const title = (value: unknown, id = "title"): LLMCallResult => ({
  toolCalls: [{ id, name: "set_title", arguments: { title: value } }],
  usage: ZERO_USAGE,
});

/** A provider that answers one scripted result per call and refuses to be called again. */
function scriptedProvider(script: Array<LLMCallResult | Error>): {
  llm: LLMProvider;
  calls: LLMCallParams[];
} {
  const calls: LLMCallParams[] = [];
  return {
    calls,
    llm: {
      call: async (params) => {
        calls.push({ ...params, messages: structuredClone(params.messages) });
        const next = script[calls.length - 1];
        if (next === undefined)
          throw new Error(`unexpected provider call #${String(calls.length)}`);
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

/** A provider that answers every call with the same result. */
function provider(result: LLMCallResult | Error): { llm: LLMProvider; calls: LLMCallParams[] } {
  return scriptedProvider([result, result, result]);
}

function textsOf(messages: readonly LiveMessage[]): string[] {
  return messages.map((message) => contentToText(message.content));
}

function warnings(): { logger: Logger; lines: Array<[unknown, string]> } {
  const lines: Array<[unknown, string]> = [];
  return {
    lines,
    logger: {
      warn: (context: unknown, message: string) => lines.push([context, message]),
    } as unknown as Logger,
  };
}

describe("generateWorkflowTitle", () => {
  it("exposes the catalog instead of forcing the title tool, and accepts one valid call", async () => {
    const fake = provider(title("  Implementar   títulos curtos  "));
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
    expect(call.toolChoice).toBeUndefined();
    expect(call.reasoningEffort).toBe("off");
    expect(call.maxOutputTokens).toBe(64);
    expect(call.maxRetries).toBe(0);
    expect(call.signal).toBe(signal);
    expect(call.timeoutMs).toBeGreaterThan(0);
    expect(call.timeoutMs).toBeLessThanOrEqual(WORKFLOW_TITLE_TIMEOUT_MS);
  });

  it.each([
    ["plain prose", { text: "Implementar títulos curtos", usage: ZERO_USAGE }],
    [
      "a foreign tool",
      { toolCalls: [{ id: "x", name: "read_file", arguments: {} }], usage: ZERO_USAGE },
    ],
    [
      "two set_title calls",
      { toolCalls: [...title("a").toolCalls!, ...title("b").toolCalls!], usage: ZERO_USAGE },
    ],
    [
      "a malformed title",
      {
        toolCalls: [{ id: "t", name: "set_title", arguments: { title: "line one\nline two" } }],
        usage: ZERO_USAGE,
      },
    ],
    [
      "undecodable arguments",
      { toolCalls: [{ id: "t", name: "set_title", arguments: "{" }], usage: ZERO_USAGE },
    ],
  ] satisfies Array<[string, LLMCallResult]>)(
    "corrects %s once, then accepts the valid call",
    async (_label, invalid: LLMCallResult) => {
      const fake = scriptedProvider([invalid, title("Título corrigido")]);

      await expect(generateWorkflowTitle({ request: request(), llm: fake.llm })).resolves.toBe(
        "Título corrigido",
      );

      expect(fake.calls).toHaveLength(2);
      expect(fake.calls.every((call) => call.toolChoice === undefined)).toBe(true);
      expect(fake.calls[1]!.timeoutMs).toBeGreaterThan(0);
      expect(fake.calls[1]!.timeoutMs).toBeLessThanOrEqual(WORKFLOW_TITLE_TIMEOUT_MS);
      expect(fake.calls[1]!.tools).toEqual(fake.calls[0]!.tools);
      const followUp = fake.calls[1]!.messages.slice(fake.calls[0]!.messages.length);
      const calls = invalid.toolCalls ?? [];
      if (calls.length === 0) {
        expect(followUp.map((message) => message.role)).toEqual(["assistant", "user"]);
        expect(textsOf(followUp).join("\n")).toContain("workflow_title:");
        expect(
          followUp.some((message) => message.role === "tool"),
          "a response with no calls has nothing to answer with a tool result",
        ).toBe(false);
        return;
      }
      expect(followUp[0]).toMatchObject({ role: "assistant" });
      const results = followUp.filter((message) => message.role === "tool");
      expect(results.map((message) => message.tool_call_id)).toEqual(
        calls.map((call: { id: string }) => call.id),
      );
      for (const result of results) expect(result.content).toContain("workflow_title:");
    },
  );

  it("keeps the provisional title after two invalid responses, naming the violation", async () => {
    const fake = scriptedProvider([
      { text: "no call at all", usage: ZERO_USAGE },
      { text: "still no call", usage: ZERO_USAGE },
    ]);
    const log = warnings();

    await expect(
      generateWorkflowTitle({ request: request(), llm: fake.llm, logger: log.logger }),
    ).resolves.toBeNull();

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.every((call) => call.toolChoice === undefined)).toBe(true);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]?.[1]).toContain("keeping the provisional title");
    expect(String((log.lines[0]?.[0] as { error?: string }).error)).toContain(
      "call set_title exactly once",
    );
  });

  it("reports a provider failure as such, without a second attempt", async () => {
    const fake = scriptedProvider([new Error("provider unavailable")]);
    const log = warnings();

    await expect(
      generateWorkflowTitle({ request: request(), llm: fake.llm, logger: log.logger }),
    ).resolves.toBeNull();

    expect(fake.calls).toHaveLength(1);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]?.[1]).toContain("generation failed");
    expect(log.lines[0]?.[1]).toContain("keeping the provisional title");
  });

  it("stops before the correction when the run is cancelled", async () => {
    const controller = new AbortController();
    const fake = scriptedProvider([{ text: "no call at all", usage: ZERO_USAGE }]);
    const cancelling: LLMProvider = {
      call: async (params) => {
        const result = await fake.llm.call(params);
        controller.abort();
        return result;
      },
    };

    await expect(
      generateWorkflowTitle({ request: request(), llm: cancelling, signal: controller.signal }),
    ).resolves.toBeNull();

    expect(fake.calls).toHaveLength(1);
  });

  it("does not call the provider at all with an already-aborted signal", async () => {
    const fake = provider(title("unused"));
    const signal = AbortSignal.abort();

    await expect(
      generateWorkflowTitle({ request: request(), llm: fake.llm, signal }),
    ).resolves.toBeNull();

    expect(fake.calls).toEqual([]);
  });

  it("does not spend a second attempt once the wall budget is gone", async () => {
    const fake = scriptedProvider([
      { text: "no call at all", usage: ZERO_USAGE },
      title("too late"),
    ]);
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const budgetBurning: LLMProvider = {
        call: async (params) => {
          const result = await fake.llm.call(params);
          now += WORKFLOW_TITLE_TIMEOUT_MS + 1;
          return result;
        },
      };

      await expect(
        generateWorkflowTitle({ request: request(), llm: budgetBurning }),
      ).resolves.toBeNull();
    } finally {
      clock.mockRestore();
    }

    expect(fake.calls).toHaveLength(1);
  });

  it("logs and skips generation when the manager provider is unavailable", async () => {
    const log = warnings();
    const fake = provider({ usage: ZERO_USAGE });

    await expect(
      generateWorkflowTitle({
        request: request({
          profiles: [{ name: "manager", model: "openai/gpt", tools: [] }],
        }),
        llm: fake.llm,
        logger: log.logger,
      }),
    ).resolves.toBeNull();

    expect(fake.calls).toEqual([]);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]?.[1]).toContain("keeping the provisional title");
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
