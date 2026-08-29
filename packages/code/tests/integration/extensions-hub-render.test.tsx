import { expect, test } from "bun:test";
import type {
  EnvironmentCompositionInput,
  EnvironmentCompositionPreview,
  EnvironmentDefinition,
  EnvironmentInventory,
  EnvironmentRef,
  EnvironmentService,
  ResolvedEnvironment,
} from "@clarvis/protocol";
import type { MarketplaceListing, MarketplaceSource } from "../../src/adapters/marketplace.ts";
import type { PluginView } from "../../src/adapters/plugins.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { spinnerChar } from "../../src/views/spinner.ts";
import { ExtensionsHub, type ExtensionsHubDeps } from "../../src/views/config/ExtensionsHub.tsx";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { openRender } from "../helpers/tracked-render.ts";

const EMPTY_DEFINITION: EnvironmentDefinition = {
  schema_version: 1,
  description: "My exact extension set",
  plugins: [],
  skills: [],
};

function operationGate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

function listing(over: Partial<MarketplaceListing> = {}): MarketplaceListing {
  return {
    name: "context7",
    displayName: "Context7",
    description: "Up-to-date documentation through MCP",
    source: "https://github.com/upstash/context7.git",
    marketplaceUrl: "https://github.com/getclarvis/marketplace.git",
    marketplace: "Clarvis Marketplace",
    installable: true,
    installed: false,
    notes: [],
    ...over,
  };
}

function installedPlugin(source: "agents" | "clarvis" = "agents"): PluginView {
  return {
    name: "context7",
    displayName: "Context7",
    shortDescription: "Current library documentation",
    scope: "global",
    source,
    dir: `/plugins/${source}/context7`,
    enabled: false,
    contributions: {
      agents: ["docs-agent"],
      brokenAgents: [],
      skills: ["context7-docs"],
      servers: ["context7"],
      hooks: 1,
      capabilityExecutables: [],
      executables: ["npx -y @upstash/context7-mcp"],
    },
  };
}

function context7Inventory(source: "agents" | "clarvis" = "agents") {
  return {
    ref: { scope: "global" as const, source, name: "context7" },
    active: false,
    installed: true,
    valid: true,
    agents: ["docs-agent"],
    skills: ["context7-docs"],
    mcp_servers: ["context7"],
    hooks: { total: 1 },
    capability_executables: [],
  };
}

function builtin(): ResolvedEnvironment {
  return {
    id: "builtin:default",
    ref: { scope: "builtin", name: "default" },
    immutable: true,
    status: "ready",
    fingerprint: `sha256:${"a".repeat(64)}`,
    selection_origin: "builtin",
    plugins: [],
    standalone_skills: [],
    issues: [],
    counts: {
      plugins_active: 0,
      standalone_skills_active: 0,
      plugin_skills_active: 0,
      mcp_servers_active: 0,
      hooks_declared: 0,
    },
  };
}

function resolveDraft(
  ref: { scope: "global" | "workspace"; name: string },
  definition: EnvironmentDefinition,
  inventory: EnvironmentInventory,
): ResolvedEnvironment {
  const plugins = definition.plugins.map((selected) => {
    const installed = inventory.plugins.find(
      (candidate) =>
        candidate.ref.scope === selected.scope &&
        candidate.ref.source === selected.source &&
        candidate.ref.name === selected.name,
    );
    return installed === undefined
      ? {
          ref: selected,
          active: false,
          installed: false,
          valid: false,
          agents: [],
          skills: [],
          mcp_servers: [],
          hooks: { total: 0 },
          capability_executables: [],
          error: "missing",
        }
      : { ...installed, active: installed.valid };
  });
  const skills = definition.skills.map((selected) => {
    const discovered = inventory.standalone_skills.find(
      (candidate) =>
        candidate.ref.scope === selected.scope &&
        candidate.ref.source === selected.source &&
        candidate.ref.name === selected.name,
    );
    return discovered === undefined
      ? { ref: selected, active: false, found: false, error: "missing" }
      : { ...discovered, active: true };
  });
  const activePlugins = plugins.filter((plugin) => plugin.active);
  return {
    id: `${ref.scope}:${ref.name}`,
    ref,
    immutable: false,
    status:
      plugins.some((plugin) => !plugin.active) || skills.some((skill) => !skill.active)
        ? "degraded"
        : "ready",
    fingerprint: `sha256:${"b".repeat(64)}`,
    selection_origin: "workspace",
    definition,
    definition_revision: `sha256:${"c".repeat(64)}`,
    description: definition.description,
    plugins,
    standalone_skills: skills,
    issues: [],
    counts: {
      plugins_active: activePlugins.length,
      standalone_skills_active: skills.filter((skill) => skill.active).length,
      plugin_skills_active: activePlugins.reduce((sum, plugin) => sum + plugin.skills.length, 0),
      mcp_servers_active: activePlugins.reduce((sum, plugin) => sum + plugin.mcp_servers.length, 0),
      hooks_declared: activePlugins.reduce((sum, plugin) => sum + plugin.hooks.total, 0),
    },
  };
}

