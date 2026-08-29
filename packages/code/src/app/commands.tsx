import { glyph } from "../theme/glyphs.ts";
import type { Accessor } from "solid-js";
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { detachObserved } from "../core/tasks.ts";
import type { Platform } from "../adapters/platform.ts";
import type { ActiveAgentStore } from "../adapters/active-agent.ts";
import {
  defaultPlansSettings,
  patchPlansSettings,
  type Scope,
  type SettingsAdapter,
} from "../adapters/settings.ts";
import type { ClarvisDirs } from "../adapters/agents.ts";
import type { KeysAdapter } from "../adapters/provider-secrets.ts";
import type { CodeConfigStore } from "../adapters/code-config.ts";
import type { MemoryModeStore } from "../adapters/memory-mode.ts";
import type { GuardModeStore } from "../adapters/guard-mode.ts";
import type { ThemePreview } from "../theme/theme.ts";
import { DEFAULT_AGENT_NAME, type EnvView } from "../adapters/agent-files.ts";
import type { AgentsStore } from "../adapters/agents-store.ts";
import type { ModelsCatalog } from "../adapters/models-catalog.ts";
import {
  bootGate,
  runGates,
  startupRoute,
  type BackendProbe,
  type DoctorCtx,
  type Gate,
} from "../onboarding/doctor.ts";
import { seedMemoryBlock } from "../onboarding/seed-memory.ts";
import { seedPlansBlock } from "../onboarding/seed-plans.ts";
import { seedDefaultAllowlist } from "../onboarding/seed-default-allowlist.ts";
import type { ConnectionState } from "../adapters/connection-state.ts";
import type { DebugSessionController } from "../adapters/debug-session.ts";
import type { RunHost } from "../run-host.ts";
import { isDiagnosticLevel } from "../core/diagnostic-events.ts";
import {
  createMcpCapabilities,
  type McpClientCaps,
  type McpEffects,
} from "../adapters/mcp-capabilities-bridge.ts";
import type { LivePrompt, PromptMessage } from "../adapters/mcp-capabilities.ts";
import type {
  PlansMode,
  EnvironmentDefinition,
  EnvironmentRef,
  EnvironmentService,
  PluginRef,
  ModelCatalogService,
  PluginService,
  ProviderAuthService,
  ResolvedEnvironment,
  RunDetail,
  SandboxInspection,
  SkillsService,
  StorageService,
  WorkflowsService,
  SubscriptionScheme,
  SubscriptionState,
} from "@clarvis/protocol";
import type { Commands, CommandUi, ViewHost, ViewRoute } from "../keys/commands.ts";
import type { InteractionEffects } from "../keys/interaction.ts";
import { splitSlashArgs } from "../views/input/autocomplete.ts";
import type { SetupState } from "../views/onboarding/SetupView.tsx";
import type { StartupIssue } from "../views/onboarding/RecoveryView.tsx";
import type { SessionCatalogItem } from "../views/config/SessionsHub.tsx";
import { SETTINGS_ITEMS } from "../views/config/hub-items.ts";
import { lazyView } from "../views/config/lazy-view.tsx";
import { createPluginsStore, type PluginView } from "../adapters/plugins.ts";
import { addMarketplaceSource, createMarketplaceAdapter } from "../adapters/marketplace.ts";
import { errorText } from "../adapters/errors.ts";
import type { HintTone } from "../views/hint.ts";
import type { SessionId, SessionMeta } from "../adapters/session-store.ts";
import type { TasksController } from "../features/tasks/controller.ts";
import type { WorkflowActivity } from "../adapters/workflow-projection.ts";

/** Dependencies for {@link registerAppCommands}: every adapter and effect the app-level commands close over. */
export interface AppCommandDeps {
  commands: Commands;
  ui: CommandUi;
  effects: Pick<
    InteractionEffects,
    | "openAgentPicker"
    | "openSafetyPresetPicker"
    | "cycleGuardMode"
    | "openDiff"
    | "openPlan"
    | "quit"
  >;
  session: {
    list: () => SessionMeta[];
    catalog?: () => Promise<SessionCatalogItem[]>;
    resume: (id: SessionId) => void;
    resumeCatalog?: (item: SessionCatalogItem) => Promise<void> | void;
    delete: (item: SessionCatalogItem) => Promise<void>;
    statusLine: () => string;
  };
  notify: (message: string, tone?: HintTone) => void;
  settings: SettingsAdapter;
  dirs: ClarvisDirs;
  catalog: ModelsCatalog | null;
  loadCatalog?: () => Promise<void>;
  modelsService?: ModelCatalogService;
  providerAuth?: ProviderAuthService;
  refreshModels: () => Promise<{ providers: number; models: number }>;
  refreshAgentProfiles: () => Promise<void>;
  keys: KeysAdapter;
  reconnectBackend: () => Promise<{ ok: boolean; message: string }>;
  env: EnvView;
  preview: ThemePreview;
  platform: Platform;
  agents: ActiveAgentStore;
  agentFiles: AgentsStore;
  plugins: PluginService;
  environments: EnvironmentService;
  skills: SkillsService;
  /** Overrides product-owned marketplace sources for an embedding or isolated test host. */
  marketplaceDefaultUrls?: readonly string[];
  code: CodeConfigStore;
  memoryMode: MemoryModeStore;
  guard: GuardModeStore;
  workflows: Pick<WorkflowsService, "list" | "get" | "delete">;
  workflowActivity?: Accessor<WorkflowActivity | null>;
  tasks: TasksController;
  storage: Pick<StorageService, "inspect" | "cleanup">;
  /** A transient host-level reason that blocks starting task work, such as the RSS fuse. */
  taskWorkBlockedReason?: () => string | null;
  getRun: (id: string) => Promise<RunDetail | null>;
  runActive: () => boolean;
  hasAvailablePlan: () => boolean;
  backend: Accessor<BackendProbe>;
  mcpClient: McpClientCaps;
  onSubmitPrompt: (
    messages: PromptMessage[],
    display?: string,
    skill?: { name: string; task?: string; plansMode?: PlansMode },
  ) => void;
  onSubmitSkillRun: (name: string, task: string, agent: string) => void;
  onCompactRun: (request?: string) => void;
  inspectRunContext?: RunHost["inspectCurrentContext"];
  fitRunContext?: RunHost["fitCurrentContext"];
  connection: Accessor<ConnectionState>;
  /** Opens, retunes and closes the bounded diagnostic log for `/debug`. */
  debugSession: DebugSessionController;
  /** Read-once argument tail of the /command line being dispatched right now. */
  takeSlashArgs: () => string;
}

/** Projections {@link registerAppCommands} hands back to the shell for wiring outside the registry. */
export interface AppCommandWiring {
  doctorDirty: Accessor<boolean>;
  recheck: () => void;
  /**
   * The host's sandbox probe, or null until an explicit inspection completes.
   * The header reads a completed probe so a configured-but-dead sandbox is
   * visible in the chip rather than only in the doctor.
   */
  sandboxInspection: Accessor<SandboxInspection | null>;
  /** The agent a skill runs on, or `undefined` when it names none. */
  skillAgent: (name: string) => string | undefined;
  /** Release app, feature, and dynamic MCP command registrations. */
  dispose(): void;
}

function environmentSelectsPlugin(
  environment: Awaited<ReturnType<EnvironmentService["current"]>>,
  ref: PluginRef,
): boolean {
  return environment.plugins.some(
    (plugin) =>
      plugin.ref.scope === ref.scope &&
      plugin.ref.source === ref.source &&
      plugin.ref.name === ref.name,
  );
}

