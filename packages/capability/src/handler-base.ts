import type { AgentRole } from "./api.ts";
import type { TracePort } from "./ports.ts";
import type { AgentBuildContext, ToolArgValidate } from "./loop-contract.ts";

/**
 * The ambient fields every tool handler needs from its agent's build context:
 * the `trace`, the agent identity, the optional subagent instance, the abort
 * `signal`, and the argument validator.
 */
export interface HandlerBase {
  trace: TracePort;
  agent: AgentRole;
  subagentInstanceId?: string;
  signal?: AbortSignal;
  validateArgs?: ToolArgValidate;
}

/**
 * Extract the {@link HandlerBase} slice from an {@link AgentBuildContext}, ready to
 * spread into a handler's construction.
 *
 * @param bc - the agent build context to project.
 * @returns the base with `subagentInstanceId`/`signal`/`validateArgs` omitted
 *   when undefined.
 */
export function handlerBaseOf(bc: AgentBuildContext): HandlerBase {
  return {
    trace: bc.trace,
    agent: bc.agent,
    ...(bc.subagentInstanceId !== undefined ? { subagentInstanceId: bc.subagentInstanceId } : {}),
    ...(bc.signal ? { signal: bc.signal } : {}),
    ...(bc.validateArgs !== undefined ? { validateArgs: bc.validateArgs } : {}),
  };
}
