import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { NOOP_LOGGER, bind, resolveStringMap } from "@clarvis/capability";
import type { Logger, McpServerConfig } from "@clarvis/capability";
import { CLIENT_NAME, VERSION } from "./version.ts";
import { BunStdioClientTransport } from "./bun-stdio-client.ts";
import { createMCPBoundedFetch } from "./bounded-fetch.ts";
import { createMCPRemoteFetch } from "./remote-fetch.ts";
import {
  createServerStderrForwarder,
  drainStderrStream,
  type ServerStderrSink,
} from "./server-stderr.ts";
import type {
  MCPAuthorizationCoordinator,
  MCPAuthorizationSession,
  OAuthFinishingTransport,
} from "./oauth.ts";
import { MCPAuthorizationPendingError } from "./oauth.ts";
import type { PoolScope } from "./connection.ts";

/**
 * A host's answer to a server-initiated elicitation: the user's action and any
 * collected `content`, shaped to the MCP `ElicitResult`.
 */
export interface ElicitationRelayResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/**
 * Host-supplied bridge for MCP elicitation requests: `handle` is invoked with
 * the server's request params (and an abort `signal`) and resolves the user's
 * decision. Supplying a relay advertises the `elicitation` capability to the
 * server; omitting it means the client declines to elicit.
 */
export interface ElicitationRelay {
  handle: (
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ElicitationRelayResult>;
}

/** A live MCP SDK {@link Client} paired with an idempotent `close`. */
export interface MCPClientHandle {
  client: Client;
  close: () => Promise<void>;
  /**
   * The MCP protocol version the handshake settled on, when the transport
   * reported one.
   *
   * @remarks The SDK hands the negotiated version to the transport and exposes
   *   no getter for it, so a factory that wants to report it has to observe
   *   `setProtocolVersion`. Optional because a substituted factory need not.
   */
  protocolVersion?: string;
}

/** Whether a caller waits for browser OAuth or lets it continue independently. */
export type MCPAuthorizationWait = "blocking" | "background";

/** Connect-time tuning, identity, and human-authorization controls. */
export interface MCPConnectOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Owner/workspace boundary used to isolate persistent remote OAuth credentials. */
  scope?: PoolScope;
  /** Pauses the caller's connect budget while a person authorizes in a browser. */
  onAuthorizationWaitStart?: () => void;
  /** Resumes that budget after the browser wait, on success or failure. */
  onAuthorizationWaitEnd?: () => void;
  /** `background` makes an opened browser flow inactive for this caller instead of awaiting it. */
  authorizationWait?: MCPAuthorizationWait;
}

/**
 * Pluggable constructor of {@link MCPClientHandle}s from a server config — the
 * seam tests substitute to avoid spawning real servers.
 * {@link defaultMCPClientFactory} is the production implementation.
 */
export type MCPClientFactory = (
  server: McpServerConfig,
  relay?: ElicitationRelay,
  opts?: MCPConnectOptions,
) => Promise<MCPClientHandle>;

/** Raw environment lookup used for interpolation and spawned MCP processes. */
export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The production {@link MCPClientFactory}: builds the transport for `server`,
 * connects an MCP SDK {@link Client}, and (when a `relay` is given) registers an
 * elicitation request handler that forwards to it.
 *
 * @param server - the server to connect to.
 * @param relay - optional elicitation bridge; its presence advertises the
 *   `elicitation` capability.
 * @param opts - optional connect `signal`/`timeoutMs`.
 * @returns the connected client handle.
 * @throws whatever {@link buildTransport} or the SDK `connect` throws (e.g. a
 *   missing `command`/`url`).
 */
export const defaultMCPClientFactory: MCPClientFactory = createMCPClientFactory(process.env);

/**
 * Options for {@link createMCPClientFactory}.
 */
export interface MCPClientFactoryOptions {
  /** Working directory for a stdio server that declares no `cwd` of its own.
   *
   * @remarks Without it a stdio child inherits the host process's cwd, so a
   *   server that resolves relative paths is rooted wherever the host happened to
   *   be launched from rather than in the workspace it is serving. Hosts pass the
   *   workspace root. A server's own `cwd` still wins. */
  defaultCwd?: string;
  /** Largest newline-delimited JSON-RPC frame accepted from a Bun stdio peer. */
  maxStdioFrameBytes?: number;
  /** Largest HTTP/SSE response accepted before the MCP SDK parses it. */
  maxHttpResponseBytes?: number;
  /** Largest unterminated SSE event accepted from a remote MCP peer. */
  maxHttpSseEventBytes?: number;
  /**
   * Where a stdio server's own stderr goes, one whole line at a time.
   *
   * @remarks Omit it and the child's stderr reaches the host process's stderr
   *   unchanged, which is what happened for every server until this existed: the
   *   transport's `onStderr` hook was declared and no caller passed one. A host
   *   whose stdout or stderr is a rendered surface must supply a sink.
   */
  onServerStderr?: ServerStderrSink;
  /** Ceiling on forwarded stderr per connection; see {@link DEFAULT_SERVER_STDERR_MAX_BYTES}. */
  maxServerStderrBytes?: number;
  /**
   * Where transport-level refusals are reported.
   *
   * @remarks The factory binds `mcp` and `transport` onto it per server, so a
   *   host passes the one logger it already has.
   */
  logger?: Logger;
  /** Persistent interactive authorization for remote HTTP/SSE servers. */
  authorization?: MCPAuthorizationCoordinator;
}

