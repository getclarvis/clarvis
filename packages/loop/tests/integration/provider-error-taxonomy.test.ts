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

function stubFetchOnce(make: () => Response | never): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => make()),
  );
}

async function runOnce(): Promise<{
  status: string;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  execution_id: string;
}> {
  harness = await makeHarness({
    llm: new AiSdkAdapter(),
    mcpFactory: mockMCPFactory({}),
  });
  return (await harness.run({
    messages: [{ role: "user", content: "Say hi" }],
    servers: [],
    providers: [{ name: "openai-compatible", kind: "openai-compatible", base_url: BASE }],
    profiles: [
      { name: "solo", model: "openai-compatible/test-model", tools: [], iteration_limit: 5 },
    ],
    entry: "solo",
    budget: { on_exceed: "stop", total_token_limit: 1000 },
  })) as never;
}

describe("provider error taxonomy surfaced in the terminal envelope", () => {
  it("HTTP 429 ⇒ details.kind transient, status 429", async () => {
    stubFetchOnce(() => new Response("rate limited", { status: 429 }));
    const res = await runOnce();
    expect(res.status).toBe("error");
    expect(res.error?.code).toBe("provider_error");
    expect(res.error?.details).toMatchObject({ kind: "transient", status: 429 });
  });

  it("HTTP 429 with Retry-After ⇒ details.retry_after_ms populated", async () => {
    stubFetchOnce(
      () => new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }),
    );
    const res = await runOnce();
    expect(res.error?.details).toMatchObject({
      kind: "transient",
      status: 429,
      retry_after_ms: 2000,
    });
  });

  it("HTTP 401 ⇒ details.kind auth", async () => {
    stubFetchOnce(() => new Response("nope", { status: 401 }));
    const res = await runOnce();
    expect(res.error?.details).toMatchObject({ kind: "auth", status: 401 });
  });

  it("HTTP 400 ⇒ details.kind client", async () => {
    stubFetchOnce(() => new Response("bad request", { status: 400 }));
    const res = await runOnce();
    expect(res.error?.details).toMatchObject({ kind: "client", status: 400 });
  });

  it("context-length error (4xx body) ⇒ details.kind context_overflow", async () => {
    stubFetchOnce(
      () =>
        new Response(
          JSON.stringify({
            error: { message: "This model's maximum context length is 8192 tokens" },
          }),
          { status: 400 },
        ),
    );
    const res = await runOnce();
    expect(res.error?.code).toBe("context_overflow");
    expect(res.error?.details).toMatchObject({ kind: "context_overflow" });
  });

  it("connection failure (no status) ⇒ details.kind transient, status absent", async () => {
    stubFetchOnce(() => {
      throw new Error("ECONNREFUSED");
    });
    const res = await runOnce();
    expect(res.error?.details?.kind).toBe("transient");
    expect(res.error?.details?.status).toBeUndefined();
  });

  it("backward compatible: code unchanged, message sanitized, no base URL leak", async () => {
    stubFetchOnce(() => new Response("boom", { status: 503 }));
    const res = await runOnce();
    expect(res.error?.code).toBe("provider_error");
    expect(typeof res.error?.message).toBe("string");
    expect(res.error?.message.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.error)).not.toContain("11434");

    const detail = await harness!.getRun(res.execution_id);
    expect(JSON.stringify(detail?.response)).not.toContain("11434");
    expect(JSON.stringify(detail?.trace)).not.toContain("11434");
  });
});
