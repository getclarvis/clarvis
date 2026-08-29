import type { McpServerConfig } from "@clarvis/capability";
import type { McpServerSettings } from "./settings-schema.ts";

/**
 * The `settings.json` keys {@link settingsServerToEngine} carries into the
 * engine's {@link McpServerConfig}. `type` is renamed to `transport`; the rest
 * pass through under their own names.
 */
type MappedSettingsKey =
  | "type"
  | "command"
  | "args"
  | "url"
  | "headers"
  | "env"
  | "cwd"
  | "expandVariables"
  | "shared"
  | "resources";

/**
 * Compile-time drift guard: only type-checks while every key of
 * {@link McpServerSettings} is one the mapper carries.
 *
 * @remarks A key added to the settings schema and forgotten here would otherwise
 *   be dropped in silence on the way to the engine — which is exactly how the
 *   `type`/`transport` mismatch survived from the initial commit. This breaks the
 *   build instead.
 */
type MapperCoversSettings = [Exclude<keyof McpServerSettings, MappedSettingsKey>] extends [never]
  ? true
  : false;

const _engineServerDriftLock: MapperCoversSettings = true;
void _engineServerDriftLock;

/**
 * Translate one validated `settings.json` MCP server entry into the engine's
 * {@link McpServerConfig}.
 *
 * The two schemas are deliberately different shapes: `settings.json` uses the
 * ecosystem-standard `mcpServers` map keyed by name and spells the transport
 * `type`, while the engine takes a flat array whose entries carry their own
 * `name` and spell it `transport`. This function is the only sanctioned bridge
 * between them.
 *
 * @param name - the server's map key in `settings.json`, which becomes the
 *   engine entry's `name` (the namespace for its tools).
 * @param entry - a server entry already parsed by `mcpServerSettingsSchema`.
 * @returns the engine-shaped config, carrying only the keys `entry` actually set.
 * @remarks `entry.type` is always present because the settings schema defaults it
 *   to `stdio`. A declared `cwd` is carried exactly; otherwise the client factory
 *   applies its workspace-rooted default.
 */
export function settingsServerToEngine(name: string, entry: McpServerSettings): McpServerConfig {
  return {
    name,
    transport: entry.type,
    ...(entry.command !== undefined ? { command: entry.command } : {}),
    ...(entry.args !== undefined ? { args: entry.args } : {}),
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
    ...(entry.env !== undefined ? { env: entry.env } : {}),
    ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
    ...(entry.expandVariables !== undefined ? { expandVariables: entry.expandVariables } : {}),
    ...(entry.shared !== undefined ? { shared: entry.shared } : {}),
    ...(entry.resources !== undefined ? { resources: entry.resources } : {}),
  };
}
