import { createHash, randomUUID } from "node:crypto";

import type { CatalogProvider } from "@clarvis/protocol";
import { VERSION } from "@clarvis/loop/host";

import {
  assertOrigin,
  fetchNoRedirect,
  jsonObject,
  mergedHeaders,
  positiveSeconds,
  readBoundedJson,
  requiredString,
  safeHeaderIdentity,
  SubscriptionHttpError,
  SubscriptionTransportError,
} from "./http.ts";
import type { SubscriptionSchemeAdapter, SubscriptionTokenSet } from "./types.ts";
import { SubscriptionError } from "./redaction.ts";

const PRODUCT_USER_AGENT = `clarvis/${VERSION}`;

/**
 * Codex catalog compatibility revision used by the ChatGPT subscription adapter.
 *
 * @remarks This is intentionally independent from the Clarvis product version. The ChatGPT model
 *   catalog compares `client_version` against each model's minimum Codex client revision; sending
 *   Clarvis `0.0.1-beta` therefore yields an empty successful catalog. Revision `0.144.0` is the
 *   first revision that exposes the current `gpt-5.6-*` family to eligible accounts.
 */
const OPENAI_CODEX_CLIENT_VERSION = "0.144.0";

export interface OpenAICodexAdapterOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const encoded = token.split(".")[1];
  if (encoded === undefined) return undefined;
  try {
    return jsonObject(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function accountIdFromToken(token: string): string | undefined {
  const claims = decodeJwtClaims(token);
  const auth = claims?.["https://api.openai.com/auth"];
  const account =
    typeof auth === "object" && auth !== null
      ? (auth as Record<string, unknown>).chatgpt_account_id
      : undefined;
  return safeHeaderIdentity(typeof account === "string" ? account : undefined);
}

async function tokenSet(response: Response, now: () => number): Promise<SubscriptionTokenSet> {
  const body = jsonObject(await readBoundedJson(response));
  if (!response.ok) {
    if (body.error === "invalid_grant") {
      throw new SubscriptionError(
        "subscription_reauthentication_required",
        "OpenAI subscription refresh was rejected; reconnect explicitly.",
        "invalid_grant",
      );
    }
    throw new Error(`OpenAI token operation failed with HTTP ${response.status}`);
  }
  const accessToken = requiredString(body.access_token);
  const accountId = accountIdFromToken(accessToken);
  if (accountId === undefined)
    throw new Error("OpenAI token lacks a safe ChatGPT account identity");
  return {
    accessToken,
    ...(typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? { refreshToken: body.refresh_token }
      : {}),
    expiresAt: now() + positiveSeconds(body.expires_in, 3600) * 1000,
    accountId,
  };
}

/** OpenAI ChatGPT Codex OAuth, authenticated catalog, and pinned Responses transport. */
export function createOpenAICodexAdapter(
  options: OpenAICodexAdapterOptions = {},
): SubscriptionSchemeAdapter {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  return {
    scheme: "openai-codex",
    async startDevice(registration, signal) {
      const origin = new URL(registration.issuer).origin;
      const response = await fetchNoRedirect(
        fetcher,
        `${origin}/api/accounts/deviceauth/usercode`,
        {
          method: "POST",
          signal,
          headers: { "content-type": "application/json", "user-agent": PRODUCT_USER_AGENT },
          body: JSON.stringify({ client_id: registration.clientId }),
        },
      );
      if (!response.ok)
        throw new Error(`OpenAI device authorization failed with HTTP ${response.status}`);
      const body = jsonObject(await readBoundedJson(response));
      const userCode = requiredString(body.user_code);
      const deviceAuthId = requiredString(body.device_auth_id);
      return {
        deviceCode: JSON.stringify({ deviceAuthId, userCode }),
        userCode,
        verificationUrl: `${origin}/codex/device`,
        expiresInSeconds: 600,
        intervalSeconds: positiveSeconds(body.interval, 5),
      };
    },
    async pollDevice(registration, deviceCode, signal) {
      const origin = new URL(registration.issuer).origin;
      let context: Record<string, unknown>;
      try {
        context = jsonObject(JSON.parse(deviceCode));
      } catch {
        throw new Error("OpenAI device attempt is malformed");
      }
      const response = await fetchNoRedirect(fetcher, `${origin}/api/accounts/deviceauth/token`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "user-agent": PRODUCT_USER_AGENT },
        body: JSON.stringify({
          device_auth_id: requiredString(context.deviceAuthId),
          user_code: requiredString(context.userCode),
        }),
      });
      if (response.status === 403 || response.status === 404) return { state: "pending" };
      if (!response.ok) return { state: "denied" };
      const exchange = jsonObject(await readBoundedJson(response));
      const tokens = await fetchNoRedirect(fetcher, `${origin}/oauth/token`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: requiredString(exchange.authorization_code),
          redirect_uri: `${origin}/deviceauth/callback`,
          client_id: registration.clientId,
          code_verifier: requiredString(exchange.code_verifier),
        }),
      });
      return { state: "connected", tokens: await tokenSet(tokens, now) };
    },
    async refresh(registration, refreshToken, signal) {
      const origin = new URL(registration.issuer).origin;
      const response = await fetchNoRedirect(fetcher, `${origin}/oauth/token`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: registration.clientId,
        }),
      });
      return tokenSet(response, now);
    },
    async catalog(registration, accessToken, accountId, signal): Promise<CatalogProvider> {
      const safeAccount = safeHeaderIdentity(accountId);
      if (safeAccount === undefined)
        throw new Error("OpenAI subscription account identity is invalid");
      const origin = new URL(registration.transportOrigin).origin;
      const response = await fetchNoRedirect(
        fetcher,
        `${origin}/backend-api/codex/models?client_version=${encodeURIComponent(OPENAI_CODEX_CLIENT_VERSION)}`,
        {
          signal,
          headers: {
            authorization: `Bearer ${accessToken}`,
            "chatgpt-account-id": safeAccount,
            originator: "clarvis",
            "user-agent": PRODUCT_USER_AGENT,
            accept: "application/json",
          },
        },
      );
      if (!response.ok) throw new SubscriptionHttpError(response.status, "catalog");
      const body = jsonObject(await readBoundedJson(response));
      if (!Array.isArray(body.models) || body.models.length > 256) {
        throw new Error("OpenAI catalog is malformed");
      }
      const models = body.models.flatMap((value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
        const model = value as Record<string, unknown>;
        if (model.visibility !== "list" || model.supported_in_api !== true) return [];
        const id = safeHeaderIdentity(typeof model.slug === "string" ? model.slug : undefined);
        if (id === undefined) return [];
        const efforts = Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels.flatMap((item) => {
              if (typeof item === "string") return [item];
              if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
              const effort = (item as Record<string, unknown>).effort;
              return typeof effort === "string" ? [effort] : [];
            })
          : undefined;
        const modalities = Array.isArray(model.input_modalities) ? model.input_modalities : [];
        return [
          {
            id,
            ...(typeof model.display_name === "string" ? { name: model.display_name } : {}),
            ...(Number.isInteger(model.context_window) && Number(model.context_window) > 0
              ? { context_window: Number(model.context_window) }
              : {}),
            capabilities: ["tool_calling", ...(modalities.includes("image") ? ["vision"] : [])],
            ...(efforts !== undefined ? { reasoning_efforts: efforts } : {}),
          },
        ];
      });
      return {
        id: "openai-codex",
        name: "ChatGPT subscription",
        kind: "openai-codex",
        needs_base_url: false,
        models,
      };
    },
    async apply(registration, record, input, init, context) {
      const origin = new URL(registration.transportOrigin).origin;
      const url = assertOrigin(input, origin);
      if (url.pathname !== "/backend-api/codex/responses") {
        throw new SubscriptionTransportError();
      }
      const accountId = safeHeaderIdentity(record.account_id);
      if (accountId === undefined)
        throw new Error("OpenAI subscription account identity is invalid");
      const headers = mergedHeaders(input, init);
      headers.delete("x-api-key");
      headers.delete("api-key");
      headers.set("authorization", `Bearer ${record.access_token}`);
      headers.set("chatgpt-account-id", accountId);
      headers.set("originator", "clarvis");
      headers.set("openai-beta", "responses=experimental");
      headers.set("accept", "text/event-stream");
      const sessionId =
        context?.conversationKey === undefined
          ? randomUUID()
          : createHash("sha256").update(context.conversationKey).digest("hex");
      headers.set("session-id", sessionId);
      headers.set("x-client-request-id", sessionId);
      headers.set("user-agent", PRODUCT_USER_AGENT);
      return fetchNoRedirect(fetcher, input, { ...init, headers });
    },
  };
}
