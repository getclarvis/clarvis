import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { AgentsPanel } from "../../src/views/config/AgentsPanel.tsx";
import type { ProviderConfig, SettingsAdapter } from "../../src/adapters/settings.ts";
import type { CodeConfigStore } from "../../src/adapters/code-config.ts";
import type { AgentFile, EnvView } from "../../src/adapters/agent-files.ts";
import type { AgentsStore } from "../../src/adapters/agents-store.ts";
import type { Scope } from "../../src/adapters/settings.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { compareAgentDisplayOrder } from "@clarvis/kernel/config";
import type { ModelCatalog } from "@clarvis/protocol";
import { createModelsCatalog } from "../../src/adapters/models-catalog.ts";

type RenderHarness = Awaited<ReturnType<typeof openRender>>;

interface FakeAgentsStore extends AgentsStore {
  stored(name: string, scope: Scope | "builtin"): AgentFile | null;
}

function fakeAgentsStore(seed: AgentFile[]): FakeAgentsStore {
  const [records, setRecords] = createSignal(seed.map((item) => ({ ...item })));
  const stored = (name: string, scope: Scope | "builtin"): AgentFile | null =>
    records().find((item) => item.name === name && item.scope === scope) ?? null;
  const list = (): AgentFile[] => {
    const merged = new Map<string, AgentFile>();
    for (const scope of ["builtin", "global", "workspace"] as const)
      for (const item of records().filter((entry) => entry.scope === scope))
        merged.set(item.name, item);
    return [...merged.values()].sort(compareAgentDisplayOrder);
  };
  const conflicts = (): string[] => {
    const scopes = new Map<string, Set<Scope | "builtin">>();
    for (const item of records()) {
      const seen = scopes.get(item.name) ?? new Set<Scope | "builtin">();
      seen.add(item.scope);
      scopes.set(item.name, seen);
    }
    return [...scopes]
      .filter(([, seen]) => seen.size > 1)
      .map(([name]) => name)
      .sort();
  };
  return {
    list,
    conflicts,
    read: async (name, scope) => stored(name, scope),
    write: async (file) => {
      setRecords((items) => [
        ...items.filter((item) => item.name !== file.name || item.scope !== file.scope),
        { ...file },
      ]);
    },
    remove: async (name, scope) => {
      setRecords((items) => items.filter((item) => item.name !== name || item.scope !== scope));
    },
    rename: async (oldName, newName, scope) => {
      setRecords((items) =>
        items.map((item) =>
          item.name === oldName && item.scope === scope ? { ...item, name: newName } : item,
        ),
      );
    },
    reload: async () => {},
    stored,
  };
}

const fakeKeymap = createFakeKeymap;

async function renderUntil(
  rendered: RenderHarness,
  done: () => boolean,
  maxIters = 200,
): Promise<void> {
  for (let index = 0; index < maxIters && !done(); index++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await rendered.renderOnce();
  }
}

const ENV: EnvView = {
  budgetOnExceed: "escalate",
  iterationDefault: 50,
  iterationCeiling: 100,
  tokenDefault: 4_000_000,
  tokenCeiling: 5_000_000,
  maxGrant: "edit",
  contextWindowDefault: 128000,
};

function fakeSettings(
  providers: { name: string; models?: Record<string, { capabilities?: string[] }> }[],
): SettingsAdapter {
  const configured: ProviderConfig[] = providers.map((provider) => ({
    kind: "openai-compatible" as const,
    ...provider,
    models: provider.models
      ? Object.fromEntries(
          Object.entries(provider.models).map(([name, model]) => [
            name,
            { context_window_tokens: 128000, ...model },
          ]),
        )
      : undefined,
  }));
  return {
    version: () => 0,
    read: () => ({ providers: configured }),
    corrupt: () => null,
    planRepair: () => null,
    applyRepair: async () => {},
    effective: () => ({ providers: configured }),
    withheldWorkspaceFields: () => [],
    workspaceTrust: () => "inert",
    setWorkspaceTrust: async () => {},
    origin: () => "global",
    effectiveProviders: () => configured.map((provider) => ({ provider, origin: "global" })),
    knownGrants: () => undefined,
    sources: () => ({ global: "/fake/settings.json" }),
    write: async () => {},
    validateProviders: () => ({ ok: true }),
    refs: () => ({ agents: [], defaultModel: false }),
    modelRefs: () => ({ agents: [], defaultModel: false }),
    envStatus: () => "unset",
    declaredMcpServers: () => [],
    reload: async () => {},
    inspectSandbox: async () => {
      throw new Error("sandbox inspection is outside the AgentsPanel contract");
    },
  };
}

