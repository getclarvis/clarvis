import type { RunEvent } from "@clarvis/protocol";
import type { EventSource, EventSpan } from "./event-span.ts";
import { isMutationTool, isTranscriptExternalOrchestrationTool } from "./tool-identity.ts";
import {
  projectTranscriptToolDisplay,
  transcriptDisplayText,
  type TranscriptNode,
} from "../core/transcript/index.ts";
import type { TranscriptToolNode } from "../core/transcript/types.ts";

/** Where one protocol event is allowed to appear before publication. */
export type TranscriptEventSurface = "frontier" | "status";

/** The authority that can close a publication candidate. */
export type TranscriptEventAuthority = "incremental" | "terminal" | "none";

/** The boundary at which an event may append immutable history. */
export type TranscriptCommitTrigger =
  | "delegation_terminal"
  | "iteration_terminal"
  | "never"
  | "point"
  | "run_terminal"
  | "tool_terminal";

/** Exhaustive transcript disposition for one protocol event variant. */
export interface TranscriptEventPolicy {
  readonly surface: TranscriptEventSurface;
  readonly authority: TranscriptEventAuthority;
  readonly commit: TranscriptCommitTrigger;
}

/**
 * Exhaustive mutable-frontier and immutable-history policy.
 *
 * @remarks The `satisfies` constraint deliberately makes a protocol event addition fail typecheck
 * until its visual ownership and publication boundary are decided.
 */
const TRANSCRIPT_EVENT_POLICY = {
  run_started: { surface: "frontier", authority: "none", commit: "never" },
  run_ended: { surface: "frontier", authority: "terminal", commit: "run_terminal" },
  iteration_started: { surface: "frontier", authority: "none", commit: "never" },
  iteration_completed: {
    surface: "frontier",
    authority: "terminal",
    commit: "iteration_terminal",
  },
  tool_call_started: { surface: "frontier", authority: "incremental", commit: "never" },
  tool_call: { surface: "frontier", authority: "terminal", commit: "tool_terminal" },
  tool_output_delta: { surface: "frontier", authority: "incremental", commit: "never" },
  tool_input_delta: { surface: "frontier", authority: "incremental", commit: "never" },
  reasoning: { surface: "frontier", authority: "terminal", commit: "iteration_terminal" },
  text_delta: { surface: "frontier", authority: "incremental", commit: "never" },
  model_error: { surface: "frontier", authority: "terminal", commit: "iteration_terminal" },
  model_retry: { surface: "frontier", authority: "none", commit: "never" },
  delegation_created: { surface: "frontier", authority: "incremental", commit: "point" },
  delegation_started: { surface: "frontier", authority: "incremental", commit: "never" },
  delegation_completed: {
    surface: "frontier",
    authority: "terminal",
    commit: "delegation_terminal",
  },
  delegation_failed: {
    surface: "frontier",
    authority: "terminal",
    commit: "delegation_terminal",
  },
  workflow_run_started: { surface: "frontier", authority: "incremental", commit: "never" },
  workflow_title_updated: { surface: "frontier", authority: "incremental", commit: "never" },
  workflow_run_progress: { surface: "frontier", authority: "incremental", commit: "never" },
  workflow_run_completed: { surface: "frontier", authority: "terminal", commit: "never" },
  workflow_run_failed: { surface: "frontier", authority: "terminal", commit: "never" },
  plan_created: { surface: "frontier", authority: "incremental", commit: "never" },
  plan_updated: { surface: "frontier", authority: "incremental", commit: "never" },
  plan_removed: { surface: "frontier", authority: "terminal", commit: "never" },
  plan_review_requested: { surface: "frontier", authority: "incremental", commit: "never" },
  plan_review_resolved: { surface: "frontier", authority: "terminal", commit: "never" },
  soft_limit_check: { surface: "frontier", authority: "terminal", commit: "point" },
  compaction_started: { surface: "status", authority: "incremental", commit: "never" },
  compaction: { surface: "frontier", authority: "terminal", commit: "point" },
  compaction_skipped: { surface: "frontier", authority: "terminal", commit: "point" },
  vision_analysis: { surface: "frontier", authority: "terminal", commit: "point" },
  elicitation_requested: { surface: "frontier", authority: "incremental", commit: "never" },
  elicitation_resolved: { surface: "frontier", authority: "terminal", commit: "point" },
  steering_applied: { surface: "frontier", authority: "terminal", commit: "point" },
  memory_ingest: { surface: "status", authority: "none", commit: "never" },
  capability_event: { surface: "frontier", authority: "terminal", commit: "point" },
  events_dropped: { surface: "frontier", authority: "terminal", commit: "point" },
  mcp_degraded: { surface: "frontier", authority: "terminal", commit: "point" },
} as const satisfies Record<RunEvent["type"], TranscriptEventPolicy>;

