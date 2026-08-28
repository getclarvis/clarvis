import { expect, test } from "bun:test";
import type { TaskProviderStatusDto } from "@clarvis/protocol";
import { openRender } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { SettingsAdapter, SettingsFile } from "../../src/adapters/settings.ts";
import type { PluginView } from "../../src/adapters/plugins.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { CapabilityProvidersPanel } from "../../src/views/config/CapabilityProvidersPanel.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const fakeKeymap = createFakeKeymap;

function plugin(
  name: string,
  over: Partial<PluginView> & { offers?: ("memory" | "plans")[] } = {},
): PluginView {
  const { offers = ["plans"], ...rest } = over;
  return {
    name,
    scope: "global",
    source: "clarvis",
    dir: `/plugins/${name}`,
    enabled: true,
    contributions: {
      agents: [],
      brokenAgents: [],
      skills: [],
      servers: [],
      hooks: 0,
      capabilityExecutables: offers.map((capability) => ({
        capability,
        command: "python3",
        args: ["server.py", capability],
        platformOverride: false,
      })),
      executables: [],
    },
    ...rest,
  };
}

function mount(
  options: {
    global?: SettingsFile;
    workspace?: SettingsFile;
    plugins?: PluginView[];
    initialScope?: "global" | "workspace";
    taskStatus?: TaskProviderStatusDto;
  } = {},
) {
  const { keymap, press } = fakeKeymap();
  const interaction = { keymap } as unknown as Interaction;
  const { host, controls } = createViewHost({
    interaction,
    close: () => {},
    dispatch: () => {},
    initialScope: options.initialScope,
  });
  const scopes = {
    ...(options.global ? { global: structuredClone(options.global) } : {}),
    ...(options.workspace ? { workspace: structuredClone(options.workspace) } : {}),
  } as { global?: SettingsFile; workspace?: SettingsFile };
  const writes: { scope: string; patch: Partial<SettingsFile> }[] = [];
  const settings = {
    version: () => writes.length,
    read: (scope: "global" | "workspace") => scopes[scope],
    effective: () => ({
      ...(scopes.global ?? {}),
      ...(scopes.workspace ?? {}),
      plans: scopes.workspace?.plans ?? scopes.global?.plans,
      memory: scopes.workspace?.memory ?? scopes.global?.memory,
      tasks: scopes.workspace?.tasks ?? scopes.global?.tasks,
    }),
    write: async (scope: "global" | "workspace", patch: Partial<SettingsFile>) => {
      writes.push({ scope, patch: structuredClone(patch) });
      const next = { ...(scopes[scope] ?? {}) };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete (next as Record<string, unknown>)[key];
        else (next as Record<string, unknown>)[key] = value;
      }
      scopes[scope] = next;
    },
  } as unknown as SettingsAdapter;
  const notes: string[] = [];
  const pluginOpens: true[] = [];
  const taskCapabilityChecks: true[] = [];
  const taskStatus: TaskProviderStatusDto = options.taskStatus ?? {
    state: "not_configured",
    writes: "disabled",
  };
  const deps = {
    settings,
    plugins: () => options.plugins ?? [],
    tasks: {
      status: async () => taskStatus,
      capabilities: async () => {
        taskCapabilityChecks.push(true);
        return {};
      },
    },
    notify: (message: string) => notes.push(message),
    openPlugins: () => pluginOpens.push(true),
  };
  return {
    host,
    controls,
    interaction,
    press,
    writes,
    deps,
    notes,
    pluginOpens,
    taskCapabilityChecks,
    scopes,
  };
}

async function render(mounted: ReturnType<typeof mount>, height = 32) {
  const output = await openRender(
    (() => CapabilityProvidersPanel(mounted.host, mounted.deps)) as never,
    { width: 140, height },
  );
  (mounted.interaction as unknown as { renderer: typeof output.renderer }).renderer =
    output.renderer;
  await output.renderOnce();
  return output;
}

test("root identifies direct executables and plugin selections", async () => {
  const mounted = mount({
    global: {
      plans: { provider: { kind: "plugin", plugin: "speckit-clarvis" } },
      memory: {
        provider: {
          kind: "executable",
          command: "python3",
          args: ["-B", "server.py", "memory"],
          timeout_ms: 30_000,
        },
      },
    },
  });
  const output = await render(mounted);
  const frame = output.captureCharFrame();
  expect(frame).toContain("plugin · speckit-clarvis");
  expect(frame).toContain("executable · python3");
  output.renderer.destroy();
});

