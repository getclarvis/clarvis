import { FILE_MUTATING_TOOL_NAMES } from "@clarvis/kernel/policy";

/**
 * The canonical name a tool call is identified by: the tool name when present,
 * falling back to the MCP server name.
 *
 * @param mcpName - the MCP server the call was routed through, if any.
 * @param toolName - the tool name, if the call named one.
 * @returns `toolName`, or `mcpName`, or `""` when neither is set.
 */
export function toolIdentity(mcpName: string | undefined, toolName: string | undefined): string {
  return toolName || mcpName || "";
}

/**
 * The display label for a tool call: `server:tool` when both are known, else
 * whichever of the two is present.
 *
 * @param mcpName - the MCP server the call was routed through, if any.
 * @param toolName - the tool name, if the call named one.
 * @param args - safe displayed arguments used for operation-specific built-in labels.
 * @returns a product label for known built-ins, a `server:tool` label for MCP, or the lone identity.
 *
 * @remarks Both slots are guarded, not just `toolName`. A node can exist with a
 * tool name and no server: `tool_input_delta` creates one the moment the model
 * names the call it is composing, and the split into server and tool is not
 * known until the call itself is recorded. Interpolating the absent slot
 * printed the literal `undefined:` in front of every builtin's name.
 */
export function toolLabel(mcpName: string | undefined, toolName: string | undefined): string {
  if (!toolName) return mcpName ?? "";
  return mcpName ? `${mcpName}:${toolName}` : toolName;
}

const BUILTIN_TOOL_LABELS: Readonly<Record<string, string>> = {
  await_agents: "Wait for agents",
  agent_poll: "Check agent",
  agent_steer: "Steer agent",
  agent_stop: "Stop agent",
  delegate_task: "Delegate task",
  run_leader: "Start workflow leader",
  run_workflow: "Run workflow",
  run_round: "Run workflow rounds",
  run_work_items: "Run work items",
  workflow_status: "Check workflow",
  workflow_decide: "Decide workflow",
};

const CONFIGURATION_TOOL_LABELS: Readonly<Record<string, string>> = {
  list: "List configuration",
  read: "Read configuration",
  write: "Write configuration",
  edit: "Edit configuration",
  delete: "Delete configuration",
};

const TRANSCRIPT_EXTERNAL_ORCHESTRATION_TOOLS = new Set([
  "spawn_subagent",
  "delegate_task",
  "agent_list",
  "agent_poll",
  "agent_stop",
  "agent_steer",
  "await_agents",
  "run_leader",
  "run_workflow",
  "run_round",
  "run_work_items",
  "workflow_status",
  "workflow_decide",
]);

/**
 * Whether a bare built-in tool's lifecycle belongs to Sidebar/footer orchestration rather than
 * Lead history.
 *
 * @remarks A non-empty `toolName` denotes a namespaced MCP identity such as
 * `server.await_agents`; matching only its leaf would hide an unrelated downstream tool. During
 * provider composition the unsplit wire name must be supplied as `mcpName`.
 */
export function isTranscriptExternalOrchestrationTool(
  mcpName: string | undefined,
  toolName: string | undefined,
): boolean {
  return !toolName && TRANSCRIPT_EXTERNAL_ORCHESTRATION_TOOLS.has(mcpName ?? "");
}

/** Product-facing label for built-in orchestration tools; MCP identities remain exact. */
export function toolDisplayLabel(
  mcpName: string | undefined,
  toolName: string | undefined,
  args?: Readonly<Record<string, unknown>>,
): string {
  if (mcpName && toolName) return `${mcpName}:${toolName}`;
  const identity = toolIdentity(mcpName, toolName);
  if (identity === "configure_clarvis" && typeof args?.operation === "string")
    return CONFIGURATION_TOOL_LABELS[args.operation] ?? identity;
  return BUILTIN_TOOL_LABELS[identity] ?? identity;
}

const MEMORY_MUTATING_TOOL_NAMES: readonly string[] = [
  "write_memory",
  "edit_memory",
  "delete_memory",
];

/** Tool identities (see {@link toolIdentity}) whose calls mutate state — files or memory. */
export const MUTATION_TOOLS = new Set<string>([
  ...FILE_MUTATING_TOOL_NAMES,
  ...MEMORY_MUTATING_TOOL_NAMES,
]);

/**
 * Whether a tool call mutates state (a file-mutating or memory-mutating tool),
 * per {@link MUTATION_TOOLS}.
 *
 * @param mcpName - the MCP server the call was routed through, if any.
 * @param toolName - the tool name, if the call named one.
 */
export function isMutationTool(mcpName: string | undefined, toolName: string | undefined): boolean {
  return MUTATION_TOOLS.has(toolIdentity(mcpName, toolName));
}
