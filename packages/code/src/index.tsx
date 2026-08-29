import {
  globalPaths,
  globalRoot,
  workspacePaths,
  workspaceRoot,
  workspaceStatePaths,
} from "@clarvis/paths";
import { mkdirSync } from "node:fs";
import { open as openFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createFileKernel, createLogger } from "@clarvis/kernel/bootstrap";
import { createCliRenderer, getTreeSitterClient, RGBA } from "@opentui/core";
import { render } from "@opentui/solid";
import { batch, createEffect, createRoot, createSignal, Show } from "solid-js";
import type { RunDetail, RunEvent } from "@clarvis/protocol";
import { formatToolCall } from "./views/tools/signature.ts";
import { mutationStats, type DiffStats } from "./views/tools/mutation-gate.ts";
import {
  renderTranscriptMarkdown,
  renderTranscriptMarkdownChunks,
  transcriptMarkdownHeader,
} from "./views/transcript-markdown.ts";
import { formatSessionRow } from "./views/session-row.ts";
import { createWorkspaceFiles } from "./adapters/workspace-files.ts";
import {
  helpText,
  parseMode,
  productVersion,
  resolveDebugRequest,
  usageText,
  versionText,
  type DebugRequest,
  type Mode,
  type PrintFormat,
} from "./cli-args.ts";
import { createPrintStream, drainPrintEvents, resolveResumeMeta } from "./cli-mode.ts";
import {
  bootstrapWorktree,
  removeWorktreeCheckout,
  runBootstrapGit,
  worktreeIsClean,
  type WorktreeBootstrapResult,
} from "./bootstrap/worktree.ts";
import { createRunHost, type RunHost } from "./run-host.ts";
import { knownPlanProviderKey } from "./adapters/capability-providers.ts";
import {
  automaticAgentFallback,
  createActiveAgentStore,
  type ActiveAgentStore,
} from "./adapters/active-agent.ts";
import {
  createAgentsStore,
  loadAgentFiles,
  loadAgentFilesSnapshot,
  type AgentsStore,
} from "./adapters/agents-store.ts";
import { agentReadiness, readEnvView, type AgentFile } from "./adapters/agent-files.ts";
import type { ClarvisDirs } from "./adapters/agents.ts";
import {
  createKeysAdapter,
  type KeysAdapter,
  type KeySource,
} from "./adapters/provider-secrets.ts";
import { errorText } from "./adapters/errors.ts";
import {
  createModelsCatalog,
  resolveModelPrice,
  type CatalogCost,
  type ModelsCatalog,
} from "./adapters/models-catalog.ts";
import { createCodeConfigStore, type CodeConfigStore } from "./adapters/code-config.ts";
import {
  createGuardModeStore,
  type GuardMode,
  type GuardModeStore,
} from "./adapters/guard-mode.ts";
import { createMemoryModeStore, type MemoryModeStore } from "./adapters/memory-mode.ts";
import { loadGuardJudgePrompt } from "./adapters/guard-judge-prompt.ts";
import { createTheme, createThemePreview, type ThemePreview } from "./theme/theme.ts";
import type { ThemeConfig } from "./theme/model.ts";
import { tokens } from "./theme/tokens.ts";
import { applyAsciiMode, glyph } from "./theme/glyphs.ts";
import { presentStatusLine, progressStatusText } from "./features/run/status-presenter.ts";
import { createAttention } from "./core/attention.ts";
import { createSettingsAdapter, type SettingsAdapter } from "./adapters/settings.ts";
import { plansState } from "./adapters/execution-safety.ts";
import {
  assertInteractiveTTY,
  buildRendererConfig,
  createPlatform,
  openPublicUrl,
} from "./adapters/platform.ts";
import { installTerminalGuard } from "./adapters/terminal-guard.ts";
import { createFilePromptHistory } from "./adapters/file-prompt-history.ts";
import { detachObserved } from "./core/tasks.ts";
import {
  diagnosticAsync,
  diagnosticBind,
  diagnosticEvent,
  activeDiagnosticLogger,
  installDiagnosticSession,
} from "./core/diagnostic-events.ts";
import { createDiagnosticSession } from "./adapters/diagnostic-session.ts";
import { createDebugSessionController } from "./adapters/debug-session.ts";
import type { ProfileInfo } from "./adapters/run-types.ts";
import {
  createKernelRunClient,
  type KernelRunClient,
  type KernelRunClientCallbacks,
} from "./adapters/kernel-run-client.ts";
import { WorkspaceClientManager } from "./adapters/workspace-client-manager.ts";
import { createTasksController } from "./features/tasks/controller.ts";
import {
  createWorkspaceCallbackTarget,
  isActiveWorkspaceCallbackTarget,
  type WorkspaceCallbackTarget,
} from "./app/workspace-runtime.ts";
import { createKernelCapabilitiesClient } from "./adapters/kernel-capabilities-client.ts";
import { applyEvent, createTranscriptStore, type TranscriptStore } from "./adapters/store.ts";
import { createActivityStore } from "./adapters/activity-store.ts";
import type { BackendProbe } from "./onboarding/doctor.ts";
import { createConnectionState, connectionProbe } from "./adapters/connection-state.ts";
import { runFatalBoot } from "./views/FatalBoot.tsx";
import { BootFrame } from "./views/BootFrame.tsx";
import { createElicitSlot } from "./adapters/elicit-slot.ts";
import {
  createSessionStore,
  formatCostUsd,
  listSessionsForWorkspace,
  loadSessions,
  uncachedInput,
  type SessionId,
  type SessionStore,
  type SessionTotals,
} from "./adapters/session-store.ts";
import { deleteSession } from "./adapters/session.ts";
import {
  App,
  type AppBackend,
  type AppFleet,
  type AppRunControls,
  type AppSessionControls,
  type AppShell,
  type AppProps,
} from "./views/App.tsx";

let workspace = workspaceRoot();
let environmentSelector: string | undefined;

const ownerOverride = process.env.CLARVIS_OWNER;

process.env.CLARVIS_AGENT_TOOLS_MAX_GRANT ??= "exec";

/**
 * The always-resident projection of a tool call: the signature its collapsed
 * header and the Markdown export render, and the mutation chip's counts.
 *
 * @remarks Built here, at the composition root, because both renderers live
 * under `views/` and the transcript store may not reach into that layer.
 */
