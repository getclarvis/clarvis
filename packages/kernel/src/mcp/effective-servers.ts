import type { McpServerConfig } from "@clarvis/capability";
import { settingsServerToEngine, type McpServerSettings } from "@clarvis/loop/host";
import type { ConfigStore, SettingsSnapshot } from "../config/config-store.ts";

/** Validated effective MCP declarations in their settings-layer shape. */
export function effectiveMcpServerSettings(
  snapshot: SettingsSnapshot,
): Record<string, McpServerSettings> {
  const value = (snapshot.merged as { mcpServers?: unknown }).mcpServers;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, McpServerSettings>)
    : {};
}

/** Convert the current effective declarations into the engine/pool shape. */
export function effectiveMcpServers(configStore: ConfigStore): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(effectiveMcpServerSettings(configStore.readSettings()))
      .filter(([, declaration]) => declaration.enabled !== false)
      .map(([name, declaration]) => [name, settingsServerToEngine(name, declaration)]),
  );
}
