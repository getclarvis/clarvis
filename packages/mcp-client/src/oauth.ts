import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { PoolScope } from "./connection.ts";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { CLIENT_NAME, VERSION } from "./version.ts";
import {
  createMcpOAuthCredentialStore,
  type McpOAuthCredentialStore,
  type McpOAuthRecord,
} from "./oauth-store.ts";

/** Stable loopback port preferred so dynamic client registrations survive restarts. */
export const DEFAULT_MCP_OAUTH_CALLBACK_PORT = 53_682;
/** Maximum time a run waits for a person to finish browser authorization. */
export const DEFAULT_MCP_OAUTH_AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const MAX_CALLBACK_URL_CHARS = 16 * 1024;
const MAX_AUTHORIZATION_CODE_CHARS = 8 * 1024;
const MAX_STATE_CHARS = 256;
const MAX_AUTHORIZATION_TIMEOUT_MS = 30 * 60_000;

/** A remote MCP server needs interactive OAuth but this host cannot open it. */
export class MCPInteractiveAuthorizationUnavailableError extends Error {
  readonly code = "mcp_oauth_interactive_unavailable" as const;

  constructor(message = "MCP OAuth authorization requires an interactive Clarvis host.") {
    super(message);
    this.name = "MCPInteractiveAuthorizationUnavailableError";
  }
}

/** Browser authorization did not complete successfully. */
export class MCPAuthorizationFailedError extends Error {
  readonly code = "mcp_oauth_authorization_failed" as const;

  constructor(message: string) {
    super(message);
    this.name = "MCPAuthorizationFailedError";
  }
}

/** Host controls for persistent, browser-based remote MCP authorization. */
export interface MCPAuthorizationOptions {
  storeFile: string;
  /** Opens a URL in the user's browser; absent on intentionally headless hosts. */
  openAuthorizationUrl?: (url: string) => Promise<boolean>;
  /** Preferred loopback callback port. Zero requests an ephemeral test/dev port. */
  callbackPort?: number;
  authorizationTimeoutMs?: number;
  /** Store seam used by deterministic tests. */
  store?: McpOAuthCredentialStore;
}

/** Transport subset needed to exchange the callback code. */
export interface OAuthFinishingTransport {
  finishAuth(code: string): Promise<void>;
}

/** One provider/session, bound to a single owner and remote resource. */
export interface MCPAuthorizationSession {
  readonly key: string;
  readonly provider: OAuthClientProvider;
  finishAuthorization(transport: OAuthFinishingTransport, signal?: AbortSignal): Promise<void>;
}

/** Long-lived callback listener and credential authority shared by one client factory. */
export interface MCPAuthorizationCoordinator {
  key(scope: PoolScope, serverUrl: string): string;
  session(scope: PoolScope, serverUrl: string): Promise<MCPAuthorizationSession>;
  runExclusive<T>(
    key: string,
    signal: AbortSignal | undefined,
    onWaitStart: (() => void) | undefined,
    onWaitEnd: (() => void) | undefined,
    run: () => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

interface PendingCallback {
  state: string;
  resolve(code: string): void;
  reject(error: Error): void;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function stateMatches(expected: string, received: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

function successPage(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
  });
  res.end(
    "<!doctype html><meta charset=utf-8><title>Clarvis authorization complete</title>" +
      "<style>body{font:16px system-ui;margin:4rem;max-width:42rem}h1{font-size:1.5rem}</style>" +
      "<h1>Authorization complete</h1><p>You can close this tab and return to Clarvis.</p>",
  );
}

function failurePage(res: ServerResponse, status = 400): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
  });
  res.end(
    "<!doctype html><meta charset=utf-8><title>Clarvis authorization failed</title>" +
      "<style>body{font:16px system-ui;margin:4rem;max-width:42rem}h1{font-size:1.5rem}</style>" +
      "<h1>Authorization failed</h1><p>Return to Clarvis for details and try again.</p>",
  );
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new MCPAuthorizationFailedError("MCP OAuth authorization was cancelled.");
}

function waitAbortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function recordKey(scope: PoolScope, serverUrl: string): string {
  const resource = new URL(serverUrl).href;
  return createHash("sha256")
    .update(scope.workspace)
    .update("\0")
    .update(scope.owner)
    .update("\0")
    .update(resource)
    .digest("hex");
}
/** Whether an OAuth network or browser destination uses HTTPS or loopback HTTP. */
export function oauthUrlIsSecure(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
  );
}

/**
 * Create the OAuth coordinator used by remote HTTP/SSE transports.
 *
 * @remarks Authorization URLs, states, codes, tokens, client secrets and token
 * responses never cross the logging boundary. The listener accepts only the
 * fixed loopback path and validates a 256-bit state before resolving a flow.
 */
export function createMCPAuthorizationCoordinator(
  options: MCPAuthorizationOptions,
): MCPAuthorizationCoordinator {
  const store = options.store ?? createMcpOAuthCredentialStore(options.storeFile);
  const preferredPort = options.callbackPort ?? DEFAULT_MCP_OAUTH_CALLBACK_PORT;
  if (!Number.isInteger(preferredPort) || preferredPort < 0 || preferredPort > 65_535) {
    throw new Error("MCP OAuth callback port must be an integer from 0 through 65535.");
  }
  const configuredTimeout =
    options.authorizationTimeoutMs ?? DEFAULT_MCP_OAUTH_AUTHORIZATION_TIMEOUT_MS;
  if (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0) {
    throw new Error("MCP OAuth authorization timeout must be a positive finite number.");
  }
  const authorizationTimeoutMs = Math.max(
    1,
    Math.min(MAX_AUTHORIZATION_TIMEOUT_MS, Math.floor(configuredTimeout)),
  );
  const pending = new Map<string, PendingCallback>();
  const tails = new Map<string, Promise<void>>();
  let callbackServer: Server | undefined;
  let callbackUrl: string | undefined;
  let startPromise: Promise<string> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const handleCallback = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET" || req.url === undefined || req.url.length > MAX_CALLBACK_URL_CHARS) {
      failurePage(res, 404);
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url, callbackUrl ?? "http://127.0.0.1");
    } catch {
      failurePage(res);
      return;
    }
    if (url.pathname !== "/oauth/callback") {
      failurePage(res, 404);
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    if (state.length === 0 || state.length > MAX_STATE_CHARS) {
      failurePage(res);
      return;
    }
    const found = [...pending.values()].find((entry) => stateMatches(entry.state, state));
    if (found === undefined) {
      failurePage(res);
      return;
    }
    pending.delete(found.state);
    const oauthError = url.searchParams.get("error");
    if (oauthError !== null) {
      found.reject(new MCPAuthorizationFailedError("The authorization server declined access."));
      failurePage(res);
      return;
    }
    const code = url.searchParams.get("code") ?? "";
    if (code.length === 0 || code.length > MAX_AUTHORIZATION_CODE_CHARS) {
      found.reject(
        new MCPAuthorizationFailedError("The authorization callback carried no usable code."),
      );
      failurePage(res);
      return;
    }
    found.resolve(code);
    successPage(res);
  };

  const listen = (server: Server, port: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });

  const ensureServer = async (): Promise<string> => {
    if (callbackUrl !== undefined) return callbackUrl;
    if (closed) throw new MCPAuthorizationFailedError("MCP OAuth coordinator is closed.");
    startPromise ??= (async () => {
      const server = createServer(handleCallback);
      callbackServer = server;
      try {
        await listen(server, preferredPort);
      } catch (error) {
        if (preferredPort === 0 || (error as NodeJS.ErrnoException | null)?.code !== "EADDRINUSE") {
          throw error;
        }
        await listen(server, 0);
      }
      const address = server.address() as AddressInfo | null;
      if (address === null) throw new Error("MCP OAuth callback listener has no address");
      callbackUrl = `http://127.0.0.1:${String(address.port)}/oauth/callback`;
      return callbackUrl;
    })();
    let started: string;
    try {
      started = await startPromise;
    } catch (error) {
      startPromise = undefined;
      callbackServer = undefined;
      throw error;
    }
    if (closed) throw new MCPAuthorizationFailedError("MCP OAuth coordinator is closed.");
    return started;
  };

  const makeSession = async (
    scope: PoolScope,
    serverUrl: string,
  ): Promise<MCPAuthorizationSession> => {
    const redirectUrl = await ensureServer();
    const key = recordKey(scope, serverUrl);
    const stored = await store.readRecord(key);
    if (closed) throw new MCPAuthorizationFailedError("MCP OAuth coordinator is closed.");
    let clientInformation =
      stored?.redirect_url === redirectUrl ? stored.client_information : undefined;
    let tokens = stored?.tokens;
    let flow: AuthorizationFlow | undefined;

    const activeFlow = (): AuthorizationFlow => {
      flow ??= {
        state: randomBytes(32).toString("base64url"),
        callback: deferred<string>(),
        codeVerifiers: new Map(),
        redirected: false,
      };
      return flow;
    };

    const persist = async (change: Partial<McpOAuthRecord>): Promise<void> => {
      await store.mutateRecord(key, (current) => ({
        ...(current ?? { updated_at: Date.now() }),
        ...change,
        redirect_url: redirectUrl,
        updated_at: Date.now(),
      }));
    };

    const clientMetadata: OAuthClientMetadata = {
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      software_id: "getclarvis/clarvis",
      software_version: VERSION,
    };

    const provider: OAuthClientProvider = {
      redirectUrl,
      clientMetadata,
      state: () => activeFlow().state,
      clientInformation: () => clientInformation,
      async saveClientInformation(value): Promise<void> {
        clientInformation = value;
        await persist({ client_information: value });
      },
      tokens: () => tokens,
      async saveTokens(value): Promise<void> {
        tokens = value;
        await persist({
          tokens: value,
          ...(clientInformation === undefined ? {} : { client_information: clientInformation }),
        });
      },
      async redirectToAuthorization(authorizationUrl): Promise<void> {
        const current = activeFlow();
        if (current.redirected) return;
        if (options.openAuthorizationUrl === undefined) {
          throw new MCPInteractiveAuthorizationUnavailableError();
        }
        if (
          authorizationUrl.href.length > MAX_CALLBACK_URL_CHARS ||
          !oauthUrlIsSecure(authorizationUrl)
        ) {
          throw new MCPAuthorizationFailedError(
            "The MCP authorization URL must use HTTPS or a loopback HTTP origin.",
          );
        }
        const challenge = authorizationUrl.searchParams.get("code_challenge");
        const verifier =
          challenge === null ? current.latestCodeVerifier : current.codeVerifiers.get(challenge);
        if (verifier === undefined) {
          throw new MCPAuthorizationFailedError(
            "The MCP authorization request has no matching PKCE verifier.",
          );
        }
        current.codeVerifier = verifier;
        current.codeVerifiers.clear();
        delete current.latestCodeVerifier;
        current.redirected = true;
        pending.set(current.state, {
          state: current.state,
          resolve: (code) => current.callback.resolve(code),
          reject: (error) => current.callback.reject(error),
        });
        let opened: boolean;
        try {
          opened = await options.openAuthorizationUrl(authorizationUrl.href);
        } catch {
          pending.delete(current.state);
          if (flow === current) flow = undefined;
          throw new MCPInteractiveAuthorizationUnavailableError(
            "Clarvis could not open the MCP authorization page in a browser.",
          );
        }
        if (!opened) {
          pending.delete(current.state);
          if (flow === current) flow = undefined;
          throw new MCPInteractiveAuthorizationUnavailableError(
            "Clarvis could not open the MCP authorization page in a browser.",
          );
        }
      },
      saveCodeVerifier(value): void {
        const current = activeFlow();
        if (current.redirected) return;
        current.latestCodeVerifier = value;
        current.codeVerifiers.set(codeChallenge(value), value);
      },
      codeVerifier(): string {
        if (flow?.codeVerifier === undefined) {
          throw new MCPAuthorizationFailedError("The MCP OAuth verifier is unavailable.");
        }
        return flow.codeVerifier;
      },
      async invalidateCredentials(kind): Promise<void> {
        if (kind === "verifier") {
          if (flow !== undefined) {
            delete flow.codeVerifier;
            delete flow.latestCodeVerifier;
            flow.codeVerifiers.clear();
          }
          return;
        }
        if (kind === "tokens" || kind === "all") tokens = undefined;
        if (kind === "client" || kind === "all") clientInformation = undefined;
        if (kind === "discovery") return;
        await store.mutateRecord(key, (current) => {
          if (current === undefined) return undefined;
          const next: McpOAuthRecord = { ...current, updated_at: Date.now() };
          if (kind === "tokens" || kind === "all") delete next.tokens;
          if (kind === "client" || kind === "all") delete next.client_information;
          return next.tokens === undefined && next.client_information === undefined
            ? undefined
            : next;
        });
      },
    };

    return {
      key,
      provider,
      async finishAuthorization(transport, signal): Promise<void> {
        const current = flow;
        if (current === undefined || !current.redirected) {
          throw new MCPAuthorizationFailedError("The MCP server did not begin authorization.");
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            pending.delete(current.state);
            reject(
              new MCPAuthorizationFailedError(
                "MCP OAuth authorization did not finish before its timeout.",
              ),
            );
          }, authorizationTimeoutMs);
          timer.unref?.();
        });
        try {
          const code = await waitAbortable(
            Promise.race([current.callback.promise, timeout]),
            signal,
          );
          await transport.finishAuth(code);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          pending.delete(current.state);
          delete current.codeVerifier;
          delete current.latestCodeVerifier;
          current.codeVerifiers.clear();
          if (flow === current) flow = undefined;
        }
      },
    };
  };

  return {
    key: recordKey,
    session: makeSession,
    async runExclusive<T>(
      key: string,
      signal: AbortSignal | undefined,
      onWaitStart: (() => void) | undefined,
      onWaitEnd: (() => void) | undefined,
      run: () => Promise<T>,
    ): Promise<T> {
      const predecessor = tails.get(key);
      const gate = deferred<void>();
      const before = predecessor?.catch(() => undefined) ?? Promise.resolve();
      const tail = before.then(() => gate.promise);
      tails.set(key, tail);
      const releaseTail = (): void => {
        if (tails.get(key) === tail) tails.delete(key);
      };
      tail.then(releaseTail, releaseTail);
      try {
        if (predecessor !== undefined) {
          onWaitStart?.();
          try {
            await waitAbortable(before, signal);
          } finally {
            onWaitEnd?.();
          }
        }
        if (signal?.aborted) throw abortError(signal);
        return await run();
      } finally {
        gate.resolve();
      }
    },
    close(): Promise<void> {
      closePromise ??= (async (): Promise<void> => {
        closed = true;
        const error = new MCPAuthorizationFailedError("MCP OAuth authorization was cancelled.");
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
        const starting = startPromise;
        if (starting !== undefined) {
          try {
            await starting;
          } catch {}
        }
        const server = callbackServer;
        callbackServer = undefined;
        callbackUrl = undefined;
        if (server === undefined || !server.listening) return;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
      return closePromise;
    },
  };
}

interface AuthorizationFlow {
  state: string;
  callback: ReturnType<typeof deferred<string>>;
  codeVerifiers: Map<string, string>;
  codeVerifier?: string;
  latestCodeVerifier?: string;
  redirected: boolean;
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
