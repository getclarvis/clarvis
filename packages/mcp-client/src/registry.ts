import type {
  Logger,
  MCPConnection,
  NamespacedTool,
  Resolved,
  NamespacedRegistry,
} from "@clarvis/capability";
import { NOOP_LOGGER } from "@clarvis/capability";
import type { NamespacedToolDescriptor } from "./connection.ts";

export type { NamespacedRegistry } from "@clarvis/capability";

/**
 * Derive a model-safe, collision-free wire name from a tool's `mcp.tool`
 * full name.
 *
 * @param fullName - the dotted `mcpName.toolName`.
 * @param used - the set of names already taken; the chosen name is added to it.
 * @param onRename - notified when the sanitized base was already taken and a
 *   suffix had to be added, with the base and the name finally chosen.
 * @returns the sanitized name (every char outside `[A-Za-z0-9_-]` replaced with
 *   `_`), suffixed `_1`, `_2`, … until unique against `used`.
 * @remarks Seed `used` with the host's reserved names to keep MCP tools from
 *   shadowing built-in or agent tool names.
 *
 *   The rename used to be silent, which is the worst property a rename can
 *   have: the operator saw a tool named `read_file_1` with nothing saying why,
 *   and the model was handed a name its server had never heard of.
 */
export function toWireToolName(
  fullName: string,
  used: Set<string>,
  onRename?: (base: string, wireName: string) => void,
): string {
  const base = fullName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const occupied = new Set([...used].map((name) => name.toLowerCase()));
  let candidate = base;
  let i = 1;
  while (occupied.has(candidate.toLowerCase())) {
    candidate = `${base}_${i++}`;
  }
  used.add(candidate);
  if (candidate !== base) onRename?.(base, candidate);
  return candidate;
}

/** One connection paired with the tools it contributes to a registry — the unit
 * {@link buildRegistry}, {@link poolToolNames} and {@link selectTools} operate
 * over. */
export interface RegistryEntry {
  conn: MCPConnection;
  tools: NamespacedToolDescriptor[];
}

/**
 * Build the lookup tables backing a {@link NamespacedRegistry}: assign each tool
 * a unique wire name and index every tool by wire name, dotted full name, and
 * their lowercased forms (first-wins on lowercase collisions).
 *
 * @param entries - the connections and their tools.
 * @param reserved - the wire names an MCP tool may not take.
 * @returns a registry whose `resolve` tries exact wire name, then exact full
 *   name, then a case-insensitive match, and whose `allUnavailable` is true only
 *   when every connection is `unavailable` (false when there are no
 *   connections).
 */