function fakeCode(agentDefault?: string): CodeConfigStore {
  return {
    read: () => ({}),
    themeAt: () => ({}),
    effectiveTheme: () => ({}),
    agentDefault: () => agentDefault,
    guardModeDefault: () => undefined,
    updateCheckEnabled: () => true,
    asciiEnabled: () => false,
    keyboardConfig: () => ({ version: 1, environments: {} }),
    keySources: () => ({}),
    keySource: () => "auto",
    overrideSource: () => null,
    write: () => {},
    writeAscii: () => {},
    writeKeyboardEnvironment: () => {},
    writeUpdateCheckEnabled: () => {},
    writeTheme: () => {},
    writeAgentDefault: () => {},
    clearAgentDefault: () => {},
    writeKeySource: () => {},
    hasWorkspace: () => false,
  };
}

function agent(
  name: string,
  frontmatter: AgentFile["frontmatter"] = {},
  body = "",
  scope: AgentFile["scope"] = "global",
  invalid?: string,
): AgentFile {
  return { name, scope, frontmatter, body, ...(invalid ? { invalid } : {}) };
}

function fixtureAgents(): AgentFile[] {
  return [
    agent(
      "builder",
      {
        description: "Builds things",
        model: "ghost/gpt-x",
        grants: ["edit_workspace", "run_commands"],
        can_spawn: ["finder"],
        default_spawn: "finder",
      },
      "Build carefully.",
    ),
    agent("finder", { description: "Reads the repo", grants: ["read_workspace"] }),
  ];
}

function fixtureAgentsExtra(): AgentFile[] {
  return [
    ...fixtureAgents(),
    agent(
      "ready",
      { description: "Ready to run", grants: ["read_workspace"], model: "openrouter/glm-5.2" },
      "Ready.",
    ),
    agent("broken", {}, "Broken.", "global", "iteration_limit: expected number"),
  ];
}

function fixtureAgentsWithConflict(): AgentFile[] {
  return [
    agent(
      "reviewer",
      { description: "Global reviewer", grants: ["edit_workspace"] },
      "Global body.",
    ),
    agent(
      "reviewer",
      { description: "Workspace reviewer", grants: ["edit_workspace"] },
      "Workspace body.",
      "workspace",
    ),
  ];
}

function mount(
  initial: AgentFile[],
  opts?: {
    providers?: { name: string; models?: Record<string, { capabilities?: string[] }> }[];
    code?: CodeConfigStore;
  },
) {
  const { keymap, press } = fakeKeymap();
  const notes: string[] = [];
  const interaction: Interaction = {
    keymap,
    renderer: undefined as never,
    pushOverlayContext: () => {},
    popOverlayContext: () => {},
    setModalContext: () => {},
    keyboardEnvironment: undefined as never,
    keyboardEnvironmentId: undefined as never,
    configureKeyboard: () => {},
    dispose: () => {},
  };
  const { host, controls } = createViewHost({
    interaction,
    close: () => {},
    dispatch: () => {},
  });
  const agents = fakeAgentsStore(initial);
  const deps = {
    agents,
    settings: fakeSettings(opts?.providers ?? [{ name: "openrouter" }]),
    catalog: createModelsCatalog({
      source: "bundle",
      providers: [
        {
          id: "ghost",
          name: "Ghost",
          kind: "openai-compatible",
          needs_base_url: true,
          models: [
            {
              id: "gpt-x",
              capabilities: ["reasoning"],
              reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
            },
          ],
        },
      ],
    } satisfies ModelCatalog),
    code: opts?.code ?? fakeCode(),
    env: ENV,
    notify: (message: string) => notes.push(message),
  };
  return { host, controls, deps, press, notes, agents };
}

async function renderPanel(
  mounted: ReturnType<typeof mount>,
  height: number,
  width = 110,
): Promise<RenderHarness> {
  const rendered = await openRender(() => AgentsPanel(mounted.host, mounted.deps), {
    width,
    height,
  });
  mounted.host.interaction.renderer = rendered.renderer;
  return rendered;
}

