import { afterEach, beforeEach, describe, expect, it, vi } from "../helpers/bun-test.ts";
import { generateText as realGenerateText } from "ai";
import { AiSdkAdapter } from "@clarvis/llm/adapter";
import type { LLMCallParams, ResolvedProviderConfig } from "@clarvis/capability";

const mockGenerate = vi.fn();
const BASE = "https://openrouter.test/api/v1";

interface Captured {
  headers: Record<string, string>;
  raw: string;
  body: Record<string, unknown>;
}

function stubFetch(): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: { body?: string; headers?: Record<string, string> }) => {
      const raw = init?.body ?? "{}";
      calls.push({
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        raw,
        body: JSON.parse(raw),
      });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return calls;
}

beforeEach(() => {
  mockGenerate.mockReset();
  mockGenerate.mockImplementation(realGenerateText as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The demo's provider entry, verbatim. */
const CFG: ResolvedProviderConfig = {
  kind: "openai-compatible",
  baseUrl: `${BASE}/`,
  apiKeyEnv: "OPENROUTER_API_KEY",
  promptCache: "implicit",
};

function turn(n: number): LLMCallParams {
  const messages: LLMCallParams["messages"] = [
    { role: "system", content: "you are the coder" },
    { role: "user", content: "build it" },
  ];
  for (let i = 0; i < n; i += 1) {
    messages.push({ role: "assistant", content: `step ${i}` });
    messages.push({ role: "user", content: `Tool 'write_file' result: wrote ${i}` });
  }
  return {
    provider: "openai-compatible",
    providerConfig: CFG,
    model: "deepseek/deepseek-v4-pro-0813",
    messages,
    tools: [],
    cacheBreakpoints: [1, 2 * n + 1].filter((i) => i >= 0),
    promptCacheKey: "01a01ca7-fa59-7e3d-87e7-2fd1a67cb828",
    maxOutputTokens: 128_000 - n,
    maxRetries: 3,
  };
}

describe("what an implicit-cache openai-compatible request actually carries", () => {
  it("keeps the wire prefix byte-identical across turns and sends no markers", async () => {
    process.env.OPENROUTER_API_KEY = "secret";
    const calls = stubFetch();
    const a = new AiSdkAdapter({ generateText: mockGenerate });
    for (const n of [1, 2, 3]) await a.call(turn(n));

    /* Nothing cache-affecting may vary between turns except the appended
       messages. Headers are checked by value, not just by key: a per-request
       header would partition an upstream's cache as effectively as a prompt
       edit, and nothing downstream would report it. */
    expect(new Set(calls.map((c) => JSON.stringify(c.headers))).size).toBe(1);
    expect(new Set(calls.map((c) => c.body.prompt_cache_key)).size).toBe(1);

    /* `implicit` means the provider caches the prefix on its own. Sending a
       breakpoint marker would rewrite the marked message's content into a
       block array — moving the marker each turn then edits the prefix in
       place, which is the opposite of what was asked for. */
    expect(calls.every((c) => !c.raw.includes("cache_control"))).toBe(true);
    expect(calls.every((c) => !c.raw.includes("__clarvis_cache_control"))).toBe(true);

    /* The messages array is the cached prefix: each turn extends the last. */
    const rendered = calls.map((c) => JSON.stringify(c.body.messages));
    for (let i = 1; i < rendered.length; i += 1) {
      expect(rendered[i]!.startsWith(rendered[i - 1]!.slice(0, -1))).toBe(true);
    }

    /* What the request carries at all, so an added top-level field is a
       deliberate change rather than a silent one. */
    expect(Object.keys(calls[0]!.body).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "prompt_cache_key",
      "session_id",
      "usage",
    ]);

    /**
     * The backend pin, on both halves, carrying the same value on every turn.
     *
     * @remarks Not decoration and not redundancy. OpenRouter documents
     * `session_id` as the primary affinity key and `prompt_cache_key` as a
     * fallback, and they engage at different moments: `session_id` pins a
     * backend on any successful request, `prompt_cache_key` only once a hit has
     * been observed. A live append-only probe against `deepseek-v4-pro` with a
     * byte-identical prefix and a fixed `prompt_cache_key` read 0 cached on
     * turn 3, between a 99.6% hit and a run of ~96% hits — the window before
     * affinity took hold.
     */
    for (const c of calls) {
      expect(c.body.session_id).toBe(c.body.prompt_cache_key);
      expect(c.headers["x-session-id"]).toBe(String(c.body.session_id));
    }
    expect(new Set(calls.map((c) => c.headers["x-session-id"])).size).toBe(1);
  });
});
