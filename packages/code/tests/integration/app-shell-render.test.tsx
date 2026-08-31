import { expect, test } from "bun:test";
import type { Accessor, JSX } from "solid-js";
import { createSignal } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { openRender } from "../helpers/tracked-render.ts";
import { KeyEvent } from "@opentui/core";
import type {
  MemoryService,
  ModelCatalog,
  PluginService,
  ResolvedEnvironment,
  RunDetail,
  WorkflowsService,
} from "@clarvis/protocol";
import { App, type AppBackend, type AppFleet, type AppProps } from "../../src/views/App.tsx";
import { createTranscriptStore } from "../../src/adapters/store.ts";
import { createActivityStore } from "../../src/adapters/activity-store.ts";
import { createPromptHistory } from "../../src/core/prompt-history.ts";
import { createGuardModeStore } from "../../src/adapters/guard-mode.ts";
import type { GuardConfig } from "@clarvis/kernel/policy";
import { fakeDebugSession } from "../helpers/fake-debug-session.ts";
import { createMemoryModeStore } from "../../src/adapters/memory-mode.ts";
import type { Platform } from "../../src/adapters/platform.ts";
import type { SettingsAdapter } from "../../src/adapters/settings.ts";
import type { ActiveAgentStore } from "../../src/adapters/active-agent.ts";
import type { AgentProfileView } from "../../src/adapters/agents.ts";
import type { ConnectionState } from "../../src/adapters/connection-state.ts";
import type { BackendProbe } from "../../src/onboarding/doctor.ts";
import type { ElicitRequestParams } from "../../src/adapters/elicit-types.ts";
import { TOKEN_ORDER } from "../../src/theme/model.ts";
import { SUBAGENT_ORDER } from "../../src/theme/tokens.ts";
import type { RunEvent } from "@clarvis/protocol";
import { applyRunEvents, runEvent } from "../helpers/run-events.ts";
import { captureUntil } from "../helpers/render-support.ts";
import { keyboardEnvironmentId } from "../../src/keys/keyboard-profile.ts";
import { createModelsCatalog } from "../../src/adapters/models-catalog.ts";
import type { WorkflowActivity } from "../../src/adapters/workflow-projection.ts";

const ev = runEvent;

function press(
  t: Awaited<ReturnType<typeof openRender>>,
  name: string,
  mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
): void {
  t.renderer.keyInput.emit(
    "keypress",
    new KeyEvent({
      name,
      ctrl: mods.ctrl ?? false,
      meta: mods.meta ?? false,
      shift: mods.shift ?? false,
      option: false,
      sequence: name,
      number: false,
      raw: name,
      eventType: "press",
      source: "raw",
    }),
  );
}

async function clickText(
  t: Awaited<ReturnType<typeof openRender>>,
  frame: string,
  needle: string,
): Promise<void> {
  const hit = frame
    .split("\n")
    .map((row, y) => ({ y, x: row.indexOf(needle) }))
    .find((candidate) => candidate.x >= 0);
  expect(hit).toBeDefined();
  await t.mockMouse.click(hit!.x + Math.min(2, needle.length - 1), hit!.y);
}

async function clickLastText(
  t: Awaited<ReturnType<typeof openRender>>,
  frame: string,
  needle: string,
): Promise<void> {
  const hit = frame
    .split("\n")
    .map((row, y) => ({ y, x: row.lastIndexOf(needle) }))
    .filter((candidate) => candidate.x >= 0)
    .sort((left, right) => right.x - left.x)[0];
  expect(hit).toBeDefined();
  await t.mockMouse.click(hit!.x + Math.min(2, needle.length - 1), hit!.y);
}

function fakePlatform(over: Partial<Platform> = {}): Platform {
  return {
    capabilities: {
      revision: () => 0,
      keyboard: () => "kitty",
      remote: () => false,
      runtimePlatform: () => "linux",
      terminal: () => ({ name: "test-kitty" }),
      mouse: () => false,
      clipboard: { osc52: () => true },
      multiplexer: () => "none",
      plain: () => false,
      themeBg: () => "dark",
      colorDepth: () => "truecolor",
    },
    onShutdown: () => () => {},
    shutdown: (() => {}) as never,
    suspend: () => {},
    resume: () => {},
    copyText: () => Promise.resolve(true),
    readClipboardImage: () => Promise.resolve(null),
    ...over,
  } as unknown as Platform;
}

interface SettingsKnobs {
  defaultModel?: string;
  providersValid?: boolean;
  guard?: GuardConfig;
  memoryEnabled?: boolean;
  memoryModel?: string;
  /** Drop the `memory:` block entirely — the pre-seed state, which also makes
   * mounting fire the one-time seed notification. */
  memoryUnconfigured?: boolean;
  providers?: unknown[];
  sandbox?: Record<string, unknown>;
  plans?: Record<string, unknown>;
  workspaceTrust?: "inert" | "trusted" | "unapproved" | "changed";
  withheldWorkspaceFields?: readonly string[];
  setWorkspaceTrust?: (approve: boolean) => Promise<void>;
}

const HEALTHY_PROVIDERS = [{ name: "acme", models: {} }];
const HEALTHY_DEFAULT_MODEL = "acme/model-x";

function fakeSettings(knobs: Accessor<SettingsKnobs>): SettingsAdapter {
  const effective = () => {
    const k = knobs();
    return {
      providers: k.providers ?? HEALTHY_PROVIDERS,
      default_model: "defaultModel" in k ? k.defaultModel : HEALTHY_DEFAULT_MODEL,
      // A host past first boot: the allow list, plans and memory have all been
      // seeded, so mounting the shell does not fire a one-time seed
      // notification into the footer these cases are asserting on.
      guard: k.guard ?? { type: "shell", allowed_commands: ["git status"] },
      memory: k.memoryUnconfigured
        ? undefined
        : {
            enabled: k.memoryEnabled ?? true,
            ...(k.memoryModel !== undefined ? { model: k.memoryModel } : {}),
          },
      sandbox: k.sandbox,
      plans: k.plans ?? { mode: "on", retention: "keep" },
    };
  };
  return {
    version: () => 0,
    read: () => effective(),
    corrupt: () => null,
    planRepair: () => null,
    applyRepair: async () => {},
    effective,
    origin: () => undefined,
    effectiveProviders: () => [],
    knownGrants: () => undefined,
    withheldWorkspaceFields: () => knobs().withheldWorkspaceFields ?? [],
    workspaceTrust: () => knobs().workspaceTrust ?? "inert",
    setWorkspaceTrust: (approve: boolean) =>
      knobs().setWorkspaceTrust?.(approve) ?? Promise.resolve(),
    sources: () => ({ global: "/nonexistent/global" }),
    write: async () => {},
    validateProviders: () => ({ ok: knobs().providersValid ?? true }),
    refs: () => ({ agents: [], defaultModel: false }),
    modelRefs: () => ({ agents: [], defaultModel: false }),
    envStatus: () => "unset",
    declaredMcpServers: () => [],
    reload: async () => {},
    inspectSandbox: () => Promise.resolve(null as never),
  } as unknown as SettingsAdapter;
}

function fakeAgents(over: {
  view?: Accessor<AgentProfileView | undefined>;
  active?: Accessor<string>;
  list?: Accessor<AgentProfileView[]>;
  setActive?: (name: string) => void;
  setDefault?: (name: string, scope: "global" | "workspace") => void;
  isRunnable?: (name: string) => boolean;
}): ActiveAgentStore {
  return {
    active: over.active ?? (() => "coder"),
    view: over.view ?? (() => undefined),
    shape: () => ({ isLead: false, askUserGranted: "unknown", softMode: false }),
    list: over.list ?? (() => []),
    resolveActive: () => (over.active ?? (() => "coder"))(),
    setActive: over.setActive ?? (() => {}),
    setDefault: over.setDefault ?? (() => {}),
    isRunnable: over.isRunnable ?? (() => true),
  } as unknown as ActiveAgentStore;
}

