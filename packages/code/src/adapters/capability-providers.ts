import type { PlansSettingsBlock, SettingsFile } from "@clarvis/kernel/config";
import type { PluginView } from "./plugins.ts";

/** The settings shapes edited by the Memory & plan providers screen. */
export type MemorySettingsBlock = NonNullable<SettingsFile["memory"]>;
export type MemoryProviderConfig = NonNullable<MemorySettingsBlock["provider"]>;
export type PlanProviderConfig = NonNullable<PlansSettingsBlock["provider"]>;

export type ProviderCapability = "memory" | "plans";
export type PluginProviderGate = "not_installed" | "broken" | "disabled" | "not_offered" | "ready";

/** One plugin row in a capability provider picker, including stale selections. */
export interface ProviderPluginOption {
  name: string;
  gate: PluginProviderGate;
  detail: string;
  offered: boolean;
  plugin?: PluginView;
}

/** Built-in defaults used only when a settings block has no provider declaration. */
const BUILTIN_PLAN_PROVIDER: PlanProviderConfig = { kind: "markdown" };
const BUILTIN_MEMORY_PROVIDER: MemoryProviderConfig = { kind: "wiki" };

export function effectivePlanProvider(block?: PlansSettingsBlock): PlanProviderConfig {
  return block?.provider ?? BUILTIN_PLAN_PROVIDER;
}

export function effectiveMemoryProvider(block?: MemorySettingsBlock): MemoryProviderConfig {
  return block?.provider ?? BUILTIN_MEMORY_PROVIDER;
}

export function planProviderLabel(provider: PlanProviderConfig): string {
  if (provider.kind === "markdown") return "Markdown";
  if (provider.kind === "executable")
    return `executable · ${provider.command || "command required"}`;
  return `plugin · ${provider.plugin || "selection required"}`;
}

export function memoryProviderLabel(provider: MemoryProviderConfig): string {
  switch (provider.kind) {
    case "wiki":
      return "wiki";
    case "file":
      return `file · ${provider.paths.length} path${provider.paths.length === 1 ? "" : "s"}`;
    case "executable":
      return `executable · ${provider.command || "command required"}`;
    case "mcp":
      return `MCP · ${provider.server || "server required"}`;
    case "plugin":
      return `plugin · ${provider.plugin || "selection required"}`;
  }
}

function pluginGate(
  plugin: PluginView | undefined,
  capability: ProviderCapability,
): PluginProviderGate {
  if (!plugin) return "not_installed";
  if (plugin.error !== undefined) return "broken";
  if (!plugin.enabled) return "disabled";
  if (!plugin.contributions.capabilityExecutables.some((m) => m.capability === capability)) {
    return "not_offered";
  }
  return "ready";
}

function gateDetail(gate: PluginProviderGate, capability: ProviderCapability): string {
  switch (gate) {
    case "not_installed":
      return "not installed";
    case "broken":
      return "manifest missing or broken";
    case "disabled":
      return "disabled · enable it independently in Plugins";
    case "not_offered":
      return `installed plugin no longer offers ${capability}`;
    case "ready":
      return "ready for the next use";
  }
}

/**
 * List every installed plugin offering `capability`, plus the current selection
 * when it is absent or stale. This is a static manifest projection: it never
 * starts the executable.
 */
export function providerPluginOptions(
  plugins: readonly PluginView[],
  capability: ProviderCapability,
  selected?: string,
): ProviderPluginOption[] {
  const byName = new Map(plugins.map((plugin) => [plugin.name, plugin]));
  const names = new Set(
    plugins
      .filter((plugin) =>
        plugin.contributions.capabilityExecutables.some((m) => m.capability === capability),
      )
      .map((plugin) => plugin.name),
  );
  if (selected) names.add(selected);
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const plugin = byName.get(name);
      const gate = pluginGate(plugin, capability);
      return {
        name,
        gate,
        detail: gateDetail(gate, capability),
        offered:
          plugin?.contributions.capabilityExecutables.some((m) => m.capability === capability) ??
          false,
        ...(plugin ? { plugin } : {}),
      };
    });
}