test("L0 lists agents under a labeled column header with blockers anchored below", async () => {
  const mounted = mount(fixtureAgents());
  const rendered = await renderPanel(mounted, 30);
  await rendered.renderOnce();
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toMatch(/role\s+name\s+grants\s+model\s+iters\s+ok\s+scope/);
  expect(frame).toContain("Lead");
  expect(frame).toContain("Sub-agent");
  expect(frame).toContain("undeclared provider 'ghost'");
  expect(frame).toContain("[a] add");
  expect(frame).toContain("[r] rename");
  const rows = frame.split("\n");
  const builder = rows.findIndex((row) => row.includes("builder"));
  expect(rows[builder - 1]).toContain("name");
  expect(rows[builder + 1]).toContain("finder");
  expect(rows[builder + 2]).toContain("undeclared provider 'ghost'");

  mounted.press("a");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("new agent name");
  await rendered.mockInput.typeText("reviewer");
  mounted.press("return");
  await renderUntil(rendered, () => mounted.agents.stored("reviewer", "global") !== null);
  expect(mounted.agents.stored("reviewer", "global")).not.toBeNull();
});

test("L1 groups fields and exposes the grants tier", async () => {
  const mounted = mount(fixtureAgents());
  const rendered = await renderPanel(mounted, 34);
  await rendered.renderOnce();
  mounted.press("return");
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("Identity");
  expect(frame).toContain("Permissions and delegation");
  expect(frame).toContain("Execution");
  expect(frame).toContain("Permissions  edit effective · exec configured · 2 grants");
  expect(frame.split("Builds things").length - 1).toBe(1);
});

test("L1 scrolls without description/model overlap at 80x24", async () => {
  const mounted = mount(fixtureAgents());
  const rendered = await renderPanel(mounted, 24, 80);
  await rendered.renderOnce();
  mounted.press("return");
  await rendered.renderOnce();
  const top = rendered.captureCharFrame();
  expect(top.split("\n").some((line) => /^\s+Sub-agent model\s+ghost\/gpt-x/.test(line))).toBe(
    true,
  );
  expect(top).not.toContain("FoModel");

  for (let index = 0; index < 7; index++) mounted.press("down");
  await renderUntil(rendered, () => rendered.captureCharFrame().includes("Instructions"));
  expect(rendered.captureCharFrame()).toContain("Instructions");
});

test("base_prompt opens the multiline editor", async () => {
  const initial = fixtureAgents();
  initial[0] = { ...initial[0]!, body: "line one\nline two" };
  const mounted = mount(initial);
  const rendered = await renderPanel(mounted, 34);
  await rendered.renderOnce();
  mounted.press("return");
  await rendered.renderOnce();
  for (let index = 0; index < 7; index++) mounted.press("down");
  mounted.press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("[^s] apply");
  expect(rendered.captureCharFrame()).toContain("line one");
  await rendered.mockInput.typeText("\nline three");
  mounted.press("ctrl+s");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).not.toContain("[^s] apply");
  expect(mounted.host.dirty()).toBe(true);
});

test("can_spawn opens the multi-select picker with the other agents", async () => {
  const mounted = mount(fixtureAgents());
  const rendered = await renderPanel(mounted, 34);
  await rendered.renderOnce();
  mounted.press("return");
  await rendered.renderOnce();
  for (let index = 0; index < 3; index++) mounted.press("down");
  mounted.press("return");
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("can_spawn — builder");
  expect(frame).toContain("finder");
  expect(frame).toContain("add/remove");
});

test("the grants picker exposes the workflow grant", async () => {
  const mounted = mount(fixtureAgents());
  const rendered = await renderPanel(mounted, 34);
  await rendered.renderOnce();
  mounted.press("return");
  await rendered.renderOnce();
  for (let index = 0; index < 2; index++) mounted.press("down");
  mounted.press("return");
  await rendered.renderOnce();
  for (let index = 0; index < 6; index++) mounted.press("down");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("workflow");
  expect(rendered.captureCharFrame()).toContain("run_leader tool (entry agent)");
  mounted.press("return");
  mounted.press("escape");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("+ workflow");
});

