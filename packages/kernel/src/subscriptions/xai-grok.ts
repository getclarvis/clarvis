import { createHash, randomUUID } from "node:crypto";

import type { CatalogProvider } from "@clarvis/protocol";
import { VERSION } from "@clarvis/loop";

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

const DEVICE_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const PRODUCT_USER_AGENT = `clarvis/${VERSION}`;

export interface XaiGrokAdapterOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

async function resolveAccountId(
  fetcher: typeof globalThis.fetch,
  issuer: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<string> {
  const origin = new URL(issuer).origin;
  const response = await fetchNoRedirect(fetcher, `${origin}/oauth2/userinfo`, {
    signal,
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`xAI user info failed with HTTP ${response.status}`);
  const body = jsonObject(await readBoundedJson(response));
  const account = safeHeaderIdentity(typeof body.sub === "string" ? body.sub : undefined);
  if (account === undefined) throw new Error("xAI user info lacks a safe account identity");
  return account;
}

async function tokenSet(
  response: Response,
  fetcher: typeof globalThis.fetch,
  issuer: string,
  now: () => number,
  signal?: AbortSignal,
): Promise<SubscriptionTokenSet> {
  const body = jsonObject(await readBoundedJson(response));
  if (!response.ok) {
    if (body.error === "invalid_grant") {
      throw new SubscriptionError(
        "subscription_reauthentication_required",
        "xAI subscription refresh was rejected; reconnect explicitly.",
        "invalid_grant",
      );
    }
    throw new Error(`xAI token operation failed with HTTP ${response.status}`);
  }
  const accessToken = requiredString(body.access_token);
  return {
    accessToken,
    ...(typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? { refreshToken: body.refresh_token }
      : {}),
    expiresAt: now() + positiveSeconds(body.expires_in, 3600) * 1000,
    accountId: await resolveAccountId(fetcher, issuer, accessToken, signal),
  };
}

function oauthHeaders(): Record<string, string> {
  return {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    "user-agent": PRODUCT_USER_AGENT,
  };
}

function requestModel(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string" || init.body.length > 4 * 1024 * 1024) {
    throw new Error("xAI subscription request body is unavailable");
  }
  const body = jsonObject(JSON.parse(init.body));
  const model = safeHeaderIdentity(typeof body.model === "string" ? body.model : undefined);
  if (model === undefined) throw new Error("xAI subscription request model is invalid");
  return model;
}

/** xAI Grok device OAuth, subscription proxy transport, and account continuity adapter. */
export function createXaiGrokAdapter(
  options: XaiGrokAdapterOptions = {},
): SubscriptionSchemeAdapter {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  return {
    scheme: "xai-grok",
    async startDevice(registration, signal) {
      const origin = new URL(registration.issuer).origin;
      const response = await fetchNoRedirect(fetcher, `${origin}/oauth2/device/code`, {
        method: "POST",
        signal,
        headers: oauthHeaders(),
        body: new URLSearchParams({
          client_id: registration.clientId,
          scope: DEVICE_SCOPE,
          referrer: "clarvis",
        }),
      });
      if (!response.ok)
        throw new Error(`xAI device authorization failed with HTTP ${response.status}`);
      const body = jsonObject(await readBoundedJson(response));
      return {
        deviceCode: requiredString(body.device_code),
        userCode: requiredString(body.user_code),
        verificationUrl: requiredString(body.verification_uri),
        expiresInSeconds: positiveSeconds(body.expires_in, 300),
        intervalSeconds: positiveSeconds(body.interval, 5),
      };
    },
    async pollDevice(registration, deviceCode, signal) {
      const origin = new URL(registration.issuer).origin;
      const response = await fetchNoRedirect(fetcher, `${origin}/oauth2/token`, {
        method: "POST",
        signal,
        headers: oauthHeaders(),
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT,
          client_id: registration.clientId,
          device_code: deviceCode,
        }),
      });
      if (response.ok) {
        return {
          state: "connected",
          tokens: await tokenSet(response, fetcher, registration.issuer, now, signal),
        };
      }
      const body = jsonObject(await readBoundedJson(response).catch(() => ({})));
      if (body.error === "authorization_pending") return { state: "pending" };
      if (body.error === "slow_down") return { state: "slow_down" };
      if (body.error === "access_denied" || body.error === "authorization_denied") {
        return { state: "denied" };
      }
      if (body.error === "expired_token") return { state: "expired" };
      throw new Error(`xAI device token operation failed with HTTP ${response.status}`);
    },
    async refresh(registration, refreshToken, signal) {
      const origin = new URL(registration.issuer).origin;
      const response = await fetchNoRedirect(fetcher, `${origin}/oauth2/token`, {
        method: "POST",
        signal,
        headers: oauthHeaders(),
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: registration.clientId,
        }),
      });
      return tokenSet(response, fetcher, registration.issuer, now, signal);
    },
    async revoke(registration, record, signal) {
      const origin = new URL(registration.issuer).origin;
      await fetchNoRedirect(fetcher, `${origin}/oauth2/revoke`, {
        method: "POST",
        signal,
        headers: oauthHeaders(),
        body: new URLSearchParams({
          token: record.refresh_token,
          client_id: registration.clientId,
        }),
      });
    },
    async catalog(registration, accessToken, accountId, signal): Promise<CatalogProvider> {
      const safeAccount = safeHeaderIdentity(accountId);
      if (safeAccount === undefined)
        throw new Error("xAI subscription account identity is invalid");
      const origin = new URL(registration.transportOrigin).origin;
      const response = await fetchNoRedirect(fetcher, `${origin}/v1/models`, {
        signal,
        headers: {
          authorization: `Bearer ${accessToken}`,
          "x-xai-token-auth": "xai-grok-cli",
          "x-userid": safeAccount,
          "user-agent": PRODUCT_USER_AGENT,
          accept: "application/json",
        },
      });
      if (!response.ok) throw new SubscriptionHttpError(response.status, "catalog");
      const body = jsonObject(await readBoundedJson(response));
      const values = Array.isArray(body.data)
        ? body.data
        : Array.isArray(body.models)
          ? body.models
          : undefined;
      if (values === undefined || values.length > 256) throw new Error("xAI catalog is malformed");
      const models = values.flatMap((value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
        const model = value as Record<string, unknown>;
        if (model.api_backend !== "responses") return [];
        const id = safeHeaderIdentity(typeof model.model === "string" ? model.model : undefined);
        if (id === undefined) return [];
        const efforts = Array.isArray(model.reasoning_efforts)
          ? model.reasoning_efforts.flatMap((item) => {
              if (typeof item === "string") return [item];
              if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
              const effort = (item as Record<string, unknown>).value;
              return typeof effort === "string" ? [effort] : [];
            })
          : undefined;
        return [
          {
            id,
            ...(typeof model.name === "string" ? { name: model.name } : {}),
            ...(Number.isInteger(model.context_window) && Number(model.context_window) > 0
              ? { context_window: Number(model.context_window) }
              : {}),
            ...(Number.isInteger(model.max_completion_tokens) &&
            Number(model.max_completion_tokens) > 0
              ? { max_output: Number(model.max_completion_tokens) }
              : {}),
            capabilities: ["tool_calling"],
            ...(efforts !== undefined ? { reasoning_efforts: efforts } : {}),
          },
        ];
      });
      return {
        id: "xai-grok",
        name: "Grok subscription",
        kind: "xai-grok",
        needs_base_url: false,
        models,
      };
    },
    async apply(registration, record, input, init, context) {
      const origin = new URL(registration.transportOrigin).origin;
      const url = assertOrigin(input, origin);
      if (url.pathname !== "/v1/responses") throw new SubscriptionTransportError();
      const accountId = safeHeaderIdentity(record.account_id);
      if (accountId === undefined) throw new Error("xAI subscription account identity is invalid");
      const headers = mergedHeaders(input, init);
      headers.delete("x-api-key");
      headers.delete("api-key");
      headers.set("authorization", `Bearer ${record.access_token}`);
      headers.set("x-xai-token-auth", "xai-grok-cli");
      headers.set("x-authenticateresponse", "authenticate-response");
      headers.set("x-grok-client-version", "1.0.6");
      headers.set("x-grok-client-identifier", "clarvis");
      headers.set("x-grok-model-override", requestModel(init));
      headers.set("x-grok-user-id", accountId);
      headers.set(
        "x-grok-conv-id",
        context?.conversationKey === undefined
          ? randomUUID()
          : createHash("sha256").update(context.conversationKey).digest("hex"),
      );
      headers.set("user-agent", PRODUCT_USER_AGENT);
      return fetchNoRedirect(fetcher, input, { ...init, headers });
    },
  };
}