/** Explain why a selected plugin's files cannot change beneath an active run snapshot. */
export async function selectedPluginLifecycleBlock(
  environments: Pick<EnvironmentService, "current">,
  runActive: () => boolean,
  ref: PluginRef,
): Promise<string | undefined> {
  if (!runActive()) return undefined;
  const environment = await environments.current();
  return environmentSelectsPlugin(environment, ref)
    ? `finish the active run before changing ${ref.scope}/${ref.source}/${ref.name} in ${environment.id}`
    : undefined;
}

/** Recompose the kernel only when a lifecycle mutation touched a selected exact plugin ref. */
export async function recomposeSelectedPlugin(
  environments: Pick<EnvironmentService, "current">,
  reconnectBackend: AppCommandDeps["reconnectBackend"],
  reloadPlugins: () => Promise<void>,
  ref: PluginRef,
): Promise<string | undefined> {
  const before = await environments.current();
  if (!environmentSelectsPlugin(before, ref)) return undefined;
  const reconnect = await reconnectBackend();
  if (!reconnect.ok) {
    return `selected by ${before.id}; takes effect after /reconnect (${reconnect.message})`;
  }
  await reloadPlugins();
  const after = await environments.current();
  return `recomposed ${after.id} ${glyph("emDash")} ${after.status}`;
}

/**
 * Registers every app-level (non-feature) command, view, and action against
 * the shared command registry.
 *
 * @param deps - Application command dependencies.
 * @returns Projections the shell wires up separately from the registry.
 */
