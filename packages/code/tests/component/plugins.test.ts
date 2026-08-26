import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { PluginService, PluginView as ProtoPluginView } from "@clarvis/protocol";
import { createPluginsStore, loadPlugins, toPluginView } from "../../src/adapters/plugins.ts";

function protoView(over: Partial<ProtoPluginView> = {}): ProtoPluginView {
  return {
    name: over.name ?? "demo",
    scope: over.scope ?? "workspace",
    dir: over.dir ?? "/ws/plugin/demo",
    enabled: over.enabled ?? true,
    shadows_global: over.shadows_global ?? false,
    version: over.version ?? "1.2.0",
    description: over.description ?? "A demo.",
    source: over.source ?? "https://example.invalid/demo.git",
    revision: over.revision ?? "abc123",
    contributions: over.contributions ?? {
      agents: ["good"],
      broken_agents: ["bad"],
      skills: ["guide"],
      servers: ["git"],
      hooks: 1,
      capability_executables: [
        {
          capability: "memory",
          command: "python3",
          args: ["-B", "server.py", "memory"],
          platform_override: false,
        },
      ],
      executables: ["$ demo:git  git-mcp"],
    },
    ...(over.error !== undefined ? { error: over.error } : {}),
    ...(over.display_name !== undefined ? { display_name: over.display_name } : {}),
    ...(over.short_description !== undefined ? { short_description: over.short_description } : {}),
  };
}

function fakeService(seed: ProtoPluginView[] = []): PluginService & { calls: string[] } {
  const calls: string[] = [];
  const list = [...seed];
  return {
    calls,
    list: async () => list,
    hooks: async () => [
      {
        plugin: "demo",
        fingerprint: "sha256:hook",
        definition: { command: "check" },
        approved: false,
      },
    ],
    install: async (url) => {
      calls.push(`install:${url}`);
      const view = protoView({ name: "installed" });
      list.push(view);
      return view;
    },
    update: async (name) => {
      calls.push(`update:${name}`);
      return protoView({ name });
    },
    uninstall: async (name) => {
      calls.push(`uninstall:${name}`);
    },
    approveHook: async (plugin, fingerprint) => {
      calls.push(`approve-hook:${plugin}:${fingerprint}`);
    },
    revokeHook: async (plugin, fingerprint) => {
      calls.push(`revoke-hook:${plugin}:${fingerprint}`);
    },
  };
}

test("toPluginView maps executable declarations and installation metadata", () => {
  const view = toPluginView(protoView({ shadows_global: true }));
  expect(view.shadowsGlobal).toBe(true);
  expect(view.source).toContain("demo.git");
  expect(view.revision).toBe("abc123");
  expect(view.contributions.brokenAgents).toEqual(["bad"]);
  expect(view.contributions.capabilityExecutables).toEqual([
    {
      capability: "memory",
      command: "python3",
      args: ["-B", "server.py", "memory"],
      platformOverride: false,
    },
  ]);
});

test("toPluginView carries display metadata through without inventing any", () => {
  const plain = toPluginView(protoView());
  expect(plain.displayName).toBeUndefined();
  expect(plain.shortDescription).toBeUndefined();

  const shown = toPluginView(
    protoView({ display_name: "Atlas Tools", short_description: "Charts and maps." }),
  );
  expect(shown.displayName).toBe("Atlas Tools");
  expect(shown.shortDescription).toBe("Charts and maps.");
});

test("loadPlugins maps every view from the service", async () => {
  const views = await loadPlugins(
    fakeService([protoView({ name: "a" }), protoView({ name: "b" })]),
  );
  expect(views.map((view) => view.name)).toEqual(["a", "b"]);
});

test("store reloads plugin and exact-hook review state after mutations", async () => {
  await createRoot(async (dispose) => {
    const service = fakeService([protoView()]);
    const store = createPluginsStore(service);
    await store.reload();
    expect(store.list().map((view) => view.name)).toEqual(["demo"]);
    expect(store.hooks()).toHaveLength(1);
    await store.approveHook("demo", "sha256:hook");
    await store.install("https://example.invalid/repo.git");
    expect(service.calls).toContain("approve-hook:demo:sha256:hook");
    expect(service.calls).toContain("install:https://example.invalid/repo.git");
    dispose();
  });
});
