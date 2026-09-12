import { tools, readOnlyTools } from "@clarvis/tools";

/** Names of every built-in coding tool exposed by @clarvis/tools. */
export const AGENT_TOOL_NAMES: readonly string[] = tools.map((t) => t.name);

/**
 * Coding tools that observe the workspace and never change it.
 *
 * @remarks Read straight off `@clarvis/tools`' own `readOnlyTools`, so there is
 * one source of truth and nothing to keep in sync. Note what it excludes:
 * `shell` and the monitors observe and mutate through the same entry point, so
 * no caller can treat them as safe without executing the command first.
 */
export const READ_ONLY_TOOL_NAMES: readonly string[] = readOnlyTools.map((t) => t.name);

const READ_ONLY_NAMES = new Set(READ_ONLY_TOOL_NAMES);

/** Coding tools that mutate state — every tool that is not read-only. */
export const EDIT_TOOL_NAMES: readonly string[] = AGENT_TOOL_NAMES.filter(
  (n) => !READ_ONLY_NAMES.has(n),
);

/**
 * Coding tools that execute commands on either the sandboxed or host boundary.
 *
 * @remarks The one list here that is written out rather than derived, and
 * deliberately so. `READ_ONLY_TOOL_NAMES` comes from `@clarvis/tools`' own
 * `readOnly` bit and `EDIT_TOOL_NAMES` is its complement, but "executes a
 * command" is not a second bit that package could carry: `readOnly` describes
 * whether a tool *changes the workspace*, and every exec tool is already
 * not-read-only by that measure. Adding an `exec` bit beside it would ask
 * `@clarvis/tools` to model a grant boundary that belongs to the engine, and it
 * would be a bit with exactly these five members.
 *
 * Being written out is also what makes it auditable: the set of tools that can
 * run arbitrary commands is the most security-relevant list in the engine, and a
 * derived one would silently acquire a member when a tool elsewhere set a flag.
 * `AGENT_TOOL_NAMES` is the registry, so a rename shows up as a name here that
 * no longer exists rather than as a quietly empty filter.
 */
export const EXEC_TOOL_NAMES: readonly string[] = [
  "shell",
  "monitor_start",
  "monitor_poll",
  "monitor_stop",
  "monitor_list",
];

/**
 * Coding tools presented as direct mutations: edit tools minus command runners.
 */
export const FILE_MUTATING_TOOL_NAMES: readonly string[] = EDIT_TOOL_NAMES.filter(
  (n) => !EXEC_TOOL_NAMES.includes(n),
);