function baseFleet(
  settings: SettingsAdapter,
  agents: ActiveAgentStore,
  codeOverride?: AppFleet["code"],
  catalogOverride?: AppFleet["catalog"],
): AppFleet {
  return {
    agents,
    agentFiles: {
      list: () => [{ name: "coder", scope: "global", frontmatter: {}, body: "" }],
      conflicts: () => [],
      reload: async () => {},
    } as never,
    settings,
    dirs: { global: "/nonexistent/global" },
    code:
      codeOverride ??
      ({
        read: () => ({}),
        agentDefault: () => undefined,
        clearAgentDefault: () => {},
        guardModeDefault: () => undefined,
        effectiveTheme: () => ({}) as never,
        asciiEnabled: () => false,
        keySources: () => ({}),
        keySource: () => "auto",
        writeKeySource: () => {},
      } as never),
    guard: createGuardModeStore({
      code: {
        guardModeDefault: () => undefined,
      },
      settingsGuard: () => settings.effective().guard as GuardConfig | undefined,
    }),
    memoryMode: createMemoryModeStore({
      settingsMemory: () => settings.effective().memory,
    }),
    preview: {
      source: () => ({}),
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
    keys: { has: () => false, set: async () => {}, reload: async () => {} },
    catalog: catalogOverride ?? null,
    refreshModels: async () => ({ providers: 0, models: 0 }),
    refreshAgentProfiles: async () => {},
  } as unknown as AppFleet;
}

function baseBackend(over: Partial<AppBackend> = {}): AppBackend {
  const [connection] = createSignal<ConnectionState>({ phase: "ready" });
  const [probe] = createSignal<BackendProbe>({ status: "reachable", profileCount: 1 });
  return {
    connection,
    probe,
    client: {
      listTools: async () => [],
      listPrompts: async () => [],
      getPrompt: async () => [],
      connectionStatus: () => "unavailable",
    },
    memory: {} as unknown as MemoryService,
    plans: {
      read: async () => null,
    } as unknown as AppBackend["plans"],
    workflows: {
      list: async () => [],
      get: async () => null,
      delete: async () => {},
    } as unknown as WorkflowsService,
    getRun: async (): Promise<RunDetail | null> => null,
    plugins: { list: () => [], install: async () => {} } as unknown as PluginService,
    skills: { list: async () => [], getPrompt: async () => [] },
    tasks: { available: () => false } as never,
    workspaceId: () => "ws_current",
    reconnect: async () => ({ ok: true, message: "ok" }),
    ...over,
  } as AppBackend;
}

function Host(props: {
  build: (renderer: ReturnType<typeof useRenderer>) => AppProps;
}): JSX.Element {
  const renderer = useRenderer();
  const appProps = props.build(renderer);
  return <App {...appProps} />;
}

async function mountApp(
  build: (renderer: ReturnType<typeof useRenderer>) => AppProps,
  size: { width: number; height: number } = { width: 140, height: 40 },
): Promise<Awaited<ReturnType<typeof openRender>>> {
  const t = await openRender((() => <Host build={build} />) as never, size);
  for (let i = 0; i < 3; i++) await t.renderOnce();
  return t;
}

function defaultProps(overrides: {
  settingsKnobs?: Accessor<SettingsKnobs>;
  agents?: ActiveAgentStore;
  backend?: AppBackend;
  quitCalls?: number[];
  active?: Accessor<boolean>;
  cancel?: () => boolean;
  status?: Accessor<string>;
  elicit?: Accessor<ElicitRequestParams | null>;
  switching?: Accessor<boolean>;
  seedStream?: RunEvent[];
  code?: AppFleet["code"];
  catalog?: AppFleet["catalog"];
  clear?: () => void;
  costLine?: () => string;
  sessionUsage?: () => { input: number; output: number; cached?: number } | null;
  initialDraft?: string;
  worktree?: AppProps["shell"]["worktree"];
  submit?: AppProps["run"]["submit"];
  submitPrompt?: AppProps["run"]["submitPrompt"];
  submitSkillRun?: AppProps["run"]["submitSkillRun"];
  store?: ReturnType<typeof createTranscriptStore>;
  activity?: ReturnType<typeof createActivityStore>;
  workflowActivity?: AppProps["run"]["workflowActivity"];
}) {
  return (renderer: ReturnType<typeof useRenderer>): AppProps => {
    const store = overrides.store ?? createTranscriptStore();
    const activity = overrides.activity ?? createActivityStore();
    if (overrides.seedStream) {
      const sink = store.openRun("exec_1");
      const asink = activity.openRun();
      applyRunEvents(sink, overrides.seedStream, "live");
      applyRunEvents(asink, overrides.seedStream, "live");
    }
    const knobs = overrides.settingsKnobs ?? (() => ({}));
    const settings = fakeSettings(knobs);
    const agents = overrides.agents ?? fakeAgents({});
    const quitCalls = overrides.quitCalls ?? [];
    return {
      store,
      activity,
      shell: {
        renderer,
        platform: fakePlatform(),
        debugSession: fakeDebugSession(),
        workspace: "/home/user/project",
        files: () => ["README.md", "src/index.ts"],
        ...(overrides.worktree ? { worktree: overrides.worktree } : {}),
        quit: () => {
          quitCalls.push(1);
        },
      },
      run: {
        status: overrides.status ?? (() => ""),
        submit: overrides.submit ?? (() => {}),
        submitPrompt: overrides.submitPrompt ?? (() => {}),
        submitSkillRun: overrides.submitSkillRun ?? (() => {}),
        compact: () => {},
        cancel: overrides.cancel ?? (() => false),
        active: overrides.active ?? (() => false),
        startedAt: () => (overrides.active?.() ? Date.now() - 5000 : null),
        workflowActivity: overrides.workflowActivity ?? (() => null),
        bang: () => true,
        localBusy: () => false,
        registerDraftRestore: () => {},
        elicit: overrides.elicit ?? (() => null),
        resolveElicit: () => {},
        switching: overrides.switching,
      },
      session: {
        history: createPromptHistory(200, null),
        list: () => [],
        resume: () => {},
        delete: async () => {},
        clear: overrides.clear ?? (() => {}),
        export: async () => "exported",
        statusLine: () => "status line",
        costLine: overrides.costLine ?? (() => ""),
        usage: overrides.sessionUsage ?? (() => null),
      },
      fleet: baseFleet(settings, agents, overrides.code, overrides.catalog),
      backend: overrides.backend ?? baseBackend(),
      ...(overrides.initialDraft === undefined ? {} : { initialDraft: overrides.initialDraft }),
    };
  };
}

function leadTurn(iteration: number, response: string, at: number): RunEvent[] {
  return [
    ev({ type: "iteration_started", agent: "lead", iteration, at, model: "m" }),
    ev({
      type: "iteration_completed",
      agent: "lead",
      iteration,
      at: at + 1,
      model: "m",
      response,
      response_phase: "commentary",
      input_tokens: 10,
      output_tokens: 4,
    }),
  ];
}

async function moveReaderAwayFromTail(t: Awaited<ReturnType<typeof openRender>>): Promise<void> {
  for (let pass = 0; pass < 600; pass += 1) {
    press(t, "pageup");
    await t.renderOnce();
    if (t.renderer.root.findDescendantById("history-newer-indicator") !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`reader never left the tail:\n${t.captureCharFrame()}`);
}

test("the complete composer adopts the draft typed during startup", async () => {
  const t = await mountApp(defaultProps({ initialDraft: "draft from startup" }));
  expect(await captureUntil(t, "draft from startup")).toContain("draft from startup");
  t.renderer.destroy();
});

const CHANGED_WORKSPACE_ENVIRONMENT: ResolvedEnvironment = {
  id: "workspace:project",
  ref: { scope: "workspace", name: "project" },
  immutable: false,
  status: "degraded",
  fingerprint: `sha256:${"c".repeat(64)}`,
  selection_origin: "workspace",
  plugins: [
    {
      ref: { scope: "workspace", source: "agents", name: "context7" },
      active: false,
      installed: true,
      valid: true,
      agents: [],
      skills: ["docs"],
      mcp_servers: ["context7:docs"],
      hooks: { total: 1 },
      capability_executables: [],
    },
  ],
  standalone_skills: [],
  issues: [{ code: "workspace_untrusted", message: "workspace changed" }],
  counts: {
    plugins_active: 0,
    standalone_skills_active: 0,
    plugin_skills_active: 0,
    mcp_servers_active: 0,
    hooks_declared: 0,
  },
};

test("a changed executable workspace opens the approval question before the shell", async () => {
  let approvals = 0;
  const settingsKnobs = () => ({
    workspaceTrust: "changed" as const,
    withheldWorkspaceFields: ["mcpServers", "hooks"],
    setWorkspaceTrust: async (approve: boolean) => {
      if (approve) approvals += 1;
    },
  });
  const t = await mountApp(
    defaultProps({
      settingsKnobs,
      backend: baseBackend({
        environments: {
          current: async () => CHANGED_WORKSPACE_ENVIRONMENT,
        } as AppBackend["environments"],
      }),
    }),
  );
  const approval = await captureUntil(t, "This workspace's executable snapshot changed.");
  expect(approval).toContain("MCP servers");
  expect(approval).toContain("[n] no, review and remove");
  expect(approvals).toBe(0);
  press(t, "return");
  for (let index = 0; index < 20 && approvals === 0; index += 1) await t.renderOnce();
  expect(approvals).toBe(1);
  t.renderer.destroy();
});

test("default wide layout: header, derived navigation and input dock are live", async () => {
  const t = await mountApp(defaultProps({}));
  const out = await captureUntil(t, "coder");
  expect(out).toContain("New task");
  // Advertised at idle because Ctrl+C owns both run cancellation and quitting.
  expect(out).toContain("[^c] cancel / quit");
  expect(out).toContain("[↵] send / steer");
  expect(out).not.toContain("open plan");
  t.renderer.destroy();
});

test("autocomplete replaces the Lead activity row instead of stacking ready or working above it", async () => {
  for (const [active, activityText] of [
    [false, "ready"],
    [true, "working"],
  ] as const) {
    const t = await mountApp(defaultProps({ active: () => active }));
    expect(await captureUntil(t, activityText)).toContain(activityText);
    await t.mockInput.typeText("/");
    await captureUntil(t, "/clear");
    await t.renderOnce();
    const open = t.captureCharFrame();
    expect(open).not.toMatch(new RegExp(`(?:^|\\s)${activityText}(?:\\s|$)`));
    expect(t.renderer.root.findDescendantById("lead-activity-line")).toBeUndefined();
    t.renderer.destroy();
  }
});

test("a completed Plan never contributes a task counter to the compact footer", async () => {
  const tasks: Extract<RunEvent, { type: "plan_created" }>["tasks"] = Array.from(
    { length: 5 },
    (_, index) => ({
      id: `done-${index + 1}`,
      title: `Done ${index + 1}`,
      status: "done",
    }),
  );
  const stream: RunEvent[] = [
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "plan_created",
      at: 2,
      id: "finished-plan",
      path: ".clarvis/plans/finished.md",
      title: "Finished plan",
      status: "active",
      retention: "keep",
      revision: 1,
      spec_revision: 1,
      tasks,
    }),
    ev({
      type: "plan_updated",
      change: "status",
      at: 3,
      id: "finished-plan",
      path: ".clarvis/plans/finished.md",
      title: "Finished plan",
      status: "completed",
      retention: "keep",
      revision: 2,
      spec_revision: 1,
      tasks,
    }),
    ev({ type: "run_ended", at: 4, status: "completed", reason: "completed" }),
  ];
  const t = await mountApp(defaultProps({ seedStream: stream, status: () => "Completed" }), {
    width: 80,
    height: 24,
  });
  const closed = await captureUntil(t, "Completed");
  expect(closed).not.toMatch(/Plan \d+\/\d+/);
  t.renderer.destroy();
});

test("the full task editor keeps the action footer on a stable row", async () => {
  const t = await mountApp(defaultProps({}), { width: 140, height: 45 });
  const collapsed = t.captureCharFrame();
  expect(collapsed).toContain("expand editor");
  const collapsedFooter = collapsed
    .split("\n")
    .findIndex((line) => line.includes("[↵] send / steer"));

  t.mockInput.pressKey("g", { ctrl: true });
  const expanded = await captureUntil(t, "collapse editor");
  const expandedFooter = expanded
    .split("\n")
    .findIndex((line) => line.includes("[↵] send / steer"));
  expect(expanded).toContain("Task editor");
  expect(expandedFooter).toBe(collapsedFooter);
  t.renderer.destroy();
});

test("/clear clears the current session", async () => {
  const clears: number[] = [];
  const t = await mountApp(defaultProps({ clear: () => clears.push(1) }));
  await t.mockInput.typeText("/clear");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  await captureUntil(t, "started a new session");
  expect(clears).toEqual([1]);
  t.renderer.destroy();
});

test("a documented slash token wins over a loose fuzzy match on another command", async () => {
  // `/mcp` is hidden from the browse list (its parent is a hub), and `mcp` is a
  // subsequence of `compact` — so typing the documented command staged the
  // destructive one instead, and one more Enter compacted the run's context.
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/mcp");
  const out = await captureUntil(t, "/mcp");
  const popup = out.split("\n").filter((row) => row.includes("/mcp") || row.includes("/compact"));
  expect(popup.some((row) => row.includes("/mcp"))).toBe(true);
  expect(popup[0]).not.toContain("/compact");
  t.renderer.destroy();
});

test("/compact remains discoverable while no run is active", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/comp");
  const out = await captureUntil(t, "/compact");
  expect(out).toContain("/compact");
  expect(out).toContain("Compact context");
  t.renderer.destroy();
});

test("the floor screen states the minimum size without mounting partial controls", async () => {
  const t = await mountApp(defaultProps({}), { width: 20, height: 8 });
  const floor = await captureUntil(t, "terminal too small");
  expect(floor).toContain("needs 24x6");
  expect(floor).not.toContain("New task");
  t.renderer.destroy();
});

