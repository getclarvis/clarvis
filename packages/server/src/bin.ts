#!/usr/bin/env bun

import {
  createKernelEnvironment,
  createFileKernel,
  createLogger,
  createOwnerScopedFileStores,
  loadEnv,
  resolveSecretEnvironment,
} from "@clarvis/kernel/bootstrap";
import { createAuditLogger, createComponentLoggers, createFileSecretStore } from "@clarvis/kernel";
import { bind } from "@clarvis/capability";
import { globalPaths, globalRoot, workspaceRoot as workspaceRoot_ } from "@clarvis/paths";
import { createAuthLayer, type AuthLayer } from "./auth/bootstrap.ts";
import { generateClientSecret, hashClientSecret } from "./auth/secrets.ts";
import { isPrivateBind, isPrivateLanBind, loadServerEnv, type ServerEnv } from "./config/env.ts";
import { createConnectionHealth } from "./health/connection-health.ts";
import { isDefaultModelReady } from "./health/model-readiness.ts";
import { ownerScopedKernelResolver } from "./host/owner-scoping.ts";
import { serveClarvisMcpOverHttp, type ServeHandle } from "./http/serve.ts";
import { createServerLoggers, newInstanceId } from "./logging.ts";
import { observeServerTask, setServerTaskObserver } from "./tasks.ts";
import { PRODUCT_VERSION } from "./version.ts";

/** The `service` every record this process writes is tagged with. */
const SERVICE = "@clarvis/server";

/** Read a `--flag value` pair from argv. */
function flag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

/** Whether a boolean `--flag` is present. */
function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** Text printed for `--help`. */
const USAGE = `clarvis-server — MCP over Streamable HTTP for the Clarvis loop

  clarvis-server [options]
  clarvis-server hash-secret [secret]   hash a client secret for auth.json

  --workspace <path>   agent working tree      (CLARVIS_WORKSPACE_ROOT, default cwd)
  --config <path>      Clarvis global root     (CLARVIS_HOME, default ~/.clarvis)
  --host <addr>        bind address            (CLARVIS_SERVER_HOST, default 127.0.0.1)
  --port <n>           bind port               (PORT / CLARVIS_SERVER_PORT, default 8080)
  --path <p>           MCP endpoint path       (CLARVIS_SERVER_PATH, default /mcp)
  --owner-mode <m>     fixed|header|allowlist|token
                                               (CLARVIS_SERVER_OWNER_MODE, default fixed)
  --auth <m>           off|required            (CLARVIS_SERVER_AUTH, default off)
  --auth-file <path>   enrolment table         (CLARVIS_SERVER_AUTH_FILE, default <config>/auth.json)
  --public-url <url>   URL clients reach       (CLARVIS_SERVER_PUBLIC_URL)
  --memory             enable the memory subsystem
  --allow-lan-bind     permit an RFC1918 local-network bind address
  --allow-public-bind  permit a non-private bind address
  --grace-ms <n>       drain budget on SIGTERM (CLARVIS_SERVER_SHUTDOWN_GRACE_MS)
  --log-level <l>      debug|info|warn|error|silent
                                               (CLARVIS_LOG_LEVEL, default info)
  --help, --version


The command guard is on unless settings.json says otherwise, and this facade
answers its confirmations with a decline, so configure guard.allowed_commands
as part of deployment or every command a run attempts will be refused.
`;

/**
 * Print a client secret and its digest, for pasting into `auth.json`.
 *
 * @param supplied - a secret to hash; one is generated when absent.
 * @remarks The plaintext is printed exactly once and never stored — enrolment is
 * a file the operator edits, and this subcommand exists so that file never holds
 * a secret in the clear.
 */
function hashSecretCommand(supplied: string | undefined): void {
  const secret = supplied ?? generateClientSecret();
  const hash = hashClientSecret(secret);
  process.stdout.write(
    `client_secret (store it in the calling application; it is not recoverable):\n  ${secret}\n\n` +
      `secret_hash (paste into auth.json):\n  ${hash}\n`,
  );
}

/**
 * Boot the server: bind first, construct the kernel, then flip readiness on.
 *
 * @remarks Binding before the kernel is deliberate. Kernel construction runs the
 * first trace-retention sweep synchronously, which on a large mounted trace
 * volume can take long enough that a liveness probe would kill the container
 * before it ever listened.
 */