interface BuiltClient {
  client: Client;
  transport: Transport;
  handle: MCPClientHandle;
}

function finishingTransport(transport: Transport): OAuthFinishingTransport | undefined {
  const candidate = transport as Transport & Partial<OAuthFinishingTransport>;
  return typeof candidate.finishAuth === "function"
    ? (candidate as OAuthFinishingTransport)
    : undefined;
}

async function closeFailedClient(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {}
}

/**
 * Build an MCP client factory bound to one immutable environment view.
 *
 * @param environment - values used for interpolation and child processes.
 * @param options - optional factory-wide defaults; see
 *   {@link MCPClientFactoryOptions}.
 * @returns the production MCP client factory using only that environment.
 * @remarks A pooled connection is opened without a `relay`, so it advertises no
 *   `elicitation` capability: a shared subprocess outlives any one run and may
 *   serve several at once, so there is no single human it could be routed to.
 */
export function createMCPClientFactory(
  environment: RuntimeEnvironment,
  options?: MCPClientFactoryOptions,
): MCPClientFactory {
  const root = options?.logger ?? NOOP_LOGGER;
  return async (server, relay, opts) => {
    const logger = bind(root, { mcp: server.name, transport: server.transport });
    const buildClient = (authProvider?: OAuthClientProvider): BuiltClient => {
      const client = new Client(
        { name: CLIENT_NAME, version: VERSION },
        { capabilities: relay ? { elicitation: {} } : {} },
      );

      if (relay) {
        client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
          const result = await relay.handle(request.params, extra.signal);
          return result as unknown as ElicitResult;
        });
      }

      const transport: Transport = buildTransport(server, environment, options?.defaultCwd, {
        ...(options?.maxStdioFrameBytes !== undefined
          ? { maxStdioFrameBytes: options.maxStdioFrameBytes }
          : {}),
        ...(options?.maxHttpResponseBytes !== undefined
          ? { maxHttpResponseBytes: options.maxHttpResponseBytes }
          : {}),
        ...(options?.maxHttpSseEventBytes !== undefined
          ? { maxHttpSseEventBytes: options.maxHttpSseEventBytes }
          : {}),
        ...(options?.onServerStderr !== undefined
          ? { onServerStderr: options.onServerStderr }
          : {}),
        ...(options?.maxServerStderrBytes !== undefined
          ? { maxServerStderrBytes: options.maxServerStderrBytes }
          : {}),
        ...(authProvider === undefined ? {} : { authProvider }),
        logger,
      });
      let protocolVersion: string | undefined;
      const reported = transport.setProtocolVersion?.bind(transport);
      transport.setProtocolVersion = (version: string): void => {
        protocolVersion = version;
        reported?.(version);
      };
      const handle: MCPClientHandle = {
        client,
        close: async () => {
          await client.close();
        },
        get protocolVersion(): string | undefined {
          return protocolVersion;
        },
      };
      return { client, transport, handle };
    };
    const connectBuilt = async (
      built: BuiltClient,
      signal: AbortSignal | undefined = opts?.signal,
    ): Promise<MCPClientHandle> => {
      await built.client.connect(built.transport, {
        ...(signal ? { signal } : {}),
        ...(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
      });
      return built.handle;
    };
    const connectOnce = async (
      authProvider?: OAuthClientProvider,
      boundary?: AuthorizationBoundary,
      signal: AbortSignal | undefined = opts?.signal,
    ): Promise<MCPClientHandle> => {
      const built = buildClient(authProvider);
      if (authorization !== undefined && boundary !== undefined) {
        attachAuthorization(built, authorization, boundary, opts?.authorizationWait);
      }
      try {
        return await connectBuilt(built, signal);
      } catch (error) {
        await closeFailedClient(built.client);
        throw error;
      }
    };

    const authorization = options?.authorization;
    if (authorization === undefined || server.transport === "stdio" || server.url === undefined) {
      return connectOnce();
    }
    if (opts?.scope === undefined) {
      throw new Error(`server '${server.name}': remote OAuth requires a connection scope`);
    }

    const key = authorization.key(opts.scope, server.url);
    const authorize = (
      onWaitStart: (() => void) | undefined,
      onWaitEnd: (() => void) | undefined,
      authorizationSignal: AbortSignal | undefined,
    ): Promise<MCPClientHandle> =>
      authorization.runExclusive(
        key,
        authorizationSignal,
        onWaitStart,
        onWaitEnd,
        async (): Promise<MCPClientHandle> => {
          const session: MCPAuthorizationSession = await authorization.session(
            opts.scope!,
            server.url!,
          );
          const boundary: AuthorizationBoundary = [session, key, server.name];
          const first = buildClient(session.provider);
          attachAuthorization(first, authorization, boundary, opts.authorizationWait);
          try {
            return await connectBuilt(first);
          } catch (error) {
            if (!(error instanceof UnauthorizedError)) {
              await closeFailedClient(first.client);
              throw error;
            }

            const finisher = finishingTransport(first.transport);
            if (finisher === undefined) {
              await closeFailedClient(first.client);
              throw new Error(`server '${server.name}': remote transport cannot finish OAuth`, {
                cause: error,
              });
            }
            onWaitStart?.();
            try {
              await session.finishAuthorization(finisher, authorizationSignal);
            } finally {
              onWaitEnd?.();
              await closeFailedClient(first.client);
            }
            return connectOnce(session.provider, boundary, authorizationSignal);
          }
        },
      );

    if (opts.authorizationWait !== "background") {
      return authorize(opts.onAuthorizationWaitStart, opts.onAuthorizationWaitEnd, opts.signal);
    }

    let announcePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      announcePending = resolve;
    });
    let announced = false;
    const attempt = authorize(
      () => {
        if (announced) return;
        announced = true;
        announcePending();
      },
      undefined,
      undefined,
    );
    const outcome = await Promise.race([
      attempt.then(
        (handle) => ({ kind: "connected" as const, handle }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      pending.then(() => ({ kind: "pending" as const })),
    ]);
    if (outcome.kind === "connected") return outcome.handle;
    if (outcome.kind === "failed") throw outcome.error;

    const completion = attempt.then(async (handle) => {
      await handle.close();
    });
    void completion.catch(() => undefined);
    throw new MCPAuthorizationPendingError(completion);
  };
}

