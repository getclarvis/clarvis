/** Wire name of the tool that delegates an existing tracked task. */
export const DELEGATE_TASK_TOOL_NAME = "delegate_task";
/** Wire name of the tool that starts an independent sub-agent. */
export const SPAWN_SUBAGENT_TOOL_NAME = "spawn_subagent";
/** Wire name of the tool that finalizes the run with its result. */
export const SUBMIT_RESULT_TOOL_NAME = "submit_result";
/** Wire name of the tool that puts a question to the human. */
export const ASK_USER_TOOL_NAME = "ask_user";
/** Wire name of the supervision tool that lists a parent's own children. */
export const AGENT_LIST_TOOL = "agent_list";
/** Wire name of the supervision tool that drains a child's buffered activity. */
export const AGENT_POLL_TOOL = "agent_poll";
/** Wire name of the supervision tool that stops a child. */
export const AGENT_STOP_TOOL = "agent_stop";
/** Wire name of the supervision tool that steers a running child. */
export const AGENT_STEER_TOOL = "agent_steer";
/** Wire name of the supervision tool that waits for children to settle. */
export const AWAIT_AGENTS_TOOL = "await_agents";

/**
 * The five agent-supervision wire names, in the order they are advertised.
 *
 * @remarks They live here, in the dep-free wire-name module, rather than in the
 * `agents` capability that implements them, so a consumer gating on them can
 * name them without importing that capability.
 */
export const AGENT_SUPERVISION_WIRE_NAMES: readonly string[] = [
  AGENT_LIST_TOOL,
  AGENT_POLL_TOOL,
  AGENT_STOP_TOOL,
  AGENT_STEER_TOOL,
  AWAIT_AGENTS_TOOL,
];

/**
 * All engine-owned built-in (non-MCP, non-coding) tool wire names — delegation,
 * `submit_result` and `ask_user` — used to distinguish built-ins from MCP and
 * agent tools.
 *
 * @remarks A capability's own tool names are NOT here. They reach the reserved
 * set through {@link import("@clarvis/capability").Capability.reservedWireNames},
 * which is the only way the list can stay complete as features are added.
 */
export const BUILTIN_WIRE_NAMES: readonly string[] = [
  DELEGATE_TASK_TOOL_NAME,
  SPAWN_SUBAGENT_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
  ASK_USER_TOOL_NAME,
];

/**
 * The wire names of the built-in coding toolset (@clarvis/tools) — file
 * read/write/edit, search, shell and monitors, and the filesystem tools —
 * mirrored here so the loop can reason about them without importing the package.
 */
export const AGENT_TOOL_WIRE_NAMES: readonly string[] = [
  "read_file",
  "read_image",
  "read_files",
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "replace",
  "list_dir",
  "glob",
  "grep",
  "diff",
  "shell",
  "monitor_start",
  "monitor_poll",
  "monitor_stop",
  "monitor_list",
  "move",
  "copy",
  "mkdir",
  "remove",
  "file_stat",
  "tree",
];

/**
 * Coding tools whose result only a model with the `vision` capability can
 * consume.
 *
 * @remarks Mirrored from `@clarvis/tools` for the same reason as its
 * neighbours. Offering `read_image` to a blind model is not merely useless: the
 * base64 payload is charged to its live context and comes back as
 * `[image #n omitted: active model lacks vision]`, so the agent pays for the
 * image and learns nothing.
 */
export const VISION_AGENT_TOOL_WIRE_NAMES: readonly string[] = ["read_image"];

/**
 * Coding tools that only observe the workspace.
 *
 * @remarks Mirrored from `@clarvis/tools` so the engine's always-present tool
 * effect port does not load that optional package. The tools subpath's drift
 * test pins this list to the feature package's actual read-only surface.
 */
export const READ_ONLY_AGENT_TOOL_WIRE_NAMES: readonly string[] = [
  "read_file",
  "read_image",
  "read_files",
  "list_dir",
  "glob",
  "grep",
  "diff",
  "file_stat",
  "tree",
];

/**
 * Every wire name an MCP tool must not be allowed to take — the built-ins plus
 * the coding toolset.
 *
 * @remarks Seeded into {@link toWireToolName}'s `used` set so a server cannot
 * contribute a tool named `submit_result` or `read_file` and shadow the real
 * one. It lives here rather than in `@clarvis/mcp-client` because it is the
 * *engine's* name vocabulary; the registry builder receives it as an argument.
 */
export const RESERVED_WIRE_NAMES: readonly string[] = [
  ...BUILTIN_WIRE_NAMES,
  ...AGENT_TOOL_WIRE_NAMES,
];

/** Control-plane tool name that starts a run. */
const RUN_TOOL_NAME = "run";
/** Control-plane tool name that steers an in-flight run. */
const STEER_TOOL_NAME = "steer";
/** Control-plane tool name that fetches a run's state. */
const GET_RUN_TOOL_NAME = "get_run";
/** Control-plane tool name that lists runs. */
const LIST_RUNS_TOOL_NAME = "list_runs";
/** Control-plane tool name that deletes a run. */
const DELETE_RUN_TOOL_NAME = "delete_run";
/** Control-plane tool name that lists available agent profiles. */
const LIST_PROFILES_TOOL_NAME = "list_profiles";

/**
 * The control-plane tool names (run lifecycle + Agent Profile listing) — a distinct
 * surface from the in-run built-in and coding tools.
 */
export const CONTROL_PLANE_TOOL_NAMES: readonly string[] = [
  RUN_TOOL_NAME,
  STEER_TOOL_NAME,
  GET_RUN_TOOL_NAME,
  LIST_RUNS_TOOL_NAME,
  DELETE_RUN_TOOL_NAME,
  LIST_PROFILES_TOOL_NAME,
];