test("plan picker exposes Markdown, executable and plugin choices", async () => {
  const mounted = mount({ plugins: [plugin("speckit-clarvis")] });
  const output = await render(mounted, 50);
  mounted.press("return");
  await output.renderOnce();
  mounted.press("return");
  await output.renderOnce();
  let frames = output.captureCharFrame();
  for (let index = 0; index < 2; index += 1) {
    mounted.press("down");
    await output.renderOnce();
    frames += output.captureCharFrame();
  }
  expect(frames).toContain("Markdown");
  expect(frames).toContain("executable");
  expect(frames).toContain("plugin");
  output.renderer.destroy();
});

test("a disabled plugin is retained as a selection but cannot be chosen as ready", async () => {
  const mounted = mount({
    global: { plans: { provider: { kind: "plugin", plugin: "speckit-clarvis" } } },
    plugins: [plugin("speckit-clarvis", { enabled: false })],
  });
  const output = await render(mounted, 40);
  mounted.press("return");
  await output.renderOnce();
  const frame = output.captureCharFrame();
  expect(frame).toContain("disabled · enable it independently");
  output.renderer.destroy();
});

test("root reports inherited origin and follows scope switching", async () => {
  const mounted = mount({
    global: {
      plans: { provider: { kind: "plugin", plugin: "speckit-clarvis" } },
      memory: { provider: { kind: "file", paths: ["AGENTS.md"] } },
    },
    initialScope: "workspace",
  });
  const output = await render(mounted);
  expect(output.captureCharFrame()).toContain("global (inherited) · no workspace override");
  await mounted.host.toggleScope();
  await output.renderOnce();
  expect(output.captureCharFrame()).toContain("global · override in global");
  output.renderer.destroy();
});

test("renders every provider-specific plan and memory surface", async () => {
  const cases: {
    settings: SettingsFile;
    panel: "plans" | "memory";
    plugins?: PluginView[];
    expected: string[];
  }[] = [
    {
      settings: { plans: { provider: { kind: "markdown" } } },
      panel: "plans",
      expected: ["provider", "Markdown · executable · plugin"],
    },
    {
      settings: {
        plans: {
          provider: {
            kind: "executable",
            command: "python3",
            args: ["server.py", "plans"],
            timeout_ms: 1_200,
          },
        },
      },
      panel: "plans",
      expected: ["command", "args", "timeout_ms", "JSON-RPC 2.0"],
    },
    {
      settings: { plans: { provider: { kind: "plugin", plugin: "speckit" } } },
      panel: "plans",
      plugins: [
        {
          ...plugin("speckit"),
          contributions: {
            ...plugin("speckit").contributions,
            skillPlanPolicies: [
              { skill: "speckit-plan", mode: "off" },
              { skill: "speckit-implement", mode: "review" },
            ],
          },
        },
      ],
      expected: ["starts only when selected", "/speckit-plan", "plans:review"],
    },
    {
      settings: { memory: { provider: { kind: "wiki" } } },
      panel: "memory",
      expected: ["provider", "wiki · file · MCP · executable · plugin"],
    },
    {
      settings: { memory: { provider: { kind: "file", paths: ["AGENTS.md"] } } },
      panel: "memory",
      expected: ["paths", "one workspace-relative path per line"],
    },
    {
      settings: {
        memory: {
          provider: {
            kind: "executable",
            command: "python3",
            args: ["server.py", "memory"],
            timeout_ms: 1_200,
          },
        },
      },
      panel: "memory",
      expected: ["command", "args", "timeout_ms", "persistent JSON-RPC service"],
    },
    {
      settings: {
        memory: {
          provider: {
            kind: "mcp",
            server: "knowledge",
            seed_tool: "seed",
            tools: {
              list_memories: "list",
              read_memory: "read",
              grep_memories: "grep",
              query_memories: "query",
              write_memory: "write",
              edit_memory: "edit",
              delete_memory: "delete",
            },
          },
        },
      },
      panel: "memory",
      expected: ["server", "seed_tool", "list_memories", "write trio: all or none"],
    },
    {
      settings: { memory: { provider: { kind: "plugin", plugin: "memory-db" } } },
      panel: "memory",
      plugins: [plugin("memory-db", { offers: ["memory"] })],
      expected: ["starts only when selected", "ready for the next use"],
    },
  ];

  for (const item of cases) {
    const mounted = mount({ global: item.settings, plugins: item.plugins });
    const output = await render(mounted, 48);
    if (item.panel === "memory") mounted.press("down");
    mounted.press("return");
    await output.renderOnce();
    const frame = output.captureCharFrame();
    for (const text of item.expected) expect(frame).toContain(text);
    output.renderer.destroy();
  }
});