test("reasoning_effort uses the shared picker and one representative commit", async () => {
  const mounted = mount(fixtureAgents(), {
    providers: [{ name: "ghost", models: { "gpt-x": { capabilities: ["reasoning"] } } }],
  });
  const rendered = await renderPanel(mounted, 40);
  await rendered.renderOnce();
  mounted.press("return");
  for (let index = 0; index < 6; index++) mounted.press("down");
  mounted.press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Sub-agent effort");
  expect(rendered.captureCharFrame()).toContain("medium");
  mounted.press("end");
  mounted.press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toMatch(/Sub-agent effort\s+max/);
  expect(mounted.host.dirty()).toBe(true);
});

test("reasoning support notes distinguish unsupported and unknown capabilities", async () => {
  const unsupported = mount(fixtureAgents(), {
    providers: [{ name: "ghost", models: { "gpt-x": { capabilities: ["tool_calling"] } } }],
  });
  const first = await renderPanel(unsupported, 40);
  await first.renderOnce();
  unsupported.press("return");
  await first.renderOnce();
  expect(first.captureCharFrame()).toContain("does not declare reasoning support");

  const unknown = mount(fixtureAgents(), { providers: [{ name: "ghost" }] });
  const second = await renderPanel(unknown, 40);
  await second.renderOnce();
  unknown.press("return");
  await second.renderOnce();
  expect(second.captureCharFrame()).not.toContain("does not declare reasoning support");
  expect(second.captureCharFrame()).toContain("Provider default");
});

test("a cross-scope conflict is visible and opens a scope picker", async () => {
  const mounted = mount(fixtureAgentsWithConflict());
  const rendered = await renderPanel(mounted, 34);
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("workspace shadow");
  mounted.press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("exists in both scopes");
  expect(rendered.captureCharFrame()).toContain("global");
  mounted.press("down");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("workspace");
});

test("the scope picker opens the selected physical copy", async () => {
  const mounted = mount(fixtureAgentsWithConflict());
  const rendered = await renderPanel(mounted, 34);
  await rendered.renderOnce();
  mounted.press("return");
  await rendered.renderOnce();
  mounted.press("down");
  mounted.press("return");
  await renderUntil(rendered, () => rendered.captureCharFrame().includes("Workspace reviewer"));
  expect(rendered.captureCharFrame()).toContain("Workspace reviewer");
  expect(rendered.captureCharFrame()).not.toContain("Global reviewer");
});

test("scope-changing a draft routes save to the fork-name prompt", async () => {
  const mounted = mount(fixtureAgents());
  const rendered = await renderPanel(mounted, 34);
  await rendered.renderOnce();
  mounted.press("down");
  mounted.press("return");
  mounted.host.toggleScope();
  await mounted.controls.runSave();
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("fork 'finder' to workspace as");
  expect(mounted.agents.stored("finder", "workspace")).toBeNull();
});

test("delete confirmation names references and cancellation preserves the selected agent", async () => {
  const mounted = mount(fixtureAgents());
  const rendered = await renderPanel(mounted, 30);
  await rendered.renderOnce();
  mounted.press("down");
  mounted.press("d");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("delete agent 'finder'?");
  expect(rendered.captureCharFrame()).toContain("spawned by: builder");
  mounted.press("n");
  await rendered.renderOnce();
  expect(mounted.agents.stored("finder", "global")).not.toBeNull();

  mounted.agents.remove = async () => {
    throw new Error("delete denied");
  };
  mounted.press("d");
  mounted.press("y");
  await renderUntil(rendered, () => mounted.notes.some((note) => note.includes("delete denied")));
  expect(mounted.agents.stored("finder", "global")).not.toBeNull();
});

test("one representative delete submit removes the draft and returns to the list", async () => {
  const mounted = mount(fixtureAgents());
  const rendered = await renderPanel(mounted, 30);
  await rendered.renderOnce();
  mounted.press("return");
  mounted.press("d");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("delete agent 'builder' (global)?");
  mounted.press("y");
  await renderUntil(rendered, () => mounted.host.level.depth() === 0);
  expect(mounted.agents.stored("builder", "global")).toBeNull();
  expect(mounted.host.level.depth()).toBe(0);
});

test("opening another agent while dirty asks before changing focus", async () => {
  const mounted = mount(fixtureAgents());
  const rendered = await renderPanel(mounted, 30);
  await rendered.renderOnce();
  mounted.press("return");
  mounted.press("return");
  await rendered.renderOnce();
  await rendered.mockInput.typeText(" (edited)");
  mounted.press("return");
  mounted.host.level.pop();
  mounted.press("down");
  mounted.press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("discard them?");
  mounted.press("y");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Reads the repo");
});