async function main(argv: string[]): Promise<void> {
  if (has(argv, "help")) {
    process.stdout.write(USAGE);
    return;
  }
  if (has(argv, "version")) {
    process.stdout.write(`${PRODUCT_VERSION}\n`);
    return;
  }
  if (argv[0] === "hash-secret") {
    try {
      hashSecretCommand(argv[1]);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return;
  }

  const overrides: NodeJS.ProcessEnv = { ...process.env };
  const assign = (key: string, value: string | undefined): void => {
    if (value !== undefined) overrides[key] = value;
  };
  assign("CLARVIS_WORKSPACE_ROOT", flag(argv, "workspace"));
  assign("CLARVIS_HOME", flag(argv, "config"));
  assign("CLARVIS_SERVER_HOST", flag(argv, "host"));
  assign("CLARVIS_SERVER_PORT", flag(argv, "port") ?? process.env.PORT);
  assign("CLARVIS_SERVER_PATH", flag(argv, "path"));
  assign("CLARVIS_SERVER_OWNER_MODE", flag(argv, "owner-mode"));
  assign("CLARVIS_SERVER_AUTH", flag(argv, "auth"));
  assign("CLARVIS_SERVER_AUTH_FILE", flag(argv, "auth-file"));
  assign("CLARVIS_SERVER_PUBLIC_URL", flag(argv, "public-url"));
  assign("CLARVIS_SERVER_SHUTDOWN_GRACE_MS", flag(argv, "grace-ms"));
  assign("CLARVIS_LOG_LEVEL", flag(argv, "log-level"));
  if (has(argv, "memory")) overrides.CLARVIS_SERVER_MEMORY = "1";
  if (has(argv, "allow-public-bind")) overrides.CLARVIS_SERVER_ALLOW_PUBLIC_BIND = "1";
  if (has(argv, "allow-lan-bind")) overrides.CLARVIS_SERVER_ALLOW_LAN_BIND = "1";

  const env: ServerEnv = loadServerEnv(overrides);
  const loopEnv = loadEnv(overrides);
  const root = bind(createLogger(loopEnv.CLARVIS_LOG_LEVEL, { service: SERVICE }), {
    instance_id: newInstanceId(),
  });
  const components = createComponentLoggers(root, loopEnv.CLARVIS_LOG, loopEnv.CLARVIS_LOG_LEVEL);
  const logger = components("server");
  const audit = createAuditLogger(root, loopEnv.CLARVIS_LOG_AUDIT);
  const loggers = createServerLoggers(logger, audit);
  setServerTaskObserver(logger);

  const authRequired = env.CLARVIS_SERVER_AUTH === "required";
  if (
    !isPrivateBind(env.CLARVIS_SERVER_HOST) &&
    !env.CLARVIS_SERVER_ALLOW_PUBLIC_BIND &&
    !authRequired
  ) {
    logger.error(
      { event: "bind.refused", audit: true, reason: "public_bind", host: env.CLARVIS_SERVER_HOST },
      "refusing a non-private bind address on a server with no authentication, where the network " +
        "is the only boundary. Set CLARVIS_SERVER_AUTH=required, or pass --allow-public-bind to " +
        "keep the network as the boundary.",
    );
    process.exit(1);
  }
  if (
    isPrivateLanBind(env.CLARVIS_SERVER_HOST) &&
    !env.CLARVIS_SERVER_ALLOW_LAN_BIND &&
    !env.CLARVIS_SERVER_ALLOW_PUBLIC_BIND &&
    !authRequired
  ) {
    logger.error(
      { event: "bind.refused", audit: true, reason: "lan_bind", host: env.CLARVIS_SERVER_HOST },
      "refusing a local-network bind address on a server with no authentication: an RFC1918 " +
        "address is private to the internet but reachable by every device on this network. Set " +
        "CLARVIS_SERVER_AUTH=required, or pass --allow-lan-bind to keep the network as the " +
        "boundary.",
    );
    process.exit(1);
  }
  if (
    !authRequired &&
    env.CLARVIS_SERVER_OWNER_MODE === "header" &&
    !isPrivateBind(env.CLARVIS_SERVER_HOST)
  ) {
    audit.warn(
      {
        event: "bind.owner_unauthenticated",
        host: env.CLARVIS_SERVER_HOST,
        owner_mode: env.CLARVIS_SERVER_OWNER_MODE,
        owner_authenticated: false,
      },
      "owner ids are caller-supplied and unauthenticated on a public bind: any caller may claim " +
        "any owner and read or overwrite its data",
    );
  }

  const configDir = globalRoot({ env: overrides });
  let auth: AuthLayer | undefined;
  if (authRequired) {
    try {
      auth = await createAuthLayer({
        configDir,
        authFile: env.CLARVIS_SERVER_AUTH_FILE,
        publicUrl: env.CLARVIS_SERVER_PUBLIC_URL,
        mcpPath: env.CLARVIS_SERVER_PATH,
        audit,
      });
    } catch (err) {
      logger.error(
        { event: "auth.boot.failed", audit: true, err },
        "cannot start with authentication required",
      );
      process.exit(1);
    }
    const current = auth.config.current();
    audit.info(
      {
        event: "auth.boot.loaded",
        file: auth.config.path,
        clients: current.clients.length,
        roles: Object.keys(current.roles).length,
        owner_mode: env.CLARVIS_SERVER_OWNER_MODE,
      },
      "the enrolment table was read; a caller it does not name is refused however good its token is",
    );

    if (env.CLARVIS_SERVER_OWNER_MODE === "fixed") {
      const declared = [...new Set(current.clients.map((client) => client.owner))];
      const ignored = declared.filter((owner) => owner !== env.CLARVIS_SERVER_OWNER);
      if (ignored.length > 0) {
        audit.warn(
          {
            event: "auth.owner_mode.ignores_enrolment",
            declared: declared.join(","),
            effective: env.CLARVIS_SERVER_OWNER,
            owner_authenticated: false,
          },
          "owner mode 'fixed' ignores the owner every enrolled client declares: they all share " +
            `'${env.CLARVIS_SERVER_OWNER}', so their memory, plans, runs and sessions are ` +
            "commingled. Use --owner-mode token to give each client the owner auth.json names.",
        );
      }
    }
  }

  const workspaceRoot = workspaceRoot_({ env: overrides });
  const health = createConnectionHealth(components("mcp"));
  const stores = createOwnerScopedFileStores({ workspaceRoot });
  const baseKernelEnvironment = createKernelEnvironment(overrides);
  const resolvedKernelEnvironment = resolveSecretEnvironment(
    baseKernelEnvironment,
    createFileSecretStore({ dir: configDir }).read().values,
    env.CLARVIS_SERVER_KEY_SOURCES,
  );

  const state: { kernel?: Awaited<ReturnType<typeof createFileKernel>>; ready: boolean } = {
    ready: false,
  };

  const handle: ServeHandle = serveClarvisMcpOverHttp({
    env,
    version: PRODUCT_VERSION,
    logger: loggers,
    ...(auth !== undefined ? { auth } : {}),
    resolveKernel: (ctx) => {
      const { kernel } = state;
      if (kernel === undefined) throw new Error("kernel is not ready");
      return ownerScopedKernelResolver(kernel)(ctx);
    },
    readiness: {
      kernel: () => state.ready,
      config: async () => {
        const settings = await state.kernel?.config.getSettings();
        return settings !== undefined && settings.sources.every((s) => s.error === undefined);
      },
      model: async () => {
        const settings = await state.kernel?.config.getSettings();
        return isDefaultModelReady(settings?.merged, resolvedKernelEnvironment.values);
      },
      mcp: () => health.ready(env.CLARVIS_SERVER_READINESS_REQUIRE_MCP),
    },
  });

  logger.info(
    {
      event: "server.boot.posture",
      host: env.CLARVIS_SERVER_HOST,
      port: handle.port,
      path: env.CLARVIS_SERVER_PATH,
      owner_mode: env.CLARVIS_SERVER_OWNER_MODE,
      owner_authenticated: env.CLARVIS_SERVER_OWNER_MODE === "token",
      auth: env.CLARVIS_SERVER_AUTH,
      memory: env.CLARVIS_SERVER_MEMORY,
      builtins: "tasks=false",
      max_runs: env.CLARVIS_SERVER_MAX_RUNS,
      max_runs_per_owner: env.CLARVIS_SERVER_MAX_RUNS_PER_OWNER,
      max_sessions: env.CLARVIS_SERVER_MAX_SESSIONS,
      run_max_ms: env.CLARVIS_SERVER_RUN_MAX_MS,
      log_requests: env.CLARVIS_SERVER_LOG_REQUESTS,
    },
    "listening; the kernel is still starting, so /readyz answers 503 until it reports ready",
  );

  /**
   * Warn when the guard will refuse everything.
   *
   * @remarks
   * The guard is on unless settings say otherwise, and this facade resolves
   * questions to `auto_decline` — so a container whose `settings.json` carries no
   * `guard.allowed_commands` denies every command a run attempts. That is the
   * correct posture and a useless deployment, and the difference between the two
   * is one settings key. Reported at boot rather than discovered per run.
   */
  const warnIfGuardHasNoAllowlist = async (): Promise<void> => {
    const settings = await state.kernel?.config.getSettings();
    const guard = settings?.merged.guard as
      { mode?: string; allowed_commands?: unknown } | undefined;
    if (guard?.mode === "off") return;
    if (Array.isArray(guard?.allowed_commands)) return;
    logger.warn(
      { event: "server.guard.no_allowlist" },
      "the command guard is active and no guard.allowed_commands is configured, so every command " +
        "will be denied: this facade declines guard confirmations, so there is nobody to approve " +
        "them. Configure guard.allowed_commands, or set guard.mode to 'off' deliberately.",
    );
  };

  state.kernel = await createFileKernel({
    workspaceRoot,
    environment: baseKernelEnvironment,
    env: loadEnv({
      ...overrides,
      CLARVIS_DEFAULT_ELICIT_WAIT_MS: String(env.CLARVIS_SERVER_ELICIT_BACKSTOP_MS),
    }),
    logger: root,
    memory: env.CLARVIS_SERVER_MEMORY,
    subscriptions: false,
    onConnectionEvent: health.sink,
    keySources: env.CLARVIS_SERVER_KEY_SOURCES,
    planStoreFor: stores.planStoreFor,
    memoryStoreFor: stores.memoryStoreFor,
    onOwnerRetired: (owner) => stores.evictOwner(owner),
    defaultOwner: env.CLARVIS_SERVER_OWNER,
    ownershipMode: "multi",
    // The HTTP facade executes only in its configured checkout. Its callers and
    // models cannot bind external task providers; that remains a local Code surface.
    builtins: { tasks: false },
    globalDir: configDir,
    traceDir: globalPaths(configDir).tracesDir,
  });
  state.ready = true;
  await warnIfGuardHasNoAllowlist();
  logger.info(
    { event: "server.boot.ready" },
    "the kernel is up; /readyz reports ready and runs may start",
  );

  let shuttingDown = false;
  const beginShutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const graceMs = env.CLARVIS_SERVER_SHUTDOWN_GRACE_MS;
    const drainDelayMs = env.CLARVIS_SERVER_DRAIN_DELAY_MS;
    const settleMs = env.CLARVIS_SERVER_RUN_SETTLE_GRACE_MS;
    logger.info(
      { event: "server.shutdown.started", reason, grace_ms: graceMs, drain_delay_ms: drainDelayMs },
      "shutting down; in-flight runs are drained, then cancelled so their traces still persist",
    );

    const force = setTimeout(
      () => {
        logger.warn(
          { event: "server.shutdown.forced" },
          "the shutdown budget was exceeded; exiting without waiting for the rest of the drain",
        );
        process.exit(0);
      },
      drainDelayMs + graceMs + settleMs + 2_000,
    );
    force.unref?.();

    observeServerTask("server_shutdown", async () => {
      try {
        handle.stopAccepting();
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, drainDelayMs);
          timer.unref?.();
        });
        await handle.close(graceMs);
        await state.kernel?.close();
      } catch (err) {
        logger.error(
          { event: "server.shutdown.failed", err },
          "the shutdown ordering threw; exiting anyway, so a stuck teardown cannot hold the container open",
        );
      } finally {
        clearTimeout(force);
        process.exit(0);
      }
    });
  };

  process.on("SIGTERM", () => beginShutdown("SIGTERM"));
  process.on("SIGINT", () => beginShutdown("SIGINT"));
}

await main(process.argv.slice(2));