test("plugin rows explain broken, disabled, stale and ready selections", async () => {
  const mounted = mount({
    global: { plans: { provider: { kind: "plugin", plugin: "no-offer" } } },
    plugins: [
      plugin("broken", { error: "manifest bad" }),
      plugin("disabled", { enabled: false }),
      plugin("ready"),
      plugin("no-offer", { offers: ["memory"] }),
    ],
  });
  const output = await render(mounted, 44);
  mounted.press("return");
  await output.renderOnce();
  const frame = output.captureCharFrame();
  for (const text of [
    "manifest missing or broken",
    "disabled · enable it independently",
    "installed plugin no longer offers plans",
    "ready for the next use",
  ]) {
    expect(frame).toContain(text);
  }
  expect(mounted.pluginOpens).toEqual([]);
  expect(mounted.writes).toEqual([]);
  output.renderer.destroy();
});

test("plan selections preserve sibling settings and edit executable and plugin providers", async () => {
  const executable = mount({
    global: {
      plans: {
        mode: "review",
        retention: "discard",
        pending_task_nudges: 8,
        provider: { kind: "markdown" },
      },
    },
  });
  let output = await render(executable, 46);
  executable.press("return");
  executable.press("return");
  executable.press("down");
  executable.press("return");
  await output.renderOnce();
  executable.press("down");
  executable.press("return");
  await output.renderOnce();
  await output.mockInput.typeText("python3");
  executable.press("return");
  executable.press("down");
  executable.press("return");
  await output.renderOnce();
  await output.mockInput.typeText("server.py");
  executable.press("ctrl+s");
  await executable.controls.runSave();
  expect(executable.writes[0]?.patch.plans).toMatchObject({
    mode: "review",
    retention: "discard",
    pending_task_nudges: 8,
    provider: { kind: "executable", command: "python3", args: ["server.py"] },
  });
  output.renderer.destroy();

  const selectedPlugin = mount({ plugins: [plugin("alpha"), plugin("beta")] });
  output = await render(selectedPlugin, 46);
  selectedPlugin.press("return");
  selectedPlugin.press("return");
  selectedPlugin.press("down");
  selectedPlugin.press("down");
  selectedPlugin.press("return");
  await output.renderOnce();
  selectedPlugin.press("down");
  selectedPlugin.press("return");
  await output.renderOnce();
  selectedPlugin.press("down");
  selectedPlugin.press("return");
  await selectedPlugin.controls.runSave();
  expect(selectedPlugin.writes[0]?.patch.plans?.provider).toEqual({
    kind: "plugin",
    plugin: "beta",
  });
  output.renderer.destroy();
});

test("memory file provider edits its path declaration", async () => {
  const file = mount();
  const output = await render(file, 50);
  file.press("down");
  file.press("return");
  file.press("return");
  file.press("down");
  file.press("return");
  await output.renderOnce();
  file.press("down");
  file.press("return");
  await output.renderOnce();
  await output.mockInput.typeText("AGENTS.md");
  file.press("ctrl+s");
  await file.controls.runSave();
  expect(file.writes[0]?.patch.memory?.provider).toEqual({
    kind: "file",
    paths: ["AGENTS.md"],
  });
  output.renderer.destroy();
});

test("memory executable provider edits its command", async () => {
  const executable = mount();
  const output = await render(executable, 50);
  executable.press("down");
  executable.press("return");
  executable.press("return");
  executable.press("down");
  executable.press("down");
  executable.press("return");
  await output.renderOnce();
  executable.press("down");
  executable.press("return");
  await output.renderOnce();
  await output.mockInput.typeText("python3");
  executable.press("return");
  executable.press("down");
  executable.press("return");
  await output.renderOnce();
  await output.mockInput.typeText("server.py");
  executable.press("ctrl+s");
  await executable.controls.runSave();
  expect(executable.writes[0]?.patch.memory?.provider).toMatchObject({
    kind: "executable",
    command: "python3",
    args: ["server.py"],
  });
  output.renderer.destroy();
});