export function registerAppCommands(deps: AppCommandDeps): AppCommandWiring {
  const commandScope = deps.commands.scope();
  const commands: Commands = {
    ...deps.commands,
    registerAction: (def) => commandScope.registerAction(def),
    registerView: (def) => commandScope.registerView(def),
    promptCommand: (server, prompt, run) => commandScope.promptCommand(server, prompt, run),
    skillCommand: (local, prompt, run) => commandScope.skillCommand(local, prompt, run),
    dispose: () => commandScope.dispose(),
  };
  const { ui, effects, notify, env } = deps;
  let disposed = false;
  const requestModelsCatalog = (): void => {
    if (deps.loadCatalog !== undefined) detachObserved("models_catalog_load", deps.loadCatalog);
  };

  commands.registerView({
    name: "help.open",
    title: "Help",
    desc: "Active actions, destinations and keyboard environment",
    slash: "/help",
    surface: "slash",
    group: "actions",
    view: lazyView(async () => {
      const { Help } = await import("../views/overlays/Help.tsx");
      return (host) => (
        <Help
          interaction={host.interaction}
          entries={(term?: string) => commands.entries(term)}
          active={host.active}
        />
      );
    }),
  });
  commands.registerView({
    name: "tasks.open",
    title: "Tasks",
    desc: "Browse and work on external tasks in the current workspace",
    slash: "/tasks",
    surface: "slash",
    group: "navigate",
    enabled: deps.tasks.available,
    view: lazyView(async () => {
      const { TasksHub } = await import("../views/config/TasksHub.tsx");
      return (host) =>
        TasksHub(host, {
          controller: deps.tasks,
          profiles: deps.agents.list,
          defaultContainer: () => deps.settings.effective().tasks?.default_container,
          ...(deps.taskWorkBlockedReason === undefined
            ? {}
            : { workBlockedReason: deps.taskWorkBlockedReason }),
          onError: (message) => notify(message, "warn"),
        });
    }),
  });

  /** Opens `childCmd` above the current view, or seeds `returnCmd` beneath a deep link. */
  function openWithReturn(childCmd: string, returnCmd: string, scope?: Scope): void {
    const factory = commands.viewFactory(childCmd);
    const parentFactory = commands.viewFactory(returnCmd);
    if (!factory) return;
    const parent: ViewRoute | undefined = parentFactory
      ? { name: returnCmd, factory: parentFactory, ...(scope ? { scope } : {}) }
      : undefined;
    ui.openView(childCmd, factory, { ...(parent ? { parent } : {}), ...(scope ? { scope } : {}) });
  }

  /**
   * The scope a deep-linked config view should open on: the workspace only when
   * it actually carries settings, and `global` otherwise.
   *
   * @remarks This used to test whether `<ws>/.clarvis` **existed**, which is a
   *   different question and almost always true: `ensureWorkspaceDir` creates
   *   that directory on the first write of anything under it — a plan, a memory
   *   file, `local/`, the prompt history — so every workspace Clarvis has ever
   *   run in has one. `/settings providers` therefore opened on a scope with no
   *   `settings.json` and listed nothing, while `/settings` followed by picking
   *   Providers from the menu worked, because the hub forwards `host.scope()`
   *   instead. The same predicate feeds internal child navigation and the first-run
   *   doctor, where the cost is higher: a new user is told a provider is
   *   missing, presses fix, lands on an empty workspace-scoped panel, and is
   *   invited to write a duplicate that then shadows the good global one.
   */
  const preferredScope = (): Scope =>
    deps.settings.read("workspace") !== undefined ? "workspace" : "global";

  interface HubItem {
    id: string;
    label: string;
    desc: string;
    cmd: string;
  }
  /** Derive a hub's `/hub <child>` inline choice hints from its item list. */
  const hubSubcommands = (items: readonly HubItem[]): { name: string; desc?: string }[] =>
    items.map((i) => ({ name: i.id, desc: i.label }));
  /**
   * Derive a hub's deep-link router: `/hub <child>` opens that child view with a
   * parent route back to the hub; an unknown child returns `false` so the plain
   * command falls through and opens the hub itself.
   */
  const hubRoute =
    (items: readonly HubItem[], returnCmd: string) =>
    (args: string): boolean => {
      const first = args.trim().split(/\s+/)[0];
      const item = items.find((i) => i.id === first);
      if (!item) return false;
      openWithReturn(item.cmd, returnCmd, preferredScope());
      return true;
    };

  commands.registerAction({
    name: "agent.picker",
    title: "Switch agent",
    desc: "Pick the active agent",
    slash: "/agent",
    surface: "slash",
    group: "navigate",
    run: () => effects.openAgentPicker(),
  });

  let extensionSetupInitialEnvironment: EnvironmentRef | undefined;
  let extensionSetupInitialPlugin: PluginRef | undefined;

  const openWorkspaceTrustPrompt = (): void => {
    const factory = commands.viewFactory("workspace.trust.prompt");
    if (factory !== undefined) {
      ui.openView("workspace.trust.prompt", factory, { scope: preferredScope() });
    }
  };

  commands.registerAction({
    name: "safety.picker",
    title: "Safety preset",
    desc: "Choose the sandbox and command-review posture for the next run",
    surface: "internal",
    group: "navigate",
    actionSurfaces: ["footer", "full-help"],
    footerLabel: "safety",
    hintPriority: 42,
    hintGroup: "navigation",
    run: () => effects.openSafetyPresetPicker(),
  });

  commands.registerAction({
    name: "run.compact",
    title: "Compact context",
    desc: "Compact context for the next model call",
    slash: "/compact",
    surface: "slash",
    group: "actions",
    args: [
      {
        name: "request",
        description: "What the compaction summary should preserve",
        required: false,
      },
    ],
    run: () => {
      const request = deps.takeSlashArgs().trim();
      deps.onCompactRun(request.length > 0 ? request : undefined);
    },
  });

  /**
   * Apply one `/debug [off|<level>]` invocation and report what happened.
   *
   * @param rawArgs - the argument tail of the dispatched command line.
   * @remarks Bare `/debug` opens (or reopens) the log at `debug`; `/debug off`
   *   closes it; `/debug <level>` retunes it, which is a close and a reopen
   *   because the level is a property of the file's header. The notice carries
   *   the path because it is the only place the user can read it after the
   *   `--debug` line printed before first paint has scrolled away; Doctor's
   *   `diagnostics` row is the other.
   */
  function applyDebugCommand(rawArgs: string): void {
    const arg = rawArgs.trim().toLowerCase();
    const before = deps.debugSession.status();
    if (arg === "off") {
      const closed = deps.debugSession.close();
      if (closed !== null) notify(`diagnostics closed ${glyph("emDash")} ${closed}`);
      else if (before.open)
        notify("diagnostics were opened with --debug and close with the app", "warn");
      else notify("diagnostics are not open");
      return;
    }
    if (arg !== "" && !isDiagnosticLevel(arg)) {
      notify(`unknown level '${arg}' ${glyph("emDash")} use error, warn, info or debug`, "warn");
      return;
    }
    const opened = deps.debugSession.open(arg === "" ? undefined : arg);
    notify(`diagnostics at ${opened.level} ${glyph("emDash")} ${opened.path}`);
    // The kernel is handed its logger once, at construction. A session opened
    // after that point therefore carries this UI's own events and nothing the
    // kernel writes; say so rather than let the file read as the whole story.
    if (!opened.retuned)
      notify("kernel records need a relaunch with --debug; this session has the UI's own", "warn");
  }

  commands.registerAction({
    name: "diagnostics.debug",
    title: "Diagnostics",
    desc: "Open, retune or close the bounded diagnostic log",
    slash: "/debug",
    surface: "slash",
    group: "actions",
    args: [
      {
        name: "level",
        description: "off, or one of error, warn, info, debug",
        required: false,
      },
    ],
    run: () => applyDebugCommand(deps.takeSlashArgs()),
  });

  /**
   * Approve or revoke this repository's executable configuration.
   *
   * @remarks
   * The recovery path for a workspace whose Environment, `hooks`, `mcpServers`,
   * `enabledPlugins`, `marketplaces` or `.clarvis/agents/*.md` are being
   * withheld. Without it the only way back is hand-editing
   * `~/.clarvis/workspace-trust.json`, which is not a product.
   *
   * It reports what is being withheld before acting, and refuses to pretend
   * there is anything to approve for the overwhelming majority of repositories,
   * which declare nothing executable at all.
   */
  commands.registerAction({
    name: "workspace.trust",
    title: "Workspace trust",
    desc: "Review and approve this repository's executable extensions and configuration",
    slash: "/workspace-trust",
    surface: "slash",
    group: "actions",
    run: () => {
      const state = deps.settings.workspaceTrust();
      if (state === "inert") {
        notify("this workspace asks to run nothing; there is nothing to approve");
        return;
      }
      if (state === "trusted") {
        void deps.settings.setWorkspaceTrust(false).then(
          () => {
            notify(
              "workspace approval revoked; its Environment, hooks, servers and agents are withheld again",
            );
            recheck();
          },
          (e: unknown) => notify(errorText(e), "warn"),
        );
        return;
      }
      openWorkspaceTrustPrompt();
    },
  });

  commands.registerAction({
    name: "guard.cycle",
    title: "Cycle guard mode",
    desc: `Cycle the guard mode: off ${glyph("arrowRight")} on ${glyph("arrowRight")} auto`,
    surface: "internal",
    group: "actions",
    run: () => effects.cycleGuardMode(),
  });
  commands.registerView({
    name: "storage.open",
    title: "Storage",
    desc: "Inspect Clarvis local storage and clean disposable artifacts",
    slash: "/storage",
    surface: "slash",
    group: "navigate",
    view: lazyView(async () => {
      const { StorageView } = await import("../views/config/StorageView.tsx");
      return (host) => StorageView(host, { storage: deps.storage, notify });
    }),
  });
  commands.registerView({
    name: "sessions.open",
    title: "Sessions",
    desc: "Resume, start new, or export a session",
    slash: "/sessions",
    surface: "slash",
    group: "navigate",
    parent: "sessions",
    view: lazyView(async () => {
      const { SessionsHub } = await import("../views/config/SessionsHub.tsx");
      return (host) =>
        SessionsHub(host, {
          sessions: deps.session.list,
          ...(deps.session.catalog === undefined ? {} : { catalog: deps.session.catalog }),
          now: () => Date.now(),
          statusLine: deps.session.statusLine,
          resume: (id) => {
            deps.session.resume(id);
            host.close();
          },
          ...(deps.session.resumeCatalog === undefined
            ? {}
            : {
                resumeCatalog: async (item: SessionCatalogItem) => {
                  await deps.session.resumeCatalog!(item);
                  host.close();
                },
              }),
          delete: deps.session.delete,
        });
    }),
  });
  commands.registerView({
    name: "workflows.open",
    title: "Workflows",
    desc: "Browse workflows and their manager " + glyph("arrowRight") + " agents tree",
    slash: "/workflow",
    surface: "slash",
    group: "navigate",
    view: lazyView(async () => {
      const { WorkflowsHub } = await import("../views/config/WorkflowsHub.tsx");
      return (host) =>
        WorkflowsHub(host, {
          list: () => deps.workflows.list(),
          get: (id) => deps.workflows.get(id),
          getRun: (id) => deps.getRun(id),
          delete: (id) => deps.workflows.delete(id),
          now: () => Date.now(),
          ...(deps.workflowActivity === undefined ? {} : { live: deps.workflowActivity }),
          openAgentPicker: () => {
            host.close();
            deps.effects.openAgentPicker(() =>
              queueMicrotask(() => commands.runCommand("workflows.open")),
            );
          },
        });
    }),
  });
  commands.registerAction({
    name: "transcript.diff",
    title: "Diff viewer",
    desc: "Open the focused/last diff full-screen",
    slash: "/diff",
    surface: "slash",
    group: "navigate",
    parent: "inspect",
    run: () => effects.openDiff(),
  });
  commands.registerAction({
    name: "plan.enableReview",
    title: "Require plan review",
    desc: "Require approval before executing plans in this workspace",
    slash: false,
    surface: "internal",
    group: "actions",
    run: async () => {
      try {
        await patchPlansSettings(deps.settings, "workspace", { mode: "review" });
        notify(
          `planning: approval required (workspace settings)${deps.runActive() ? ` ${glyph("emDash")} applies to the next run` : ""}`,
          "success",
        );
      } catch (error) {
        notify(`planning failed: ${errorText(error)}`, "error");
      }
    },
  });
  commands.registerAction({
    name: "plan.enableDefault",
    title: "Use normal planning",
    desc: "Return planning to the normal ungated mode in this workspace",
    slash: false,
    surface: "internal",
    group: "actions",
    run: async () => {
      try {
        await patchPlansSettings(deps.settings, "workspace", {
          mode: defaultPlansSettings().mode,
        });
        notify(
          `planning: default mode restored (workspace settings)${deps.runActive() ? ` ${glyph("emDash")} applies to the next run` : ""}`,
          "success",
        );
      } catch (error) {
        notify(`planning failed: ${errorText(error)}`, "error");
      }
    },
  });
  commands.registerAction({
    name: "planning.configure",
    title: "Planning mode",
    desc: "Choose whether plans run normally or require approval",
    slash: "/planning",
    surface: "slash",
    group: "actions",
    subcommands: [
      { name: "review", desc: "Require approval before a plan executes" },
      { name: "normal", desc: "Run plans without an approval gate" },
    ],
    route: (args) => {
      const mode = args.trim().split(/\s+/)[0];
      if (mode === "review") {
        commands.runCommand("plan.enableReview");
        return true;
      }
      if (mode === "normal") {
        commands.runCommand("plan.enableDefault");
        return true;
      }
      return false;
    },
    run: () => notify("choose /planning/review or /planning/normal"),
  });
  commands.registerAction({
    name: "plans.open",
    title: "Plans",
    desc: "Browse plan history",
    /**
     * `/plans` names the viewer; `/planning/<mode>` owns planning policy.
     *
     * @remarks It used to open the workspace's planning-approval mode, which
     *   created `<ws>/.clarvis/settings.json` — a persistent write into the
     *   user's repository — under a name that invites someone expecting to look
     *   at a plan. Keeping history and policy under distinct nouns makes both
     *   discoverable through hierarchical completion without ambiguous verbs.
     */
    slash: "/plans",
    surface: "slash",
    group: "navigate",
    parent: "inspect",
    run: () => effects.openPlan("history"),
  });
  commands.registerAction({
    name: "plan.open",
    title: "Plan details",
    desc: "Open the current or latest plan full-screen",
    slash: false,
    surface: "internal",
    group: "navigate",
    actionSurfaces: ["footer", "full-help"],
    footerLabel: "open plan",
    hintPriority: 55,
    hintGroup: "navigation",
    enabled: deps.hasAvailablePlan,
    run: () => effects.openPlan(),
  });
  commands.registerAction({
    name: "app.quit",
    title: "Quit",
    desc: "Quit Clarvis",
    slash: "/quit",
    surface: "slash",
    group: "actions",
    run: () => effects.quit({ confirm: false }),
  });

  commands.registerAction({
    name: "catalog.refresh",
    title: "Refresh model catalog",
    desc: "Pull the latest providers/models from models.dev",
    slash: "/refresh",
    surface: "slash",
    group: "actions",
    parent: "inspect",
    run: async () => {
      notify("refreshing models.dev catalog" + glyph("ellipsis"));
      const r = await deps.refreshModels();
      notify(
        `models.dev refreshed ${glyph("emDash")} ${r.providers} providers / ${r.models} models`,
        "success",
      );
    },
  });

  commands.registerView({
    name: "controls.open",
    title: "Run controls",
    desc: "Safety presets, sandbox, guard, memory and planning for the next run",
    surface: "internal",
    group: "navigate",
    parent: "settings",
    view: lazyView(async () => {
      const { RunControlsPanel } = await import("../views/config/RunControlsPanel.tsx");
      return (host) =>
        RunControlsPanel(host, {
          settings: deps.settings,
          guard: deps.guard,
          memory: deps.memoryMode,
          notify,
          runActive: deps.runActive,
          openSandbox: () => openWithReturn("sandbox.config", "controls.open", host.scope()),
        });
    }),
  });

  commands.registerView({
    name: "model.open",
    title: "Default model",
    desc: "Choose the default from every configured provider",
    slash: "/model",
    surface: "slash",
    group: "navigate",
    view: lazyView(async () => {
      const { ModelView } = await import("../views/config/ModelView.tsx");
      return (host) => {
        requestModelsCatalog();
        return ModelView(host, {
          settings: deps.settings,
          catalog: deps.catalog,
          notify,
          runActive: deps.runActive,
          ...(deps.inspectRunContext === undefined
            ? {}
            : { inspectContext: deps.inspectRunContext }),
          ...(deps.fitRunContext === undefined ? {} : { fitContext: deps.fitRunContext }),
        });
      };
    }),
  });

  commands.registerView({
    name: "effort.open",
    title: "Default effort",
    desc: "Choose the reasoning effort for the default model",
    slash: "/effort",
    surface: "slash",
    group: "navigate",
    view: lazyView(async () => {
      const { EffortView } = await import("../views/config/EffortView.tsx");
      return (host) => {
        requestModelsCatalog();
        return EffortView(host, {
          settings: deps.settings,
          catalog: deps.catalog,
          ...(deps.modelsService === undefined ? {} : { modelsService: deps.modelsService }),
          notify,
        });
      };
    }),
  });

  commands.registerView({
    name: "defaults.open",
    title: "Defaults",
    desc: "Vision and run budget defaults",
    surface: "internal",
    group: "navigate",
    parent: "settings",
    view: lazyView(async () => {
      const { DefaultsPanel } = await import("../views/config/DefaultsPanel.tsx");
      return (host) => DefaultsPanel(host, { settings: deps.settings, env, notify });
    }),
  });

  const pluginsStore = createPluginsStore(deps.plugins);
  const recomposePlugin = (ref: PluginRef) =>
    recomposeSelectedPlugin(
      deps.environments,
      deps.reconnectBackend,
      () => pluginsStore.reload(),
      ref,
    );
  const selectedLifecycleBlock = (ref: PluginRef) =>
    selectedPluginLifecycleBlock(deps.environments, deps.runActive, ref);

  const refOf = (plugin: {
    scope: "global" | "workspace";
    source: "agents" | "clarvis";
    name: string;
  }): PluginRef => ({
    scope: plugin.scope,
    source: plugin.source,
    name: plugin.name,
  });

  const samePluginRef = (left: PluginRef, right: PluginRef): boolean =>
    left.scope === right.scope && left.source === right.source && left.name === right.name;

  const persistPluginMembership = async (
    environment: ResolvedEnvironment,
    ref: PluginRef,
    include: boolean,
  ): Promise<void> => {
    if (environment.ref.scope === "builtin") {
      const current = deps.settings.read("global")?.enabledPlugins ?? [];
      if (!include && !current.some((candidate) => samePluginRef(candidate, ref))) {
        throw new Error(
          `${ref.scope}/${ref.source}/${ref.name} is selected outside global settings; configure a custom Environment before removing it`,
        );
      }
      const enabledPlugins = include
        ? [...current.filter((candidate) => candidate.name !== ref.name), ref]
        : current.filter((candidate) => !samePluginRef(candidate, ref));
      await deps.settings.write("global", { enabledPlugins });
      return;
    }
    if (environment.definition === undefined || environment.definition_revision === undefined) {
      throw new Error(`Environment ${environment.id} has no editable definition`);
    }
    const authoredRef = environment.ref as { scope: "global" | "workspace"; name: string };
    const plugins = include
      ? [...environment.definition.plugins.filter((candidate) => candidate.name !== ref.name), ref]
      : environment.definition.plugins.filter((candidate) => !samePluginRef(candidate, ref));
    const definition: EnvironmentDefinition = { ...environment.definition, plugins };
    if (environment.selection_origin === "cli") {
      if (include && environment.ref.scope === "workspace") {
        throw new Error(
          `restart without --env before installing into workspace Environment ${environment.id}`,
        );
      }
      await deps.environments.update({
        ref: authoredRef,
        definition,
        expected_revision: environment.definition_revision,
      });
      return;
    }
    const selectionScope = environment.selection_origin === "global" ? "global" : "workspace";
    const input = {
      ref: authoredRef,
      definition,
      expected_revision: environment.definition_revision,
      selection_scope: selectionScope,
    } as const;
    const preview = await deps.environments.previewComposition(input);
    await deps.environments.applyComposition(input, {
      preview_token: preview.token,
      ...(preview.requires_workspace_trust ? { approve_workspace: true } : {}),
    });
  };

  const marketplaceInstallPreflight = async (): Promise<ResolvedEnvironment> => {
    if (deps.runActive()) throw new Error("finish the active run before installing a plugin");
    const environment = await deps.environments.current();
    if (
      environment.ref.scope !== "builtin" &&
      (environment.definition === undefined || environment.definition_revision === undefined)
    ) {
      throw new Error(`Environment ${environment.id} cannot be edited for plugin activation`);
    }
    if (environment.selection_origin === "cli" && environment.ref.scope === "workspace") {
      throw new Error(
        `restart without --env before installing into workspace Environment ${environment.id}`,
      );
    }
    return environment;
  };

  const installAndActivatePlugin = async (
    url: string,
    source: "agents" | "clarvis",
    subdir?: string,
  ): Promise<string> => {
    const environment = await marketplaceInstallPreflight();
    const installed = await pluginsStore.install(url, subdir, source);
    const ref = refOf(installed);
    let membershipAccepted = false;
    try {
      await persistPluginMembership(environment, ref, true);
      membershipAccepted = true;
      const reconnect = await deps.reconnectBackend();
      if (!reconnect.ok) {
        await pluginsStore.reload();
        return `installed ${ref.scope}/${ref.source}/${ref.name}; activation takes effect after /reconnect (${reconnect.message})`;
      }
      await pluginsStore.reload();
      const active = pluginsStore.list().find((plugin) => samePluginRef(refOf(plugin), ref));
      const current = await deps.environments.current();
      return active?.enabled
        ? `installed and activated ${ref.scope}/${ref.source}/${ref.name} in ${current.id}`
        : `installed ${ref.scope}/${ref.source}/${ref.name}; ${current.id} is degraded and did not activate it`;
    } catch (error) {
      if (membershipAccepted) throw error;
      await deps.plugins.uninstall(ref).catch(() => undefined);
      await pluginsStore.reload().catch(() => undefined);
      throw error;
    }
  };

  const updatePlugin = async (plugin: PluginView): Promise<string> => {
    const ref = refOf(plugin);
    const blocked = await selectedLifecycleBlock(ref);
    if (blocked !== undefined) throw new Error(blocked);
    const updated = await pluginsStore.update(ref);
    const recomposed = await recomposePlugin(ref);
    return `updated ${plugin.scope}/${plugin.source}/${plugin.name}${updated.version ? ` to v${updated.version}` : ""}${recomposed === undefined ? "" : ` ${glyph("emDash")} ${recomposed}`}`;
  };

  const uninstallPlugin = async (plugin: PluginView): Promise<string> => {
    const ref = refOf(plugin);
    const blocked = await selectedLifecycleBlock(ref);
    if (blocked !== undefined) throw new Error(blocked);
    const environment = await deps.environments.current();
    if (environmentSelectsPlugin(environment, ref)) {
      await persistPluginMembership(environment, ref, false);
      const reconnect = await deps.reconnectBackend();
      if (!reconnect.ok) {
        return `deactivated ${plugin.scope}/${plugin.source}/${plugin.name}; reconnect before uninstalling (${reconnect.message})`;
      }
    }
    await pluginsStore.uninstall(ref);
    return `uninstalled ${plugin.scope}/${plugin.source}/${plugin.name}`;
  };

  commands.registerView({
    name: "environments.open",
    title: "Environment",
    desc: "Select and diagnose the active extension set",
    slash: false,
    surface: "internal",
    group: "navigate",
    parent: "extensions",
    view: lazyView(async () => {
      const { EnvironmentBrowser } = await import("../views/config/EnvironmentBrowser.tsx");
      return (host) =>
        EnvironmentBrowser(host, {
          environments: deps.environments,
          reconnect: deps.reconnectBackend,
          runActive: deps.runActive,
          notify,
          configure: (ref) => {
            extensionSetupInitialEnvironment = ref;
            extensionSetupInitialPlugin = undefined;
            openWithReturn("extensions.open", "environments.open", host.scope());
          },
        });
    }),
  });

  commands.registerView({
    name: "workspace.trust.prompt",
    title: "Workspace approval",
    desc: "Approve or revise a new executable workspace snapshot",
    slash: false,
    surface: "internal",
    group: "actions",
    parent: "extensions",
    view: lazyView(async () => {
      const { WorkspaceTrustPrompt } = await import("../views/config/WorkspaceTrustPrompt.tsx");
      return (host) =>
        WorkspaceTrustPrompt(host, {
          state: () => deps.settings.workspaceTrust(),
          fields: () => deps.settings.withheldWorkspaceFields(),
          environment: () => deps.environments.current(),
          approve: async () => {
            if (deps.runActive()) {
              throw new Error("finish the active run before approving a changed workspace");
            }
            await deps.settings.setWorkspaceTrust(true);
            await deps.refreshAgentProfiles();
            recheck();
          },
          review: () => {
            detachObserved(
              "workspace_trust_review",
              async () => {
                extensionSetupInitialEnvironment = (await deps.environments.current()).ref;
                extensionSetupInitialPlugin = undefined;
                host.close();
                const factory = commands.viewFactory("extensions.open");
                if (factory !== undefined) {
                  ui.openView("extensions.open", factory, { scope: preferredScope() });
                }
              },
              (error) => notify(errorText(error), "warn"),
            );
          },
          notify,
        });
    }),
  });

  commands.registerView({
    name: "capability-providers.open",
    title: "Feature backends",
    desc: "Select Memory, Plans and Tasks providers by scope",
    surface: "internal",
    group: "navigate",
    parent: "settings",
    view: lazyView(async () => {
      const { CapabilityProvidersPanel } =
        await import("../views/config/CapabilityProvidersPanel.tsx");
      return (host) => {
        detachObserved(
          "capability_provider_plugins_reload",
          () => pluginsStore.reload(),
          (e) => notify(errorText(e), "warn"),
        );
        return CapabilityProvidersPanel(host, {
          settings: deps.settings,
          plugins: pluginsStore.list,
          tasks: deps.tasks,
          notify,
          openPlugins: () =>
            openWithReturn("marketplace.open", "capability-providers.open", host.scope()),
        });
      };
    }),
  });

  commands.registerView({
    name: "marketplace.open",
    title: "Marketplace",
    desc: "Browse plugins from the official and added marketplaces",
    surface: "internal",
    group: "navigate",
    parent: "extensions",
    view: lazyView(async () => {
      const { MarketplaceBrowser } = await import("../views/config/MarketplaceBrowser.tsx");
      return (host) => {
        const store = pluginsStore;
        const [stamp, bump] = createSignal(0);
        const [loading, setLoading] = createSignal(false);
        const [environment, setEnvironment] = createSignal<string>();
        const installedNames = createMemo(() => store.list().map((p) => p.name));
        const market = createMarketplaceAdapter({
          urls: () => deps.settings.effective().marketplaces ?? [],
          installed: () => installedNames(),
          ...(deps.marketplaceDefaultUrls !== undefined
            ? { defaultUrls: deps.marketplaceDefaultUrls }
            : {}),
        });
        const reload = (): void => {
          setLoading(true);
          detachObserved(
            "marketplace_load",
            () =>
              Promise.all([store.reload(), market.load(), deps.environments.current()])
                .then(([, , current]) => setEnvironment(current.id))
                .finally(() => {
                  setLoading(false);
                  bump(stamp() + 1);
                }),
            (e) => notify(errorText(e), "warn"),
          );
        };
        reload();
        return MarketplaceBrowser(host, {
          listings: () => {
            stamp();
            return market.listings();
          },
          sources: () => {
            stamp();
            return market.sources();
          },
          plugins: store.list,
          environment,
          loading,
          install: (listing) => installAndActivatePlugin(listing.source, "agents", listing.path),
          installUrl: (url, source) => installAndActivatePlugin(url, source),
          configure: (plugin) =>
            detachObserved(
              "marketplace_environment_configure",
              async () => {
                extensionSetupInitialEnvironment = (await deps.environments.current()).ref;
                extensionSetupInitialPlugin = refOf(plugin);
                openWithReturn("extensions.open", "marketplace.open", host.scope());
              },
              (error) => notify(errorText(error), "warn"),
            ),
          update: updatePlugin,
          uninstall: uninstallPlugin,
          refresh: () => {
            market.refresh();
            notify("re-reading marketplaces");
            reload();
          },
          addSource: (url) => {
            addMarketplaceSource(deps.settings, url).then(
              (result) => {
                if (result.added) {
                  market.refresh();
                  reload();
                }
                notify(result.message, result.added ? "success" : "warn");
              },
              (e: unknown) => notify(errorText(e), "warn"),
            );
          },
          notify,
        });
      };
    }),
  });

  commands.registerView({
    name: "memory.config",
    title: "Memory settings",
    desc: "Enable and configure execution memory (create the block, model, on/off)",
    surface: "internal",
    group: "navigate",
    parent: "settings",
    view: lazyView(async () => {
      const { MemoryConfigPanel } = await import("../views/config/MemoryConfigPanel.tsx");
      return (host) =>
        MemoryConfigPanel(host, {
          settings: deps.settings,
          memoryMode: deps.memoryMode,
          notify,
        });
    }),
  });

  commands.registerView({
    name: "sandbox.config",
    title: "Sandbox",
    desc: "Enable, disable and configure native command isolation",
    surface: "internal",
    group: "navigate",
    parent: "settings",
    view: lazyView(async () => {
      const { SandboxConfigPanel } = await import("../views/config/SandboxConfigPanel.tsx");
      return (host) => SandboxConfigPanel(host, { settings: deps.settings, notify });
    }),
  });

  commands.registerView({
    name: "theme.open",
    title: "Theme",
    desc: "Colors, presets, contrast " + glyph("emDash") + " live preview",
    surface: "internal",
    group: "navigate",
    parent: "settings",
    view: lazyView(async () => {
      const { ThemeView } = await import("../views/config/ThemeView.tsx");
      return (host) =>
        ThemeView(host, {
          preview: deps.preview,
          platform: deps.platform,
          code: deps.code,
          notify,
        });
    }),
  });

  let startKeyboardDiagnostic = false;
  commands.registerView({
    name: "keyboard.open",
    title: "Keyboard",
    desc: "Keyboard profiles, terminal compatibility and diagnostics",
    surface: "internal",
    group: "navigate",
    parent: "settings",
    view: lazyView(async () => {
      const { KeyboardView } = await import("../views/config/KeyboardView.tsx");
      return (host) => {
        const startDiagnostic = startKeyboardDiagnostic;
        startKeyboardDiagnostic = false;
        return KeyboardView(host, { code: deps.code, notify, startDiagnostic });
      };
    }),
  });

  commands.registerView({
    name: "settings.open",
    title: "Settings",
    desc: "Providers, agents, defaults, memory, sandbox, theme and run controls",
    slash: "/settings",
    surface: "slash",
    group: "navigate",
    subcommands: hubSubcommands(SETTINGS_ITEMS),
    route: hubRoute(SETTINGS_ITEMS, "settings.open"),
    view: lazyView(async () => {
      const { SettingsHub } = await import("../views/config/SettingsHub.tsx");
      return (host) =>
        SettingsHub(host, {
          openChild: (cmd) => openWithReturn(cmd, "settings.open", preferredScope()),
        });
    }),
  });

  const [sandboxInspection, setSandboxInspection] = createSignal<Awaited<
    ReturnType<SettingsAdapter["inspectSandbox"]>
  > | null>(null);
  let sandboxRequest = 0;
  const refreshSandboxInspection = async (refresh = false): Promise<void> => {
    const request = ++sandboxRequest;
    try {
      const inspection = await deps.settings.inspectSandbox({ refresh });
      if (!disposed && request === sandboxRequest) setSandboxInspection(inspection);
    } catch {
      if (!disposed && request === sandboxRequest) setSandboxInspection(null);
    }
  };
  const [subscriptionReadiness, setSubscriptionReadiness] = createSignal<
    Partial<Record<SubscriptionScheme, { state: SubscriptionState; entitled?: boolean }>>
  >({});
  let subscriptionRequest = 0;
  const refreshSubscriptionReadiness = async (): Promise<void> => {
    const request = ++subscriptionRequest;
    if (deps.providerAuth === undefined) return;
    const statuses = await deps.providerAuth.list();
    const next: Partial<
      Record<SubscriptionScheme, { state: SubscriptionState; entitled?: boolean }>
    > = {};
    await Promise.all(
      statuses.map(async (status) => {
        if (status.state !== "connected" || deps.modelsService === undefined) {
          next[status.scheme] = { state: status.state };
          return;
        }
        try {
          const catalog = await deps.modelsService.getEntitled(status.scheme);
          next[status.scheme] = { state: status.state, entitled: catalog.models.length > 0 };
        } catch {
          next[status.scheme] = { state: status.state, entitled: false };
        }
      }),
    );
    if (!disposed && request === subscriptionRequest) setSubscriptionReadiness(next);
  };
  const doctorCtx: DoctorCtx = {
    settings: deps.settings,
    agents: {
      list: () => deps.agentFiles.list(),
      conflicts: () => deps.agentFiles.conflicts(),
    },
    code: deps.code,
    env,
    backend: deps.backend,
    sandboxInspection,
    subscriptionReadiness,
  };
  const [recheckRev, setRecheckRev] = createSignal(0);
  const recheck = (): void => {
    setRecheckRev((v) => v + 1);
  };
  const inspectReadiness = (): void => {
    recheck();
    detachObserved(
      "sandbox_reinspection",
      () => refreshSandboxInspection(true).then(() => setRecheckRev((v) => v + 1)),
      (e) => deps.notify(errorText(e), "warn"),
    );
    detachObserved(
      "subscription_reinspection",
      () => refreshSubscriptionReadiness().then(() => setRecheckRev((v) => v + 1)),
      (e) => deps.notify(errorText(e), "warn"),
    );
  };
  const report = createMemo(() => {
    recheckRev();
    return runGates(doctorCtx);
  });
  const doctorDirty = createMemo(() =>
    report().gates.some(
      (g) =>
        (g.severity === "hard" || g.severity === "soft") &&
        report().results[g.id].status !== "pass",
    ),
  );

  commands.registerAction({
    name: "backend.reconnect",
    title: "Reconnect backend",
    desc: "Rebuild the kernel with fresh env and saved keys",
    slash: "/reconnect",
    surface: "slash",
    group: "actions",
    parent: "inspect",
    run: async () => {
      notify("reconnecting backend" + glyph("ellipsis"));
      const r = await deps.reconnectBackend();
      notify(r.message, r.ok ? "success" : "error");
      recheck();
    },
  });

  const FIX_VIEW_CMD: Record<
    "providers" | "model" | "defaults" | "theme" | "agents" | "memory" | "controls",
    string
  > = {
    providers: "providers.open",
    model: "model.open",
    defaults: "defaults.open",
    theme: "theme.open",
    agents: "agents.open",
    memory: "memory.config",
    controls: "controls.open",
  };
  function openFixView(
    view: "providers" | "model" | "defaults" | "theme" | "agents" | "memory" | "controls",
    scope: Scope,
    returnCmd = "doctor.open",
  ): void {
    openWithReturn(FIX_VIEW_CMD[view], returnCmd, scope);
  }

  commands.registerView({
    name: "doctor.open",
    title: "Doctor",
    desc: "Checks, diagnostics and guided fixes",
    slash: "/doctor",
    surface: "slash",
    group: "navigate",
    parent: "inspect",
    view: lazyView(async () => {
      const { DoctorView } = await import("../views/config/DoctorView.tsx");
      return (host) =>
        DoctorView(host, {
          ctx: doctorCtx,
          report,
          recheck: inspectReadiness,
          openFix: openFixView,
          startAnyway: () => host.close(),
          keys: deps.keys,
          notify,
          openKeyboard: () => {
            startKeyboardDiagnostic = true;
            openWithReturn("keyboard.open", "doctor.open", preferredScope());
          },
        });
    }),
  });

  const [setupState, setSetupState] = createSignal<SetupState>({
    phase: "welcome",
    detail: "Choose a provider and model to continue.",
  });
  let setupReconnectRequired = false;
  let setupRunning = false;

  /** Seed the ordinary Clarvis defaults only after setup has created settings.json. */
  async function seedSetupDefaults(): Promise<void> {
    await seedPlansBlock(deps.settings);
    const memory = await seedMemoryBlock(deps.settings);
    if (memory.seeded) {
      deps.memoryMode.refresh();
      deps.memoryMode.setMode("on");
    }
    await seedDefaultAllowlist(deps.settings);
  }

  /** Finish an idempotent first-run setup and publish the resulting agent fleet live. */
  async function prepareSetup(): Promise<void> {
    if (setupRunning) return;
    setupRunning = true;
    setSetupState((state) => ({
      ...state,
      phase: "preparing",
      detail: "Setting up Clarvis defaults" + glyph("ellipsis"),
    }));
    try {
      await seedSetupDefaults();
      if (setupReconnectRequired) {
        const reconnect = await deps.reconnectBackend();
        if (!reconnect.ok) throw new Error(reconnect.message);
      } else {
        await deps.refreshAgentProfiles();
      }
      if (!deps.agents.list().some((agent) => agent.name === DEFAULT_AGENT_NAME))
        throw new Error(`the ${DEFAULT_AGENT_NAME} profile did not become available`);
      deps.agents.setDefault(DEFAULT_AGENT_NAME, "global");
      deps.agents.setActive(DEFAULT_AGENT_NAME);
      recheck();
      if (bootGate(report()) !== "shell")
        throw new Error("a required configuration check is still unresolved");
      setSetupState((state) => ({
        phase: "ready",
        detail: "Clarvis is ready.",
        model: state.model ?? deps.settings.effective().default_model,
        agent: DEFAULT_AGENT_NAME,
      }));
    } catch (error) {
      setSetupState((state) => ({
        ...state,
        phase: "error",
        detail: errorText(error),
      }));
    } finally {
      setupRunning = false;
    }
  }

  commands.registerView({
    name: "setup.providers",
    title: "Connect a model",
    desc: "Choose the first provider and model",
    slash: false,
    surface: "internal",
    group: "navigate",
    view: lazyView(async () => {
      const [{ ProvidersPanel }] = await Promise.all([
        import("../views/config/ProvidersPanel.tsx"),
        deps.loadCatalog?.() ?? Promise.resolve(),
      ]);
      return (host) => {
        return ProvidersPanel(host, {
          settings: deps.settings,
          catalog: deps.catalog,
          modelsService: deps.modelsService,
          providerAuth: deps.providerAuth,
          copyText: (text) => deps.platform.copyText(text),
          ...(deps.platform.openUrl === undefined
            ? {}
            : { openUrl: (url: string) => deps.platform.openUrl!(url) }),
          keys: deps.keys,
          code: deps.code,
          notify,
          bootstrap: true,
          onBootstrapComplete: ({ model, reconnectRequired }) => {
            setupReconnectRequired = reconnectRequired;
            setSetupState({ phase: "preparing", detail: "Saving provider configuration", model });
            detachObserved("finish_clarvis_setup", prepareSetup, (error) =>
              setSetupState({ phase: "error", detail: errorText(error), model }),
            );
          },
        });
      };
    }),
  });

  commands.registerView({
    name: "setup.open",
    title: "Set up Clarvis",
    desc: "First-run Clarvis setup",
    slash: false,
    surface: "internal",
    group: "navigate",
    view: lazyView(async () => {
      const { SetupView } = await import("../views/onboarding/SetupView.tsx");
      return (host) =>
        SetupView(host, {
          state: setupState,
          begin: () => {
            const configured =
              (deps.settings.effective().providers?.length ?? 0) > 0 &&
              deps.settings.effective().default_model !== undefined;
            if (configured) {
              detachObserved("resume_clarvis_setup", prepareSetup);
              return;
            }
            host.dispatch("setup.providers");
          },
          retry: () => detachObserved("retry_clarvis_setup", prepareSetup),
          finish: () => {
            host.close();
            const trust = deps.settings.workspaceTrust();
            if (trust === "unapproved" || trust === "changed") {
              queueMicrotask(openWorkspaceTrustPrompt);
            }
          },
        });
    }),
  });

  const blockingGates = (): Gate[] =>
    report().gates.filter((gate) => {
      const status = report().results[gate.id].status;
      return gate.severity === "hard"
        ? status === "fail"
        : gate.severity === "soft" && status !== "pass";
    });
  const recoveryIssue = (): StartupIssue | undefined => {
    const gate = blockingGates()[0];
    if (!gate) return undefined;
    const result = report().results[gate.id];
    return {
      label: gate.label,
      detail: result.detail,
      ...(result.hint ? { hint: result.hint } : {}),
    };
  };

  /** Apply a corrupt-config repair without routing the startup user through full Doctor. */
  function repairStartupSettings(host: ViewHost, scope: Scope): void {
    detachObserved(
      "recovery_repair_settings",
      async () => {
        const plan = await deps.settings.planRepair(scope);
        if (!plan) {
          notify("settings are valid " + glyph("emDash") + " nothing to repair");
          recheck();
          return;
        }
        const request =
          plan.action === "strip"
            ? {
                message: `strip invalid keys from ${scope} settings.json?`,
                detail: [plan.path, `drops: ${plan.dropped.join(", ")}`],
                danger: true,
              }
            : {
                message: `reset ${scope} settings.json to {}? its contents cannot be parsed`,
                detail: [plan.path, plan.reason],
                danger: true,
              };
        if (!(await host.confirm(request))) return;
        await deps.settings.applyRepair(plan);
        notify(
          plan.action === "strip"
            ? `settings repaired ${glyph("emDash")} dropped ${plan.dropped.join(", ")}`
            : `settings reset ${glyph("emDash")} ${plan.path} is now {}`,
        );
        recheck();
        if (startupRoute(doctorCtx, report()) === "setup") host.dispatch("setup.open");
      },
      (error) => {
        notify(`repair failed: ${errorText(error)}`, "warn");
        recheck();
      },
    );
  }

  commands.registerView({
    name: "recovery.open",
    title: "Repair Clarvis",
    desc: "Repair a configuration that cannot start runs",
    slash: false,
    surface: "internal",
    group: "navigate",
    view: lazyView(async () => {
      const { RecoveryView } = await import("../views/onboarding/RecoveryView.tsx");
      return (host) =>
        RecoveryView(host, {
          issue: recoveryIssue,
          ready: () => bootGate(report()) === "shell",
          onReady: () => host.close(),
          resolve: () => {
            const gate = blockingGates()[0];
            if (!gate) return;
            const fix = report().results[gate.id].fix ?? gate.fix;
            if (fix?.kind === "view") {
              openFixView(fix.view, preferredScope(), "recovery.open");
              return;
            }
            if (fix?.kind === "set-key") {
              openFixView("providers", preferredScope(), "recovery.open");
              return;
            }
            if (fix?.kind === "reconnect") {
              host.dispatch("backend.reconnect");
              return;
            }
            if (fix?.kind === "repair-settings") {
              repairStartupSettings(host, fix.scope);
              return;
            }
            openWithReturn("doctor.open", "recovery.open", preferredScope());
          },
          openDoctor: () => openWithReturn("doctor.open", "recovery.open", preferredScope()),
        });
    }),
  });

  const mcpEffects: McpEffects = {
    submitPromptTurn: (messages, display, skill) => deps.onSubmitPrompt(messages, display, skill),
    submitSkillRun: (name, task, agent) => deps.onSubmitSkillRun(name, task, agent),
    activeProfile: () => deps.agents.active(),
    openMcpServers: (server) => {
      // The real global settings path, not a guess at where the home is:
      // CLARVIS_HOME moves it, and naming `~/.clarvis` sent the user to a file
      // that does not exist on any host that sets it.
      const path = deps.settings.sources().global || "settings.json";
      notify(
        server
          ? `mcp servers: ${path} ${glyph("arrowRight")} "mcpServers" ${glyph("arrowRight")} "${server}" (in-app editor planned)`
          : `mcp servers: ${path} ${glyph("arrowRight")} "mcpServers" (in-app editor planned)`,
      );
    },
    collectArgs: (_server: string, prompt: LivePrompt) => {
      const specs = prompt.arguments ?? [];
      const values = splitSlashArgs(deps.takeSlashArgs(), specs.length);
      const args: Record<string, string> = {};
      specs.forEach((spec, i) => {
        const value = values[i];
        if (value !== undefined && value.length > 0) args[spec.name] = value;
      });
      const missing = specs.filter((s) => s.required && args[s.name] === undefined);
      if (missing.length > 0) {
        notify(
          `/${prompt.name} needs ${missing.map((m) => `<${m.name}>`).join(" ")} ${glyph("emDash")} type the arguments after the command`,
          "warn",
        );
        return Promise.resolve(null);
      }
      return Promise.resolve(args);
    },
  };
  const mcpCaps = createMcpCapabilities({
    client: deps.mcpClient,
    commands,
    effects: mcpEffects,
    declared: () => deps.settings.declaredMcpServers(),
    profiles: () => deps.agents.list().map((v) => v.name),
  });
  const backendConnected = createMemo(() => deps.connection().phase === "ready");
  createEffect(() => {
    backendConnected();
    void mcpCaps
      .refresh()
      .catch((e: unknown) => notify(`mcp refresh failed: ${errorText(e)}`, "error"));
  });
  commands.registerView({
    name: "mcp.browse",
    title: "MCP",
    desc: "Browse servers, tools and prompts (read-only)",
    slash: false,
    surface: "internal",
    group: "navigate",
    parent: "extensions",
    view: lazyView(async () => {
      const { McpBrowser } = await import("../views/config/McpBrowser.tsx");
      return (host) =>
        McpBrowser(host, {
          nodes: mcpCaps.nodes,
          refresh: () => mcpCaps.refresh(),
          editConfig: (server) => mcpEffects.openMcpServers(server),
          notify,
        });
    }),
  });

  commands.registerView({
    name: "extensions.open",
    title: "Extensions",
    desc: "Guided discovery, composition, capability review and activation",
    slash: "/extensions",
    surface: "slash",
    group: "navigate",
    view: lazyView(async () => {
      const { ExtensionsHub } = await import("../views/config/ExtensionsHub.tsx");
      return (host) => {
        const initialEnvironment = extensionSetupInitialEnvironment;
        const initialPlugin = extensionSetupInitialPlugin;
        extensionSetupInitialEnvironment = undefined;
        extensionSetupInitialPlugin = undefined;
        const [stamp, setStamp] = createSignal(0);
        const [loading, setLoading] = createSignal(false);
        const [loadError, setLoadError] = createSignal<string>();
        const [definitions, setDefinitions] = createSignal<
          Awaited<ReturnType<EnvironmentService["list"]>>
        >([]);
        const [inventory, setInventory] =
          createSignal<Awaited<ReturnType<EnvironmentService["inventory"]>>>();
        const [environment, setEnvironment] = createSignal<ResolvedEnvironment>();
        const installedNames = createMemo(() => pluginsStore.list().map((plugin) => plugin.name));
        const market = createMarketplaceAdapter({
          urls: () => deps.settings.effective().marketplaces ?? [],
          installed: installedNames,
          ...(deps.marketplaceDefaultUrls === undefined
            ? {}
            : { defaultUrls: deps.marketplaceDefaultUrls }),
        });
        let disposed = false;
        let refreshActive: Promise<void> | undefined;
        let refreshQueued = false;
        let inventoryLoaded = false;

        onCleanup(() => {
          disposed = true;
        });

        const refreshOnce = async (refreshInventory: boolean): Promise<void> => {
          setLoading(true);
          try {
            await pluginsStore.reload();
            const nextInventory =
              refreshInventory || !inventoryLoaded
                ? deps.environments.inventory()
                : Promise.resolve(undefined);
            const [nextDefinitions, nextEnvironment, refreshedInventory] = await Promise.all([
              deps.environments.list(),
              deps.environments.current(),
              nextInventory,
              market.load(),
            ]);
            if (disposed) return;
            setDefinitions(nextDefinitions);
            setEnvironment(nextEnvironment);
            if (refreshedInventory !== undefined) {
              setInventory(refreshedInventory);
              inventoryLoaded = true;
            }
            setLoadError(undefined);
            setStamp((value) => value + 1);
          } catch (error) {
            if (!disposed) setLoadError(errorText(error));
            throw error;
          } finally {
            if (!disposed) setLoading(false);
          }
        };

        const refresh = (refreshInventory = false): Promise<void> => {
          if (refreshActive !== undefined) {
            refreshQueued = refreshQueued || refreshInventory;
            return refreshActive;
          }
          refreshActive = (async () => {
            let inventory = refreshInventory;
            do {
              refreshQueued = false;
              await refreshOnce(inventory);
              inventory = refreshQueued;
            } while (refreshQueued && !disposed);
          })().finally(() => {
            refreshActive = undefined;
          });
          return refreshActive;
        };

        detachObserved(
          "extensions_catalog_load",
          () => refresh(true),
          (error) => notify(errorText(error), "warn"),
        );

        const listings = (): ReturnType<typeof market.listings> => {
          stamp();
          return market.listings();
        };
        const sources = (): ReturnType<typeof market.sources> => {
          stamp();
          return market.sources();
        };

        return ExtensionsHub(host, {
          environments: deps.environments,
          definitions,
          inventory,
          current: environment,
          listings,
          sources,
          loading,
          loadError,
          install: (listing, source) => pluginsStore.install(listing.source, listing.path, source),
          refresh: async (refreshInventory = false) => {
            market.refresh();
            await refresh(refreshInventory);
          },
          reconnect: deps.reconnectBackend,
          runActive: deps.runActive,
          notify,
          openChild: (cmd) => openWithReturn(cmd, "extensions.open", preferredScope()),
          ...(initialEnvironment === undefined ? {} : { initialEnvironment }),
          ...(initialPlugin === undefined ? {} : { initialPlugin }),
        });
      };
    }),
  });

  onMount(() => {
    detachObserved(
      "seed_plans_settings",
      () =>
        seedPlansBlock(deps.settings).then((outcome) => {
          if (!outcome.seeded) return;
          notify(
            `planning: on ${glyph("separator")} keep plans (${outcome.scope} settings) ${glyph("emDash")} change it in Run controls`,
          );
          recheck();
        }),
      (e) => notify(errorText(e), "warn"),
    );
    detachObserved(
      "seed_memory_settings",
      () =>
        seedMemoryBlock(deps.settings).then((outcome) => {
          if (!outcome.seeded) return;
          deps.memoryMode.refresh();
          deps.memoryMode.setMode("on");
          notify(
            `memory: on (${outcome.scope} settings) ${glyph("emDash")} change it in Memory settings`,
          );
          recheck();
        }),
      (e) => notify(errorText(e), "warn"),
    );
    detachObserved(
      "seed_default_allowlist",
      () =>
        seedDefaultAllowlist(deps.settings).then((outcome) => {
          if (!outcome.seeded) return;
          notify(
            `guard: seeded ${outcome.count} allowed commands (${outcome.scope} settings) ${glyph("emDash")} edit them in settings`,
          );
          recheck();
        }),
      (e) => notify(errorText(e), "warn"),
    );
    const route = startupRoute(doctorCtx, report());
    if (route === "shell") {
      const trust = deps.settings.workspaceTrust();
      if (trust === "unapproved" || trust === "changed") openWorkspaceTrustPrompt();
      return;
    }
    const name = route === "setup" ? "setup.open" : "recovery.open";
    const factory = commands.viewFactory(name);
    if (factory) ui.openView(name, factory, { scope: preferredScope() });
  });

  return {
    doctorDirty,
    recheck: inspectReadiness,
    sandboxInspection,
    skillAgent: (name: string) => mcpCaps.skillAgent(name),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      sandboxRequest++;
      mcpCaps.dispose();
      commandScope.dispose();
    },
  };
}
