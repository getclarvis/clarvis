import type { Accessor, JSX } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  lazy,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from "solid-js";
import { useSelectionHandler, useTerminalDimensions } from "@opentui/solid";
import { KeymapProvider, reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import type {
  CliRenderer,
  MouseEvent,
  Renderable,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core";
import type { ElicitRequestParams, ElicitResult } from "../adapters/elicit-types.ts";
import type { MessageContent } from "@clarvis/protocol";
import { tokens } from "../theme/tokens.ts";
import { ruleColor } from "../theme/surfaces.ts";
import { borderChars, glyph } from "../theme/glyphs.ts";
import type { Platform } from "../adapters/platform.ts";
import type { DebugSessionController } from "../adapters/debug-session.ts";
import type { ActiveAgentStore } from "../adapters/active-agent.ts";
import type { AgentsStore } from "../adapters/agents-store.ts";
import type { SettingsAdapter } from "../adapters/settings.ts";
import { resolveContextWindow } from "../adapters/settings.ts";
import type { ModelsCatalog } from "../adapters/models-catalog.ts";
import type { ClarvisDirs } from "../adapters/agents.ts";
import type { KeysAdapter } from "../adapters/provider-secrets.ts";
import type { CodeConfigStore } from "../adapters/code-config.ts";
import { guardAutoResolves, type GuardMode, type GuardModeStore } from "../adapters/guard-mode.ts";
import type { MemoryModeStore } from "../adapters/memory-mode.ts";
import type { WorkflowActivity } from "../adapters/workflow-projection.ts";
import { deriveRunControls } from "../adapters/execution-safety.ts";
import type { ThemePreview } from "../theme/theme.ts";
import { readEnvView } from "../adapters/agent-files.ts";
import { registerCodeCommands } from "../app/command-composition.ts";
import type { BackendProbe } from "../onboarding/doctor.ts";
import type { ConnectionState } from "../adapters/connection-state.ts";
import type { McpClientCaps } from "../adapters/mcp-capabilities-bridge.ts";
import type {
  ModelCatalogService,
  EnvironmentService,
  PlansService,
  PluginService,
  ProviderAuthService,
  SkillsService,
  RunDetail,
  StorageService,
  WorkflowsService,
} from "@clarvis/protocol";
import type { PromptMessage } from "../adapters/mcp-capabilities.ts";
import type { PlansMode } from "@clarvis/protocol";
import type { TranscriptStore, TranscriptToolNode } from "../adapters/store.ts";
import type { ActivityStore } from "../adapters/activity-store.ts";
import type { SessionId, SessionMeta } from "../adapters/session-store.ts";
import type { PromptHistory } from "../core/prompt-history.ts";
import type { RunHost } from "../run-host.ts";
import type { TasksController } from "../features/tasks/controller.ts";
import type { SessionCatalogItem } from "./config/SessionsHub.tsx";
import { createInteraction, type InteractionEffects } from "../keys/interaction.ts";
import { uiCommand } from "../keys/actions.ts";
import { commandKeyLabel, LAYER } from "../keys/keyspec.ts";
import { createCommands, type CommandEffects } from "../keys/commands.ts";
import {
  classifySlashSubmit,
  type CompleteItem,
  type CompleteProvider,
} from "./input/autocomplete.ts";
import { fuzzyFilter } from "../core/fuzzy.ts";
import { createCommandCompletionProvider } from "./input/command-completion.ts";
import { capitalize } from "./blocks.tsx";
import { projectHeader } from "./header-projection.ts";
import { HeaderRows } from "./HeaderRows.tsx";
import { createTranscriptState } from "./transcript-state.ts";
import { createOverlayHost } from "./overlay-host.ts";
import { createHintState, type HintTone } from "./hint.ts";
import { createQuitConfirm } from "./quit-confirm.ts";
import { formatElapsed, tickNow, useSpinnerClock } from "./spinner.ts";
import { runStripText } from "../features/run/status-presenter.ts";
import { errorText } from "../adapters/errors.ts";
import { Footer, HintToast, LeadActivityLine, type LeadActivityPhase } from "./Footer.tsx";
import { FLOAT_Z } from "./overlays/FloatFrame.tsx";
import { InputDock, type SlashOutcome } from "./InputDock.tsx";
import { ProfilePicker, type AgentDefaults } from "./overlays/ProfilePicker.tsx";
import { createLayoutController, FLOOR_MIN_COLUMNS, FLOOR_MIN_ROWS } from "../app/layout.ts";
import { OverlayRegion, overlayFallbackActive } from "./app/OverlayRegion.tsx";
import { TranscriptRegion } from "./app/TranscriptRegion.tsx";
import type { CommittedHistoryHandle } from "./history/CommittedHistory.tsx";
import { NavigationBar } from "../ui/patterns/navigation-bar.tsx";
import { isAvailablePlan, isLivePlan } from "../adapters/plan-projection.ts";
import { bindSyntaxStyleRenderer } from "../theme/syntax.ts";
import {
  createMemoryPressureController,
  memoryPressureAllowsSlash,
  tuiRssLimitBytes,
  type MemoryPressurePhase,
} from "../adapters/memory-pressure.ts";
import { ActivityDetail } from "./overlays/ActivityDetail.tsx";
import type { ActivityDetail as ActivityDetailValue } from "./activity-detail.ts";
import { WorktreeExitPrompt } from "./overlays/WorktreeExitPrompt.tsx";
import { detachObserved } from "../core/tasks.ts";
import { activeDiagnosticLogger } from "../core/diagnostic-events.ts";
import { SurfaceBoundary, SurfacePortal } from "../ui/patterns/surface-lifecycle.tsx";

const SafetyPresetPicker = lazy(async () => {
  const module = await import("./overlays/SafetyPresetPicker.tsx");
  return { default: module.SafetyPresetPicker };
});

/** Minimal painted alpha that lets OpenTUI hit-test the pointer blocker without hiding the UI. */
const POINTER_BLOCKER_BG = "#00000001";

/** Count the current OpenTUI tree without retaining a second node index. */
function countRenderables(root: Renderable): number {
  let count = 1;
  for (const child of root.getChildren()) count += countRenderables(child);
  return count;
}

/** Prevents queued replacement-time pointer input from reaching the retained application tree. */
function consumePointerEvent(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function executionContext(key: string): string {
  const boundary = key.indexOf("::");
  return boundary < 0 ? key : key.slice(0, boundary);
}

/** Identifies the execution that owns the first sub-agent in the current activity roster. */
function visibleSubagentContext(store: TranscriptStore, activity: ActivityStore): string | null {
  const first = activity.subagents[0];
  if (first === undefined) return null;
  for (let index = store.nodes.length - 1; index >= 0; index -= 1) {
    const node = store.nodes[index];
    if (node?.subagentId !== first.id) continue;
    return executionContext(node.key);
  }
  return null;
}

/** Identifies the execution that owns the current live Plan projection. */
function visiblePlanContext(store: TranscriptStore, activity: ActivityStore): string | null {
  const plan = activity.plan;
  if (!isLivePlan(plan)) return null;
  const reference = plan.path ?? plan.id;
  for (let index = store.nodes.length - 1; index >= 0; index -= 1) {
    const node = store.nodes[index];
    if (node?.kind !== "plan" || node.text !== reference) continue;
    return executionContext(node.key);
  }
  return null;
}

/** Handles to the host renderer, platform bridge and workspace root the shell was booted with. */
export interface AppShell {
  renderer: CliRenderer;
  platform: Platform;
  /** Opens, retunes and closes the bounded diagnostic log for `/debug`. */
  debugSession: DebugSessionController;
  workspace: string;
  workspaceLabel?: string;
  branch?: string;
  files: () => string[];
  /** Queue non-visual startup work until the first usable application frame is idle. */
  afterPaint?(task: () => void): void;
  worktree?: {
    name: string;
    branch: string;
    isClean(): Promise<boolean>;
    requestRemoval(): Promise<void>;
  };
  quit: () => void;
}

/** The active run's live surface: submit/cancel/status plus the pending elicitation, if any. */
export interface AppRunControls {
  status: () => string;
  submit: (content: MessageContent) => void;
  submitPrompt: (
    messages: PromptMessage[],
    display?: string,
    skill?: { name: string; task?: string; plansMode?: PlansMode },
  ) => void;
  submitSkillRun: (name: string, task: string, agent: string) => void;
  compact: (request?: string) => void;
  inspectContext?: RunHost["inspectCurrentContext"];
  fitContext?: RunHost["fitCurrentContext"];
  cancel: () => boolean;
  /** Detach an unresponsive run after the memory fuse's cancellation grace. */
  forceStop?: () => void;
  active: () => boolean;
  /** True until every backend handle and local process has physically settled. */
  physicalActive?: () => boolean;
  /** Host-owned retained-memory and event-queue counters. */
  memory?: () => Record<string, number | boolean>;
  /** Epoch ms of the active run's start (null before the first run). */
  startedAt: () => number | null;
  /** The current (or last) workflow's live tree; null when not a workflow. */
  workflowActivity: Accessor<WorkflowActivity | null>;
  bang: (cmd: string) => boolean;
  localBusy: () => boolean;
  /** True while context compaction is awaiting hooks or a summary model call. */
  compacting?: () => boolean;
  /** Lets the host put a message back in the input (e.g. after a failed steer). */
  registerDraftRestore?: (fn: (text: string, content?: MessageContent) => void) => void;
  elicit: Accessor<ElicitRequestParams | null>;
  resolveElicit: (result: ElicitResult) => void;
  /** True while a fully booted workspace runtime is being prepared/published. */
  switching?: Accessor<boolean>;
}

/** Session history and lifecycle operations (list/resume/delete/export) exposed to the UI. */
export interface AppSessionControls {
  history: PromptHistory;
  list: () => SessionMeta[];
  catalog?: () => Promise<SessionCatalogItem[]>;
  resume: (id: SessionId) => unknown;
  resumeCatalog?: (item: SessionCatalogItem) => Promise<void> | void;
  delete: (item: SessionCatalogItem) => Promise<void>;
  clear: () => void;
  export: () => Promise<string>;
  statusLine: () => string;
  costLine: () => string;
  /** Cumulative token totals for the current session, retained after a run settles. */
  usage?: () => { input: number; output: number; cached?: number } | null;
}

/** The workspace's configuration surfaces — agents, settings, guard/memory mode, keys and the model catalog. */
export interface AppFleet {
  agents: ActiveAgentStore;
  agentFiles: AgentsStore;
  settings: SettingsAdapter;
  dirs: ClarvisDirs;
  code: CodeConfigStore;
  guard: GuardModeStore;
  memoryMode: MemoryModeStore;
  preview: ThemePreview;
  keys: KeysAdapter;
  /** A reactive catalog facade that stays empty until a catalog-backed surface opens. */
  catalog: ModelsCatalog | null;
  /** Single-flight on-demand loader for the models.dev snapshot. */
  loadCatalog: () => Promise<void>;
  refreshModels: () => Promise<{ providers: number; models: number }>;
  /** Reloads kernel profiles after agent files change, without restarting the TUI. */
  refreshAgentProfiles: () => Promise<void>;
}

/** The kernel-backed services the shell talks to: connection state, MCP client, plans/workflows and run lookup. */
export interface AppBackend {
  connection: Accessor<ConnectionState>;
  probe: Accessor<BackendProbe>;
  client: McpClientCaps;
  plans: Pick<PlansService, "read">;
  models: ModelCatalogService;
  providerAuth: ProviderAuthService;
  workflows: WorkflowsService;
  getRun: (id: string) => Promise<RunDetail | null>;
  plugins: PluginService;
  environments: EnvironmentService;
  skills: SkillsService;
  tasks: TasksController;
  storage: StorageService;
  reconnect: () => Promise<{ ok: boolean; message: string }>;
}

/** Everything {@link App} needs to render: transcript/activity state, shell handles and the run/session/fleet/backend controls. */
export interface AppProps {
  store: TranscriptStore;
  activity: ActivityStore;
  shell: AppShell;
  run: AppRunControls;
  session: AppSessionControls;
  fleet: AppFleet;
  backend: AppBackend;
  /** Draft typed into the startup composer before the complete application mounted. */
  initialDraft?: string;
}

/**
 * The application shell: wires transcript state, keymap interaction, overlays,
 * the header/footer/input dock and autocomplete providers around one running
 * agent session.
 *
 * @remarks Overlays reach the screen by two routes on purpose. A kind that owns
 *   the whole region (`view`, `diff`, `plan`) is rendered by
 *   {@link OverlayRegion}, which swaps out the transcript. A picker such as
 *   `agentPicker` is a floating `FloatFrame` card over its own dimming scrim, so
 *   it is mounted here as a sibling *after* the region and the transcript keeps
 *   rendering behind it — moving it into the region's switch would black out
 *   everything the scrim exists to show through.
 */
export function App(props: AppProps): JSX.Element {
  const releaseSyntaxStyles = bindSyntaxStyleRenderer(props.shell.renderer);
  onCleanup(releaseSyntaxStyles);
  const { hint, notify } = createHintState();
  const memoryPressure = createMemoryPressureController({
    limitBytes: tuiRssLimitBytes(process.env.CLARVIS_TUI_RSS_LIMIT_MB),
    isRunActive: props.run.active,
    cancelRun: props.run.cancel,
    ...(props.run.forceStop === undefined ? {} : { forceStopRun: props.run.forceStop }),
    reconnect: props.backend.reconnect,
    canCollect: () => !(props.run.physicalActive?.() ?? props.run.active()),
    gc: () => Bun.gc(true),
    ledgerEnabled: () => activeDiagnosticLogger() !== undefined,
    ledger: () => ({
      ...(props.store.memory?.() ?? {}),
      ...(props.run.memory?.() ?? {}),
      renderer_renderables: countRenderables(props.shell.renderer.root),
      renderer_lifecycle_passes: props.shell.renderer.getLifecyclePasses().size,
      renderer_frame_listeners: props.shell.renderer.listenerCount("frame"),
    }),
  });
  const [pressure, setPressure] = createSignal(memoryPressure.state());
  const unsubscribePressure = memoryPressure.subscribe(setPressure);
  onMount(() => memoryPressure.start());
  onCleanup(() => {
    memoryPressure.stop();
    unsubscribePressure();
  });
  let previousPressurePhase: MemoryPressurePhase = pressure().phase;
  let previousMemoryAdvisory = pressure().advisory;
  createEffect(() => {
    const state = pressure();
    const phase = state.phase;
    if (phase === "aborting" && previousPressurePhase !== "aborting")
      notify("RSS limit reached; active work was aborted and recovery is available", "error");
    if (state.advisory && !previousMemoryAdvisory)
      notify("Memory is rising above the healthy baseline; diagnostics captured a ledger", "warn");
    previousPressurePhase = phase;
    previousMemoryAdvisory = state.advisory;
  });
  const pressureBlocked = (): boolean =>
    ["aborting", "tripped", "recovering", "cooling"].includes(pressure().phase);
  const pressureBlockedReason = (): string | null =>
    pressureBlocked()
      ? "New work is blocked by the memory fuse; use /recover-memory or clear the transcript with /clear."
      : null;
  const recoverMemory = (): void => {
    memoryPressure
      .recover()
      .then((result) => notify(result.message, result.ok ? "success" : "warn"))
      .catch((error: unknown) => notify(`memory recovery failed: ${errorText(error)}`, "error"));
  };
  const refuseModelAction = (): boolean => {
    const reason = pressureBlockedReason();
    if (reason === null) return false;
    notify(reason, "warn");
    return true;
  };
  const term = useTerminalDimensions();
  const dims = (): { w: number; h: number } => ({ w: term().width, h: term().height });
  const sidebarHasContent = (): boolean =>
    props.activity.plan != null ||
    props.activity.subagents.length > 0 ||
    [...(props.run.workflowActivity()?.nodes.values() ?? [])].some((n) => n.kind === "leader");
  const layout = createLayoutController({
    dims,
    hasSidebarContent: sidebarHasContent,
  });
  const layoutMode = layout.layoutMode;
  const drawerOpen = layout.drawerOpen;
  const sidebarVisible = layout.sidebarVisible;
  const sidebarWidth = layout.sidebarWidth;
  const secondaryMode = layout.secondaryMode;
  const contentInset = layout.contentInset;
  const ts = createTranscriptState({
    nodes: () => props.store.committedNodes(),
    detailNodes: () => props.store.nodes,
    preserveOrder: true,
    subagents: () =>
      props.activity.subagents.map((w) => ({
        id: w.id,
        order: w.order,
        title: capitalize(w.title),
        status: w.status === "done" ? "ok" : w.status === "error" ? "error" : "running",
      })),
    notify,
    defaultFolded: (key) => props.store.defaultFolded(key),
    rehydrate: (key) => void props.store.rehydrate(key),
  });
  const [diffNode, setDiffNode] = createSignal<TranscriptToolNode | null>(null);
  useSpinnerClock(
    () => props.run.active() || props.run.localBusy() || props.run.compacting?.() === true,
  );
  let inputEl: TextareaRenderable | undefined;
  let dock:
    | {
        clearAttachments: () => void;
        restoreAttachments: (content: MessageContent) => void;
        popupOpen: () => boolean;
        expanded: () => boolean;
        closeEditor: () => void;
      }
    | undefined;
  const [editorExpanded, setEditorExpanded] = createSignal(false);
  const [inputPopupOpen, setInputPopupOpen] = createSignal(false);
  const [draftNonEmpty, setDraftNonEmpty] = createSignal(false);
  type TransientOverlay = "none" | "activityDetail" | "worktreeExit";
  const [transientOverlay, setTransientOverlay] = createSignal<TransientOverlay>("none");
  const [activityDetail, setActivityDetail] = createSignal<ActivityDetailValue | null>(null);
  let scrollEl: ScrollBoxRenderable | undefined;
  let historyHandle: CommittedHistoryHandle | undefined;
  let leadHistoryHandle: CommittedHistoryHandle | undefined;
  const submitFromLeadTail = (submit: () => void): void => {
    if (refuseModelAction()) return;
    const selected = ts.selectedSubagent();
    if (selected !== null) ts.toggleSubagent(selected);
    leadHistoryHandle?.returnToTail();
    submit();
  };
  type AutoSidebarIntent = "plan" | "workflow" | "agents";
  interface AutoSidebarState {
    context: string | null;
    opened: boolean;
    dismissed: boolean;
  }
  const autoSidebar: Record<AutoSidebarIntent, AutoSidebarState> = {
    plan: { context: null, opened: false, dismissed: false },
    workflow: { context: null, opened: false, dismissed: false },
    agents: { context: null, opened: false, dismissed: false },
  };
  const [sidebarReveal, setSidebarReveal] = createSignal<{
    section: AutoSidebarIntent;
    context: string;
  } | null>(null);
  let autoSidebarOwner: AutoSidebarIntent | null = null;

  const requestAutomaticSidebar = (intent: AutoSidebarIntent, context: string): void => {
    const state = autoSidebar[intent];
    if (state.context !== context) {
      state.context = context;
      state.opened = false;
      state.dismissed = false;
    }
    if (state.opened || state.dismissed) return;
    state.opened = true;
    autoSidebarOwner = intent;
    setSidebarReveal({ section: intent, context });
    layout.setDrawerOpen(true);
  };

  const closeActivitySidebar = (): void => {
    if (layout.drawerOpen() && autoSidebarOwner !== null)
      autoSidebar[autoSidebarOwner].dismissed = true;
    layout.setDrawerOpen(false);
  };

  const sidebarSectionAvailable = (section: AutoSidebarIntent): boolean => {
    if (section === "plan") return props.activity.plan !== null;
    if (section === "workflow")
      return [...(props.run.workflowActivity()?.nodes.values() ?? [])].some(
        (node) => node.kind === "leader",
      );
    return props.activity.subagents.length > 0;
  };
  let manualSidebarReveal = 0;
  const openActivitySidebar = (requested?: AutoSidebarIntent): void => {
    const section =
      requested ?? (["agents", "workflow", "plan"] as const).find(sidebarSectionAvailable) ?? null;
    if (section === null || !sidebarSectionAvailable(section)) {
      notify(
        requested === undefined
          ? "no run activity to inspect"
          : `${capitalize(requested)} activity is not available`,
        "warn",
      );
      return;
    }
    autoSidebarOwner = null;
    manualSidebarReveal += 1;
    setSidebarReveal({ section, context: `manual:${manualSidebarReveal}` });
    layout.setDrawerOpen(true);
  };

  createEffect(() => {
    const context = visiblePlanContext(props.store, props.activity);
    if (context !== null) requestAutomaticSidebar("plan", context);
  });

  createEffect(() => {
    const workflow = props.run.workflowActivity();
    if (workflow !== null && [...workflow.nodes.values()].some((node) => node.kind === "leader"))
      requestAutomaticSidebar("workflow", workflow.root);
  });

  createEffect(() => {
    const context = visibleSubagentContext(props.store, props.activity);
    if (context !== null) requestAutomaticSidebar("agents", context);
  });

  const overlays = createOverlayHost({
    interaction: () => interaction,
    runCommand: (n) => commands.runCommand(n),
    focusInput: () => inputEl?.focus(),
    notify,
    transientOpen: () => transientOverlay() !== "none",
  });

  let requestFinalQuit = props.shell.quit;
  const quitConfirm = createQuitConfirm({
    isDirtyView: () => overlays.viewDirty(),
    isRunActive: () => props.run.active(),
    isDraftNonEmpty: () => (inputEl?.plainText ?? "").trim().length > 0,
    notify,
    quit: () => requestFinalQuit(),
  });

  const closeTransientOverlay = (): boolean => {
    const closing = transientOverlay();
    if (closing === "none") return false;
    setTransientOverlay("none");
    if (closing === "activityDetail") setActivityDetail(null);
    interaction.popOverlayContext();
    if (overlays.overlay() === "none" && !props.run.elicit() && !props.run.switching?.())
      queueMicrotask(() => inputEl?.focus());
    return true;
  };

  const openTransientOverlay = (kind: Exclude<TransientOverlay, "none">): boolean => {
    if (transientOverlay() !== "none") return false;
    setTransientOverlay(kind);
    interaction.pushOverlayContext(kind);
    notify("");
    return true;
  };
  const openActivityDetail = (detail: ActivityDetailValue): void => {
    if (refuseAtFloor() || transientOverlay() !== "none" || overlays.overlay() !== "none") return;
    setActivityDetail(detail);
    openTransientOverlay("activityDetail");
  };

  /**
   * Whether the terminal is below the floor, and so may not mount an overlay.
   *
   * @remarks The floor screen exists to say the terminal is too small and how to
   *   fix it, and the floor rule is explicit that it shows "no misleading
   *   partial controls". An overlay opened underneath it painted a shredded card
   *   *over* that message — destroying the one instruction that could get the
   *   user out — so the request is refused here rather than at each opener.
   */
  const refuseAtFloor = (): boolean => layoutMode() === "floor";

  const warnIfAutoDegrades = (mode: GuardMode): void => {
    if (mode !== "auto") return;
    if (!guardAutoResolves(props.fleet.settings)) {
      notify(
        `guard 'auto' needs a usable default_model for the LLM judge ${glyph("emDash")} it will fall back to asking you (on)`,
        "warn",
      );
    }
  };

  const effects: InteractionEffects = {
    interactionBlocked: () => props.run.switching?.() ?? false,
    cancelRun: () => props.run.cancel(),
    clearInputDraft: () => {
      if (overlays.overlay() !== "none") return;
      inputEl?.setText("");
      dock?.clearAttachments();
    },
    quit: quitConfirm.quit,
    dismissTopOverlay: () => {
      if (closeTransientOverlay() || overlays.dismissTop()) return true;
      if (!layout.drawerOpen()) return false;
      closeActivitySidebar();
      return true;
    },
    isRunActive: () => props.run.active(),
    isDraftNonEmpty: draftNonEmpty,
    hint: (message) => notify(message, "warn"),
    openAgentPicker: (onClose) => {
      if (overlays.openPicker("agentPicker", onClose)) notify("");
    },
    openSafetyPresetPicker: () => {
      if (overlays.openPicker("safetyPicker")) notify("");
    },
    cycleGuardMode: () => {
      if (overlays.overlay() !== "none") return;
      const mode = props.fleet.guard.cycle();
      notify(`guard: ${mode} (this session)`);
      warnIfAutoDegrades(mode);
    },
    focusNext: () => {
      if (layout.drawerOpen() || secondaryMode() === "split") {
        ts.cycleSubagent();
        return;
      }
      ts.clearFocus();
      inputEl?.focus();
    },
    toggleExpandAll: () => {
      if (overlays.overlay() !== "none") return;
      ts.toggleExpandOrBlock();
    },
    focusBlock: (delta) => {
      if (overlays.overlay() !== "none") return;
      const key = ts.focusBlock(delta);
      if (key && !historyHandle?.revealKey(key)) scrollEl?.scrollChildIntoView(key);
    },
    clearBlockFocus: () => ts.clearFocus(),
    openDiff: () => {
      const pick = ts.pickDiffNode();
      if (!pick) {
        notify("no diff in the transcript");
        return;
      }
      setDiffNode(pick);
      overlays.openPicker("diff");
    },
    openPlan: () => {
      if (overlays.overlay() === "plan") {
        overlays.dismissTop();
        return;
      }
      overlays.openPicker("plan");
    },
    /**
     * Scroll the transcript, extending its window when there is nowhere left to
     * scroll.
     *
     * @remarks Reaching the top and asking to go further is exactly the gesture
     *   "show me more history" — so the already-bound `pageup` and `alt+up` grow
     *   the window rather than needing a key of their own to learn.
     */
    scrollTranscript: (rows) => {
      const result = historyHandle?.scrollBy(rows);
      if (result !== undefined) {
        if (result === "start") notify("start of transcript");
        if (result === "end") notify("latest transcript batch");
        return;
      }
      scrollEl?.scrollBy({ x: 0, y: rows });
    },
    loadEarlier: () => {
      if (!historyHandle?.requestEarlier()) notify("start of transcript");
    },
  };

  const keyboardConfig = () =>
    props.fleet.code.keyboardConfig?.() ?? { version: 1 as const, environments: {} };

  const interaction = createInteraction(
    props.shell.renderer,
    props.shell.platform,
    effects,
    keyboardConfig(),
  );

  let checkingWorktreeForExit = false;
  let removingWorktreeForExit = false;
  requestFinalQuit = (): void => {
    const worktree = props.shell.worktree;
    if (!worktree) {
      props.shell.quit();
      return;
    }
    if (checkingWorktreeForExit) return;
    if (transientOverlay() !== "none" || refuseAtFloor()) {
      props.shell.quit();
      return;
    }
    checkingWorktreeForExit = true;
    notify("checking worktree before exit" + glyph("ellipsis"));
    detachObserved(
      "worktree_exit_check",
      async () => {
        const clean = await worktree.isClean();
        checkingWorktreeForExit = false;
        if (!clean) {
          props.shell.quit();
          return;
        }
        openTransientOverlay("worktreeExit");
      },
      () => {
        checkingWorktreeForExit = false;
        props.shell.quit();
      },
    );
  };

  onMount(() => {
    const off = interaction.keymap.registerLayer({
      enabled: reactiveMatcherFromSignal(drawerOpen),
      priority: LAYER.TRANSIENT,
      commands: [
        uiCommand({
          id: "sidebar.drawer.close",
          title: "Close activity drawer",
          description: "Return to the transcript",
          category: "escape",
          surfaces: ["footer"],
          footerLabel: "close activity",
          hintPriority: 100,
          hintGroup: "escape",
          essential: true,
          run: closeActivitySidebar,
        }),
      ],
      bindings: [{ key: "escape", cmd: "sidebar.drawer.close" }],
    });
    onCleanup(off);
  });

  const commandEffects: CommandEffects = {
    clearSession: () => {
      props.session.clear();
      ts.reset();
      notify("started a new session", "success");
    },
    status: () => notify(props.session.statusLine()),
    exportSession: () => {
      if (pressureBlocked()) {
        notify(
          "Export is blocked while the memory fuse is active; recover memory or start a new session first.",
          "warn",
        );
        return;
      }
      props.session
        .export()
        .then((msg) => notify(msg, msg.startsWith("export failed") ? "error" : "success"))
        .catch((error: unknown) =>
          notify(
            `export failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          ),
        );
    },
  };
  const commands = createCommands(interaction, commandEffects, overlays.ui);
  commands.registerAction({
    name: "activity.open",
    title: "Run activity",
    desc: "Reopen the current Plan, parallel workflow, or sub-agent sidebar",
    slash: "/activity",
    surface: "slash",
    group: "navigate",
    enabled: sidebarHasContent,
    subcommands: [
      { name: "plan", desc: "Reveal the current Plan" },
      { name: "workflow", desc: "Reveal parallel workflow leaders" },
      { name: "agents", desc: "Reveal delegated sub-agents" },
    ],
    route: (args) => {
      const section = args.trim().split(/\s+/)[0];
      if (section !== "plan" && section !== "workflow" && section !== "agents") return false;
      openActivitySidebar(section);
      return true;
    },
    run: () => openActivitySidebar(),
  });
  let notifiedMissingEntryAgent = false;
  let entryAgentPromptQueued = false;
  createEffect(() => {
    if (
      entryAgentPromptQueued ||
      props.fleet.agents.active() !== "" ||
      props.fleet.agents.list().length === 0 ||
      overlays.overlay() !== "none" ||
      transientOverlay() !== "none"
    )
      return;
    entryAgentPromptQueued = true;
    queueMicrotask(() => {
      entryAgentPromptQueued = false;
      if (
        props.fleet.agents.active() !== "" ||
        overlays.overlay() !== "none" ||
        transientOverlay() !== "none"
      )
        return;
      if (overlays.openPicker("agentPicker")) {
        if (!notifiedMissingEntryAgent) {
          notifiedMissingEntryAgent = true;
          notify("Choose an interactive entry agent; no safe default is configured.", "warn");
        }
      }
    });
  });
  // Register destinations before resolving manual bindings: a saved binding
  // for a stable app command must work on the first boot, not only after the
  // user edits the Keyboard screen and triggers a second configuration pass.
  createEffect(() => {
    props.shell.platform.capabilities.revision?.();
    interaction.configureKeyboard(keyboardConfig());
  });

  const env = readEnvView();

  const contextWindow = createMemo(() => {
    props.fleet.settings.version();
    return resolveContextWindow(
      props.fleet.settings.effective().providers,
      props.activity.context?.model ?? props.fleet.agents.view()?.model,
      env.contextWindowDefault,
    );
  });
  const resolvedModel = createMemo(() => {
    props.fleet.settings.version();
    return (
      props.activity.context?.model ??
      props.fleet.agents.view()?.model ??
      props.fleet.settings.effective().default_model ??
      env.defaultModel ??
      "(default)"
    );
  });
  const runControls = createMemo(() => {
    props.fleet.settings.version();
    return deriveRunControls(
      props.fleet.settings.effective(),
      props.fleet.guard.mode(),
      props.fleet.memoryMode.mode(),
    );
  });

  let pendingSlashArgs = "";
  const takeSlashArgs = (): string => {
    const args = pendingSlashArgs;
    pendingSlashArgs = "";
    return args;
  };

  const appWiring = registerCodeCommands({
    commands,
    ui: overlays.ui,
    effects,
    session: {
      list: props.session.list,
      ...(props.session.catalog === undefined ? {} : { catalog: props.session.catalog }),
      resume: (id) => {
        props.session.resume(id);
        ts.reset();
      },
      ...(props.session.resumeCatalog === undefined
        ? {}
        : {
            resumeCatalog: async (item: SessionCatalogItem) => {
              await props.session.resumeCatalog!(item);
              ts.reset();
            },
          }),
      delete: props.session.delete,
      statusLine: props.session.statusLine,
    },
    notify,
    settings: props.fleet.settings,
    dirs: props.fleet.dirs,
    catalog: props.fleet.catalog,
    loadCatalog: props.fleet.loadCatalog,
    refreshModels: props.fleet.refreshModels,
    refreshAgentProfiles: props.fleet.refreshAgentProfiles,
    keys: props.fleet.keys,
    reconnectBackend: props.backend.reconnect,
    env,
    preview: props.fleet.preview,
    platform: props.shell.platform,
    agents: props.fleet.agents,
    agentFiles: props.fleet.agentFiles,
    code: props.fleet.code,
    memoryMode: props.fleet.memoryMode,
    guard: props.fleet.guard,
    workflows: props.backend.workflows,
    modelsService: props.backend.models,
    providerAuth: props.backend.providerAuth,
    workflowActivity: props.run.workflowActivity,
    getRun: props.backend.getRun,
    runActive: props.run.active,
    hasAvailablePlan: () => isAvailablePlan(props.activity.plan),
    backend: props.backend.probe,
    mcpClient: props.backend.client,
    ...(props.shell.afterPaint === undefined
      ? {}
      : { afterPaint: (task: () => void) => props.shell.afterPaint!(task) }),
    plugins: props.backend.plugins,
    environments: props.backend.environments,
    skills: props.backend.skills,
    tasks: props.backend.tasks,
    storage: props.backend.storage,
    taskWorkBlockedReason: pressureBlockedReason,
    onSubmitPrompt: (messages, display, skill) => {
      submitFromLeadTail(() => props.run.submitPrompt(messages, display, skill));
    },
    onSubmitSkillRun: (name, task, agent) => {
      submitFromLeadTail(() => props.run.submitSkillRun(name, task, agent));
    },
    onCompactRun: (request) => {
      if (!refuseModelAction()) props.run.compact(request);
    },
    ...(props.run.inspectContext === undefined
      ? {}
      : { inspectRunContext: props.run.inspectContext }),
    ...(props.run.fitContext === undefined ? {} : { fitRunContext: props.run.fitContext }),
    connection: props.backend.connection,
    debugSession: props.shell.debugSession,
    takeSlashArgs,
    features: {
      settings: props.fleet.settings,
      catalog: props.fleet.catalog,
      loadCatalog: props.fleet.loadCatalog,
      keys: props.fleet.keys,
      code: props.fleet.code,
      modelsService: props.backend.models,
      providerAuth: props.backend.providerAuth,
      copyText: (text) => props.shell.platform.copyText(text),
      ...(props.shell.platform.openUrl === undefined
        ? {}
        : { openUrl: (url: string) => props.shell.platform.openUrl!(url) }),
      agents: props.fleet.agentFiles,
      env,
      notify,
    },
  });
  overlays.setRecheck(appWiring.recheck);
  onCleanup(() => {
    if (transientOverlay() !== "none") {
      setTransientOverlay("none");
      interaction.popOverlayContext();
    }
    overlays.dispose();
    appWiring.dispose();
    commands.dispose();
    interaction.dispose();
  });
  const doctorDirty = appWiring.doctorDirty;
  const focusedRepairSurface = (): boolean =>
    ["setup.open", "setup.providers", "recovery.open", "doctor.open"].includes(
      overlays.view()?.name ?? "",
    );
  const agentName = (): string =>
    props.fleet.agents.view()?.name ?? (props.fleet.agents.active() || "no agent");
  const headerPlan = createMemo(() =>
    projectHeader({
      width: dims().w - 1,
      floor: layoutMode() === "floor",
      agentName: agentName(),
      model: resolvedModel(),
      safetyPreset: runControls().preset,
      guardMode: runControls().guardMode,
      sandboxUnavailable:
        runControls().sandboxEnabled && appWiring.sandboxInspection()?.backend.available === false,
      memoryConfigured: props.fleet.memoryMode.configured(),
      memory: runControls().memory,
      plans: runControls().plans,
      connection: props.backend.connection(),
      doctorDirty: doctorDirty() && !focusedRepairSurface(),
      workspace: props.shell.workspace,
      workspaceLabel: props.shell.workspaceLabel,
      branch: props.shell.branch,
    }),
  );

  const onSlashCommand = (name: string, args: string): SlashOutcome => {
    if (name === "recover-memory") {
      recoverMemory();
      return "handled";
    }
    if (pressureBlocked() && !memoryPressureAllowsSlash(name)) {
      notify(pressureBlockedReason()!, "warn");
      return "block";
    }
    const path = /^([^/]+)\/(.+)$/.exec(name);
    if (path) {
      const parentSlash = "/" + path[1]!;
      const child = path[2]!;
      const parent = commands.entries().find((entry) => entry.slashes.includes(parentSlash));
      if (parent?.subcommands.some((subcommand) => subcommand.name === child)) {
        if (commands.route(parent.name, [child, args].filter(Boolean).join(" "))) return "handled";
      }
    }
    const hit = classifySlashSubmit(name, {
      skillAgent: (n) => appWiring.skillAgent(n),
      findCommand: (slash) => commands.entries().find((e) => e.slashes.includes(slash))?.name,
    });
    if (hit.kind === "skill") {
      submitFromLeadTail(() => props.run.submitSkillRun(name, args, hit.agent));
      return "handled";
    }
    if (hit.kind === "command") {
      if (args && commands.route(hit.command, args)) return "handled";
      pendingSlashArgs = args;
      commands.runCommand(hit.command);
      pendingSlashArgs = "";
      return "handled";
    }
    if (hit.kind === "unknown") {
      notify(`unknown command: /${name}`, "warn");
      return "block";
    }
    return "pass";
  };

  const commandProvider = createCommandCompletionProvider({ commands, recoverMemory });

  const mentionProvider: CompleteProvider = {
    id: "file",
    trigger: "@",
    label: "files",
    query: (term) =>
      fuzzyFilter(props.shell.files(), term, (f) => f)
        .slice(0, 12)
        .map((f) => ({ label: f, value: f, insert: f })),
  };

  const argHintProviders = (): CompleteProvider[] =>
    commands
      .entries()
      .filter((e) => e.slashes.length > 0 && e.args.length > 0)
      .flatMap((e) => {
        const rows: CompleteItem[] = e.args.map((a) => ({
          label: `<${a.name}>` + (a.required ? "" : "?"),
          detail: a.description,
          value: a.name,
        }));
        return e.slashes.map((slash): CompleteProvider => ({
          id: "args:" + slash,
          trigger: slash,
          label: slash + " arguments",
          kind: "hint",
          query: () => rows,
        }));
      });

  /**
   * The autocomplete providers handed to the input dock.
   *
   * @remarks A memo rather than an inline array on the prop. Solid compiles a
   *   prop whose expression contains a call into a getter, so every read of it
   *   re-ran {@link argHintProviders} — a walk of the whole command registry
   *   allocating a provider per slash alias — and the dock reads it on every
   *   keystroke.
   *
   *   Reading `commands.revision()` is what makes the memo correct rather than
   *   merely cheap. The registry is a plain `Map` with no reactive source, so a
   *   memo without this dependency computes once at setup and never again —
   *   which silently drops every command registered later, and skills and MCP
   *   prompts are all registered asynchronously once the client connects. The
   *   inline expression this replaced was re-evaluated per read and so never had
   *   the problem.
   */
  const providerList = createMemo<CompleteProvider[]>(() => {
    commands.revision();
    return [commandProvider, mentionProvider, ...argHintProviders()];
  });

  let copyingSelection = false;
  useSelectionHandler((selection) => {
    const text = selection.getSelectedText();
    if (!text || copyingSelection) return;
    copyingSelection = true;
    void props.shell.platform
      .copyText(text)
      .then((ok) => {
        if (ok) notify("copied to clipboard", "success");
        else notify("clipboard unavailable (no native helper or OSC-52)", "warn");
      })
      .catch(() => {
        notify("clipboard unavailable (native helper failed)", "warn");
      })
      .finally(() => {
        copyingSelection = false;
      });
  });

  createEffect(() => {
    if (overlays.overlay() !== "none" || transientOverlay() !== "none" || props.run.active())
      quitConfirm.disarm();
  });

  const footerHint = (): { text: string; tone: HintTone } =>
    props.run.switching?.()
      ? { text: "switching workspace" + glyph("ellipsis"), tone: "info" }
      : overlays.overlay() !== "none" || transientOverlay() !== "none"
        ? { text: "", tone: "info" }
        : hint();
  const leadActivityPhase = (): LeadActivityPhase => {
    const busy = props.run.active() || props.run.localBusy() || props.run.compacting?.() === true;
    if (!busy) return "ready";
    if (
      props.run.active() &&
      props.store
        .frontierNodes()
        .some(
          (node) =>
            node.kind === "thinking" &&
            node.subagentId === undefined &&
            node.subagentOrder === undefined,
        )
    )
      return "thinking";
    return "working";
  };
  const leadActivityDetail = (): string => {
    if (!props.run.active()) return "";
    const detail: string[] = [];
    const startedAt = props.run.startedAt();
    if (startedAt !== null) detail.push(formatElapsed(tickNow() - startedAt));
    const iteration = /iteration\s+(\d+)/i.exec(props.run.status())?.[1];
    if (iteration) detail.push(`iteration ${iteration}`);
    const interruptKey = commandKeyLabel(interaction.keymap, "run.cancel", {
      visibility: "registered",
    });
    if (interruptKey !== undefined) detail.push(`${interruptKey} to interrupt`);
    return detail.join(` ${glyph("separator")} `);
  };
  const compactActivityStrip = (): string => {
    if (secondaryMode() === "split") return "";
    const counts = {
      waiting: props.activity.subagents.filter((agent) => agent.status === "spawned").length,
      running: props.activity.subagents.filter((agent) => agent.status === "running").length,
      done: props.activity.subagents.filter((agent) => agent.status === "done").length,
      failed: props.activity.subagents.filter((agent) => agent.status === "error").length,
    };
    const selected = ts.selectedSubagent();
    const selectedIndex = selected
      ? props.activity.subagents.findIndex((agent) => agent.id === selected)
      : -1;
    const agents =
      props.activity.subagents.length === 0
        ? ""
        : [
            `Agents ${props.activity.subagents.length}`,
            counts.waiting > 0 ? `${counts.waiting} waiting` : "",
            counts.running > 0 ? `${counts.running} running` : "",
            counts.done > 0 ? `${counts.done} done` : "",
            counts.failed > 0 ? `${counts.failed} failed` : "",
            selectedIndex >= 0 ? `A${selectedIndex + 1} focused` : "",
          ]
            .filter(Boolean)
            .join(` ${glyph("separator")} `);
    const leaders = [...(props.run.workflowActivity()?.nodes.values() ?? [])].filter(
      (node) => node.kind === "leader",
    ).length;
    return [agents, leaders > 0 ? `Workflow ${leaders}` : ""]
      .filter(Boolean)
      .join(` ${glyph("separator")} `);
  };
  const footerRunStrip = (): string => {
    if (
      overlays.overlay() !== "none" ||
      transientOverlay() !== "none" ||
      props.run.elicit() ||
      props.run.switching?.()
    )
      return "";
    // A transient acknowledgement already owns the flexible half of this row.
    // On narrow terminals, seating the activity strip beside it makes both
    // strings truncate into one ambiguous sentence; the strip returns when the
    // self-clearing hint expires.
    if (footerHint().text.length > 0) return "";
    const activityStrip = compactActivityStrip();
    const context = props.activity.context;
    const usage = props.activity.usage;
    const settledSessionUsage = props.session.usage?.() ?? null;
    const sessionUsage = props.run.active() ? (usage ?? settledSessionUsage) : settledSessionUsage;
    const sessionCost = props.session.costLine();
    const runStrip = runStripText({
      active: props.run.active(),
      status: props.run.status(),
      startedAt: props.run.startedAt(),
      now: tickNow(),
      width: dims().w,
      ...(context ? { context: { used: context.used, limit: contextWindow() } } : {}),
      ...(sessionUsage ? { sessionUsage } : {}),
      ...(sessionCost ? { sessionCost } : {}),
    });
    return [runStrip, activityStrip].filter(Boolean).join(` ${glyph("separator")} `);
  };
  /**
   * The band width the footer's action row is budgeted against.
   *
   * @remarks The terminal width, less only what the run strip takes from the
   *   same row. The footer's own padding is `budgetFooterActions`'s to account
   *   for; subtracting it here as well charged for it twice and cost the row a
   *   whole tier at every band boundary.
   */
  const footerNavigationWidth = (): number => {
    const strip = footerRunStrip();
    return Math.max(0, dims().w - (strip ? Bun.stringWidth(strip) + 2 : 0));
  };

  createEffect(() => {
    if (
      overlays.overlay() === "none" &&
      transientOverlay() === "none" &&
      !drawerOpen() &&
      !props.run.elicit() &&
      !props.run.switching?.()
    )
      inputEl?.focus();
    else inputEl?.blur();
  });

  createEffect(() => {
    const switching = props.run.switching?.() ?? false;
    overlays.setInteractionBlocked(transientOverlay() !== "none");
    interaction.setModalContext(props.run.elicit() != null || switching ? "elicitation" : "none");
  });

  createEffect(
    on(
      () => props.run.elicit(),
      (req) => {
        if (req == null) return;
        dock?.closeEditor();
        closeTransientOverlay();
        overlays.dismissTopUnlessDirty({
          reason:
            "the agent is waiting for an answer " +
            glyph("emDash") +
            " save changes or leave this view to reply",
        });
        queueMicrotask(() => scrollEl?.scrollBy({ x: 0, y: 1_000_000 }));
      },
    ),
  );

  return (
    <KeymapProvider keymap={interaction.keymap}>
      <box flexDirection="column" flexGrow={1} backgroundColor={tokens.bg}>
        <HeaderRows plan={headerPlan} />
        <box
          height={1}
          flexShrink={0}
          border={["top"]}
          borderStyle="single"
          customBorderChars={borderChars()}
          borderColor={ruleColor()}
          backgroundColor={tokens.bg}
          zIndex={1}
        />

        <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
          <OverlayRegion
            host={overlays}
            interaction={interaction}
            diffNode={diffNode}
            activity={props.activity}
            plans={props.backend.plans}
            fallback={
              <TranscriptRegion
                store={props.store}
                transcript={ts}
                activity={props.activity}
                interaction={interaction}
                run={props.run}
                active={() => overlayFallbackActive(overlays)}
                layout={{
                  mode: layoutMode,
                  sidebarVisible,
                  secondaryMode,
                  sidebarWidth,
                  drawerOpen,
                  closeDrawer: closeActivitySidebar,
                  contentInset,
                  width: () => dims().w,
                  height: () => dims().h,
                }}
                contextWindow={contextWindow}
                agent={agentName}
                model={resolvedModel}
                notify={notify}
                openPlan={() => effects.openPlan()}
                sidebarReveal={sidebarReveal}
                onOpenDetail={openActivityDetail}
                onScrollbox={(el) => (scrollEl = el)}
                onHistoryHandle={(handle) => (historyHandle = handle)}
                onLeadHistoryHandle={(handle) => (leadHistoryHandle = handle)}
                draftNonEmpty={draftNonEmpty}
                memoryPressure={{ state: pressure, onRecover: recoverMemory }}
              />
            }
          />
        </box>

        <SurfaceBoundary
          active={() => overlays.overlay() === "agentPicker"}
          retention="retain-one"
          placement="portal"
        >
          {(lifecycle) => (
            <ProfilePicker
              interaction={interaction}
              enabled={lifecycle.active}
              list={props.fleet.agents.list}
              active={props.fleet.agents.active}
              isRunnable={(name) => props.fleet.agents.isRunnable(name)}
              defaults={() => {
                const global = props.fleet.code.read("global").agent?.default;
                const workspace = props.fleet.code.read("workspace").agent?.default;
                return {
                  ...(global !== undefined ? { global } : {}),
                  ...(workspace !== undefined ? { workspace } : {}),
                } satisfies AgentDefaults;
              }}
              onConfirm={(name) => {
                props.fleet.agents.setActive(name);
                overlays.dismissTop();
              }}
              onSetDefault={(name, scope) => {
                try {
                  props.fleet.agents.setDefault(name, scope);
                  const workspaceOverride = props.fleet.code.read("workspace").agent?.default;
                  notify(
                    scope === "global" && workspaceOverride !== undefined
                      ? `global default set to ${name}; this workspace still overrides it with ${workspaceOverride}`
                      : `${scope} default agent set to ${name}`,
                    "success",
                  );
                  return true;
                } catch (e) {
                  notify(`set default failed: ${errorText(e)}`, "error");
                  return false;
                }
              }}
              onClearDefault={(scope) => {
                if (props.fleet.code.read(scope).agent?.default === undefined) {
                  notify(`no ${scope} default agent is configured`, "warn");
                  return false;
                }
                try {
                  props.fleet.code.clearAgentDefault(scope);
                  const inherited = props.fleet.code.agentDefault();
                  notify(
                    `${scope} default agent cleared${inherited ? `; effective default is now ${inherited}` : ""}`,
                    "success",
                  );
                  return true;
                } catch (e) {
                  notify(`clear default failed: ${errorText(e)}`, "error");
                  return false;
                }
              }}
            />
          )}
        </SurfaceBoundary>
        <SurfaceBoundary
          active={() => overlays.overlay() === "safetyPicker"}
          retention="retain-one"
          placement="portal"
        >
          {(lifecycle) => (
            <Suspense fallback={<text>Loading safety presets{glyph("ellipsis")}</text>}>
              <SafetyPresetPicker
                interaction={interaction}
                settings={props.fleet.settings}
                guard={props.fleet.guard}
                scope={() =>
                  props.fleet.settings.read("workspace") !== undefined ? "workspace" : "global"
                }
                runActive={props.run.active}
                active={lifecycle.active}
                notify={notify}
                onClose={() => overlays.dismissTop()}
                onApplied={() => overlays.dismissTop()}
              />
            </Suspense>
          )}
        </SurfaceBoundary>
        <SurfaceBoundary
          active={() => transientOverlay() === "activityDetail" && activityDetail() !== null}
          retention="retain-one"
          placement="portal"
        >
          {() => (
            <ActivityDetail
              interaction={interaction}
              detail={activityDetail}
              onClose={() => closeTransientOverlay()}
            />
          )}
        </SurfaceBoundary>
        <SurfaceBoundary
          active={() => transientOverlay() === "worktreeExit" && props.shell.worktree !== undefined}
          retention="retain-one"
          placement="portal"
        >
          {() => (
            <WorktreeExitPrompt
              interaction={interaction}
              name={props.shell.worktree!.name}
              branch={props.shell.worktree!.branch}
              onRemove={() => {
                if (removingWorktreeForExit) return;
                removingWorktreeForExit = true;
                notify("removing clean worktree" + glyph("ellipsis"));
                detachObserved(
                  "worktree_exit_remove",
                  async () => {
                    await props.shell.worktree!.requestRemoval();
                    props.shell.quit();
                  },
                  () => props.shell.quit(),
                );
              }}
              onKeep={props.shell.quit}
              onCancel={() => closeTransientOverlay()}
            />
          )}
        </SurfaceBoundary>
        <SurfaceBoundary
          active={() => overlays.overlay() !== "none" || transientOverlay() !== "none"}
          retention="dispose-on-close"
        >
          {() => <HintToast hint={hint} />}
        </SurfaceBoundary>
        <box
          flexDirection="column"
          flexShrink={editorExpanded() ? 1 : 0}
          flexGrow={editorExpanded() ? 1 : 0}
          minHeight={editorExpanded() ? 0 : undefined}
          position={editorExpanded() ? "absolute" : "relative"}
          left={editorExpanded() ? 0 : "auto"}
          right={editorExpanded() ? 0 : "auto"}
          top={editorExpanded() ? 2 : "auto"}
          bottom={editorExpanded() ? 0 : "auto"}
          backgroundColor={tokens.bg}
          zIndex={editorExpanded() ? 3 : 1}
        >
          <Show when={!inputPopupOpen()}>
            <LeadActivityLine phase={leadActivityPhase} detail={leadActivityDetail} />
          </Show>
          <InputDock
            interaction={interaction}
            renderer={props.shell.renderer}
            platform={props.shell.platform}
            history={props.session.history}
            providers={providerList()}
            visible={() =>
              overlays.overlay() === "none" && !props.run.elicit() && !props.run.switching?.()
            }
            runActive={() => props.run.active()}
            submissionBlocked={pressureBlockedReason}
            onSubmit={(content) => {
              submitFromLeadTail(() => props.run.submit(content));
            }}
            onSlashCommand={onSlashCommand}
            onBashCommand={props.run.bang}
            onReady={(el) => {
              inputEl = el;
              if (props.initialDraft !== undefined && el.plainText.length === 0) {
                el.setText(props.initialDraft);
                el.gotoBufferEnd();
              }
              props.run.registerDraftRestore?.((text, content) => {
                if ((el.plainText ?? "").trim().length > 0) return;
                el.setText(text);
                el.gotoBufferEnd();
                if (Array.isArray(content)) dock?.restoreAttachments(content);
              });
            }}
            onDock={(value) => {
              dock = value;
            }}
            onExpandedChange={setEditorExpanded}
            onPopupOpenChange={setInputPopupOpen}
            onDraftChange={setDraftNonEmpty}
            targetLabel={() => {
              if (pressureBlocked()) return "Memory recovery required";
              if (props.run.active())
                return props.run.workflowActivity() ? "Message workflow" : "Steer this run";
              if (/done|completed|cancel/i.test(props.run.status())) return "Ask for an adjustment";
              return "New task";
            }}
            onNotify={notify}
          />
          <Footer
            hint={footerHint}
            status={() =>
              props.run.compacting?.() === true
                ? { text: "Compacting context…", tone: "running" }
                : { text: "", tone: "info" }
            }
            runStrip={footerRunStrip}
            onRunStripMouseDown={() => {
              if (compactActivityStrip()) {
                autoSidebarOwner = null;
                layout.setDrawerOpen(true);
              }
            }}
            navigation={
              <NavigationBar
                environment={interaction.keyboardEnvironment}
                width={footerNavigationWidth}
                active={() =>
                  overlays.overlay() === "none" &&
                  transientOverlay() === "none" &&
                  !props.run.switching?.()
                }
                actionFilter={
                  drawerOpen() ? (action) => action.id === "sidebar.drawer.close" : undefined
                }
              />
            }
          />
        </box>
        <SurfacePortal visible={() => props.run.switching?.() ?? false} zIndex={FLOAT_Z + 3}>
          <box
            position="absolute"
            left={0}
            right={0}
            top={0}
            bottom={0}
            backgroundColor={POINTER_BLOCKER_BG}
            onMouse={consumePointerEvent}
          />
        </SurfacePortal>
        <Show when={layoutMode() === "floor"}>
          {/* Above the float layer on purpose: this message is the only route
              out, and an overlay that painted over it left the user with a
              shredded card and no instruction. `refuseAtFloor` stops one being
              opened; this stops one already open from covering the message. */}
          <box
            position="absolute"
            left={0}
            right={0}
            top={0}
            bottom={0}
            backgroundColor={tokens.bg}
            justifyContent="center"
            alignItems="center"
            flexDirection="column"
            zIndex={FLOAT_Z + 2}
          >
            <text fg={tokens.warn}>terminal too small</text>
            <text fg={tokens.muted}>
              {`needs ${FLOOR_MIN_COLUMNS}x${FLOOR_MIN_ROWS}, have ${dims().w}x${dims().h}`}
            </text>
          </box>
        </Show>
      </box>
    </KeymapProvider>
  );
}