/**
 * Build the MCP SDK {@link Transport} for a server config, selecting by
 * `transport`.
 *
 * @param server - the server config.
 * @param environment - values used for `${VAR}` interpolation and, for stdio, the
 *   child's environment.
 * @param defaultCwd - working directory for a stdio child that declares no `cwd`;
 *   absent, the child inherits the host process's.
 * @returns a stdio transport for `stdio` (the Bun-native
 *   {@link BunStdioClientTransport} when running under Bun, else the SDK's
 *   {@link StdioClientTransport}), a {@link StreamableHTTPClientTransport} for
 *   `http`, or an {@link SSEClientTransport} for `sse`.
 * @throws {@link Error} if a stdio server omits `command`, or an http/sse server
 *   omits `url`.
 * @remarks
 * For stdio, the child's environment is always {@link getDefaultEnvironment}
 * with the interpolated `env` block layered over it — never the caller's own
 * environment. That matters because `environment` carries resolved provider API
 * keys: handing it to a child would give every configured MCP server every
 * credential on the host, and a server that names nothing in `env` is exactly
 * the one with no business seeing any of them. Declaring `env` therefore *adds*
 * to a fixed safe base rather than switching the child from "inherit
 * everything" to "inherit a filtered set".
 *
 * The consequence is deliberate and is a breaking change: a server that used to
 * work by inheriting an extended `PATH`, `NODE_OPTIONS`, or a token exported in
 * the user's shell must now name it in `env` (`"${MY_TOKEN}"` still interpolates
 * from `environment`, so the value need not be duplicated).
 *
 * For http/sse, interpolated `headers` are injected by the wrapping `fetch`
 * only for MCP resource requests on the configured origin. OAuth discovery,
 * registration, and token requests do not inherit them, and an SDK-defined
 * header always wins. `${VAR}` references in `env` and `headers` resolve against
 * `environment` and throw {@link MissingEnvVarsError} when unset unless
 * `server.expandVariables === false`; that mode preserves package-owned literal
 * values after a portable format adapter has performed its own bounded expansion.
 */
