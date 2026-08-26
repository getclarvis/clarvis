import type { CommandEntryView, Group, Parent } from "./commands.ts";

/** Display order of {@link Group}s in slash autocomplete and Help. */
export const GROUP_ORDER: readonly Group[] = ["actions", "navigate", "skills", "mcp"];

/** Human-readable heading for each {@link Group}. */
export const GROUP_LABEL: Record<Group, string> = {
  actions: "Actions",
  navigate: "Go to",
  skills: "Skills",
  mcp: "MCP prompts",
};

/**
 * Parents that own a landing hub (`/settings`, `/extensions`): a command with
 * one of these parents is reached _through_ its hub or a `/hub <child>`
 * deep-link, so it is hidden from the top-level `/` list and Help. Other
 * parents (`sessions`, `inspect`) are purely informational and hide nothing.
 */
const HUB_PARENTS: ReadonlySet<Parent> = new Set(["settings", "extensions"]);

/**
 * Whether a command entry should appear in the top-level `/` list and Help.
 *
 */
export function isTopLevelCommand(e: Pick<CommandEntryView, "surface" | "parent">): boolean {
  return e.surface !== "internal" && !(e.parent !== undefined && HUB_PARENTS.has(e.parent));
}