test("first boot explains the guided provider picker before saving anything", async () => {
  const catalog = createModelsCatalog({
    source: "bundle",
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        kind: "anthropic",
        api_key_env: "ANTHROPIC_API_KEY",
        needs_base_url: false,
        models: [{ id: "claude", context_window: 200000 }],
      },
    ],
  } satisfies ModelCatalog);
  const settingsKnobs = () => ({ providers: [], defaultModel: undefined });
  const t = await mountApp(defaultProps({ settingsKnobs, catalog }));

  let frame = await captureUntil(t, "Connect a provider and choose a model.");
  expect(frame).toContain("Set up Clarvis");
  expect(frame).toContain("begin setup");
  expect(frame).not.toContain("Doctor needs attention");
  t.mockInput.pressEnter();
  frame = await captureUntil(t, "Step 1 of 2");
  expect(frame).toContain("anthropic");
  expect(t.renderer.listenerCount("resize")).toBeLessThanOrEqual(t.renderer.getMaxListeners());
  press(t, "down");
  press(t, "down");
  press(t, "return");
  frame = await captureUntil(t, "Step 2 of 2");
  expect(frame).toContain("claude");
  t.renderer.destroy();
});

test("rapid /help and Enter open Help and return to the same shell", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/");
  await t.renderOnce();
  void t.mockInput.typeText("help");
  t.mockInput.pressEnter();
  const help = await captureUntil(t, "Go to");
  expect(help).toContain("Help");
  expect(help).toContain("Available here");
  expect(help).toContain("Go to");
  expect(help).not.toContain("[f1]");
  press(t, "escape");
  expect(await captureUntil(t, "New task")).not.toContain("Keyboard environment");
  t.renderer.destroy();
});

test("a child name anywhere in a hierarchical route is discoverable from the slash popup", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/provider");
  const suggestions = await captureUntil(t, "/settings/providers");
  expect(suggestions).toContain("/settings/providers");
  t.renderer.destroy();
});

test("Extensions exposes only the wizard slash command, never hidden child deep links", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/extensions/marketplace");
  const out = await captureUntil(t, "no match");
  expect(out).not.toContain("Browse and install extensions");
  t.renderer.destroy();
});

test("Enter runs an exact hierarchical hub while Tab still owns child completion", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/settings");
  await t.renderOnce();
  press(t, "return");
  const settings = await captureUntil(t, "[↵] open");
  expect(settings).toContain("Settings");
  expect(settings).toContain("Providers");
  t.renderer.destroy();
});

test("Tab opens a child and rapid Escape steps back through its hub to the transcript", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/settings");
  await t.renderOnce();
  press(t, "tab");
  const children = await captureUntil(t, "/settings/providers");
  expect(children).toContain("/settings/providers");
  press(t, "tab");
  await t.renderOnce();
  press(t, "return");
  const providers = await captureUntil(t, "Credentials");
  expect(providers).toContain("Credentials");

  press(t, "escape");
  const settings = await captureUntil(t, "Run controls");
  expect(settings).toContain("Settings");

  press(t, "escape");
  await t.renderOnce();
  await t.renderOnce();
  const transcript = t.captureCharFrame();
  expect(transcript).not.toContain("Settings");
  t.renderer.destroy();
});

test("a saved manual destination binding is active on first boot", async () => {
  const environmentId = keyboardEnvironmentId({
    remote: false,
    runtimePlatform: "linux",
    terminal: { name: "test-kitty" },
    kittyKeyboard: true,
    multiplexer: "none",
    host: {
      platform: "linux",
      primaryModifier: "ctrl",
      modifiers: {
        ctrl: "supported",
        shift: "supported",
        meta: "supported",
        super: "unknown",
        hyper: "unknown",
      },
    },
  });
  const code = {
    agentDefault: () => undefined,
    guardModeDefault: () => undefined,
    effectiveTheme: () => ({}) as never,
    asciiEnabled: () => false,
    keyboardConfig: () => ({
      version: 1 as const,
      environments: {
        [environmentId]: {
          profile: "manual" as const,
          bindings: { "settings.open": ["f8"] },
        },
      },
    }),
    writeKeyboardEnvironment: () => {},
  } as unknown as AppFleet["code"];
  const t = await mountApp(defaultProps({ code }));
  await captureUntil(t, "New task");
  press(t, "f8");
  const settings = await captureUntil(t, "Run controls");
  expect(settings).toContain("Settings");
  t.renderer.destroy();
});

test("Keyboard settings persists a profile and a normalized diagnostic for this environment", async () => {
  const [keyboard, setKeyboard] = createSignal<ReturnType<AppFleet["code"]["keyboardConfig"]>>({
    version: 1,
    environments: {},
  });
  const writes: { id: string; value: unknown }[] = [];
  const code = {
    agentDefault: () => undefined,
    guardModeDefault: () => undefined,
    effectiveTheme: () => ({}) as never,
    asciiEnabled: () => false,
    keyboardConfig: keyboard,
    writeKeyboardEnvironment: (
      id: string,
      value: ReturnType<AppFleet["code"]["keyboardConfig"]>["environments"][string] | undefined,
    ) => {
      writes.push({ id, value });
      setKeyboard((current) => {
        const environments = { ...current.environments };
        if (value) environments[id] = value;
        else delete environments[id];
        return { version: 1, environments };
      });
    },
  } as unknown as AppFleet["code"];
  const t = await mountApp(defaultProps({ code }));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/settings");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  await captureUntil(t, "Run controls");
  for (let index = 0; index < 7; index++) press(t, "down");
  await t.renderOnce();
  press(t, "return");
  const keyboardView = await captureUntil(t, "Terminal: test-kitty");
  expect(keyboardView).toContain("Protocol: kitty");
  expect(keyboardView).toContain("Transport: local");
  expect(keyboardView).toContain("Multiplexer: none");

  press(t, "up");
  press(t, "return");
  await captureUntil(t, "keyboard profile: portable");
  expect(writes.at(-1)?.value).toMatchObject({ profile: "portable" });

  press(t, "d");
  await captureUntil(t, "Keyboard diagnostic");
  press(t, "f5");
  await captureUntil(t, "Received instead: f5");
  for (let index = 0; index < 4; index++) press(t, "u");
  await captureUntil(t, "Diagnostic complete");
  press(t, "s");
  await captureUntil(t, "keyboard diagnostic saved: portable");
  const final = writes.at(-1)!;
  expect(final.id).toMatch(/^[a-f0-9]{24}$/);
  expect(final.value).toEqual({
    profile: "portable",
    verdicts: {
      ctrl: "unsupported",
      meta: "unsupported",
      super: "unsupported",
      baseLayout: "unsupported",
    },
  });
  expect(JSON.stringify(final.value)).not.toContain("raw");
  t.renderer.destroy();
});

test("agentName falls back to 'no agent' when there is no active profile", async () => {
  const t = await mountApp(
    defaultProps({ agents: fakeAgents({ active: () => "", view: () => undefined }) }),
  );
  const out = await captureUntil(t, "no agent");
  expect(out).toContain("no agent");
  t.renderer.destroy();
});

test("no safe automatic entry agent keeps the agent picker modal until a choice is made", async () => {
  const agents = fakeAgents({
    active: () => "",
    view: () => undefined,
    list: () => [{ name: "runner", grants: [], canSpawn: [] }],
  });
  const t = await mountApp(defaultProps({ agents }));
  const out = await captureUntil(t, "Select agent");
  expect(out).toContain("runner");
  press(t, "escape");
  await t.renderOnce();
  const reopened = await captureUntil(t, "Select agent");
  expect(reopened).toContain("runner");
  t.renderer.destroy();
});

test("a terminal below the floor threshold shows 'terminal too small' instead of the normal shell", async () => {
  const t = await mountApp(defaultProps({}), { width: 15, height: 4 });
  const out = await captureUntil(t, "terminal too");
  expect(out).toContain("terminal too");
  t.renderer.destroy();
});

test("an active run seats its live metadata beside working and keeps the session footer stable", async () => {
  const activity = createActivityStore();
  applyRunEvents(
    activity.openRun(),
    [
      ev({ type: "run_started", at: 1 }),
      ev({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        at: 2,
        model: "m",
        input_tokens: 120_000,
        output_tokens: 12_000,
        cached_tokens: 100_000,
        response: "",
      }),
      ev({ type: "run_ended", status: "completed", at: 3, reason: "completed" }),
    ],
    "live",
  );
  const stream: RunEvent[] = [
    ev({ type: "run_started", at: 4 }),
    ev({
      type: "iteration_completed",
      agent: "lead",
      iteration: 1,
      at: 5,
      model: "m",
      input_tokens: 5_000,
      output_tokens: 100,
      response: "",
    }),
  ];
  const [active, setActive] = createSignal(true);
  const [status, setStatus] = createSignal("running iteration 9");
  const [sessionUsage, setSessionUsage] = createSignal({
    input: 120_000,
    output: 12_000,
    cached: 100_000,
  });
  const t = await mountApp(
    defaultProps({
      active,
      status,
      seedStream: stream,
      activity,
      sessionUsage,
    }),
    { width: 160, height: 40 },
  );
  const out = await captureUntil(t, "cancel");
  expect(out).toContain("steer");
  const activityRow = out.split("\n").find((row) => row.includes("working"));
  expect(activityRow).toMatch(/working · \d+s · iteration 9 · \^c to interrupt/);
  const footer = out.split("\n").find((row) => row.includes("Session  In"));
  expect(footer).toContain("Context ");
  expect(footer).toContain("Session  In 25k · Out 12k · Cache hit 80%");
  expect(footer).not.toContain("Running");
  expect(footer).not.toContain("iteration");

  setSessionUsage({ input: 125_000, output: 12_100, cached: 100_000 });
  setStatus("completed");
  setActive(false);
  const settled = await captureUntil(t, "Completed");
  const settledFooter = settled.split("\n").find((row) => row.includes("Session  In"));
  expect(settledFooter).toContain("Session  In 25k · Out 12k · Cache hit 80%");
  t.renderer.destroy();
});

test("an active session keeps a known zero cache hit visible across its live projection", async () => {
  const activity = createActivityStore();
  applyRunEvents(
    activity.openRun(),
    [
      ev({ type: "run_started", at: 1 }),
      ev({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        at: 2,
        model: "m",
        input_tokens: 16_000,
        output_tokens: 10,
        response: "",
      }),
      ev({ type: "run_ended", status: "completed", at: 3, reason: "completed" }),
    ],
    "live",
  );
  const [active, setActive] = createSignal(true);
  const [status, setStatus] = createSignal("running iteration 1");
  const t = await mountApp(
    defaultProps({
      active,
      status,
      activity,
      sessionUsage: () => ({ input: 16_000, output: 10, cached: 0 }),
    }),
    { width: 160, height: 40 },
  );
  let out = await captureUntil(t, "Cache hit 0%");
  expect(out).toContain("Session  In 16k · Out 10 · Cache hit 0%");

  setActive(false);
  setStatus("completed");
  out = await captureUntil(t, "Completed");
  expect(out).toContain("Session  In 16k · Out 10 · Cache hit 0%");
  t.renderer.destroy();
});