/** Compatibility phase carried by every semantically committed batch. */
export type TranscriptPublicationPhase = "committed";

/** Semantic reason a set of transcript nodes shares one atomic publication boundary. */
export type TranscriptPublicationKind =
  | "annotation"
  | "degraded"
  | "iteration"
  | "local"
  | "run_terminal"
  | "subagent"
  | "tool_group"
  | "user";

/** Frozen grouping role consumed by a committed tool block. */
export interface TranscriptPublicationToolGroup {
  readonly role: "head" | "member" | "solo";
  readonly ordinal: number;
  readonly size: number;
  readonly members?: readonly TranscriptToolNode[];
  readonly headKey?: string;
}

/** Frozen section header consumed by a committed sub-agent block. */
export interface TranscriptPublicationSectionHeader {
  readonly order: number;
  readonly title: string;
  readonly model?: string;
  readonly status: TranscriptNode["status"];
  readonly hiddenEntries?: number;
}

/** An immutable semantic batch whose compatibility readiness fields are already terminal. */
export interface TranscriptPublicationBatch {
  readonly id: string;
  readonly executionId?: string;
  readonly kind: TranscriptPublicationKind;
  readonly nodes: readonly TranscriptNode[];
  readonly defaultFolded: Readonly<Record<string, boolean>>;
  readonly toolGroups: Readonly<Record<string, TranscriptPublicationToolGroup>>;
  readonly sectionHeaders: Readonly<Record<string, TranscriptPublicationSectionHeader>>;
  readonly sectionAnchors: Readonly<Record<string, string>>;
  readonly sectionFoldedKeys: readonly string[];
  readonly phase: TranscriptPublicationPhase;
  readonly ready: boolean;
}

/** Input accepted by the reactive store when the pure publisher seals a batch. */
export type PreparedTranscriptPublicationBatch = Omit<
  TranscriptPublicationBatch,
  "phase" | "ready"
>;

/** Scheduler seam for the bounded same-tool grouping latency. */
export interface TranscriptPublicationScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

/** Store ports consumed by {@link TranscriptPublisher}. */
export interface TranscriptPublisherHost {
  nodes(): readonly TranscriptNode[];
  defaultFolded(key: string): boolean;
  toolArguments(node: TranscriptToolNode): Record<string, unknown> | undefined;
  append(batch: PreparedTranscriptPublicationBatch): void;
}

/** Completion detail supplied after stored reconciliation has finished or definitively degraded. */
export interface TranscriptRunPublicationCompletion {
  degraded?: string;
}

interface RunPublicationState {
  pendingToolIdentity?: PublicationToolIdentity;
  pendingTools: ReservedPublicationNode[];
  groupFlushHandle?: unknown;
  heldUnknownAnswer?: string;
  heldFinalAnswer?: string;
  completedSubagents: string[];
  reservedSubagents: Map<string, Map<string, ReservedPublicationNode>>;
}

interface PublicationToolIdentity {
  readonly mcpName: string | undefined;
  readonly toolName: string | undefined;
}

interface ReservedPublicationNode {
  readonly node: TranscriptNode;
  readonly defaultFolded: boolean;
}

/** Longest a terminal tool may wait for another grouping-eligible sibling. */
export const TRANSCRIPT_TOOL_GROUP_LATENCY_MS = 80;