function mount(
  options: {
    inventory?: EnvironmentInventory;
    listings?: MarketplaceListing[];
    initialEnvironment?: EnvironmentRef;
    loadError?: string;
    runActive?: boolean;
    cliSelection?: boolean;
    definition?: EnvironmentDefinition;
    installGate?: Promise<void>;
    previewGate?: Promise<void>;
    applyGate?: Promise<void>;
    requiresWorkspaceTrust?: boolean;
    previewIssue?: boolean;
    reconnectResult?: { ok: boolean; message: string };
  } = {},
) {
  const harness = createFakeKeymap();
  const closed: string[] = [];
  const opened: string[] = [];
  const notifications: string[] = [];
  const installed: string[] = [];
  const previews: EnvironmentCompositionInput[] = [];
  const applied: EnvironmentCompositionInput[] = [];
  const { host } = createViewHost({
    interaction: { keymap: harness.keymap } as unknown as Interaction,
    close: () => closed.push("closed"),
    dispatch: () => {},
  });
  const ref = { scope: "global" as const, name: "mine" };
  const baseDefinition = options.definition ?? EMPTY_DEFINITION;
  let current = options.cliSelection
    ? { ...builtin(), selection_origin: "cli" as const }
    : builtin();
  let inventory: EnvironmentInventory = options.inventory ?? {
    plugins: [context7Inventory()],
    standalone_skills: [
      {
        ref: { scope: "user", source: "agents", name: "deep-research" },
        active: false,
        found: true,
        description: "Research a question from primary sources",
      },
    ],
  };
  let lastPreview: EnvironmentCompositionPreview | undefined;
  const service: EnvironmentService = {
    list: async () => [
      { ref: builtin().ref, immutable: true },
      {
        ref,
        immutable: false,
        revision: `sha256:${"c".repeat(64)}`,
        definition: baseDefinition,
      },
    ],
    current: async () => current,
    get: async (target) =>
      target.scope === "builtin" ? current : resolveDraft(ref, baseDefinition, inventory),
    inventory: async () => inventory,
    preview: async () => {
      throw new Error("not used");
    },
    previewClear: async () => {
      throw new Error("not used");
    },
    previewComposition: async (input) => {
      previews.push(input);
      await options.previewGate;
      const resolved = resolveDraft(input.ref, input.definition, inventory);
      const authored: ResolvedEnvironment = options.previewIssue
        ? {
            ...resolved,
            status: "degraded",
            issues: [{ code: "invalid_plugin", message: "plugin executable content changed" }],
          }
        : resolved;
      lastPreview = {
        current,
        authored,
        target: authored,
        delta: {
          plugins_entering: authored.plugins
            .filter((plugin) => plugin.active)
            .map((plugin) => plugin.ref),
          plugins_leaving: [],
          skills_entering: authored.standalone_skills
            .filter((skill) => skill.active)
            .map((skill) => `standalone:${skill.ref.scope}:${skill.ref.source}:${skill.ref.name}`),
          skills_leaving: [],
          mcp_servers_entering: authored.plugins.flatMap((plugin) => plugin.mcp_servers),
          mcp_servers_leaving: [],
          hooks_entering: authored.plugins
            .filter((plugin) => plugin.hooks.total > 0)
            .map((plugin) => ({ plugin: plugin.ref, ...plugin.hooks })),
          hooks_leaving: [],
        },
        token: `preview-${previews.length}`,
        requires_workspace_trust: options.requiresWorkspaceTrust === true,
      };
      return lastPreview;
    },
    select: async () => {
      throw new Error("not used");
    },
    clearSelection: async () => {
      throw new Error("not used");
    },
    applyComposition: async (input) => {
      await options.applyGate;
      applied.push(input);
      current = lastPreview!.target;
      return {
        definition: {
          ref: input.ref,
          immutable: false,
          revision: `sha256:${"d".repeat(64)}`,
          definition: input.definition,
        },
        selected: input.ref,
        effective: input.ref,
        reconnect_required: true,
      };
    },
    create: async () => {
      throw new Error("not used");
    },
    update: async () => {
      throw new Error("not used");
    },
    delete: async () => {
      throw new Error("not used");
    },
    clone: async () => {
      throw new Error("not used");
    },
  };
  const deps: ExtensionsHubDeps = {
    environments: service,
    definitions: () => [
      { ref: builtin().ref, immutable: true },
      {
        ref,
        immutable: false,
        revision: `sha256:${"c".repeat(64)}`,
        definition: baseDefinition,
      },
    ],
    inventory: () => inventory,
    current: () => current,
    listings: () => options.listings ?? [listing()],
    sources: () => [
      { url: "https://github.com/getclarvis/marketplace.git" } satisfies MarketplaceSource,
    ],
    loading: () => false,
    loadError: () => options.loadError,
    install: async (value, source) => {
      await options.installGate;
      installed.push(`${value.name}:${source}`);
      const plugin = installedPlugin(source);
      inventory = { ...inventory, plugins: [...inventory.plugins, context7Inventory(source)] };
      return plugin;
    },
    refresh: async () => {},
    reconnect: async () => options.reconnectResult ?? { ok: true, message: "connected" },
    runActive: () => options.runActive === true,
    notify: (message) => notifications.push(message),
    openChild: (command) => opened.push(command),
    ...(options.initialEnvironment === undefined
      ? {}
      : { initialEnvironment: options.initialEnvironment }),
  };
  return {
    host,
    press: harness.press,
    deps,
    installed,
    previews,
    applied,
    notifications,
    opened,
    closed,
  };
}