/**
 * The selected plan-provider identity a client can know without touching code.
 * Direct executable identities are deliberately opaque to this static UI.
 */
export function knownPlanProviderKey(provider?: PlanProviderConfig): string | undefined {
  const selected = provider ?? BUILTIN_PLAN_PROVIDER;
  if (selected.kind === "markdown") return "markdown";
  if (selected.kind === "plugin" && selected.plugin.trim())
    return `plugin:${selected.plugin.trim()}`;
  return undefined;
}

export interface ProviderDraftIssue {
  field: string;
  message: string;
}

const required = (field: string, value: string): ProviderDraftIssue | null =>
  value.trim().length > 0 ? null : { field, message: `${field} is required` };

function executableIssue(provider: {
  command: string;
  args?: string[];
  timeout_ms?: number;
}): ProviderDraftIssue | null {
  const command = required("command", provider.command);
  if (command) return command;
  if (!(provider.args ?? []).every((arg) => typeof arg === "string")) {
    return { field: "args", message: "args must contain only strings" };
  }
  return provider.timeout_ms === undefined ||
    (Number.isInteger(provider.timeout_ms) && provider.timeout_ms > 0)
    ? null
    : { field: "timeout_ms", message: "timeout_ms must be a positive integer" };
}

export function validatePlanProviderDraft(block: PlansSettingsBlock): ProviderDraftIssue | null {
  const nudges = block.pending_task_nudges;
  if (nudges !== undefined && (!Number.isInteger(nudges) || nudges < 0)) {
    return {
      field: "pending_task_nudges",
      message: "pending_task_nudges must be a non-negative integer",
    };
  }
  const provider = effectivePlanProvider(block);
  if (provider.kind === "executable") return executableIssue(provider);
  if (provider.kind === "plugin") return required("plugin", provider.plugin);
  return null;
}

export function validateMemoryProviderDraft(block: MemorySettingsBlock): ProviderDraftIssue | null {
  const budgets = block.budgets;
  if (
    budgets?.seed_chars !== undefined &&
    (!Number.isInteger(budgets.seed_chars) || budgets.seed_chars < 500)
  ) {
    return {
      field: "budgets.seed_chars",
      message: "seed_chars must be an integer of at least 500",
    };
  }
  if (
    budgets?.digest_tokens !== undefined &&
    (!Number.isInteger(budgets.digest_tokens) || budgets.digest_tokens < 500)
  ) {
    return {
      field: "budgets.digest_tokens",
      message: "digest_tokens must be an integer of at least 500",
    };
  }
  if (
    budgets?.max_index_ops !== undefined &&
    (!Number.isInteger(budgets.max_index_ops) ||
      budgets.max_index_ops < 1 ||
      budgets.max_index_ops > 50)
  ) {
    return {
      field: "budgets.max_index_ops",
      message: "max_index_ops must be an integer from 1 to 50",
    };
  }

  const provider = effectiveMemoryProvider(block);
  switch (provider.kind) {
    case "wiki":
      return null;
    case "file":
      return provider.paths.length > 0 && provider.paths.every((path) => path.trim().length > 0)
        ? null
        : { field: "paths", message: "at least one non-empty path is required" };
    case "executable":
      return executableIssue(provider);
    case "mcp": {
      const values: [string, string][] = [
        ["server", provider.server],
        ["tools.list_memories", provider.tools.list_memories],
        ["tools.read_memory", provider.tools.read_memory],
        ["tools.grep_memories", provider.tools.grep_memories],
        ["tools.query_memories", provider.tools.query_memories],
      ];
      for (const [field, value] of values) {
        const issue = required(field, value);
        if (issue) return issue;
      }
      const writes = [
        provider.tools.write_memory,
        provider.tools.edit_memory,
        provider.tools.delete_memory,
      ];
      const present = writes.filter(
        (value) => value !== undefined && value.trim().length > 0,
      ).length;
      return present === 0 || present === 3
        ? null
        : {
            field: "tools.write_memory",
            message:
              "write_memory, edit_memory and delete_memory must all be present or all be absent",
          };
    }
    case "plugin":
      return required("plugin", provider.plugin);
  }
}
