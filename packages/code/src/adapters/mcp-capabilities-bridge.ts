import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";
import type { MCPStatus, PlansMode } from "@clarvis/protocol";
import type { Commands } from "../keys/commands.ts";
import {
  classifyCapability,
  reconcile,
  type LivePrompt,
  type LiveTool,
  type McpServerDecl,
  type PromptMessage,
  type ServerNode,
} from "./mcp-capabilities.ts";
import { diagnosticAsync, diagnosticCount, diagnosticEvent } from "../core/diagnostic-events.ts";

/** The subset of an MCP client the capabilities bridge needs to list and invoke downstream capabilities. */
export interface McpClientCaps {
  listTools(): Promise<LiveTool[]>;
  listPrompts(): Promise<LivePrompt[]>;
  getPrompt(name: string, args: Record<string, string>): Promise<PromptMessage[]>;
  connectionStatus(): MCPStatus;
}

/** Host callbacks the bridge invokes when a downstream prompt or skill is triggered. */
export interface McpEffects {
  submitPromptTurn(
    messages: PromptMessage[],
    display?: string,
    skill?: { name: string; task?: string; plansMode?: PlansMode },
  ): void;
  submitSkillRun(name: string, task: string, agent: string): void;
  activeProfile(): string;
  openMcpServers(server?: string): void;
  collectArgs(server: string, prompt: LivePrompt): Promise<Record<string, string> | null>;
}

/** The live, reconciled view of MCP servers/tools/prompts exposed to the UI. */
export interface McpCapabilities {
  nodes: Accessor<ServerNode[]>;
  refresh(): Promise<void>;
  /**
   * The agent a skill runs on, or `undefined` when it names none — which is also
   * how a caller learns the slash command is not a skill run at all.
   */
  skillAgent(name: string): string | undefined;
  /** Stop pending refreshes and unregister every prompt/skill command. */
  dispose(): void;
}

/** Dependencies for {@link createMcpCapabilities}. */
export interface McpCapabilitiesDeps {
  client: McpClientCaps;
  commands: Pick<Commands, "promptCommand" | "skillCommand">;
  effects: McpEffects;
  declared: () => McpServerDecl[];
  profiles: () => string[];
  /** Internal test seam for the pending-operation warning. */
  refreshSlowMs?: number;
}

function promptKey(server: string, local: string): string {
  return `${server}:${local}`;
}

/**
 * Build the live {@link McpCapabilities} view: reconciles declared MCP servers
 * against the connected client's live tools/prompts, and registers a slash
 * command for each downstream prompt and skill (deregistering ones that
 * disappear on the next {@link McpCapabilities.refresh}).
 *
 * @param deps - the client, command registry, effects, and declared-server/profile accessors.
 */
/**
 * Record an MCP listing that failed, and stand an empty list in for it.
 *
 * @param surface - `tools` or `prompts`, so one failing half is distinguishable.
 * @param error - why the listing failed.
 * @returns the empty array the reconciler is given, so a connected server whose
 *   listing failed reads as "no tools" rather than crashing the refresh.
 * @typeParam T - the element type of the list that was requested.
 */
function reportListFailure<T>(surface: "tools" | "prompts", error: unknown): T[] {
  diagnosticEvent("mcp.list.failed", { surface, error }, "warn");
  return [];
}

