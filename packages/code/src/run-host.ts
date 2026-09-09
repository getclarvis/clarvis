import { createHash } from "node:crypto";
import { batch, createRoot, createSignal, type Accessor, type Setter } from "solid-js";
import {
  sameLoopBinding,
  type LoopBinding,
  type LoopTurnCompletion,
  type ScheduledTurnAdmission,
  type ScheduledTurnRequest,
} from "./core/loop-schedule.ts";
import type {
  ActiveTaskRequestDto,
  HostedActivityLease,
  HostedRunReceipt,
  HostedRunRef,
  Message,
  MessageContent,
  PlansMode,
  TaskRefDto,
} from "@clarvis/protocol";
import type { RunDetail, RunEvent, RunRecovery, RunResult } from "@clarvis/protocol";
import { memoryIngestIsPending } from "./adapters/event-span.ts";
import { appendMentionImages, buildContent, MentionImageError } from "./core/attachments.ts";
import { createImageLoader } from "./adapters/workspace-files.ts";
import { errorText } from "./adapters/errors.ts";
import { detachObserved } from "./core/tasks.ts";
import { diagnosticBind } from "./core/diagnostic-events.ts";
import type { KernelRunClient } from "./adapters/kernel-run-client.ts";
import type { CompactResult, MemoryIngestNotice, RunHandle } from "./adapters/run-types.ts";
import {
  applyEvent,
  boundTranscriptText,
  createTranscriptStore,
  teeSink,
  transcriptTextFingerprint,
  type RunSink,
  type TranscriptNode,
  type TranscriptStore,
  type TranscriptStoreDeps,
} from "./adapters/store.ts";
import { formatBashObservation, runLocalBash } from "./adapters/local-shell.ts";
import type { ActivityStore } from "./adapters/activity-store.ts";
import { promptMessagesToContent, type PromptMessage } from "./adapters/mcp-capabilities.ts";
import type { ElicitSlot } from "./adapters/elicit-slot.ts";
import type { GuardMode } from "./adapters/guard-mode.ts";
import type { MemoryMode } from "./adapters/memory-mode.ts";
import type { PlanMode } from "./adapters/execution-safety.ts";
import type { CatalogCost } from "./adapters/models-catalog.ts";
import { contentToText } from "./adapters/message-content.ts";
import type { EventSource } from "./adapters/event-span.ts";
import {
  reduceWorkflowProjection,
  type WorkflowActivity,
  type WorkflowProjectionEvent,
} from "./adapters/workflow-projection.ts";
import {
  addUsageToTotals,
  redactPreview,
  type SessionId,
  type SessionMeta,
  type SessionStore,
  type SessionTotals,
} from "./adapters/session-store.ts";
import type { Attention } from "./core/attention.ts";
import { memoryNoticeStatus, plainStatusLine, type StatusLine } from "./core/run-status.ts";
import {
  buildSkillRunDigest,
  createSession,
  isContinuationUnavailable,
  resumeSession,
  type Session,
} from "./adapters/session.ts";
import type { PromptHistory } from "./core/prompt-history.ts";

/**
 * Everything {@link createRunHost} needs from its host: the transcript,
 * activity and session stores, the kernel run client, and the presentation/
 * policy hooks a headless host may omit.
 */
export interface RunHostDeps {
  store: TranscriptStore;
  activity: ActivityStore;
  sessionStore: SessionStore;
  history: PromptHistory;
  client: Pick<KernelRunClient, "startRun" | "steer" | "compact" | "getRun" | "files"> &
    Partial<Pick<KernelRunClient, "context" | "currentExtensionProfile" | "hosting" | "attachRun">>;
  elicit: Pick<ElicitSlot, "cancelPending">;
  owner: string;
  project: string;
  workspaceId: string;
  workspace: string;
  priceFor: (model: string) => CatalogCost | undefined;
  activeProfile: () => string;
  setActiveProfile: (name: string) => void;
  guardMode: () => GuardMode;
  judgePayload: (mode: GuardMode) => { guardJudge?: { prompt: string } };
  memoryMode: () => MemoryMode;
  /** The planning policy the next run will use, so the shell can warn about an
   * approval gate before the run starts. Optional; headless hosts omit it. */
  plansMode?: () => PlanMode;
  /** Static identity of the selected plan provider, when it can be known
   * without resolving or importing provider code. */
  planProviderKey?: () => string | undefined;
  /** True when the active Agent Profile carries the `workflow` grant, so the kernel will
   * route its run as a workflow (a manager fanning out leader runs). Used only to
   * drive local UI (arm the tree projection) and to keep the manager on the
   * full-message path — routing itself is the kernel's decision by grant, not a
   * client toggle. */
  isManagerProfile?: () => boolean;
  /** Terminal attention cues (title + notification); optional so headless hosts no-op. */
  attention?: Pick<Attention, "notify" | "setTitle" | "away">;
  /** Injectable for tests only; production uses the real local shell. */
  runBash?: typeof runLocalBash;
  /** Presentation port for semantic status segments; headless hosts use ASCII. */
  presentStatus?: (line: StatusLine) => string;
  /**
   * Renders the always-resident projection of a tool call, as passed to the
   * live transcript store.
   *
   * @remarks Supplied so {@link RunHost.exportNodeBatches} reconstructs folded turns
   *   with the same signatures the live transcript shows. Omitted, those blocks
   *   fall back to whatever fields survive, exactly as the store does.
   */
  describeToolCall?: TranscriptStoreDeps["describeToolCall"];
  /** Current settings/agent content identity, supplied by the runtime without disclosing values. */
  executionConfiguration?: () => { fingerprint: string; label: string };
  /** Current connection, readiness and UI admission gates; never grants authority itself. */
  scheduledBlockedReason?: () => string | null;
  /** Invalidate in-memory recurrence when the conversation or host authority changes. */
  onSessionInvalidated?: (id: string, reason: "clear" | "switch" | "teardown") => void;
}

/** One live-only MCP startup warning that the TUI may show outside the transcript. */
export interface McpStartupNotice {
  /** Monotonic session-local identity used to display this notice once. */
  sequence: number;
  /** Newly observed server failures, already sanitized by the run protocol. */
  servers: ReadonlyArray<{ name: string; reason: string }>;
}

/**
 * The stateful bridge a UI shell (interactive or headless) drives to submit,
 * steer and cancel turns, manage the active session, and read back run and
 * workflow status.
 */
export interface RunHost {
  /** True only while the current run can still accept interactive control. */
  runActive: Accessor<boolean>;
  /** The currently observed run has a host-confirmed policy to continue after this TUI exits. */
  continuesOnExit: Accessor<boolean>;
  bashActive: Accessor<boolean>;
  /** True while the context-compaction pipeline is doing hook or model work. */
  compactionActive: Accessor<boolean>;
  /** True until every started run handle and local command has physically settled. */
  physicalWorkActive: Accessor<boolean>;
  /** Aggregate host-owned counters used by the sampled process memory ledger. */
  memory(): Record<string, number | boolean>;
  runStatus: Accessor<string>;
  setRunStatus: Setter<string>;
  /** Epoch ms of the current (or last) managed run's start; null before any run. */
  runStartedAt: Accessor<number | null>;
  /** Persisted session totals captured immediately before the active run. */
  sessionUsageBaseline: Accessor<SessionTotals | null>;
  /** The current (or last) workflow's live tree, folded from its manager's
   * structural events; `null` when the active/last run was not a workflow. */
  workflowActivity: Accessor<WorkflowActivity | null>;
  /** Latest unique live MCP startup failure; replay never repopulates it. */
  mcpStartupNotice: Accessor<McpStartupNotice | null>;
  /** Whether `executionId` currently owns the live transcript/progress surface. */
  ownsExecution(executionId: string): boolean;
  onEvent(event: RunEvent, source: EventSource, executionId?: string): void;
  /**
   * Applies a memory-ingest notice to the status line.
   *
   * @remarks
   * A `"started"` or `"queued"` phase (including a retry-driven re-`"queued"`)
   * composes onto, and retains, the line's current base, so that a later
   * terminal phase replaces the composed line rather than concatenating onto
   * one that is already composed.
   */
  onMemoryIngest(notice: MemoryIngestNotice): void;
  cancelCurrentRun(): boolean;
  compactCurrentRun(request?: string): Promise<void>;
  inspectCurrentContext(targetWindowTokens: number): ReturnType<KernelRunClient["context"]> | null;
  fitCurrentContext(targetWindowTokens: number): Promise<CompactResult | null>;
  teardownRuns(): void;
  /** Abort TUI-owned shell work and wait for its physical completion and lease release before disconnecting. */
  stopLocalWork(): Promise<void>;
  /** Commit continuation in the independent host and release only this TUI's ownership. */
  backgroundCurrentRun(): Promise<HostedRunReceipt>;
  /** Open a hosted execution's conversation and observe the same execution without a start. */
  attachHostedRun(ref: HostedRunRef, control?: "observe" | "acquire" | "takeover"): Promise<void>;
  submitTurn(content: MessageContent, display?: string): Promise<void>;
  /** Current live conversation binding; materialization creates no run or transcript message. */
  scheduledBinding(materialize?: boolean): LoopBinding | null;
  /** Reserve an automatic turn synchronously; an occupied host never converts it to steer. */
  submitScheduledTurn(request: ScheduledTurnRequest): ScheduledTurnAdmission;
  /** Reactive complete admission gate, including preparation, reconciliation and physical work. */
  scheduledBusy: Accessor<boolean>;
  submitPromptTurn(
    messages: PromptMessage[],
    display?: string,
    skill?: { name: string; task?: string; plansMode?: PlansMode },
  ): void;
  /** Run a skill that names an agent as a run of its own, on that agent. */
  submitSkillRun(name: string, task: string, agent: string): Promise<void>;
  /** Start a fresh session bound to one provider-neutral task in this workspace. */
  workOnTask(ref: TaskRefDto, profile: string): Promise<void>;
  runBangCommand(cmd: string): boolean;
  clearSession(opts?: { flush?: boolean }): void;
  loadSessionMeta(meta: SessionMeta): Promise<void>;
  resumeSessionById(id: SessionId): Promise<void>;
  /**
   * The whole session as bounded transcript batches, including folded turns.
   *
   * @remarks Resuming a session only replays the most recent turns into the
   *   transcript, and a live session applies the same bound once it exceeds 20
   *   turns. The complete old prefix becomes one notice, which carries no reply.
   *   Reading `store.nodes` for an export would therefore drop its content. This
   *   refetches each folded turn's trace and rebuilds it into a throwaway store,
   *   so the export describes the session rather than whatever the view happens
   *   to be holding.
   *
   *   A folded turn whose trace can no longer be fetched keeps the same notice
   *   it already shows on screen; an export is never failed by one missing
   *   trace. Each folded turn is yielded before the next one is rebuilt, so an
   *   export never retains a second copy of the whole session. Nothing is
   *   refetched while the session still fits in the resident window; there the
   *   sole batch is exactly `store.nodes`.
   */
  exportNodeBatches(): AsyncIterable<readonly TranscriptNode[]>;
  sessionMeta(): SessionMeta | null;
  setSessionProfile(name: string): void;
  flushSession(): void;
  registerDraftRestore(fn: (text: string, content?: MessageContent) => void): void;
}