async function settle(
  rendered: Awaited<ReturnType<typeof openRender>>,
  predicate: () => boolean,
): Promise<void> {
  for (let index = 0; index < 40 && !predicate(); index += 1) {
    await Promise.resolve();
    await rendered.renderOnce();
  }
}

test("guides scope, Environment, exact extensions, capabilities and activation", async () => {
  const applyGate = operationGate();
  const mounted = mount({ applyGate: applyGate.wait });
  const rendered = await openRender((() => ExtensionsHub(mounted.host, mounted.deps)) as never, {
    width: 120,
    height: 32,
  });
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Build one exact extension snapshot");

  mounted.press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Step 1 of 5");
  expect(rendered.captureCharFrame()).toContain("This workspace");

  mounted.press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Step 2 of 5");
  expect(rendered.captureCharFrame()).toContain("global:mine");
  expect(rendered.captureCharFrame()).toContain("Clone active → workspace");

  mounted.press("down");
  mounted.press("down");
  mounted.press("return");
  await rendered.renderOnce();
  let frame = rendered.captureCharFrame();
  expect(frame).toContain("Step 3 of 5");
  expect(frame).toContain("context7");
  expect(frame).toContain("/deep-research");
  expect(frame).toContain("global/agents");
  expect(frame).toContain("Continue to");
  expect(frame).toContain("review");
  expect(frame).toContain("[↵] continue");
  expect(frame).toContain("[esc] back");

  mounted.press("down");
  mounted.press("return");
  mounted.press("down");
  mounted.press("return");
  mounted.press("home");
  mounted.press("return");
  await settle(rendered, () => rendered.captureCharFrame().includes("Capabilities"));
  frame = rendered.captureCharFrame();
  expect(frame).toContain("context7:docs-agent");
  expect(frame).toContain("context7:/context7-docs");
  expect(frame).toContain("context7");
  expect(frame).toContain("Selecting each plugin approves its complete contribution");
  expect(frame).toContain("[esc] back");
  expect(frame).not.toContain("change extensions");
  expect(mounted.applied).toEqual([]);

  mounted.press("escape");
  await settle(rendered, () => rendered.captureCharFrame().includes("[↵] continue"));
  expect(mounted.host.pendingConfirm()).toBeNull();
  expect(rendered.captureCharFrame()).toContain("2 selected");
  mounted.press("return");
  await settle(rendered, () => rendered.captureCharFrame().includes("Capabilities"));

  mounted.press("return");
  await rendered.renderOnce();
  frame = rendered.captureCharFrame();
  expect(frame).toContain("Step 5 of 5");
  expect(frame).toContain("Plugins entering (1)");
  expect(frame).toContain("MCP servers entering (1)");
  expect(frame).toContain("Hooks entering (1)");
  expect(frame).toContain("[↵] apply and reconnect");
  expect(frame).toContain("[esc] back");
  expect(frame).not.toContain("[y] apply and reconnect");
  expect(mounted.applied).toEqual([]);

  mounted.press("return");
  await settle(rendered, () => rendered.captureCharFrame().includes("Applying reviewed snapshot"));
  frame = rendered.captureCharFrame();
  expect(frame).toContain(spinnerChar());
  expect(frame).toContain("Applying reviewed snapshot");
  expect(mounted.applied).toEqual([]);
  applyGate.release();
  await settle(rendered, () => rendered.captureCharFrame().includes("Extensions ready"));
  expect(mounted.applied).toHaveLength(1);
  expect(mounted.applied[0]!.definition.plugins).toEqual([
    { scope: "global", source: "agents", name: "context7" },
  ]);
  expect(mounted.applied[0]!.definition.skills).toEqual([
    { scope: "user", source: "agents", name: "deep-research" },
  ]);
  expect(rendered.captureCharFrame()).toContain("Extensions ready");
  rendered.renderer.destroy();
});

