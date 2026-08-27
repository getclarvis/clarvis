import type { HandlerBase } from "@clarvis/capability";
import type { NamespacedRegistry } from "@clarvis/capability";
import type { ConvergenceGuards } from "../guards/convergence-guards.ts";
import type { ToolArgValidator } from "../tools/tool-arg-validator.ts";
import { executeMcpToolCall } from "../tools/mcp-dispatch.ts";
import type { HandlerVerdict, ToolHandler } from "./loop-contract.ts";

/**
 * Build the catch-all {@link ToolHandler} that dispatches any tool call through
 * the MCP registry.
 *
 * @param deps.base - the ambient {@link HandlerBase} (trace, agent, signal).
 * @param deps.registry - the namespaced tool registry to execute against.
 * @param deps.argValidator - validates the call's arguments before dispatch.
 * @param deps.guards - the convergence guards consulted during dispatch.
 * @param deps.progress - the persona's policy mapping a dispatch outcome
 *   (`errText`/`productive`) to whether it counts as progress.
 * @param deps.availableWireNames - the tool wire names currently exposed;
 *   defaults to every tool in the registry.
 * @returns a handler whose `matches` claims every call and whose `handle` runs
 *   {@link executeMcpToolCall}, formatting the result (or error) as the model-
 *   facing `Tool '…' result` text and forwarding any returned images.
 */
export function buildMcpHandler(deps: {
  base: HandlerBase;
  registry: NamespacedRegistry;
  argValidator: ToolArgValidator;
  guards: ConvergenceGuards;
  progress: (r: { errText: string | null; productive: boolean }) => boolean;
  availableWireNames?: string[];
}): ToolHandler {
  const { base } = deps;
  const wireNames = deps.availableWireNames ?? deps.registry.tools.map((t) => t.wireName);
  return {
    matches: () => true,
    canonicalName: (call) => deps.registry.resolve(call.name)?.fullName,
    async handle(call, iteration): Promise<HandlerVerdict> {
      const { resultText, errText, productive, images } = await executeMcpToolCall({
        call,
        registry: deps.registry,
        availableWireNames: wireNames,
        argValidator: deps.argValidator,
        guards: deps.guards,
        trace: base.trace,
        agent: base.agent,
        ...(base.subagentInstanceId !== undefined
          ? { subagentInstanceId: base.subagentInstanceId }
          : {}),
        iteration,
        ...(base.signal ? { signal: base.signal } : {}),
      });
      const text =
        errText === null
          ? `Tool '${call.name}' result: ${resultText}`
          : `Tool '${call.name}' result (error): ${errText}`;
      return {
        kind: "result",
        text,
        progress: deps.progress({ errText, productive }),
        ...(images ? { images } : {}),
      };
    },
  };
}