test("Lead thinking and working reuse one fixed line immediately above the composer", async () => {
  const [active, setActive] = createSignal(true);
  const store = createTranscriptStore();
  const sink = store.openRun("exec_activity_line");
  applyRunEvents(
    sink,
    [
      ev({ type: "run_started", at: 1 }),
      ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 2, model: "m" }),
    ],
    "live",
  );
  const t = await mountApp(defaultProps({ active, store }));
  const thinking = await captureUntil(t, "thinking");
  const line = t.renderer.root.findDescendantById("lead-activity-line");
  const input = t.renderer.root.findDescendantById("input-dock");
  const history = t.renderer.root.findDescendantById("committed-history");
  expect(line).toBeDefined();
  expect(input).toBeDefined();
  expect(line!.y + line!.height).toBe(input!.y);
  expect(history?.findDescendantById("lead-activity-line")).toBeUndefined();
  expect(thinking.match(/thinking/g)?.length).toBe(1);
  const fixedY = line!.y;

  applyRunEvents(
    sink,
    [
      ev({
        type: "text_delta",
        agent: "lead",
        iteration: 1,
        channel: "text",
        text: "VISIBLE LEAD ANSWER",
        at: 3,
        reset: true,
      }),
    ],
    "live",
  );
  const working = await captureUntil(t, "working");
  expect(working).toContain("VISIBLE LEAD ANSWER");
  expect(t.renderer.root.findDescendantById("lead-activity-line")).toBe(line);
  expect(line!.y).toBe(fixedY);

  applyRunEvents(
    sink,
    [
      ev({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        at: 4,
        model: "m",
        response: "VISIBLE LEAD ANSWER",
        input_tokens: 1,
        output_tokens: 1,
      }),
      ev({ type: "run_ended", status: "completed", at: 5, reason: "completed" }),
    ],
    "live",
  );
  setActive(false);
  await t.renderOnce();
  await t.renderOnce();
  const settledLine = t.captureCharFrame().split("\n")[fixedY] ?? "";
  expect(settledLine).toContain("ready");
  expect(settledLine).not.toContain("thinking");
  expect(t.renderer.root.findDescendantById("lead-activity-line")).toBe(line);
  expect(line!.y).toBe(fixedY);
  t.renderer.destroy();
});

test("footer status uses canonical terminal outcomes and hides generic internal strings", async () => {
  const [status, setStatus] = createSignal("");
  const t = await mountApp(defaultProps({ status }));
  await t.renderOnce();

  setStatus("model error: 503");
  let out = await captureUntil(t, "Failed");
  expect(out).not.toContain("model error: 503");

  setStatus("cancelled");
  out = await captureUntil(t, "Canceled");
  expect(out).not.toContain("cancelled");

  setStatus("completed");
  out = await captureUntil(t, "Completed");
  expect(out).toContain("Completed");

  setStatus("resumed from 3 turns");
  await t.renderOnce();
  out = t.captureCharFrame();
  expect(out).not.toContain("resumed from 3 turns");
  expect(out).not.toContain("Completed");

  setStatus("waiting on network");
  await t.renderOnce();
  out = t.captureCharFrame();
  expect(out).not.toContain("waiting on network");

  t.renderer.destroy();
});

test("the settled footer keeps cumulative session tokens and cost", async () => {
  const t = await mountApp(
    defaultProps({
      status: () => "completed",
      costLine: () => "$0.042",
      sessionUsage: () => ({ input: 120_000, output: 12_000, cached: 1_000 }),
    }),
    { width: 160, height: 40 },
  );
  const out = await captureUntil(t, "Session $0.042");
  expect(out).toContain("Completed");
  expect(out).toContain("$0.042");
  expect(out).toContain("Session  In 119k · Out 12k · Cache hit 1%");
  expect(out).not.toContain("12k→820 tok");
  t.renderer.destroy();
});

test("an in-flight elicitation replaces shell navigation with its real actions", async () => {
  const [elicit, setElicit] = createSignal<ElicitRequestParams | null>(null);
  const t = await mountApp(defaultProps({ elicit }));
  let out = await captureUntil(t, "New task");
  expect(out).toContain("New task");

  setElicit({ message: "allow this command?", kind: "guard_confirm" });
  await t.renderOnce();
  await t.renderOnce();
  out = t.captureCharFrame();
  expect(out).toContain("[↵] confirm");
  expect(out).toContain("[esc] cancel");
  expect(out).toContain("[^c] cancel / quit");
  expect(out).not.toContain("expand");

  t.renderer.destroy();
});

test("a workspace switch blocks shell interaction until it settles", async () => {
  const [switching, setSwitching] = createSignal(false);
  const t = await mountApp(defaultProps({ switching }));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("keep this draft");

  setSwitching(true);
  let out = await captureUntil(t, "switching workspace");
  expect(out).not.toContain("New task");
  press(t, "c", { ctrl: true });
  await t.renderOnce();

  setSwitching(false);
  out = await captureUntil(t, "keep this draft");
  expect(out).not.toContain("New task");
  t.renderer.destroy();
});

test("a workspace switch keeps the active view's Escape route live", async () => {
  const [switching, setSwitching] = createSignal(false);
  const t = await mountApp(defaultProps({ switching }));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/settings");
  await t.renderOnce();
  press(t, "return");
  await captureUntil(t, "Run controls");

  setSwitching(true);
  let out = await captureUntil(t, "switching workspace");
  expect(out).toContain("Settings");
  press(t, "escape");
  await t.renderOnce();
  out = t.captureCharFrame();
  expect(out).not.toContain("Settings");
  expect(out).toContain("switching workspace");

  setSwitching(false);
  await captureUntil(t, "New task");
  t.renderer.destroy();
});

test("a workspace switch blocks picker mouse actions", async () => {
  const [switching, setSwitching] = createSignal(false);
  const activated: string[] = [];
  const agents = fakeAgents({
    list: () => [
      { name: "coder", grants: [], canSpawn: [] },
      { name: "reviewer", grants: [], canSpawn: [] },
    ],
    setActive: (name) => activated.push(name),
  });
  const t = await mountApp(defaultProps({ agents, switching }));
  await captureUntil(t, "New task");
  press(t, "tab", { shift: true });
  await captureUntil(t, "Select agent");

  setSwitching(true);
  await t.renderOnce();
  await t.renderOnce();
  const blocked = t.captureCharFrame();
  const rows = blocked.split("\n");
  const y = rows.findIndex((row) => row.includes("reviewer"));
  const x = rows[y]!.indexOf("reviewer");
  await t.mockMouse.click(x, y);
  await t.renderOnce();
  expect(activated).toEqual([]);
  expect(t.captureCharFrame()).toContain("Select agent");

  setSwitching(false);
  await t.renderOnce();
  press(t, "escape");
  await captureUntil(t, "New task");
  t.renderer.destroy();
});

test("Alt+M no longer changes memory for the session", async () => {
  const knobs = () => ({ memoryEnabled: true });
  const build = defaultProps({ settingsKnobs: knobs });
  let memoryMode!: AppFleet["memoryMode"];
  const t = await mountApp((renderer) => {
    const props = build(renderer);
    memoryMode = props.fleet.memoryMode;
    return props;
  });
  await captureUntil(t, "New task");
  press(t, "m", { meta: true });
  await t.renderOnce();
  expect(memoryMode.mode()).toBe("on");
  expect(t.captureCharFrame()).not.toContain("memory: off (session)");
  t.renderer.destroy();
});

test("agent picker overlay opens on /agent and closes on escape", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/agent");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  const out = await captureUntil(t, "Select agent");
  expect(out).toContain("Select agent");
  press(t, "escape");
  const back = await captureUntil(t, "New task");
  expect(back).toContain("New task");
  t.renderer.destroy();
});

test("Ctrl+S opens the safety-preset picker and Escape returns to the composer", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");

  press(t, "s", { ctrl: true });
  const picker = await captureUntil(t, "Select safety preset");

  expect(picker).toContain("judged");
  expect(picker).toContain("LLM judge reviews risk");
  press(t, "escape");
  const back = await captureUntil(t, "New task");
  expect(back).not.toContain("Select safety preset");
  t.renderer.destroy();
});

test("a literal sharp s remains composer text instead of opening the safety picker", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");

  await t.mockInput.typeText("ß");
  const out = await captureUntil(t, "ß");

  expect(out).not.toContain("Select safety preset");
  t.renderer.destroy();
});

test("/diff with no diff in the transcript warns and does not open the viewer", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/diff");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  const out = await captureUntil(t, "no diff in the transcript");
  expect(out).toContain("no diff in the transcript");
  t.renderer.destroy();
});

test("/diff with an edit in the transcript opens the diff viewer", async () => {
  const editStream: RunEvent[] = [
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "tool_call",
      call_id: "c1",
      agent: "lead",
      at: 2,
      server: "edit_file",
      tool: "",
      arguments: { path: "a.ts", old_string: "x", new_string: "y" },
      result: "Replaced 1 occurrence in a.ts.",
      ok: true,
      diff: "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-x\n+y",
    }),
  ];
  const t = await mountApp(defaultProps({ seedStream: editStream }));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/diff");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  await t.renderOnce();
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).not.toContain("no diff in the transcript");
  t.renderer.destroy();
});

test("/plan enables required review from normal planning", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/plan");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  const out = await captureUntil(t, "plan review: required");
  expect(out).not.toContain("unknown command");
  t.renderer.destroy();
});

test("/plan remains the built-in toggle when an agent-backed skill is also named plan", async () => {
  let resolveListed!: () => void;
  const listed = new Promise<void>((resolve) => {
    resolveListed = resolve;
  });
  const skillRuns: Array<{ name: string; task: string; agent: string }> = [];
  const backend = baseBackend({
    client: {
      listTools: async () => [],
      listPrompts: async () => {
        resolveListed();
        return [{ name: "plan", agent: "coder" }];
      },
      getPrompt: async () => [],
      connectionStatus: () => "connected",
    },
  });
  const t = await mountApp(
    defaultProps({
      backend,
      submitSkillRun: (name, task, agent) => skillRuns.push({ name, task, agent }),
    }),
  );
  await listed;
  await Promise.resolve();
  await Promise.resolve();
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/plan");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  const out = await captureUntil(t, "plan review: required");
  expect(out).not.toContain("unknown command");
  expect(skillRuns).toEqual([]);
  t.renderer.destroy();
});

test("the removed /plans command is rejected instead of opening history", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/plans");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  const out = await captureUntil(t, "unknown command: /plans");
  expect(out).not.toContain("Plan · History");
  t.renderer.destroy();
});