/**
 * Nodes yielded per batch while streaming a transcript export.
 *
 * @remarks Chunking exists so an export of an arbitrarily long session never
 * materializes the whole transcript at once; the size only decides how often the
 * generator yields back to the event loop, and neither direction changes the
 * result. Small enough that a batch is not itself a large allocation, large
 * enough that the per-batch overhead disappears against the nodes in it.
 */
const EXPORT_BATCH_NODE_LIMIT = 128;
/**
 * Number of complete semantic turns retained in the live Solid transcript.
 *
 * @remarks The bound on *resident* turns, not on the session: an older turn is
 * folded to a placeholder and its prose released, and it is still readable from
 * the run trace. So this trades scrollback against the memory and reconciliation
 * cost of keeping every node mounted in Solid. Twenty is set at how far back a
 * person scrolls without reaching for history — beyond that they are looking
 * something up, which the export and the trace answer better than a live tree.
 */
export const RESIDENT_TRANSCRIPT_TURN_LIMIT = 20;
const EXPORT_INCOMPLETE_PREFIX =
  "EXPORT INCOMPLETE — original transcript prose was released from the live TUI";

interface ResidentTurnRef {
  userKey: string;
}

/**
 * The transcript line a turn gets when its persisted record was rebuilt from a
 * damaged crash journal.
 *
 * @param recovery - the counts the kernel forwarded from the stored record.
 * @returns a factual sentence naming both counts.
 * @remarks Deliberately not alarming: the run itself happened and its surviving
 *   events are shown above this line. What is being reported is that the
 *   *record* is partial — the log half of that fact
 *   (`trace.journal_recovery_degraded`) reaches an operator's stderr, which the
 *   person reading the transcript has no access to.
 */
function recoveryNotice(recovery: RunRecovery): string {
  const parts: string[] = [];
  if (recovery.skipped_lines > 0) {
    const n = recovery.skipped_lines;
    parts.push(`${n} journal line${n === 1 ? "" : "s"} lost`);
  }
  if (recovery.synthesized_tool_calls > 0) {
    const n = recovery.synthesized_tool_calls;
    parts.push(`${n} tool result${n === 1 ? "" : "s"} synthesized`);
  }
  return `partial record — this turn was rebuilt from a damaged journal after a crash: ${parts.join(", ")}. The run happened; this record of it is incomplete.`;
}

/** Human-sized SHA-256 prefix without repeating the algorithm label. */
function fingerprintPrefix(fingerprint: string): string {
  return fingerprint.startsWith("sha256:")
    ? fingerprint.slice("sha256:".length, "sha256:".length + 8)
    : fingerprint.slice(0, 8);
}

function foldedPrefixNotice(turns: number): string {
  return `${turns} earlier turn${turns === 1 ? " was" : "s were"} folded from this live view to protect memory. Use /export to read the persisted transcript.`;
}

/** Composer text excludes the placeholders used by transcript-only projections. */
function composerText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (part): part is Extract<(typeof content)[number], { type: "text" }> => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

type ProseNode = TranscriptNode & { kind: "user" | "assistant" | "reasoning" };

function isReleasedProse(node: TranscriptNode): node is ProseNode {
  return (
    (node.kind === "user" || node.kind === "assistant" || node.kind === "reasoning") &&
    node.proseReleased === true
  );
}

function sourceExecutionId(node: ProseNode): string | undefined {
  if (node.kind === "user") return node.sourceExecutionId;
  const separator = node.key.indexOf("::");
  return separator > 0 ? node.key.slice(0, separator) : undefined;
}

function incompleteExportNode(node: ProseNode, reason: string): TranscriptNode {
  return {
    ...node,
    proseReleased: undefined,
    textTruncated: true,
    text: `${EXPORT_INCOMPLETE_PREFIX}; ${reason}.`,
  };
}

function replayRunEvents(sink: RunSink, stored: RunDetail | null): void {
  const events = stored?.events;
  if (!events || events.length === 0) return;
  batch(() => {
    sink.beginReconcile();
    for (const event of events) applyEvent(sink, event, "replay");
    sink.endReconcile();
  });
}

function runOutcomeStatus(envelope: RunResult | undefined): StatusLine {
  if (envelope?.status === "failed" && envelope.error) {
    return ["failed ", { mark: "emDash" }, ` ${envelope.error.message}`];
  }
  return [envelope?.status ?? "done"];
}

/**
 * Builds the {@link RunHost}: the stateful bridge between a UI shell and the
 * kernel run client, owning the active session, the in-flight run handle, and
 * the transcript/activity/status projections derived from its events.
 *
 * @param deps - {@link RunHostDeps}.
 * @returns The {@link RunHost} handle.
 */