test("Escape goes back and confirms before discarding an edited Environment draft", async () => {
  const mounted = mount({ initialEnvironment: { scope: "global", name: "mine" } });
  const rendered = await openRender((() => ExtensionsHub(mounted.host, mounted.deps)) as never, {
    width: 100,
    height: 25,
  });
  await settle(rendered, () => rendered.captureCharFrame().includes("[↵] continue"));

  mounted.press("down");
  mounted.press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("1 selected");
  mounted.press("escape");
  await settle(rendered, () => rendered.captureCharFrame().includes("[y] discard"));
  expect(mounted.host.pendingConfirm()?.message).toContain("Unsaved Environment changes");
  expect(mounted.host.pendingConfirm()?.confirmLabel).toBe("discard");
  expect(mounted.host.pendingConfirm()?.cancelLabel).toBe("keep editing");
  expect(rendered.captureCharFrame()).toContain("[y] discard");

  mounted.press("n");
  await settle(rendered, () => rendered.captureCharFrame().includes("[↵] continue"));
  expect(mounted.host.pendingConfirm()).toBeNull();
  expect(rendered.captureCharFrame()).toContain("1 selected");

  mounted.press("escape");
  await settle(rendered, () => rendered.captureCharFrame().includes("[y] discard"));
  mounted.press("y");
  await settle(rendered, () => rendered.captureCharFrame().includes("Step 2 of 5"));
  expect(mounted.host.pendingConfirm()).toBeNull();
  expect(rendered.captureCharFrame()).toContain("global:mine");
  rendered.renderer.destroy();
});

test("Escape leaves an unchanged existing draft without a discard prompt", async () => {
  const mounted = mount({ initialEnvironment: { scope: "global", name: "mine" } });
  const rendered = await openRender((() => ExtensionsHub(mounted.host, mounted.deps)) as never, {
    width: 100,
    height: 25,
  });
  await settle(rendered, () => rendered.captureCharFrame().includes("[↵] continue"));
  mounted.press("escape");
  await settle(rendered, () => rendered.captureCharFrame().includes("Step 2 of 5"));
  expect(mounted.host.pendingConfirm()).toBeNull();
  expect(rendered.captureCharFrame()).toContain("global:mine");
  rendered.renderer.destroy();
});