/** Pressure ceiling that seals a same-tool group even while terminal calls keep arriving. */
export const TRANSCRIPT_TOOL_GROUP_MAX_ENTRIES = 8;

/** Stable semantic identity for one immutable Lead-side delegation lifecycle marker. */
export function delegationLeadMarkerKey(
  delegationId: string,
  phase: "spawned" | "settled",
): string {
  return `delegation-marker:${delegationId}:${phase}`;
}

function runIdOf(node: TranscriptNode): string {
  const separator = node.key.indexOf("::");
  return separator < 0 ? "" : node.key.slice(0, separator);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/** Build the bounded, owned node snapshot that committed history is allowed to retain. */
export function snapshotTranscriptNode(
  node: TranscriptNode,
  toolArguments: Record<string, unknown> | undefined = node.kind === "tool_call"
    ? node.args
    : undefined,
): TranscriptNode {
  if (node.kind === "tool_call") {
    const display = projectTranscriptToolDisplay(node, toolArguments);
    const base = { ...node };
    delete base.args;
    delete base.result;
    delete base.diff;
    delete base.error;
    delete base.liveOutput;
    delete base.inputChars;
    delete base.dehydrated;
    delete base.hydrationNotice;
    return deepFreeze({
      ...base,
      text: transcriptDisplayText(node),
      ...(display.arguments === undefined ? {} : { args: display.arguments }),
      ...(display.result === undefined ? {} : { result: display.result }),
      ...(display.diff === undefined ? {} : { diff: display.diff }),
      ...(display.error === undefined ? {} : { error: display.error }),
      guard: node.guard === undefined ? undefined : { ...node.guard },
      mutation:
        node.mutation === undefined || node.mutation === null
          ? node.mutation
          : { ...node.mutation },
    } satisfies TranscriptToolNode);
  }
  if (node.kind === "plan") {
    return deepFreeze({
      ...node,
      text: transcriptDisplayText(node),
      tasks: node.tasks?.map((task) => ({ ...task })),
    });
  }
  return deepFreeze({ ...node, text: transcriptDisplayText(node) });
}

function defaultScheduler(): TranscriptPublicationScheduler {
  return {
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function publicationToolGroups(
  nodes: readonly TranscriptNode[],
): Readonly<Record<string, TranscriptPublicationToolGroup>> {
  const groups: Record<string, TranscriptPublicationToolGroup> = Object.create(null);
  let index = 0;
  while (index < nodes.length) {
    const head = nodes[index]!;
    if (head.kind !== "tool_call") {
      index += 1;
      continue;
    }
    if (isMutationTool(head.mcpName, head.toolName)) {
      groups[head.key] = Object.freeze({ role: "solo", ordinal: 0, size: 1 });
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < nodes.length) {
      const candidate = nodes[end]!;
      if (
        candidate.kind !== "tool_call" ||
        isMutationTool(candidate.mcpName, candidate.toolName) ||
        candidate.mcpName !== head.mcpName ||
        candidate.toolName !== head.toolName ||
        candidate.subagentId !== head.subagentId
      )
        break;
      end += 1;
    }
    const members = nodes.slice(index, end) as readonly TranscriptToolNode[];
    if (members.length === 1) {
      groups[head.key] = Object.freeze({ role: "solo", ordinal: 0, size: 1 });
    } else {
      const frozenMembers = Object.freeze([...members]);
      for (const [ordinal, member] of frozenMembers.entries()) {
        groups[member.key] = Object.freeze(
          ordinal === 0
            ? {
                role: "head" as const,
                ordinal,
                size: frozenMembers.length,
                members: frozenMembers,
                headKey: head.key,
              }
            : {
                role: "member" as const,
                ordinal,
                size: frozenMembers.length,
                headKey: head.key,
              },
        );
      }
    }
    index = end;
  }
  return Object.freeze(groups);
}

function publicationToolIdentity(node: TranscriptToolNode): PublicationToolIdentity {
  return { mcpName: node.mcpName, toolName: node.toolName };
}

function samePublicationToolIdentity(
  identity: PublicationToolIdentity,
  node: TranscriptToolNode,
): boolean {
  return identity.mcpName === node.mcpName && identity.toolName === node.toolName;
}

function publicationSection(
  kind: TranscriptPublicationKind,
  nodes: readonly TranscriptNode[],
): {
  sectionHeaders: Readonly<Record<string, TranscriptPublicationSectionHeader>>;
  sectionAnchors: Readonly<Record<string, string>>;
  sectionFoldedKeys: readonly string[];
} {
  const headers: Record<string, TranscriptPublicationSectionHeader> = Object.create(null);
  const anchors: Record<string, string> = Object.create(null);
  if (kind !== "subagent") {
    return {
      sectionHeaders: Object.freeze(headers),
      sectionAnchors: Object.freeze(anchors),
      sectionFoldedKeys: Object.freeze([]),
    };
  }
  const card = nodes.find((node) => node.kind === "subagent");
  const body = nodes.filter((node) => node.kind !== "subagent");
  const anchor = card ?? body[0];
  if (anchor === undefined) {
    return {
      sectionHeaders: Object.freeze(headers),
      sectionAnchors: Object.freeze(anchors),
      sectionFoldedKeys: Object.freeze([]),
    };
  }
  const folded = card === undefined ? body.slice(1) : body;
  for (const node of folded) anchors[node.key] = anchor.key;
  headers[anchor.key] = Object.freeze({
    order: anchor.subagentOrder ?? 0,
    title: card?.title ?? body[0]?.agentLabel ?? "subagent",
    model: card?.model ?? body.find((node) => node.model !== undefined)?.model,
    status: card?.status ?? body.at(-1)?.status ?? "ok",
    ...(folded.length === 0 ? {} : { hiddenEntries: folded.length }),
  });
  return {
    sectionHeaders: Object.freeze(headers),
    sectionAnchors: Object.freeze(anchors),
    sectionFoldedKeys: Object.freeze(folded.map((node) => node.key)),
  };
}

/**
 * Converts the mutable semantic candidate ledger into append-only immutable publication batches.
 *
 * @remarks Live and replay reducers remain responsible for semantic convergence. This publisher
 * only snapshots terminal candidates, never patches a key after reserving it, and delays the run
 * terminal batch until the host has completed stored reconciliation.
 */
export class TranscriptPublisher {
  readonly #host: TranscriptPublisherHost;
  readonly #scheduler: TranscriptPublicationScheduler;
  readonly #toolGroupLatencyMs: number;
  readonly #toolGroupMaxEntries: number;
  readonly #knownKeys = new Set<string>();
  readonly #runs = new Map<string, RunPublicationState>();
  #batchSequence = 0;

  constructor(
    host: TranscriptPublisherHost,
    options: {
      scheduler?: TranscriptPublicationScheduler;
      toolGroupLatencyMs?: number;
      toolGroupMaxEntries?: number;
    } = {},
  ) {
    this.#host = host;
    this.#scheduler = options.scheduler ?? defaultScheduler();
    this.#toolGroupLatencyMs = Math.max(
      0,
      Math.floor(options.toolGroupLatencyMs ?? TRANSCRIPT_TOOL_GROUP_LATENCY_MS),
    );
    this.#toolGroupMaxEntries = Math.max(
      1,
      Math.floor(options.toolGroupMaxEntries ?? TRANSCRIPT_TOOL_GROUP_MAX_ENTRIES),
    );
  }

  /** Publish a client-owned terminal node such as a user turn or local command. */
  publishImmediate(key: string, kind: "annotation" | "local" | "user"): void {
    const node = this.#node(key);
    if (node === undefined) return;
    this.#append(kind, [node], runIdOf(node) || undefined);
  }

  /** Enter replay reconciliation without reopening any already-reserved history entry. */
  beginReconcile(executionId: string): void {
    this.#run(executionId);
  }

  /** Leave replay reconciliation; publication remains held until {@link completeRun}. */
  endReconcile(executionId: string): void {
    this.#run(executionId);
  }

  /** Observe one event after the mutable semantic reducer has applied it. */
  observe(executionId: string, span: EventSpan, event: RunEvent, _source: EventSource): void {
    const state = this.#run(executionId);
    if (TRANSCRIPT_EVENT_POLICY[event.type].surface === "status") return;

    switch (event.type) {
      case "iteration_started":
        if (event.agent === "lead") {
          this.#flushLeadTools(executionId, state);
          if (state.heldUnknownAnswer !== undefined) {
            this.#appendKeys("iteration", [state.heldUnknownAnswer], executionId);
            state.heldUnknownAnswer = undefined;
          }
        }
        return;
      case "iteration_completed":
        this.#publishIteration(executionId, state, span, event);
        return;
      case "tool_call":
        this.#publishTool(executionId, state, span, event);
        return;
      case "delegation_completed":
      case "delegation_failed":
        this.#rememberSubagentCompletion(state, event.delegation_id);
        this.#flushLeadTools(executionId, state);
        this.#publishSubagent(executionId, state, event.delegation_id);
        this.#appendKeys(
          "annotation",
          [`${executionId}::${delegationLeadMarkerKey(event.delegation_id, "settled")}`],
          executionId,
        );
        return;
      case "delegation_created":
        this.#flushLeadTools(executionId, state);
        this.#appendKeys(
          "annotation",
          [`${executionId}::${delegationLeadMarkerKey(event.delegation_id, "spawned")}`],
          executionId,
        );
        return;
      case "compaction":
      case "compaction_skipped":
      case "vision_analysis":
      case "soft_limit_check":
      case "elicitation_resolved":
      case "steering_applied":
      case "capability_event":
      case "events_dropped":
      case "mcp_degraded":
        this.#flushLeadTools(executionId, state);
        this.#publishTerminalPoints(executionId);
        return;
      case "run_ended":
        this.#flushLeadTools(executionId, state);
        this.#captureTerminalAnswer(executionId, state);
        return;
      case "run_started":
      case "tool_call_started":
      case "tool_output_delta":
      case "tool_input_delta":
      case "reasoning":
      case "text_delta":
      case "model_error":
      case "model_retry":
      case "delegation_started":
      case "workflow_run_started":
      case "workflow_title_updated":
      case "workflow_run_progress":
      case "workflow_run_completed":
      case "workflow_run_failed":
      case "plan_created":
      case "plan_updated":
      case "plan_removed":
      case "plan_review_requested":
      case "plan_review_resolved":
      case "compaction_started":
      case "elicitation_requested":
      case "memory_ingest":
        return;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  /**
   * Seal every remaining candidate and append the final answer/run outcome atomically.
   *
   * @remarks The host calls this only after stored reconciliation finishes or definitively fails.
   */
  completeRun(executionId: string, completion: TranscriptRunPublicationCompletion = {}): void {
    const state = this.#run(executionId);
    this.#flushLeadTools(executionId, state);
    this.#publishRemainingSubagents(executionId, state);
    this.#captureTerminalAnswer(executionId, state);
    const finalKey = state.heldFinalAnswer ?? state.heldUnknownAnswer;
    this.#publishRemainingLead(executionId, finalKey);

    if (completion.degraded !== undefined) {
      const node: TranscriptNode = deepFreeze({
        key: `${executionId}::publication-degraded`,
        kind: "annotation",
        status: "error",
        tone: "warn",
        text: completion.degraded,
      });
      this.#append("degraded", [node], executionId);
    }

    const terminal: TranscriptNode[] = [];
    if (finalKey !== undefined) {
      const answer = this.#node(finalKey);
      if (answer !== undefined && !this.#knownKeys.has(answer.key)) terminal.push(answer);
    }
    const run = this.#node(`${executionId}::run`);
    if (run !== undefined && !this.#knownKeys.has(run.key)) terminal.push(run);
    this.#append("run_terminal", terminal, executionId);
    this.#cancelToolFlush(state);
    this.#runs.delete(executionId);
  }

  /** Reset all publication bookkeeping after `/clear` or session replacement. */
  clear(): void {
    for (const state of this.#runs.values()) this.#cancelToolFlush(state);
    this.#runs.clear();
    this.#knownKeys.clear();
    this.#batchSequence = 0;
  }

  /** Release keys whose semantic nodes and immutable publication owners were both discarded. */
  forgetDiscarded(keys: Iterable<string>): void {
    const resident = new Set(this.#host.nodes().map((node) => node.key));
    const discarded = new Set([...keys].filter((key) => !resident.has(key)));
    if (discarded.size === 0) return;

    for (const state of this.#runs.values()) {
      state.pendingTools = state.pendingTools.filter((entry) => !discarded.has(entry.node.key));
      if (state.pendingTools.length === 0) {
        state.pendingToolIdentity = undefined;
        this.#cancelToolFlush(state);
      }
      if (state.heldUnknownAnswer !== undefined && discarded.has(state.heldUnknownAnswer))
        state.heldUnknownAnswer = undefined;
      if (state.heldFinalAnswer !== undefined && discarded.has(state.heldFinalAnswer))
        state.heldFinalAnswer = undefined;
      for (const [delegationId, reserved] of state.reservedSubagents) {
        for (const key of discarded) reserved.delete(key);
        if (reserved.size === 0) state.reservedSubagents.delete(delegationId);
      }
    }

    for (const key of discarded) this.#knownKeys.delete(key);
  }

  /** Number of retained or staged immutable node identities owned by this publisher. */
  knownKeyCount(): number {
    return this.#knownKeys.size;
  }

  #run(executionId: string): RunPublicationState {
    let state = this.#runs.get(executionId);
    if (state === undefined) {
      state = {
        pendingTools: [],
        completedSubagents: [],
        reservedSubagents: new Map(),
      };
      this.#runs.set(executionId, state);
    }
    return state;
  }

  #node(key: string): TranscriptNode | undefined {
    return this.#host.nodes().find((node) => node.key === key);
  }

  #nodes(executionId: string): readonly TranscriptNode[] {
    const prefix = `${executionId}::`;
    return this.#host.nodes().filter((node) => node.key.startsWith(prefix));
  }

  #appendKeys(kind: TranscriptPublicationKind, keys: readonly string[], executionId: string): void {
    this.#append(
      kind,
      keys.flatMap((key) => {
        const node = this.#node(key);
        return node === undefined ? [] : [node];
      }),
      executionId,
    );
  }

  #append(
    kind: TranscriptPublicationKind,
    candidates: readonly TranscriptNode[],
    executionId?: string,
  ): void {
    this.#appendReserved(kind, this.#reserve(candidates), executionId);
  }

  #reserve(candidates: readonly TranscriptNode[]): ReservedPublicationNode[] {
    return candidates.flatMap((node) => {
      if (this.#knownKeys.has(node.key)) return [];
      const snapshot = snapshotTranscriptNode(
        node,
        node.kind === "tool_call" ? this.#host.toolArguments(node) : undefined,
      );
      this.#knownKeys.add(node.key);
      return [{ node: snapshot, defaultFolded: this.#host.defaultFolded(node.key) }];
    });
  }

  #appendReserved(
    kind: TranscriptPublicationKind,
    reserved: readonly ReservedPublicationNode[],
    executionId?: string,
  ): void {
    if (reserved.length === 0) return;
    const nodes = reserved.map((entry) => entry.node);
    const defaultFolded = Object.freeze(
      Object.fromEntries(reserved.map((entry) => [entry.node.key, entry.defaultFolded])),
    );
    const section = publicationSection(kind, nodes);
    this.#host.append({
      id: `publication:${this.#batchSequence++}`,
      ...(executionId === undefined ? {} : { executionId }),
      kind,
      nodes: Object.freeze(nodes),
      defaultFolded,
      toolGroups: publicationToolGroups(nodes),
      ...section,
    });
  }

  #publishIteration(
    executionId: string,
    state: RunPublicationState,
    span: EventSpan,
    event: Extract<RunEvent, { type: "iteration_completed" }>,
  ): void {
    const prefix = `${executionId}::${span.span_id}`;
    const reasoning = `${prefix}#reasoning`;
    const error = `${prefix}#error`;
    const message = `${prefix}#msg`;
    if (event.agent === "subagent") {
      if (event.subagent_id !== undefined)
        this.#reserveSubagent(
          state,
          event.subagent_id,
          [reasoning, error, message].flatMap((key) => {
            const node = this.#node(key);
            return node === undefined ? [] : [node];
          }),
        );
      return;
    }
    this.#flushLeadTools(executionId, state);
    const immediate = [reasoning, error].filter((key) => this.#node(key) !== undefined);
    if (event.response_phase === "commentary") {
      if (this.#node(message) !== undefined) immediate.push(message);
    } else if (event.response_phase === "final_answer") {
      state.heldFinalAnswer = this.#node(message)?.key;
    } else {
      state.heldUnknownAnswer = this.#node(message)?.key;
    }
    this.#appendKeys("iteration", immediate, executionId);
  }

  #publishTool(
    executionId: string,
    state: RunPublicationState,
    span: EventSpan,
    event: Extract<RunEvent, { type: "tool_call" }>,
  ): void {
    if (event.agent === "lead" && isTranscriptExternalOrchestrationTool(event.server, event.tool)) {
      this.#flushLeadTools(executionId, state);
      return;
    }
    const key = `${executionId}::${span.span_id}`;
    const node = this.#node(key);
    if (node?.kind !== "tool_call") return;
    if (event.agent === "subagent") {
      if (node.subagentId !== undefined) this.#reserveSubagent(state, node.subagentId, [node]);
      return;
    }
    if (isMutationTool(node.mcpName, node.toolName)) {
      this.#flushLeadTools(executionId, state);
      this.#append("tool_group", [node], executionId);
      return;
    }
    const reserved = this.#reserve([node]);
    if (reserved.length === 0) return;
    if (
      state.pendingToolIdentity !== undefined &&
      !samePublicationToolIdentity(state.pendingToolIdentity, node)
    )
      this.#flushLeadTools(executionId, state);
    state.pendingToolIdentity = publicationToolIdentity(node);
    state.pendingTools.push(...reserved);
    if (state.pendingTools.length >= this.#toolGroupMaxEntries)
      this.#flushLeadTools(executionId, state);
    else this.#scheduleToolFlush(executionId, state);
  }

  #scheduleToolFlush(executionId: string, state: RunPublicationState): void {
    if (state.groupFlushHandle !== undefined) return;
    state.groupFlushHandle = this.#scheduler.schedule(
      () => this.#flushLeadTools(executionId, state),
      this.#toolGroupLatencyMs,
    );
  }

  #cancelToolFlush(state: RunPublicationState): void {
    if (state.groupFlushHandle === undefined) return;
    this.#scheduler.cancel(state.groupFlushHandle);
    state.groupFlushHandle = undefined;
  }

  #flushLeadTools(executionId: string, state: RunPublicationState): void {
    this.#cancelToolFlush(state);
    const reserved = state.pendingTools.splice(0);
    state.pendingToolIdentity = undefined;
    this.#appendReserved("tool_group", reserved, executionId);
  }

  #rememberSubagentCompletion(state: RunPublicationState, delegationId: string): void {
    if (!state.completedSubagents.includes(delegationId))
      state.completedSubagents.push(delegationId);
  }

  #reserveSubagent(
    state: RunPublicationState,
    delegationId: string,
    candidates: readonly TranscriptNode[],
  ): void {
    let reserved = state.reservedSubagents.get(delegationId);
    if (reserved === undefined) {
      reserved = new Map();
      state.reservedSubagents.set(delegationId, reserved);
    }
    for (const entry of this.#reserve(candidates)) reserved.set(entry.node.key, entry);
  }

  #publishSubagent(executionId: string, state: RunPublicationState, delegationId: string): void {
    const nodes = this.#nodes(executionId).filter((node) => node.subagentId === delegationId);
    const reserved = state.reservedSubagents.get(delegationId) ?? new Map();
    for (const entry of this.#reserve(nodes)) reserved.set(entry.node.key, entry);
    const included = new Set<string>();
    const ordered = nodes.flatMap((node) => {
      const entry = reserved.get(node.key);
      if (entry === undefined) return [];
      included.add(node.key);
      return [entry];
    });
    for (const entry of reserved.values()) {
      if (!included.has(entry.node.key)) ordered.push(entry);
    }
    this.#appendReserved("subagent", ordered, executionId);
    state.reservedSubagents.delete(delegationId);
  }

  #publishRemainingSubagents(executionId: string, state: RunPublicationState): void {
    const ids = new Set(
      this.#nodes(executionId)
        .filter((node) => node.subagentId !== undefined)
        .map((node) => node.subagentId!),
    );
    for (const id of state.reservedSubagents.keys()) ids.add(id);
    const ordered = [
      ...state.completedSubagents.filter((id) => ids.delete(id)),
      ...[...ids].sort((a, b) => {
        const left = this.#nodes(executionId).find((node) => node.subagentId === a);
        const right = this.#nodes(executionId).find((node) => node.subagentId === b);
        return (left?.subagentOrder ?? 0) - (right?.subagentOrder ?? 0);
      }),
    ];
    for (const id of ordered) this.#publishSubagent(executionId, state, id);
  }

  #publishTerminalPoints(executionId: string): void {
    const nodes = this.#nodes(executionId).filter(
      (candidate) =>
        !this.#knownKeys.has(candidate.key) &&
        candidate.kind === "annotation" &&
        candidate.status !== "pending" &&
        candidate.status !== "running",
    );
    this.#append("annotation", nodes, executionId);
  }

  #captureTerminalAnswer(executionId: string, state: RunPublicationState): void {
    const assistants = this.#nodes(executionId).filter(
      (node) =>
        node.kind === "assistant" &&
        node.subagentId === undefined &&
        !this.#knownKeys.has(node.key),
    );
    const explicit = assistants.findLast(
      (node) => node.kind === "assistant" && node.assistantPhase === "final_answer",
    );
    if (explicit !== undefined) state.heldFinalAnswer = explicit.key;
    if (state.heldFinalAnswer === undefined && state.heldUnknownAnswer === undefined) {
      const unknown = assistants.findLast(
        (node) => node.kind === "assistant" && node.assistantPhase === undefined,
      );
      if (unknown !== undefined) state.heldUnknownAnswer = unknown.key;
    }
  }

  #publishRemainingLead(executionId: string, finalKey: string | undefined): void {
    const state = this.#run(executionId);
    for (const node of this.#nodes(executionId)) {
      if (
        this.#knownKeys.has(node.key) ||
        node.key === finalKey ||
        node.kind === "run" ||
        node.kind === "thinking" ||
        node.kind === "plan" ||
        node.subagentId !== undefined ||
        (node.kind === "tool_call" &&
          isTranscriptExternalOrchestrationTool(node.mcpName, node.toolName)) ||
        node.status === "running" ||
        node.status === "pending"
      )
        continue;
      if (node.kind === "tool_call") {
        if (isMutationTool(node.mcpName, node.toolName)) {
          this.#flushLeadTools(executionId, state);
          this.#append("tool_group", [node], executionId);
        } else {
          if (
            state.pendingToolIdentity !== undefined &&
            !samePublicationToolIdentity(state.pendingToolIdentity, node)
          )
            this.#flushLeadTools(executionId, state);
          state.pendingToolIdentity = publicationToolIdentity(node);
          state.pendingTools.push(...this.#reserve([node]));
        }
        continue;
      }
      this.#flushLeadTools(executionId, state);
      this.#append(
        node.kind === "assistant" || node.kind === "reasoning" ? "iteration" : "annotation",
        [node],
        executionId,
      );
    }
    this.#flushLeadTools(executionId, state);
  }
}
