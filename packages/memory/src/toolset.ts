/**
 * Host-side adapter for @clarvis/memory's wiki tools: maps the leaf package's
 * host-agnostic MemoryToolDefs onto the loop's NamespacedTool shape (bare wire
 * names, same convention as load_skill — MCP tools are namespaced, so collisions
 * are impossible). The capability decides which subset of a Memory's tools a
 * given agent gets (read-only vs. read+write).
 */
import type { MemoryToolDef } from "./types.ts";

import type { NamespacedTool } from "@clarvis/capability";

/**
 * The loop-facing view of a Memory's wiki tools: the {@link NamespacedTool} defs
 * to advertise, the `names` set for membership checks, the per-run `callLimit`,
 * and the `dispatch` that runs one tool by name.
 */
export interface MemoryToolset {
  defs: NamespacedTool[];
  names: Set<string>;
  /** Per-run call budget; enforced by the handler. */
  callLimit: number;
  dispatch(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ isError: boolean; text: string }>;
}

/**
 * Adapt a set of host-agnostic {@link MemoryToolDef}s onto a loop
 * {@link MemoryToolset}: build bare-wire-named tool defs and a `dispatch` that
 * routes to the matching def's `execute`.
 *
 * @param tools - the memory tool definitions this agent may call (already scoped
 *   by the capability to read-only or read+write).
 * @param callLimit - the per-run call budget carried on the toolset.
 * @returns the assembled {@link MemoryToolset}; `dispatch` returns an error result
 *   for an unknown tool name rather than throwing.
 */
export function buildMemoryToolset(tools: MemoryToolDef[], callLimit: number): MemoryToolset {
  const byName = new Map<string, MemoryToolDef>(tools.map((t) => [t.name, t]));
  const defs: NamespacedTool[] = tools.map((t) => ({
    fullName: t.name,
    wireName: t.name,
    mcpName: "",
    toolName: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }));
  return {
    defs,
    names: new Set(byName.keys()),
    callLimit,
    async dispatch(name, args, signal) {
      const tool = byName.get(name);
      if (tool === undefined) {
        return { isError: true, text: `unknown memory tool '${name}'` };
      }
      return tool.execute(args, signal);
    },
  };
}
