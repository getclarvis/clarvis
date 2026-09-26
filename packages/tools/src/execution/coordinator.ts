import { isIsolationSetupError } from "./isolation-port.ts";
import type { RuntimeConfig } from "../config.ts";
import type { ToolResult } from "../tools/content.ts";
import type { ToolCallHooks, ToolDef } from "../tools/types.ts";
import { hostToolExecutor } from "./host.ts";
import type { ToolExecutionPort } from "./port.ts";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalTarget } from "./canonical-target.ts";
import { ToolError } from "../errors.ts";
import { resultDiagnostic } from "./diagnostics.ts";
import { randomUUID } from "node:crypto";

const FILE_MUTATIONS = new Set(["write_file", "edit_file", "apply_patch", "remove"]);
const SAFE_REPLAYS = new Set(["read_file", "read_image", "list_dir"]);

function readonlyWorkspaceMutation(error: unknown, tool: ToolDef, config: RuntimeConfig): boolean {
  if (tool.name !== "write_file" && tool.name !== "edit_file") return false;
  if (!(error instanceof ToolError) || error.code !== "sandbox_denied") return false;
  if (config.executionPolicy?.workspaceAccess !== "read-only") return false;
  if (typeof error.fields.path !== "string") return false;
  if (
    error.fields.errno_code !== "EROFS" &&
    !(config.sandboxBackend?.name === "seatbelt" && error.fields.errno_code === "EPERM")
  )
    return false;
  const path = isAbsolute(error.fields.path)
    ? resolve(error.fields.path)
    : resolve(config.executionPolicy.workspaceRoot, error.fields.path);
  const target = canonicalTarget(path);
  if (!target) return false;
  if (
    config.executionPolicy.denies.some((deny) => {
      const canonicalDeny = canonicalTarget(deny);
      if (!canonicalDeny) return true;
      const suffix = relative(canonicalDeny, target);
      return (
        suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
      );
    })
  )
    return false;
  const suffix = relative(config.executionPolicy.workspaceRoot, target);
  return (
    suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

function settingsAtomicFailure(
  error: unknown,
  tool: ToolDef,
  args: Record<string, unknown>,
  config: RuntimeConfig,
): boolean {
  if (!(error instanceof ToolError) || error.code !== "io_error") return false;
  if (!["EROFS", "EBUSY", "EACCES", "EPERM"].includes(String(error.fields.errno_code)))
    return false;
  if (tool.name !== "write_file" && tool.name !== "edit_file") return false;
  const path = args.path;
  if (typeof path !== "string" || !config.executionPolicy) return false;
  const target = isAbsolute(path) ? resolve(path) : resolve(config.workspaceRoot, path);
  return canonicalTarget(target) === config.executionPolicy.settingsFile;
}

function marked(
  result: string | ToolResult,
  mode: "host" | "sandbox",
  fallback: boolean,
  toolName: string,
  policyId?: string,
  sandboxBackend?: "bubblewrap" | "seatbelt",
  reason?: string,
  sandboxAttempted = true,
): ToolResult {
  const structured = typeof result === "string" ? { content: result } : result;
  const backend = mode === "host" ? "host" : sandboxBackend;
  const attemptId = randomUUID();
  return {
    ...structured,
    meta: {
      ...structured.meta,
      execution_mode: mode,
      ...(backend === undefined ? {} : { execution_backend: backend }),
      ...(policyId === undefined ? {} : { policy_id: policyId }),
      execution_started: true,
      sandbox_fallback: fallback,
      requested_mode: "sandbox",
      effective_mode: mode,
      attempt_id: attemptId,
      attempts:
        fallback && sandboxAttempted
          ? [
              {
                attempt_id: randomUUID(),
                mode: "sandbox",
                execution_started:
                  reason !== "sandbox_unavailable" && reason !== "sandbox_setup_failed",
                reason,
              },
              { attempt_id: attemptId, mode: "host", execution_started: true },
            ]
          : [{ attempt_id: attemptId, mode, execution_started: true }],
      ...(reason === undefined ? {} : { fallback_reason: reason }),
      ...(policyId && backend && !structured.meta?.execution_diagnostic
        ? {
            execution_diagnostic: resultDiagnostic(result, toolName, mode, backend, policyId),
          }
        : {}),
    },
  };
}

/** Serializes native file mutations across runs and owns explicit Host recovery. */
export class CoordinatedToolExecutor implements ToolExecutionPort {
  private mutationTail: Promise<void> = Promise.resolve();
  private unavailable = false;
  private recovery = new WeakMap<object, Set<string>>();

  constructor(
    private readonly sandbox: ToolExecutionPort,
    private readonly allowHostFallback: boolean,
    private readonly onAvailability?: (available: boolean) => void,
  ) {}

  async execute(
    tool: ToolDef,
    args: Record<string, unknown>,
    config: RuntimeConfig,
    signal?: AbortSignal,
    hooks?: ToolCallHooks,
  ): Promise<string | ToolResult> {
    if (tool.name === "shell_session") {
      return hostToolExecutor.execute(tool, args, config, signal, hooks);
    }
    if (!FILE_MUTATIONS.has(tool.name)) {
      return this.attempt(tool, args, config, signal, hooks);
    }
    const preceding = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      return await this.attempt(tool, args, config, signal, hooks);
    } finally {
      release();
    }
  }

  private async attempt(
    tool: ToolDef,
    args: Record<string, unknown>,
    config: RuntimeConfig,
    signal?: AbortSignal,
    hooks?: ToolCallHooks,
  ): Promise<string | ToolResult> {
    const strategy = args.execution_strategy;
    const token = args.recovery_token;
    if (strategy !== undefined || token !== undefined) {
      if (tool.name !== "shell" || strategy !== "host_recovery" || typeof token !== "string") {
        throw new ToolError("invalid_input", "Invalid Host recovery request");
      }
      const allowed = this.recovery.get(config.sessionAgent);
      if (!allowed?.delete(token)) throw new ToolError("denied", "Host recovery token is invalid");
      if (signal?.aborted) throw new ToolError("aborted", "Tool call aborted");
      const hostConfig = { ...config, executionPolicy: undefined, sandboxBackend: undefined };
      return marked(
        await hostToolExecutor.execute(tool, args, hostConfig, signal, hooks),
        "host",
        true,
        tool.name,
        config.executionPolicy?.id,
        config.sandboxBackend?.name,
        "agent_recovery",
        false,
      );
    }
    if (this.unavailable) {
      if (signal?.aborted) throw new ToolError("aborted", "Tool call aborted");
      const hostConfig = { ...config, executionPolicy: undefined, sandboxBackend: undefined };
      return marked(
        await hostToolExecutor.execute(tool, args, hostConfig, signal, hooks),
        "host",
        true,
        tool.name,
        config.executionPolicy?.id,
        config.sandboxBackend?.name,
        "sandbox_unavailable",
        false,
      );
    }
    try {
      const result = marked(
        await this.sandbox.execute(tool, args, config, signal, hooks),
        "sandbox",
        false,
        tool.name,
        config.executionPolicy?.id,
        config.sandboxBackend?.name,
      );
      this.onAvailability?.(true);
      return result;
    } catch (error) {
      if (error instanceof ToolError && error.code === "sandbox_denied") {
        this.onAvailability?.(true);
      }
      if (!this.allowHostFallback || signal?.aborted) throw error;
      const prelaunch = isIsolationSetupError(error);
      const atomicSettings = settingsAtomicFailure(error, tool, args, config);
      const safeReplay =
        error instanceof ToolError &&
        error.code === "sandbox_denied" &&
        SAFE_REPLAYS.has(tool.name);
      const readonlyMutation = readonlyWorkspaceMutation(error, tool, config);
      if (!prelaunch && !atomicSettings && !safeReplay && !readonlyMutation) {
        if (
          tool.name === "shell" &&
          error instanceof ToolError &&
          (error.code === "sandbox_denied" || error.code === "outcome_unknown")
        ) {
          const recoveryToken = randomUUID();
          const tokens = this.recovery.get(config.sessionAgent) ?? new Set<string>();
          tokens.add(recoveryToken);
          this.recovery.set(config.sessionAgent, tokens);
          throw new ToolError(error.code, error.message, {
            ...error.fields,
            recovery_token: recoveryToken,
            recovery_strategy: "host_recovery",
            requested_mode: "sandbox",
            effective_mode: "sandbox",
            execution_backend: config.sandboxBackend?.name,
            policy_id: config.executionPolicy?.id,
            sandbox_fallback: false,
            attempt_id: randomUUID(),
          });
        }
        throw error;
      }
      if (prelaunch) {
        this.unavailable = true;
        this.onAvailability?.(false);
      }
      config.logger.warn(
        {
          event: "tools.sandbox_fallback",
          policy_id: config.executionPolicy?.id ?? "unknown",
          reason: prelaunch
            ? error.code
            : atomicSettings
              ? "atomic_settings"
              : readonlyMutation
                ? "readonly_workspace"
                : "sandbox_denied",
        },
        "sandbox operation could not complete; executing on Host under operator authorization",
      );
      const hostConfig = { ...config, executionPolicy: undefined, sandboxBackend: undefined };
      return marked(
        await hostToolExecutor.execute(tool, args, hostConfig, signal, hooks),
        "host",
        true,
        tool.name,
        config.executionPolicy?.id,
        config.sandboxBackend?.name,
        prelaunch
          ? error.code
          : atomicSettings
            ? "atomic_settings"
            : readonlyMutation
              ? "readonly_workspace"
              : "sandbox_denied",
      );
    }
  }

  async close(): Promise<void> {
    await this.mutationTail;
    this.recovery = new WeakMap();
    await this.sandbox.close?.();
  }
}