test("pins apply progress beside a long delta and lets Escape leave while apply continues", async () => {
  const applyGate = operationGate();
  const plugins = Array.from({ length: 36 }, (_, index) => {
    const plugin = context7Inventory("agents");
    return {
      ...plugin,
      ref: { ...plugin.ref, name: `extension-${String(index).padStart(2, "0")}` },
      skills: [`skill-${index}`],
      mcp_servers: [`extension-${index}:server`],
    };
  });
  const definition: EnvironmentDefinition = {
    schema_version: 1,
    plugins: plugins.map((plugin) => plugin.ref),
    skills: [],
  };
  const mounted = mount({
    inventory: { plugins, standalone_skills: [] },
    definition,
    initialEnvironment: { scope: "global", name: "mine" },
    applyGate: applyGate.wait,
  });
  const rendered = await openRender((() => ExtensionsHub(mounted.host, mounted.deps)) as never, {
    width: 80,
    height: 24,
  });

  await settle(rendered, () => rendered.captureCharFrame().includes("Step 3 of 5"));
  mounted.press("return");
  await settle(rendered, () => rendered.captureCharFrame().includes("Capabilities"));
  mounted.press("return");
  await settle(rendered, () => rendered.captureCharFrame().includes("Step 5 of 5"));
  mounted.press("return");
  await settle(rendered, () => rendered.captureCharFrame().includes("Applying reviewed snapshot"));

  const applying = rendered.captureCharFrame();
  expect(applying).toContain(spinnerChar());
  expect(applying).toContain("Applying reviewed snapshot");
  expect(applying).toContain("footer reports progress");
  expect(applying.trimEnd().split("\n").at(-1)).toContain("Applying reviewed snapshot");
  expect(applying).toContain("[esc] close");
  mounted.press("escape");
  await rendered.renderOnce();
  expect(mounted.closed).toEqual(["closed"]);
  expect(mounted.applied).toEqual([]);

  applyGate.release();
  await settle(rendered, () => mounted.applied.length === 1);
  expect(mounted.notifications.join("\n")).toContain("global:mine is active for future runs");
  expect(rendered.captureCharFrame()).not.toContain("Extensions ready");
  rendered.renderer.destroy();
});

test("Escape returns from a pending capability preview without waiting for it", async () => {
  const previewGate = operationGate();
  const mounted = mount({
    initialEnvironment: { scope: "global", name: "mine" },
    previewGate: previewGate.wait,
  });
  const rendered = await openRender((() => ExtensionsHub(mounted.host, mounted.deps)) as never, {
    width: 100,
    height: 26,
  });
  await settle(rendered, () => rendered.captureCharFrame().includes("Step 3 of 5"));
  mounted.press("return");
  await settle(rendered, () =>
    rendered.captureCharFrame().includes("Resolving exact capabilities"),
  );
  expect(rendered.captureCharFrame()).toContain("[esc] back");

  mounted.press("escape");
  await settle(rendered, () => rendered.captureCharFrame().includes("[↵] continue"));
  expect(rendered.captureCharFrame()).toContain("Step 3 of 5");

  previewGate.release();
  await settle(
    rendered,
    () => !rendered.captureCharFrame().includes("Resolving exact capabilities"),
  );
  expect(rendered.captureCharFrame()).toContain("Step 3 of 5");
  expect(rendered.captureCharFrame()).not.toContain("Capabilities of");
  rendered.renderer.destroy();
});

test("shows workspace approval, degraded issues and reconnect recovery in the guided result", async () => {
  const mounted = mount({
    definition: {
      schema_version: 1,
      plugins: [{ scope: "global", source: "agents", name: "context7" }],
      skills: [],
    },
    initialEnvironment: { scope: "global", name: "mine" },
    requiresWorkspaceTrust: true,
    previewIssue: true,
    reconnectResult: { ok: false, message: "backend reconnect pending" },
  });
  const rendered = await openRender((() => ExtensionsHub(mounted.host, mounted.deps)) as never, {
    width: 120,
    height: 32,
  });

  await settle(rendered, () => rendered.captureCharFrame().includes("Step 3 of 5"));
  mounted.press("return");
  await settle(rendered, () => rendered.captureCharFrame().includes("Capabilities"));
  let frame = rendered.captureCharFrame();
  expect(frame).toContain("Selecting each plugin approves its complete contribution");
  mounted.press("end");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Issues (1)");

  mounted.press("return");
  await settle(rendered, () => rendered.captureCharFrame().includes("Step 5 of 5"));
  for (let index = 0; index < 6; index += 1) mounted.press("pagedown");
  await rendered.renderOnce();
  frame = rendered.captureCharFrame();
  expect(frame).toContain("selected plugin enters as one complete unit");

  mounted.press("return");
  await settle(rendered, () => rendered.captureCharFrame().includes("Environment saved"));
  frame = rendered.captureCharFrame();
  expect(frame).toContain("1 issue requires attention");
  expect(frame).toContain("backend reconnect pending");
  rendered.renderer.destroy();
});