test("the removed /planning command is rejected", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/planning");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  const out = await captureUntil(t, "unknown command: /planning");
  expect(out).not.toContain("plan review: required");
  t.renderer.destroy();
});

test("Ctrl+P toggles a run's plan detail, while Ctrl+C cancels without closing it", async () => {
  const doc = {
    id: "plan-active",
    path: ".clarvis/plans/active.md",
    title: "Active checkout plan",
    status: "active" as const,
    retention: "keep" as const,
    revision: 1,
    spec_revision: 1,
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
    created_by_run: "exec_1",
    objective: "Ship checkout safely",
    context: "",
    tasks: [],
    validation: [],
    notes: "",
    markdown: "## Objective\n\nShip checkout safely.",
  };
  const plans: AppBackend["plans"] = {
    read: async () => doc,
  };
  const stream: RunEvent[] = [
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "plan_created",
      at: 2,
      id: doc.id,
      path: doc.path,
      title: doc.title,
      status: doc.status,
      retention: doc.retention,
      revision: doc.revision,
      spec_revision: doc.spec_revision,
      tasks: [{ id: "t1", title: "Implement checkout", status: "in_progress" }],
    }),
  ];
  const cancels: number[] = [];
  const t = await mountApp(
    defaultProps({
      seedStream: stream,
      backend: baseBackend({ plans }),
      active: () => true,
      cancel: () => (cancels.push(1), true),
    }),
  );
  expect(await captureUntil(t, "Active checkout plan")).toContain("│ Plan");
  press(t, "p", { meta: true });
  expect(await captureUntil(t, "Ship checkout safely.")).toContain("Ship checkout safely.");
  press(t, "p", { ctrl: true });
  const main = await captureUntil(t, "Steer this run");
  expect(main).not.toContain("Plan · History");
  expect(cancels).toEqual([]);

  press(t, "p", { ctrl: true });
  await captureUntil(t, "Ship checkout safely.");
  press(t, "c", { ctrl: true });
  const plan = await captureUntil(t, "Ship checkout safely.");
  expect(plan).toContain("Ship checkout safely.");
  expect(cancels).toEqual([1]);
  t.renderer.destroy();
});

test("an unknown /command warns and blocks the draft; a known one clears it", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/totallynotacommand");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  const out = await captureUntil(t, "unknown command: /totallynotacommand");
  expect(out).toContain("unknown command: /totallynotacommand");
  t.renderer.destroy();
});

test("/quit calls shell.quit() directly when there is nothing to lose", async () => {
  const quitCalls: number[] = [];
  const t = await mountApp(defaultProps({ quitCalls }));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/quit");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  await t.renderOnce();
  expect(quitCalls).toEqual([1]);
  t.renderer.destroy();
});

test("a clean managed worktree asks whether to remove its checkout before exit", async () => {
  const quitCalls: number[] = [];
  const removals: number[] = [];
  const t = await mountApp(
    defaultProps({
      quitCalls,
      worktree: {
        name: "review-auth",
        branch: "clarvis/review-auth",
        isClean: async () => true,
        requestRemoval: async () => {
          removals.push(1);
        },
      },
    }),
  );
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/quit");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  const prompt = await captureUntil(t, "Remove checkout 'review-auth'");
  expect(prompt).toContain("Branch clarvis/review-auth will be kept");
  expect(prompt).toContain("[y] remove");
  expect(prompt).toContain("[n] keep");
  press(t, "n");
  await t.renderOnce();
  expect(removals).toEqual([]);
  expect(quitCalls).toEqual([1]);
  t.renderer.destroy();
});

test("accepting clean-worktree removal completes it before shutdown", async () => {
  const quitCalls: number[] = [];
  const removals: number[] = [];
  let finishRemoval!: () => void;
  const removalFinished = new Promise<void>((resolve) => {
    finishRemoval = resolve;
  });
  const t = await mountApp(
    defaultProps({
      quitCalls,
      worktree: {
        name: "temporary",
        branch: "clarvis/temporary",
        isClean: async () => true,
        requestRemoval: async () => {
          removals.push(1);
          await removalFinished;
        },
      },
    }),
  );
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/quit");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  await captureUntil(t, "Remove checkout 'temporary'");
  press(t, "y");
  await t.renderOnce();
  expect(removals).toEqual([1]);
  expect(quitCalls).toEqual([]);
  finishRemoval();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  expect(quitCalls).toEqual([1]);
  t.renderer.destroy();
});

test("a managed worktree with pending changes exits without offering removal", async () => {
  const quitCalls: number[] = [];
  const t = await mountApp(
    defaultProps({
      quitCalls,
      worktree: {
        name: "dirty",
        branch: "clarvis/dirty",
        isClean: async () => false,
        requestRemoval: async () => {
          throw new Error("must not request removal");
        },
      },
    }),
  );
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/quit");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  for (let i = 0; i < 4; i++) await t.renderOnce();
  expect(quitCalls).toEqual([1]);
  expect(t.captureCharFrame()).not.toContain("Clean worktree");
  t.renderer.destroy();
});

test("escape with no overlay, focus or draft does not cancel or quit", async () => {
  const quitCalls: number[] = [];
  const cancels: number[] = [];
  const t = await mountApp(
    defaultProps({
      quitCalls,
      active: () => true,
      cancel: () => (cancels.push(1), true),
    }),
  );
  await captureUntil(t, "Steer this run");
  press(t, "escape");
  await t.renderOnce();
  expect(cancels).toEqual([]);
  expect(quitCalls).toEqual([]);
  t.renderer.destroy();
});

test("ctrl+c with no active run arms quit without clearing the draft", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("unsent draft");
  await t.renderOnce();
  press(t, "c", { ctrl: true });
  const out = await captureUntil(t, "press again to quit");
  expect(out).toContain("unsent draft");
  expect(out).not.toContain("Draft cleared");
  t.renderer.destroy();
});

test("double ctrl+c exits while a requested run cancellation is still settling", async () => {
  const quitCalls: number[] = [];
  let cancellationPending = false;
  const t = await mountApp(
    defaultProps({
      quitCalls,
      active: () => true,
      cancel: () => {
        if (cancellationPending) return false;
        cancellationPending = true;
        return true;
      },
    }),
  );
  await captureUntil(t, "Steer this run");

  press(t, "c", { ctrl: true });
  press(t, "c", { ctrl: true });
  press(t, "c", { ctrl: true });
  await t.renderOnce();

  expect(quitCalls).toEqual([1]);
  t.renderer.destroy();
});

test("the first visible sub-agent opens Agents once per run and an explicit close is sticky", async () => {
  const store = createTranscriptStore();
  const activity = createActivityStore();
  const sink = store.openRun("exec_1");
  const activitySink = activity.openRun();
  const initial: RunEvent[] = [
    ev({ type: "run_started", at: 1 }),
    ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 2, model: "m" }),
    ev({
      type: "text_delta",
      agent: "lead",
      iteration: 1,
      channel: "text",
      text: "WIDTH ANCHOR before delegated activity",
      at: 3,
      reset: true,
    }),
  ];
  applyRunEvents(sink, initial, "live");
  applyRunEvents(activitySink, initial, "live");
  const t = await mountApp(defaultProps({ store, activity }));
  await captureUntil(t, "WIDTH ANCHOR");
  const historyBefore = t.renderer.root.findDescendantById("committed-history");
  const historyWidthBefore = historyBefore?.width;

  const delegation: RunEvent[] = [
    ev({
      type: "delegation_created",
      delegation_id: "w1",
      at: 4,
      title: "explorer",
      task: "look around",
      tools: [],
    }),
    ev({ type: "delegation_started", delegation_id: "w1", at: 5, model: "m" }),
  ];
  applyRunEvents(sink, delegation, "live");
  applyRunEvents(activitySink, delegation, "live");
  const out = await captureUntil(t, "Lead transcript");
  const historyOpen = t.renderer.root.findDescendantById("committed-history");
  expect(out).toContain("explorer");
  expect(out).toContain("Running");
  expect(out).not.toContain("tokens");
  expect(out).toContain("│ Agents");
  expect(out.replace(/\s+/g, " ")).toContain("> Lead transcript");
  expect(out).not.toContain("look around");
  expect(out).not.toContain("Activity detail");
  expect(historyOpen!.width).toBeLessThan(historyWidthBefore!);

  press(t, "escape");
  await t.renderOnce();
  await t.renderOnce();
  const historyExplicitlyClosed = t.renderer.root.findDescendantById("committed-history");
  expect(historyExplicitlyClosed?.width).toBe(historyWidthBefore);

  const laterDelegation: RunEvent[] = [
    ev({
      type: "delegation_created",
      delegation_id: "w2",
      at: 6,
      title: "reviewer",
      task: "review the result",
      tools: [],
    }),
    ev({ type: "delegation_started", delegation_id: "w2", at: 7, model: "m" }),
  ];
  applyRunEvents(sink, laterDelegation, "live");
  applyRunEvents(activitySink, laterDelegation, "live");
  const stillClosed = await captureUntil(t, "Agents 2");
  expect(stillClosed).not.toContain("│ Agents");
  expect(t.renderer.root.findDescendantById("committed-history")?.width).toBe(historyWidthBefore);

  const nextSink = store.openRun("exec_2");
  const nextActivitySink = activity.openRun();
  const nextRun: RunEvent[] = [
    ev({ type: "run_started", at: 8 }),
    ev({
      type: "delegation_created",
      delegation_id: "w1",
      at: 9,
      title: "new-run explorer",
      task: "inspect the new run",
      tools: [],
    }),
  ];
  applyRunEvents(nextSink, nextRun, "live");
  applyRunEvents(nextActivitySink, nextRun, "live");
  const reopened = await captureUntil(t, "new-run explorer");
  expect(reopened).toContain("│ Agents");
  expect(reopened.replace(/\s+/g, " ")).toContain("> Lead transcript");
  t.renderer.destroy();
});

