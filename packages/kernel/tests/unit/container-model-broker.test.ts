import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { LLMCallResult, LLMProvider, ModelExecutionInfo } from "@clarvis/capability";
import { createContainerModelBroker } from "../../src/runtime/model-broker-host.ts";
import {
  decodeContainerModelCall,
  MODEL_INPUT_BYTES,
} from "../../src/hosting/container-model-contract.ts";

const target: ModelExecutionInfo = {
  provider: "host-alias",
  model: "model",
  kind: "openai",
  contextWindowTokens: 100,
  maxOutputTokens: 20,
  capabilities: [],
  reasoningEfforts: [],
  promptCache: "implicit",
};
const result: LLMCallResult = {
  text: "done",
  usage: { input_tokens: 10, output_tokens: 2, cached_tokens: 8, cache_write_tokens: 2 },
};
function fixture(
  llm: LLMProvider = {
    async call() {
      return result;
    },
  },
  extra = {},
) {
  let resolutions = 0;
  const broker = createContainerModelBroker({
    owner: "owner",
    namespace: "workspace",
    modelCatalog: [target],
    maxConcurrent: 1,
    maxQueued: 1,
    tokenCeiling: 10_000,
    hostMaxRetries: 1,
    maxResponseBytes: MODEL_INPUT_BYTES,
    maxTimeoutMs: 60_000,
    defaultTimeoutMs: 30_000,
    ...extra,
    async resolve() {
      resolutions++;
      return { llm, providerConfig: { kind: "openai" } };
    },
  });
  const connection = broker.connect(
    () => undefined,
    () => undefined,
  );
  const request = () => ({
    leaseId: broker.leaseId,
    generation: broker.generation,
    callId: randomUUID(),
    runId: "run_native_execution",
    purpose: "generation",
    provider: "host-alias",
    model: "model",
    input: { messages: [{ role: "user", content: "hello" }], tools: [] },
  });
  return { broker, connection, request, resolutions: () => resolutions };
}
async function tick() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Container model admission", () => {
  test("refuses reverse administration, exact scope mismatches and construction settings before resolver/SDK", async () => {
    let calls = 0;
    const f = fixture({
      async call() {
        calls++;
        return result;
      },
    });
    try {
      await expect(f.connection.handle("config.get", {})).rejects.toMatchObject({
        code: "unauthorized",
      });
      for (const replacement of [
        { leaseId: "0".repeat(64) },
        { generation: randomUUID() },
        { provider: "openai" },
        { model: "other" },
      ]) {
        await expect(
          f.connection.handle("model.call", { ...f.request(), ...replacement }),
        ).rejects.toMatchObject({ code: "unauthorized" });
      }
      for (const field of ["providerConfig", "capabilities", "auth", "env", "url", "path"]) {
        const request = f.request();
        await expect(
          f.connection.handle("model.call", {
            ...request,
            input: { ...request.input, [field]: {} },
          }),
        ).rejects.toMatchObject({ code: "invalid_request" });
      }
      expect(f.resolutions()).toBe(0);
      expect(calls).toBe(0);
      expect(f.broker.accounting.chargedTokens).toBe(0);
    } finally {
      f.broker.revoke();
    }
  });
  test("closed native structures, bounded JSON and inline-only media", () => {
    const f = fixture();
    try {
      expect(
        decodeContainerModelCall({
          ...f.request(),
          input: {
            messages: [{ role: "user", content: "ok" }],
            tools: [
              {
                fullName: "read_file",
                wireName: "read_file",
                mcpName: "",
                toolName: "read_file",
                inputSchema: { type: "object" },
              },
            ],
          },
        }).input.tools[0]?.mcpName,
      ).toBe("");
      for (const messages of [
        [{ role: "user", content: [{ type: "image", image: "https://host.invalid/private" }] }],
        [
          {
            role: "tool",
            tool_call_id: "t",
            content: "",
            images: [{ data: "file:///etc/passwd", mediaType: "image/png" }],
          },
        ],
        [{ role: "user", content: "ok", hidden: true }],
        [{ role: "assistant", content: "", tool_calls: [{ id: "t", name: "tool" }] }],
      ])
        expect(() =>
          decodeContainerModelCall({ ...f.request(), input: { messages, tools: [] } }),
        ).toThrow();
      const bad = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') as unknown;
      expect(() =>
        decodeContainerModelCall({
          ...f.request(),
          input: {
            messages: [],
            tools: [
              { fullName: "a", wireName: "a", mcpName: "m", toolName: "a", inputSchema: bad },
            ],
          },
        }),
      ).toThrow();
      expect(() =>
        decodeContainerModelCall({
          ...f.request(),
          input: {
            messages: [{ role: "user", content: "x".repeat(MODEL_INPUT_BYTES) }],
            tools: [],
          },
        }),
      ).toThrow();
      expect(f.resolutions()).toBe(0);
    } finally {
      f.broker.revoke();
    }
  });
  test("reserves atomically using host retry/output caps; measured debit excludes cache double-counting", async () => {
    let seen = 0;
    const f = fixture(
      {
        async call(params) {
          seen++;
          expect(params.maxRetries).toBe(1);
          expect(params.maxOutputTokens).toBe(20);
          return {
            ...result,
            retriedUsage: {
              input_tokens: 3,
              output_tokens: 1,
              cached_tokens: 3,
              cache_write_tokens: 0,
            },
          };
        },
      },
      { tokenCeiling: 240 },
    );
    try {
      const request = f.request();
      await f.connection.handle("model.call", {
        ...request,
        input: { ...request.input, maxRetries: 1_000 },
      });
      expect(f.broker.accounting).toMatchObject({ chargedTokens: 240, debitedTokens: 16 });
      await expect(f.connection.handle("model.call", f.request())).rejects.toMatchObject({
        code: "resource_exhausted",
      });
      expect(seen).toBe(1);
      await expect(f.connection.handle("model.call", request)).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(
        f.connection.handle("model.call", { ...request, runId: "different" }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      f.broker.revoke();
    }
  });
  test("settles known usage only after terminal write and never releases twice", async () => {
    const f = fixture();
    try {
      const terminal = await f.connection.handle("model.call", f.request());
      expect(f.broker.accounting).toMatchObject({ chargedTokens: 240, debitedTokens: 12 });
      f.connection.responseSent?.("model.call", terminal);
      expect(f.broker.accounting.chargedTokens).toBe(12);
      f.connection.responseSent?.("model.call", terminal);
      expect(f.broker.accounting.chargedTokens).toBe(12);
      const second = await f.connection.handle("model.call", f.request());
      f.broker.revoke();
      f.connection.responseSent?.("model.call", second);
      expect(f.broker.accounting.chargedTokens).toBe(252);
    } finally {
      f.broker.revoke();
    }
  });

  test("unknown usage retains its reservation even after terminal write", async () => {
    const f = fixture({
      async call() {
        return { ...result, usage: { ...result.usage, usage_unknown: true } };
      },
    });
    try {
      const terminal = await f.connection.handle("model.call", f.request());
      f.connection.responseSent?.("model.call", terminal);
      expect(f.broker.accounting).toMatchObject({ chargedTokens: 240, debitedTokens: 12 });
    } finally {
      f.broker.revoke();
    }
  });

  test("reported usage above reservation is accounted in full and stops new admission at ceiling", async () => {
    const f = fixture(
      {
        async call() {
          return { ...result, usage: { ...result.usage, input_tokens: 300 } };
        },
      },
      { tokenCeiling: 300 },
    );
    try {
      const terminal = await f.connection.handle("model.call", f.request());
      f.connection.responseSent?.("model.call", terminal);
      expect(f.broker.accounting).toMatchObject({ chargedTokens: 302, debitedTokens: 302 });
      await expect(f.connection.handle("model.call", f.request())).rejects.toMatchObject({
        code: "resource_exhausted",
      });
      expect(f.resolutions()).toBe(1);
    } finally {
      f.broker.revoke();
    }
  });

  test("guest timeout cannot exceed the independent host ceiling", async () => {
    const seen: number[] = [];
    const f = fixture({
      async call(params) {
        seen.push(params.timeoutMs!);
        return result;
      },
    });
    try {
      for (const timeoutMs of [undefined, 10, 90_000]) {
        const request = f.request();
        await f.connection.handle("model.call", {
          ...request,
          input: { ...request.input, timeoutMs },
        });
      }
      expect(seen).toEqual([30_000, 10, 60_000]);
    } finally {
      f.broker.revoke();
    }
  });

  test("queue cancellation releases zero-dispatch reservation; active cancellation retains unknown outcome", async () => {
    const f = fixture({ call: () => new Promise(() => undefined) });
    const active = new AbortController();
    const queued = new AbortController();
    const first = f.connection.handle("model.call", f.request(), active.signal);
    void first.catch(() => undefined);
    await tick();
    const second = f.connection.handle("model.call", f.request(), queued.signal);
    void second.catch(() => undefined);
    expect(f.broker.accounting.chargedTokens).toBe(480);
    await expect(f.connection.handle("model.call", f.request())).rejects.toMatchObject({
      code: "resource_exhausted",
    });
    queued.abort();
    await expect(second).rejects.toMatchObject({ details: { outcome_unknown: false } });
    expect(f.broker.accounting.chargedTokens).toBe(240);
    expect(f.resolutions()).toBe(1);
    active.abort();
    await expect(first).rejects.toMatchObject({ details: { outcome_unknown: true } });
    expect(f.broker.accounting.chargedTokens).toBe(240);
    f.broker.revoke();
  });
  test("expiry, pair/account revocation and generation close abort pending work without fallback", async () => {
    for (const action of ["expiry", "pair", "account", "close"] as const) {
      let clock = 1;
      const f = fixture({ call: () => new Promise(() => undefined) }, { now: () => clock });
      const first = f.connection.handle("model.call", f.request());
      void first.catch(() => undefined);
      await tick();
      const queued = f.connection.handle("model.call", f.request());
      void queued.catch(() => undefined);
      if (action === "expiry") {
        clock = f.broker.expiresAt;
        await expect(f.connection.handle("model.call", f.request())).rejects.toMatchObject({
          code: "unauthorized",
        });
      } else if (action === "pair") f.broker.revokePair("host-alias", "model");
      else if (action === "account") f.broker.revokePair("host-alias");
      else f.connection.close();
      await expect(first).rejects.toMatchObject({ details: { outcome_unknown: true } });
      await expect(queued).rejects.toMatchObject({ details: { outcome_unknown: false } });
      await expect(f.connection.handle("model.call", f.request())).rejects.toMatchObject({
        code: "unauthorized",
      });
      expect(f.resolutions()).toBe(1);
      f.broker.revoke();
    }
  });
  test("callback overflow aborts instead of truncating or returning success", async () => {
    const f = fixture({
      async call(params) {
        for (let i = 0; i < 1_025; i++)
          params.onStreamDelta?.({ channel: "text", text: "x", reset: false });
        return result;
      },
    });
    try {
      await expect(f.connection.handle("model.call", f.request())).rejects.toMatchObject({
        code: "resource_exhausted",
        details: { outcome_unknown: true },
      });
    } finally {
      f.broker.revoke();
    }
  });
});