const describeToolCall = (input: {
  mcpName?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  diff?: string;
}): { signature: string; mutation: DiffStats | null } => ({
  signature: formatToolCall(input.mcpName ?? "", input.toolName ?? "", input.args ?? {}),
  mutation: mutationStats(input),
});

/**
 * Boots a `logger: "silent"` file kernel over the current workspace/global
 * roots and the owner's session store, for the headless CLI modes that need
 * nothing else — listing, resume/continue existence checks, and deletion.
 *
 * @returns the booted kernel (the caller must call `.close()` on it) and its
 *   session store, already loaded for the process-wide `owner`.
 *
 * @remarks `runPrintMode` boots its own kernel instead of this one: it needs
 * `keySources` and `memory: true`, neither of which a silent listing/delete
 * command has any use for.
 */
async function bootSilentSessionStore(): Promise<{
  manager: WorkspaceClientManager;
  client: Awaited<ReturnType<WorkspaceClientManager["open"]>>;
  store: SessionStore;
  owner: string;
}> {
  const manager = await WorkspaceClientManager.create({
    workspaceRoot: workspace,
    globalDir: globalRoot(),
    ...(ownerOverride === undefined ? {} : { defaultOwner: ownerOverride }),
    ...(environmentSelector === undefined ? {} : { environmentSelector }),
    logger: activeDiagnosticLogger() ?? createLogger("silent"),
  });
  const owner = manager.defaultOwner;
  const client = await manager.open();
  const store = createSessionStore(
    client.client.sessions,
    owner,
    await loadSessions(client.client.sessions, owner),
  );
  return { manager, client, store, owner };
}

async function runListMode(): Promise<never> {
  const { manager, client, store } = await bootSilentSessionStore();
  const rows = store.list().sort((a, b) => b.updatedAt - a.updatedAt);
  if (rows.length === 0) {
    process.stdout.write("no sessions\n");
  } else {
    const now = Date.now();
    for (const row of rows) process.stdout.write(`${formatSessionRow(row, now)}\n`);
  }
  await client.release();
  await manager.close();
  process.exit(0);
}

async function assertSessionExists(
  mode: { kind: "resume"; id: SessionId } | { kind: "continue" },
): Promise<void> {
  const { manager, client, store, owner } = await bootSilentSessionStore();
  const exists = resolveResumeMeta(store, owner, manager.current.id, mode) !== null;
  await client.release();
  await manager.close();
  if (exists) return;
  process.stderr.write(
    (mode.kind === "resume"
      ? `session not found: ${mode.id}`
      : "no session to continue in this workspace") + ` ${glyph("emDash")} run clarvis --list\n`,
  );
  process.exit(1);
}

async function runPrintMode(opts: {
  prompt: string;
  agent?: string;
  format: PrintFormat;
}): Promise<never> {
  const printDirs: ClarvisDirs = {
    global: globalPaths(),
    workspace: workspacePaths(workspace),
    state: workspaceStatePaths(workspace),
  };
  let code!: CodeConfigStore;
  createRoot(() => {
    code = createCodeConfigStore(printDirs);
  });
  const kernel = await createFileKernel({
    workspaceRoot: workspace,
    globalDir: printDirs.global.root,
    keySources: code.keySources(),
    memory: true,
    ...(environmentSelector === undefined ? {} : { environmentSelector }),
    logger: activeDiagnosticLogger() ?? createLogger("silent"),
    openMcpAuthorizationUrl: openPublicUrl,
  });
  try {
    let agent = opts.agent;
    if (agent === undefined) {
      const available = await kernel.listAgents();
      const files = await loadAgentFiles(kernel.config);
      const settingsView = await kernel.config.getSettings();
      const env = readEnvView();
      const fileByName = new Map(files.map((candidate) => [candidate.name, candidate]));
      const candidates = [
        ...files.map((candidate) => ({
          name: candidate.name,
          isLead: (candidate.frontmatter.can_spawn?.length ?? 0) > 0,
        })),
        ...available
          .filter((candidate) => candidate.scope === "plugin" && !fileByName.has(candidate.name))
          .map((candidate) => ({
            name: candidate.name,
            isLead: (candidate.can_spawn?.length ?? 0) > 0,
          })),
      ];
      const isRunnable = (name: string): boolean => {
        const file = fileByName.get(name);
        if (file === undefined) return true;
        return (
          file.invalid === undefined &&
          agentReadiness(file, files, settingsView.merged, env, settingsView.known_grants).runnable
        );
      };
      const names = new Set(candidates.map((candidate) => candidate.name));
      const preferred = code.agentDefault();
      agent =
        preferred && names.has(preferred) && isRunnable(preferred)
          ? preferred
          : automaticAgentFallback(candidates, isRunnable);
      if (!agent) {
        process.stderr.write(
          `no interactive entry agent configured ${glyph("emDash")} pass --agent or set a default\n`,
        );
        await kernel.close();
        process.exit(1);
      }
    }
    const executionId = "exec_" + crypto.randomUUID();
    const handle = await kernel.runs.start({
      execution_id: executionId,
      messages: [{ role: "user", content: opts.prompt }],
      agent,
    });
    handle.onElicit((req) => {
      process.stderr.write(
        `${req.kind} auto-denied (headless): ${(req.prompt.split("\n", 1)[0] ?? "").trim()}\n`,
      );
      detachObserved("headless_elicitation_decline", () =>
        handle.respond({ id: req.id, action: "decline" }),
      );
    });

    let onEvent: (event: RunEvent) => void;
    let finish: () => void;
    let disposeStore: (() => void) | undefined;
    if (opts.format === "md") {
      let store!: TranscriptStore;
      disposeStore = createRoot((dispose) => {
        store = createTranscriptStore({ describeToolCall });
        return dispose;
      });
      store.appendUserMessage(opts.prompt, undefined, executionId);
      const sink = store.openRun(executionId);
      onEvent = (event) => applyEvent(sink, event, "live");
      finish = () => process.stdout.write(renderTranscriptMarkdown(store.nodes) + "\n");
    } else {
      let printedAny = false;
      onEvent = createPrintStream((chunk) => {
        if (chunk.length === 0) return;
        printedAny = true;
        process.stdout.write(chunk);
      });
      finish = () => {
        if (printedAny) process.stdout.write("\n");
      };
    }
    const { transcriptDone, drained } = drainPrintEvents(handle.events, {
      onEvent,
      onNotice: (text) => process.stderr.write(text + "\n"),
    });
    const result = await handle.done;
    await transcriptDone;
    finish();
    disposeStore?.();
    await drained;
    await kernel.close();
    if (result.status !== "completed") {
      const reason = result.error?.message ?? result.ended_reason ?? result.status;
      process.stderr.write(`run ${result.status}: ${reason}\n`);
      process.exit(1);
    }
    process.exit(0);
  } catch (e) {
    process.stderr.write(`print failed: ${errorText(e)}\n`);
    await kernel.close().catch(() => undefined);
    process.exit(1);
  }
}

