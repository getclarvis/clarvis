import { createHash } from "node:crypto";
import { sanitizeDeep, sanitizeErrorMessage, type Logger } from "@clarvis/capability";
import { readCapabilitySettings, settingsServerToEngine } from "@clarvis/loop/host";
import {
  TaskProviderError,
  createMcpTaskProvider,
  probeMcpTaskCapabilities,
  taskProviderKey,
  type TaskProviderResolution,
  type TaskProviderResolver,
  type TaskServerPortResolver,
} from "@clarvis/tasks";
import { tasksSettingsSpec, type ResolvedTasksSettingsBlock } from "@clarvis/tasks/settings";
import type { ConfigStore, SettingsSnapshot } from "../config/config-store.ts";
import type {
  PluginContributions,
  ResolvedPluginMcpContribution,
} from "../plugins/plugin-contributions.ts";
import { effectiveMcpServerSettings } from "../mcp/effective-servers.ts";

export interface TaskProviderRuntimeStatus {
  state: "not_configured" | "ready" | "unavailable" | "incompatible";
  providerKey?: string;
  providerKind?: string;
  server?: string;
  writes: "disabled" | "enabled";
  reason?: string;
}

export interface TaskProviderFactoryOptions {
  configStore: ConfigStore;
  serverPort: TaskServerPortResolver;
  pluginContributions: PluginContributions;
  /** Environment used by the MCP client to resolve `${VAR}` references. */
  environment?: Readonly<Record<string, string | undefined>>;
  enabled?: boolean;
  now?: () => number;
  capabilitiesTtlMs?: number;
  cacheMax?: number;
  /**
   * The `tasks` component logger, handed to every provider this factory builds
   * and to the capability probe that precedes one.
   */
  logger?: Logger;
}

const DEFAULT_CAPABILITIES_TTL_MS = 30_000;
const DEFAULT_RESOLUTION_CACHE_MAX = 256;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function environmentReferences(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)) {
      const name = match[1];
      if (name !== undefined) into.add(name);
    }
  } else if (Array.isArray(value)) {
    for (const child of value) environmentReferences(child, into);
  } else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      environmentReferences(child, into);
    }
  }
  return into;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    return Promise.reject(new TaskProviderError("task_cancelled", "Task request was cancelled."));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new TaskProviderError("task_cancelled", "Task request was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(
          error instanceof Error
            ? error
            : new TaskProviderError(
                "task_provider_unavailable",
                sanitizeErrorMessage(String(error)),
              ),
        );
      },
    );
  });
}

function settingsOf(snapshot: SettingsSnapshot): ResolvedTasksSettingsBlock | undefined {
  return readCapabilitySettings<ResolvedTasksSettingsBlock>(snapshot.merged, tasksSettingsSpec);
}

function directlyDeclared(snapshot: SettingsSnapshot, server: string): boolean {
  const has = (scope: unknown): boolean => {
    if (typeof scope !== "object" || scope === null) return false;
    const servers = (scope as { mcpServers?: unknown }).mcpServers;
    return (
      typeof servers === "object" &&
      servers !== null &&
      !Array.isArray(servers) &&
      Object.prototype.hasOwnProperty.call(servers, server)
    );
  };
  if (has(snapshot.scopes.global)) return true;
  return (
    !snapshot.withheld_workspace_fields?.includes("mcpServers") && has(snapshot.scopes.workspace)
  );
}

function pluginFor(
  snapshot: SettingsSnapshot,
  server: string,
  contributions: readonly ResolvedPluginMcpContribution[],
): ResolvedPluginMcpContribution | undefined {
  if (directlyDeclared(snapshot, server)) return undefined;
  return contributions.find((candidate) => candidate.effectiveName === server);
}

interface ProviderSelection {
  readonly settings: ResolvedTasksSettingsBlock;
  readonly server: string;
  readonly declaration: ReturnType<typeof settingsServerToEngine>;
  readonly publicDeclaration: unknown;
  readonly plugin?: ResolvedPluginMcpContribution;
  readonly fingerprint: string;
}

interface CachedResolution {
  readonly resolution: TaskProviderResolution;
  expiresAt: number;
  lastUsedAt: number;
}

/**
 * One settings-sensitive provider selector shared by run capability and control plane.
 *
 * @remarks Public identity retains secret reference names but never resolved
 * values. The private cache fingerprint includes resolved material so a secret
 * rotation invalidates sessions. Concurrent capability probes are
 * single-flight per owner; cancellation detaches only that waiter.
 */
export class TaskProviderFactory implements TaskProviderResolver {
  private readonly cache = new Map<string, CachedResolution>();
  private readonly inFlight = new Map<string, Promise<TaskProviderResolution>>();

