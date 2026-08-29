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
    source: over.source ?? "clarvis",
    version: over.version ?? "1.2.0",
    description: over.description ?? "A demo.",
    install_source: over.install_source ?? "https://example.invalid/demo.git",
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
    install: async (url, subdir, options) => {
      calls.push(`install:${url}`);
      if (subdir !== undefined) calls.push(`subdir:${subdir}`);
      if (options !== undefined) calls.push(`source:${options.source}`);
      const view = protoView({ name: "installed" });
      list.push(view);
      return view;
    },
    update: async (ref) => {
      calls.push(`update:${ref.scope}/${ref.source}/${ref.name}`);
      return protoView({ name: ref.name, scope: ref.scope, source: ref.source });
    },
    uninstall: async (ref) => {
      calls.push(`uninstall:${ref.scope}/${ref.source}/${ref.name}`);
    },
  };
}

test("toPluginView maps executable declarations and installation metadata", () => {
  const view = toPluginView(protoView());
  expect(view.source).toBe("clarvis");
  expect(view.installSource).toContain("demo.git");
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

test("toPluginView projects sorted per-skill Plans policies", () => {
  const view = toPluginView(
    protoView({
      contributions: {
        ...protoView().contributions,
        capability_run_policies: {
          plans: { skills: { zebra: "review", alpha: "on" } },
        },
      },
    }),
  );

  expect(view.contributions.skillPlanPolicies).toEqual([
    { skill: "alpha", mode: "on" },
    { skill: "zebra", mode: "review" },
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

test("store reloads plugin state after mutations", async () => {
  await createRoot(async (dispose) => {
    const service = fakeService([protoView()]);
    const store = createPluginsStore(service);
    await store.reload();
    expect(store.list().map((view) => view.name)).toEqual(["demo"]);
    await store.install("https://example.invalid/repo.git", "packages/demo", "clarvis");
    expect(service.calls).toContain("install:https://example.invalid/repo.git");
    expect(service.calls).toContain("subdir:packages/demo");
    expect(service.calls).toContain("source:clarvis");
    await store.update({ scope: "global", source: "clarvis", name: "demo" });
    expect(service.calls).toContain("update:global/clarvis/demo");
    await store.uninstall({ scope: "global", source: "clarvis", name: "demo" });
    expect(service.calls).toContain("uninstall:global/clarvis/demo");
    dispose();
  });
});
