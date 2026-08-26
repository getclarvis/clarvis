import type { RuntimeConfig } from "../config.ts";
import type { ToolResult } from "./content.ts";

/**
 * Optional callbacks a caller passes into a tool handler to observe it while it
 * runs. Every field is opt-in and advisory.
 */
export interface ToolCallHooks {
  /**
   * Live, incremental output from a long-running tool, coalesced by the
   * producer (per line / short interval). Purely advisory: the authoritative
   * output is the handler's result, and a flood-capped stream may omit middle
   * segments - consumers should treat the accumulated text as a display tail.
   *
   * @param chunk - the next fragment of streamed output.
   */
  onOutput?: (chunk: string) => void;
}

/**
 * The definition of a single tool: its identity, JSON Schema for arguments, and
 * the handler that executes it. The registry holds one of these per tool and
 * the dispatcher validates against `inputSchema` before invoking `handler`.
 *
 * @remarks
 * `handler` receives the validated (schema-defaulted, type-coerced) arguments,
 * not the raw caller input; see the dispatcher for the validation contract.
 */
export interface ToolDef {
  /** Stable tool name, unique across the registry and used for dispatch. */
  name: string;
  /** Human-readable description surfaced to the model in the tool listing. */
  description: string;

  /** JSON Schema for the tool's arguments, compiled once into a validator. */
  inputSchema: Record<string, unknown>;

  /**
   * When true, the handler's text output is already length-bounded and the
   * dispatcher must not re-clamp it to `maxOutputBytes`; when false or absent,
   * text parts are truncated to that limit.
   */
  bounded?: boolean;

  /**
   * Execute the tool.
   *
   * @param args - the validated, schema-defaulted arguments.
   * @param config - the resolved server configuration for this run.
   * @param signal - optional abort signal to cancel a long-running tool.
   * @param hooks - optional {@link ToolCallHooks} for live output.
   * @returns the tool result, either a bare string (wrapped as a single text
   *   part) or a full {@link ToolResult} with content parts and metadata.
   */
  handler: (
    args: Record<string, unknown>,
    config: RuntimeConfig,
    signal?: AbortSignal,
    hooks?: ToolCallHooks,
  ) => Promise<string | ToolResult>;
}