  constructor(private readonly options: TaskProviderFactoryOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private selection(snapshot: SettingsSnapshot): ProviderSelection {
    const settings = settingsOf(snapshot);
    if (settings === undefined) {
      throw new TaskProviderError("task_not_configured", "No Tasks provider is configured.");
    }
    const server = settings.provider.server;
    const rawDeclaration = effectiveMcpServerSettings(snapshot)[server];
    if (rawDeclaration === undefined) {
      throw new TaskProviderError(
        "task_provider_unavailable",
        `The selected MCP server '${server}' is absent, disabled, or untrusted.`,
      );
    }
    const merged = snapshot.merged as Record<string, unknown>;
    const enabledPlugins = Array.isArray(merged.enabledPlugins)
      ? (merged.enabledPlugins as string[])
      : [];
    const plugin = pluginFor(
      snapshot,
      server,
      this.options.pluginContributions.mcpServers(enabledPlugins),
    );
    const declaration = freezeDeep(
      structuredClone(settingsServerToEngine(server, structuredClone(rawDeclaration))),
    );
    const environment = this.options.environment ?? process.env;
    const secretReferences = [...environmentReferences(rawDeclaration)].sort();
    const resolvedSecretMaterial = Object.fromEntries(
      secretReferences.map((name) => [name, environment[name] ?? null]),
    );
    const pluginIdentity =
      plugin === undefined
        ? undefined
        : {
            name: plugin.plugin,
            version: plugin.pluginVersion,
            revision: plugin.resolvedRevision,
          };
    return {
      settings,
      server,
      declaration,
      publicDeclaration: {
        declaration: sanitizeDeep(rawDeclaration),
        secretReferences,
      },
      ...(plugin === undefined ? {} : { plugin }),
      fingerprint: digest({
        settings,
        declaration: rawDeclaration,
        plugin: pluginIdentity,
        resolvedSecretMaterial,
      }),
    };
  }

  private sweep(now: number): void {
    for (const [key, value] of this.cache) {
      if (value.expiresAt <= now) this.cache.delete(key);
    }
    const max = this.options.cacheMax ?? DEFAULT_RESOLUTION_CACHE_MAX;
    while (this.cache.size > max) {
      let oldestKey: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, value] of this.cache) {
        if (value.lastUsedAt < oldest) {
          oldest = value.lastUsedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }

  async resolve(
    owner: string,
    expectedProviderKey?: string,
    signal?: AbortSignal,
  ): Promise<TaskProviderResolution> {
    if (this.options.enabled === false) {
      throw new TaskProviderError("task_not_configured", "Tasks are disabled in this host.");
    }
    const snapshot = this.options.configStore.readSettings();
    const selection = this.selection(snapshot);
    const now = this.now();
    this.sweep(now);
    const cacheKey = `${owner}\u0000${selection.fingerprint}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      cached.lastUsedAt = now;
      if (
        expectedProviderKey !== undefined &&
        expectedProviderKey !== cached.resolution.provider.key
      ) {
        throw new TaskProviderError(
          "task_provider_mismatch",
          `Task expects provider '${expectedProviderKey}', but '${cached.resolution.provider.key}' is selected.`,
        );
      }
      return cached.resolution;
    }

    let pending = this.inFlight.get(cacheKey);
    if (pending === undefined) {
      pending = (async (): Promise<TaskProviderResolution> => {
        const port = this.options.serverPort.forOwner(owner, {
          server: selection.server,
          declaration: selection.declaration,
        });
        const capabilities = await probeMcpTaskCapabilities({
          owner,
          port,
          ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
        });
        const key = taskProviderKey({
          kind: "mcp",
          server: selection.server,
          protocol: selection.settings.provider.protocol,
          providerKind: capabilities.providerKind,
          providerInstanceId: capabilities.providerInstanceId,
          declaration: selection.publicDeclaration,
          ...(selection.plugin === undefined
            ? {}
            : {
                plugin: {
                  name: selection.plugin.plugin,
                  ...(selection.plugin.pluginVersion === undefined
                    ? {}
                    : { version: selection.plugin.pluginVersion }),
                  ...(selection.plugin.resolvedRevision === undefined
                    ? {}
                    : { revision: selection.plugin.resolvedRevision }),
                },
              }),
        });
        const provider = await createMcpTaskProvider({
          owner,
          key,
          port,
          capabilities,
          ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
        });
        const resolution: TaskProviderResolution = {
          provider,
          capabilities,
          writes: selection.settings.writes,
          ...(selection.settings.default_container === undefined
            ? {}
            : { defaultContainer: selection.settings.default_container }),
          server: selection.server,
        };
        const completedAt = this.now();
        this.cache.set(cacheKey, {
          resolution,
          expiresAt: completedAt + (this.options.capabilitiesTtlMs ?? DEFAULT_CAPABILITIES_TTL_MS),
          lastUsedAt: completedAt,
        });
        this.sweep(completedAt);
        return resolution;
      })().finally(() => this.inFlight.delete(cacheKey));
      this.inFlight.set(cacheKey, pending);
    }
    const resolution = await waitFor(pending, signal);
    if (expectedProviderKey !== undefined && expectedProviderKey !== resolution.provider.key) {
      throw new TaskProviderError(
        "task_provider_mismatch",
        `Task expects provider '${expectedProviderKey}', but '${resolution.provider.key}' is selected.`,
      );
    }
    return resolution;
  }

  async status(owner: string, signal?: AbortSignal): Promise<TaskProviderRuntimeStatus> {
    const settings =
      this.options.enabled === false
        ? undefined
        : settingsOf(this.options.configStore.readSettings());
    if (settings === undefined) {
      return {
        state: "not_configured",
        writes: "disabled",
        ...(this.options.enabled === false ? { reason: "Tasks are disabled in this host." } : {}),
      };
    }
    try {
      const resolution = await this.resolve(owner, undefined, signal);
      return {
        state: "ready",
        providerKey: resolution.provider.key,
        providerKind: resolution.provider.kind,
        server: resolution.server,
        writes: resolution.writes,
      };
    } catch (error) {
      if (error instanceof TaskProviderError && error.code === "task_cancelled") throw error;
      const taskError =
        error instanceof TaskProviderError
          ? error
          : new TaskProviderError(
              "task_provider_unavailable",
              error instanceof Error ? error.message : String(error),
              { cause: error },
            );
      return {
        state: taskError.code === "task_invalid_response" ? "incompatible" : "unavailable",
        server: settings.provider.server,
        writes: settings.writes,
        reason: sanitizeErrorMessage(taskError.message),
      };
    }
  }
}