export function createRunHost(deps: RunHostDeps): RunHost {
  const {
    store,
    activity,
    sessionStore,
    history,
    client,
    elicit,
    owner,
    project,
    workspaceId,
    workspace,
  } = deps;
  const loadImage = createImageLoader(client.files);
  const runBash = deps.runBash ?? runLocalBash;
  const presentStatus = deps.presentStatus ?? plainStatusLine;

  let currentSink: { executionId: string; sink: RunSink; transcript: RunSink } | undefined;
  let currentHandle: RunHandle | undefined;
  const physicalHandles = new Set<RunHandle>();
  /** Serializes a new semantic turn behind reconciliation without extending steer mode. */
  let currentSettlement: { promise: Promise<void>; release: () => void } | undefined;
  let runOwnershipEpoch = 0;
  let cancelRequested = false;
  let session: Session | undefined;
  const configurationSessions = new WeakMap<Session, string>();
  const configurationSessionId = (active: Session): string => {
    let id = configurationSessions.get(active);
    if (id === undefined) {
      id = crypto.randomUUID();
      configurationSessions.set(active, id);
    }
    return id;
  };
  let sessionTask: ActiveTaskRequestDto | undefined;
  const [runActive, setRunActive] = createSignal(false);
  const [disconnectPolicy, setDisconnectPolicy] =
    createSignal<HostedRunRef["disconnect_policy"]>("cancel");
  const [compactionActive, setCompactionActive] = createSignal(false);
  const [physicalRunCount, setPhysicalRunCount] = createSignal(0);
  let bashAbort: AbortController | undefined;
  let localWork: Promise<void> | undefined;
  const [bashActive, setBashActive] = createSignal(false);
  const [runStatus, setRunStatus] = createSignal("idle");
  const setStatus = (line: StatusLine): void => {
    setRunStatus(presentStatus(line));
  };
  const [runStartedAt, setRunStartedAt] = createSignal<number | null>(null);
  const [sessionUsageBaseline, setSessionUsageBaseline] = createSignal<SessionTotals | null>(null);
  const [workflowActivity, setWorkflowActivity] = createSignal<WorkflowActivity | null>(null);
  const [mcpStartupNotice, setMcpStartupNotice] = createSignal<McpStartupNotice | null>(null);
  const seenMcpStartupFailures = new Set<string>();
  let mcpStartupNoticeSequence = 0;
  /** Set to the active workflow's manager execution id while a workflow is
   * in flight (live events only); null for a plain run. Gates whether `onEvent`
   * also folds the event into `workflowActivity`. */
  let workflowRunId: string | null = null;
  let draftRestore: ((text: string, content?: MessageContent) => void) | undefined;
  let loadEpoch = 0;
  const [sessionGeneration, setSessionGeneration] = createSignal(0);
  const [sessionLoading, setSessionLoading] = createSignal(false);
  const [humanSubmissions, setHumanSubmissions] = createSignal(0);
  const [compactionCalls, setCompactionCalls] = createSignal(0);
  const [localCommandCount, setLocalCommandCount] = createSignal(0);
  const [scheduledReserved, setScheduledReserved] = createSignal(false);
  const [settlementActive, setSettlementActive] = createSignal(false);
  interface ScheduledReservation {
    request: ScheduledTurnRequest;
    executionId: string;
    ready: Promise<void>;
    releaseReady(): void;
    cancelled: boolean;
    handles: RunHandle[];
  }
  let scheduledReservation: ScheduledReservation | undefined;

  function scheduledBinding(materialize = false): LoopBinding | null {
    const generation = sessionGeneration();
    if (sessionLoading()) return null;
    const profile = deps.activeProfile();
    if (!profile) return null;
    if (!session && materialize) {
      loadEpoch += 1;
      session = createSession(boundSessionDeps, { agentProfile: profile });
    }
    const meta = materialize ? session?.ensureIdentity("Scheduled conversation") : session?.meta();
    if (!meta) return null;
    const configuration = deps.executionConfiguration?.();
    return {
      sessionId: meta.id,
      generation,
      owner,
      workspaceId,
      agentId: profile,
      configFingerprint: createHash("sha256")
        .update(
          JSON.stringify([
            configuration?.fingerprint,
            profile,
            deps.guardMode(),
            deps.judgePayload(deps.guardMode()),
            deps.memoryMode(),
            deps.plansMode?.(),
            deps.planProviderKey?.(),
            sessionTask,
            client.currentExtensionProfile?.(),
          ]),
        )
        .digest("hex"),
      configLabel:
        configuration?.label ?? `review ${deps.guardMode()} · memory ${deps.memoryMode()}`,
    };
  }

  const scheduledBusy = (): boolean =>
    scheduledReserved() ||
    humanSubmissions() > 0 ||
    sessionLoading() ||
    settlementActive() ||
    runActive() ||
    physicalRunCount() > 0 ||
    localCommandCount() > 0 ||
    compactionActive() ||
    compactionCalls() > 0;

  function assertAutomatic(reservation: ScheduledReservation): void {
    if (
      reservation.cancelled ||
      !reservation.request.valid() ||
      !sameLoopBinding(reservation.request.binding, scheduledBinding()) ||
      deps.scheduledBlockedReason?.()
    )
      throw new Error("Scheduled occurrence invalidated before dispatch.");
  }

  function turnCompletion(result: RunResult | undefined): LoopTurnCompletion {
    if (!result || result.status === "running")
      return {
        status: "unknown",
        reason: "Run result is unavailable; inspect it before resuming.",
        usage: {},
      };
    const totals: SessionTotals = { input: 0, output: 0 };
    if (result.usage) addUsageToTotals(totals, result.usage, priceFor);
    const attributed = (result.usage?.by_agent?.length ?? 0) > 0;
    const costsKnown =
      attributed && result.usage!.by_agent!.every((agent) => priceFor(agent.model) !== undefined);
    return {
      status: result.status,
      ...(result.error?.message
        ? { reason: result.error.message }
        : result.ended_reason && result.status !== "completed"
          ? { reason: result.ended_reason }
          : {}),
      usage: result.usage
        ? {
            ...(attributed || result.usage.input_tokens !== undefined
              ? { input: attributed ? totals.input : result.usage.input_tokens }
              : {}),
            ...(attributed || result.usage.output_tokens !== undefined
              ? { output: attributed ? totals.output : result.usage.output_tokens }
              : {}),
            ...(costsKnown ? { costUsd: totals.costUsd ?? 0 } : {}),
          }
        : {},
    };
  }

  function submitScheduledTurn(request: ScheduledTurnRequest): ScheduledTurnAdmission {
    if (!sameLoopBinding(request.binding, scheduledBinding()) || !request.valid())
      return {
        status: "refused",
        reason: "Conversation or execution configuration changed; resume explicitly.",
      };
    const blocked = deps.scheduledBlockedReason?.();
    if (blocked) return { status: "deferred", reason: blocked };
    if (scheduledBusy()) return { status: "deferred", reason: "The conversation is occupied." };
    let releaseReady!: () => void;
    const reservation: ScheduledReservation = {
      request,
      executionId: "exec_" + crypto.randomUUID(),
      cancelled: false,
      handles: [],
      ready: new Promise<void>((resolve) => {
        releaseReady = resolve;
      }),
      releaseReady: () => releaseReady(),
    };
    scheduledReservation = reservation;
    setScheduledReserved(true);
    const completion = (async (): Promise<LoopTurnCompletion> => {
      let result: LoopTurnCompletion;
      try {
        result =
          (await submitPreparedTurn(request.prompt, undefined, undefined, reservation)) ??
          turnCompletion(undefined);
      } catch (error) {
        result = {
          status: reservation.cancelled ? "cancelled" : "failed",
          reason: errorText(error),
          usage: {},
        };
      } finally {
        reservation.releaseReady();
      }
      const closed = await Promise.allSettled(reservation.handles.map((handle) => handle.closed));
      if (closed.some((entry) => entry.status === "rejected"))
        result = {
          ...result,
          status: "unknown",
          reason: "Run closure failed; inspect its result before resuming.",
        };
      if (scheduledReservation === reservation) scheduledReservation = undefined;
      setScheduledReserved(scheduledReservation !== undefined);
      return result;
    })();
    return {
      status: "admitted",
      executionId: reservation.executionId,
      completion,
      cancel: async () => {
        reservation.cancelled = true;
        const handle = reservation.handles.at(-1);
        if (handle) await handle.cancel();
      },
    };
  }

  function isWorkflowProjectionEvent(event: RunEvent): event is WorkflowProjectionEvent {
    return (
      event.type === "workflow_run_started" ||
      event.type === "workflow_title_updated" ||
      event.type === "workflow_sequence_state" ||
      event.type === "workflow_run_progress" ||
      event.type === "workflow_run_completed" ||
      event.type === "workflow_run_failed" ||
      event.type === "run_ended"
    );
  }

  function priceFor(model: string): CatalogCost | undefined {
    return deps.priceFor(model);
  }

  const boundSessionDeps = {
    store: sessionStore,
    owner,
    project,
    workspace: workspaceId,
    priceFor,
    hosted: client.hosting !== undefined,
    ...(client.currentExtensionProfile === undefined
      ? {}
      : { extensionProfile: client.currentExtensionProfile }),
  };
  let sessionRetirement: Promise<void> = Promise.resolve();
  let handoffFlight: Promise<HostedRunReceipt> | undefined;
  let pendingHandoff: { operationId: string; executionId: string } | undefined;

  async function prepareHostedSession(
    sess: Session,
    title: string,
  ): Promise<
    | {
        session_id: string;
        session_revision: number;
      }
    | undefined
  > {
    if (client.hosting === undefined) return undefined;
    await sessionRetirement;
    const identity = sess.ensureIdentity(title);
    await sessionStore.flushPending?.();
    const canonical = await sessionStore.load(identity.id, { refresh: true });
    if (session !== sess) throw new Error("conversation changed during hosted preparation");
    if (canonical?.revision === undefined)
      throw new Error("hosted conversation has no confirmed revision");
    sess.acceptHosted(canonical);
    return { session_id: canonical.id, session_revision: canonical.revision };
  }

  /**
   * Apply one run event to the transcript and the workflow projection.
   *
   * @remarks Batched because a single event routinely produces several store
   *   writes — `iteration_completed` alone does a `remove`, two `patch`es and an
   *   `upsert` — and every one of them writes a field the
   *   `grouped → toolGroups → focusables` memo chain reads, so an unbatched
   *   event re-runs that chain and the transcript's `<For>` diff once per write.
   *   The replay and resume paths already batch; this is the live one.
   */
  function onEvent(event: RunEvent, source: EventSource, executionId?: string): void {
    batch(() => {
      const target = currentSink;
      const ownsSurface =
        target !== undefined && (executionId === undefined || target.executionId === executionId);
      if (ownsSurface) {
        applyEvent(target.sink, event, source);
        if (source === "live") {
          if (event.type === "mcp_degraded") {
            const servers = event.servers.filter((server) => {
              const key = `${server.name}\0${server.reason}`;
              if (seenMcpStartupFailures.has(key)) return false;
              seenMcpStartupFailures.add(key);
              return true;
            });
            if (servers.length > 0) {
              setMcpStartupNotice({ sequence: ++mcpStartupNoticeSequence, servers });
            }
          }
          if (event.type === "compaction_started") setCompactionActive(true);
          else if (
            event.type === "compaction" ||
            event.type === "compaction_skipped" ||
            event.type === "run_ended"
          )
            setCompactionActive(false);
        }
      }
      if (source === "live" && workflowRunId !== null && isWorkflowProjectionEvent(event)) {
        if (executionId !== undefined && executionId !== workflowRunId) return;
        setWorkflowActivity((prev) => reduceWorkflowProjection(prev, event));
      }
    });
  }

  let memoryStatusBase: string | null = null;
  let heldIngest: MemoryIngestNotice | null = null;
  /** Which run's memory segment currently owns the status line. Set at the
   * top of every `runManaged` call; a notice whose `execution_id` doesn't
   * match this belongs to a run this line no longer represents (a stale,
   * late-arriving notice from an earlier turn) and must not touch the
   * display. */
  let currentStatusExecId: string | null = null;

  function onMemoryIngest(notice: MemoryIngestNotice): void {
    if (notice.execution_id !== currentStatusExecId) return;
    if (runActive() || bashActive()) {
      heldIngest = notice;
      memoryStatusBase = null;
      return;
    }
    if (memoryIngestIsPending(notice.phase)) {
      if (memoryStatusBase === null) memoryStatusBase = runStatus();
      setStatus([
        memoryStatusBase,
        "  ",
        { mark: "separator" },
        "  ",
        ...memoryNoticeStatus(notice),
      ]);
      return;
    }
    const base = memoryStatusBase ?? runStatus();
    memoryStatusBase = null;
    setStatus([base, "  ", { mark: "separator" }, "  ", ...memoryNoticeStatus(notice)]);
  }

  function cancelCurrentRun(): boolean {
    if (bashAbort) {
      // Aborting is idempotent at the platform boundary, but it must not be
      // idempotent at the keyboard boundary: once cancellation is pending,
      // another ^C belongs to the quit gate instead of being swallowed here.
      if (bashAbort.signal.aborted) return false;
      bashAbort.abort();
      setStatus(["! cancelling", { mark: "ellipsis" }]);
      return true;
    }
    // A handle that is no longer running has nothing to cancel, and saying so
    // would be worse than silence: `cancelRequested` makes the settled run read
    // `Canceled` for the rest of the session. Pressing ^c in the instant a run
    // finishes did exactly that, permanently relabelling a run whose correct
    // answer was already on screen under a `✓ Completed` node.
    if (!currentHandle || !runActive() || cancelRequested) return false;
    cancelRequested = true;
    setStatus(["cancelling", { mark: "ellipsis" }]);
    const handle = currentHandle;
    if (scheduledReservation?.handles.includes(handle)) scheduledReservation.cancelled = true;
    void handle.cancel().catch((error: unknown) => {
      if (currentHandle !== handle || !runActive()) return;
      cancelRequested = false;
      setStatus(["cancel request failed ", { mark: "emDash" }, ` ${errorText(error)}`]);
    });
    return true;
  }

  function latestExecutionId(): string | undefined {
    return runActive() && currentHandle !== undefined
      ? currentHandle.executionId
      : [...(session?.meta()?.turns ?? [])]
          .reverse()
          .find((turn) => turn.kind === "conversation" && turn.executionId !== undefined)
          ?.executionId;
  }

  async function compactCurrentRun(request?: string): Promise<void> {
    if (scheduledReserved() && !runActive()) {
      setStatus(["a scheduled turn is preparing or closing; compact after it settles"]);
      return;
    }
    const executionId = latestExecutionId();
    if (executionId === undefined) {
      setStatus(["no session context to compact"]);
      return;
    }
    const settled = !runActive();
    setCompactionCalls((count) => count + 1);
    if (settled) setCompactionActive(true);
    try {
      const result = await client.compact({
        executionId,
        ...(request?.trim() ? { request: request.trim() } : {}),
      });
      if (result.status === "queued") {
        setStatus(["compaction queued ", { mark: "emDash" }, " before the next model call"]);
      } else if (result.status === "compacted") {
        setStatus([
          "context compacted ",
          { mark: "emDash" },
          ` ${result.freed_chars.toLocaleString()} chars freed for the next run`,
        ]);
      } else {
        setStatus([`compaction skipped: ${result.reason.replaceAll("_", " ")}`]);
      }
    } catch (error) {
      setStatus([`compaction failed: ${errorText(error)}`]);
    } finally {
      setCompactionCalls((count) => count - 1);
      if (settled) setCompactionActive(false);
    }
  }

  function inspectCurrentContext(
    targetWindowTokens: number,
  ): ReturnType<KernelRunClient["context"]> | null {
    const executionId = latestExecutionId();
    return executionId === undefined || client.context === undefined
      ? null
      : client.context(executionId, targetWindowTokens);
  }

  async function fitCurrentContext(targetWindowTokens: number): Promise<CompactResult | null> {
    if (scheduledReserved() && !runActive()) return null;
    const executionId = latestExecutionId();
    if (executionId === undefined) return null;
    setCompactionCalls((count) => count + 1);
    try {
      return await client.compact({ executionId, mechanicalTargetTokens: targetWindowTokens });
    } finally {
      setCompactionCalls((count) => count - 1);
    }
  }

  function teardownRuns(reason: "clear" | "switch" | "teardown" = "teardown"): void {
    const previousSession = session?.meta()?.id;
    if (previousSession) deps.onSessionInvalidated?.(previousSession, reason);
    const hosting = client.hosting;
    if (hosting !== undefined && previousSession !== undefined) {
      sessionRetirement = Promise.all([
        sessionRetirement,
        hosting.closeSession(previousSession),
      ]).then(() => undefined);
      detachObserved("hosting.session.retirement", () => sessionRetirement);
    }
    if (scheduledReservation) {
      scheduledReservation.cancelled = true;
      scheduledReservation.releaseReady();
    }
    runOwnershipEpoch += 1;
    setSessionGeneration((generation) => generation + 1);
    const settlement = currentSettlement;
    currentSettlement = undefined;
    setSettlementActive(false);
    settlement?.release();
    bashAbort?.abort();
    if (currentHandle && hosting === undefined) {
      cancelRequested = true;
      void currentHandle.cancel().catch(() => undefined);
    }
    if (hosting !== undefined) {
      for (const handle of physicalHandles) {
        if (handle.releaseObservation !== undefined)
          detachObserved("hosting.observation.release", () => handle.releaseObservation!());
        physicalHandles.delete(handle);
        setPhysicalRunCount((count) => Math.max(0, count - 1));
      }
    }
    currentSink = undefined;
    currentHandle = undefined;
    workflowRunId = null;
    currentStatusExecId = null;
    heldIngest = null;
    diagnosticBind({ execution_id: undefined });
    setRunActive(false);
    setCompactionActive(false);
    setSessionUsageBaseline(null);
    deps.attention?.setTitle(null);
  }

  function backgroundCurrentRun(): Promise<HostedRunReceipt> {
    if (handoffFlight !== undefined) return handoffFlight;
    const hosting = client.hosting;
    const handle = currentHandle;
    const sess = session;
    if (hosting === undefined || handle === undefined || sess === undefined)
      return Promise.reject(new Error("there is no hosted run to move to background"));
    if (bashActive() || compactionActive())
      return Promise.reject(new Error("finish the local command or compaction before background"));
    const ownership = runOwnershipEpoch;
    const flight = (async () => {
      let receipt: HostedRunReceipt | null;
      if (pendingHandoff?.executionId === handle.executionId) {
        receipt = await hosting.receipt(pendingHandoff.operationId);
        if (receipt === null)
          throw new Error("background handoff is unconfirmed; reconnect to inspect the hosted run");
      } else {
        const ref = (await hosting.list()).find(
          (entry) => entry.execution_id === handle.executionId,
        );
        if (
          ref === undefined ||
          ref.session_id !== sess.meta()?.id ||
          ref.workspace_id !== workspaceId ||
          session !== sess ||
          runOwnershipEpoch !== ownership
        )
          throw new Error("conversation changed before background handoff");
        const operationId = crypto.randomUUID();
        pendingHandoff = { executionId: handle.executionId, operationId };
        try {
          receipt = await hosting.detach({
            execution_id: ref.execution_id,
            host_generation: ref.host_generation,
            operation_id: operationId,
            control_epoch: ref.control_epoch,
            revision: ref.revision,
          });
        } catch (error) {
          const recovered = await hosting.receipt(operationId).catch(() => null);
          if (recovered === null) throw error;
          receipt = recovered;
        }
      }
      if (session === sess && runOwnershipEpoch === ownership) {
        teardownRuns("teardown");
        elicit.cancelPending();
        setStatus(["run continues in background"]);
      } else
        throw new Error(
          "The run is in background; the conversation changed, so this TUI remains open.",
        );
      return receipt;
    })();
    handoffFlight = flight;
    void flight.then(
      () => {
        if (handoffFlight === flight) handoffFlight = undefined;
      },
      () => {
        if (handoffFlight === flight) handoffFlight = undefined;
      },
    );
    return flight;
  }

  type RunEnvelope = Awaited<RunHandle["done"]>;
  type StoredRun = Awaited<ReturnType<typeof client.getRun>>;

  /**
   * Runs one managed turn: opens transcript/activity sinks, tracks run status
   * and terminal attention, then settles bookkeeping (session state, stored-run
   * reconciliation) once `opts.run` resolves or rejects.
   *
   * @remarks
   * Resets `memoryStatusBase` to `null` before starting: a base captured for a
   * run whose terminal memory notice never arrived (e.g. the job is still
   * queued when the next turn starts) belongs to a run that no longer owns
   * the status line, so starting fresh here is what stops it from later being
   * mistaken for this run's own pre-memory status text.
   *
   * It also owns the diagnostic `execution_id` binding, because it is the single
   * funnel every run shape goes through. Every `code` record written while a run
   * is live therefore carries the same id the kernel's own records do, which is
   * the only thing that lets the two halves of one failure be read together.
   */
  async function runManaged(opts: {
    sess: Session;
    executionId: string;
    initialStatus: StatusLine;
    disconnectPolicy?: HostedRunRef["disconnect_policy"];
    run: (setHandle: (h: RunHandle) => void) => Promise<RunEnvelope>;
    afterRun?: (envelope: RunEnvelope) => void;
    onStored: (envelope: RunEnvelope, stored: StoredRun, sink: RunSink) => void;
    onError: (e: unknown) => void;
  }): Promise<void> {
    const { sess, executionId } = opts;
    const ownershipEpoch = runOwnershipEpoch;
    const hosted = client.hosting !== undefined;
    const attention = deps.attention;
    const transcript = store.openRun(executionId);
    const sink = teeSink(transcript, activity.openRun({ current: true }));
    currentSink = { executionId, sink, transcript };
    cancelRequested = false;
    currentStatusExecId = executionId;
    memoryStatusBase = null;
    diagnosticBind({ execution_id: executionId });
    const baseline = sess.meta()?.totals;
    setSessionUsageBaseline(baseline === undefined ? null : { ...baseline });
    setDisconnectPolicy(hosted ? (opts.disconnectPolicy ?? "cancel") : "cancel");
    setRunActive(true);
    setCompactionActive(false);
    setRunStartedAt(Date.now());
    setStatus(opts.initialStatus);
    attention?.setTitle("running");
    let publicationCompleted = false;
    let releaseSettlement!: () => void;
    const settlement = {
      promise: new Promise<void>((resolve) => {
        releaseSettlement = resolve;
      }),
      release: () => releaseSettlement(),
    };
    currentSettlement = settlement;
    setSettlementActive(true);
    let interactiveReleased = false;
    const releaseInteractiveOwnership = (): void => {
      if (interactiveReleased || ownershipEpoch !== runOwnershipEpoch || currentSink?.sink !== sink)
        return;
      interactiveReleased = true;
      currentHandle = undefined;
      workflowRunId = null;
      setRunActive(false);
      setCompactionActive(false);
      attention?.setTitle(null);
      if (heldIngest?.execution_id === executionId) {
        const notice = heldIngest;
        heldIngest = null;
        onMemoryIngest(notice);
      }
    };
    try {
      const envelope = await opts.run((h) => {
        currentHandle = h;
        physicalHandles.add(h);
        setPhysicalRunCount((count) => count + 1);
        void h.closed.then(
          () => {
            if (physicalHandles.delete(h)) setPhysicalRunCount((count) => Math.max(0, count - 1));
          },
          () => {
            if (physicalHandles.delete(h)) setPhysicalRunCount((count) => Math.max(0, count - 1));
          },
        );
      });
      if (session !== sess || ownershipEpoch !== runOwnershipEpoch) return;
      if (hosted) {
        const id = sess.meta()?.id;
        const canonical = id === undefined ? null : await sessionStore.load(id, { refresh: true });
        if (session !== sess || ownershipEpoch !== runOwnershipEpoch) return;
        if (canonical === null) throw new Error("hosted conversation could not be reconciled");
        sess.acceptHosted(canonical);
      }
      opts.afterRun?.(envelope);
      setStatus(runOutcomeStatus(envelope));
      releaseInteractiveOwnership();
      let stored: StoredRun = null;
      let storedReadDegraded = false;
      try {
        stored = await client.getRun(executionId);
      } catch {
        storedReadDegraded = true;
        store.settleRun(executionId, envelope?.status === "completed");
      }
      if (session !== sess || ownershipEpoch !== runOwnershipEpoch) return;
      opts.onStored(envelope, stored, sink);
      if (envelope?.status === "failed" && envelope.error)
        store.appendRunFailure(executionId, envelope.error);
      transcript.complete(
        storedReadDegraded
          ? {
              degraded:
                "Stored run reconciliation was unavailable; committed history uses the terminal live events that reached this client.",
            }
          : undefined,
      );
      publicationCompleted = true;
      if (!cancelRequested && attention?.away())
        attention.notify(`run ${presentStatus(runOutcomeStatus(envelope))}`);
    } catch (e) {
      if (session === sess && ownershipEpoch === runOwnershipEpoch) {
        opts.onError(e);
        store.settleRun(executionId);
        if (!publicationCompleted) {
          transcript.complete({
            degraded:
              "Run settlement ended before authoritative stored reconciliation; committed history uses the available terminal events.",
          });
        }
        if (!cancelRequested && attention?.away()) attention.notify("run failed");
      }
    } finally {
      if (ownershipEpoch === runOwnershipEpoch && currentSink?.sink === sink) {
        releaseInteractiveOwnership();
        diagnosticBind({ execution_id: undefined });
        currentSink = undefined;
      }
      if (currentSettlement === settlement) {
        currentSettlement = undefined;
        setSettlementActive(false);
      }
      settlement.release();
      if (session === sess && ownershipEpoch === runOwnershipEpoch) elicit.cancelPending();
    }
  }

  async function submitTurn(
    content: MessageContent,
    display?: string,
    skill?: { name: string; task?: string; plansMode?: PlansMode },
  ): Promise<void> {
    const epoch = runOwnershipEpoch;
    setHumanSubmissions((count) => count + 1);
    try {
      if (scheduledReservation && !currentHandle) await scheduledReservation.ready;
      if (epoch !== runOwnershipEpoch) return;
      await submitPreparedTurn(content, display, skill);
    } finally {
      setHumanSubmissions((count) => count - 1);
    }
  }

  async function submitPreparedTurn(
    content: MessageContent,
    display?: string,
    skill?: { name: string; task?: string; plansMode?: PlansMode },
    automatic?: ScheduledReservation,
  ): Promise<LoopTurnCompletion | void> {
    const preparationEpoch = runOwnershipEpoch;
    const profile = deps.activeProfile();
    if (!profile) {
      setStatus(["no backend yet"]);
      return;
    }
    const draftText = display ?? composerText(content);
    let msg: MessageContent;
    try {
      msg =
        typeof content === "string"
          ? await buildContent(content, loadImage)
          : await appendMentionImages(content, loadImage);
    } catch (error) {
      if (automatic) throw error;
      if (!(error instanceof MentionImageError)) throw error;
      if (preparationEpoch !== runOwnershipEpoch) return;
      setStatus([error.message]);
      draftRestore?.(draftText, typeof content === "string" ? undefined : content);
      return;
    }
    if (automatic) assertAutomatic(automatic);
    if (preparationEpoch !== runOwnershipEpoch) return;
    const settlement = currentSettlement;
    if (!runActive() && settlement !== undefined) await settlement.promise;
    if (preparationEpoch !== runOwnershipEpoch) return;
    if (automatic) assertAutomatic(automatic);
    if (automatic === undefined && runActive() && currentHandle) {
      const execId = currentHandle.executionId;
      const queuedReceipt =
        currentSink?.executionId === execId
          ? currentSink.transcript.queueSteer?.(draftText)
          : undefined;
      try {
        const res = await client.steer({ executionId: execId, message: msg, profile });
        if (preparationEpoch !== runOwnershipEpoch) return;
        if (res.status !== "steered") queuedReceipt?.discard();
        setStatus(
          res.status === "steered"
            ? ["steering queued ", { mark: "arrowRight" }]
            : [`steer: ${res.status}`],
        );
      } catch {
        if (preparationEpoch !== runOwnershipEpoch) return;
        queuedReceipt?.fail();
        setStatus(["steer failed ", { mark: "emDash" }, " message restored to the input"]);
        draftRestore?.(draftText, typeof content === "string" ? undefined : content);
      }
      return;
    }
    if (!session) {
      loadEpoch += 1;
      session = createSession(boundSessionDeps, { agentProfile: profile });
    }
    const sess = session;
    const executionId = automatic?.executionId ?? "exec_" + crypto.randomUUID();
    let hostedSession: Awaited<ReturnType<typeof prepareHostedSession>>;
    try {
      hostedSession = await prepareHostedSession(sess, draftText);
    } catch (error) {
      if (automatic) throw error;
      if (preparationEpoch === runOwnershipEpoch) {
        setStatus([`turn was not admitted: ${errorText(error)}`]);
        draftRestore?.(draftText, typeof content === "string" ? undefined : content);
      }
      return;
    }
    if (preparationEpoch !== runOwnershipEpoch || session !== sess) return;
    if (automatic) assertAutomatic(automatic);
    const assertPreparation = (): void => {
      if (session !== sess || preparationEpoch !== runOwnershipEpoch)
        throw new Error("Conversation changed during turn preparation.");
      if (automatic) assertAutomatic(automatic);
    };
    let completion = turnCompletion(undefined);
    const messagesBeforeTurn = [...sess.messages()];
    const hostedPending = hostedSession === undefined ? 0 : (sess.meta()?.pending?.length ?? 0);
    if (hostedPending > 0) messagesBeforeTurn.splice(-hostedPending);
    const userKey = store.appendUserMessage(msg, display, executionId);
    if ((skill?.plansMode ?? deps.plansMode?.()) === "review")
      store.appendNotice(
        presentStatus([
          "this run requires plan approval ",
          { mark: "emDash" },
          " the lead may explore first, but cannot execute an authored plan until you approve it",
        ]),
      );
    const continueFrom = sess.beginTurn(msg, executionId);
    rememberResidentTurn({ userKey });
    const promptCacheKey = sess.meta()?.id;
    const guardMode = deps.guardMode();
    const memoryMode = deps.memoryMode();
    const guardArgs = {
      guardMode,
      ...deps.judgePayload(guardMode),
      ...(memoryMode === "off" ? { memory: memoryMode } : {}),
    };
    const pending = sess.takePending();
    const requestPending = hostedSession === undefined ? pending : [];
    const isManager = deps.isManagerProfile?.() === true;
    workflowRunId = executionId;
    setWorkflowActivity(null);
    const fullRequestMessages = async (): Promise<Message[]> => {
      if (sess.hasCompleteHistory())
        return hostedSession === undefined
          ? [...(skill === undefined ? sess.messages() : messagesBeforeTurn)]
          : [
              ...messagesBeforeTurn,
              ...(skill === undefined ? [{ role: "user" as const, content: msg }] : []),
            ];
      const currentMeta = sess.meta();
      if (currentMeta === null) throw new Error("cannot rebuild a detached session's full history");
      const historical = await resumeSession(
        { ...currentMeta, turns: currentMeta.turns.slice(0, -1) },
        {
          getRun: (id) => client.getRun(id),
          currentPlanProviderKey: deps.planProviderKey,
          renderTurn: () => {},
        },
        { renderWindow: 0 },
      );
      assertPreparation();
      if (historical.degraded.length > 0)
        throw new Error(
          `cannot rebuild full history: ${historical.degraded.length} persisted run trace${historical.degraded.length === 1 ? " is" : "s are"} unavailable`,
        );
      const beforeCurrent = [...historical.messages, ...pending];
      const semanticHistory = [...beforeCurrent, { role: "user" as const, content: msg }];
      sess.restoreHistory(semanticHistory);
      return hostedSession === undefined
        ? skill === undefined
          ? semanticHistory
          : beforeCurrent
        : [
            ...historical.messages,
            ...(skill === undefined ? [{ role: "user" as const, content: msg }] : []),
          ];
    };
    const startFull = (messages?: readonly Message[]): RunHandle => {
      assertPreparation();
      return client.startRun({
        ...(hostedSession === undefined
          ? {}
          : { session: { ...hostedSession, kind: "conversation", user_preview: draftText } }),
        messages: [
          ...(messages ??
            (hostedSession === undefined
              ? skill === undefined
                ? sess.messages()
                : messagesBeforeTurn
              : [
                  ...messagesBeforeTurn,
                  ...(skill === undefined ? [{ role: "user" as const, content: msg }] : []),
                ])),
        ],
        profile,
        executionId,
        ...(skill !== undefined
          ? {
              skill: {
                name: skill.name,
                ...(skill.task !== undefined ? { task: skill.task } : {}),
              },
            }
          : {}),
        ...(promptCacheKey ? { promptCacheKey } : {}),
        configurationSessionId: configurationSessionId(sess),
        ...(sessionTask === undefined ? {} : { task: sessionTask }),
        ...guardArgs,
      });
    };
    await runManaged({
      sess,
      executionId,
      initialStatus: ["running", { mark: "ellipsis" }],
      run: async (setHandle) => {
        assertPreparation();
        const attach = (handle: RunHandle): void => {
          setHandle(handle);
          if (automatic) {
            automatic.handles.push(handle);
            automatic.releaseReady();
          }
        };
        const handle =
          continueFrom && !isManager
            ? client.startRun({
                ...(hostedSession === undefined
                  ? {}
                  : {
                      session: { ...hostedSession, kind: "conversation", user_preview: draftText },
                    }),
                messages:
                  skill === undefined
                    ? [...requestPending, { role: "user", content: msg }]
                    : requestPending,
                profile,
                executionId,
                continueFrom,
                ...(skill !== undefined
                  ? {
                      skill: {
                        name: skill.name,
                        ...(skill.task !== undefined ? { task: skill.task } : {}),
                      },
                    }
                  : {}),
                ...(promptCacheKey ? { promptCacheKey } : {}),
                configurationSessionId: configurationSessionId(sess),
                ...(sessionTask === undefined ? {} : { task: sessionTask }),
                ...guardArgs,
              })
            : startFull(isManager ? await fullRequestMessages() : undefined);
        attach(handle);
        let envelope = await handle.done;
        if (
          hostedSession === undefined &&
          continueFrom &&
          !isManager &&
          isContinuationUnavailable(envelope) &&
          !cancelRequested
        ) {
          await handle.closed;
          assertPreparation();
          setStatus([
            "context expired ",
            { mark: "emDash" },
            " rebuilding from history",
            { mark: "ellipsis" },
          ]);
          const retry = startFull(await fullRequestMessages());
          attach(retry);
          envelope = await retry.done;
        }
        return envelope;
      },
      afterRun: (envelope) => {
        sess.endTurn(envelope);
        completion = turnCompletion(envelope);
        if (cancelRequested || automatic?.cancelled)
          completion = { ...completion, status: "cancelled" };
      },
      onStored: (_envelope, stored, sink) => {
        sess.reconcile(stored);
        replayRunEvents(sink, stored);
        if (stored !== null) sess.releaseHistory();
        else if (automatic)
          completion = {
            ...completion,
            status: "unknown",
            reason: "Persisted reconciliation is unavailable; inspect the run before resuming.",
          };
      },
      onError: (e) => {
        sess.endTurn(undefined);
        setStatus([cancelRequested ? "cancelled" : `run error: ${errorText(e)}`]);
        completion = {
          status: cancelRequested || automatic?.cancelled ? "cancelled" : "unknown",
          reason: errorText(e),
          usage: {},
        };
      },
    });
    return completion;
  }

  function submitPromptTurn(
    messages: PromptMessage[],
    display?: string,
    skill?: { name: string; task?: string; plansMode?: PlansMode },
  ): void {
    const content = promptMessagesToContent(messages);
    const empty =
      (typeof content === "string" && content.length === 0) ||
      (Array.isArray(content) && content.length === 0);
    if (empty) return;
    detachObserved(
      "submit_prompt_turn",
      () => submitTurn(content, display, skill),
      (e) => setStatus([`run failed: ${errorText(e)}`]),
    );
  }

  async function submitSkillRun(name: string, task: string, agent: string): Promise<void> {
    if (scheduledReserved()) {
      setStatus(["busy ", { mark: "emDash" }, " finish the scheduled turn first"]);
      return;
    }
    const settlement = currentSettlement;
    if (!runActive() && settlement !== undefined) await settlement.promise;
    if (runActive()) {
      setStatus(["busy ", { mark: "emDash" }, " finish the current run first"]);
      return;
    }
    const profile = deps.activeProfile();
    if (!session) {
      loadEpoch += 1;
      session = createSession(boundSessionDeps, { agentProfile: profile || undefined });
    }
    const sess = session;
    const executionId = "exec_" + crypto.randomUUID();
    const label = task.trim().length > 0 ? `/${name} ${task.trim()}` : `/${name}`;
    const hostedSession = await prepareHostedSession(sess, label);
    if (session !== sess) return;
    const userKey = store.appendUserMessage(label, label, executionId);
    const promptCacheKey = sess.meta()?.id;
    sess.beginTranscriptTurn(label, executionId);
    rememberResidentTurn({ userKey });
    const skillGuardMode = deps.guardMode();
    const skillMemoryMode = deps.memoryMode();
    await runManaged({
      sess,
      executionId,
      initialStatus: [`running /${name} on ${agent}`, { mark: "ellipsis" }],
      run: (setHandle) => {
        const handle = client.startRun({
          ...(hostedSession === undefined
            ? {}
            : { session: { ...hostedSession, kind: "transcript", user_preview: label } }),
          skill: { name, task },
          executionId,
          profile,
          ...(promptCacheKey ? { promptCacheKey } : {}),
          configurationSessionId: configurationSessionId(sess),
          guardMode: skillGuardMode,
          ...deps.judgePayload(skillGuardMode),
          ...(skillMemoryMode === "off" ? { memory: skillMemoryMode } : {}),
        });
        setHandle(handle);
        return handle.done;
      },
      afterRun: (envelope) => sess.endTranscriptTurn(envelope),
      onStored: (envelope, stored, sink) => {
        replayRunEvents(sink, stored);
        if (hostedSession === undefined)
          sess.appendObservation(
            buildSkillRunDigest(name, agent, envelope, stored, deps.planProviderKey?.()),
          );
        else sess.releaseHistory();
      },
      onError: (e) => {
        sess.endTranscriptTurn(undefined);
        setStatus([`/${name} failed: ${errorText(e)}`]);
      },
    });
  }

  async function workOnTask(ref: TaskRefDto, profile: string): Promise<void> {
    if (scheduledReserved()) {
      setStatus(["busy ", { mark: "emDash" }, " finish the scheduled turn first"]);
      return;
    }
    const settlement = currentSettlement;
    if (!runActive() && settlement !== undefined) await settlement.promise;
    if (runActive() || bashActive()) {
      setStatus(["busy ", { mark: "emDash" }, " finish the current run or command first"]);
      return;
    }
    if (profile.trim().length === 0) {
      setStatus(["choose an agent before working on a task"]);
      return;
    }
    clearSession();
    deps.setActiveProfile(profile);
    loadEpoch += 1;
    sessionTask = { id: ref.id, provider_key: ref.provider_key, mode: "work" };
    session = createSession(boundSessionDeps, { agentProfile: profile });
    const sess = session;
    const executionId = "exec_" + crypto.randomUUID();
    const message =
      `Work on task ${ref.id} in the current workspace. Read the active task context, ` +
      "call start_task explicitly when that tool is available and you are ready to begin, and keep every review or completion transition explicit.";
    const display = `Work on task ${ref.id}`;
    const hostedSession = await prepareHostedSession(sess, display);
    if (session !== sess) return;
    const userKey = store.appendUserMessage(message, display, executionId);
    sess.beginTurn(message, executionId);
    rememberResidentTurn({ userKey });
    const promptCacheKey = sess.meta()?.id;
    const guardMode = deps.guardMode();
    const memoryMode = deps.memoryMode();
    workflowRunId = executionId;
    setWorkflowActivity(null);
    await runManaged({
      sess,
      executionId,
      initialStatus: [`working on ${ref.id}`, { mark: "ellipsis" }],
      run: (setHandle) => {
        const handle = client.startRun({
          ...(hostedSession === undefined
            ? {}
            : { session: { ...hostedSession, kind: "conversation", user_preview: display } }),
          messages: [...sess.messages()],
          profile,
          executionId,
          task: sessionTask,
          ...(promptCacheKey ? { promptCacheKey } : {}),
          configurationSessionId: configurationSessionId(sess),
          guardMode,
          ...deps.judgePayload(guardMode),
          ...(memoryMode === "off" ? { memory: memoryMode } : {}),
        });
        setHandle(handle);
        return handle.done;
      },
      afterRun: (envelope) => sess.endTurn(envelope),
      onStored: (_envelope, stored, sink) => {
        sess.reconcile(stored);
        replayRunEvents(sink, stored);
        if (stored !== null) sess.releaseHistory();
      },
      onError: (error) => {
        sess.endTurn(undefined);
        setStatus([`task run failed: ${errorText(error)}`]);
      },
    });
  }

  function runBangCommand(cmd: string): boolean {
    if (scheduledReserved() || humanSubmissions() > 0 || sessionLoading()) return false;
    if (currentSettlement !== undefined || compactionCalls() > 0 || physicalRunCount() > 0)
      return false;
    if (bashActive()) {
      setStatus(["a ! command is already running ", { mark: "emDash" }, " draft kept"]);
      return false;
    }
    if (!session) {
      loadEpoch += 1;
      session = createSession(boundSessionDeps, {
        agentProfile: deps.activeProfile() || undefined,
      });
    }
    const sess = session;
    const hosting = client.hosting;
    const finish = store.beginLocalBash(cmd);
    let finished = false;
    const abort = new AbortController();
    bashAbort = abort;
    setBashActive(true);
    setLocalCommandCount((count) => count + 1);
    setStatus(["! running", { mark: "ellipsis" }]);
    localWork = (async () => {
      let lease: HostedActivityLease | undefined;
      try {
        if (hosting !== undefined) {
          const binding = await prepareHostedSession(sess, cmd);
          abort.signal.throwIfAborted();
          lease = await hosting.reserveActivity(binding!.session_id, "shell");
          if (session !== sess)
            throw new Error("conversation changed before local shell admission");
        }
        abort.signal.throwIfAborted();
        const result = await runBash(cmd, { cwd: workspace, signal: abort.signal });
        finish(result);
        finished = true;
        if (session === sess) {
          sess.appendObservation(formatBashObservation(cmd, result), "user");
          if (hosting !== undefined) {
            await sessionStore.flushPending?.();
            const canonical = await sessionStore.load(lease!.session_id, { refresh: true });
            if (session === sess && canonical !== null) sess.acceptHosted(canonical);
          }
        }
        if (bashAbort === abort && session === sess)
          setStatus([
            result.cancelled
              ? "! cancelled"
              : result.timedOut
                ? "! timed out"
                : `! exit ${result.exitCode ?? "?"}`,
          ]);
      } catch (error) {
        if (!finished)
          finish({
            exitCode: null,
            stdout: "",
            stderr: errorText(error),
            signal: null,
            timedOut: false,
            cancelled: abort.signal.aborted,
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        throw error;
      } finally {
        try {
          if (lease !== undefined) await hosting!.releaseActivity(lease.lease_id);
        } finally {
          if (bashAbort === abort) {
            bashAbort = undefined;
            setBashActive(false);
          }
          setLocalCommandCount((count) => count - 1);
        }
      }
    })();
    detachObserved(
      "local_bash",
      () => localWork,
      (e) => {
        if (session === sess) setStatus([`shell failed: ${errorText(e)}`]);
      },
    );
    return true;
  }

  async function stopLocalWork(): Promise<void> {
    bashAbort?.abort();
    await Promise.allSettled(localWork === undefined ? [] : [localWork]);
  }

  /** Number of canonical session turns represented by the transcript's single prefix notice. */
  let foldedTurnCount = 0;

  /** Complete turns still represented by semantic nodes in the live store. */
  let residentTurns: ResidentTurnRef[] = [];

  /**
   * How many nodes at the head of the transcript form the folded-prefix notice,
   * which {@link exportNodeBatches} replaces with the real turns.
   *
   * @remarks Structural folding always emits exactly one leading annotation;
   *   the count makes the export independent of the store's internal key.
   */
  let foldedPrefix = 0;

  /**
   * Add one resident turn and structurally fold the oldest one when needed.
   *
   * @remarks `TranscriptStore.foldPrefixBefore` replaces the whole prefix in a
   * single write/reindex. The live host retains only a scalar count; the
   * canonical persisted session turn index supplies `/export` metadata lazily.
   */
  function rememberResidentTurn(turn: ResidentTurnRef): void {
    residentTurns.push(turn);
    if (residentTurns.length <= RESIDENT_TRANSCRIPT_TURN_LIMIT) return;

    const nextOldest = residentTurns[1];
    if (nextOldest === undefined) return;
    const nextFoldedCount = foldedTurnCount + 1;
    if (!store.foldPrefixBefore(nextOldest.userKey, foldedPrefixNotice(nextFoldedCount))) {
      const fallbackFoldedCount = foldedTurnCount + residentTurns.length - 1;
      if (store.foldPrefixBefore(turn.userKey, foldedPrefixNotice(fallbackFoldedCount))) {
        residentTurns.splice(0, residentTurns.length - 1);
        foldedTurnCount = fallbackFoldedCount;
        foldedPrefix = 1;
        return;
      }
      residentTurns.pop();
      return;
    }

    residentTurns.shift();
    foldedTurnCount = nextFoldedCount;
    foldedPrefix = 1;
  }

  function clearSession(opts?: { flush?: boolean }): void {
    loadEpoch += 1;
    teardownRuns("clear");
    setSessionLoading(false);
    if (opts?.flush !== false) session?.flush();
    session = undefined;
    sessionTask = undefined;
    store.clear();
    activity.clear();
    foldedTurnCount = 0;
    residentTurns = [];
    foldedPrefix = 0;
    setStatus(["idle"]);
  }

  async function* exportNodeBatches(): AsyncGenerator<readonly TranscriptNode[]> {
    let scratch!: TranscriptStore;
    const dispose = createRoot((d) => {
      scratch = createTranscriptStore({
        ...(deps.describeToolCall ? { describeToolCall: deps.describeToolCall } : {}),
        // This store exists for one persisted run at a time. Applying the live
        // aggregate caps here would replace export content with the very
        // memory notices the lazy reload exists to repair. The trace store's
        // per-record ceiling bounds this one-run scratch lifetime instead.
        proseTotalLimitBytes: Number.MAX_SAFE_INTEGER,
        hydratedToolLimit: Number.MAX_SAFE_INTEGER,
        hydratedToolBytesLimit: Number.MAX_SAFE_INTEGER,
        hydratedToolSingleBytesLimit: Number.MAX_SAFE_INTEGER,
      });
      return d;
    });

    async function* exportResidentNodes(
      nodes: readonly TranscriptNode[],
    ): AsyncGenerator<readonly TranscriptNode[]> {
      let outputBatch: TranscriptNode[] = [];
      let cachedExecutionId: string | undefined;
      let cachedDetail: RunDetail | null = null;
      let restored = new Map<string, TranscriptNode>();
      let fetchFailed = false;

      const loadPersisted = async (executionId: string): Promise<void> => {
        if (executionId === cachedExecutionId) return;
        cachedExecutionId = executionId;
        cachedDetail = null;
        restored = new Map();
        fetchFailed = false;
        try {
          cachedDetail = await client.getRun(executionId);
        } catch {
          fetchFailed = true;
          return;
        }
        if (cachedDetail === null) return;
        scratch.clear();
        const sink = scratch.openRun(executionId);
        batch(() => {
          sink.beginReconcile();
          for (const event of cachedDetail!.events) applyEvent(sink, event, "replay");
          sink.endReconcile();
          sink.complete();
        });
        restored = new Map(scratch.nodes.map((candidate) => [candidate.key, candidate]));
      };

      for (const node of nodes) {
        let exported = node;
        if (isReleasedProse(node)) {
          const executionId = sourceExecutionId(node);
          if (executionId === undefined) {
            exported = incompleteExportNode(node, "no persisted run identifies this block");
          } else {
            await loadPersisted(executionId);
            // `loadPersisted` mutates this cache across an async closure; retain
            // its runtime state explicitly instead of relying on CFA across the call.
            const persisted = cachedDetail as RunDetail | null;
            if (fetchFailed) {
              exported = incompleteExportNode(node, `run ${executionId} could not be fetched`);
            } else if (persisted === null) {
              exported = incompleteExportNode(node, `run ${executionId} is no longer retained`);
            } else if (node.kind === "user") {
              const content = persisted.messages.at(-1)?.content;
              if (content === undefined) {
                exported = incompleteExportNode(
                  node,
                  `run ${executionId} has no recoverable prompt`,
                );
              } else {
                const text = contentToText(content);
                if (
                  node.sourceTextFingerprint !== undefined &&
                  node.sourceTextFingerprint !== transcriptTextFingerprint(text)
                ) {
                  exported = incompleteExportNode(
                    node,
                    `run ${executionId}'s persisted prompt does not match this displayed block`,
                  );
                } else {
                  const bounded = boundTranscriptText(text);
                  exported = {
                    ...node,
                    text: bounded.text,
                    textTruncated: bounded.truncated ? true : undefined,
                    proseReleased: undefined,
                  };
                }
              }
            } else {
              const candidate = restored.get(node.key);
              if (
                candidate === undefined ||
                (candidate.kind !== "assistant" && candidate.kind !== "reasoning") ||
                candidate.proseReleased === true
              ) {
                exported = incompleteExportNode(
                  node,
                  `run ${executionId} has no recoverable ${node.kind} block`,
                );
              } else {
                exported = { ...candidate };
              }
            }
          }
        }
        outputBatch.push(exported);
        if (outputBatch.length >= EXPORT_BATCH_NODE_LIMIT) {
          yield outputBatch;
          outputBatch = [];
        }
      }
      if (outputBatch.length > 0) yield outputBatch;
    }

    try {
      if (foldedTurnCount === 0) {
        if (!store.nodes.some(isReleasedProse)) {
          yield store.nodes;
          return;
        }
        yield* exportResidentNodes(store.nodes);
        return;
      }

      const canonicalTurns = session?.meta()?.turns;
      for (let index = 0; index < foldedTurnCount; index += 1) {
        scratch.clear();
        const turn = canonicalTurns?.[index];
        if (turn === undefined) {
          scratch.appendUserMessage(`Earlier turn ${index + 1}`);
          scratch.appendNotice(
            "folded — this turn's session metadata could not be reloaded",
            "info",
          );
          yield [...scratch.nodes];
          continue;
        }
        const executionId = turn.executionId;
        if (executionId === undefined) {
          scratch.appendUserMessage(turn.userPreview);
          scratch.appendNotice("folded — this turn has no persisted run to reload", "info");
          yield [...scratch.nodes];
          continue;
        }
        let detail: RunDetail | null = null;
        try {
          detail = await client.getRun(executionId);
        } catch {
          detail = null;
        }
        if (!detail) {
          scratch.appendUserMessage(turn.userPreview, undefined, executionId);
          scratch.appendNotice("folded — this turn's reply could not be reloaded", "info");
        } else {
          const persistedUserContent =
            turn.kind === "conversation" ? detail.messages.at(-1)?.content : undefined;
          scratch.appendUserMessage(
            persistedUserContent ?? turn.userPreview,
            undefined,
            executionId,
          );
          if (turn.kind === "conversation" && persistedUserContent === undefined)
            scratch.appendNotice(
              "folded — this turn's complete prompt could not be reloaded",
              "info",
            );
          const sink = scratch.openRun(executionId);
          batch(() => {
            sink.beginReconcile();
            for (const event of detail.events) applyEvent(sink, event, "replay");
            sink.endReconcile();
            sink.complete();
          });
        }
        yield [...scratch.nodes];
      }
      yield* exportResidentNodes(store.nodes.slice(foldedPrefix));
    } finally {
      dispose();
    }
  }

  async function loadSessionMeta(meta: SessionMeta): Promise<void> {
    const epoch = ++loadEpoch;
    teardownRuns("switch");
    setSessionLoading(true);
    session?.flush();
    session = undefined;
    sessionTask = undefined;
    store.clear();
    activity.clear();
    foldedTurnCount = 0;
    residentTurns = [];
    foldedPrefix = 0;
    const windowStart = Math.max(0, meta.turns.length - RESIDENT_TRANSCRIPT_TURN_LIMIT);
    if (windowStart > 0) {
      foldedTurnCount = windowStart;
      store.appendNotice(foldedPrefixNotice(foldedTurnCount));
      foldedPrefix = 1;
    }
    const seeds: string[] = [];
    for (let index = 0; index < foldedTurnCount; index += 1) {
      const turn = meta.turns[index];
      if (turn?.kind === "conversation") seeds.push(turn.userPreview);
    }
    let renderedTurnIndex = 0;
    let resumed: Awaited<ReturnType<typeof resumeSession>>;
    try {
      resumed = await resumeSession(
        meta,
        {
          getRun: (id) => client.getRun(id),
          currentPlanProviderKey: deps.planProviderKey,
          renderTurn: ({ executionId, userContent, events, recovery }) => {
            const index = renderedTurnIndex++;
            if (epoch !== loadEpoch || index < windowStart) return;
            const persistedTurn = meta.turns[index];
            const preview =
              persistedTurn?.userPreview ??
              redactPreview(
                typeof userContent === "string" ? userContent : contentToText(userContent),
              );
            const renderedContent = persistedTurn?.kind === "transcript" ? preview : userContent;
            if (persistedTurn?.kind === "conversation") {
              seeds.push(
                typeof userContent === "string" ? userContent : contentToText(userContent),
              );
            }
            batch(() => {
              const userKey = store.appendUserMessage(renderedContent, undefined, executionId);
              residentTurns.push({ userKey });
              if (events && executionId) {
                const transcript = store.openRun(executionId);
                const sink = teeSink(transcript, activity.openRun());
                sink.beginReconcile();
                for (const event of events) applyEvent(sink, event, "replay");
                sink.endReconcile();
                transcript.complete();
              }
              if (recovery) store.appendNotice(recoveryNotice(recovery), "warn");
            });
          },
        },
        { renderWindow: RESIDENT_TRANSCRIPT_TURN_LIMIT },
      );
    } catch (error) {
      if (epoch !== loadEpoch) return;
      setSessionLoading(false);
      throw error;
    }
    if (epoch !== loadEpoch) return;
    sessionTask = resumed.activeTask;
    session = createSession(boundSessionDeps, {
      meta,
      messages: resumed.messages,
      agentProfile: meta.agentProfile,
      historyComplete: resumed.degraded.length === 0,
    });
    setSessionLoading(false);
    history.seed(seeds);
    if (meta.agentProfile) deps.setActiveProfile(meta.agentProfile);
    const previousExtensionProfile =
      meta.lastExtensionProfile ?? meta.turns.at(-1)?.extensionProfile;
    const currentExtensionProfile = client.currentExtensionProfile?.();
    const extensionProfileChanged =
      previousExtensionProfile !== undefined &&
      currentExtensionProfile !== undefined &&
      (previousExtensionProfile.id !== currentExtensionProfile.id ||
        previousExtensionProfile.fingerprint !== currentExtensionProfile.fingerprint);
    if (extensionProfileChanged) {
      store.appendNotice(
        `Extension Profile changed since the newest persisted turn: ${previousExtensionProfile.id} (${fingerprintPrefix(previousExtensionProfile.fingerprint)}) -> ${currentExtensionProfile.id} (${fingerprintPrefix(currentExtensionProfile.fingerprint)}).`,
        "warn",
      );
    }
    setStatus([
      `resumed ${meta.turns.length} turns`,
      ...(foldedTurnCount
        ? ([" ", { mark: "separator" }, ` ${foldedTurnCount} folded`] satisfies StatusLine)
        : []),
      ...(extensionProfileChanged
        ? ([" ", { mark: "separator" }, " Extension Profile changed"] satisfies StatusLine)
        : []),
      ...(resumed.degraded.length
        ? ([
            " ",
            { mark: "separator" },
            ` ${resumed.degraded.length} degraded`,
          ] satisfies StatusLine)
        : []),
    ]);
  }

  async function resumeSessionById(id: SessionId): Promise<void> {
    const requestEpoch = ++loadEpoch;
    setSessionLoading(true);
    const previous = session?.meta()?.id;
    if (previous) deps.onSessionInvalidated?.(previous, "switch");
    let meta: SessionMeta | null;
    try {
      if (client.hosting !== undefined) {
        const ref = (await client.hosting.list())
          .filter((entry) => entry.session_id === id)
          .sort(
            (a, b) =>
              Number(a.execution_state === "closed") - Number(b.execution_state === "closed") ||
              b.created_at - a.created_at,
          )[0];
        if (requestEpoch !== loadEpoch) return;
        if (ref?.execution_state === "unknown")
          throw new Error(
            "this conversation has a run with an unknown outcome; inspect it in /background list or start another conversation",
          );
        if (ref !== undefined) {
          setSessionLoading(false);
          await attachHostedRun(ref, ref.control === "other" ? "observe" : "acquire");
          return;
        }
      }
      meta = await sessionStore.load(id, { refresh: client.hosting !== undefined });
    } catch (error) {
      if (requestEpoch === loadEpoch) {
        setSessionLoading(false);
        setStatus([`resume failed: ${errorText(error)}`]);
      }
      return;
    }
    if (requestEpoch !== loadEpoch) return;
    if (!meta) {
      setSessionLoading(false);
      setStatus(["session not found"]);
      return;
    }
    await loadSessionMeta(meta).catch((e) => setStatus([`resume failed: ${errorText(e)}`]));
  }

  async function attachHostedRun(
    ref: HostedRunRef,
    control: "observe" | "acquire" | "takeover" = "acquire",
  ): Promise<void> {
    if (client.hosting === undefined || client.attachRun === undefined)
      throw new Error("backend does not support hosted observation");
    if (currentHandle?.executionId === ref.execution_id) {
      setStatus(["already attached to this execution"]);
      return;
    }
    if (ref.workspace_id !== workspaceId)
      throw new Error("hosted run belongs to another workspace");
    if (ref.execution_state === "unknown")
      throw new Error(
        "this execution has an unknown outcome; inspect its history before starting another conversation",
      );
    const requestEpoch = ++loadEpoch;
    const previousHandle = currentHandle;
    const meta = await sessionStore.load(ref.session_id, { refresh: true });
    if (requestEpoch !== loadEpoch || currentHandle !== previousHandle || humanSubmissions() > 0)
      return;
    if (meta === null) throw new Error("hosted conversation is unavailable");
    if (ref.execution_state === "closed") {
      await loadSessionMeta(meta);
      if (loadEpoch === requestEpoch + 1) await client.hosting.acknowledge(ref.execution_id);
      return;
    }
    const turn = meta.turns.find((entry) => entry.executionId === ref.execution_id);
    if (turn === undefined) throw new Error("hosted execution has no matching conversation turn");
    const resumeEpoch = loadEpoch + 1;
    await loadSessionMeta({ ...meta, turns: meta.turns.filter((entry) => entry !== turn) });
    await sessionRetirement;
    if (resumeEpoch !== loadEpoch) return;
    const sess = session;
    if (sess === undefined || sess.meta()?.id !== ref.session_id)
      throw new Error("conversation changed during hosted attach");
    sess.acceptHosted(meta);
    const userKey = store.appendUserMessage(turn.userPreview, undefined, ref.execution_id);
    rememberResidentTurn({ userKey });
    workflowRunId = ref.execution_id;
    await runManaged({
      sess,
      executionId: ref.execution_id,
      initialStatus: [control === "observe" ? "observing hosted run" : "reattached to hosted run"],
      disconnectPolicy: ref.disconnect_policy,
      run: (setHandle) => {
        const handle = client.attachRun!({
          execution_id: ref.execution_id,
          host_generation: ref.host_generation,
          control,
        });
        setHandle(handle);
        return handle.done;
      },
      onStored: (_result, stored, sink) => {
        replayRunEvents(sink, stored);
        sess.releaseHistory();
      },
      onError: (error) => setStatus([`hosted observation interrupted: ${errorText(error)}`]),
    });
  }

  return {
    runActive,
    continuesOnExit: () => runActive() && disconnectPolicy() === "continue",
    bashActive,
    compactionActive,
    physicalWorkActive: () =>
      physicalRunCount() > 0 || localCommandCount() > 0 || compactionCalls() > 0,
    memory: () => {
      const sessionMemory = session?.memory();
      let eventQueueItems = 0;
      let eventQueueBytes = 0;
      let eventQueueDropped = 0;
      for (const handle of physicalHandles) {
        const buffered = handle.buffered?.();
        eventQueueItems += buffered?.buffered_items ?? 0;
        eventQueueBytes += buffered?.buffered_bytes ?? 0;
        eventQueueDropped += buffered?.dropped ?? 0;
      }
      return {
        ...(store.memory?.() ?? {}),
        ...(sessionStore.memory?.() ?? {}),
        ...(sessionMemory ?? {}),
        transcript_resident_turns: residentTurns.length,
        transcript_folded_turns: foldedTurnCount,
        session_turn_refs: session?.meta()?.turns.length ?? 0,
        manager_history_bytes:
          deps.isManagerProfile?.() === true && sessionMemory?.session_history_complete === true
            ? sessionMemory.session_payload_bytes
            : 0,
        physical_run_handles: physicalHandles.size,
        local_process_active: bashActive(),
        event_queue_items: eventQueueItems,
        event_queue_bytes: eventQueueBytes,
        event_queue_dropped: eventQueueDropped,
      };
    },
    runStatus,
    setRunStatus,
    runStartedAt,
    sessionUsageBaseline,
    workflowActivity,
    mcpStartupNotice,
    ownsExecution: (executionId) => currentSink?.executionId === executionId,
    onEvent,
    onMemoryIngest,
    cancelCurrentRun,
    compactCurrentRun,
    inspectCurrentContext,
    fitCurrentContext,
    teardownRuns,
    stopLocalWork,
    backgroundCurrentRun,
    attachHostedRun,
    submitTurn,
    scheduledBinding,
    submitScheduledTurn,
    scheduledBusy,
    submitPromptTurn,
    submitSkillRun,
    workOnTask,
    runBangCommand,
    clearSession,
    loadSessionMeta,
    resumeSessionById,
    exportNodeBatches,
    sessionMeta: () => session?.meta() ?? null,
    setSessionProfile: (name) => session?.setAgentProfile(name),
    flushSession: () => session?.flush(),
    registerDraftRestore: (fn) => {
      draftRestore = fn;
    },
  };
}