test("installs into the chosen convention but waits for Step 5 to activate", async () => {
  const installGate = operationGate();
  const mounted = mount({
    inventory: { plugins: [], standalone_skills: [] },
    initialEnvironment: { scope: "global", name: "mine" },
    installGate: installGate.wait,
  });
  const rendered = await openRender((() => ExtensionsHub(mounted.host, mounted.deps)) as never, {
    width: 100,
    height: 26,
  });
  await settle(rendered, () => rendered.captureCharFrame().includes("Step 3 of 5"));
  mounted.press("down");
  mounted.press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain(".agents/plugins");
  expect(rendered.captureCharFrame()).toContain(".clarvis/plugins");
  mounted.press("down");
  mounted.press("return");
  await settle(rendered, () => rendered.captureCharFrame().includes("Installing context7"));
  const installing = rendered.captureCharFrame();
  expect(installing).toContain(spinnerChar());
  expect(installing).toContain("Installing context7");
  expect(mounted.installed).toEqual([]);
  installGate.release();
  await settle(rendered, () => mounted.notifications.length > 0);
  expect(mounted.installed).toEqual(["context7:clarvis"]);
  expect(mounted.applied).toEqual([]);
  expect(mounted.notifications.join("\n")).toContain("staged, not active until Step 5");
  await settle(rendered, () => rendered.captureCharFrame().includes("[↵] continue"));
  mounted.press("home");
  mounted.press("return");
  await settle(rendered, () => mounted.previews.length === 1);
  expect(mounted.previews[0]!.definition.plugins).toEqual([
    { scope: "global", source: "clarvis", name: "context7" },
  ]);
  expect(mounted.applied).toEqual([]);
  rendered.renderer.destroy();
});

test("Escape leaves a pending install immediately and the checkout finishes without stale staging", async () => {
  const installGate = operationGate();
  const mounted = mount({
    inventory: { plugins: [], standalone_skills: [] },
    initialEnvironment: { scope: "global", name: "mine" },
    installGate: installGate.wait,
  });
  const rendered = await openRender((() => ExtensionsHub(mounted.host, mounted.deps)) as never, {
    width: 100,
    height: 26,
  });
  await settle(rendered, () => rendered.captureCharFrame().includes("Step 3 of 5"));
  mounted.press("down");
  mounted.press("return");
  mounted.press("down");
  mounted.press("return");
  await settle(rendered, () => rendered.captureCharFrame().includes("Installing context7"));
  expect(rendered.captureCharFrame()).toContain("[esc] back");

  mounted.press("escape");
  await settle(rendered, () => rendered.captureCharFrame().includes("Step 2 of 5"));
  expect(mounted.installed).toEqual([]);

  installGate.release();
  await settle(rendered, () => mounted.installed.length === 1);
  expect(mounted.applied).toEqual([]);
  expect(mounted.notifications.join("\n")).toContain("setup was left before staging");
  rendered.renderer.destroy();
});

test("same-name plugin origins remain exact and replacing one is explicit", async () => {
  const mounted = mount({
    inventory: {
      plugins: [context7Inventory("agents"), context7Inventory("clarvis")],
      standalone_skills: [],
    },
    listings: [],
    initialEnvironment: { scope: "global", name: "mine" },
  });
  const rendered = await openRender((() => ExtensionsHub(mounted.host, mounted.deps)) as never, {
    width: 140,
    height: 25,
  });
  await settle(rendered, () => rendered.captureCharFrame().includes("global/agents"));
  expect(rendered.captureCharFrame()).toContain("global/clarvis");
  mounted.press("down");
  mounted.press("return");
  mounted.press("down");
  mounted.press("return");
  expect(mounted.notifications.join("\n")).toContain(
    "replaced global/agents/context7 with global/clarvis/context7",
  );
  mounted.press("home");
  mounted.press("return");
  await settle(rendered, () => mounted.previews.length === 1);
  expect(mounted.previews[0]!.definition.plugins).toEqual([
    { scope: "global", source: "clarvis", name: "context7" },
  ]);
  rendered.renderer.destroy();
});