test("model and default_spawn rows open their dedicated pickers", async () => {
  const model = mount(fixtureAgents());
  const first = await renderPanel(model, 34);
  await first.renderOnce();
  model.press("return");
  model.press("down");
  model.press("return");
  await first.renderOnce();
  expect(first.captureCharFrame()).toContain("Pick a model");
  model.press("return");
  await first.renderOnce();
  expect(first.captureCharFrame()).toContain("model (provider/modelId)");
  await first.mockInput.typeText("2");
  model.press("return");
  await first.renderOnce();
  expect(first.captureCharFrame()).toContain("ghost/gpt-x2");

  const spawn = mount(fixtureAgents());
  const second = await renderPanel(spawn, 34);
  await second.renderOnce();
  spawn.press("return");
  for (let index = 0; index < 4; index++) spawn.press("down");
  spawn.press("return");
  await second.renderOnce();
  expect(second.captureCharFrame()).toContain("Default delegate");
  expect(second.captureCharFrame()).toContain("finder");
  spawn.press("down");
  spawn.press("return");
  await second.renderOnce();
  expect(second.captureCharFrame()).toMatch(/Default delegate\s+Choose when delegating/);
});

test("invalid and runnable agents expose their representative status rows", async () => {
  const mounted = mount(fixtureAgentsExtra(), {
    providers: [{ name: "openrouter", models: { "glm-5.2": {} } }],
  });
  const rendered = await renderPanel(mounted, 30);
  await rendered.renderOnce();
  const initial = rendered.captureCharFrame();
  expect(initial).toContain("invalid frontmatter");
  mounted.press("return");
  expect(mounted.host.level.depth()).toBe(0);
  expect(mounted.notes.some((note) => note.includes("invalid frontmatter"))).toBe(true);

  for (let index = 0; index < 3; index++) mounted.press("down");
  await rendered.renderOnce();
  const rows = rendered.captureCharFrame().split("\n");
  const ready = rows.findIndex((row) => row.includes("ready"));
  expect(ready).toBeGreaterThanOrEqual(0);
  expect(rows[ready + 1]).toContain("runnable");
});

/**
 * A shipped agent nobody has customized: it lists like any other, but there is
 * no document behind it, so the destructive verbs have nothing to act on.
 */
function fixtureShipped(): AgentFile[] {
  return [
    agent(
      "marshall",
      { description: "Coding Lead", grants: ["edit_workspace"] },
      "Be careful.",
      "builtin",
    ),
    agent("finder", { description: "Reads the repo", grants: ["read_workspace"] }),
  ];
}

test("a shipped agent cannot be deleted, and the panel says why instead of confirming", async () => {
  const mounted = mount(fixtureShipped());
  const rendered = await renderPanel(mounted, 30);
  await rendered.renderOnce();
  mounted.press("d");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).not.toContain("delete agent");
  expect(mounted.notes.some((n) => n.includes("shipped with Clarvis and cannot be deleted"))).toBe(
    true,
  );
});

test("deleting a customized shipped agent is offered as a reset to the shipped default", async () => {
  const customized = [
    agent("marshall", { description: "Mine", grants: ["edit_workspace"] }, "Mine.", "global"),
    agent("finder", { description: "Reads the repo", grants: ["read_workspace"] }),
  ];
  const mounted = mount(customized);
  const rendered = await renderPanel(mounted, 30);
  await rendered.renderOnce();
  mounted.press("d");
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("reset 'marshall' to the shipped default");
  expect(frame).toContain("[y] reset");
});

test("a shipped agent declines the rename before asking for a name", async () => {
  const mounted = mount(fixtureShipped());
  const rendered = await renderPanel(mounted, 30);
  await rendered.renderOnce();
  mounted.press("r");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).not.toContain("rename 'marshall' to");
  expect(mounted.notes.some((n) => n.includes("fork it under a new name instead"))).toBe(true);
});

test("a shipped agent open in the editor declines the rename there too", async () => {
  const mounted = mount(fixtureShipped());
  const rendered = await renderPanel(mounted, 30);
  await rendered.renderOnce();
  mounted.press("return");
  await rendered.renderOnce();
  mounted.press("r");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).not.toContain("rename 'marshall' to");
  expect(mounted.notes.some((n) => n.includes("fork it under a new name instead"))).toBe(true);
});
