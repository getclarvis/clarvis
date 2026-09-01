import type { RunCapability } from "@clarvis/capability";
import type { OpenedConnection } from "@clarvis/mcp-client";

export const MAX_MCP_INSTRUCTIONS_SECTION_CHARS = 32_768;

function withinCharacterBudget(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

/** Build the bounded system section contributed by connected MCP servers. */
export function renderMcpInstructions(opened: readonly OpenedConnection[]): string | undefined {
  const sections = opened.flatMap(({ conn }) => {
    const instructions = conn.instructions?.trim();
    return instructions ? [`### ${conn.name}\n\n${instructions}`] : [];
  });
  if (sections.length === 0) return undefined;

  const heading =
    "## MCP server instructions\n\n" +
    "These instructions came from connected MCP servers. Apply each section when using that " +
    "server's tools or resources; higher-priority instructions still take precedence.\n\n";
  return withinCharacterBudget(
    `${heading}${sections.join("\n\n")}`,
    MAX_MCP_INSTRUCTIONS_SECTION_CHARS,
  );
}

/** Expose initialize-handshake instructions to entry agents and their spawned subagents. */
export function createMcpInstructionsRunCapability(
  opened: readonly OpenedConnection[],
): RunCapability | undefined {
  const section = renderMcpInstructions(opened);
  if (section === undefined) return undefined;
  return {
    name: "mcp-instructions",
    systemSection: () => section,
    forAgent: () => null,
  };
}