async function runDeleteMode(id: SessionId): Promise<never> {
  const { manager, client, store } = await bootSilentSessionStore();
  const meta = await store.load(id);
  if (meta === null) {
    await client.release();
    await manager.close();
    process.stderr.write(`session not found: ${id}\n`);
    process.exit(1);
  }
  const result = await deleteSession(meta, store, async (execId) => {
    try {
      await client.client.runs.delete(execId);
      return true;
    } catch {
      return false;
    }
  });
  await store.flushPending?.();
  await client.release();
  await manager.close();
  const okTraces = result.traces.filter((t) => t.deleted).length;
  process.stdout.write(
    `session ${result.session ? "deleted" : "not found"}; traces ${okTraces}/${result.traces.length} deleted\n`,
  );
  process.exit(0);
}

async function runRefreshMode(): Promise<never> {
  try {
    const kernel = await createFileKernel({
      workspaceRoot: workspace,
      globalDir: globalRoot(),
      ...(environmentSelector === undefined ? {} : { environmentSelector }),
      logger: activeDiagnosticLogger() ?? createLogger("silent"),
    });
    const cat = await kernel.models.refresh();
    await kernel.close();
    const models = cat.providers.reduce((n, p) => n + p.models.length, 0);
    process.stdout.write(
      `models.dev refreshed ${glyph("emDash")} ${cat.providers.length} providers / ${models} models\n`,
    );
    process.exit(0);
  } catch (e) {
    process.stderr.write(`refresh failed: ${errorText(e)}\n`);
    process.exit(1);
  }
}

type InteractiveMode = Extract<Mode, { kind: "run" | "resume" | "continue" }>;

/** The step of the boot sequence a `boot.failed` record attributes its error to. */
type BootPhase =
  "connect" | "keys" | "agents" | "settings" | "agent-files" | "sessions" | "profiles";

