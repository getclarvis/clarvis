import { describe, expect, it } from "bun:test";
import type { SettingsData } from "@clarvis/protocol";
import type { TaskServerPortResolver } from "@clarvis/tasks";
import { createMemoryConfigStore } from "../../src/config/memory-config-store.ts";
import type { ConfigStore, SettingsSnapshot } from "../../src/config/config-store.ts";
import { effectiveMcpServers } from "../../src/mcp/effective-servers.ts";
import type { PluginContributions } from "../../src/plugins/plugin-contributions.ts";
import { TaskProviderFactory } from "../../src/tasks/task-provider-factory.ts";

const CAPABILITIES = {
  protocol_version: 2,
  provider_kind: "jira",
  provider_instance_id: "jira-cloud:tenant-a",
  read: { containers: true, search: true, get: true, actors: false },
  write: {
    create: false,
    assign: false,
    comment: true,
    attach_artifact: false,
    intents: ["start", "submit_review"],
  },
  concurrency: "exclusive_claim",
};

function settings(server = "jira-work:tasks", url = "https://tasks.example/mcp"): SettingsData {
  return {
    mcpServers: { [server]: { type: "http", url } },
    tasks: {
      provider: { kind: "mcp", server, protocol: "clarvis.tasks.v2" },
      default_container: "CLAR",
      writes: "enabled",
    },
  };
}

function pluginContributions(
  over: { version?: string; revision?: string; enabled?: boolean } = {},
): PluginContributions {
  return {
    mcpServers: () =>
      over.enabled === false
        ? []
        : [
            {
              effectiveName: "jira-work:tasks",
              plugin: "jira-work",
              ...(over.version === undefined ? {} : { pluginVersion: over.version }),
              ...(over.revision === undefined ? {} : { resolvedRevision: over.revision }),
              declaration: { type: "http", url: "https://tasks.example/mcp" },
            },
          ],
  } as unknown as PluginContributions;
}

function port(options: { malformed?: boolean; providerInstanceId?: string } = {}) {
  const owners: string[] = [];
  const bindings: Array<{ server: string; declaration: unknown }> = [];
  const resolver: TaskServerPortResolver = {
    forOwner(owner, binding) {
      owners.push(owner);
      bindings.push(binding);
      return {
        async callTool(tool) {
          if (tool !== "tasks_capabilities" || options.malformed === true) {
            return { isError: false, data: { protocol_version: 9, ok: true, result: {} } };
          }
          return {
            isError: false,
            data: {
              protocol_version: 2,
              provider_instance_id: options.providerInstanceId ?? CAPABILITIES.provider_instance_id,
              ok: true,
              result: {
                ...CAPABILITIES,
                provider_instance_id:
                  options.providerInstanceId ?? CAPABILITIES.provider_instance_id,
              },
            },
          };
        },
      };
    },
  };
  return { resolver, owners, bindings };
}

function snapshotStore(snapshot: SettingsSnapshot): ConfigStore {
  return { readSettings: () => snapshot } as unknown as ConfigStore;
}