function makeRegistry(
  entries: RegistryEntry[],
  reserved: readonly string[],
  logger: Logger,
): NamespacedRegistry {
  const reservedLower = new Set(reserved.map((name) => name.toLowerCase()));
  const tools: NamespacedTool[] = [];
  const byWireName = new Map<string, Resolved>();
  const byFullName = new Map<string, Resolved>();
  const byLowerName = new Map<string, Resolved>();
  const usedWireNames = new Set<string>(reserved);
  const conns: MCPConnection[] = entries.map((e) => e.conn);
  const localNameCounts = new Map<string, number>();
  for (const entry of entries) {
    for (const tool of entry.tools) {
      const key = tool.name.toLowerCase();
      localNameCounts.set(key, (localNameCounts.get(key) ?? 0) + 1);
    }
  }
  const localReservations = new Set<string>();
  for (const entry of entries) {
    for (const tool of entry.tools) {
      const localLower = tool.name.toLowerCase();
      if (
        /^[a-zA-Z0-9_-]+$/.test(tool.name) &&
        localNameCounts.get(localLower) === 1 &&
        !reservedLower.has(localLower)
      ) {
        localReservations.add(tool.name);
      }
    }
  }
  for (const name of localReservations) usedWireNames.add(name);

  for (const { conn, tools: toolList } of entries) {
    for (const t of toolList) {
      const fullName = `${conn.name}.${t.name}`;
      const localLower = t.name.toLowerCase();
      const localSafe = /^[a-zA-Z0-9_-]+$/.test(t.name);
      const useLocal =
        localSafe && localNameCounts.get(localLower) === 1 && !reservedLower.has(localLower);
      let collisionRenamed = false;
      const wireName = useLocal
        ? t.name
        : toWireToolName(fullName, usedWireNames, (base, chosen) => {
            collisionRenamed = true;
            logger.warn(
              {
                event: "mcp.registry.renamed",
                mcp: conn.name,
                tool: t.name,
                full_name: fullName,
                wire_name: chosen,
                reason: reservedLower.has(base.toLowerCase()) ? "reserved" : "collision",
              },
              "mcp tool's wire name was already taken, so the model is offered it under a " +
                "suffixed name; a call by its original name will not reach this server",
            );
          });
      if (!useLocal && !collisionRenamed) {
        logger.warn(
          {
            event: "mcp.registry.renamed",
            mcp: conn.name,
            tool: t.name,
            full_name: fullName,
            wire_name: wireName,
            reason: !localSafe
              ? "invalid"
              : reservedLower.has(localLower)
                ? "reserved"
                : "collision",
          },
          "mcp tool's local name cannot be offered safely, so the model is offered its " +
            "namespaced form",
        );
      }
      const namespaced: NamespacedTool = {
        fullName,
        wireName,
        mcpName: conn.name,
        toolName: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.kind !== undefined ? { kind: t.kind } : {}),
      };
      tools.push(namespaced);
      const resolved: Resolved = {
        connection: conn,
        toolName: t.name,
        fullName,
        inputSchema: t.inputSchema,
        ...(t.kind !== undefined ? { kind: t.kind } : {}),
      };
      byWireName.set(wireName, resolved);
      byFullName.set(fullName, resolved);
      if (!byLowerName.has(wireName.toLowerCase()))
        byLowerName.set(wireName.toLowerCase(), resolved);
      if (!byLowerName.has(fullName.toLowerCase()))
        byLowerName.set(fullName.toLowerCase(), resolved);
    }
  }

  return {
    tools,
    resolve(name: string): Resolved | null {
      return (
        byWireName.get(name) ?? byFullName.get(name) ?? byLowerName.get(name.toLowerCase()) ?? null
      );
    },
    allUnavailable(): boolean {
      if (conns.length === 0) return false;
      return conns.every((c) => c.status === "unavailable");
    },
  };
}

/**
 * Assemble a {@link NamespacedRegistry} from connection/tool entries, giving the
 * runtime name resolution and an aggregate availability check.
 *
 * @param entries - the connections and their tools.
 * @param reserved - the wire names an MCP tool may not take, seeded into the
 *   uniqueness set so a server cannot shadow a host tool. Required rather than
 *   defaulted to empty: a host that forgets it would silently reintroduce the
 *   shadowing this parameter exists to prevent, and nothing would report it.
 * @param options - optional `logger`; a rename is reported through it.
 * @returns the registry; see {@link makeRegistry} for the resolution order.
 */
export function buildRegistry(
  entries: RegistryEntry[],
  reserved: readonly string[],
  options: BuildRegistryOptions = {},
): NamespacedRegistry {
  return makeRegistry(entries, reserved, options.logger ?? NOOP_LOGGER);
}

/** Optional inputs to {@link buildRegistry}. */
export interface BuildRegistryOptions {
  /** Where a wire-name rename is reported. */
  logger?: Logger;
}

/**
 * List every tool's dotted `mcpName.toolName` across all entries, in order.
 *
 * @param entries - the connections and their tools.
 * @returns the full names, e.g. for granting or display.
 */
export function poolToolNames(entries: RegistryEntry[]): string[] {
  return entries.flatMap((e) => e.tools.map((t) => `${e.conn.name}.${t.name}`));
}

/**
 * Narrow entries to only the tools whose dotted full name is in `names`.
 *
 * @param entries - the connections and their tools.
 * @param names - the allowed `mcpName.toolName` full names; when omitted,
 *   `entries` is returned unchanged (no filtering).
 * @returns entries with non-matching tools removed and any now-empty connection
 *   dropped.
 */
export function selectTools(entries: RegistryEntry[], names?: string[]): RegistryEntry[] {
  if (!names) return entries;
  const wanted = new Set(names);
  return entries
    .map((e) => ({
      conn: e.conn,
      tools: e.tools.filter((t) => wanted.has(`${e.conn.name}.${t.name}`)),
    }))
    .filter((e) => e.tools.length > 0);
}
