import type { RuntimeConfig } from "../config.ts";
import type { ToolCallHooks, ToolDef } from "../tools/types.ts";
import type { ToolResult } from "../tools/content.ts";

/** A trusted executor receives only a schema-validated tool operation. */
export interface ToolExecutionPort {
  execute(
    tool: ToolDef,
    args: Record<string, unknown>,
    config: RuntimeConfig,
    signal?: AbortSignal,
    hooks?: ToolCallHooks,
  ): Promise<string | ToolResult>;
  close?(): Promise<void>;
}