export function buildTransport(
  server: McpServerConfig,
  environment: RuntimeEnvironment = process.env,
  defaultCwd?: string,
  limits: {
    maxStdioFrameBytes?: number;
    maxHttpResponseBytes?: number;
    maxHttpSseEventBytes?: number;
    onServerStderr?: ServerStderrSink;
    maxServerStderrBytes?: number;
    logger?: Logger;
    authProvider?: OAuthClientProvider;
  } = {},
):
  | BunStdioClientTransport
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | SSEClientTransport {
  if (server.transport === "stdio") {
    if (!server.command) {
      throw new Error(`server '${server.name}': command is required for stdio transport`);
    }
    const customEnv = server.env
      ? server.expandVariables === false
        ? { ...server.env }
        : resolveStringMap(server.env, environment)
      : undefined;
    const cwd = server.cwd ?? defaultCwd;
    const forwarder =
      limits.onServerStderr === undefined
        ? undefined
        : createServerStderrForwarder({
            mcp: server.name,
            sink: limits.onServerStderr,
            ...(limits.maxServerStderrBytes !== undefined
              ? { maxBytes: limits.maxServerStderrBytes }
              : {}),
          });
    const parameters = {
      command: server.command,
      args: server.args ?? [],
      env: { ...getDefaultEnvironment(), ...customEnv },
      ...(cwd !== undefined ? { cwd } : {}),
      ...(limits.maxStdioFrameBytes !== undefined
        ? { maxFrameBytes: limits.maxStdioFrameBytes }
        : {}),
    };
    if (typeof Bun !== "undefined") {
      return new BunStdioClientTransport({
        ...parameters,
        ...(limits.logger !== undefined ? { logger: limits.logger } : {}),
        ...(forwarder
          ? {
              onStderr: (text: string) => {
                forwarder.push(text);
              },
              onStderrEnd: () => {
                forwarder.flush();
              },
            }
          : {}),
      });
    }
    const transport = new StdioClientTransport({
      ...parameters,
      ...(forwarder ? { stderr: "pipe" as const } : {}),
    });
    if (forwarder) drainStderrStream(transport.stderr, forwarder);
    return transport;
  }
  if (!server.url) {
    throw new Error(`server '${server.name}': url is required for ${server.transport} transport`);
  }
  const url = new URL(server.url);
  const headers = server.headers
    ? server.expandVariables === false
      ? { ...server.headers }
      : resolveStringMap(server.headers, environment)
    : undefined;
  const remoteFetch = createMCPRemoteFetch({
    resourceUrl: url,
    authorization: limits.authProvider !== undefined,
    ...(headers ? { headers } : {}),
  });
  const boundedFetch: FetchLike = createMCPBoundedFetch({
    mcpName: server.name,
    fetch: remoteFetch,
    ...(limits.logger !== undefined ? { logger: limits.logger } : {}),
    ...(limits.maxHttpResponseBytes !== undefined
      ? { maxResponseBytes: limits.maxHttpResponseBytes }
      : {}),
    ...(limits.maxHttpSseEventBytes !== undefined
      ? { maxSseEventBytes: limits.maxHttpSseEventBytes }
      : {}),
  });
  const opts: { fetch: FetchLike; authProvider?: OAuthClientProvider } = {
    fetch: boundedFetch,
    ...(limits.authProvider === undefined ? {} : { authProvider: limits.authProvider }),
  };
  return server.transport === "http"
    ? new StreamableHTTPClientTransport(url, opts)
    : new SSEClientTransport(url, opts);
}

type AuthorizationBoundary = readonly [
  session: MCPAuthorizationSession,
  key: string,
  serverName: string,
];
type AuthorizedRequest = <T>(request: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

const authorizedRequests = new WeakMap<MCPClientHandle, AuthorizedRequest>();

/** Run an SDK request through a production handle's late-authorization boundary. */
export function runMCPRequest<T>(
  handle: MCPClientHandle,
  request: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return authorizedRequests.get(handle)?.(request, signal) ?? request();
}

function authorizationAbort(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("MCP OAuth authorization was cancelled.", "AbortError");
}

function waitForAuthorization(
  promise: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(authorizationAbort(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(authorizationAbort(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function attachAuthorization(
  built: BuiltClient,
  authorization: MCPAuthorizationCoordinator,
  [session, key, serverName]: AuthorizationBoundary,
  authorizationWait: MCPAuthorizationWait = "blocking",
): void {
  let finishing: Promise<void> | undefined;
  authorizedRequests.set(
    built.handle,
    async <T>(request: () => Promise<T>, signal?: AbortSignal) => {
      try {
        return await request();
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error;
        const finisher = finishingTransport(built.transport);
        if (finisher === undefined) {
          throw new Error(`server '${serverName}': remote transport cannot finish OAuth`, {
            cause: error,
          });
        }
        const background = authorizationWait === "background";
        finishing ??= authorization
          .runExclusive(key, background ? undefined : signal, undefined, undefined, () =>
            session.finishAuthorization(finisher, background ? undefined : signal),
          )
          .finally(() => {
            finishing = undefined;
          });
        if (authorizationWait === "background") {
          const completion = finishing;
          void completion.catch(() => undefined);
          throw new MCPAuthorizationPendingError(completion);
        }
        await waitForAuthorization(finishing, signal);
        return request();
      }
    },
  );
}