export function createMcpCapabilities(deps: McpCapabilitiesDeps): McpCapabilities {
  const [nodes, setNodes] = createSignal<ServerNode[]>([]);
  const registered = new Map<string, { fingerprint: string; off: () => void }>();
  const skillAgents = new Map<string, string>();
  let disposed = false;
  let refreshActive: Promise<void> | undefined;
  let refreshQueued = false;

  async function refreshOnce(): Promise<void> {
    const backend = deps.client.connectionStatus();
    let tools: LiveTool[] = [];
    let prompts: LivePrompt[] = [];
    if (backend === "connected") {
      [tools, prompts] = await Promise.all([
        deps.client
          .listTools()
          .catch((error: unknown) => reportListFailure<LiveTool>("tools", error)),
        deps.client
          .listPrompts()
          .catch((error: unknown) => reportListFailure<LivePrompt>("prompts", error)),
      ]);
    }
    if (disposed || refreshQueued) return;
    const profiles = deps.profiles();
    setNodes(reconcile(deps.declared(), tools, prompts, backend, profiles));
    syncPromptCommands(prompts, profiles);
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    diagnosticCount("mcp.refresh.requested");
    if (refreshActive !== undefined) {
      refreshQueued = true;
      diagnosticCount("mcp.refresh.coalesced");
      return refreshActive;
    }
    refreshActive = (async () => {
      try {
        do {
          refreshQueued = false;
          await diagnosticAsync(
            "mcp.refresh",
            refreshOnce,
            deps.refreshSlowMs === undefined ? {} : { slowMs: deps.refreshSlowMs },
          );
        } while (refreshQueued && !disposed);
      } finally {
        refreshActive = undefined;
      }
    })();
    return refreshActive;
  }

  function syncPromptCommands(prompts: LivePrompt[], profiles: string[]): void {
    const seen = new Set<string>();
    for (const p of prompts) {
      const c = classifyCapability(p.name, "prompt", profiles);
      if (c.origin === "skill") {
        const local = c.local;
        const key = `skill::${local}`;
        seen.add(key);
        if (p.agent !== undefined) skillAgents.set(local, p.agent);
        else skillAgents.delete(local);
        const spec: LivePrompt = {
          name: local,
          description: p.description,
          arguments: p.arguments,
          ...(p.displayName !== undefined ? { displayName: p.displayName } : {}),
          ...(p.agent !== undefined ? { agent: p.agent } : {}),
          ...(p.plansMode !== undefined ? { plansMode: p.plansMode } : {}),
        };
        const fingerprint = JSON.stringify(spec);
        const current = registered.get(key);
        if (current?.fingerprint === fingerprint) continue;
        current?.off();
        const off = deps.commands.skillCommand(local, spec, async (args) => {
          if (spec.agent !== undefined) {
            deps.effects.submitSkillRun(local, args, spec.agent);
            return;
          }
          const messages = await deps.client.getPrompt(local, { task: args });
          if (disposed) return;
          deps.effects.submitPromptTurn(messages, args ? `/${local} ${args}` : `/${local}`, {
            name: local,
            ...(args.length > 0 ? { task: args } : {}),
            ...(spec.plansMode !== undefined ? { plansMode: spec.plansMode } : {}),
          });
        });
        registered.set(key, { fingerprint, off });
        continue;
      }
      if (c.origin !== "downstream" || !c.server) continue;
      const server = c.server;
      const local = c.local;
      const key = promptKey(server, local);
      seen.add(key);
      const spec: LivePrompt = { name: local, description: p.description, arguments: p.arguments };
      const fingerprint = JSON.stringify(spec);
      const current = registered.get(key);
      if (current?.fingerprint === fingerprint) continue;
      current?.off();
      const off = deps.commands.promptCommand(server, spec, async () => {
        let args: Record<string, string> = {};
        if (spec.arguments && spec.arguments.length > 0) {
          const collected = await deps.effects.collectArgs(server, spec);
          if (disposed || collected === null) return;
          args = collected;
        }
        const messages = await deps.client.getPrompt(promptKey(server, local), args);
        if (disposed) return;
        deps.effects.submitPromptTurn(messages, `/${promptKey(server, local)}`);
      });
      registered.set(key, { fingerprint, off });
    }
    for (const [key, registration] of registered) {
      if (!seen.has(key)) {
        registration.off();
        registered.delete(key);
        if (key.startsWith("skill::")) skillAgents.delete(key.slice("skill::".length));
      }
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    refreshQueued = false;
    for (const { off } of [...registered.values()].reverse()) {
      try {
        off();
      } catch {}
    }
    registered.clear();
    skillAgents.clear();
    setNodes([]);
  }

  return {
    nodes,
    refresh,
    skillAgent: (name: string) => skillAgents.get(name),
    dispose,
  };
}
