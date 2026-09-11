import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  createCommands,
  type CommandEffects,
  type CommandUi,
  type Commands,
} from "../../src/keys/commands.ts";
import { registerCodeCommands, type CodeCommandDeps } from "../../src/app/command-composition.ts";
import { readEnvView } from "../../src/adapters/agent-files.ts";
import type { SettingsAdapter } from "../../src/adapters/settings.ts";
import type { CodeConfigStore } from "../../src/adapters/code-config.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { globalPaths } from "@clarvis/paths";
import { fakeDebugSession } from "../helpers/fake-debug-session.ts";

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

function harness(): {
  commands: Commands;
  calls: string[];
  wiring: ReturnType<typeof registerCodeCommands>;
  dispose: () => void;
} {
  const calls: string[] = [];
  const effects: CommandEffects = {
    clearSession: () => calls.push("clear"),
    status: () => calls.push("status"),
    exportSession: () => calls.push("export"),
  };
  const ui: CommandUi = {
    openView: (name) => calls.push("view:" + name),
    dismiss: () => calls.push("dismiss"),
    commandFailed: (name, e) =>
      calls.push(`failed:${name}:${e instanceof Error ? e.message : String(e)}`),
  };
  const commands = createCommands(fakeInteraction(), effects, ui);
  const settings = fakeSettings();
  const code = fakeCode();
  const notify = (message: string): void => {
    calls.push("notify:" + message);
  };
  const deps: CodeCommandDeps = {
    commands,
    ui,
    effects: {
      openAgentPicker: () => calls.push("agent-picker"),
      openIsolationPicker: () => calls.push("isolation-picker"),
      openReviewPicker: () => calls.push("review-picker"),
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
    notify,
    debugSession: fakeDebugSession(),
    settings,
    dirs: { global: globalPaths("/nonexistent/global") },
    catalog: null,
    refreshModels: async () => ({ providers: 0, models: 0 }),
    refreshAgentProfiles: async () => {},
    keys: {} as never,
    reconnectBackend: async () => ({ ok: true, message: "ok" }),
    env: readEnvView(),
    preview: {} as never,
    platform: {} as never,
    agents: { active: () => "", view: () => undefined, list: () => [] } as never,
    agentFiles: { list: () => [], conflicts: () => [] } as never,
    plugins: {} as never,
    extensionProfiles: {} as never,
    skills: { list: async () => [], getPrompt: async () => [] },
    code,
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
        throw new Error("not implemented in composition test");
      },
    },
    guard: {
      mode: () => "off",
      setMode: () => {},
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
    features: {
      settings,
      catalog: null,
      keys: {} as never,
      code,
      agents: { list: () => [], conflicts: () => [] } as never,
      env: readEnvView(),
      notify,
    },
  };
  let wiring!: ReturnType<typeof registerCodeCommands>;
  const disposeRoot = createRoot((disposeRoot) => {
    wiring = registerCodeCommands(deps);
    return disposeRoot;
  });
  const dispose = (): void => {
    wiring.dispose();
    commands.dispose();
    disposeRoot();
  };
  return { commands, calls, wiring, dispose };
}

const VIEW_CONTRACT = [
  ["providers.open", "Providers", "internal", "settings"],
  ["agents.open", "Agents", "internal", "settings"],
  ["sessions.open", "Sessions", "slash", "sessions"],
  ["storage.open", "Storage", "slash", undefined],
  ["tasks.open", "Tasks", "slash", undefined],
  ["workflows.open", "Workflows", "slash", undefined],
  ["controls.open", "Run controls", "internal", "settings"],
  ["defaults.open", "Defaults", "internal", "settings"],
  ["model.open", "Default model", "slash", undefined],
  ["effort.open", "Default effort", "slash", undefined],
  ["capability-providers.open", "Feature backends", "internal", "settings"],
  ["marketplace.open", "Marketplace", "internal", "extensions"],
  ["memory.config", "Memory settings", "internal", "settings"],
  ["sandbox.config", "Sandbox", "internal", "settings"],
  ["isolation.config", "Isolation", "internal", "settings"],
  ["theme.open", "Theme", "internal", "settings"],
  ["settings.open", "Settings", "slash", undefined],
  ["doctor.open", "Doctor", "slash", "inspect"],
  ["mcp.browse", "MCP", "internal", "extensions"],
  ["extensions.open", "Extensions", "slash", undefined],
] as const;

test("every routed view has canonical metadata and one registered factory", () => {
  const { commands, dispose } = harness();
  const byName = new Map(commands.entries().map((e) => [e.name, e]));
  for (const [name, title, surface, parent] of VIEW_CONTRACT) {
    expect(byName.get(name)).toMatchObject({ title, surface, ...(parent ? { parent } : {}) });
    expect(typeof commands.viewFactory(name)).toBe("function");
  }
  dispose();
});

test("registerCodeCommands returns the app command wiring (doctorDirty/recheck/skillAgent)", () => {
  const { wiring, dispose } = harness();
  expect(typeof wiring.recheck).toBe("function");
  expect(typeof wiring.skillAgent).toBe("function");
  expect(wiring.doctorDirty()).toBe(true);
  dispose();
});

test("the composition disposer unregisters feature, app, and dynamic command owners", () => {
  const { commands, wiring, dispose } = harness();
  expect(commands.viewFactory("providers.open")).toBeDefined();
  expect(commands.viewFactory("settings.open")).toBeDefined();

  wiring.dispose();

  expect(commands.viewFactory("providers.open")).toBeUndefined();
  expect(commands.viewFactory("settings.open")).toBeUndefined();
  expect(
    commands
      .entries()
      .map((entry) => entry.name)
      .sort(),
  ).toEqual(["app.clear", "session.export", "status.show"].sort());
  dispose();
});