test("Plan, Parallel work, and Agents own independent once-per-run sidebar reveals", async () => {
  const store = createTranscriptStore();
  const activity = createActivityStore();
  const sink = store.openRun("exec_intents");
  const activitySink = activity.openRun();
  const [workflow, setWorkflow] = createSignal<WorkflowActivity | null>(null);
  const started = [ev({ type: "run_started", at: 1 })];
  applyRunEvents(sink, started, "live");
  applyRunEvents(activitySink, started, "live");
  const t = await mountApp(defaultProps({ store, activity, workflowActivity: workflow }), {
    width: 140,
    height: 30,
  });

  const tasks: Extract<RunEvent, { type: "plan_created" }>["tasks"] = Array.from(
    { length: 12 },
    (_, index) => ({
      id: `task-${index + 1}`,
      title: `Plan task ${index + 1}`,
      status: index === 0 ? "in_progress" : "pending",
    }),
  );
  const planCreated: RunEvent[] = [
    ev({
      type: "plan_created",
      at: 2,
      id: "intent-plan",
      path: ".clarvis/plans/intent.md",
      title: "Intent plan",
      status: "active",
      retention: "keep",
      revision: 1,
      spec_revision: 1,
      tasks,
    }),
  ];
  applyRunEvents(sink, planCreated, "live");
  applyRunEvents(activitySink, planCreated, "live");
  const planOpen = await captureUntil(t, "Intent plan");
  expect(planOpen).toContain("│ Plan");

  press(t, "escape");
  await t.renderOnce();
  const planUpdate: RunEvent[] = [
    ev({
      type: "plan_updated",
      change: "task",
      at: 3,
      id: "intent-plan",
      path: ".clarvis/plans/intent.md",
      title: "Intent plan",
      status: "active",
      retention: "keep",
      revision: 2,
      spec_revision: 1,
      tasks: tasks.map((task, index) =>
        index === 0
          ? { ...task, status: "done" }
          : index === 1
            ? { ...task, status: "in_progress" }
            : task,
      ),
    }),
  ];
  applyRunEvents(sink, planUpdate, "live");
  applyRunEvents(activitySink, planUpdate, "live");
  await t.renderOnce();
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("│ Plan");

  await t.mockInput.typeText("/activity plan");
  t.mockInput.pressEnter();
  const manuallyReopenedPlan = await captureUntil(t, "Intent plan");
  expect(manuallyReopenedPlan).toContain("│ Plan");
  press(t, "escape");
  await t.renderOnce();

  setWorkflow({
    root: "workflow_intents",
    nodes: new Map([
      [
        "workflow_intents",
        {
          runId: "workflow_intents",
          kind: "manager",
          title: "manager",
          status: "running",
        },
      ],
      [
        "leader-1",
        {
          runId: "leader-1",
          parentRunId: "workflow_intents",
          kind: "leader",
          title: "Workflow intent leader",
          status: "running",
        },
      ],
    ]),
  });
  const workflowOpen = await captureUntil(t, "Workflow intent leader");
  expect(workflowOpen).toContain("Parallel work");

  press(t, "escape");
  await t.renderOnce();
  setWorkflow((current) => {
    const nodes = new Map(current!.nodes);
    nodes.set("leader-2", {
      runId: "leader-2",
      parentRunId: "workflow_intents",
      kind: "leader",
      title: "Later workflow leader",
      status: "running",
    });
    return { root: current!.root, nodes };
  });
  await t.renderOnce();
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("Parallel work");

  await t.mockInput.typeText("/activity workflow");
  t.mockInput.pressEnter();
  const manuallyReopenedWorkflow = await captureUntil(t, "Later workflow leader");
  expect(manuallyReopenedWorkflow).toContain("Parallel work");
  press(t, "escape");
  await t.renderOnce();

  const firstDelegation: RunEvent[] = [
    ev({
      type: "delegation_created",
      delegation_id: "intent-worker-1",
      at: 4,
      title: "Agent intent worker",
      task: "inspect the intent",
      tools: [],
    }),
  ];
  applyRunEvents(sink, firstDelegation, "live");
  applyRunEvents(activitySink, firstDelegation, "live");
  const agentsOpen = await captureUntil(t, "│ Agents");
  expect(agentsOpen).toContain("│ Agents");
  expect(agentsOpen).toContain("Lead transcript");

  press(t, "escape");
  await t.renderOnce();
  const laterDelegation: RunEvent[] = [
    ev({
      type: "delegation_created",
      delegation_id: "intent-worker-2",
      at: 5,
      title: "Later agent worker",
      task: "inspect again",
      tools: [],
    }),
  ];
  applyRunEvents(sink, laterDelegation, "live");
  applyRunEvents(activitySink, laterDelegation, "live");
  await t.renderOnce();
  await t.renderOnce();
  const agentsStillClosed = t.captureCharFrame();
  expect(agentsStillClosed).not.toContain("│ Agents");
  expect(agentsStillClosed).not.toContain("Lead transcript");

  await t.mockInput.typeText("/activity agents");
  t.mockInput.pressEnter();
  const manuallyReopenedAgents = await captureUntil(t, "│ Agents");
  expect(manuallyReopenedAgents).toContain("│ Agents");
  expect(manuallyReopenedAgents).toContain("Lead transcript");
  press(t, "escape");
  await t.renderOnce();

  setWorkflow({
    root: "workflow_next",
    nodes: new Map([
      [
        "workflow_next",
        {
          runId: "workflow_next",
          kind: "manager",
          title: "manager",
          status: "running",
        },
      ],
      [
        "leader-next",
        {
          runId: "leader-next",
          parentRunId: "workflow_next",
          kind: "leader",
          title: "Next workflow leader",
          status: "running",
        },
      ],
    ]),
  });
  const nextWorkflow = await captureUntil(t, "Next workflow leader");
  expect(nextWorkflow).toContain("Parallel work");

  press(t, "escape");
  await t.renderOnce();
  setWorkflow(null);
  const nextSink = store.openRun("exec_intents_next");
  const nextActivitySink = activity.openRun();
  const nextPlan: RunEvent[] = [
    ev({ type: "run_started", at: 6 }),
    ev({
      type: "plan_created",
      at: 7,
      id: "intent-plan",
      path: ".clarvis/plans/intent.md",
      title: "Intent plan next run",
      status: "active",
      retention: "keep",
      revision: 1,
      spec_revision: 1,
      tasks,
    }),
  ];
  applyRunEvents(nextSink, nextPlan, "live");
  applyRunEvents(nextActivitySink, nextPlan, "live");
  const nextPlanOpen = await captureUntil(t, "Intent plan next run");
  expect(nextPlanOpen).toContain("│ Plan");
  t.renderer.destroy();
});

test("clicking the drawer scrim keeps dismissal sticky for later sub-agents", async () => {
  const store = createTranscriptStore();
  const activity = createActivityStore();
  const sink = store.openRun("exec_scrim");
  const activitySink = activity.openRun();
  const firstDelegation: RunEvent[] = [
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "delegation_created",
      delegation_id: "w1",
      at: 2,
      title: "scrim explorer",
      task: "inspect the drawer",
      tools: [],
    }),
  ];
  applyRunEvents(sink, firstDelegation, "live");
  applyRunEvents(activitySink, firstDelegation, "live");
  const t = await mountApp(defaultProps({ store, activity }), { width: 90, height: 30 });
  const open = await captureUntil(t, "Lead transcript");
  expect(open).toContain("scrim explorer");

  await t.mockMouse.click(2, 5);
  await t.renderOnce();
  await t.renderOnce();
  const closed = t.captureCharFrame();
  expect(closed).not.toContain("│ Agents");
  expect(closed).not.toContain("Lead transcript");

  const laterDelegation: RunEvent[] = [
    ev({
      type: "delegation_created",
      delegation_id: "w2",
      at: 3,
      title: "scrim reviewer",
      task: "review the drawer",
      tools: [],
    }),
  ];
  applyRunEvents(sink, laterDelegation, "live");
  applyRunEvents(activitySink, laterDelegation, "live");
  const stillClosed = await captureUntil(t, "Agents 2");
  expect(stillClosed).not.toContain("│ Agents");
  expect(stillClosed).not.toContain("Lead transcript");
  t.renderer.destroy();
});

test("Escape closes a narrow-layout inspector drawer without canceling the active run", async () => {
  const subStream: RunEvent[] = [
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "delegation_created",
      delegation_id: "w1",
      at: 2,
      title: "drawer explorer",
      task: "inspect the workspace",
      tools: [],
    }),
    ev({ type: "delegation_started", delegation_id: "w1", at: 3, model: "m" }),
  ];
  const cancels: number[] = [];
  const t = await mountApp(
    defaultProps({
      seedStream: subStream,
      active: () => true,
      cancel: () => (cancels.push(1), true),
    }),
    { width: 90, height: 30 },
  );
  const open = await captureUntil(t, "Lead transcript");
  expect(open).toContain("drawer explorer");

  press(t, "escape");
  await t.renderOnce();
  await t.renderOnce();

  // Closing the drawer preserves transcript orientation but removes the
  // drawer roster.
  expect(t.captureCharFrame()).not.toContain("│ Agents");
  expect(cancels).toEqual([]);
  t.renderer.destroy();
});

test("normal submit and steer return an old reader to the Lead tail while background events do not", async () => {
  const store = createTranscriptStore();
  const activity = createActivityStore();
  const sink = store.openRun("exec_submit_tail");
  const activitySink = activity.openRun();
  const initial: RunEvent[] = [ev({ type: "run_started", at: 1 })];
  for (let iteration = 1; iteration <= 40; iteration += 1)
    initial.push(...leadTurn(iteration, `TAIL RESPONSE ${iteration}`, iteration * 3));
  applyRunEvents(sink, initial, "live");
  applyRunEvents(activitySink, initial, "live");
  const [active, setActive] = createSignal(false);
  const submissions: unknown[] = [];
  const t = await mountApp(
    defaultProps({
      store,
      activity,
      active,
      submit: (content) => submissions.push(content),
    }),
    { width: 120, height: 30 },
  );

  await captureUntil(t, "TAIL RESPONSE 40");
  await moveReaderAwayFromTail(t);
  const background = leadTurn(41, "BACKGROUND APPEND MUST NOT JUMP", 200);
  applyRunEvents(sink, background, "live");
  applyRunEvents(activitySink, background, "live");
  for (let pass = 0; pass < 8; pass += 1) await t.renderOnce();
  expect(t.renderer.root.findDescendantById("history-newer-indicator")).toBeDefined();
  expect(t.captureCharFrame()).not.toContain("BACKGROUND APPEND MUST NOT JUMP");

  await t.mockInput.typeText("normal explicit submit");
  t.mockInput.pressEnter();
  const afterSubmit = await captureUntil(t, "BACKGROUND APPEND MUST NOT JUMP");
  expect(afterSubmit).toContain("BACKGROUND APPEND MUST NOT JUMP");
  expect(t.renderer.root.findDescendantById("history-newer-indicator")).toBeUndefined();
  expect(submissions).toEqual(["normal explicit submit"]);

  setActive(true);
  await captureUntil(t, "Steer this run");
  await moveReaderAwayFromTail(t);
  const steerBackground = leadTurn(42, "STEER RETURN TARGET", 220);
  applyRunEvents(sink, steerBackground, "live");
  applyRunEvents(activitySink, steerBackground, "live");
  for (let pass = 0; pass < 8; pass += 1) await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("STEER RETURN TARGET");

  await t.mockInput.typeText("explicit steer");
  t.mockInput.pressEnter();
  expect(await captureUntil(t, "STEER RETURN TARGET")).toContain("STEER RETURN TARGET");
  expect(submissions).toEqual(["normal explicit submit", "explicit steer"]);
  t.renderer.destroy();
});

