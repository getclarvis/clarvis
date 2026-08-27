import { describe, expect, it } from "bun:test";
import { VERSION } from "@clarvis/loop";

import { createOpenAICodexAdapter } from "../../src/subscriptions/openai-codex.ts";
import { createXaiGrokAdapter } from "../../src/subscriptions/xai-grok.ts";
import { readBoundedJson } from "../../src/subscriptions/http.ts";
import type {
  SubscriptionAccountRecord,
  SubscriptionSchemeRegistration,
} from "../../src/subscriptions/types.ts";

const account: SubscriptionAccountRecord = {
  access_token: "secret-access-token",
  refresh_token: "secret-refresh-token",
  expires_at: 10_000,
  account_id: "account-safe",
};

const openaiRegistration: SubscriptionSchemeRegistration = {
  scheme: "openai-codex",
  clientId: "test-client",
  issuer: "https://auth.openai.test",
  transportOrigin: "https://chatgpt.com",
  authorization: { owner: "clarvis", evidence: "test" },
};

const grokRegistration: SubscriptionSchemeRegistration = {
  scheme: "xai-grok",
  clientId: "test-client",
  issuer: "https://auth.xai.test",
  transportOrigin: "https://cli-chat-proxy.grok.com",
  authorization: { owner: "clarvis", evidence: "test" },
};