test("memory MCP provider edits its server and writable tool trio", async () => {
  const mcp = mount();
  const output = await render(mcp, 54);
  mcp.press("down");
  mcp.press("return");
  mcp.press("return");
  for (let index = 0; index < 3; index += 1) mcp.press("down");
  mcp.press("return");
  await output.renderOnce();
  mcp.press("down");
  mcp.press("return");
  await output.renderOnce();
  await output.mockInput.typeText("knowledge");
  mcp.press("return");
  for (let index = 0; index < 6; index += 1) mcp.press("down");
  for (const value of ["write", "edit", "delete"]) {
    mcp.press("return");
    await output.renderOnce();
    await output.mockInput.typeText(value);
    mcp.press("return");
    mcp.press("down");
  }
  await mcp.controls.runSave();
  expect(mcp.writes[0]?.patch.memory?.provider).toMatchObject({
    kind: "mcp",
    server: "knowledge",
    tools: { write_memory: "write", edit_memory: "edit", delete_memory: "delete" },
  });
  output.renderer.destroy();
});

test("memory plugin provider selects an installed executable", async () => {
  const selectedPlugin = mount({ plugins: [plugin("memory-db", { offers: ["memory"] })] });
  const output = await render(selectedPlugin, 48);
  selectedPlugin.press("down");
  selectedPlugin.press("return");
  selectedPlugin.press("return");
  for (let index = 0; index < 4; index += 1) {
    selectedPlugin.press("down");
    await output.renderOnce();
  }
  selectedPlugin.press("return");
  await selectedPlugin.controls.runSave();
  expect(selectedPlugin.writes[0]?.patch.memory?.provider).toEqual({
    kind: "plugin",
    plugin: "memory-db",
  });
  output.renderer.destroy();
});

test("Tasks provider shows effective health and tests capabilities without a write", async () => {
  const base = plugin("jira-work");
  const offered: PluginView = {
    ...base,
    contributions: { ...base.contributions, servers: ["jira-work:tasks"] },
  };
  const mounted = mount({
    global: {
      tasks: {
        provider: {
          kind: "mcp",
          server: "jira-work:tasks",
          protocol: "clarvis.tasks.v2",
        },
        default_container: "CLAR",
        writes: "disabled",
      },
    },
    plugins: [offered],
    taskStatus: {
      state: "ready",
      provider_key: "tasks:mcp:v1:sha256:fixture",
      provider_kind: "jira",
      server: "jira-work:tasks",
      writes: "disabled",
    },
  });
  const output = await render(mounted, 42);
  mounted.press("down");
  mounted.press("down");
  mounted.press("return");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await output.renderOnce();

  const frame = output.captureCharFrame();
  expect(frame).toContain("jira-work:tasks");
  expect(frame).toContain("clarvis.tasks.v2 (fixed)");
  expect(frame).toContain("contributed by plugin jira-work");
  expect(frame).toContain("ready");
  expect(mounted.writes).toEqual([]);

  mounted.press("t");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mounted.taskCapabilityChecks).toHaveLength(1);
  expect(mounted.notes.at(-1)).toBe("Tasks provider is compatible");
  expect(mounted.writes).toEqual([]);
  output.renderer.destroy();
});

test("inherit, Plugins navigation and validation are explicit", async () => {
  const mounted = mount({
    global: {
      plans: {
        mode: "review",
        retention: "keep",
        pending_task_nudges: 3,
        provider: { kind: "markdown" },
      },
    },
  });
  const output = await render(mounted, 42);
  mounted.press("return");
  await output.renderOnce();
  mounted.press("p");
  expect(mounted.pluginOpens).toEqual([true]);
  mounted.press("i");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(output.captureCharFrame()).toContain("also removes: mode, retention, pending_task_nudges");
  mounted.press("y");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await mounted.controls.runSave();
  expect(mounted.writes).toEqual([{ scope: "global", patch: {} }]);
  expect(mounted.scopes.global?.plans).toBeUndefined();
  output.renderer.destroy();

  const invalid = mount({ global: { memory: { provider: { kind: "plugin", plugin: "" } } } });
  const invalidOutput = await render(invalid, 42);
  invalid.press("down");
  invalid.press("return");
  invalid.press("down");
  invalid.press("return");
  expect(invalid.notes.at(-1)).toContain("no installed plugin offers memory");
  await invalid.controls.runSave();
  expect(invalid.writes).toEqual([]);
  invalidOutput.renderer.destroy();
});