test("submitting from a retained child selects Lead and returns its old reader to the newest tail", async () => {
  const store = createTranscriptStore();
  const activity = createActivityStore();
  const sink = store.openRun("exec_child_submit_tail");
  const activitySink = activity.openRun();
  const initial: RunEvent[] = [ev({ type: "run_started", at: 1 })];
  for (let iteration = 1; iteration <= 40; iteration += 1)
    initial.push(...leadTurn(iteration, `RETAINED LEAD ${iteration}`, iteration * 3));
  initial.push(
    ev({
      type: "delegation_created",
      delegation_id: "child-submit",
      at: 200,
      title: "Submit child",
      task: "verify Lead return",
      tools: [],
    }),
    ev({
      type: "delegation_started",
      delegation_id: "child-submit",
      at: 201,
      model: "m",
    }),
    ev({
      type: "iteration_completed",
      agent: "subagent",
      subagent_id: "child-submit",
      iteration: 1,
      at: 202,
      model: "m",
      response: "CHILD SUBMIT VIEW",
      input_tokens: 10,
      output_tokens: 4,
    }),
  );
  applyRunEvents(sink, initial, "live");
  applyRunEvents(activitySink, initial, "live");
  const submissions: unknown[] = [];
  const t = await mountApp(
    defaultProps({
      store,
      activity,
      submit: (content) => submissions.push(content),
    }),
    { width: 120, height: 30 },
  );

  const leadTail = await captureUntil(t, "RETAINED LEAD 40");
  await moveReaderAwayFromTail(t);
  expect(t.captureCharFrame()).not.toContain("RETAINED LEAD 40");
  await clickLastText(t, leadTail, "Submit child");
  const child = await captureUntil(t, "CHILD SUBMIT VIEW");
  expect(child).not.toContain("RETAINED LEAD 40");

  const background = leadTurn(41, "CHILD-SELECTED LEAD RETURN TARGET", 220);
  applyRunEvents(sink, background, "live");
  applyRunEvents(activitySink, background, "live");
  for (let pass = 0; pass < 8; pass += 1) await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("CHILD-SELECTED LEAD RETURN TARGET");

  await clickText(t, t.captureCharFrame(), "New task");
  await t.mockInput.typeText("submit from child");
  t.mockInput.pressEnter();
  for (let pass = 0; pass < 8; pass += 1) await t.renderOnce();
  expect(submissions).toEqual(["submit from child"]);
  const returned = await captureUntil(t, "CHILD-SELECTED LEAD RETURN TARGET");
  expect(returned.replace(/\s+/g, " ")).toContain("> Lead transcript");
  expect(returned).not.toContain("CHILD SUBMIT VIEW");
  t.renderer.destroy();
});

test("model-backed prompt and skill submit also return an old reader to the Lead tail", async () => {
  const store = createTranscriptStore();
  const activity = createActivityStore();
  const sink = store.openRun("exec_command_tail");
  const activitySink = activity.openRun();
  const initial: RunEvent[] = [ev({ type: "run_started", at: 1 })];
  for (let iteration = 1; iteration <= 32; iteration += 1)
    initial.push(...leadTurn(iteration, `COMMAND TAIL ${iteration}`, iteration * 3));
  applyRunEvents(sink, initial, "live");
  applyRunEvents(activitySink, initial, "live");

  let resolveListed!: () => void;
  const listed = new Promise<void>((resolve) => {
    resolveListed = resolve;
  });
  const promptSubmissions: unknown[][] = [];
  const skillSubmissions: Array<{ name: string; task: string; agent: string }> = [];
  const backend = baseBackend({
    client: {
      listTools: async () => [],
      listPrompts: async () => {
        resolveListed();
        return [
          { name: "figma:inspect", description: "Inspect through a downstream prompt." },
          { name: "quickfix", description: "Run a skill.", agent: "coder" },
        ];
      },
      getPrompt: async () => [{ role: "user" as const, content: "inspect now" }],
      connectionStatus: () => "connected",
    },
  });
  const t = await mountApp(
    defaultProps({
      store,
      activity,
      backend,
      submitPrompt: (...args) => promptSubmissions.push(args),
      submitSkillRun: (name, task, agent) => skillSubmissions.push({ name, task, agent }),
    }),
    { width: 120, height: 30 },
  );
  await listed;
  await Promise.resolve();
  await Promise.resolve();
  await captureUntil(t, "COMMAND TAIL 32");

  await moveReaderAwayFromTail(t);
  await t.mockInput.typeText("/figma:inspect");
  await t.renderOnce();
  t.mockInput.pressEnter();
  for (let pass = 0; pass < 100 && promptSubmissions.length === 0; pass += 1) {
    await Promise.resolve();
    await t.renderOnce();
  }
  expect(promptSubmissions).toHaveLength(1);
  expect(promptSubmissions[0]?.[1]).toBe("/figma:inspect");
  expect(await captureUntil(t, "COMMAND TAIL 32")).toContain("COMMAND TAIL 32");

  await moveReaderAwayFromTail(t);
  await t.mockInput.typeText("/quickfix audit");
  await t.renderOnce();
  t.mockInput.pressEnter();
  expect(skillSubmissions).toEqual([{ name: "quickfix", task: "audit", agent: "coder" }]);
  expect(await captureUntil(t, "COMMAND TAIL 32")).toContain("COMMAND TAIL 32");
  t.renderer.destroy();
});

test("transcript navigation: ctrl+down focuses a block, ctrl+o toggles it, escape clears the focus", async () => {
  const stream: RunEvent[] = [
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "tool_call",
      call_id: "c1",
      agent: "lead",
      at: 2,
      server: "clarvis",
      tool: "read_file",
      arguments: { path: "a.ts" },
      result: "1\tconst a = 1",
      ok: true,
    }),
    ev({ type: "run_ended", status: "completed", at: 3, reason: "completed" }),
  ];
  const t = await mountApp(defaultProps({ seedStream: stream }));
  await captureUntil(t, "New task");
  press(t, "down", { ctrl: true });
  await t.renderOnce();
  press(t, "o", { ctrl: true });
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).toContain("New task");
  t.renderer.destroy();
});

test("Tab returns the transcript's logical block focus to the composer", async () => {
  const stream: RunEvent[] = [
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "tool_call",
      call_id: "c1",
      agent: "lead",
      at: 2,
      server: "clarvis",
      tool: "read_file",
      arguments: { path: "a.ts" },
      result: "1\tconst a = 1",
      ok: true,
    }),
    ev({ type: "run_ended", status: "completed", at: 3, reason: "completed" }),
  ];
  const t = await mountApp(defaultProps({ seedStream: stream }));
  await captureUntil(t, "New task");
  press(t, "down", { ctrl: true });
  press(t, "o", { ctrl: true });
  await t.renderOnce();
  press(t, "tab");
  press(t, "o", { ctrl: true });
  await t.renderOnce();
  // Ctrl+O now targets the transcript as a whole; it must not re-toggle the
  // block that Tab just left behind.
  expect(t.captureCharFrame()).toContain("blocks expanded");
  t.renderer.destroy();
});

test("transcript scroll keys (pageup/pagedown/alt+up/alt+down) run without crashing the shell", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  press(t, "pageup");
  press(t, "pagedown");
  press(t, "up", { meta: true });
  press(t, "down", { meta: true });
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).toContain("New task");
  t.renderer.destroy();
});

test("the split sidebar owns one compact textual agent roster, including after expand all", async () => {
  const stream: RunEvent[] = [
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "delegation_created",
      delegation_id: "w1",
      at: 2,
      title: "Scout",
      task: "auth",
      tools: [],
    }),
    ev({
      type: "delegation_created",
      delegation_id: "w2",
      at: 2,
      title: "Reviewer",
      task: "tests",
      tools: [],
    }),
    ev({
      type: "delegation_created",
      delegation_id: "w3",
      at: 2,
      title: "Fixer",
      task: "types",
      tools: [],
    }),
    ev({ type: "delegation_started", delegation_id: "w3", task_id: "t3", at: 3, model: "m" }),
    ev({
      type: "delegation_completed",
      delegation_id: "w1",
      task_id: "t1",
      at: 4,
      status: "completed",
      summary: "Checked **auth** | pass",
    }),
    ev({
      type: "delegation_failed",
      delegation_id: "w2",
      task_id: "t2",
      at: 4,
      status: "error",
      summary: "Typecheck failed",
    }),
  ];
  const t = await mountApp(defaultProps({ seedStream: stream }), { width: 120, height: 34 });
  const before = await captureUntil(t, "2/3 finished");
  const normalizedBefore = before.replace(/\s+/g, " ");
  expect(before).toContain("Lead transcript");
  expect(before.match(/2\/3 finished/g)?.length).toBe(1);
  expect(before).toContain("1 running");
  expect(before).toContain("1 failed");
  expect(normalizedBefore).toContain("A1 Scout");
  expect(normalizedBefore).toContain("A2 Reviewer");
  expect(normalizedBefore).toContain("A3 Fixer");
  expect(before).toContain("Failed: Typechec");
  expect(before).not.toContain("All agents");
  expect(before).not.toContain("Aggregated transcript");
  expect(before).not.toContain("Activity: working");

  press(t, "tab");
  await t.renderOnce();
  expect(t.captureCharFrame().replace(/\s+/g, " ")).toContain("> A1 Scout");

  press(t, "o", { ctrl: true });
  await t.renderOnce();
  const expanded = t.captureCharFrame();
  expect(expanded).toContain("Lead transcript");
  expect(expanded.replace(/\s+/g, " ")).toContain("A1 Scout");
  t.renderer.destroy();
});