function fetchStub(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect() {} }) as typeof fetch;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function openAiAccessToken(accountId = "account-safe"): string {
  const claims = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${claims}.signature`;
}

describe("subscription transport authority", () => {
  it("completes the ChatGPT device and refresh token lifecycles", async () => {
    const calls: string[] = [];
    const adapter = createOpenAICodexAdapter({
      now: () => 1_000,
      fetch: fetchStub(async (input) => {
        const url = requestUrl(input);
        calls.push(url);
        if (url.endsWith("/api/accounts/deviceauth/usercode")) {
          return Response.json({
            user_code: "SAFE-CODE",
            device_auth_id: "device-auth",
            interval: 2,
          });
        }
        if (url.endsWith("/api/accounts/deviceauth/token")) {
          return Response.json({ authorization_code: "authorization", code_verifier: "verifier" });
        }
        return Response.json({
          access_token: openAiAccessToken(),
          refresh_token: "rotated-refresh",
          expires_in: 60,
        });
      }),
    });

    const device = await adapter.startDevice(openaiRegistration, new AbortController().signal);
    expect(device).toMatchObject({
      userCode: "SAFE-CODE",
      verificationUrl: "https://auth.openai.test/codex/device",
      intervalSeconds: 2,
    });
    const connected = await adapter.pollDevice(
      openaiRegistration,
      device.deviceCode,
      new AbortController().signal,
    );
    expect(connected).toMatchObject({
      state: "connected",
      tokens: { refreshToken: "rotated-refresh", expiresAt: 61_000, accountId: "account-safe" },
    });
    await expect(adapter.refresh(openaiRegistration, "refresh", undefined)).resolves.toMatchObject({
      accountId: "account-safe",
      refreshToken: "rotated-refresh",
    });
    expect(calls).toHaveLength(4);
  });

  it("maps ChatGPT polling and token failures without accepting malformed identity", async () => {
    const pending = createOpenAICodexAdapter({
      fetch: fetchStub(async () => new Response(null, { status: 403 })),
    });
    await expect(
      pending.pollDevice(
        openaiRegistration,
        JSON.stringify({ deviceAuthId: "d", userCode: "u" }),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ state: "pending" });

    const denied = createOpenAICodexAdapter({
      fetch: fetchStub(async () => new Response(null, { status: 500 })),
    });
    await expect(
      denied.pollDevice(
        openaiRegistration,
        JSON.stringify({ deviceAuthId: "d", userCode: "u" }),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ state: "denied" });
    await expect(
      denied.pollDevice(openaiRegistration, "not-json", new AbortController().signal),
    ).rejects.toThrow("malformed");

    const invalidGrant = createOpenAICodexAdapter({
      fetch: fetchStub(async () => Response.json({ error: "invalid_grant" }, { status: 400 })),
    });
    await expect(invalidGrant.refresh(openaiRegistration, "refresh")).rejects.toMatchObject({
      code: "subscription_reauthentication_required",
    });

    const unsafeIdentity = createOpenAICodexAdapter({
      fetch: fetchStub(async () =>
        Response.json({ access_token: "not-a-jwt", refresh_token: "refresh", expires_in: 60 }),
      ),
    });
    await expect(unsafeIdentity.refresh(openaiRegistration, "refresh")).rejects.toThrow(
      "safe ChatGPT account identity",
    );

    const malformedClaims = createOpenAICodexAdapter({
      fetch: fetchStub(async () =>
        Response.json({ access_token: "header.bm90LWpzb24.signature", expires_in: 60 }),
      ),
    });
    await expect(malformedClaims.refresh(openaiRegistration, "refresh")).rejects.toThrow(
      "safe ChatGPT account identity",
    );

    const failedToken = createOpenAICodexAdapter({
      fetch: fetchStub(async () => Response.json({ error: "server_error" }, { status: 500 })),
    });
    await expect(failedToken.refresh(openaiRegistration, "refresh")).rejects.toThrow("HTTP 500");
  });

  it("completes Grok device, refresh, user-info, and revoke lifecycles", async () => {
    const calls: string[] = [];
    const adapter = createXaiGrokAdapter({
      now: () => 2_000,
      fetch: fetchStub(async (input) => {
        const url = requestUrl(input);
        calls.push(url);
        if (url.endsWith("/oauth2/device/code")) {
          return Response.json({
            device_code: "device",
            user_code: "GROK-CODE",
            verification_uri: "https://auth.xai.test/device",
            expires_in: 300,
            interval: 3,
          });
        }
        if (url.endsWith("/oauth2/userinfo")) return Response.json({ sub: "grok-account" });
        if (url.endsWith("/oauth2/revoke")) return new Response(null, { status: 204 });
        return Response.json({
          access_token: "grok-access",
          refresh_token: "grok-refresh",
          expires_in: 90,
        });
      }),
    });

    await expect(
      adapter.startDevice(grokRegistration, new AbortController().signal),
    ).resolves.toMatchObject({ userCode: "GROK-CODE", intervalSeconds: 3 });
    await expect(
      adapter.pollDevice(grokRegistration, "device", new AbortController().signal),
    ).resolves.toMatchObject({
      state: "connected",
      tokens: { accountId: "grok-account", expiresAt: 92_000 },
    });
    await expect(adapter.refresh(grokRegistration, "refresh")).resolves.toMatchObject({
      accountId: "grok-account",
      refreshToken: "grok-refresh",
    });
    await adapter.revoke?.(grokRegistration, account);
    expect(calls.some((url) => url.endsWith("/oauth2/revoke"))).toBe(true);
  });

  it("owns every Grok device polling outcome and invalid-grant refresh", async () => {
    const outcome = async (error: string) => {
      const adapter = createXaiGrokAdapter({
        fetch: fetchStub(async () => Response.json({ error }, { status: 400 })),
      });
      return adapter.pollDevice(grokRegistration, "device", new AbortController().signal);
    };
    await expect(outcome("authorization_pending")).resolves.toEqual({ state: "pending" });
    await expect(outcome("slow_down")).resolves.toEqual({ state: "slow_down" });
    await expect(outcome("access_denied")).resolves.toEqual({ state: "denied" });
    await expect(outcome("authorization_denied")).resolves.toEqual({ state: "denied" });
    await expect(outcome("expired_token")).resolves.toEqual({ state: "expired" });
    await expect(outcome("unknown")).rejects.toThrow("HTTP 400");

    const invalidGrant = createXaiGrokAdapter({
      fetch: fetchStub(async () => Response.json({ error: "invalid_grant" }, { status: 400 })),
    });
    await expect(invalidGrant.refresh(grokRegistration, "refresh")).rejects.toMatchObject({
      code: "subscription_reauthentication_required",
    });

    const failedToken = createXaiGrokAdapter({
      fetch: fetchStub(async () => Response.json({ error: "server_error" }, { status: 500 })),
    });
    await expect(failedToken.refresh(grokRegistration, "refresh")).rejects.toThrow("HTTP 500");
  });

  it("rejects missing Grok request bodies and accepts the alternate models catalog envelope", async () => {
    const adapter = createXaiGrokAdapter({
      fetch: fetchStub(async () =>
        Response.json({
          models: [{ model: "grok-code", name: "Grok Code", api_backend: "responses" }],
        }),
      ),
    });
    await expect(
      adapter.apply(grokRegistration, account, "https://cli-chat-proxy.grok.com/v1/responses"),
    ).rejects.toThrow("body is unavailable");
    await expect(
      adapter.catalog(grokRegistration, account.access_token, account.account_id),
    ).resolves.toMatchObject({ models: [{ id: "grok-code", name: "Grok Code" }] });
  });

  it("pins ChatGPT origin and overwrites every credential and identity header", async () => {
    let request: Request | undefined;
    const adapter = createOpenAICodexAdapter({
      fetch: fetchStub(async (input, init) => {
        request =
          input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
        return new Response("ok");
      }),
    });

    await adapter.apply(
      openaiRegistration,
      account,
      new Request("https://chatgpt.com/backend-api/codex/responses", {
        headers: {
          authorization: "Bearer attacker",
          "chatgpt-account-id": "attacker",
          originator: "attacker",
        },
      }),
      { headers: { "x-api-key": "attacker" } },
      { conversationKey: "conversation" },
    );

    expect(request?.redirect).toBe("manual");
    expect(request?.headers.get("authorization")).toBe("Bearer secret-access-token");
    expect(request?.headers.get("chatgpt-account-id")).toBe("account-safe");
    expect(request?.headers.get("originator")).toBe("clarvis");
    expect(request?.headers.get("user-agent")).toBe(`clarvis/${VERSION}`);
    expect(request?.headers.get("x-api-key")).toBeNull();
    expect(request?.headers.get("session-id")).toMatch(/^[a-f0-9]{64}$/);
    expect(request?.headers.get("x-client-request-id")).toBe(request?.headers.get("session-id"));
  });

  it("pins Grok subscription transport and derives its required headers after assembly", async () => {
    let request: Request | undefined;
    const adapter = createXaiGrokAdapter({
      fetch: fetchStub(async (input, init) => {
        request =
          input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
        return new Response("ok");
      }),
    });

    await adapter.apply(
      grokRegistration,
      account,
      "https://cli-chat-proxy.grok.com/v1/responses",
      {
        method: "POST",
        headers: {
          authorization: "Bearer attacker",
          "x-grok-user-id": "attacker",
          "x-grok-model-override": "attacker",
        },
        body: JSON.stringify({ model: "grok-code" }),
      },
      { conversationKey: "conversation" },
    );

    expect(request?.redirect).toBe("manual");
    expect(request?.headers.get("authorization")).toBe("Bearer secret-access-token");
    expect(request?.headers.get("x-grok-user-id")).toBe("account-safe");
    expect(request?.headers.get("x-grok-model-override")).toBe("grok-code");
    expect(request?.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(request?.headers.get("x-grok-client-version")).toBe("1.0.6");
    expect(request?.headers.get("user-agent")).toBe(`clarvis/${VERSION}`);
    expect(request?.headers.get("x-grok-conv-id")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses cross-origin and alternate-path credential transport", async () => {
    const adapter = createOpenAICodexAdapter({
      fetch: fetchStub(async () => new Response("unexpected")),
    });
    await expect(
      adapter.apply(openaiRegistration, account, "https://example.test/responses"),
    ).rejects.toThrow();
    await expect(
      adapter.apply(openaiRegistration, account, "https://chatgpt.com/backend-api/other"),
    ).rejects.toThrow();
  });

  it("maps only visible API-supported Codex models and their reasoning facts", async () => {
    let request: Request | undefined;
    const adapter = createOpenAICodexAdapter({
      fetch: fetchStub(async (input, init) => {
        request =
          input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
        return Response.json({
          models: [
            {
              slug: "gpt-codex",
              display_name: "GPT Codex",
              visibility: "list",
              supported_in_api: true,
              supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
              input_modalities: ["text", "image"],
              context_window: 200_000,
            },
            { slug: "hidden", visibility: "hide", supported_in_api: true },
            {
              slug: "gpt-5.6-sol",
              display_name: "GPT-5.6 Sol",
              visibility: "list",
              supported_in_api: true,
              use_responses_lite: true,
              supported_reasoning_levels: [
                { effort: "low" },
                { effort: "medium" },
                { effort: "high" },
                { effort: "xhigh" },
                { effort: "max" },
              ],
            },
          ],
        });
      }),
    });
    await expect(
      adapter.catalog(openaiRegistration, account.access_token, account.account_id),
    ).resolves.toMatchObject({
      models: [
        {
          id: "gpt-codex",
          context_window: 200_000,
          capabilities: ["tool_calling", "vision"],
          reasoning_efforts: ["low", "high"],
        },
        {
          id: "gpt-5.6-sol",
          capabilities: ["tool_calling"],
          reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
        },
      ],
    });
    expect(request?.url).toContain("client_version=0.144.0");
    expect(request?.url).not.toContain(encodeURIComponent(VERSION));
    expect(request?.headers.get("user-agent")).toBe(`clarvis/${VERSION}`);
  });

  it("retains only Responses-backed Grok subscription models", async () => {
    let request: Request | undefined;
    const adapter = createXaiGrokAdapter({
      fetch: fetchStub(async (input, init) => {
        request =
          input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
        return Response.json({
          data: [
            {
              model: "grok-code",
              api_backend: "responses",
              context_window: 256_000,
              max_completion_tokens: 32_000,
              supports_reasoning_effort: true,
              reasoning_efforts: [{ value: "low" }, { value: "high" }],
            },
            { model: "grok-chat", api_backend: "chat_completions" },
          ],
        });
      }),
    });
    await expect(
      adapter.catalog(grokRegistration, account.access_token, account.account_id),
    ).resolves.toMatchObject({
      models: [
        {
          id: "grok-code",
          context_window: 256_000,
          max_output: 32_000,
          reasoning_efforts: ["low", "high"],
        },
      ],
    });
    expect(request?.url).toBe("https://cli-chat-proxy.grok.com/v1/models");
    expect(request?.headers.get("x-grok-client-version")).toBe("1.0.6");
    expect(request?.headers.get("user-agent")).toBe(`clarvis/${VERSION}`);
  });
});

it("keeps the byte-limit error when cancelling an oversized provider stream also fails", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel() {
        throw new Error("cancel failed");
      },
    }),
  );

  await expect(readBoundedJson(response)).rejects.toThrow("provider response exceeds byte limit");
});

it("maps malformed Grok polling JSON through the bounded-response fallback", async () => {
  const adapter = createXaiGrokAdapter({
    fetch: fetchStub(async () => new Response("{", { status: 400 })),
  });
  await expect(
    adapter.pollDevice(grokRegistration, "device", new AbortController().signal),
  ).rejects.toThrow("xAI device token operation failed with HTTP 400");
});
