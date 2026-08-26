import type { MCPStatus } from "@clarvis/protocol";
import type { SkillsService } from "@clarvis/protocol";
import type { McpClientCaps } from "./mcp-capabilities-bridge.ts";
import type { LivePrompt, LiveTool, PromptMessage } from "./mcp-capabilities.ts";

/**
 * The capabilities catalog, served by the in-process kernel. The only live
 * capability a UI lists is SKILLS (as slash-command
 * prompts); downstream MCP tools were never surfaced at catalog time (the kernel
 * connects to them only during a run), and the declared servers come from
 * settings. So `listTools` is empty and the backend is always "connected".
 */
export function createKernelCapabilitiesClient(skills: SkillsService): McpClientCaps {
  return {
    listTools: async (): Promise<LiveTool[]> => [],
    listPrompts: async (): Promise<LivePrompt[]> => {
      const list = await skills.list();
      return list.map((s) => ({
        name: s.name,
        description: s.presentation?.shortDescription ?? s.description,
        ...(s.presentation?.displayName !== undefined
          ? { displayName: s.presentation.displayName }
          : {}),
        ...(s.arguments ? { arguments: s.arguments } : {}),
        ...(s.agent !== undefined ? { agent: s.agent } : {}),
        ...(s.plansMode !== undefined ? { plansMode: s.plansMode } : {}),
      }));
    },
    getPrompt: async (name: string, args: Record<string, string>): Promise<PromptMessage[]> => {
      const messages = await skills.getPrompt(name, { task: args.task });
      return messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : "",
      }));
    },
    connectionStatus: (): MCPStatus => "connected",
  };
}