test("the main transcript omits workers and sidebar selection opens one isolated transcript", async () => {
  const stream: RunEvent[] = [
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "delegation_created",
      delegation_id: "w1",
      at: 2,
      title: "Scout",
      task: "Inspect authentication",
      tools: [],
    }),
    ev({ type: "delegation_started", delegation_id: "w1", at: 3, model: "m" }),
    ev({
      type: "iteration_completed",
      agent: "subagent",
      subagent_id: "w1",
      iteration: 1,
      at: 4,
      model: "m",
      response: "SCOUT BODY OPENS READABLE",
      input_tokens: 10,
      output_tokens: 4,
    }),
    ev({
      type: "delegation_completed",
      delegation_id: "w1",
      at: 5,
      status: "completed",
      summary: "Scout completed",
    }),
    ev({
      type: "delegation_created",
      delegation_id: "w2",
      at: 6,
      title: "Reviewer",
      task: "Review authentication",
      tools: [],
    }),
    ev({ type: "delegation_started", delegation_id: "w2", at: 7, model: "m" }),
    ev({
      type: "iteration_completed",
      agent: "subagent",
      subagent_id: "w2",
      iteration: 1,
      at: 8,
      model: "m",
      response: "REVIEWER BODY OPENS READABLE",
      input_tokens: 10,
      output_tokens: 4,
    }),
    ev({
      type: "delegation_completed",
      delegation_id: "w2",
      at: 9,
      status: "completed",
      summary: "Reviewer completed",
    }),
    ev({ type: "run_ended", status: "completed", at: 10, reason: "completed" }),
  ];
  const t = await mountApp(defaultProps({ seedStream: stream }), { width: 120, height: 34 });
  const main = await captureUntil(t, "Reviewer");
  expect(main.replace(/\s+/g, " ")).toContain("> Lead transcript");
  expect(main).not.toContain("SCOUT BODY OPENS READABLE");
  expect(main).not.toContain("REVIEWER BODY OPENS READABLE");
  expect(main).not.toContain("Activity detail");

  await clickLastText(t, main, "Scout");
  const isolated = await captureUntil(t, "SCOUT BODY OPENS READABLE");
  expect(isolated).toContain("SCOUT BODY OPENS READABLE");
  expect(isolated).not.toContain("REVIEWER BODY OPENS READABLE");

  await clickText(t, isolated, "Scout");
  const collapsed = await captureUntil(t, "hidden");
  expect(collapsed).not.toContain("SCOUT BODY OPENS READABLE");
  await clickText(t, collapsed, "Lead transcript");
  const leadAgain = await captureUntil(t, "Reviewer");
  await clickLastText(t, leadAgain, "Scout");
  press(t, "pageup");
  const reselected = await captureUntil(t, "hidden");
  expect(reselected).toContain("hidden");
  expect(reselected).not.toContain("SCOUT BODY OPENS READABLE");
  t.renderer.destroy();
});

test("returning from a child sidebar transcript restores the live Lead frontier", async () => {
  const stream: RunEvent[] = [
    ev({ type: "run_started", at: 1 }),
    ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 2, model: "m" }),
    ev({
      type: "text_delta",
      agent: "lead",
      iteration: 1,
      channel: "text",
      text: "LEAD FRONTIER MUST RETURN",
      at: 3,
      reset: true,
    }),
    ev({
      type: "delegation_created",
      delegation_id: "w1",
      at: 4,
      title: "Scout",
      task: "Inspect the live-tail handoff",
      tools: [],
    }),
    ev({ type: "delegation_started", delegation_id: "w1", at: 5, model: "m" }),
    ev({
      type: "iteration_completed",
      agent: "subagent",
      subagent_id: "w1",
      iteration: 1,
      at: 6,
      model: "m",
      response: "CHILD COMMITTED TRANSCRIPT",
      input_tokens: 10,
      output_tokens: 4,
    }),
    ev({
      type: "delegation_completed",
      delegation_id: "w1",
      at: 7,
      status: "completed",
      summary: "Scout completed",
    }),
  ];
  const t = await mountApp(defaultProps({ seedStream: stream, active: () => true }), {
    width: 120,
    height: 34,
  });
  const lead = await captureUntil(t, "Scout");
  expect(lead).toContain("LEAD FRONTIER MUST RETURN");
  await clickLastText(t, lead, "Scout");
  const child = await captureUntil(t, "CHILD COMMITTED TRANSCRIPT");
  expect(child).not.toContain("LEAD FRONTIER MUST RETURN");

  await clickText(t, child, "Lead transcript");
  const restored = await captureUntil(t, "LEAD FRONTIER MUST RETURN");
  expect(restored).not.toContain("CHILD COMMITTED TRANSCRIPT");
  t.renderer.destroy();
});

test("clicking a completed agent opens its isolated transcript without a detail modal", async () => {
  const stream: RunEvent[] = [
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "delegation_created",
      delegation_id: "w1",
      at: 2,
      title: "Researcher",
      task: "inspect",
      tools: [],
    }),
    ev({
      type: "iteration_completed",
      agent: "subagent",
      subagent_id: "w1",
      iteration: 1,
      at: 3,
      model: "m",
      response: "ISOLATED WORKER RESULT",
      input_tokens: 10,
      output_tokens: 4,
    }),
    ev({
      type: "delegation_completed",
      delegation_id: "w1",
      at: 4,
      status: "completed",
      summary: "## Result\n\n| check | status |\n| --- | --- |\n| transcript | **fixed** |",
    }),
  ];
  const t = await mountApp(defaultProps({ seedStream: stream }), { width: 140, height: 34 });
  const frame = await captureUntil(t, "click to read");
  const rows = frame.split("\n");
  const researcher = rows
    .map((row, y) => ({ row, y, x: row.lastIndexOf("Researcher") }))
    .find((hit) => hit.x > 90);
  expect(researcher).toBeDefined();
  await t.mockMouse.click(researcher!.x + 2, researcher!.y);
  const selected = await captureUntil(t, "ISOLATED WORKER RESULT");
  expect(selected).not.toContain("Completed sub-agent response");
  expect(selected).not.toContain("Activity detail");
  expect(selected).toContain("> A1");
  t.renderer.destroy();
});

test("a compact activity strip keeps sub-agents visible when the split sidebar cannot fit", async () => {
  const subStream: RunEvent[] = [
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "delegation_created",
      delegation_id: "w1",
      at: 2,
      title: "responsive explorer",
      task: "inspect",
      tools: [],
    }),
    ev({ type: "delegation_started", delegation_id: "w1", at: 3, model: "m" }),
  ];
  const t = await mountApp(defaultProps({ seedStream: subStream }), {
    width: 80,
    height: 24,
  });
  const frame = await captureUntil(t, "Lead transcript");
  expect(frame).toContain("responsive explorer");
  expect(frame).toContain("Agents 1");
  expect(frame).toContain("1 running");
  press(t, "escape");
  await t.renderOnce();
  await t.renderOnce();
  const closed = t.captureCharFrame();
  expect(closed).not.toContain("Lead transcript");
  expect(closed).toContain("Agents 1");
  t.renderer.destroy();
});

test("the first workflow leader opens and reveals Parallel work", async () => {
  const workflow = () => ({
    root: "manager",
    nodes: new Map([
      [
        "manager",
        {
          runId: "manager",
          kind: "manager" as const,
          title: "manager",
          status: "running" as const,
        },
      ],
      [
        "leader-1",
        {
          runId: "leader-1",
          parentRunId: "manager",
          kind: "leader" as const,
          title: "Visual continuity audit",
          status: "running" as const,
        },
      ],
    ]),
  });
  const t = await mountApp(defaultProps({ workflowActivity: workflow }));
  const split = await captureUntil(t, "Visual continuity audit");
  expect(split).toContain("Parallel work");
  expect(split).toContain("1 leader");
  t.renderer.destroy();
});

test("the footer run strip owns context pressure when there is no visible sidebar", async () => {
  const stream: RunEvent[] = [
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "iteration_completed",
      agent: "lead",
      iteration: 1,
      at: 2,
      model: "m",
      input_tokens: 5000,
      output_tokens: 100,
      response: "",
    }),
  ];
  const t = await mountApp(defaultProps({ seedStream: stream }));
  const out = await captureUntil(t, "Context ");
  expect(out).toMatch(/Context \d+%/);
  t.renderer.destroy();
});

test("a pending elicitation dismisses a clean overlay so the question becomes visible", async () => {
  const [elicit, setElicit] = createSignal<ElicitRequestParams | null>(null);
  const t = await mountApp(defaultProps({ elicit }));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/agent");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  await captureUntil(t, "Select agent");
  setElicit({ message: "allow this command?", kind: "guard_confirm" });
  const out = await captureUntil(t, "allow this command?");
  expect(out).not.toContain("Select agent");
  t.renderer.destroy();
});

test("a pending elicitation does not discard an in-progress config edit", async () => {
  const [elicit, setElicit] = createSignal<ElicitRequestParams | null>(null);
  const t = await mountApp(defaultProps({ elicit }));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("/settings");
  await t.renderOnce();
  press(t, "escape");
  await t.renderOnce();
  t.mockInput.pressEnter();
  await captureUntil(t, "Run controls");
  for (let i = 0; i < 6; i++) press(t, "down");
  await t.renderOnce();
  press(t, "return");
  await captureUntil(t, "contrast checker");
  for (let i = 0; i < 3; i++) press(t, "down");
  await t.renderOnce();
  press(t, "x");
  await captureUntil(t, "Unsaved");

  setElicit({ message: "allow this command?", kind: "guard_confirm" });
  const kept = await captureUntil(t, "the agent is waiting for an answer");
  expect(kept).toContain("Unsaved");
  expect(kept).toContain("contrast checker");
  expect(kept).not.toContain("allow this command?");

  press(t, "escape");
  await captureUntil(t, "Discard unsaved changes?");
  press(t, "y");
  await captureUntil(t, "Run controls");
  press(t, "escape");
  const answered = await captureUntil(t, "allow this command?");
  expect(answered).not.toContain("contrast checker");
  t.renderer.destroy();
});

test("escape clears a non-empty composer draft without exposing a quit action", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("unsent draft");
  await t.renderOnce();
  press(t, "escape");
  const out = await captureUntil(t, "Draft cleared");
  expect(out).not.toContain("unsent draft");
  expect(out).not.toContain("again to quit");
  t.renderer.destroy();
});

test("escape also clears a whitespace-only composer draft", async () => {
  const t = await mountApp(defaultProps({}));
  await captureUntil(t, "New task");
  await t.mockInput.typeText("   ");
  await t.renderOnce();
  press(t, "escape");
  const out = await captureUntil(t, "Draft cleared");
  expect(out).not.toContain("again to quit");
  t.renderer.destroy();
});

test("a wide split transcript uses the space up to the sidebar", async () => {
  const transcriptText = Array.from({ length: 80 }, (_, index) => `splitword${index}`).join(" ");
  const stream: RunEvent[] = [
    ev({ type: "run_started", at: 1 }),
    ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 2, model: "m" }),
    ev({
      type: "text_delta",
      agent: "lead",
      iteration: 1,
      channel: "text",
      text: transcriptText,
      at: 3,
      reset: false,
    }),
    ev({
      type: "plan_created",
      at: 4,
      id: "split-plan",
      path: ".clarvis/plans/split.md",
      title: "Split width plan",
      status: "active",
      retention: "keep",
      revision: 1,
      spec_revision: 1,
      tasks: [{ id: "t1", title: "Use the available width", status: "in_progress" }],
    }),
  ];
  const t = await mountApp(defaultProps({ seedStream: stream }), { width: 200, height: 40 });
  const frame = await captureUntil(t, "Split width plan");
  expect(frame).toContain("│ Plan");
  const rows = frame.split("\n");
  const sidebarStart = rows.find((row) => row.includes("│ Plan"))!.indexOf("│");
  const transcriptRows = rows.filter((row) => row.includes("splitword"));

  expect(sidebarStart).toBe(144);
  expect(transcriptRows.some((row) => row.slice(112, sidebarStart).includes("splitword"))).toBe(
    true,
  );
  expect(transcriptRows.every((row) => !/splitword\d/.test(row.slice(sidebarStart + 1)))).toBe(
    true,
  );
  t.renderer.destroy();
});
