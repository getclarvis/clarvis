import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { PoolScope } from "./connection.ts";
import type { McpOAuthConfig } from "@clarvis/capability";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { CLIENT_NAME, VERSION } from "./version.ts";
import {
  createMcpOAuthCredentialStore,
  type McpOAuthCredentialStore,
  type McpOAuthRecord,
} from "./oauth-store.ts";

/** An ephemeral listener is the safe default for loopback OAuth callbacks. */
export const DEFAULT_MCP_OAUTH_CALLBACK_PORT = 0;
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

/** Browser authorization is continuing without holding the current run. */
export class MCPAuthorizationPendingError extends Error {
  readonly code = "mcp_oauth_authorization_pending" as const;

  constructor(readonly completion: Promise<void> = Promise.resolve()) {
    super(
      "MCP OAuth authorization is continuing in the browser; this MCP is inactive for the current run.",
    );
    this.name = "MCPAuthorizationPendingError";
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
  /** Global callback base used when one server does not declare its own. */
  callbackUrl?: string;
  /** Public HTTPS client-metadata document used when a server advertises CIMD. */
  clientMetadataUrl?: string;
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
  key(scope: PoolScope, serverUrl: string, oauth?: McpOAuthConfig): string;
  session(
    scope: PoolScope,
    serverUrl: string,
    oauth?: McpOAuthConfig,
  ): Promise<MCPAuthorizationSession>;
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
  pathname: string;
  expectedIssuer?: string;
  issuerRequired: boolean;
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

function recordKey(scope: PoolScope, serverUrl: string, oauth?: McpOAuthConfig): string {
  const resource = new URL(serverUrl).href;
  return createHash("sha256")
    .update(scope.workspace)
    .update("\0")
    .update(scope.owner)
    .update("\0")
    .update(resource)
    .update("\0")
    .update(
      JSON.stringify({
        client_id: oauth?.client_id ?? null,
        callback_url: oauth?.callback_url ?? null,
        callback_port: oauth?.callback_port ?? null,
        client_metadata_url: oauth?.client_metadata_url ?? null,
      }),
    )
    .digest("hex");
}

function callbackId(serverUrl: string): string {
  return createHash("sha256").update(new URL(serverUrl).href).digest("base64url").slice(0, 12);
}

function withCallbackId(raw: string, id: string): string {
  const url = new URL(raw);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${id}`;
  return url.href;
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
 * session's selected callback path and validates a 256-bit state before
 * resolving a flow.
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
  const callbackServers = new Set<Server>();
  const listenerStarts = new Map<string, Promise<number>>();
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const handleCallback = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET" || req.url === undefined || req.url.length > MAX_CALLBACK_URL_CHARS) {
      failurePage(res, 404);
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      failurePage(res);
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    if (state.length === 0 || state.length > MAX_STATE_CHARS) {
      failurePage(res);
      return;
    }
    const found = [...pending.values()].find(
      (entry) => entry.pathname === url.pathname && stateMatches(entry.state, state),
    );
    if (found === undefined) {
      failurePage(res);
      return;
    }
    pending.delete(found.state);
    const receivedIssuer = url.searchParams.get("iss");
    if (
      found.expectedIssuer !== undefined &&
      (receivedIssuer !== null || found.issuerRequired) &&
      receivedIssuer !== found.expectedIssuer
    ) {
      found.reject(
        new MCPAuthorizationFailedError("The authorization callback issuer did not match."),
      );
      failurePage(res);
      return;
    }
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

  const listen = (server: Server, port: number, host: string): Promise<void> =>
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
      server.listen(port, host);
    });

  const ensureServer = async (
    oauth?: McpOAuthConfig,
  ): Promise<{ callbackBase: string; configuredCallback?: string; listenerPort: number }> => {
    if (closed) throw new MCPAuthorizationFailedError("MCP OAuth coordinator is closed.");
    const configuredCallback = oauth?.callback_url ?? options.callbackUrl;
    const baseUrl = new URL(
      configuredCallback ?? options.callbackUrl ?? "http://127.0.0.1/callback",
    );
    if (
      !oauthUrlIsSecure(baseUrl) ||
      baseUrl.username.length > 0 ||
      baseUrl.password.length > 0 ||
      baseUrl.hash.length > 0
    ) {
      throw new Error(
        "MCP OAuth callback URL must use HTTPS or loopback HTTP without credentials.",
      );
    }
    const hostname = baseUrl.hostname;
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(hostname.toLowerCase());
    const bindHost = local ? (hostname === "[::1]" ? "::1" : "127.0.0.1") : "0.0.0.0";
    const requestedPort = oauth?.callback_port ?? preferredPort;
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
      throw new Error("MCP OAuth callback port must be an integer from 0 through 65535.");
    }
    if (local && baseUrl.port.length > 0 && Number(baseUrl.port) !== requestedPort) {
      throw new Error(
        "A loopback OAuth callback URL with an explicit port requires the same callback_port.",
      );
    }
    if (local && baseUrl.port.length === 0 && hostname !== "127.0.0.1") {
      throw new Error("Only http://127.0.0.1 supports a portless loopback OAuth callback URL.");
    }
    const listenerKey = `${bindHost}\0${String(requestedPort)}`;
    let start = listenerStarts.get(listenerKey);
    start ??= (async () => {
      const server = createServer(handleCallback);
      callbackServers.add(server);
      try {
        await listen(server, requestedPort, bindHost);
      } catch (error) {
        callbackServers.delete(server);
        throw error;
      }
      const address = server.address() as AddressInfo | null;
      if (address === null) throw new Error("MCP OAuth callback listener has no address");
      return address.port;
    })();
    listenerStarts.set(listenerKey, start);
    let actualPort: number;
    try {
      actualPort = await start;
    } catch (error) {
      if (listenerStarts.get(listenerKey) === start) listenerStarts.delete(listenerKey);
      throw error;
    }
    if (closed) throw new MCPAuthorizationFailedError("MCP OAuth coordinator is closed.");
    if (local && baseUrl.hostname === "127.0.0.1" && baseUrl.port.length === 0) {
      baseUrl.port = String(actualPort);
    }
    return {
      callbackBase: baseUrl.href,
      ...(configuredCallback === undefined ? {} : { configuredCallback: baseUrl.href }),
      listenerPort: actualPort,
    };
  };

  const makeSession = async (
    scope: PoolScope,
    serverUrl: string,
    oauth?: McpOAuthConfig,
  ): Promise<MCPAuthorizationSession> => {
    const callback = await ensureServer(oauth);
    const key = recordKey(scope, serverUrl, oauth);
    const stored = await store.readRecord(key);
    if (closed) throw new MCPAuthorizationFailedError("MCP OAuth coordinator is closed.");
    const configuredClient =
      oauth?.client_id === undefined ? undefined : { client_id: oauth.client_id };
    const id = callbackId(serverUrl);
    let savedClientInformation: McpOAuthRecord["client_information"];
    let tokens = stored?.tokens;
    let flow: AuthorizationFlow | undefined;
    let discoveryState: OAuthDiscoveryState | undefined;

    const issuerMetadata = (): {
      supported: boolean;
      issuer?: string;
    } => {
      const metadata = discoveryState?.authorizationServerMetadata as
        | ({ issuer?: unknown; authorization_response_iss_parameter_supported?: unknown } & Record<
            string,
            unknown
          >)
        | undefined;
      const supported = metadata?.authorization_response_iss_parameter_supported === true;
      const issuer = typeof metadata?.issuer === "string" ? metadata.issuer : undefined;
      if (supported && issuer === undefined) {
        throw new MCPAuthorizationFailedError(
          "The authorization server advertised issuer-bound responses without an issuer.",
        );
      }
      return { supported, ...(issuer === undefined ? {} : { issuer }) };
    };

    const redirectUrl = (): string => {
      const { supported } = issuerMetadata();
      const configured = callback.configuredCallback;
      if (configuredClient !== undefined && configured === undefined) {
        return withCallbackId(callback.callbackBase, id);
      }
      if (configured !== undefined && configuredClient === undefined) {
        return supported ? configured : withCallbackId(configured, id);
      }
      if (configured !== undefined && configuredClient !== undefined) {
        if (supported || new URL(configured).pathname.endsWith(`/${id}`)) return configured;
        const fallback = new URL(options.callbackUrl ?? "http://127.0.0.1/callback");
        if (fallback.hostname === "127.0.0.1" && fallback.port.length === 0) {
          fallback.port = String(callback.listenerPort);
        }
        return withCallbackId(fallback.href, id);
      }
      return withCallbackId(callback.callbackBase, id);
    };

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
        redirect_url: redirectUrl(),
        updated_at: Date.now(),
      }));
    };

    const clientMetadata = (): OAuthClientMetadata => ({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUrl()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      software_id: "getclarvis/clarvis",
      software_version: VERSION,
    });

    const provider: OAuthClientProvider = {
      get redirectUrl(): string {
        return redirectUrl();
      },
      ...((oauth?.client_metadata_url ?? options.clientMetadataUrl)
        ? { clientMetadataUrl: oauth?.client_metadata_url ?? options.clientMetadataUrl }
        : {}),
      get clientMetadata(): OAuthClientMetadata {
        return clientMetadata();
      },
      state: () => activeFlow().state,
      clientInformation: () =>
        configuredClient ??
        savedClientInformation ??
        (stored?.redirect_url === redirectUrl() ? stored.client_information : undefined),
      async saveClientInformation(value): Promise<void> {
        savedClientInformation = value;
        await persist({ client_information: value });
      },
      tokens: () => tokens,
      async saveTokens(value): Promise<void> {
        tokens = value;
        await persist({
          tokens: value,
          ...(savedClientInformation === undefined
            ? {}
            : { client_information: savedClientInformation }),
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
        const { issuer: expectedIssuer, supported } = issuerMetadata();
        const currentRedirect = redirectUrl();
        pending.set(current.state, {
          state: current.state,
          pathname: new URL(currentRedirect).pathname,
          ...(expectedIssuer === undefined ? {} : { expectedIssuer }),
          issuerRequired: supported,
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
        if (kind === "client" || kind === "all") savedClientInformation = undefined;
        if (kind === "discovery" || kind === "all") discoveryState = undefined;
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
      saveDiscoveryState(value): void {
        discoveryState = value;
      },
      discoveryState: () => discoveryState,
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
        await Promise.allSettled(listenerStarts.values());
        await Promise.all(
          [...callbackServers].map(
            (server) =>
              new Promise<void>((resolve) => {
                if (!server.listening) {
                  resolve();
                  return;
                }
                server.close(() => resolve());
              }),
          ),
        );
        callbackServers.clear();
        listenerStarts.clear();
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
