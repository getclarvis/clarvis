import { spawn, type SpawnOptions } from "node:child_process";
import { hostname } from "node:os";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { detachObserved, NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { kernelError } from "../core/errors.ts";
import { connectKernelClient, type RemoteKernel } from "../transport/client.ts";
import { connectLocalKernelTransport } from "../transport/local.ts";
import { CLARVIS_WIRE_VERSION } from "../transport/wire.ts";
import {
  localHostProcessAlive,
  readLocalHostConnection,
  resolveLocalHostIdentity,
  type LocalHostIdentity,
  type LocalHostConnectionRecord,
} from "./local-state.ts";

/** Exact host artifact command selected by the application, never a request supplied by the agent. */
export interface LocalKernelLaunchOptions {
  workspaceRoot: string;
  globalDir?: string;
  owner?: string;
  artifactId: string;
  /** Absolute executable followed by fixed installation-owned arguments. No shell is involved. */
  command: readonly [string, ...string[]];
  /** Operator environment snapshot; preserve configured tool policy and keep it off the RPC wire. */
  environment: Readonly<Record<string, string | undefined>>;
  startupTimeoutMs?: number;
  logger?: Logger;
}

/** Closing the client disconnects one TUI; it never terminates the independently owned process. */
export interface ConnectedLocalKernel {
  client: RemoteKernel;
  identity: LocalHostIdentity;
}

/** Each supported OS uses an explicit detachment policy, without inheriting the parent's terminal. */
export function localHostSpawnOptions(platform: NodeJS.Platform = process.platform): SpawnOptions {
  switch (platform) {
    case "linux":
    case "darwin":
      return { detached: true, stdio: "ignore" };
    case "win32":
      return { detached: true, windowsHide: true, stdio: "ignore" };
    default:
      throw kernelError("unsupported", "local host processes are unsupported on this platform");
  }
}

async function connect(
  record: LocalHostConnectionRecord,
  identity: LocalHostIdentity,
  deadline: number,
  logger: Logger,
): Promise<RemoteKernel> {
  const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
  const transport = await connectLocalKernelTransport(record.endpoint, {
    timeoutMs: Math.min(1000, remaining),
    logger,
  });
  const timer = setTimeout(() => {
    detachObserved(() => transport.close(), { operation: "hosting.hello.timeout", logger });
  }, remaining);
  try {
    const client = await connectKernelClient(transport, {
      auth: record.credential,
      workspace: identity.workspaceRoot,
      clientInfo: { name: "clarvis-local" },
    });
    if (
      client.workspace.id !== record.workspace_id ||
      client.capabilities.hosting?.host_generation !== record.host_generation
    ) {
      await client.close();
      throw kernelError("conflict", "local host handshake does not match its discovery identity");
    }
    if (client.localHost !== undefined && (await client.localHost.inspect()).restart_requested) {
      await client.close();
      throw kernelError("unavailable", "local host is retiring after an explicit restart request");
    }
    return client;
  } catch (error) {
    await transport.close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Discover or launch one lease-owned host, then authenticate a fresh kernel RPC connection. A
 * startup timeout never kills or restarts an unconfirmed process. Concurrent launchers may contend
 * for the lease, but only its winner constructs a kernel. Mutations are never replayed here.
 */
export async function connectOrLaunchLocalKernel(
  options: LocalKernelLaunchOptions,
): Promise<ConnectedLocalKernel> {
  if (
    !isAbsolute(options.command[0]) ||
    options.artifactId.length === 0 ||
    options.artifactId.length > 256
  )
    throw kernelError(
      "invalid_request",
      "local host requires an absolute artifact command and identity",
    );
  const timeout = options.startupTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 120_000)
    throw kernelError("invalid_request", "host startup timeout must be within 120 seconds");
  const logger = options.logger ?? NOOP_LOGGER;
  const identity = await resolveLocalHostIdentity(options);
  const environment = {
    ...options.environment,
    CLARVIS_HOME: identity.globalDir,
    CLARVIS_WORKSPACE_ROOT: identity.workspaceRoot,
  };
  const deadline = performance.now() + timeout;
  let launched = false;
  let launchFailed = false;
  while (performance.now() < deadline) {
    const record = await readLocalHostConnection(identity);
    if (record !== null && record.host !== hostname())
      throw kernelError("conflict", "local host state belongs to another machine");
    const live = record !== null && localHostProcessAlive(record.pid);
    if (live) {
      if (record.wire_version !== CLARVIS_WIRE_VERSION || record.artifact_id !== options.artifactId)
        throw kernelError(
          "unsupported",
          "active local host requires its original compatible installation",
        );
      try {
        return { identity, client: await connect(record, identity, deadline, logger) };
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code !== "unavailable" && code !== "ECONNREFUSED" && code !== "ENOENT") throw error;
      }
    } else if (!launched) {
      launched = true;
      const child = spawn(
        options.command[0],
        [
          ...options.command.slice(1),
          "--local-host",
          "--workspace",
          identity.workspaceRoot,
          "--global-dir",
          identity.globalDir,
          "--owner",
          identity.owner,
          "--artifact-id",
          options.artifactId,
        ],
        { ...localHostSpawnOptions(), cwd: identity.workspaceRoot, env: environment },
      );
      child.once("error", () => {
        launchFailed = true;
      });
      child.once("exit", (code) => {
        if (code !== 0) launchFailed = true;
      });
      child.unref();
    }
    if (launchFailed) throw kernelError("unavailable", "local host process failed during startup");
    await delay(Math.min(50, Math.max(1, deadline - performance.now())));
  }
  throw kernelError(
    "unavailable",
    "local host startup is unconfirmed; no process was stopped or restarted",
  );
}

/** Strict private CLI arguments shared by the distributed host entry and process fixtures. */
export function parseLocalHostArguments(argv: readonly string[]): {
  workspaceRoot: string;
  globalDir: string;
  defaultOwner: string;
  artifactId: string;
} | null {
  if (argv[0] !== "--local-host") return null;
  const values = new Map<string, string>();
  const allowed = new Set(["--workspace", "--global-dir", "--owner", "--artifact-id"]);
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || !allowed.has(key) || values.has(key) || !value || value.includes("\0"))
      throw kernelError("invalid_request", "invalid local host bootstrap arguments");
    values.set(key, value);
  }
  if (values.size !== allowed.size)
    throw kernelError("invalid_request", "local host bootstrap arguments are incomplete");
  return {
    workspaceRoot: values.get("--workspace")!,
    globalDir: values.get("--global-dir")!,
    defaultOwner: values.get("--owner")!,
    artifactId: values.get("--artifact-id")!,
  };
}
