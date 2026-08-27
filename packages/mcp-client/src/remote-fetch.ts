import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { MCPAuthorizationFailedError, oauthUrlIsSecure } from "./oauth.ts";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REMOTE_REDIRECTS = 10;
const CROSS_ORIGIN_CREDENTIAL_HEADERS = [
  "authorization",
  "cookie",
  "cookie2",
  "proxy-authorization",
] as const;
const BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
];

/** Inputs that keep configured MCP resource headers bound to one origin. */
export interface MCPRemoteFetchOptions {
  resourceUrl: URL;
  headers?: Readonly<Record<string, string>>;
  authorization: boolean;
  fetch?: FetchLike;
}

function redirectedMethod(method: string, status: number): string {
  if (status === 303 && method !== "GET" && method !== "HEAD") return "GET";
  if ((status === 301 || status === 302) && method === "POST") return "GET";
  return method;
}

function rejectInsecureOAuthTarget(url: URL): void {
  if (oauthUrlIsSecure(url)) return;
  throw new MCPAuthorizationFailedError(
    "MCP OAuth endpoints and redirects must use HTTPS or a loopback HTTP origin.",
  );
}

/**
 * Build the network authority shared by one remote MCP transport.
 *
 * @remarks Configured resource headers are injected only for the configured
 * resource origin without replacing request-defined headers. Once an OAuth
 * challenge or SDK authorization credential is seen, SDK discovery,
 * registration, and token requests remain free of configured resource headers;
 * every requested URL and redirect hop must use HTTPS or loopback HTTP.
 * Redirects are followed explicitly so validation and cross-origin credential
 * stripping happen before the next request leaves the process.
 */
export function createMCPRemoteFetch(options: MCPRemoteFetchOptions): FetchLike {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const resourceOrigin = options.resourceUrl.origin;
  let authorizationActive = false;

  return async (input, init) => {
    let target = new URL(input.toString());
    let method = (init?.method ?? "GET").toUpperCase();
    let body = init?.body;
    const headers = new Headers(init?.headers);

    for (let redirects = 0; redirects <= MAX_REMOTE_REDIRECTS; redirects += 1) {
      const requestHeaders = new Headers(headers);
      const incomingAuthorization = requestHeaders.get("authorization");
      const carriesAuthorization = options.authorization && incomingAuthorization !== null;
      if (carriesAuthorization) authorizationActive = true;
      if (authorizationActive) rejectInsecureOAuthTarget(target);
      const carriesResourceBearer = /^Bearer\s/i.test(incomingAuthorization ?? "");
      const acceptsResourceHeaders =
        target.origin === resourceOrigin && (!authorizationActive || carriesResourceBearer);
      if (acceptsResourceHeaders) {
        for (const [key, value] of Object.entries(options.headers ?? {})) {
          if (!requestHeaders.has(key)) requestHeaders.set(key, value);
        }
      }

      const requestInit: RequestInit = {
        ...init,
        method,
        headers: requestHeaders,
        redirect: "manual",
      };
      if (body === undefined) delete requestInit.body;
      else requestInit.body = body;
      const response = await baseFetch(target, requestInit);

      if (options.authorization && (response.status === 401 || response.status === 403)) {
        authorizationActive = true;
      }

      const location = response.headers.get("location");
      if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;
      if (redirects === MAX_REMOTE_REDIRECTS) {
        if (response.body !== null) void response.body.cancel().catch(() => undefined);
        throw new MCPAuthorizationFailedError(
          `MCP remote request exceeded the ${String(MAX_REMOTE_REDIRECTS)}-redirect limit.`,
        );
      }

      const next = new URL(location, target);
      if (authorizationActive) rejectInsecureOAuthTarget(next);
      if (next.origin !== target.origin) {
        for (const name of CROSS_ORIGIN_CREDENTIAL_HEADERS) headers.delete(name);
      }
      const nextMethod = redirectedMethod(method, response.status);
      if (nextMethod !== method) {
        body = undefined;
        for (const name of BODY_HEADERS) headers.delete(name);
      }
      method = nextMethod;
      target = next;
      if (response.body !== null) void response.body.cancel().catch(() => undefined);
    }

    throw new MCPAuthorizationFailedError("MCP remote redirect processing failed.");
  };
}
