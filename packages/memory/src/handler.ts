import {
  openCallEnvelope,
  type HandlerBase,
  type HandlerVerdict,
  type ToolHandler,
} from "@clarvis/capability";

import { isMutatingTool, type Mutation } from "./indexer/pyramid.ts";
import type { MemoryToolset } from "./toolset.ts";

/** Inputs for the handler over one read or write memory toolset. */
export interface MemoryToolsHandlerDeps {
  base: HandlerBase;
  toolset: MemoryToolset;
  onMutation?: (mutation: Mutation) => void;
}

/** Dispatch one memory toolset while enforcing its per-agent call budget. */
export function buildMemoryToolsHandler(deps: MemoryToolsHandlerDeps): ToolHandler {
  const { base, toolset, onMutation } = deps;
  let calls = 0;
  return {
    matches: (call) => toolset.names.has(call.name),
    async handle(call, iteration): Promise<HandlerVerdict> {
      const envelope = openCallEnvelope({
        call,
        name: call.name,
        trace: base.trace,
        agent: base.agent,
        ...(base.subagentInstanceId !== undefined
          ? { subagentInstanceId: base.subagentInstanceId }
          : {}),
        iteration,
      });
      if (calls >= toolset.callLimit) {
        return {
          kind: "result",
          text: envelope.fail(
            `Memory tool budget for this run is exhausted (${toolset.callLimit} calls). ` +
              "Proceed with what the memory block and prior results already gave you, or " +
              "inspect the workspace directly.",
          ),
          progress: false,
        };
      }
      calls += 1;
      envelope.start();
      const args =
        call.arguments !== null &&
        typeof call.arguments === "object" &&
        !Array.isArray(call.arguments)
          ? (call.arguments as Record<string, unknown>)
          : {};
      const result = await toolset.dispatch(call.name, args, base.signal);
      if (!result.isError && onMutation !== undefined && isMutatingTool(call.name)) {
        const path = args.path;
        if (typeof path === "string") onMutation({ tool: call.name, path });
      }
      return result.isError
        ? { kind: "result", text: envelope.fail(result.text), progress: false }
        : { kind: "result", text: envelope.ok(result.text), progress: true };
    },
  };
}