async function runApp(
  mode: InteractiveMode,
  debug: DebugRequest,
  selectedWorktree?: WorktreeBootstrapResult,
): Promise<void> {
  assertInteractiveTTY();

  const diagnostics = debug.enabled
    ? createDiagnosticSession({ workspace, level: debug.level })
    : undefined;
  let uninstallDiagnostics: (() => void) | undefined;
  const closeDiagnostics = (): void => {
    uninstallDiagnostics?.();
    uninstallDiagnostics = undefined;
    diagnostics?.close();
  };
  if (diagnostics !== undefined) {
    uninstallDiagnostics = installDiagnosticSession(diagnostics);
    diagnosticBind({ workspace });
    process.stderr.write(`Clarvis debug log: ${diagnostics.path}\n`);
    // Cover failures before the renderer/platform exists. Once the platform
    // installs its own exit restoration below, move this handler behind it so
    // renderer teardown remains visible before diagnostics.stop.
    process.once("exit", closeDiagnostics);
    diagnosticEvent("app.boot.begin", { mode: mode.kind, workspace }, "info");
  }

  if (mode.kind === "resume" || mode.kind === "continue")
    await diagnosticAsync("session.preflight", () => assertSessionExists(mode));

  const dev = !!process.env.CLARVIS_CODE_DEV;
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION)
    process.env.OPENTUI_FORCE_EXPLICIT_WIDTH ??= "true";
  const asciiFlag = mode.ascii;
  const renderer = await diagnosticAsync("boot.renderer", () =>
    createCliRenderer(buildRendererConfig({ dev })),
  );
  const releaseTerminal = installTerminalGuard();
  process.once("exit", releaseTerminal);
  const platform = createPlatform(renderer, { dev });
  platform.onShutdown(() => {
    releaseTerminal();
  });
  /**
   * The `/debug` lifecycle. Constructed even when `--debug` was not passed, so
   * the command exists in the registry on every launch: a diagnostic channel
   * you can only ask for before the failure you want it for is no channel.
   */
  const debugSession = createDebugSessionController({ workspace });
  if (diagnostics !== undefined) {
    process.removeListener("exit", closeDiagnostics);
    process.once("exit", closeDiagnostics);
  }
  platform.onShutdown((reason) => {
    diagnosticEvent("app.shutdown", { reason }, "info");
  });
  const [mountedApp, setMountedApp] = createSignal<AppProps | null>(null);
  await render(
    () => (
      <Show when={mountedApp()} keyed fallback={<BootFrame />}>
        {(props: AppProps) => <App {...props} />}
      </Show>
    ),
    renderer,
  );
  await renderer.idle();
  diagnosticEvent(
    "app.boot.shell-painted",
    { elapsed_ms: Math.round(process.uptime() * 1000), mode: mode.kind },
    "info",
  );
  const preloadMarkdown = async (): Promise<void> => {
    const startedAt = performance.now();
    try {
      const treeSitter = getTreeSitterClient();
      await treeSitter.initialize();
      const [markdown, markdownInline] = await Promise.all([
        treeSitter.preloadParser("markdown"),
        treeSitter.preloadParser("markdown_inline"),
      ]);
      diagnosticEvent(
        "markdown.preload.completed",
        {
          markdown,
          markdownInline,
          duration_ms: Math.round(performance.now() - startedAt),
        },
        "debug",
      );
    } catch (error) {
      diagnosticEvent(
        "markdown.preload.failed",
        {
          error: errorText(error),
          duration_ms: Math.round(performance.now() - startedAt),
        },
        "warn",
      );
    }
  };
  const attention = createAttention(renderer);
  const workspaceManager = await diagnosticAsync("boot.workspace-manager", () =>
    WorkspaceClientManager.create({
      workspaceRoot: workspace,
      globalDir: globalRoot(),
      ...(ownerOverride === undefined ? {} : { defaultOwner: ownerOverride }),
      memory: true,
      ...(environmentSelector === undefined ? {} : { environmentSelector }),
      logger: diagnostics?.logger ?? createLogger("silent"),
      openMcpAuthorizationUrl: openPublicUrl,
      keySources: (() => {
        const targetDirs: ClarvisDirs = {
          global: globalPaths(),
          workspace: workspacePaths(workspace),
          state: workspaceStatePaths(workspace),
        };
        let sources: Record<string, KeySource> = {};
        createRoot((dispose) => {
          sources = createCodeConfigStore(targetDirs).keySources();
          dispose();
        });
        return sources;
      })(),
    }),
  );
  const owner = workspaceManager.defaultOwner;
  const activeWorkspace = workspaceManager.current;
  const activeWorkspacePath = activeWorkspace.path ?? workspace;
  /**
   * The checked-out branch shown in the header.
   *
   * @remarks A signal rather than a plain binding because it is resolved *after*
   * the first frame: it costs a kernel round-trip and is one string of header
   * chrome, so blocking paint on it was pure latency. A plain binding assigned
   * post-paint would never re-render.
   */
  const [activeBranch, setActiveBranch] = createSignal<string | undefined>(undefined);
  const [workspaceRef] = createSignal(activeWorkspace);

  const runDetailFetcher: { current?: (executionId: string) => Promise<RunDetail | null> } = {};
  const store = createTranscriptStore({
    describeToolCall,
    fetchRun: (executionId) => runDetailFetcher.current?.(executionId) ?? Promise.resolve(null),
  });
  const activity = createActivityStore();
  let sessionStore!: SessionStore;
  const runCallbackTarget = createWorkspaceCallbackTarget<RunHost>();
  let historyFailure: string | undefined;

  const conn = createConnectionState();
  interface ProfileState {
    value: () => ProfileInfo[];
    set(value: ProfileInfo[]): void;
  }
  const createProfileState = (initial: ProfileInfo[]): ProfileState => {
    const [value, setValue] = createSignal(initial);
    return { value, set: setValue };
  };
  const profileState = createProfileState([]);
  const profiles = (): ProfileInfo[] => profileState.value();
  const setProfiles = (value: ProfileInfo[]): void => profileState.set(value);

  const backend = (): BackendProbe => connectionProbe(conn.state(), profiles().length);

  const elicit = createElicitSlot();

  const dirs: ClarvisDirs = {
    global: globalPaths(),
    workspace: workspacePaths(activeWorkspacePath),
    state: workspaceStatePaths(activeWorkspacePath),
  };
  const createOwnedCode = (
    targetDirs: ClarvisDirs,
  ): { value: CodeConfigStore; dispose: () => void } => {
    let value!: CodeConfigStore;
    const dispose = createRoot((disposeRoot) => {
      value = createCodeConfigStore(targetDirs);
      return disposeRoot;
    });
    return { value, dispose };
  };
  const initialCode = createOwnedCode(dirs);
  const code = initialCode.value;
  const disposeCode = initialCode.dispose;
  const createHistory = (
    targetDirs: ClarvisDirs = dirs,
    callbackTarget: WorkspaceCallbackTarget<RunHost> = runCallbackTarget,
  ): ReturnType<typeof createFilePromptHistory> =>
    createFilePromptHistory(200, targetDirs.state?.promptHistoryFile, {
      onPersistenceError: ({ operation }) => {
        historyFailure = `prompt history persistence degraded (${operation})`;
        callbackTarget.current()?.setRunStatus(historyFailure);
      },
    });
  const history = createHistory();
  let settings!: SettingsAdapter;
  let keys!: KeysAdapter;
  let agents!: ActiveAgentStore;
  let agentFiles!: AgentsStore;
  let initialAgentFiles: AgentFile[] = [];
  let initialAgentConflicts: string[] = [];
  let guard!: GuardModeStore;
  let memoryMode!: MemoryModeStore;
  let preview!: ThemePreview;
  const [modelsCatalog, setModelsCatalog] = createSignal<ModelsCatalog | null>(null);
  const liveCatalog: ModelsCatalog = {
    get source() {
      return modelsCatalog()?.source ?? "bundle";
    },
    providers: () => modelsCatalog()?.providers() ?? [],
    provider: (id) => modelsCatalog()?.provider(id),
    models: (providerId) => modelsCatalog()?.models(providerId) ?? [],
    seed: (providerId, taken) => modelsCatalog()?.seed(providerId, taken),
    fill: (kind, modelId) => modelsCatalog()?.fill(kind, modelId),
  };
  function priceForRuntime(
    catalog: ModelsCatalog | null,
    runtimeSettings: SettingsAdapter,
    model: string,
  ): CatalogCost | undefined {
    if (!catalog) return undefined;
    try {
      const providers = runtimeSettings.effectiveProviders().map((p) => p.provider);
      return resolveModelPrice(catalog, providers, model);
    } catch {
      return undefined;
    }
  }

  function judgePayloadFor(
    runtimeDirs: ClarvisDirs,
    mode: GuardMode,
  ): { guardJudge?: { prompt: string } } {
    if (mode !== "auto") return {};
    return { guardJudge: { prompt: loadGuardJudgePrompt(runtimeDirs).prompt } };
  }

  const createRunClientCallbacks = (
    callbackTarget: WorkspaceCallbackTarget<RunHost>,
  ): KernelRunClientCallbacks => ({
    onEvent: (event, source, executionId) =>
      callbackTarget.current()?.onEvent(event, source, executionId),
    onProgress: (p, executionId) => {
      const target = callbackTarget.current();
      if (target?.ownsExecution(executionId)) target.setRunStatus(progressStatusText(p));
    },
    onMemoryIngest: (notice) => callbackTarget.current()?.onMemoryIngest(notice),
    onElicit: (params) => {
      if (!isActiveWorkspaceCallbackTarget(callbackTarget, runCallbackTarget)) {
        return Promise.resolve({ action: "cancel" });
      }
      attention.notify(
        "Clarvis needs approval: " + (params.message.split("\n", 1)[0] ?? "").trim(),
      );
      attention.setTitle("waiting for approval");
      return elicit.ask(params).finally(() => {
        if (isActiveWorkspaceCallbackTarget(callbackTarget, runCallbackTarget)) {
          attention.setTitle(callbackTarget.current()?.runActive() ? "running" : null);
        }
      });
    },
  });
  const createWorkspaceRunClient = (
    workspaceId: string,
    callbackTarget: WorkspaceCallbackTarget<RunHost>,
  ): KernelRunClient =>
    createKernelRunClient({
      createKernel: async () => (await workspaceManager.open(workspaceId)).client,
      prepareReconnect: () => workspaceManager.invalidate(workspaceId),
      callbacks: createRunClientCallbacks(callbackTarget),
    });
  const runClient = createWorkspaceRunClient(workspaceRef().id, runCallbackTarget);

  runDetailFetcher.current = (executionId) => runClient.getRun(executionId);

  const capabilities = createKernelCapabilitiesClient(runClient.skills);

  interface FoundationSnapshot {
    keys: KeysAdapter;
    settings: SettingsAdapter;
    agentFiles: AgentFile[];
    agentConflicts: string[];
    sessions: SessionStore;
    /** The one agent listing this boot made, so the profile catalogue can reuse it. */
    agentSummaries: Awaited<ReturnType<KernelRunClient["config"]["listAgents"]>>;
  }

  /**
   * The step of {@link loadFoundation} currently in flight.
   *
   * @remarks The six `boot.*` spans already time each step; this is what lets
   * the failure half name the one that threw. `FatalBoot` renders only the
   * error text, so without it a boot failure is a sentence with no phase, no
   * cause chain and no attempt number.
   */
  let bootPhase: BootPhase = "connect";
  let bootAttempt = 0;

  /**
   * Record a boot step's failure before the retry screen takes the terminal.
   *
   * @param error - what threw.
   * @remarks Extracted from the `catch` so Bun counts it as its own unit;
   * `specs/cross-cutting/test-architecture.md` §3.7 records that a `catch` body's line counter is
   * otherwise satisfied by the enclosing `try`.
   */
  function reportBootFailure(error: unknown): void {
    diagnosticEvent("boot.failed", { phase: bootPhase, error, attempt: bootAttempt }, "error");
  }

  /**
   * Note that the models catalogue did not load; the picker will be empty.
   *
   * @param reason - what went wrong, as prose.
   * @param source - `kernel` when the call itself failed, `snapshot` when it
   *   answered with nothing — the shape a bundle shipped without
   *   `models-dev.json` produces.
   */
  function reportCatalogUnavailable(reason: string, source: "kernel" | "snapshot"): void {
    diagnosticEvent("catalog.unavailable", { reason, source }, "warn");
  }

  let catalogLoad: Promise<void> | null = null;

  /** Load and project models.dev only when a catalog-backed surface is opened. */
  function ensureModelsCatalog(): Promise<void> {
    if (modelsCatalog() !== null) return Promise.resolve();
    if (catalogLoad !== null) return catalogLoad;
    diagnosticEvent("catalog.load.started", { trigger: "catalog_surface" }, "info");
    const flight = diagnosticAsync("catalog.load", async () => {
      const loaded = createModelsCatalog(await runClient.models.get());
      if (loaded.providers().length === 0)
        reportCatalogUnavailable("the catalog carries no providers", "snapshot");
      setModelsCatalog(loaded);
    })
      .catch((error: unknown) => reportCatalogUnavailable(errorText(error), "kernel"))
      .finally(() => {
        if (catalogLoad === flight) catalogLoad = null;
      });
    catalogLoad = flight;
    return flight;
  }

  async function loadFoundation(
    client: KernelRunClient,
    targetCode: CodeConfigStore,
    callbackTarget: WorkspaceCallbackTarget<RunHost>,
  ): Promise<FoundationSnapshot> {
    bootPhase = "connect";
    await diagnosticAsync("boot.kernel-connect", () => client.connect());
    bootPhase = "keys";
    const nextKeys = await diagnosticAsync("boot.keys", () => createKeysAdapter(client.secrets));
    /**
     * One agent listing for the whole boot. The settings adapter, the agent-file
     * snapshot and the profile catalogue each used to fetch their own, so a cold
     * start read the fleet from disk three times over.
     */
    bootPhase = "agents";
    const agentSummaries = await diagnosticAsync("boot.list-agents", () =>
      client.config.listAgents(),
    );
    bootPhase = "settings";
    const nextSettings = await diagnosticAsync("boot.settings", () =>
      createSettingsAdapter(client.config, {
        keys: nextKeys,
        keySource: (varName) => targetCode.keySource(varName),
        agents: agentSummaries,
      }),
    );
    bootPhase = "agent-files";
    const agentFilesSnapshot = await diagnosticAsync("boot.agent-files", () =>
      loadAgentFilesSnapshot(client.config, agentSummaries),
    );
    bootPhase = "sessions";
    const sessions = createSessionStore(
      client.sessions,
      owner,
      await loadSessions(client.sessions, owner),
      { onError: (message) => callbackTarget.current()?.setRunStatus(message) },
    );
    return {
      keys: nextKeys,
      settings: nextSettings,
      agentFiles: agentFilesSnapshot.files,
      agentConflicts: agentFilesSnapshot.conflicts,
      sessions,
      agentSummaries,
    };
  }

  let bootAgentSummaries: FoundationSnapshot["agentSummaries"] | undefined;

  function applyFoundation(snapshot: FoundationSnapshot): void {
    bootAgentSummaries = snapshot.agentSummaries;
    keys = snapshot.keys;
    settings = snapshot.settings;
    initialAgentFiles = snapshot.agentFiles;
    initialAgentConflicts = snapshot.agentConflicts;
    sessionStore = snapshot.sessions;
  }

  async function bootFoundation(): Promise<void> {
    bootAttempt += 1;
    applyFoundation(await loadFoundation(runClient, code, runCallbackTarget));
  }
  try {
    await bootFoundation();
  } catch (e) {
    reportBootFailure(e);
    conn.set({ phase: "failed", detail: errorText(e) });
    await runFatalBoot({
      renderer,
      error: e,
      retry: async () => {
        await runClient.dispose().catch(() => undefined);
        try {
          await bootFoundation();
        } catch (retryError) {
          reportBootFailure(retryError);
          throw retryError;
        }
      },
      quit: () => {
        try {
          renderer.destroy();
        } catch {}
        releaseTerminal();
        process.exit(1);
      },
    });
    conn.set({ phase: "connecting" });
  }
  bootPhase = "profiles";
  const bootProfiles = await diagnosticAsync("boot.profiles", () =>
    runClient.listProfiles(bootAgentSummaries),
  ).catch((error: unknown) => {
    reportBootFailure(error);
    throw error;
  });
  void runBootstrapGit(activeWorkspacePath, ["branch", "--show-current"])
    .then((result) => {
      setActiveBranch(result.stdout.trim() || undefined);
    })
    .catch((error: unknown) => {
      diagnosticEvent("worktree.branch.unavailable", { reason: errorText(error) }, "warn");
    });
  setProfiles(bootProfiles);
  conn.set(
    bootProfiles.length === 0 ? { phase: "ready", detail: "no profiles" } : { phase: "ready" },
  );
  const workspaceFiles = createWorkspaceFiles(runClient.files);

  interface WorkspaceAdaptersSnapshot {
    guard: GuardModeStore;
    memoryMode: MemoryModeStore;
    agentFiles: AgentsStore;
    agents: ActiveAgentStore;
    preview: ThemePreview;
    activate(): void;
    dispose(): void;
  }

  function createWorkspaceAdapters(input: {
    client: KernelRunClient;
    code: CodeConfigStore;
    settings: SettingsAdapter;
    profiles: () => ProfileInfo[];
    runtimeHost: () => RunHost | undefined;
    agentFiles: AgentFile[];
    agentConflicts: string[];
  }): WorkspaceAdaptersSnapshot {
    let snapshot!: Omit<WorkspaceAdaptersSnapshot, "activate" | "dispose">;
    let activate!: () => void;
    const dispose = createRoot((disposeRoot) => {
      const nextGuard = createGuardModeStore({
        code: input.code,
        settingsGuard: () => input.settings.effective().guard,
      });
      const nextMemoryMode = createMemoryModeStore({
        settingsMemory: () => input.settings.effective().memory,
      });
      const nextAgentFiles = createAgentsStore(
        input.client.config,
        input.agentFiles,
        input.agentConflicts,
      );
      const agentEnv = readEnvView();
      const nextAgents = createActiveAgentStore({
        profiles: input.profiles,
        code: input.code,
        sessionProfile: () => input.runtimeHost()?.sessionMeta()?.profile,
        persistActive: (name) => input.runtimeHost()?.setSessionProfile(name),
        isRunnable: (name) => {
          const file = nextAgentFiles.list().find((candidate) => candidate.name === name);
          if (file === undefined) return true;
          return (
            file.invalid === undefined &&
            agentReadiness(
              file,
              nextAgentFiles.list(),
              input.settings.effective(),
              agentEnv,
              input.settings.knownGrants(),
            ).runnable
          );
        },
      });
      const [draftGlobal, setDraftGlobal] = createSignal<ThemeConfig | null>(null);
      const [draftWorkspace, setDraftWorkspace] = createSignal<ThemeConfig | null>(null);
      const nextPreview = createThemePreview(input.code, {
        global: draftGlobal,
        setGlobal: setDraftGlobal,
        workspace: draftWorkspace,
        setWorkspace: setDraftWorkspace,
      });
      const [appearanceActive, setAppearanceActive] = createSignal(false);
      const [appearanceRevision, setAppearanceRevision] = createSignal(0);
      const theme = createTheme({ themeBg: () => platform.capabilities.themeBg() }, () =>
        nextPreview.source(),
      );
      createEffect(() => {
        appearanceRevision();
        if (!appearanceActive()) return;
        renderer.setBackgroundColor(
          theme.background() === "terminal" ? RGBA.defaultBackground() : tokens.bg,
        );
      });
      createEffect(() => {
        appearanceRevision();
        if (appearanceActive()) applyAsciiMode(asciiFlag || input.code.asciiEnabled());
      });
      activate = () => {
        batch(() => {
          setAppearanceActive(true);
          setAppearanceRevision((value) => value + 1);
        });
      };
      snapshot = {
        guard: nextGuard,
        memoryMode: nextMemoryMode,
        agentFiles: nextAgentFiles,
        agents: nextAgents,
        preview: nextPreview,
      };
      return disposeRoot;
    });
    return { ...snapshot, activate, dispose };
  }

  const publishWorkspaceAdapters = (next: WorkspaceAdaptersSnapshot): void => {
    guard = next.guard;
    memoryMode = next.memoryMode;
    agentFiles = next.agentFiles;
    agents = next.agents;
    preview = next.preview;
    next.activate();
  };
  const workspaceAdapters = createWorkspaceAdapters({
    client: runClient,
    code,
    settings,
    profiles,
    runtimeHost: () => runCallbackTarget.current(),
    agentFiles: initialAgentFiles,
    agentConflicts: initialAgentConflicts,
  });
  publishWorkspaceAdapters(workspaceAdapters);

  const buildRunHost = (input: {
    client: KernelRunClient;
    sessionStore: SessionStore;
    history: ReturnType<typeof createFilePromptHistory>;
    workspacePath: string;
    dirs: ClarvisDirs;
    settings: SettingsAdapter;
    catalog: () => ModelsCatalog | null;
    adapters: WorkspaceAdaptersSnapshot;
    profiles: () => ProfileInfo[];
  }): RunHost =>
    createRunHost({
      store,
      activity,
      sessionStore: input.sessionStore,
      history: input.history,
      client: input.client,
      elicit,
      owner,
      project: input.client.project.id,
      workspaceId: input.client.workspace.id,
      workspace: input.workspacePath,
      priceFor: (model) => priceForRuntime(input.catalog(), input.settings, model),
      activeProfile: () => input.adapters.agents.active(),
      setActiveProfile: (name) => input.adapters.agents.setActive(name),
      guardMode: () => input.adapters.guard.mode(),
      judgePayload: (mode) => judgePayloadFor(input.dirs, mode),
      memoryMode: () => input.adapters.memoryMode.mode(),
      plansMode: () => plansState(input.settings.effective()).mode,
      planProviderKey: () => knownPlanProviderKey(input.settings.effective().plans?.provider),
      isManagerProfile: () => {
        const grants = input
          .profiles()
          .find((p) => p.name === input.adapters.agents.active())?.grants;
        return Array.isArray(grants) && grants.includes("workflow");
      },
      attention,
      presentStatus: presentStatusLine,
      describeToolCall,
    });

  const runHost = buildRunHost({
    client: runClient,
    sessionStore,
    history,
    workspacePath: activeWorkspacePath,
    dirs,
    settings,
    catalog: modelsCatalog,
    adapters: workspaceAdapters,
    profiles,
  });
  runCallbackTarget.bind(runHost);
  if (historyFailure !== undefined) runHost.setRunStatus(historyFailure);
  const runStatus = (): string => runHost.runStatus();
  const setRunStatus = (value: string): void => {
    runHost.setRunStatus(value);
  };
  let workspaceCloseFlight: Promise<void> | undefined;
  const closeWorkspace = (): Promise<void> => {
    workspaceCloseFlight ??= (async () => {
      runHost.flushSession();
      await history.flush();
      await sessionStore.flushPending?.();
      try {
        await runClient.dispose();
        workspaceAdapters.dispose();
        disposeCode();
        await workspaceManager.close();
      } finally {
        runCallbackTarget.clear();
      }
    })();
    return workspaceCloseFlight;
  };
  platform.onShutdown(closeWorkspace);

  const removeSelectedWorktree = async (): Promise<void> => {
    if (!selectedWorktree) return;
    try {
      await closeWorkspace();
      await removeWorktreeCheckout(selectedWorktree);
      diagnosticEvent(
        "worktree.remove.completed",
        { name: selectedWorktree.name, branch: selectedWorktree.branch },
        "info",
      );
    } catch (error) {
      diagnosticEvent(
        "worktree.remove.failed",
        { name: selectedWorktree.name, branch: selectedWorktree.branch, error },
        "error",
      );
      throw error;
    }
  };

  async function reconnectBackend(): Promise<{ ok: boolean; message: string }> {
    if (runHost.runActive())
      return {
        ok: false,
        message: "run in progress " + glyph("emDash") + " cancel it before reconnecting",
      };
    conn.set({ phase: "connecting", detail: "reconnecting" });
    try {
      await runClient.reconnect();
      await keys.reload();
      await settings.reload();
      await agentFiles.reload();
      const profs = await runClient.listProfiles();
      setProfiles(profs);
      conn.set(profs.length === 0 ? { phase: "ready", detail: "no profiles" } : { phase: "ready" });
      return { ok: true, message: "backend reconnected " + glyph("emDash") + " keys applied" };
    } catch (e) {
      conn.set({ phase: "failed", detail: errorText(e) });
      return {
        ok: false,
        message: `reconnect failed ${glyph("emDash")} restart clarvis (${errorText(e)})`,
      };
    }
  }

  /** Reload agent files and the kernel-resolved runtime profile catalogue together. */
  async function refreshAgentProfiles(): Promise<void> {
    await agentFiles.reload();
    setProfiles(await runClient.listProfiles());
  }

  const tasks = createTasksController({
    service: runClient.tasks,
    available: () => runClient.capabilities.tasks,
    runActive: () => runHost.runActive() || runHost.bashActive(),
    workOnTask: (ref, profile) => runHost.workOnTask(ref, profile),
  });

  /**
   * A session's token counts as every surface states them: input the provider
   * had to read — {@link uncachedInput} — against output.
   *
   * @remarks One writer for the footer and Sessions both, so the two can never
   *   disagree about what "input" means. Cost keeps the gross count; only the
   *   count on screen nets the prefix-cache reads out.
   */
  function sessionTokens(totals: SessionTotals): string {
    return `${uncachedInput(totals)}${glyph("arrowRight")}${totals.output} tok`;
  }

  function sessionCostLine(): string {
    const totals = runHost.sessionMeta()?.totals;
    return totals?.costUsd === undefined ? "" : formatCostUsd(totals.costUsd);
  }

  function statusLine(): string {
    const totals = runHost.sessionMeta()?.totals;
    const tok = totals ? sessionTokens(totals) : "no tokens yet";
    return [agents.active() || "no agent", tok, runStatus()]
      .filter(Boolean)
      .join(" " + glyph("separator") + " ");
  }

  /** Write one bounded export chunk without monopolizing the TUI event loop. */
  async function writeExportChunk(output: FileHandle, chunk: string): Promise<void> {
    const bytes = Buffer.from(chunk, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = await output.write(bytes, offset, bytes.length - offset, null);
      if (written.bytesWritten <= 0) throw new Error("export write made no progress");
      offset += written.bytesWritten;
    }
  }

  async function exportSession(): Promise<string> {
    try {
      const meta = runHost.sessionMeta();
      const dir = globalPaths().exportsDirForOwner(owner);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${meta?.id ?? "session"}.md`);
      const output = await openFile(file, "w", 0o600);
      try {
        await writeExportChunk(output, transcriptMarkdownHeader(meta?.title));
        for await (const nodes of runHost.exportNodeBatches())
          for (const chunk of renderTranscriptMarkdownChunks(nodes))
            await writeExportChunk(output, chunk);
      } finally {
        await output.close();
      }
      return `exported to ${file}`;
    } catch (e) {
      return `export failed: ${errorText(e)}`;
    }
  }

  const shell: AppShell = {
    renderer,
    platform,
    debugSession,
    get workspace() {
      return activeWorkspacePath;
    },
    get workspaceLabel() {
      return workspaceRef().label;
    },
    get branch() {
      return activeBranch();
    },
    get files() {
      return workspaceFiles;
    },
    ...(selectedWorktree
      ? {
          worktree: {
            name: selectedWorktree.name,
            branch: selectedWorktree.branch,
            isClean: () => worktreeIsClean(selectedWorktree),
            requestRemoval: removeSelectedWorktree,
          },
        }
      : {}),
    quit: () => void platform.shutdown("user-quit"),
  };
  const runControls: AppRunControls = {
    status: runStatus,
    submit: (c) => detachObserved("submit_turn", () => runHost.submitTurn(c)),
    submitPrompt: (messages, display, skill) => runHost.submitPromptTurn(messages, display, skill),
    submitSkillRun: (name, task, agent) =>
      detachObserved("submit_skill_run", () => runHost.submitSkillRun(name, task, agent)),
    compact: (request) =>
      detachObserved("compact_current_run", () => runHost.compactCurrentRun(request)),
    inspectContext: (targetWindowTokens) => runHost.inspectCurrentContext(targetWindowTokens),
    fitContext: (targetWindowTokens) => runHost.fitCurrentContext(targetWindowTokens),
    cancel: () => runHost.cancelCurrentRun(),
    forceStop: () => runHost.teardownRuns(),
    active: () => runHost.runActive(),
    physicalActive: () => runHost.physicalWorkActive(),
    memory: () => runHost.memory(),
    startedAt: () => runHost.runStartedAt(),
    workflowActivity: () => runHost.workflowActivity(),
    bang: (cmd) => runHost.runBangCommand(cmd),
    localBusy: () => runHost.bashActive(),
    compacting: () => runHost.compactionActive(),
    registerDraftRestore: (fn) => runHost.registerDraftRestore(fn),
    elicit: () => elicit.request(),
    resolveElicit: (r) => elicit.resolve(r),
    switching: () => false,
  };
  const sessionControls: AppSessionControls = {
    get history() {
      return history;
    },
    list: () => listSessionsForWorkspace(sessionStore, workspaceRef().id),
    catalog: async () =>
      listSessionsForWorkspace(sessionStore, workspaceRef().id).map((meta) => ({
        meta,
        workspaceId: workspaceRef().id,
        workspaceLabel: workspaceRef().label,
        available: true,
      })),
    resume: (id) => runHost.resumeSessionById(id),
    resumeCatalog: (item) => runHost.resumeSessionById(item.meta.id),
    delete: async (item) => {
      const meta = await sessionStore.load(item.meta.id);
      if (!meta) return;
      if (runHost.sessionMeta()?.id === meta.id) runHost.clearSession({ flush: false });
      await deleteSession(meta, sessionStore, (execId) => runClient.deleteRun(execId));
    },
    clear: () => runHost.clearSession(),
    export: exportSession,
    statusLine,
    costLine: sessionCostLine,
  };
  async function refreshModels(): Promise<{ providers: number; models: number }> {
    const cat = await runClient.models.refresh();
    setModelsCatalog(createModelsCatalog(cat));
    const models = cat.providers.reduce((n, p) => n + p.models.length, 0);
    return { providers: cat.providers.length, models };
  }
  const fleet: AppFleet = {
    get agents() {
      return agents;
    },
    get agentFiles() {
      return agentFiles;
    },
    get settings() {
      return settings;
    },
    get dirs() {
      return dirs;
    },
    get code() {
      return code;
    },
    get guard() {
      return guard;
    },
    get memoryMode() {
      return memoryMode;
    },
    get preview() {
      return preview;
    },
    get keys() {
      return keys;
    },
    catalog: liveCatalog,
    loadCatalog: ensureModelsCatalog,
    refreshModels,
    refreshAgentProfiles,
  };
  const backendConn: AppBackend = {
    connection: conn.state,
    probe: backend,
    get client() {
      return capabilities;
    },
    get plans() {
      return runClient.plans;
    },
    get models() {
      return runClient.models;
    },
    get providerAuth() {
      return runClient.providerAuth;
    },
    get workflows() {
      return runClient.workflows;
    },
    getRun: (id) => runClient.getRun(id),
    get plugins() {
      return runClient.plugins;
    },
    get environments() {
      return runClient.environments;
    },
    get skills() {
      return runClient.skills;
    },
    get tasks() {
      return tasks;
    },
    get storage() {
      return runClient.storage;
    },
    reconnect: reconnectBackend,
  };

  await diagnosticAsync("boot.app-mount", async () => {
    setMountedApp({
      store,
      activity,
      shell,
      run: runControls,
      session: sessionControls,
      fleet,
      backend: backendConn,
    });
    await renderer.idle();
  });
  diagnosticEvent("app.render.mounted", { mode: mode.kind }, "info");
  diagnosticEvent(
    "app.boot.painted",
    {
      elapsed_ms: Math.round(process.uptime() * 1000),
      mode: mode.kind,
      deferred_catalog: modelsCatalog() === null,
    },
    "info",
  );
  workspaceManager.startMemoryRecovery();
  const markdownPreload = preloadMarkdown();

  if (mode.kind === "resume" || mode.kind === "continue") {
    const summary = resolveResumeMeta(sessionStore, owner, workspaceRef().id, mode);
    if (!summary) setRunStatus("session not found");
    else
      detachObserved(
        "resume_session",
        async () => {
          await markdownPreload;
          const meta = await sessionStore.load(summary.id);
          if (meta === null) throw new Error("session not found");
          await runHost.loadSessionMeta(meta);
        },
        (e) => setRunStatus(`resume failed: ${errorText(e)}`),
      );
  }
}

/**
 * Open a diagnostic session for a mode that boots no renderer.
 *
 * @param mode - the parsed invocation.
 * @remarks `--debug` used to be refused outside the interactive TUI, which left
 * `-p/--print`, `--list`, `--delete` and `--refresh-models` — the modes a script
 * or CI actually runs — with no diagnostics at all. The restriction made sense
 * while the destination might have been the terminal; the destination is a file.
 *
 * The interactive path opens its own session in {@link runApp}, because it must
 * re-register the exit handler behind the platform's so renderer teardown is
 * recorded before `diagnostics.stop`.
 */
function openHeadlessDiagnostics(mode: Mode, debug: DebugRequest): void {
  if (!debug.enabled) return;
  if (mode.kind === "run" || mode.kind === "resume" || mode.kind === "continue") return;
  const session = createDiagnosticSession({ workspace, level: debug.level });
  installDiagnosticSession(session);
  process.stderr.write(`Clarvis debug log: ${session.path}\n`);
  process.once("exit", () => session.close());
  diagnosticBind({ workspace });
  diagnosticEvent("app.boot.begin", { mode: mode.kind, workspace }, "info");
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  environmentSelector = "environmentSelector" in mode ? mode.environmentSelector : undefined;
  let selectedWorktree: WorktreeBootstrapResult | undefined;
  if ("worktree" in mode && mode.worktree !== undefined) {
    selectedWorktree = await bootstrapWorktree(workspace, mode.worktree);
    workspace = selectedWorktree.workspaceRoot;
    process.env.CLARVIS_WORKSPACE_ROOT = workspace;
  }
  const debug = resolveDebugRequest(mode, process.env);
  openHeadlessDiagnostics(mode, debug);
  switch (mode.kind) {
    case "usage-error":
      process.stderr.write(`${mode.message}\n${usageText()}\n`);
      return void process.exit(1);
    case "help":
      process.stdout.write(helpText() + "\n");
      return void process.exit(0);
    case "version":
      process.stdout.write(versionText() + "\n");
      return void process.exit(0);
    case "update": {
      const { runUpdateCommand } = await import("./update/index.ts");
      return void process.exit(await runUpdateCommand({ currentVersion: productVersion() }));
    }
    case "print":
      return void (await runPrintMode(mode));
    case "refresh-models":
      return void (await runRefreshMode());
    case "list":
      return void (await runListMode());
    case "delete":
      return void (await runDeleteMode(mode.id));
    case "resume":
    case "continue":
      return void (await runApp(mode, debug, selectedWorktree));
    case "run":
      return void (await runApp(mode, debug, selectedWorktree));
  }
}

detachObserved("code_main", main, (e) => {
  process.stderr.write(`clarvis failed: ${errorText(e)}\n`);
  process.exitCode = 1;
});
