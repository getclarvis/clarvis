import type {
  ActiveTaskBindingDto,
  ExtensionProfileRunRef,
  Message,
  MessageContent,
  PlanRef,
  RunDetail,
  RunEvent,
  RunRecovery,
  RunResult,
} from "@clarvis/protocol";
import {
  addUsageToTotals,
  redactPreview,
  redactTurnError,
  runStatusToNode,
  uuidv7,
  type NodeStatus,
  type SessionMeta,
  type SessionStore,
  type TurnRef,
} from "./session-store.ts";
import { contentToText } from "./message-content.ts";
import type { CatalogCost } from "./models-catalog.ts";

function now(): number {
  return Date.now();
}

function resultToContent(result: RunResult | undefined): MessageContent | null {
  if (!result || !("result" in result)) return null;
  const value = result.result;
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** A live session's turn-tracking, message history, and persistence. */
export interface Session {
  meta(): SessionMeta | null;
  messages(): Message[];
  /** Current semantic history and pending payload counters for diagnostics. */
  memory(): {
    session_messages: number;
    session_payload_bytes: number;
    session_pending_messages: number;
    session_pending_payload_bytes: number;
    session_history_complete: boolean;
  };
  /** Whether {@link messages} still contains the complete full-wire history. */
  hasCompleteHistory(): boolean;
  /** Drop the reconstructible message chain after its run trace is durably readable. */
  releaseHistory(): void;
  /** Restore a full-wire chain reconstructed from persisted run traces. */
  restoreHistory(messages: readonly Message[]): void;
  beginTurn(content: MessageContent, executionId: string): string | undefined;
  endTurn(envelope: RunResult | undefined): void;
  /** Record a separately-invoked run without adding its prompt or result to continuation history. */
  beginTranscriptTurn(display: string, executionId: string): void;
  /** Settle the newest matching transcript-only turn without appending an assistant message. */
  endTranscriptTurn(envelope: RunResult | undefined): void;
  reconcile(stored: RunDetail | null): void;
  setAgentProfile(name: string): void;
  appendObservation(content: MessageContent, role?: "user" | "assistant"): void;
  takePending(): Message[];
  flush(): void;
}

/** Dependencies for {@link createSession}. */
export interface SessionDeps {
  store: SessionStore;
  owner: string;
  project: string;
  workspace: string;
  priceFor?: (model: string) => CatalogCost | undefined;
  /** Process-pinned Extension Profile identity for each newly started turn. */
  extensionProfile?: () => ExtensionProfileRunRef | undefined;
}

/** Initial state to seed a {@link Session} from — an existing session's metadata and history. */
export interface SessionInit {
  meta?: SessionMeta;
  messages?: Message[];
  agentProfile?: string;
  redactPreviews?: boolean;
  /** Whether `messages` is a complete full-wire chain. A degraded resume may
   * still display and continue from its newest trace, but must not use that
   * partial chain as the fallback when provider continuation is unavailable. */
  historyComplete?: boolean;
}

/** Whether a run's result is a failure specifically because its continuation was unavailable. */
export function isContinuationUnavailable(envelope: RunResult | undefined): boolean {
  return envelope?.status === "failed" && envelope.error?.code === "continuation_unavailable";
}

/**
 * Build a {@link Session}: tracks turns and message history in memory, saving
 * the session's metadata to `deps.store` after every mutation.
 *
 * @param deps - the backing store, owner, workspace, and optional pricing lookup.
 * @param init - existing metadata/history/Agent Profile to resume from, if any.
 */
export function createSession(deps: SessionDeps, init: SessionInit = {}): Session {
  let meta: SessionMeta | null = init.meta ?? null;
  const persistedPending = init.meta?.pending ?? [];
  const history: Message[] = [...(init.messages ?? []), ...persistedPending];
  const pending: Message[] = [...persistedPending];
  let historyComplete = init.historyComplete !== false;
  const counted = new Set<string>();
  const redact = init.redactPreviews !== false;
  let continuationBase: string | undefined;
  if (meta) {
    for (let index = meta.turns.length - 1; index >= 0; index -= 1) {
      const turn = meta.turns[index];
      if (turn?.kind !== "conversation" || turn.executionId === undefined) continue;
      continuationBase = turn.executionId;
      break;
    }
  }

  function lastTurnFor(
    executionId: string | undefined,
    kind: TurnRef["kind"],
  ): TurnRef | undefined {
    if (!meta) return undefined;
    for (let i = meta.turns.length - 1; i >= 0; i--) {
      const t = meta.turns[i];
      if (t?.kind === kind && (executionId === undefined || t.executionId === executionId))
        return t;
    }
    return undefined;
  }

  function ensureMeta(title: string, ts: number): SessionMeta {
    if (meta) return meta;
    meta = {
      id: uuidv7(),
      title: redactPreview(title, { redact, max: 80 }),
      projectId: deps.project,
      workspace: deps.workspace,
      owner: deps.owner,
      createdAt: ts,
      updatedAt: ts,
      agentProfile: init.agentProfile,
      turns: [],
      totals: { input: 0, output: 0, cached: 0 },
    };
    return meta;
  }

  function beginTurn(content: MessageContent, executionId: string): string | undefined {
    const ts = now();
    const base = continuationBase;
    const current = ensureMeta(contentToText(content), ts);
    history.push({ role: "user", content });
    const extensionProfile = deps.extensionProfile?.();
    current.turns.push({
      kind: "conversation",
      userPreview: redactPreview(contentToText(content), { redact }),
      executionId,
      ...(extensionProfile !== undefined ? { extensionProfile } : {}),
      status: "running",
      startedAt: ts,
    });
    continuationBase = executionId;
    if (extensionProfile !== undefined) current.lastExtensionProfile = extensionProfile;
    current.updatedAt = ts;
    deps.store.save(current);
    return base;
  }

  function beginTranscriptTurn(display: string, executionId: string): void {
    const ts = now();
    const current = ensureMeta(display, ts);
    const extensionProfile = deps.extensionProfile?.();
    current.turns.push({
      kind: "transcript",
      userPreview: redactPreview(display, { redact }),
      executionId,
      ...(extensionProfile !== undefined ? { extensionProfile } : {}),
      status: "running",
      startedAt: ts,
    });
    if (extensionProfile !== undefined) current.lastExtensionProfile = extensionProfile;
    current.updatedAt = ts;
    deps.store.save(current);
  }

  function finishTurn(
    kind: TurnRef["kind"],
    envelope: RunResult | undefined,
    appendAssistant: boolean,
  ): void {
    if (!meta) return;
    const turn = lastTurnFor(envelope?.execution_id, kind);
    const ts = now();
    if (turn) turn.endedAt = ts;
    if (envelope) {
      const status: NodeStatus = runStatusToNode(envelope.status, envelope.ended_reason);
      if (turn) {
        turn.status = status;
        if (envelope.error) turn.error = redactTurnError(envelope.error, { redact });
        else delete turn.error;
      }
      const assistant = resultToContent(envelope);
      if (appendAssistant && assistant != null)
        history.push({ role: "assistant", content: assistant });
      if (envelope.usage && turn?.executionId && !counted.has(turn.executionId)) {
        addUsageToTotals(meta.totals, envelope.usage, deps.priceFor);
        counted.add(turn.executionId);
      }
    } else if (turn) {
      turn.status = "error";
    }
    meta.updatedAt = ts;
    deps.store.save(meta);
  }

  function endTurn(envelope: RunResult | undefined): void {
    finishTurn("conversation", envelope, true);
  }

  function endTranscriptTurn(envelope: RunResult | undefined): void {
    finishTurn("transcript", envelope, false);
  }

  function reconcile(stored: RunDetail | null): void {
    if (!meta || !stored) return;
    const turn = lastTurnFor(stored.execution_id, "conversation");
    if (turn) {
      turn.status = runStatusToNode(stored.status, stored.result?.ended_reason);
      if (stored.ended_at !== undefined) turn.endedAt = stored.ended_at;
      if (stored.extension_profile !== undefined) {
        turn.extensionProfile = stored.extension_profile;
        meta.lastExtensionProfile = stored.extension_profile;
      }
    }
    if (!counted.has(stored.execution_id)) {
      addUsageToTotals(meta.totals, stored.result?.usage, deps.priceFor);
      counted.add(stored.execution_id);
    }
    meta.updatedAt = now();
    deps.store.save(meta);
  }

  function setAgentProfile(name: string): void {
    if (!meta || meta.agentProfile === name) return;
    meta.agentProfile = name;
    meta.updatedAt = now();
    deps.store.save(meta);
  }

  function appendObservation(
    content: MessageContent,
    role: "user" | "assistant" = "assistant",
  ): void {
    const msg: Message = { role, content };
    history.push(msg);
    pending.push(msg);
    if (meta) {
      meta.pending = [...pending];
      meta.updatedAt = now();
      deps.store.save(meta);
    }
  }

  function takePending(): Message[] {
    const out = [...pending];
    pending.length = 0;
    if (meta && meta.pending !== undefined) {
      delete meta.pending;
      deps.store.save(meta);
    }
    return out;
  }

  function flush(): void {
    if (meta) deps.store.save(meta);
  }

  function releaseHistory(): void {
    history.length = 0;
    historyComplete = false;
  }

  function restoreHistory(messages: readonly Message[]): void {
    history.splice(0, history.length, ...messages);
    historyComplete = true;
  }

  return {
    meta: () => meta,
    messages: () => history,
    memory: () => ({
      session_messages: history.length,
      session_payload_bytes: history.reduce(
        (total, message) => total + messageContentPayloadChars(message.content) * 2,
        0,
      ),
      session_pending_messages: pending.length,
      session_pending_payload_bytes: pending.reduce(
        (total, message) => total + messageContentPayloadChars(message.content) * 2,
        0,
      ),
      session_history_complete: historyComplete,
    }),
    hasCompleteHistory: () => historyComplete,
    releaseHistory,
    restoreHistory,
    beginTurn,
    endTurn,
    beginTranscriptTurn,
    endTranscriptTurn,
    reconcile,
    setAgentProfile,
    appendObservation,
    takePending,
    flush,
  };
}

/**
 * Build the text a lead agent sees for a `/skill` run it dispatched: the skill
 * run's textual result, or — if the run was interrupted before producing one — a
 * {@link buildRecoveredContext} salvage, or else a bare status line.
 *
 * @param name - the skill's name, for the digest's tag line.
 * @param agent - the agent the skill declared and therefore ran on; naming it is
 *   the only way the reader can tell whose profile produced the result.
 * @param envelope - the live run's result, if the run just finished.
 * @param stored - the persisted run detail, as a fallback source for `envelope`/salvage.
 */
export function buildSkillRunDigest(
  name: string,
  agent: string,
  envelope: RunResult | undefined,
  stored: RunDetail | null,
  selectedPlanProviderKey?: string,
): string {
  const execId = envelope?.execution_id ?? stored?.execution_id;
  const tag = `[/${name} → ${agent}${execId ? `, exec ${execId}` : ""}]`;
  const source: RunResult | undefined = envelope ?? stored?.result;
  const raw = resultToContent(source);
  const salvaged =
    raw ??
    (stored
      ? buildRecoveredContext(stored.events, stored.plan_ref, selectedPlanProviderKey)
      : null);
  const body =
    salvaged == null ? null : typeof salvaged === "string" ? salvaged : contentToText(salvaged);
  if (body == null || body.trim().length === 0) {
    const status = envelope?.status ?? stored?.status ?? "completed";
    return `${tag} ${status} with no textual result.`;
  }
  return `${tag}\n${body}`;
}

/**
 * Salvage from an interrupted run: what the next turn must not re-ask or redo.
 *
 * The plan is NOT reconstructed from events — plan documents never enter the
 * trace. The persisted `plan_ref` names its provider and stable id, so the
 * salvage points at the provider's authoritative current state instead of
 * trusting a stale snapshot.
 */
export function buildRecoveredContext(
  events: RunEvent[],
  planRef?: PlanRef,
  selectedPlanProviderKey?: string,
): string | null {
  const sections: string[] = [];

  const decisions = events.filter(
    (e): e is Extract<RunEvent, { type: "elicitation_resolved" }> =>
      e.type === "elicitation_resolved" &&
      e.outcome === "accept" &&
      typeof e.answer === "string" &&
      e.answer.length > 0,
  );
  if (decisions.length > 0) {
    const lines = decisions.map((d) => `  • ${d.question.trim()} → ${d.answer!.trim()}`);
    sections.push("Decisions already confirmed (do not re-ask):\n" + lines.join("\n"));
  }

  if (planRef !== undefined && planRef.status !== "completed") {
    const locator = planRef.path ? `\n  Locator: ${planRef.path}` : "";
    const providerMismatch =
      selectedPlanProviderKey !== undefined && selectedPlanProviderKey !== planRef.provider_key;
    sections.push(
      `Plan left ${planRef.status} at revision ${planRef.final_revision}.\n` +
        `  Provider: ${planRef.provider_key}\n` +
        `  ID: ${planRef.id}` +
        locator +
        "\n  " +
        (providerMismatch
          ? `The currently selected provider is ${selectedPlanProviderKey}. Select ${planRef.provider_key} again before read_plan can return this document to the selected provider's history scope; do not open another document as if it were the active plan.`
          : `Read id ${planRef.id} with read_plan before acting — the provider's document is authoritative and may have changed.`),
    );
  }

  if (sections.length === 0) return null;
  return (
    "[Recovered context — the previous run was interrupted before finishing. Reconstructed from its " +
    "trace so you can continue rather than restart.]\n\n" +
    sections.join("\n\n") +
    "\n\nResume from here: keep these decisions, honor the plan and each task's status, and do not " +
    "repeat questions that are already answered above."
  );
}

interface DegradedTurn {
  executionId?: string;
  reason: "interrupted" | "trace_pruned" | "trace_unavailable";
}

/** The result of {@link resumeSession}: rehydrated messages plus any turns that came back degraded. */
export interface ResumedSession {
  messages: Message[];
  degraded: DegradedTurn[];
  /** Most recent persisted task binding, used if continuation falls back to full history. */
  activeTask?: ActiveTaskBindingDto;
  /**
   * How many turns rendered as collapsed placeholders because they fell outside
   * the render window.
   *
   * @remarks Reported so the UI can say the history was folded. Silently showing
   *   a bare user message for an old turn is indistinguishable from showing a
   *   turn whose answer was lost. Counts only turns that actually rendered
   *   `collapsed` — a turn outside the window whose trace was pruned renders as
   *   degraded and is counted there instead, so the two totals never overlap.
   */
  collapsed: number;
}

/** Dependencies for {@link resumeSession}. */
export interface ResumeDeps {
  getRun(executionId: string): Promise<RunDetail | null>;
  /** Static identity of the currently selected plan provider, when the host can know it. */
  currentPlanProviderKey?: () => string | undefined;
  renderTurn(input: {
    executionId?: string;
    userContent: MessageContent;
    events?: RunEvent[];
    degraded?: DegradedTurn["reason"];
    /**
     * Render this turn as a collapsed placeholder, without its event stream.
     *
     * @remarks Distinct from `degraded` on purpose. A collapsed turn is intact
     *   and simply outside the render window; reusing `degraded` for it would
     *   tell the user their history was damaged when it was not.
     */
    collapsed?: true;
    /**
     * The turn's run was rebuilt from a damaged crash journal, and this is how
     * much of it was lost or synthesized.
     *
     * @remarks Distinct from `degraded`, which says the turn could not be
     *   reloaded at all. A recovered turn reloads and replays; it is its
     *   *record* that is incomplete, so the host marks it beside the events it
     *   does have rather than instead of them.
     */
    recovery?: RunRecovery;
  }): void;
}

/** Options for {@link resumeSession}. */
export interface ResumeOptions {
  /** How many of the most recent turns replay with their events; the rest collapse. */
  renderWindow?: number;
}

/** Mirrors the engine request schema's aggregate history limits. Keeping the
 * resume path at or below them prevents reconstructing a payload that the next
 * run would reject after the allocation had already happened. */
export const SESSION_RESUME_MAX_PAYLOAD_CHARS = 16_000_000;
const SESSION_RESUME_MAX_MESSAGES = 10_000;

/** Explicit resource exhaustion raised instead of returning a silently
 * truncated model context. */
class SessionResumeLimitError extends Error {
  readonly code = "resource_exhausted" as const;
  readonly reason = "session_resume_history_limit" as const;

  constructor(
    readonly dimension: "payload_chars" | "messages",
    readonly limit: number,
  ) {
    const unit = dimension === "payload_chars" ? "payload characters" : "messages";
    super(
      `Cannot resume session safely: persisted history exceeds the limit of ${String(limit)} ${unit}. Start a new session instead of loading a partial model context.`,
    );
    this.name = "SessionResumeLimitError";
  }
}

/** Count the protocol payload that becomes engine message content without
 * serializing or copying strings/base64 data. */
function messageContentPayloadChars(content: MessageContent): number {
  if (typeof content === "string") return content.length;
  let total = 0;
  for (const part of content) {
    total += part.type === "text" ? part.text.length : (part.data ?? part.ref ?? "").length;
  }
  return total;
}

interface ResumedRunProjection {
  continueFrom?: string;
  userContent?: MessageContent;
  /** Retained only for the continuation chain at or after the newest full-wire reset. */
  history?: { messages: Message[]; assistant: MessageContent | null };
  /** Retained only for turns inside the bounded visual render window. */
  events?: RunEvent[];
  /** Retained, like `events`, only for turns inside the visual render window. */
  recovery?: RunRecovery;
}

/**
 * How many of a session's most recent turns are replayed with their full event
 * stream, the rest rendering as collapsed placeholders.
 */
const DEFAULT_RENDER_WINDOW = 20;

/**
 * How many run details are fetched concurrently while walking a session's turns.
 *
 * @remarks Bounded because rehydration is a burst: a window of turns all become
 * fetchable at once, and issuing them unbounded would put the whole window in
 * flight against a kernel that may be remote. The work is I/O-bound rather than
 * CPU-bound, so the useful range is wide and the figure is not tuned to a core
 * count — it is small enough that a slow transport is not flooded, and large
 * enough that {@link DEFAULT_RENDER_WINDOW} turns arrive in a few round-trips
 * rather than twenty.
 */
const FETCH_CONCURRENCY = 6;

/**
 * Rehydrate a session's transcript by re-fetching each turn's persisted run
 * detail and rendering each via `deps.renderTurn`.
 *
 * @param meta - the persisted session, whose `turns` are walked in order.
 * @param deps - the run fetcher and the per-turn render sink.
 * @param opts - see {@link ResumeOptions}.
 * @returns the rehydrated message chain and any turns that came back degraded.
 * @remarks A turn whose run can no longer be fetched is reported as
 *   `"interrupted"` (it was still running), `"trace_pruned"` (it had an
 *   execution id but the trace is gone), or `"trace_unavailable"` (no
 *   execution id was ever recorded). A turn that *does* come back but whose
 *   record was rebuilt from a damaged crash journal is not degraded — it replays
 *   normally and additionally carries its `recovery` counts to `renderTurn`, so
 *   the host can say the record is incomplete without withholding it.
 *
 *   **The message chain is never windowed or silently truncated.** A continued run's `messages` are
 *   only the delta since its parent (see `RunDetail.continue_from`), so the
 *   chain the model eventually sees on a full send is the accumulation of every
 *   turn from the last non-continued one onward. Dropping any of it would
 *   silently change the model's context. The chain is therefore charged
 *   incrementally against the engine's request limits, before any concatenation;
 *   an oversized chain fails with {@link SessionResumeLimitError} instead of
 *   allocating a payload the engine would reject. Turns are fetched backwards from the newest in
 *   bounded-concurrency batches and the walk stops at the first turn that
 *   carries no `continue_from`, because that turn replaces the accumulated
 *   history outright and everything before it is provably superfluous. In a
 *   session whose first turn is the only full-wire one that saves nothing — but
 *   it is a contract, not a heuristic, so it never costs anything either. The
 *   stop is checked per batch rather than per turn, so up to
 *   {@link FETCH_CONCURRENCY} - 1 turns beyond the reset point are fetched
 *   needlessly; that is the price of issuing the fetches concurrently instead of
 *   one at a time, and it is bounded by a constant rather than by session length.
 *   Each batch is immediately projected to the message fields the continuation
 *   chain needs and, for the visual window only, its events. The `RunDetail`
 *   objects and every older event trace are released before the next batch, so
 *   bounded concurrency is also a bounded trace-retention contract.
 *
 *   The render window is separate and purely visual: only the last
 *   {@link ResumeOptions.renderWindow} turns replay their events into the
 *   transcript, which is what keeps reopening a long session from rebuilding
 *   every node of it.
 */
export async function resumeSession(
  meta: SessionMeta,
  deps: ResumeDeps,
  opts: ResumeOptions = {},
): Promise<ResumedSession> {
  const turns = meta.turns;
  const renderWindow = opts.renderWindow ?? DEFAULT_RENDER_WINDOW;
  const windowStart = Math.max(0, turns.length - renderWindow);

  const projected = new Map<number, ResumedRunProjection | null>();
  const visited = new Set<number>();
  let newestActiveTask: { index: number; binding: ActiveTaskBindingDto } | undefined;
  let historyPayloadChars = 0;
  let historyMessages = 0;
  let resetIdx = 0;
  let foundReset = false;

  const reserveHistory = (messages: readonly Message[], assistant: MessageContent | null): void => {
    const addedMessages = messages.length + (assistant === null ? 0 : 1);
    if (addedMessages > SESSION_RESUME_MAX_MESSAGES - historyMessages) {
      throw new SessionResumeLimitError("messages", SESSION_RESUME_MAX_MESSAGES);
    }

    let addedChars = 0;
    const reserveContent = (content: MessageContent): void => {
      const chars = messageContentPayloadChars(content);
      if (chars > SESSION_RESUME_MAX_PAYLOAD_CHARS - historyPayloadChars - addedChars) {
        throw new SessionResumeLimitError("payload_chars", SESSION_RESUME_MAX_PAYLOAD_CHARS);
      }
      addedChars += chars;
    };
    for (const message of messages) reserveContent(message.content);
    if (assistant !== null) reserveContent(assistant);

    historyMessages += addedMessages;
    historyPayloadChars += addedChars;
  };

  // `createSession` appends these persisted observations to the reconstructed
  // chain, so they belong to the same eventual request budget even though this
  // function intentionally returns them separately.
  reserveHistory(meta.pending ?? [], null);

  const fetchBatch = async (batch: number[], retainHistory: boolean): Promise<void> => {
    const fetched = await Promise.all(
      batch.map(async (index) => {
        const executionId = turns[index]?.executionId;
        return { index, detail: executionId ? await deps.getRun(executionId) : null };
      }),
    );
    for (const { index, detail } of fetched) {
      const turn = turns[index];
      visited.add(index);
      if (detail === null) {
        projected.set(index, null);
        continue;
      }
      if (
        turn?.kind === "conversation" &&
        detail.active_task !== undefined &&
        (newestActiveTask === undefined || index > newestActiveTask.index)
      )
        newestActiveTask = { index, binding: detail.active_task };
      const messages = detail.messages;
      const keepHistory = turn?.kind === "conversation" && retainHistory && !foundReset;
      const assistant = keepHistory
        ? (resultToContent(detail.result) ??
          buildRecoveredContext(detail.events, detail.plan_ref, deps.currentPlanProviderKey?.()))
        : null;
      if (keepHistory) reserveHistory(messages, assistant);
      const userContent = messages.at(-1)?.content;
      projected.set(index, {
        ...(detail.continue_from ? { continueFrom: detail.continue_from } : {}),
        ...(userContent !== undefined && (keepHistory || index >= windowStart)
          ? { userContent }
          : {}),
        ...(keepHistory ? { history: { messages, assistant } } : {}),
        ...(index >= windowStart ? { events: detail.events } : {}),
        ...(index >= windowStart && detail.recovery !== undefined
          ? { recovery: detail.recovery }
          : {}),
      });
      if (keepHistory && !detail.continue_from) {
        foundReset = true;
        resetIdx = index;
      }
    }
    fetched.length = 0;
  };

  let cursor = turns.length - 1;
  while (cursor >= 0 && !foundReset) {
    const batch: number[] = [];
    while (batch.length < FETCH_CONCURRENCY && cursor >= 0) {
      const index = cursor--;
      if (turns[index]?.kind === "conversation") batch.push(index);
    }
    if (batch.length === 0) continue;
    await fetchBatch(batch, true);
  }

  const pendingRender: number[] = [];
  for (let idx = windowStart; idx < turns.length; idx++)
    if (!visited.has(idx)) pendingRender.push(idx);
  for (let i = 0; i < pendingRender.length; i += FETCH_CONCURRENCY) {
    await fetchBatch(pendingRender.slice(i, i + FETCH_CONCURRENCY), false);
  }

  const degraded: DegradedTurn[] = [];
  let rehydrated: Message[] = [];
  let collapsedCount = 0;

  for (const [idx, turn] of turns.entries()) {
    const stored = projected.get(idx);
    const collapsed = idx < windowStart;
    if (stored !== undefined && stored !== null) {
      if (collapsed) collapsedCount++;
      const history = stored.history;
      if (turn.kind === "conversation" && idx >= resetIdx) {
        if (history === undefined)
          throw new Error(`resume projection missing history for turn ${idx}`);
        if (stored.continueFrom) rehydrated.push(...history.messages);
        else rehydrated = [...history.messages];
        if (history.assistant != null)
          rehydrated.push({ role: "assistant", content: history.assistant });
      }
      deps.renderTurn({
        executionId: turn.executionId,
        userContent:
          turn.kind === "transcript" ? turn.userPreview : (stored.userContent ?? turn.userPreview),
        ...(collapsed
          ? { collapsed: true }
          : {
              events: stored.events,
              ...(stored.recovery !== undefined ? { recovery: stored.recovery } : {}),
            }),
      });
    } else if (visited.has(idx)) {
      const reason: DegradedTurn["reason"] =
        turn.status === "running"
          ? "interrupted"
          : turn.executionId
            ? "trace_pruned"
            : "trace_unavailable";
      degraded.push({ executionId: turn.executionId, reason });
      deps.renderTurn({
        executionId: turn.executionId,
        userContent: turn.userPreview,
        degraded: reason,
      });
    } else {
      collapsedCount++;
      deps.renderTurn({
        executionId: turn.executionId,
        userContent: turn.userPreview,
        collapsed: true,
      });
    }
  }

  const activeTask = newestActiveTask?.binding;
  return {
    messages: rehydrated,
    degraded,
    collapsed: collapsedCount,
    ...(activeTask === undefined ? {} : { activeTask }),
  };
}

/**
 * Delete a session and every run trace its turns reference.
 *
 * @returns whether the session record itself was deleted, plus each turn's
 *   execution id and whether its trace was deleted.
 */
export async function deleteSession(
  meta: SessionMeta,
  store: SessionStore,
  deleteRun: (executionId: string) => Promise<boolean>,
): Promise<{ session: boolean; traces: { executionId: string; deleted: boolean }[] }> {
  const traces: { executionId: string; deleted: boolean }[] = [];
  for (const turn of meta.turns) {
    if (turn.executionId)
      traces.push({ executionId: turn.executionId, deleted: await deleteRun(turn.executionId) });
  }
  const session = store.delete(meta.id);
  return { session, traces };
}
