import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../config.ts";
import type { ToolResult } from "../tools/content.ts";
import type { ToolCallHooks, ToolDef } from "../tools/types.ts";
import { ToolError } from "../errors.ts";
import { hostToolExecutor } from "./host.ts";
import { isIsolationSetupError, ToolIsolationSetupError } from "./isolation-port.ts";
import type { ToolExecutionPort } from "./port.ts";

const FILE_MUTATIONS = new Set(["write_file", "edit_file", "apply_patch", "remove"]);

/** Serialize file mutations without changing execution authority after a failure. */
export class CoordinatedToolExecutor implements ToolExecutionPort {
  private mutationTail: Promise<void> = Promise.resolve();
  private unavailable = false;

  constructor(
    private readonly sandbox: ToolExecutionPort,
    private readonly onAvailability?: (available: boolean) => void,
  ) {}

  async execute(
    tool: ToolDef,
    args: Record<string, unknown>,
    config: RuntimeConfig,
    signal?: AbortSignal,
    hooks?: ToolCallHooks,
  ): Promise<string | ToolResult> {
    if (tool.name === "shell_session")
      return hostToolExecutor.execute(tool, args, config, signal, hooks);
    if (!FILE_MUTATIONS.has(tool.name)) return this.attempt(tool, args, config, signal, hooks);
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
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new ToolError("aborted", "Tool call aborted");
    if (this.unavailable) {
      throw new ToolIsolationSetupError(
        "sandbox_unavailable",
        "Native sandbox remains unavailable",
        {
          backend: config.sandboxBackend?.name ?? "bubblewrap",
          policyId: config.executionPolicy?.id ?? "unknown",
        },
      );
    }
    try {
      const result = await this.sandbox.execute(tool, args, config, signal, hooks);
      this.onAvailability?.(true);
      const structured = typeof result === "string" ? { content: result } : result;
      return {
        ...structured,
        meta: {
          ...structured.meta,
          requested_mode: "sandbox",
          effective_mode: "sandbox",
          sandbox_fallback: false,
          attempt_id: randomUUID(),
          policy_id: config.executionPolicy?.id,
          execution_backend: config.sandboxBackend?.name,
          execution_started: true,
        },
      };
    } catch (error) {
      if (isIsolationSetupError(error)) {
        this.unavailable = true;
        this.onAvailability?.(false);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.mutationTail;
    await this.sandbox.close?.();
  }
}