describe("TaskProviderFactory", () => {
  it("converts effective settings declarations through the shared MCP adapter", () => {
    const store = createMemoryConfigStore({
      settings: {
        global: {
          mcpServers: {
            tasks: { type: "http", url: "https://tasks.example/mcp" },
          },
        },
      },
    });
    expect(effectiveMcpServers(store).tasks).toMatchObject({
      name: "tasks",
      transport: "http",
      url: "https://tasks.example/mcp",
    });
  });

  it("resolves live operator settings and rejects a continuation key after declaration change", async () => {
    const store = createMemoryConfigStore({ settings: { global: settings("operator-tasks") } });
    const serverPort = port();
    const factory = new TaskProviderFactory({
      configStore: store,
      serverPort: serverPort.resolver,
      pluginContributions: pluginContributions({ enabled: false }),
    });

    const first = await factory.resolve("alice");
    expect(first).toMatchObject({
      writes: "enabled",
      defaultContainer: "CLAR",
      server: "operator-tasks",
      capabilities: { providerKind: "jira", concurrency: "exclusive_claim" },
    });
    expect(serverPort.owners).toEqual(["alice"]);
    expect(serverPort.bindings[0]).toMatchObject({
      server: "operator-tasks",
      declaration: { name: "operator-tasks", url: "https://tasks.example/mcp" },
    });
    expect((await factory.resolve("alice", first.provider.key)).provider.key).toBe(
      first.provider.key,
    );

    store.writeSettings("global", settings("operator-tasks", "https://changed.example/mcp"));
    await expect(factory.resolve("alice", first.provider.key)).rejects.toMatchObject({
      code: "task_provider_mismatch",
    });
    expect((await factory.resolve("alice")).provider.key).not.toBe(first.provider.key);
  });

  it("includes resolved plugin identity in keys without letting enablement select it", async () => {
    const merged = { ...settings(), enabledPlugins: ["jira-work"] };
    const snapshot: SettingsSnapshot = { merged, scopes: {}, sources: [] };
    const serverPort = port();
    const factory = (revision: string) =>
      new TaskProviderFactory({
        configStore: snapshotStore(snapshot),
        serverPort: serverPort.resolver,
        pluginContributions: pluginContributions({ version: "1.0.0", revision }),
      });

    const oldKey = (await factory("abc").resolve("alice")).provider.key;
    const newKey = (await factory("def").resolve("alice")).provider.key;
    expect(newKey).not.toBe(oldKey);

    const enabledWithoutSelection = createMemoryConfigStore({
      settings: {
        global: {
          mcpServers: (merged as Record<string, unknown>).mcpServers,
          enabledPlugins: ["jira-work"],
        },
      },
    });
    await expect(
      new TaskProviderFactory({
        configStore: enabledWithoutSelection,
        serverPort: serverPort.resolver,
        pluginContributions: pluginContributions(),
      }).resolve("alice"),
    ).rejects.toMatchObject({ code: "task_not_configured" });
  });

  it("reports absent, disabled, and incompatible selections without probing writes", async () => {
    const serverPort = port();
    const unconfigured = new TaskProviderFactory({
      configStore: createMemoryConfigStore(),
      serverPort: serverPort.resolver,
      pluginContributions: pluginContributions(),
    });
    expect(await unconfigured.status("alice")).toEqual({
      state: "not_configured",
      writes: "disabled",
    });

    const missing = new TaskProviderFactory({
      configStore: createMemoryConfigStore({
        settings: {
          global: {
            tasks: {
              provider: {
                kind: "mcp",
                server: "jira-work:tasks",
                protocol: "clarvis.tasks.v2",
              },
              writes: "enabled",
            },
          },
        },
      }),
      serverPort: serverPort.resolver,
      pluginContributions: pluginContributions({ enabled: false }),
    });
    expect(await missing.status("alice")).toMatchObject({
      state: "unavailable",
      server: "jira-work:tasks",
      writes: "enabled",
    });

    const incompatible = new TaskProviderFactory({
      configStore: createMemoryConfigStore({ settings: { global: settings() } }),
      serverPort: port({ malformed: true }).resolver,
      pluginContributions: pluginContributions(),
    });
    expect(await incompatible.status("alice")).toMatchObject({
      state: "incompatible",
      server: "jira-work:tasks",
    });

    const disabled = new TaskProviderFactory({
      configStore: createMemoryConfigStore({ settings: { global: settings() } }),
      serverPort: serverPort.resolver,
      pluginContributions: pluginContributions(),
      enabled: false,
    });
    expect(await disabled.status("alice")).toEqual({
      state: "not_configured",
      writes: "disabled",
      reason: "Tasks are disabled in this host.",
    });
  });

  it("single-flights probes per owner, bounds them by TTL, and isolates owners", async () => {
    let currentTime = 1_000;
    const serverPort = port();
    const factory = new TaskProviderFactory({
      configStore: createMemoryConfigStore({
        settings: { global: settings("operator-tasks") },
      }),
      serverPort: serverPort.resolver,
      pluginContributions: pluginContributions({ enabled: false }),
      now: () => currentTime,
      capabilitiesTtlMs: 30,
    });

    const [left, right] = await Promise.all([factory.resolve("alice"), factory.resolve("alice")]);
    expect(left.provider).toBe(right.provider);
    expect(serverPort.owners).toEqual(["alice"]);

    currentTime += 20;
    await factory.resolve("alice");
    expect(serverPort.owners).toEqual(["alice"]);

    await factory.resolve("bob");
    expect(serverPort.owners).toEqual(["alice", "bob"]);

    currentTime += 11;
    await factory.resolve("alice");
    expect(serverPort.owners).toEqual(["alice", "bob", "alice"]);
  });

  it("invalidates the runtime on secret rotation without putting secret values in provider identity", async () => {
    const environment: Record<string, string | undefined> = { TASK_TOKEN: "first-secret" };
    const store = createMemoryConfigStore({
      settings: {
        global: {
          mcpServers: {
            "operator-tasks": {
              type: "http",
              url: "https://tasks.example/mcp",
              headers: { Authorization: "Bearer ${TASK_TOKEN}" },
            },
          },
          tasks: {
            provider: {
              kind: "mcp",
              server: "operator-tasks",
              protocol: "clarvis.tasks.v2",
            },
          },
        },
      },
    });
    const serverPort = port();
    const factory = new TaskProviderFactory({
      configStore: store,
      serverPort: serverPort.resolver,
      pluginContributions: pluginContributions({ enabled: false }),
      environment,
    });

    const first = await factory.resolve("alice");
    environment.TASK_TOKEN = "second-secret";
    const rotated = await factory.resolve("alice");

    expect(rotated.provider.key).toBe(first.provider.key);
    expect(serverPort.owners).toEqual(["alice", "alice"]);
    expect(first.provider.key).not.toContain("first-secret");
    expect(first.provider.key).not.toContain("second-secret");
  });

  it("changes provider identity when the backend instance handshake changes", async () => {
    const store = createMemoryConfigStore({
      settings: { global: settings("operator-tasks") },
    });
    const resolve = async (providerInstanceId: string) =>
      new TaskProviderFactory({
        configStore: store,
        serverPort: port({ providerInstanceId }).resolver,
        pluginContributions: pluginContributions({ enabled: false }),
      }).resolve("alice");

    expect((await resolve("tenant-a")).provider.key).not.toBe(
      (await resolve("tenant-b")).provider.key,
    );
  });

  it("detaches a cancelled capability-probe waiter without cancelling shared resolution", async () => {
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let probes = 0;
    const serverPort: TaskServerPortResolver = {
      forOwner() {
        return {
          async callTool() {
            probes += 1;
            await probeGate;
            return {
              isError: false,
              data: {
                protocol_version: 2,
                provider_instance_id: CAPABILITIES.provider_instance_id,
                ok: true,
                result: CAPABILITIES,
              },
            };
          },
        };
      },
    };
    const factory = new TaskProviderFactory({
      configStore: createMemoryConfigStore({
        settings: { global: settings("operator-tasks") },
      }),
      serverPort,
      pluginContributions: pluginContributions({ enabled: false }),
    });
    const controller = new AbortController();
    const cancelled = factory.resolve("alice", undefined, controller.signal);
    const retained = factory.resolve("alice");

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "task_cancelled" });
    expect(probes).toBe(1);
    releaseProbe();
    expect(await retained).toMatchObject({ capabilities: { providerKind: "jira" } });
  });

  it("normalizes a non-error failure from a shared capability probe", async () => {
    const serverPort: TaskServerPortResolver = {
      forOwner() {
        throw "probe failed\u001b[31m";
      },
    };
    const factory = new TaskProviderFactory({
      configStore: createMemoryConfigStore({
        settings: { global: settings("operator-tasks") },
      }),
      serverPort,
      pluginContributions: pluginContributions({ enabled: false }),
    });

    await expect(
      factory.resolve("alice", undefined, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "task_provider_unavailable",
      message: "probe failed\u001b[31m",
    });
  });
});
