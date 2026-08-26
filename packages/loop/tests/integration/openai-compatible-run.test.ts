import { describe, it, expect, afterEach, vi } from "../bun-test.ts";
import { AiSdkAdapter } from "@clarvis/llm/adapter";
import { mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

const BASE = "http://localhost:11434/v1";
const PROVIDERS = [{ name: "openai-compatible", kind: "openai-compatible", base_url: BASE }];

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
  vi.unstubAllGlobals();
});

interface Captured {
  url: string;
  body: {
    model: string;
    messages: unknown[];
    tools?: Array<{ function: { name: string } }>;
    usage?: unknown;
    prompt_cache_key?: unknown;
  };
}

function stubFetch(responder: (c: Captured, n: number) => Response): { calls: Captured[] } {
  const calls: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: { body?: string }) => {
      const captured: Captured = { url: String(url), body: JSON.parse(init?.body ?? "{}") };
      calls.push(captured);
      return responder(captured, calls.length);
    }),
  );
  return { calls };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function completion(opts: {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
}): unknown {
  return {
    choices: [
      {
        message: {
          content: opts.content ?? null,
          ...(opts.toolCalls
            ? {
                tool_calls: opts.toolCalls.map((t) => ({
                  id: t.id,
                  type: "function",
                  function: { name: t.name, arguments: t.args },
                })),
              }
            : {}),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
  };
}

describe("run a model behind an openai-compatible endpoint", () => {
  it("routes to <base>/chat/completions and completes with the endpoint's answer", async () => {
    const { calls } = stubFetch(() =>
      jsonResponse(completion({ content: "Hello from the endpoint." })),
    );
    harness = await makeHarness({
      llm: new AiSdkAdapter(),
      env: { CLARVIS_STREAM: "false" },
      mcpFactory: mockMCPFactory({}),
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "Say hi" }],
      servers: [],
      profiles: [
        { name: "solo", model: "openai-compatible/acme/test-model", tools: [], iteration_limit: 5 },
      ],
      entry: "solo",
      providers: PROVIDERS,
      budget: { on_exceed: "stop", total_token_limit: 1000 },
    });

    expect(res).toMatchObject({ status: "completed", result: "Hello from the endpoint." });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/chat/completions`);
    expect(calls[0]!.body.model).toBe("acme/test-model");

    const detail = await harness.getRun(res.execution_id);
    expect(detail).not.toBeNull();
    expect(detail!.request.profiles[0]!.model).toBe("openai-compatible/acme/test-model");
    expect(detail!.trace.events.some((e) => e.type === "subagent_iteration")).toBe(true);
    expect(JSON.stringify(detail!.request.providers)).toContain("11434");
    expect(JSON.stringify(detail!.trace)).not.toContain("11434");
    expect(JSON.stringify(detail!.response)).not.toContain("11434");
  });

  it("dispatches tool_calls through the endpoint and feeds results back", async () => {
    const { calls } = stubFetch((captured, n) => {
      if (n === 1) {
        const wireName = captured.body.tools![0]!.function.name;
        return jsonResponse(
          completion({
            toolCalls: [
              { id: "call_1", name: wireName, args: JSON.stringify({ path: "/etc/hostname" }) },
            ],
          }),
        );
      }
      return jsonResponse(completion({ content: "The hostname is my-host." }));
    });

    harness = await makeHarness({
      llm: new AiSdkAdapter(),
      env: { CLARVIS_STREAM: "false" },
      mcpFactory: mockMCPFactory({
        filesystem: {
          tools: [
            {
              name: "read",
              inputSchema: { type: "object", properties: { path: { type: "string" } } },
              call: () => "my-host\n",
            },
          ],
        },
      }),
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "Read /etc/hostname" }],
      servers: [{ name: "filesystem", transport: "stdio", command: "node", args: ["-e", ""] }],
      profiles: [
        {
          name: "solo",
          model: "openai-compatible/test-model",
          tools: ["filesystem.read"],
          iteration_limit: 5,
        },
      ],
      entry: "solo",
      providers: PROVIDERS,
      budget: { on_exceed: "stop", total_token_limit: 10000 },
    });

    expect(res).toMatchObject({ status: "completed", result: "The hostname is my-host." });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.tools?.[0]!.function.name).toBeTruthy();
  });

  it("requests usage accounting and forwards prompt_cache_key from the run request", async () => {
    const { calls } = stubFetch(() => jsonResponse(completion({ content: "ok" })));
    harness = await makeHarness({
      llm: new AiSdkAdapter(),
      env: { CLARVIS_STREAM: "false" },
      mcpFactory: mockMCPFactory({}),
    });

    await harness.run({
      prompt_cache_key: "conversation-42",
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      profiles: [
        { name: "solo", model: "openai-compatible/test-model", tools: [], iteration_limit: 3 },
      ],
      entry: "solo",
      providers: PROVIDERS,
      budget: { on_exceed: "stop", total_token_limit: 1000 },
    });

    expect(calls[0]!.body.usage).toEqual({ include: true });
    expect(calls[0]!.body.prompt_cache_key).toBe("conversation-42");
  });

  it("defaults prompt_cache_key to the run's execution_id when the request omits it", async () => {
    const { calls } = stubFetch(() => jsonResponse(completion({ content: "ok" })));
    harness = await makeHarness({
      llm: new AiSdkAdapter(),
      env: { CLARVIS_STREAM: "false" },
      mcpFactory: mockMCPFactory({}),
    });

    const res = await harness.run({
      execution_id: "exec_fixed_1",
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      profiles: [
        { name: "solo", model: "openai-compatible/test-model", tools: [], iteration_limit: 3 },
      ],
      entry: "solo",
      providers: PROVIDERS,
      budget: { on_exceed: "stop", total_token_limit: 1000 },
    });

    expect(res.execution_id).toBe("exec_fixed_1");
    expect(calls[0]!.body.prompt_cache_key).toBe("exec_fixed_1");
  });

  it("proceeds on text when the endpoint ignores supplied tools", async () => {
    stubFetch(() => jsonResponse(completion({ content: "Plain answer, no tools used." })));
    harness = await makeHarness({
      llm: new AiSdkAdapter(),
      env: { CLARVIS_STREAM: "false" },
      mcpFactory: mockMCPFactory({
        filesystem: {
          tools: [{ name: "read", inputSchema: { type: "object" }, call: () => "x" }],
        },
      }),
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [{ name: "filesystem", transport: "stdio", command: "node", args: ["-e", ""] }],
      profiles: [
        {
          name: "solo",
          model: "openai-compatible/test-model",
          tools: ["filesystem.read"],
          iteration_limit: 5,
        },
      ],
      entry: "solo",
      providers: PROVIDERS,
      budget: { on_exceed: "stop", total_token_limit: 1000 },
    });

    expect(res).toMatchObject({ status: "completed", result: "Plain answer, no tools used." });
  });
});

describe("reasoning capture end-to-end", () => {
  it("emits a model_reasoning trace event when the endpoint returns reasoning_content", async () => {
    stubFetch(() =>
      jsonResponse({
        choices: [
          {
            message: { content: "42.", reasoning_content: "I multiplied 6 by 7." },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      }),
    );
    harness = await makeHarness({
      llm: new AiSdkAdapter(),
      env: { CLARVIS_STREAM: "false" },
      mcpFactory: mockMCPFactory({}),
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "what is 6 times 7?" }],
      servers: [],
      profiles: [
        { name: "solo", model: "openai-compatible/reasoner", tools: [], iteration_limit: 3 },
      ],
      entry: "solo",
      providers: PROVIDERS,
      budget: { on_exceed: "stop", total_token_limit: 1000 },
    });

    expect(res).toMatchObject({ status: "completed", result: "42." });
    const detail = await harness.getRun(res.execution_id);
    const reasoning = detail!.trace.events.filter((e) => e.type === "model_reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({ agent: "subagent", text: "I multiplied 6 by 7." });
    expect((reasoning[0] as { model: string }).model).toContain("reasoner");
  });

  it("replays reasoning_content through the full loop on the next tool iteration", async () => {
    const { calls } = stubFetch((_captured, n) =>
      jsonResponse(
        n === 1
          ? {
              choices: [
                {
                  message: {
                    content: null,
                    reasoning_content: "I should inspect the file.",
                    tool_calls: [
                      {
                        id: "call_read",
                        type: "function",
                        function: { name: "filesystem_read", arguments: '{"path":"/x"}' },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: { prompt_tokens: 4, completion_tokens: 2 },
            }
          : completion({ content: "done" }),
      ),
    );
    harness = await makeHarness({
      llm: new AiSdkAdapter(),
      env: { CLARVIS_STREAM: "false" },
      mcpFactory: mockMCPFactory({
        filesystem: {
          tools: [{ name: "read", inputSchema: { type: "object" }, call: () => "contents" }],
        },
      }),
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "inspect /x" }],
      servers: [{ name: "filesystem", transport: "stdio", command: "node", args: ["-e", ""] }],
      profiles: [
        {
          name: "solo",
          model: "openai-compatible/reasoner",
          tools: ["filesystem.read"],
          iteration_limit: 3,
        },
      ],
      entry: "solo",
      providers: PROVIDERS,
      budget: { on_exceed: "stop", total_token_limit: 1000 },
    });

    expect(res).toMatchObject({ status: "completed", result: "done" });
    const secondMessages = calls[1]!.body.messages as Array<Record<string, unknown>>;
    expect(secondMessages.find((message) => message.role === "assistant")).toMatchObject({
      reasoning_content: "I should inspect the file.",
    });
    const stored = harness.traceStore.getById("test", res.execution_id)!;
    expect(
      stored.final_context?.some(
        (entry) =>
          entry.message.role === "assistant" &&
          "reasoning" in entry.message &&
          entry.message.reasoning?.[0]?.text === "I should inspect the file.",
      ),
    ).toBe(true);
  });
});
