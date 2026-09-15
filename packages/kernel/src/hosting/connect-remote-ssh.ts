import { spawn } from "node:child_process";
import { sanitizeText, NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { kernelError } from "../core/errors.ts";
import { connectKernelClient, type RemoteKernel } from "../transport/client.ts";
import { createStdioTransport } from "../transport/stdio.ts";

const SAFE_SSH_DESTINATION = /^[A-Za-z0-9_.:@-]+$/u;
const SAFE_REMOTE_TOKEN = /^[A-Za-z0-9_./:=@+-]+$/u;
const MAX_STDERR_BYTES = 32 * 1024;
const SSH_ENVIRONMENT_KEYS = [
  "HOME",
  "USERPROFILE",
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "SSH_AUTH_SOCK",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
] as const;

/** Keep only local process-discovery and SSH authentication inputs, never provider credentials. */
export function remoteSshEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SSH_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/** Operator-selected SSH process and fixed remote Clarvis command. */
export interface RemoteSshKernelOptions {
  destination: string;
  workspace: string;
  /** Remote command tokens. They are shell-safe validated because OpenSSH joins them remotely. */
  remoteCommand: readonly [string, ...string[]];
  /** Local SSH executable and installation-owned prefix arguments. */
  sshCommand?: readonly [string, ...string[]];
  startupTimeoutMs?: number;
  logger?: Logger;
}

/** A kernel client whose lifetime owns exactly one SSH process. */
export interface ConnectedRemoteSshKernel {
  client: RemoteKernel;
  /** Settles when the physical SSH stdio channel closes. */
  closed: Promise<string>;
  /** Sanitized bounded stderr retained for diagnostics after process failure. */
  stderr(): string;
}

function validateOptions(options: RemoteSshKernelOptions): number {
  if (
    options.destination.length === 0 ||
    options.destination.length > 255 ||
    options.destination.startsWith("-") ||
    !SAFE_SSH_DESTINATION.test(options.destination)
  )
    throw kernelError("invalid_request", "SSH destination has an invalid format");
  if (options.workspace.length === 0 || options.workspace.length > 16_384)
    throw kernelError("invalid_request", "remote workspace must be within 16384 characters");
  if (
    options.remoteCommand.length === 0 ||
    options.remoteCommand.some(
      (token) => token.length === 0 || token.length > 16_384 || !SAFE_REMOTE_TOKEN.test(token),
    )
  )
    throw kernelError("invalid_request", "remote command contains a shell-unsafe token");
  if (options.sshCommand !== undefined && options.sshCommand[0].length === 0)
    throw kernelError("invalid_request", "SSH executable cannot be empty");
  const timeout = options.startupTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 120_000)
    throw kernelError("invalid_request", "remote startup timeout must be within 120 seconds");
  return timeout;
}

/**
 * Spawn OpenSSH without a local shell and negotiate the ordinary Clarvis stdio protocol.
 *
 * @remarks SSH owns machine/user authentication, host-key verification and encryption. Clarvis
 * sends no local discovery credential or provider secret in argv, and disables port, agent and X11
 * forwarding without preventing the local agent from authenticating the connection. Authentication
 * and host-key verification must already be noninteractive so OpenSSH cannot compete with the TUI
 * for its controlling terminal. OpenSSH still joins command arguments for the remote shell, so every
 * remote token is restricted to a conservative shell-safe alphabet. Closing the client closes stdin
 * and terminates only the SSH process owned by this connection.
 */
export async function connectRemoteKernelOverSsh(
  options: RemoteSshKernelOptions,
): Promise<ConnectedRemoteSshKernel> {
  const timeout = validateOptions(options);
  const logger = options.logger ?? NOOP_LOGGER;
  const ssh = options.sshCommand ?? (["ssh"] as const);
  const child = spawn(
    ssh[0],
    [
      ...ssh.slice(1),
      "-T",
      "-a",
      "-x",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "BatchMode=yes",
      "--",
      options.destination,
      ...options.remoteCommand,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: remoteSshEnvironment(process.env),
    },
  );
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    child.kill();
    throw kernelError("unavailable", "SSH process did not expose its stdio pipes");
  }
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  let stderr = Buffer.alloc(0);
  child.stderr.on("data", (chunk: Buffer | string) => {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderr = Buffer.concat([stderr, next]).subarray(-MAX_STDERR_BYTES);
  });
  const base = createStdioTransport({ input: child.stdout, output: child.stdin }, logger);
  const physicalClose = Promise.withResolvers<string>();
  base.onClose?.((reason) => {
    physicalClose.resolve(reason instanceof Error ? reason.message : "SSH transport closed");
  });
  let closed = false;
  const transport = {
    ...base,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await base.close();
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null) {
        const grace = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          timer.unref?.();
        });
        await Promise.race([exited, grace]);
      }
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
  const timer = setTimeout(() => {
    void transport.close().catch(() => undefined);
  }, timeout);
  try {
    const client = await connectKernelClient(transport, {
      clientInfo: { name: "clarvis-ssh" },
      logger,
    });
    if (client.capabilities.hosting === undefined) {
      await client.close();
      throw kernelError("unsupported", "remote kernel does not advertise hosted execution");
    }
    return {
      client,
      closed: physicalClose.promise,
      stderr: () => sanitizeText(stderr.toString("utf8")).slice(-4096),
    };
  } catch (error) {
    await transport.close();
    const detail = sanitizeText(stderr.toString("utf8")).trim().slice(-4096);
    if (detail.length === 0) throw error;
    throw kernelError("unavailable", `SSH kernel startup failed: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}