test("missing selected origins stay visible and removable from the exact draft", async () => {
  const mounted = mount({
    inventory: { plugins: [], standalone_skills: [] },
    listings: [],
    definition: {
      schema_version: 1,
      plugins: [{ scope: "global", source: "agents", name: "gone" }],
      skills: [{ scope: "user", source: "clarvis", name: "gone-skill" }],
    },
    initialEnvironment: { scope: "global", name: "mine" },
  });
  const rendered = await openRender((() => ExtensionsHub(mounted.host, mounted.deps)) as never, {
    width: 110,
    height: 24,
  });
  await settle(rendered, () => rendered.captureCharFrame().includes("missing selected"));
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("gone");
  expect(frame).toContain("gone-skill");
  mounted.press("down");
  mounted.press("return");
  mounted.press("home");
  mounted.press("return");
  await settle(rendered, () => mounted.previews.length === 1);
  expect(
    mounted.previews[0]!.definition.plugins.length + mounted.previews[0]!.definition.skills.length,
  ).toBe(1);
  rendered.renderer.destroy();
});

test("a 196-item Step 3 catalog remains searchable and navigable in retained slots", async () => {
  const listings = Array.from({ length: 196 }, (_, index) =>
    listing({
      name: `plugin-${String(index).padStart(3, "0")}`,
      displayName: `Plugin ${String(index).padStart(3, "0")}`,
      description: index === 137 ? "unique vector database helper" : `Extension ${index}`,
    }),
  );
  const mounted = mount({
    inventory: { plugins: [], standalone_skills: [] },
    listings,
    initialEnvironment: { scope: "global", name: "mine" },
  });
  const rendered = await openRender((() => ExtensionsHub(mounted.host, mounted.deps)) as never, {
    width: 80,
    height: 24,
  });
  await settle(rendered, () => rendered.captureCharFrame().includes("Plugin 000"));
  mounted.press("end");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Plugin 195");

  mounted.press("/");
  await rendered.renderOnce();
  await rendered.mockInput.typeText("vector database");
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("filter  vector database");
  expect(frame).toContain("Plugin 137");
  expect(frame).not.toContain("Plugin 195");
  rendered.renderer.destroy();
});

test("active runs and --env keep the final reviewed mutation read-only", async () => {
  const mounted = mount({
    initialEnvironment: { scope: "global", name: "mine" },
    runActive: true,
    cliSelection: true,
  });
  const rendered = await openRender((() => ExtensionsHub(mounted.host, mounted.deps)) as never, {
    width: 100,
    height: 25,
  });
  await settle(rendered, () => rendered.captureCharFrame().includes("Step 3 of 5"));
  mounted.press("return");
  await settle(rendered, () => rendered.captureCharFrame().includes("Capabilities"));
  mounted.press("return");
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("Finish the active run before applying");
  expect(frame).toContain("Restart without --env");
  mounted.press("return");
  await rendered.renderOnce();
  expect(mounted.applied).toEqual([]);
  rendered.renderer.destroy();
});

test("compact setup keeps load errors persistent instead of flashing them in the footer", async () => {
  const mounted = mount({ loadError: "ENOENT: failed to read Environment inventory" });
  const rendered = await openRender((() => ExtensionsHub(mounted.host, mounted.deps)) as never, {
    width: 60,
    height: 20,
  });
  for (let index = 0; index < 5; index += 1) await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("Build one exact extension snapshot");
  expect(frame).toContain("ENOENT: failed to read Environment inventory");
  expect(frame).toContain("r to retry");
  mounted.press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).not.toContain("Step 1 of 5");
  rendered.renderer.destroy();
});

test("the 80x24 Extensions intro gives its rows to decisions instead of crowding them with the banner", async () => {
  const mounted = mount({});
  const rendered = await openRender((() => ExtensionsHub(mounted.host, mounted.deps)) as never, {
    width: 80,
    height: 24,
  });
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("Build one exact extension snapshot");
  expect(frame).toContain("Enter → begin guided setup");
  expect(frame).toContain("Plugins and Marketplace");
  expect(frame).not.toContain("d8888b");
  rendered.renderer.destroy();
});
