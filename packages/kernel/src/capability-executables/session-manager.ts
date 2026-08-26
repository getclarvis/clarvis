import { createHash } from "node:crypto";
import {
  CAPABILITY_EXECUTABLE_PROTOCOL_VERSION,
  CapabilityExecutableRpcError,
  capabilityExecutableDeclarationSchema,
  resolveCapabilityExecutable,
  type CapabilityExecutableInitialization,
  type CapabilityExecutablePort,
  type CapabilityExecutableSession,
  type CapabilityExecutableSessionInput,
  type EffectiveCapabilityExecutable,
  type Logger,
} from "@clarvis/capability";
import { killTree, ownProcessGroup } from "@clarvis/tools/shell";

const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const SHUTDOWN_GRACE_MS = 2_000;

interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
}

interface ManagedSession extends CapabilityExecutableSession {
  readonly key: string;
  readonly capability: string;
  readonly owner?: string;
  readonly closed: boolean;
}

/** Construction inputs for the kernel-owned persistent subprocess pool. */
export interface CapabilityExecutableSessionManagerOptions {
  environment: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  logger?: Logger;
}

/** Session pool and lifecycle resource for external capability providers. */
export interface CapabilityExecutableSessionManager extends CapabilityExecutablePort {
  close(): Promise<void>;
}

/**
 * The environment one capability-executable child is launched with.
 *
 * @remarks A capability executable inherits the kernel's **whole** environment,
 * with its configured `env` layered on top. That is the opposite of the two
 * other children Clarvis spawns, and the asymmetry is recorded here rather than
 * justified, because nothing in this package argues for it:
 *
 * - a stdio MCP child gets a fixed safe base plus its declared `env`, never the
 *   caller's environment, precisely so a server that declares nothing sees no
 *   provider credentials (`@clarvis/mcp-client`'s `createTransport` argues this
 *   at length);
 * - a workspace hook gets a keep-list, then a per-run denylist derived from the
 *   run's `api_key_env` names, then a name-shape rule
 *   (`@clarvis/hooks`' `env.ts`).
 *
 * Both of those treat "this child had no reason to see the run's provider keys"
 * as the default. This path does not, so a configured capability executable
 * receives every credential the kernel holds. Whether that is intended — an
 * executable is operator-configured and arguably peer to the kernel — or an
 * oversight is a decision for the owner; it is called out here so the choice is
 * visible at the line that makes it rather than absent from the record.
 */
function processEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  additions: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const values = { ...inherited, ...additions };
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function sessionKey(
  input: CapabilityExecutableSessionInput,
  executable: EffectiveCapabilityExecutable,
): string {
  const env = Object.fromEntries(
    Object.entries(executable.env).sort(([a], [b]) => a.localeCompare(b)),
  );
  const value = JSON.stringify({
    capability: input.capability,
    workspace: input.workspace,
    cwd: input.cwd,
    command: executable.command,
    args: executable.args,
    env,
    timeout_ms: executable.timeout_ms,
    platform: executable.platform,
  });
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function errorOf(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function rpcError(value: unknown): CapabilityExecutableRpcError {
  if (typeof value !== "object" || value === null) {
    return new CapabilityExecutableRpcError("invalid JSON-RPC error response", -32603);
  }
  const candidate = value as Partial<JsonRpcErrorObject>;
  return new CapabilityExecutableRpcError(
    typeof candidate.message === "string" ? candidate.message : "capability executable failed",
    typeof candidate.code === "number" ? candidate.code : -32603,
    candidate.data,
  );
}

function initializationOf(value: unknown): CapabilityExecutableInitialization {
  if (typeof value !== "object" || value === null) {
    throw new Error("initialize must return an object");
  }
  const result = value as Record<string, unknown>;
  if (result.protocol_version !== CAPABILITY_EXECUTABLE_PROTOCOL_VERSION) {
    throw new Error(
      `unsupported capability executable protocol version '${String(result.protocol_version)}'`,
    );
  }
  if (typeof result.provider_kind !== "string" || result.provider_kind.trim().length === 0) {
    throw new Error("initialize must return a non-empty provider_kind");
  }
  if (result.writable !== undefined && typeof result.writable !== "boolean") {
    throw new Error("initialize writable must be boolean when present");
  }
  return {
    protocol_version: CAPABILITY_EXECUTABLE_PROTOCOL_VERSION,
    provider_kind: result.provider_kind,
    ...(typeof result.writable === "boolean" ? { writable: result.writable } : {}),
  };
}

/** Create a lazy pool keyed by workspace, capability, cwd, and effective declaration. */
export function createCapabilityExecutableSessionManager(
  options: CapabilityExecutableSessionManagerOptions,
): CapabilityExecutableSessionManager {
  const platform = options.platform ?? process.platform;
  const sessions = new Map<string, Promise<ManagedSession>>();
  let closing = false;

  function build(
    input: CapabilityExecutableSessionInput,
    executable: EffectiveCapabilityExecutable,
    key: string,
  ): Promise<ManagedSession> {
    return new Promise<ManagedSession>((resolve, reject) => {
      let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
      try {
        child = Bun.spawn([executable.command, ...executable.args], {
          cwd: input.cwd,
          env: processEnvironment(options.environment, executable.env),
          detached: ownProcessGroup(platform),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (error) {
        reject(errorOf(error));
        return;
      }

      let nextId = 1;
      let stdoutBuffer = Buffer.alloc(0);
      let stderr = "";
      let ended = false;
      let initialized: CapabilityExecutableInitialization | undefined;
      const pending = new Map<number, PendingCall>();

      const rejectPending = (error: Error): void => {
        for (const call of pending.values()) {
          clearTimeout(call.timer);
          call.removeAbort?.();
          call.reject(error);
        }
        pending.clear();
      };

      const terminate = (error: Error): void => {
        if (ended) return;
        ended = true;
        rejectPending(error);
        killTree(child.pid, "SIGTERM", { platform });
      };

      const handleLine = (line: Buffer): void => {
        if (line.length === 0) return;
        let message: unknown;
        try {
          message = JSON.parse(line.toString("utf8"));
        } catch {
          terminate(new Error("capability executable wrote invalid JSON to stdout"));
          return;
        }
        if (typeof message !== "object" || message === null || Array.isArray(message)) {
          terminate(new Error("capability executable wrote a non-object JSON-RPC message"));
          return;
        }
        const response = message as Record<string, unknown>;
        if (response.jsonrpc !== "2.0" || typeof response.id !== "number") {
          terminate(new Error("capability executable wrote an invalid JSON-RPC response"));
          return;
        }
        const call = pending.get(response.id);
        if (call === undefined) {
          terminate(new Error(`capability executable responded with unknown id ${response.id}`));
          return;
        }
        const hasResult = Object.hasOwn(response, "result");
        const hasError = Object.hasOwn(response, "error");
        if (hasResult === hasError) {
          terminate(new Error("JSON-RPC response must contain exactly one of result or error"));
          return;
        }
        pending.delete(response.id);
        clearTimeout(call.timer);
        call.removeAbort?.();
        if (hasError) call.reject(rpcError(response.error));
        else call.resolve(response.result);
      };

      const readStdout = async (): Promise<void> => {
        for await (const chunk of child.stdout) {
          if (ended) return;
          stdoutBuffer = Buffer.concat([stdoutBuffer, Buffer.from(chunk)]);
          if (stdoutBuffer.length > MAX_PROTOCOL_LINE_BYTES && stdoutBuffer.indexOf(10) < 0) {
            terminate(new Error("capability executable exceeded the maximum JSON line size"));
            return;
          }
          for (;;) {
            const newline = stdoutBuffer.indexOf(10);
            if (newline < 0) break;
            const line = stdoutBuffer.subarray(0, newline);
            stdoutBuffer = stdoutBuffer.subarray(newline + 1);
            if (line.length > MAX_PROTOCOL_LINE_BYTES) {
              terminate(new Error("capability executable exceeded the maximum JSON line size"));
              return;
            }
            handleLine(
              line.length > 0 && line[line.length - 1] === 13 ? line.subarray(0, -1) : line,
            );
            if (ended) return;
          }
        }
      };
      const readStderr = async (): Promise<void> => {
        const decoder = new TextDecoder();
        for await (const chunk of child.stderr) {
          if (stderr.length >= MAX_STDERR_BYTES) continue;
          stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(0, MAX_STDERR_BYTES);
        }
        if (stderr.length < MAX_STDERR_BYTES) {
          stderr = (stderr + decoder.decode()).slice(0, MAX_STDERR_BYTES);
        }
      };
      const stdoutDrained = readStdout().catch((error) => terminate(errorOf(error)));
      const stderrDrained = readStderr().catch((error) => terminate(errorOf(error)));
      void child.exited
        .then(async (code) => {
          await Promise.allSettled([stdoutDrained, stderrDrained]);
          if (ended) return;
          const diagnostic = stderr.trim();
          ended = true;
          rejectPending(
            new Error(
              `capability executable exited (code=${String(code)}, signal=${String(child.signalCode ?? null)})` +
                (diagnostic.length > 0 ? `: ${diagnostic}` : ""),
            ),
          );
        })
        .catch((error) => terminate(errorOf(error)));

      const request = (
        method: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        timeoutMs = executable.timeout_ms,
      ): Promise<unknown> => {
        if (ended) return Promise.reject(new Error("capability executable session is closed"));
        if (signal?.aborted === true) {
          const error = errorOf(signal.reason ?? "capability executable call cancelled");
          terminate(error);
          return Promise.reject(error);
        }
        const id = nextId++;
        return new Promise<unknown>((callResolve, callReject) => {
          const timer = setTimeout(() => {
            const error = new Error(
              `capability executable method '${method}' timed out after ${String(timeoutMs)}ms`,
            );
            terminate(error);
          }, timeoutMs);
          timer.unref?.();
          let removeAbort: (() => void) | undefined;
          if (signal !== undefined) {
            const abort = (): void => terminate(errorOf(signal.reason ?? "call cancelled"));
            signal.addEventListener("abort", abort, { once: true });
            removeAbort = () => signal.removeEventListener("abort", abort);
          }
          pending.set(id, { resolve: callResolve, reject: callReject, timer, removeAbort });
          const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
          (async () => {
            await child.stdin.write(line);
            await child.stdin.flush();
          })().catch((error) => terminate(errorOf(error)));
        });
      };

      const session: ManagedSession = {
        key,
        capability: input.capability,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        get providerKind(): string {
          return initialized?.provider_kind ?? "uninitialized";
        },
        get writable(): boolean | undefined {
          return initialized?.writable;
        },
        get closed(): boolean {
          return ended;
        },
        request(method, params, signal) {
          return request(method, params, signal);
        },
        async close(): Promise<void> {
          if (ended) return;
          try {
            await request("shutdown", {}, undefined, SHUTDOWN_GRACE_MS);
          } catch {
            // Shutdown is best-effort; termination below is authoritative.
          } finally {
            if (!ended) {
              ended = true;
              rejectPending(new Error("capability executable session closed"));
              try {
                await child.stdin.end();
              } catch {
                // The process may have closed its read side after shutdown.
              }
              killTree(child.pid, "SIGTERM", { platform });
            }
          }
        },
      };

      void request("initialize", {
        protocol_version: CAPABILITY_EXECUTABLE_PROTOCOL_VERSION,
        capability: input.capability,
        workspace: input.workspace,
      })
        .then((value) => {
          initialized = initializationOf(value);
          if (input.capability === "memory" && initialized.writable === undefined) {
            throw new Error("memory initialize must declare writable");
          }
          resolve(session);
        })
        .catch((error) => {
          terminate(errorOf(error));
          reject(errorOf(error));
        });
    });
  }

  return {
    async session(input): Promise<CapabilityExecutableSession> {
      if (closing) throw new Error("capability executable manager is closing");
      const declaration = capabilityExecutableDeclarationSchema.parse(input.declaration);
      const executable = resolveCapabilityExecutable(declaration, platform, options.environment);
      const key = sessionKey(input, executable);
      const existing = sessions.get(key);
      if (existing !== undefined) {
        const session = await existing;
        if (session.closed) {
          sessions.delete(key);
        } else {
          if (
            input.capability === "plans" &&
            session.owner !== undefined &&
            input.owner !== session.owner
          ) {
            throw new Error(
              `plans executable session already belongs to owner '${session.owner}' (v1 allows one owner)`,
            );
          }
          return session;
        }
      }
      const created = build(input, executable, key);
      sessions.set(key, created);
      void created.catch((error) => {
        options.logger?.warn(
          {
            event: "capexec.session.failed",
            capability: input.capability,
            cause: errorOf(error).message,
          },
          "a capability executable session did not start; the capability falls back to its built-in provider for this call",
        );
        if (sessions.get(key) === created) sessions.delete(key);
      });
      return created;
    },
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      const settled = await Promise.allSettled([...sessions.values()]);
      sessions.clear();
      await Promise.allSettled(
        settled.flatMap((outcome) =>
          outcome.status === "fulfilled" ? [outcome.value.close()] : [],
        ),
      );
    },
  };
}
