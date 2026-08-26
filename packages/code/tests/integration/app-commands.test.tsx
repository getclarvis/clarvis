import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import {
  createCommands,
  type CommandEffects,
  type CommandUi,
  type Commands,
} from "../../src/keys/commands.ts";
import { registerAppCommands, type AppCommandDeps } from "../../src/app/commands.tsx";
import { registerProvidersCommands } from "../../src/features/providers/commands.ts";
import { registerAgentsCommands } from "../../src/features/agents/commands.ts";
import { readEnvView } from "../../src/adapters/agent-files.ts";
import type { SettingsAdapter } from "../../src/adapters/settings.ts";
import type { CodeConfigStore } from "../../src/adapters/code-config.ts";
import type { AgentsStore } from "../../src/adapters/agents-store.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import type { PluginService } from "@clarvis/protocol";
import { TOKEN_ORDER } from "../../src/theme/model.ts";
import { fakeDebugSession } from "../helpers/fake-debug-session.ts";
import { SUBAGENT_ORDER } from "../../src/theme/tokens.ts";
import { globalPaths, workspacePaths } from "@clarvis/paths";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { Help } from "../../src/views/overlays/Help.tsx";

async function waitUntil(predicate: () => boolean, maxIters = 40): Promise<void> {
  for (let i = 0; i < maxIters && !predicate(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function waitForFrame(
  rendered: Awaited<ReturnType<typeof openRender>>,
  token: string,
  maxIters = 40,
): Promise<string> {
  let frame = "";
  for (let i = 0; i < maxIters; i += 1) {
    await rendered.renderOnce();
    frame = rendered.captureCharFrame();
    if (frame.includes(token)) return frame;
    await Promise.resolve();
  }
  return frame;
}

interface FakeCmd {
  name: string;
  run: (ctx: unknown) => unknown;
  [k: string]: unknown;
}

function fakeInteraction(): Interaction {
  const cmds = new Map<string, FakeCmd>();
  const keymap = {
    registerLayer(layer: { commands?: FakeCmd[] }) {
      for (const c of layer.commands ?? []) cmds.set(c.name, c);
      return () => {
        for (const c of layer.commands ?? []) cmds.delete(c.name);
      };
    },
    runCommand(name: string) {
      const c = cmds.get(name);
      if (c) c.run({});
      return { ok: !!c };
    },
    getCommandBindings: () => new Map(),
    getCommandEntries: () => [],
  };
  return {
    keymap: keymap as never,
    renderer: undefined as never,
    pushOverlayContext: () => {},
    popOverlayContext: () => {},
    setModalContext: () => {},
    keyboardEnvironment: undefined as never,
    keyboardEnvironmentId: undefined as never,
    configureKeyboard: () => {},
    dispose: () => {},
  };
}

test("Help renders from the minimal application command projection", async () => {
  const rendered = await openRender(
    () => <Help interaction={fakeInteraction()} entries={() => []} />,
    { width: 80, height: 24 },
  );
  try {
    await rendered.renderOnce();
    expect(rendered.captureCharFrame()).toContain("Input syntax");
  } finally {
    rendered.renderer.destroy();
  }
});

function fakeSettings(): SettingsAdapter {
  return {
    version: () => 0,
    read: () => ({}),
    corrupt: () => null,
    planRepair: () => null,
    applyRepair: async () => {},
    effective: () => ({}),
    origin: () => undefined,
    effectiveProviders: () => [],
    knownGrants: () => undefined,
    withheldWorkspaceFields: () => [],
    workspaceTrust: () => "inert",
    setWorkspaceTrust: async () => {},
    sources: () => ({ global: "/nonexistent/global" }),
    write: async () => {},
    validateProviders: () => ({ ok: true }),
    refs: () => ({ agents: [], defaultModel: false }),
    modelRefs: () => ({ agents: [], defaultModel: false }),
    envStatus: () => "unset",
    declaredMcpServers: () => [],
    reload: async () => {},
    inspectSandbox: () => Promise.resolve(null as never),
  };
}

function fakeCode(): CodeConfigStore {
  return {
    read: () => ({}),
    themeAt: () => ({}),
    effectiveTheme: () => ({}),
    agentDefault: () => undefined,
    guardModeDefault: () => undefined,
    asciiEnabled: () => false,
    keyboardConfig: () => ({ version: 1, environments: {} }),
    keySources: () => ({}),
    keySource: () => "auto",
    overrideSource: () => null,
    write: () => {},
    writeAscii: () => {},
    writeKeyboardEnvironment: () => {},
    writeTheme: () => {},
    writeAgentDefault: () => {},
    clearAgentDefault: () => {},
    writeKeySource: () => {},
    hasWorkspace: () => false,
  };
}

function baseDeps(
  calls: string[],
  commands: Commands,
  ui: CommandUi,
  overrides: Partial<AppCommandDeps>,
): AppCommandDeps {
  const deps: AppCommandDeps = {
    commands,
    ui,
    effects: {
      openAgentPicker: () => calls.push("agent-picker"),
      openSafetyPresetPicker: () => calls.push("safety-picker"),
      cycleGuardMode: () => calls.push("guard-cycle"),
      openDiff: () => calls.push("diff"),
      openPlan: () => calls.push("plan"),
      quit: () => calls.push("quit"),
    },
    session: {
      list: () => [],
      resume: (id) => calls.push("resume:" + id),
      delete: async (item) => {
        calls.push("delete:" + item.meta.id);
      },
      statusLine: () => "status",
    },
    notify: (message, tone) => calls.push(`notify:${message}${tone ? `:${tone}` : ""}`),
    debugSession: fakeDebugSession(),
    settings: fakeSettings(),
    dirs: { global: globalPaths("/nonexistent/global") },
    catalog: null,
    refreshModels: async () => ({ providers: 0, models: 0 }),
    refreshAgentProfiles: async () => {},
    keys: {} as never,
    reconnectBackend: async () => ({ ok: true, message: "ok" }),
    env: readEnvView(),
    preview: {
      source: () => ({ mode: "dark", preset: "family" }),
      draft: () => null,
      set: () => {},
      reset: () => {},
      commit: async () => {},
      overridesAt: () => undefined,
      resolveToken: () => ({ value: "#888888", source: "family" }),
      resolveAll: () => ({
        ...Object.fromEntries(TOKEN_ORDER.map((t) => [t, "#888888"])),
        ...Object.fromEntries(SUBAGENT_ORDER.map((n) => [n, "#888888"])),
        subagent: SUBAGENT_ORDER.map(() => "#888888"),
      }),
    } as never,
    platform: {
      capabilities: { themeBg: () => "dark", colorDepth: () => "truecolor" },
      suspend: () => {},
      resume: () => {},
    } as never,
    agents: { active: () => "", view: () => undefined, list: () => [] } as never,
    agentFiles: {
      list: () => [],
      conflicts: () => [],
      read: async () => null,
      write: async () => {},
      remove: async () => {},
      rename: async () => {},
      reload: async () => {},
    } satisfies AgentsStore,
    plugins: fakePluginService(),
    code: fakeCode(),
    memoryMode: {
      configured: () => true,
      mode: () => "on",
      setMode: (m: string) => calls.push("memory:" + m),
      cycle: () => "on",
      refresh: () => {},
    } as never,
    workflows: {
      list: async () => ({ items: [], total: 0, limit: 20, offset: 0 }),
      get: async () => null,
      delete: async () => {},
    } as never,
    tasks: { available: () => false } as never,
    storage: {
      inspect: async () => ({
        generated_at: Date.now(),
        total_bytes: 0,
        reclaimable_bytes: 0,
        truncated: false,
        categories: [],
        credentials: {
          keys: { present: false, owner_only: null },
          subscriptions: { present: false, owner_only: null },
        },
      }),
      cleanup: async () => {
        throw new Error("not implemented in command registration test");
      },
    },
    guard: {
      mode: () => "off",
      setMode: (m: string) => calls.push("guard:" + m),
      setDefault: () => {},
      cycle: () => "on",
    } as never,
    getRun: async () => null,
    runActive: () => false,
    hasAvailablePlan: () => false,
    backend: () => ({ status: "reachable", profileCount: 1 }),
    mcpClient: {
      listTools: async () => [],
      listPrompts: async () => [],
      getPrompt: async () => [],
      connectionStatus: () => "unavailable",
    },
    onSubmitPrompt: () => calls.push("prompt"),
    onSubmitSkillRun: () => calls.push("skill"),
    onCompactRun: (request) => calls.push("compact:" + (request ?? "")),
    connection: () => ({ phase: "connecting" }),
    takeSlashArgs: () => "",
  };
  return { ...deps, ...overrides };
}

function harness(
  overrides: Partial<AppCommandDeps> = {},
  interaction = fakeInteraction(),
): {
  commands: Commands;
  calls: string[];
  opened: { name: string; scope?: string; parent?: string }[];
  recheck: () => void;
  dispose: () => void;
  deps: AppCommandDeps;
} {
  const calls: string[] = [];
  const opened: { name: string; scope?: string; parent?: string }[] = [];
  const effects: CommandEffects = {
    clearSession: () => calls.push("clear"),
    status: () => calls.push("status"),
    exportSession: () => calls.push("export"),
  };
  const ui: CommandUi = {
    openView: (name, _factory, opts) => {
      calls.push("view:" + name);
      opened.push({
        name,
        ...(opts?.scope !== undefined ? { scope: opts.scope } : {}),
        ...(opts?.parent ? { parent: opts.parent.name } : {}),
      });
    },
    dismiss: () => calls.push("dismiss"),
    commandFailed: (name, e) =>
      calls.push(`failed:${name}:${e instanceof Error ? e.message : String(e)}`),
  };
  const commands = createCommands(interaction, effects, ui);
  const deps = baseDeps(calls, commands, ui, overrides);
  let wiring!: ReturnType<typeof registerAppCommands>;
  const disposeRoot = createRoot((d) => {
    registerProvidersCommands(commands, {
      settings: deps.settings,
      catalog: deps.catalog,
      ...(deps.loadCatalog === undefined ? {} : { loadCatalog: deps.loadCatalog }),
      keys: deps.keys,
      code: deps.code,
      notify: deps.notify,
    });
    registerAgentsCommands(commands, {
      agents: deps.agentFiles,
      settings: deps.settings,
      catalog: deps.catalog,
      ...(deps.loadCatalog === undefined ? {} : { loadCatalog: deps.loadCatalog }),
      code: deps.code,
      env: deps.env,
      notify: deps.notify,
    });
    wiring = registerAppCommands(deps);
    return d;
  });
  const dispose = (): void => {
    wiring.dispose();
    commands.dispose();
    disposeRoot();
  };
  return { commands, calls, opened, recheck: wiring.recheck, dispose, deps };
}

function fakePluginService(): PluginService {
  return {
    list: async () => [],
    install: async () => {
      throw new Error("plugin installation belongs to PluginBrowser tests");
    },
    update: async () => {
      throw new Error("plugin updates belong to PluginBrowser tests");
    },
    uninstall: async () => {},
    hooks: async () => [],
    approveHook: async () => {},
    revokeHook: async () => {},
  };
}

function fakeViewKeymap(): Interaction["keymap"] {
  const keymap = {
    registerLayer(layer: { bindings?: { key: string; cmd: () => void }[] }) {
      void layer;
      return () => {};
    },
    getCommandBindings: () => new Map(),
    getCommandEntries: () => [],
  };
  return keymap as never;
}

function mountView(
  commands: Commands,
  name: string,
): {
  host: ReturnType<typeof createViewHost>["host"];
  factory: NonNullable<ReturnType<Commands["viewFactory"]>>;
} {
  const keymap = fakeViewKeymap();
  const { host } = createViewHost({
    interaction: {
      keymap,
      renderer: undefined as never,
      pushOverlayContext: () => {},
      popOverlayContext: () => {},
      setModalContext: () => {},
      keyboardEnvironment: undefined as never,
      keyboardEnvironmentId: undefined as never,
      configureKeyboard: () => {},
      dispose: () => {},
    },
    close: () => {},
    dispatch: () => {},
  });
  const factory = commands.viewFactory(name);
  if (!factory) throw new Error(`no view factory registered for ${name}`);
  return { host, factory };
}

function mountInteractiveView(commands: Commands, name: string) {
  const { keymap, press, layers } = createFakeKeymap();
  let closed = 0;
  const { host, controls } = createViewHost({
    interaction: {
      keymap,
      renderer: undefined as never,
      pushOverlayContext: () => {},
      popOverlayContext: () => {},
    } as unknown as Interaction,
    close: () => {
      closed++;
    },
    dispatch: (command) => {
      commands.runCommand(command);
    },
  });
  const factory = commands.viewFactory(name);
  if (!factory) throw new Error(`no view factory registered for ${name}`);
  return { host, controls, factory, press, keymap, layers, closed: () => closed };
}

test("/exit is gone — app.quit only answers to /quit", () => {
  const { commands, calls, dispose } = harness();
  const entry = commands.entries().find((e) => e.name === "app.quit")!;
  expect(entry.slashes).toEqual(["/quit"]);
  commands.runCommand("app.quit");
  expect(calls).toContain("quit");
  dispose();
});

test("/model is canonical and the retired picker command stays gone", () => {
  const { commands, dispose } = harness();
  const byName = new Map(commands.entries().map((e) => [e.name, e]));
  expect(byName.get("guard.picker")).toBeUndefined();
  expect(byName.get("model.picker")).toBeUndefined();
  expect(byName.get("model.open")).toMatchObject({ slashes: ["/model"], surface: "slash" });
  expect(byName.get("effort.open")).toMatchObject({ slashes: ["/effort"], surface: "slash" });
  dispose();
});

test("the public model catalog is requested only after a catalog-backed route opens", async () => {
  let loads = 0;
  const mounted = harness({
    loadCatalog: async () => {
      loads += 1;
    },
  });
  expect(loads).toBe(0);

  const view = mountView(mounted.commands, "providers.open");
  const rendered = await openRender(() => view.factory(view.host), { width: 100, height: 28 });
  await rendered.renderOnce();
  await waitUntil(() => loads === 1);
  expect(loads).toBe(1);

  rendered.renderer.destroy();
  mounted.dispose();
});

test("first-run setup waits for the lazy model catalog before mounting its provider picker", async () => {
  let loads = 0;
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  const anthropic = {
    id: "anthropic",
    name: "Anthropic",
    kind: "anthropic" as const,
    needsBaseUrl: false,
    models: [],
  };
  const mounted = harness({
    catalog: {
      source: "bundle",
      providers: () => [anthropic],
      provider: (id) => (id === anthropic.id ? anthropic : undefined),
      models: () => [],
      seed: () => undefined,
      fill: () => undefined,
    },
    loadCatalog: () => {
      loads += 1;
      return loaded;
    },
  });
  const view = mountView(mounted.commands, "setup.providers");
  const rendered = await openRender(() => view.factory(view.host), { width: 100, height: 28 });
  await rendered.renderOnce();
  await waitUntil(() => loads === 1);
  expect(rendered.captureCharFrame()).toContain("Loading");

  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const frame = await waitForFrame(rendered, "Browse all 1 providers");
  expect(frame).toContain("anthropic");

  rendered.renderer.destroy();
  mounted.dispose();
});

test("subscription entitlement is deferred until an explicit Doctor recheck", async () => {
  let lists = 0;
  let entitled = 0;
  const mounted = harness({
    providerAuth: {
      list: async () => {
        lists += 1;
        return [{ scheme: "openai-codex", state: "connected" }];
      },
    } as never,
    modelsService: {
      getEntitled: async () => {
        entitled += 1;
        return { provider: "openai-codex", models: [{ id: "codex" }] };
      },
    } as never,
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(lists).toBe(0);
  expect(entitled).toBe(0);

  mounted.recheck();
  await waitUntil(() => entitled === 1);
  expect(lists).toBe(1);
  expect(entitled).toBe(1);
  mounted.dispose();
});

test("planning mode commands switch workspace policy without resetting plan retention", async () => {
  const writes: { scope: string; patch: unknown }[] = [];
  const settings: SettingsAdapter = {
    ...fakeSettings(),
    read: (scope) =>
      scope === "workspace"
        ? ({
            plans: {
              mode: "off",
              retention: "discard",
              pending_task_nudges: 7,
            },
          } as never)
        : undefined,
    effective: () =>
      ({
        plans: {
          mode: "off",
          retention: "discard",
          pending_task_nudges: 7,
        },
      }) as never,
    write: async (scope, patch) => {
      writes.push({ scope, patch });
    },
  };
  const { commands, calls, dispose } = harness({ settings });

  commands.runCommand("plan.enableReview");
  await waitUntil(() =>
    calls.includes("notify:planning: approval required (workspace settings):success"),
  );

  expect(writes.filter((write) => write.scope === "workspace")).toEqual([
    {
      scope: "workspace",
      patch: {
        plans: {
          mode: "review",
          retention: "discard",
          pending_task_nudges: 7,
        },
      },
    },
  ]);
  expect(calls).toContain("notify:planning: approval required (workspace settings):success");

  commands.runCommand("plan.enableDefault");
  await waitUntil(() =>
    calls.includes("notify:planning: default mode restored (workspace settings):success"),
  );

  expect(writes.filter((write) => write.scope === "workspace").at(-1)).toEqual({
    scope: "workspace",
    patch: {
      plans: {
        mode: "on",
        retention: "discard",
        pending_task_nudges: 7,
      },
    },
  });
  expect(calls).toContain("notify:planning: default mode restored (workspace settings):success");
  dispose();
});

test("every top-level command carries a canonical /token (no bare-title rows)", () => {
  const { commands, dispose } = harness();
  const byName = new Map(commands.entries().map((e) => [e.name, e]));
  const expected: Record<string, string[]> = {
    "app.quit": ["/quit"],
    "agent.picker": ["/agent"],
    "safety.picker": [],
    "transcript.diff": ["/diff"],
    "plan.enableReview": [],
    "planning.configure": ["/planning"],
    "plans.open": ["/plans"],
    "plan.enableDefault": [],
    "catalog.refresh": ["/refresh"],
    "backend.reconnect": ["/reconnect"],
    "doctor.open": ["/doctor"],
    "workflows.open": ["/workflow"],
    "settings.open": ["/settings"],
    "model.open": ["/model"],
    "effort.open": ["/effort"],
    "extensions.open": ["/extensions"],
    "providers.open": [],
    "plugins.open": [],
    "hooks.open": [],
    "mcp.browse": [],
  };
  for (const [name, slashes] of Object.entries(expected)) {
    expect([name, byName.get(name)?.slashes]).toEqual([name, slashes]);
  }
  dispose();
});

test("non-aliased hub children and folded toggles stay off the slash surface", () => {
  const { commands, dispose } = harness();
  const byName = new Map(commands.entries().map((e) => [e.name, e]));
  for (const name of ["controls.open", "capability-providers.open", "sandbox.config"]) {
    expect([name, byName.get(name)?.slashes]).toEqual([name, []]);
    expect([name, byName.get(name)?.parent]).toEqual([
      name,
      name.includes("plugin") || name === "mcp.browse" ? "extensions" : "settings",
    ]);
  }
  // Session memory is configured through Run controls; there is no global
  // quick-toggle command that can silently change execution semantics.
  expect(byName.get("guard.cycle")!.surface).toBe("internal");
  expect(byName.get("memory.cycle")).toBeUndefined();
  dispose();
});

test("hub children have one hierarchical slash route instead of duplicate aliases", () => {
  const { commands, dispose } = harness();
  const byName = new Map(commands.entries().map((entry) => [entry.name, entry]));
  expect(byName.get("providers.open")).toMatchObject({
    slashes: [],
    parent: "settings",
  });
  expect(byName.get("plugins.open")).toMatchObject({
    slashes: [],
    parent: "extensions",
  });
  expect(byName.get("hooks.open")).toMatchObject({ slashes: [], parent: "extensions" });
  expect(byName.get("mcp.browse")).toMatchObject({ slashes: [], parent: "extensions" });
  dispose();
});

test("/settings <child> deep-links to that editor with a mounted parent route", () => {
  const { commands, calls, opened, dispose } = harness();
  expect(commands.route("settings.open", "sandbox")).toBe(true);
  expect(calls).toContain("view:sandbox.config");
  expect(opened.at(-1)?.parent).toBe("settings.open");
  expect(commands.route("settings.open", "controls")).toBe(true);
  expect(calls).toContain("view:controls.open");
  expect(commands.route("settings.open", "")).toBe(false);
  expect(commands.route("settings.open", "bogus")).toBe(false);
  dispose();
});

test("settings children prefer workspace scope when workspace settings exist", () => {
  const settings = fakeSettings();
  settings.read = ((scope: string) =>
    scope === "workspace" ? { plans: {} } : {}) as SettingsAdapter["read"];
  const mounted = harness({ settings });
  expect(mounted.commands.route("settings.open", "capability-providers")).toBe(true);
  expect(mounted.opened.at(-1)).toEqual({
    name: "capability-providers.open",
    scope: "workspace",
    parent: "settings.open",
  });
  mounted.dispose();
});

test("/extensions <child> deep-links", () => {
  const { commands, calls, dispose } = harness();
  expect(commands.route("extensions.open", "market")).toBe(true);
  expect(calls).toContain("view:marketplace.open");
  dispose();
});

const DISPOSITION: [string, { surface: string; group: string; parent?: string }][] = [
  ["agent.picker", { surface: "slash", group: "navigate" }],
  ["safety.picker", { surface: "internal", group: "navigate" }],
  ["guard.cycle", { surface: "internal", group: "actions" }],
  ["sessions.open", { surface: "slash", group: "navigate", parent: "sessions" }],
  ["workflows.open", { surface: "slash", group: "navigate" }],
  ["settings.open", { surface: "slash", group: "navigate" }],
  ["extensions.open", { surface: "slash", group: "navigate" }],
  ["transcript.diff", { surface: "slash", group: "navigate", parent: "inspect" }],
  ["plan.enableReview", { surface: "internal", group: "actions" }],
  ["planning.configure", { surface: "slash", group: "actions" }],
  ["plan.enableDefault", { surface: "internal", group: "actions" }],
  ["plans.open", { surface: "slash", group: "navigate", parent: "inspect" }],
  ["plan.open", { surface: "internal", group: "navigate" }],
  ["app.quit", { surface: "slash", group: "actions" }],
  ["catalog.refresh", { surface: "slash", group: "actions", parent: "inspect" }],
  ["controls.open", { surface: "internal", group: "navigate", parent: "settings" }],
  ["providers.open", { surface: "internal", group: "navigate", parent: "settings" }],
  ["capability-providers.open", { surface: "internal", group: "navigate", parent: "settings" }],
  ["agents.open", { surface: "internal", group: "navigate", parent: "settings" }],
  ["defaults.open", { surface: "internal", group: "navigate", parent: "settings" }],
  ["model.open", { surface: "slash", group: "navigate" }],
  ["effort.open", { surface: "slash", group: "navigate" }],
  ["plugins.open", { surface: "internal", group: "navigate", parent: "extensions" }],
  ["hooks.open", { surface: "internal", group: "navigate", parent: "extensions" }],
  ["marketplace.open", { surface: "internal", group: "navigate", parent: "extensions" }],
  ["memory.config", { surface: "internal", group: "navigate", parent: "settings" }],
  ["sandbox.config", { surface: "internal", group: "navigate", parent: "settings" }],
  ["theme.open", { surface: "internal", group: "navigate", parent: "settings" }],
  ["backend.reconnect", { surface: "slash", group: "actions", parent: "inspect" }],
  ["doctor.open", { surface: "slash", group: "navigate", parent: "inspect" }],
  ["mcp.browse", { surface: "internal", group: "navigate", parent: "extensions" }],
];

test("every registered command matches its planned surface/group/parent disposition", () => {
  const { commands, dispose } = harness();
  const byName = new Map(commands.entries().map((e) => [e.name, e]));
  for (const [name, expected] of DISPOSITION) {
    const entry = byName.get(name);
    expect(entry).toBeDefined();
    expect([name, entry!.surface, entry!.group, entry!.parent]).toEqual([
      name,
      expected.surface,
      expected.group,
      expected.parent,
    ]);
  }
  dispose();
});

test("thin action commands dispatch through their injected application effects", () => {
  const { commands, calls, dispose } = harness();
  const contract = [
    ["agent.picker", "agent-picker"],
    ["safety.picker", "safety-picker"],
    ["guard.cycle", "guard-cycle"],
    ["transcript.diff", "diff"],
    ["plans.open", "plan"],
    ["plan.open", "plan"],
    ["app.quit", "quit"],
  ] as const;
  for (const [command, effect] of contract) {
    commands.runCommand(command);
    expect(calls).toContain(effect);
  }
  dispose();
});

test("every registered app command callback is safe to dispatch against the empty application state", async () => {
  const keymap = createFakeKeymap();
  const { calls, dispose } = harness({}, { ...fakeInteraction(), keymap: keymap.keymap });
  try {
    const callbacks = keymap.layers.flatMap((layer) => layer.commands ?? []);
    await Promise.allSettled(callbacks.map((command) => command.run({} as never)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((call) => call.startsWith("failed:"))).toEqual([]);
  } finally {
    dispose();
  }
});

test("plan.open remains enabled for a retained terminal plan", () => {
  let available = false;
  const keymap = createFakeKeymap();
  const mounted = harness(
    { hasAvailablePlan: () => available },
    { ...fakeInteraction(), keymap: keymap.keymap },
  );
  const planCommand = () =>
    keymap.keymap.getCommands().find((command) => command.name === "plan.open");

  expect(planCommand()).toBeUndefined();
  available = true;
  expect(planCommand()?.title).toBe("Plan details");
  expect(planCommand()?.desc).toBe("Open the current or latest plan full-screen");
  mounted.dispose();
});

test("catalog.refresh notifies before and after, with the fresh provider/model counts", async () => {
  const { commands, calls, dispose } = harness({
    refreshModels: async () => ({ providers: 3, models: 42 }),
  });
  commands.runCommand("catalog.refresh");
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toContain("notify:refreshing models.dev catalog…");
  expect(calls.some((c) => c.includes("42 models") && c.includes("success"))).toBe(true);
  dispose();
});

test("backend.reconnect surfaces a success notification and reruns the doctor gates", async () => {
  const { commands, calls, dispose } = harness({
    reconnectBackend: async () => ({ ok: true, message: "kernel rebuilt" }),
  });
  commands.runCommand("backend.reconnect");
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toContain("notify:reconnecting backend…");
  expect(calls).toContain("notify:kernel rebuilt:success");
  dispose();
});

test("backend.reconnect surfaces a failure notification with an error tone", async () => {
  const { commands, calls, dispose } = harness({
    reconnectBackend: async () => ({ ok: false, message: "kernel unreachable" }),
  });
  commands.runCommand("backend.reconnect");
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toContain("notify:kernel unreachable:error");
  dispose();
});

test("/compact exposes one optional argument and forwards the trimmed argument tail", () => {
  const { commands, calls, deps, dispose } = harness();
  const entry = commands.entries().find((candidate) => candidate.name === "run.compact");
  expect(entry).toMatchObject({
    slashes: ["/compact"],
    args: [{ name: "request", required: false }],
  });
  expect(entry?.canAct).toBeUndefined();

  deps.takeSlashArgs = () => "  keep auth context  ";
  commands.runCommand("run.compact");
  expect(calls).toContain("compact:keep auth context");

  deps.takeSlashArgs = () => "";
  commands.runCommand("run.compact");
  expect(calls).toContain("compact:");
  dispose();
});

test("/debug opens, retunes and closes the diagnostic log, and names the file each time", () => {
  const controller = fakeDebugSession();
  const { commands, calls, deps, dispose } = harness({ debugSession: controller });
  const entry = commands.entries().find((candidate) => candidate.name === "diagnostics.debug");
  expect(entry).toMatchObject({
    slashes: ["/debug"],
    args: [{ name: "level", required: false }],
  });

  deps.takeSlashArgs = () => "";
  commands.runCommand("diagnostics.debug");
  expect(controller.calls).toEqual(["open:debug"]);
  expect(calls.some((call) => call.includes("diagnostics at debug"))).toBe(true);
  expect(calls.some((call) => call.includes("/tmp/fake-debug.jsonl"))).toBe(true);

  deps.takeSlashArgs = () => "  WARN ";
  commands.runCommand("diagnostics.debug");
  expect(controller.calls).toEqual(["open:debug", "open:warn"]);

  deps.takeSlashArgs = () => "off";
  commands.runCommand("diagnostics.debug");
  expect(controller.calls.at(-1)).toBe("close");
  expect(calls.some((call) => call.includes("diagnostics closed"))).toBe(true);
  dispose();
});

test("/debug refuses a level it does not know, and says nothing was open when nothing was", () => {
  const controller = fakeDebugSession();
  const { commands, calls, deps, dispose } = harness({ debugSession: controller });

  deps.takeSlashArgs = () => "loud";
  commands.runCommand("diagnostics.debug");
  expect(controller.calls).toEqual([]);
  expect(calls.some((call) => call.includes("unknown level 'loud'"))).toBe(true);

  deps.takeSlashArgs = () => "off";
  commands.runCommand("diagnostics.debug");
  expect(calls.some((call) => call.includes("diagnostics are not open"))).toBe(true);
  dispose();
});

test("/debug off leaves a --debug session for the process's own exit handler", () => {
  const controller = fakeDebugSession(true);
  controller.close = () => null;
  const { commands, calls, deps, dispose } = harness({ debugSession: controller });

  deps.takeSlashArgs = () => "off";
  commands.runCommand("diagnostics.debug");
  expect(calls.some((call) => call.includes("opened with --debug"))).toBe(true);
  dispose();
});

test("a downstream MCP prompt with required args funnels a missing tail through collectArgs into a warn notify, never submitting", async () => {
  let argsTail = "";
  const { commands, calls, dispose } = harness({
    mcpClient: {
      listTools: async () => [],
      listPrompts: async () => [
        {
          name: "figma:inspect",
          description: "Inspect a node.",
          arguments: [{ name: "env", required: true }],
        },
      ],
      getPrompt: async () => [{ role: "user", content: "hi" }] as never,
      connectionStatus: () => "connected",
    },
    takeSlashArgs: () => argsTail,
  });
  await waitUntil(() => commands.entries().some((e) => e.name === "figma:inspect"));
  const entry = commands.entries().find((e) => e.name === "figma:inspect");
  expect(entry).toBeDefined();
  argsTail = "";
  commands.runCommand("figma:inspect");
  await waitUntil(() => calls.some((c) => c.includes("needs <env>")));
  expect(calls.some((c) => c.includes("needs <env>") && c.includes("warn"))).toBe(true);
  expect(calls).not.toContain("prompt");
  dispose();
});

test("a downstream MCP prompt with a satisfied tail parses positional args and submits the prompt turn", async () => {
  let argsTail = "";
  const { commands, calls, dispose } = harness({
    mcpClient: {
      listTools: async () => [],
      listPrompts: async () => [
        {
          name: "figma:inspect",
          description: "Inspect a node.",
          arguments: [{ name: "env", required: true }],
        },
      ],
      getPrompt: async () => [{ role: "user", content: "hi" }] as never,
      connectionStatus: () => "connected",
    },
    takeSlashArgs: () => argsTail,
  });
  await waitUntil(() => commands.entries().some((e) => e.name === "figma:inspect"));
  argsTail = "prod";
  commands.runCommand("figma:inspect");
  await waitUntil(() => calls.includes("prompt"));
  expect(calls).toContain("prompt");
  dispose();
});

test("onMount seeds the planning block once settings exist and it is unconfigured, and notifies the scope", async () => {
  const writes: { scope: string; patch: unknown }[] = [];
  const { calls, dispose } = harness({
    settings: {
      version: () => 0,
      read: () => ({}),
      corrupt: () => null,
      planRepair: () => null,
      applyRepair: async () => {},
      // A host past first boot: with an allow list already present the one-time
      // guard seed is a no-op, so `writes` holds only what this case triggers.
      effective: () => ({ guard: { type: "shell", allowed_commands: ["git status"] } }),
      origin: () => undefined,
      effectiveProviders: () => [],
      knownGrants: () => undefined,
      withheldWorkspaceFields: () => [],
      workspaceTrust: () => "inert",
      setWorkspaceTrust: async () => {},
      sources: () => ({ global: "/nonexistent/global" }),
      write: async (scope: string, patch: unknown) => {
        writes.push({ scope, patch });
      },
      validateProviders: () => ({ ok: true }),
      refs: () => ({ agents: [], defaultModel: false }),
      modelRefs: () => ({ agents: [], defaultModel: false }),
      envStatus: () => "unset",
      declaredMcpServers: () => [],
      reload: async () => {},
      inspectSandbox: () => Promise.resolve(null as never),
    } satisfies SettingsAdapter,
  });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  expect(writes.some((w) => w.scope === "global" && (w.patch as never)["plans" as never])).toBe(
    true,
  );
  expect(calls.some((c) => c.startsWith("notify:planning: on"))).toBe(true);
  dispose();
});

const FACTORY_SMOKES = [
  "help.open",
  "providers.open",
  "agents.open",
  "sessions.open",
  "workflows.open",
  "controls.open",
  "defaults.open",
  "model.open",
  "effort.open",
  "capability-providers.open",
  "plugins.open",
  "hooks.open",
  "marketplace.open",
  "memory.config",
  "sandbox.config",
  "theme.open",
  "settings.open",
  "doctor.open",
  "setup.providers",
  "setup.open",
  "recovery.open",
  "mcp.browse",
  "extensions.open",
] as const;

test("every registered view factory boots through one data-driven composition smoke", async () => {
  const { commands, dispose } = harness();
  try {
    for (const name of FACTORY_SMOKES) {
      const { host, factory } = mountView(commands, name);
      const rendered = await openRender(() => factory(host), { width: 130, height: 34 });
      try {
        await rendered.renderOnce();
        expect(rendered.captureCharFrame().length).toBeGreaterThan(0);
      } finally {
        rendered.renderer.destroy();
      }
    }
  } finally {
    dispose();
  }
});

test("every registered view handles its common keyboard actions without leaving the composition", async () => {
  const mounted = harness();
  const keys = [
    "return",
    "tab",
    "space",
    "up",
    "down",
    "left",
    "right",
    "j",
    "k",
    "a",
    "e",
    "d",
    "r",
    "s",
    "t",
    "x",
  ];
  try {
    for (const name of FACTORY_SMOKES) {
      const view = mountInteractiveView(mounted.commands, name);
      const rendered = await openRender(() => view.factory(view.host), { width: 130, height: 34 });
      try {
        await rendered.renderOnce();
        for (const key of keys) view.press(key);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await rendered.renderOnce();
      } finally {
        rendered.renderer.destroy();
      }
    }
  } finally {
    mounted.dispose();
  }
});

test("hub rows open their nested surfaces and expose their local actions", async () => {
  const mounted = harness();
  const localKeys = ["tab", "space", "a", "e", "r", "s", "t", "x", "d"];
  try {
    for (const name of FACTORY_SMOKES) {
      for (let row = 0; row < 12; row += 1) {
        const view = mountInteractiveView(mounted.commands, name);
        const rendered = await openRender(() => view.factory(view.host), {
          width: 130,
          height: 34,
        });
        try {
          await rendered.renderOnce();
          for (let index = 0; index < row; index += 1) view.press("down");
          view.press("return");
          await rendered.renderOnce();
          const activeActions = view.keymap.getCommands();
          await Promise.allSettled(activeActions.map(async (command) => command.run({} as never)));
          for (const key of localKeys) view.press(key);
          await rendered.renderOnce();
          view.press("return");
          await rendered.renderOnce();
        } finally {
          rendered.renderer.destroy();
        }
      }
    }
  } finally {
    mounted.dispose();
  }
});

test("first-run setup routes its primary action without giving Escape a quit route", async () => {
  const mounted = harness();
  const view = mountInteractiveView(mounted.commands, "setup.open");
  const rendered = await openRender(() => view.factory(view.host), { width: 100, height: 28 });
  await waitForFrame(rendered, "Set up Clarvis");

  view.press("return");
  expect(mounted.calls).toContain("view:setup.providers");
  view.press("escape");
  expect(mounted.calls).not.toContain("quit");

  rendered.renderer.destroy();
  view.controls.dispose();
  mounted.dispose();
});

test("startup recovery confirms and applies the exact corrupt-settings repair plan", async () => {
  let corrupt: string | null = "unknown key: stale";
  let applied = 0;
  const settings: SettingsAdapter = {
    ...fakeSettings(),
    read: (scope) => (scope === "global" ? ({} as never) : undefined),
    corrupt: (scope) => (scope === "global" ? corrupt : null),
    planRepair: () => ({
      scope: "global",
      path: "/tmp/clarvis-test/settings.json",
      revision: "repair-revision",
      action: "strip",
      dropped: ["stale"],
    }),
    applyRepair: async () => {
      applied++;
      corrupt = null;
    },
  };
  const mounted = harness({ settings });
  const view = mountInteractiveView(mounted.commands, "recovery.open");
  const rendered = await openRender(() => view.factory(view.host), { width: 100, height: 28 });
  expect(await waitForFrame(rendered, "config: unknown key: stale")).toContain(
    "config: unknown key: stale",
  );

  view.press("return");
  await waitUntil(() => view.host.pendingConfirm() !== null);
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("strip invalid keys from global settings.json?");
  expect(applied).toBe(0);

  view.press("y");
  await waitUntil(() => applied === 1);
  await rendered.renderOnce();
  expect(applied).toBe(1);
  expect(mounted.calls).toContain("notify:settings repaired — dropped stale");
  expect(mounted.calls).toContain("view:setup.open");

  rendered.renderer.destroy();
  view.controls.dispose();
  mounted.dispose();
});

test("startup recovery names an unparsable settings reset before applying it", async () => {
  let applied = 0;
  const settings: SettingsAdapter = {
    ...fakeSettings(),
    read: (scope) => (scope === "global" ? ({} as never) : undefined),
    corrupt: (scope) => (scope === "global" ? "invalid JSON" : null),
    planRepair: () => ({
      scope: "global",
      path: "/tmp/clarvis-test/settings.json",
      revision: "reset-revision",
      action: "reset",
      reason: "invalid JSON",
    }),
    applyRepair: async () => {
      applied++;
    },
  };
  const mounted = harness({ settings });
  const view = mountInteractiveView(mounted.commands, "recovery.open");
  const rendered = await openRender(() => view.factory(view.host), { width: 100, height: 28 });
  await waitForFrame(rendered, "config: invalid JSON");

  view.press("return");
  await waitUntil(() => view.host.pendingConfirm() !== null);
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("reset global settings.json to {}?");
  expect(rendered.captureCharFrame()).toContain("invalid JSON");
  view.press("y");
  await waitUntil(() => applied === 1);
  expect(mounted.calls).toContain(
    "notify:settings reset — /tmp/clarvis-test/settings.json is now {}",
  );

  rendered.renderer.destroy();
  view.controls.dispose();
  mounted.dispose();
});

test("startup recovery rechecks when the corrupt-settings repair is already obsolete", async () => {
  const settings: SettingsAdapter = {
    ...fakeSettings(),
    read: (scope) => (scope === "global" ? ({} as never) : undefined),
    corrupt: (scope) => (scope === "global" ? "stale diagnostic" : null),
    planRepair: () => null,
  };
  const mounted = harness({ settings });
  const view = mountInteractiveView(mounted.commands, "recovery.open");
  const rendered = await openRender(() => view.factory(view.host), { width: 100, height: 28 });
  await waitForFrame(rendered, "config: stale diagnostic");

  view.press("return");
  await waitUntil(() => mounted.calls.includes("notify:settings are valid — nothing to repair"));
  expect(view.host.pendingConfirm()).toBeNull();

  rendered.renderer.destroy();
  view.controls.dispose();
  mounted.dispose();
});

/**
 * `/settings providers` and friends are deep links: the hub router picks the
 * child view and hands it a scope. That scope used to be decided by whether
 * `<ws>/.clarvis` existed on disk, which is a different question and almost
 * always true — `ensureWorkspaceDir` creates the directory on the first write
 * of a plan, a memory file or the prompt history. So the panel opened on a
 * workspace scope with no `settings.json` and listed nothing, while reaching
 * the same panel through the `/settings` menu worked, because the hub forwards
 * `host.scope()` instead. The router must key on the settings, not the folder.
 */
test("a deep-linked config view opens on global when the workspace has no settings", () => {
  // A workspace whose `.clarvis` directory exists — the state every workspace
  // Clarvis has ever run in reaches — but which carries no settings file. The
  // old predicate returned "workspace" here purely because the folder was there.
  const root = mkdtempSync(join(tmpdir(), "clarvis-scope-"));
  mkdirSync(join(root, ".clarvis"), { recursive: true });
  const { commands, opened, dispose } = harness({
    dirs: { global: globalPaths("/nonexistent/global"), workspace: workspacePaths(root) },
    settings: { ...fakeSettings(), read: () => undefined } satisfies SettingsAdapter,
  });
  expect(existsSync(workspacePaths(root).clarvisDir)).toBe(true);
  expect(commands.route("settings.open", "providers")).toBe(true);
  expect(opened.at(-1)).toEqual({
    name: "providers.open",
    scope: "global",
    parent: "settings.open",
  });
  dispose();
  rmSync(root, { recursive: true, force: true });
});

test("it still opens on the workspace when that scope really carries settings", () => {
  const { commands, opened, dispose } = harness({
    settings: {
      ...fakeSettings(),
      read: (scope: string) => (scope === "workspace" ? { providers: [] } : undefined),
    } satisfies SettingsAdapter,
  });
  expect(commands.route("settings.open", "providers")).toBe(true);
  expect(opened.at(-1)).toEqual({
    name: "providers.open",
    scope: "workspace",
    parent: "settings.open",
  });
  dispose();
});

test("the same router feeds /extensions, so its children get the corrected scope too", () => {
  const { commands, opened, dispose } = harness({
    settings: { ...fakeSettings(), read: () => undefined } satisfies SettingsAdapter,
  });
  expect(commands.route("extensions.open", "plugins")).toBe(true);
  expect(opened.at(-1)?.scope).toBe("global");
  dispose();
});
