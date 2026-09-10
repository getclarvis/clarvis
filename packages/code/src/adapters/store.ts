import { batch, createSignal } from "solid-js";
import { $RAW, createStore, produce } from "solid-js/store";
import { createHash } from "node:crypto";
import type { MessageContent, RunDetail, RunEvent } from "@clarvis/protocol";
import { deriveEventSpan, type EventSpan, type EventSource } from "./event-span.ts";
import { createSubagentRegistry, iterationTokens, subagentCompletedOk } from "./run-reducers.ts";
import {
  isExpectedPlanDiscard,
  reducePlanProjection,
  type PlanActivity,
  type PlanTaskActivity,
} from "./plan-projection.ts";
import { contentToText } from "./message-content.ts";
import { isTranscriptExternalOrchestrationTool, toolIdentity } from "./tool-identity.ts";
import type { LocalBashResult } from "./local-shell.ts";
import { parseBash } from "./tool-parsers.ts";
import { streamMetrics } from "./stream-metrics.ts";
import { diagnosticEvent } from "../core/diagnostic-events.ts";
import {
  compactionNoticeText,
  compactionSkippedNoticeText,
  softLimitNoticeText,
  visionNoticeText,
  steerNoticeText,
  steerQueuedNoticeText,
  steerUndeliveredNoticeText,
  type TranscriptNode as CoreTranscriptNode,
} from "../core/transcript/index.ts";
import { TRANSCRIPT_PROSE_RELEASED_DISPLAY } from "../core/transcript/presenters.ts";
import {
  delegationLeadMarkerKey,
  TranscriptPublisher,
  type TranscriptPublicationBatch,
  type TranscriptPublicationScheduler,
  type TranscriptRunPublicationCompletion,
} from "./transcript-publication.ts";

export type { NodeStatus } from "../core/transcript/index.ts";

/** Store node: core projection plus concrete plan-task activity type from adapters. */
export type TranscriptNode = CoreTranscriptNode extends infer Node
  ? Node extends { kind: "plan" }
    ? Omit<Node, "tasks"> & { tasks?: PlanTaskActivity[] }
    : Node
  : never;

/** A {@link TranscriptNode} narrowed to a tool call. */
export type TranscriptToolNode = Extract<TranscriptNode, { kind: "tool_call" }>;
/** A {@link TranscriptNode} narrowed to a run summary. */
export type TranscriptRunNode = Extract<TranscriptNode, { kind: "run" }>;
/** A {@link TranscriptNode} narrowed to a plan block. */
export type TranscriptPlanNode = Extract<TranscriptNode, { kind: "plan" }>;
/** A {@link TranscriptNode} narrowed to an annotation (notice/compaction/steer, etc.). */
export type TranscriptAnnotationNode = Extract<TranscriptNode, { kind: "annotation" }>;

/**
 * Return a tool node's original arguments rather than Solid's deep store proxy.
 *
 * The display projector deliberately inspects data descriptors without invoking
 * accessors. Solid store proxies expose every ordinary field as an accessor,
 * which made safe, real arguments look like hostile getters in the expanded
 * transcript. `$RAW` is a shallow escape hatch: unlike `unwrap`, it does not
 * recursively walk an arbitrarily large payload before the projector's own
 * node/character budgets can apply.
 */
export function rawToolArguments(node: TranscriptToolNode): Record<string, unknown> | undefined {
  const args = node.args;
  if (args === undefined) return undefined;
  const raw = (args as Record<PropertyKey, unknown>)[$RAW];
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : args;
}

/** Fan a single event stream out to every sink in `sinks`, in order. */
export function teeSink(...sinks: RunSink[]): RunSink {
  return {
    open: (s, e, src) => sinks.forEach((k) => k.open(s, e, src)),
    point: (s, e, src) => sinks.forEach((k) => k.point(s, e, src)),
    close: (s, e, src) => sinks.forEach((k) => k.close(s, e, src)),
    beginReconcile: () => sinks.forEach((k) => k.beginReconcile()),
    endReconcile: () => sinks.forEach((k) => k.endReconcile()),
  };
}

function asArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const LIVE_OUTPUT_MAX_LINES = 50;
const LIVE_OUTPUT_MAX_CHARS = 8192;

/** Maximum retained prose for one transcript node. */
export const TRANSCRIPT_PROSE_MAX_CHARS = 2 * 1024 * 1024;
export const TRANSCRIPT_PROSE_TRUNCATED_NOTICE =
  "\n\n[Display truncated at 2 million characters to protect TUI memory.]";

/** Aggregate UTF-16 storage budget for resident user/assistant/reasoning prose. */
const TRANSCRIPT_PROSE_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
export const TRANSCRIPT_PROSE_RELEASED_NOTICE = TRANSCRIPT_PROSE_RELEASED_DISPLAY;

export interface BoundedTranscriptText {
  text: string;
  truncated: boolean;
}

/** Small identity for matching released display prose to a persisted message without retaining it. */
export function transcriptTextFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 22);
}

/** Bound one complete prose value before it reaches Solid/OpenTUI state. */
export function boundTranscriptText(value: string): BoundedTranscriptText {
  if (value.length <= TRANSCRIPT_PROSE_MAX_CHARS) return { text: value, truncated: false };
  const prefixChars = TRANSCRIPT_PROSE_MAX_CHARS - TRANSCRIPT_PROSE_TRUNCATED_NOTICE.length;
  return {
    text: value.slice(0, prefixChars) + TRANSCRIPT_PROSE_TRUNCATED_NOTICE,
    truncated: true,
  };
}

/** Append a streamed suffix without first constructing an over-limit aggregate. */
function appendTranscriptText(
  existing: string,
  suffix: string,
  alreadyTruncated = false,
): BoundedTranscriptText {
  if (alreadyTruncated) return { text: existing, truncated: true };
  if (existing.length + suffix.length <= TRANSCRIPT_PROSE_MAX_CHARS) {
    return { text: existing + suffix, truncated: false };
  }
  const prefixChars = TRANSCRIPT_PROSE_MAX_CHARS - TRANSCRIPT_PROSE_TRUNCATED_NOTICE.length;
  const prefix =
    existing.length >= prefixChars
      ? existing.slice(0, prefixChars)
      : existing + suffix.slice(0, prefixChars - existing.length);
  return {
    text: prefix + TRANSCRIPT_PROSE_TRUNCATED_NOTICE,
    truncated: true,
  };
}

/**
 * Append a streamed output chunk to a running tool call's live buffer, capping
 * it first by total characters and then by line count so a chatty tool never
 * grows the transcript unbounded while it is still running.
 */
function appendLiveOutput(existing: string | undefined, chunk: string): string {
  let next = (existing ?? "") + chunk;
  if (next.length > LIVE_OUTPUT_MAX_CHARS) next = next.slice(-LIVE_OUTPUT_MAX_CHARS);
  const lines = next.split("\n");
  if (lines.length > LIVE_OUTPUT_MAX_LINES) next = lines.slice(-LIVE_OUTPUT_MAX_LINES).join("\n");
  return next;
}

/** Stable frontier label for a provider retry without exposing a moving countdown. */
function modelRetryText(event: Extract<RunEvent, { type: "model_retry" }>): string {
  const delay = Math.max(0, Math.ceil(event.delay_ms / 1000));
  return `retrying in ${delay}s (${event.attempt}/${event.max_retries}) — ${event.kind}`;
}

/** Immutable question/answer fact produced when an elicitation leaves the live frontier. */
function elicitationOutcomeText(
  event: Extract<RunEvent, { type: "elicitation_resolved" }>,
): string {
  const outcome =
    event.outcome === "accept" && event.answer?.trim()
      ? event.answer.trim()
      : event.outcome === "accept"
        ? "accepted"
        : event.outcome;
  return `asked: ${event.question}\nanswered: ${outcome}`;
}

/** Receives one callback per event span phase: opened, an interior point, or closed. */
export interface SpanSink {
  open(span: EventSpan, event: RunEvent, source: EventSource): void;
  point(span: EventSpan, event: RunEvent, source: EventSource): void;
  close(span: EventSpan, event: RunEvent, source: EventSource): void;
}

/** Derive `event`'s {@link EventSpan} and dispatch it to the matching {@link SpanSink} method. */
export function applyEvent(sink: SpanSink, event: RunEvent, source: EventSource): void {
  const span = deriveEventSpan(event);
  if (span.phase === "start") sink.open(span, event, source);
  else if (span.phase === "point") sink.point(span, event, source);
  else sink.close(span, event, source);
}

/**
 * A sink that can absorb a stored run's replay over the transcript it already
 * rendered live. The replay is bracketed rather than preceded by a wipe: nodes
 * the replay regenerates keep the identity they already have, so finishing a
 * run patches the transcript instead of remounting every block in it.
 */
export interface RunSink extends SpanSink {
  /**
   * Add an immediate steer acknowledgement that the later
   * `steering_applied` event updates in place.
   *
   * @returns controls that either discard a synchronously refused request or
   *   retain a visible failure receipt when delivery could not complete.
   */
  queueSteer?(message: string): QueuedSteerReceipt;
  /** Opens a reconciliation pass: everything applied until endReconcile is a replay. */
  beginReconcile(): void;
  /** Closes the pass, dropping whatever the replay did not regenerate. */
  endReconcile(): void;
}

/** Client-owned controls for one optimistic steering receipt. */
export interface QueuedSteerReceipt {
  /** Removes a request the server refused before accepting it as steering. */
  discard(): void;
  /** Promotes a rejected delivery to a reconciliation-stable warning. */
  fail(): void;
}

/** Run sink whose transcript publisher is closed only after host reconciliation completes. */
export interface TranscriptRunSink extends RunSink {
  complete(completion?: TranscriptRunPublicationCompletion): void;
}

/** The fields of a local (`!bash`) shell result the transcript needs to render it. */
export type LocalBashDisplay = Pick<
  LocalBashResult,
  | "exitCode"
  | "stdout"
  | "stderr"
  | "signal"
  | "timedOut"
  | "cancelled"
  | "stdoutTruncated"
  | "stderrTruncated"
>;

/** The reactive transcript the UI renders, and the reducers that populate it from runs and local commands. */
export interface TranscriptStore {
  nodes: TranscriptNode[];
  /**
   * Immutable history batches, append-only during ordinary publication.
   *
   * @remarks Explicit host retention may replace an evicted whole-batch prefix
   *   with one immutable folded-prefix batch; individual published nodes are
   *   never patched in place.
   */
  readonly publicationBatches: readonly TranscriptPublicationBatch[];
  /** Mutable candidates not yet visible as committed history. */
  frontierNodes(): readonly TranscriptNode[];
  /** Immutable nodes from every semantically sealed publication batch. */
  committedNodes(): readonly TranscriptNode[];
  /**
   * Compatibility acknowledgement for callers predating physical viewport ownership.
   *
   * @remarks Physical readiness now belongs to `CommittedHistory`; semantic publication is sealed
   * immediately and this method deliberately performs no state transition.
   */
  markPublicationReady(batchId: string): void;
  /** O(1) retained-memory counters for the process-level diagnostic ledger. */
  memory?(): {
    transcript_nodes: number;
    transcript_prose_bytes: number;
    publication_batches: number;
    publication_known_keys: number;
    hydrated_tool_nodes: number;
    hydrated_tool_bytes: number;
    active_rehydrates: number;
    queued_rehydrates: number;
  };
  /** Ephemeral presentation default derived while reducing the current run. */
  defaultFolded(key: string): boolean;
  appendUserMessage(
    content: MessageContent,
    displayText?: string,
    sourceExecutionId?: string,
  ): string;
  /**
   * Replace every semantic node before `beforeKey` with one bounded notice.
   *
   * @returns whether the boundary existed and a prefix was folded.
   * @remarks This is deliberately one array replacement plus one index rebuild.
   *   Calling {@link remove} for every old node would reindex the shrinking tail
   *   once per removal and turn a long-session fold into quadratic work.
   */
  foldPrefixBefore(beforeKey: string, notice: string): boolean;
  /**
   * Append a client-side annotation raised by the shell rather than by a run
   * event (e.g. a plan warning or immediate steer acknowledgement).
   */
  appendNotice(text: string, tone?: "info" | "warn" | "accent"): void;
  beginLocalBash(command: string): (result: LocalBashDisplay) => void;
  /**
   * Record why a run failed, when nothing in the run itself already did.
   *
   * @param execId - the failed run's execution id.
   * @param error - the envelope's stable code and message.
   * @remarks A run rejected before its first model call — a bad agent profile,
   *   an unresolvable model, a refused key — emits no `model_error`, so the
   *   transcript stayed empty and the only report was the word `Failed` in the
   *   header. The cause reached the client on the envelope and was thrown away.
   *   No-ops when the run already produced an error node, so a model failure is
   *   not reported twice.
   */
  appendRunFailure(execId: string, error: { code: string; message: string }): void;
  settleRun(execId: string, ok?: boolean): void;
  openRun(execId: string): TranscriptRunSink;
  clear(): void;
  /**
   * Refill a tool block whose body was dropped by the retention window.
   *
   * @param key - the node key, as carried on {@link TranscriptToolNode.key}.
   * @returns once the body is back, or immediately when the node is unknown,
   *   still hydrated, or no run fetcher was supplied.
   * @remarks Safe to call on every expand: a hydrated node is a no-op and
   *   concurrent calls for the same key share one fetch.
   */
  rehydrate(key: string): Promise<void>;
}

/** Construction-time dependencies for {@link createTranscriptStore}. */
export interface TranscriptStoreDeps {
  /**
   * Fetches a run's persisted detail, used to refill a dehydrated tool block.
   *
   * @remarks Omitted in tests and in any host with no kernel behind it; without
   *   it a dehydrated block simply stays empty rather than failing.
   */
  fetchRun?: (executionId: string) => Promise<RunDetail | null>;
  /** How many tool-call bodies stay resident; see {@link DEFAULT_HYDRATED_TOOL_LIMIT}. */
  hydratedToolLimit?: number;
  /** Aggregate estimated bytes across hydrated tool args/results/diffs/errors. */
  hydratedToolBytesLimit?: number;
  /** Hard ceiling for one explicitly reloaded tool body. */
  hydratedToolSingleBytesLimit?: number;
  /** Maximum distinct persisted-run detail reads in flight. */
  maxConcurrentRehydrates?: number;
  /** Maximum distinct hydration requests waiting behind the in-flight reads. */
  maxQueuedRehydrates?: number;
  /** Aggregate resident prose budget; injectable so retention can be tested without large fixtures. */
  proseTotalLimitBytes?: number;
  /**
   * Renders the small, always-resident projection of a tool call: the signature
   * its collapsed header and the Markdown export show, and the mutation chip's
   * counts.
   *
   * @remarks Injected rather than imported because both renderers live under
   *   `views/`, which this layer must not reach into. Omitted, a dehydrated
   *   block simply falls back to rendering from whatever fields it still has.
   */
  describeToolCall?: (input: {
    mcpName?: string;
    toolName?: string;
    args?: Record<string, unknown>;
    diff?: string;
  }) => { signature: string; mutation: { added: number; removed: number; lines: number } | null };
  /** Injectable publication scheduler used by deterministic grouping tests. */
  publicationScheduler?: TranscriptPublicationScheduler;
  /** Maximum time a terminal same-tool candidate may wait for a grouping sibling. */
  publicationToolGroupLatencyMs?: number;
  /** Maximum terminal same-tool candidates retained by one staging group. */
  publicationToolGroupMaxEntries?: number;
}

/**
 * How many of the most recent tool calls keep their `args`/`result`/`diff` in
 * memory.
 *
 * @remarks The count cap prevents small bodies from accumulating forever; the
 * aggregate character cap below handles large MCP responses. An old block is
 * folded and off-screen, so dropping its body costs nothing until the user
 * expands it, at which point it is fetched back.
 */
const DEFAULT_HYDRATED_TOOL_LIMIT = 200;

/**
 * Aggregate resident byte estimate for hydrated tool bodies.
 *
 * MCP admits an individual response body of up to 16 MiB. A count-only window
 * of 200 therefore still allowed several GiB to survive in the transcript.
 * Strings are charged as UTF-16 plus a fixed structural estimate, and the
 * budget is enforced in addition to the count limit.
 */
const DEFAULT_HYDRATED_TOOL_BYTES_LIMIT = 64 * 1024 * 1024;
const DEFAULT_HYDRATED_TOOL_SINGLE_BYTES_LIMIT = 32 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_TOOL_REHYDRATES = 2;
const DEFAULT_MAX_QUEUED_TOOL_REHYDRATES = 8;
const TOOL_BODY_TOO_LARGE_NOTICE =
  "Tool body is too large for the live TUI. Use /export to inspect the persisted transcript.";
const TOOL_BODY_REHYDRATE_BUSY_NOTICE =
  "Tool body reload queue is full. Wait for another expanded tool to finish loading, then retry.";
const TOOL_BODY_REHYDRATE_FAILED_NOTICE =
  "Tool body could not be reloaded from persistence. Use /export to inspect the available transcript.";

/**
 * Build the {@link TranscriptStore} with a mutable semantic ledger and a
 * separate immutable publication ledger. User messages, local shell commands,
 * and each run's live events (via {@link TranscriptStore.openRun}) upsert the
 * semantic `nodes` array so reconciliation can repair detail state in place;
 * the publisher snapshots terminal candidates into frozen batches that the
 * committed-history owner mounts without later semantic updates.
 */
export function createTranscriptStore(deps: TranscriptStoreDeps = {}): TranscriptStore {
  const [state, setState] = createStore<{ nodes: TranscriptNode[] }>({ nodes: [] });
  const [publicationBatches, setPublicationBatches] = createSignal<
    readonly TranscriptPublicationBatch[]
  >(Object.freeze([]));
  const indexOfKey = new Map<string, number>();
  const foldDefaults = new Map<string, boolean>();
  const publisher = new TranscriptPublisher(
    {
      nodes: () => state.nodes,
      defaultFolded: (key) => foldDefaults.get(key) ?? false,
      toolArguments: rawToolArguments,
      append: (prepared) => {
        setPublicationBatches((current) =>
          Object.freeze([
            ...current,
            Object.freeze({
              ...prepared,
              phase: "committed" as const,
              ready: true,
            }),
          ]),
        );
      },
    },
    {
      ...(deps.publicationScheduler === undefined ? {} : { scheduler: deps.publicationScheduler }),
      ...(deps.publicationToolGroupLatencyMs === undefined
        ? {}
        : { toolGroupLatencyMs: deps.publicationToolGroupLatencyMs }),
      ...(deps.publicationToolGroupMaxEntries === undefined
        ? {}
        : { toolGroupMaxEntries: deps.publicationToolGroupMaxEntries }),
    },
  );
  const metrics = streamMetrics();
  const hydratedToolLimit = Math.max(
    0,
    Math.floor(deps.hydratedToolLimit ?? DEFAULT_HYDRATED_TOOL_LIMIT),
  );
  const hydratedToolBytesLimit = Math.max(
    0,
    Math.floor(deps.hydratedToolBytesLimit ?? DEFAULT_HYDRATED_TOOL_BYTES_LIMIT),
  );
  const hydratedToolSingleBytesLimit = Math.max(
    0,
    Math.floor(deps.hydratedToolSingleBytesLimit ?? DEFAULT_HYDRATED_TOOL_SINGLE_BYTES_LIMIT),
  );
  const maxConcurrentRehydrates = Math.max(
    1,
    Math.floor(deps.maxConcurrentRehydrates ?? DEFAULT_MAX_CONCURRENT_TOOL_REHYDRATES),
  );
  const maxQueuedRehydrates = Math.max(
    0,
    Math.floor(deps.maxQueuedRehydrates ?? DEFAULT_MAX_QUEUED_TOOL_REHYDRATES),
  );
  const proseTotalLimitBytes = Math.max(
    0,
    Math.floor(deps.proseTotalLimitBytes ?? TRANSCRIPT_PROSE_TOTAL_MAX_BYTES),
  );
  const hydratedTools: string[] = [];
  const hydratedToolBytesByKey = new Map<string, number>();
  let hydratedToolBytes = 0;
  const rehydrating = new Map<string, Promise<void>>();
  const rehydrateQueue: { key: string; run: () => Promise<void>; cancel: () => void }[] = [];
  let activeRehydrates = 0;
  let hydrationEpoch = 0;
  const proseBytesByKey = new Map<string, number>();
  const proseOrder: string[] = [];
  let proseBytes = 0;

  type RetainedProseNode = TranscriptNode & {
    kind: "user" | "assistant" | "reasoning";
    textTruncated?: true;
    textEpoch?: number;
  };

  function isProseNode(node: TranscriptNode | undefined): node is RetainedProseNode {
    return (
      node !== undefined &&
      (node.kind === "user" || node.kind === "assistant" || node.kind === "reasoning")
    );
  }

  function reindex(): void {
    indexOfKey.clear();
    state.nodes.forEach((n, i) => indexOfKey.set(n.key, i));
  }

  let replayed: { keys: string[]; seen: Set<string> } | null = null;

  function retainedProseBytes(node: TranscriptNode | undefined): number | null {
    if (!isProseNode(node) || node.text === TRANSCRIPT_PROSE_RELEASED_NOTICE) return null;
    // JavaScript strings are UTF-16. Charging two bytes per code unit is a
    // conservative, allocation-free estimate for the heap retained by prose.
    return node.text.length * 2;
  }

  function forgetProse(key: string): void {
    const previous = proseBytesByKey.get(key);
    if (previous === undefined) return;
    proseBytesByKey.delete(key);
    proseBytes -= previous;
  }

  function releaseOldProse(protectedKey?: string): void {
    let candidates = proseOrder.length;
    while (proseBytes > proseTotalLimitBytes && candidates-- > 0) {
      const key = proseOrder.shift();
      if (key === undefined) break;
      const charged = proseBytesByKey.get(key);
      if (charged === undefined) continue;
      const index = indexOfKey.get(key);
      if (index === undefined) {
        forgetProse(key);
        continue;
      }
      const node = state.nodes[index];
      if (node === undefined) {
        forgetProse(key);
        continue;
      }
      if (key === protectedKey || node.status === "running") {
        proseOrder.push(key);
        continue;
      }

      forgetProse(key);
      setState(
        "nodes",
        index,
        produce((current: TranscriptNode) => {
          if (!isProseNode(current)) return;
          current.text = TRANSCRIPT_PROSE_RELEASED_NOTICE;
          current.textTruncated = true;
          current.proseReleased = true;
          if (current.kind === "assistant" || current.kind === "reasoning")
            current.textEpoch = (current.textEpoch ?? 0) + 1;
        }),
      );
    }
  }

  function syncProse(key: string, index: number): void {
    const next = retainedProseBytes(state.nodes[index]);
    const previous = proseBytesByKey.get(key);
    if (next === null) {
      forgetProse(key);
      return;
    }
    if (previous === undefined) {
      proseOrder.push(key);
      proseBytesByKey.set(key, next);
      proseBytes += next;
    } else if (previous !== next) {
      proseBytesByKey.set(key, next);
      proseBytes += next - previous;
    }
    // Reconciliation may replay hundreds of complete iteration responses before
    // `endReconcile`. Enforce the aggregate bound incrementally here too; waiting
    // for the final rebuild recreates exactly the transient multi-GiB spike the
    // resident budget exists to prevent.
    releaseOldProse(key);
  }

  function rebuildProseAccounting(): void {
    proseBytesByKey.clear();
    proseOrder.length = 0;
    proseBytes = 0;
    for (const node of state.nodes) {
      const bytes = retainedProseBytes(node);
      if (bytes === null) continue;
      proseBytesByKey.set(node.key, bytes);
      proseOrder.push(node.key);
      proseBytes += bytes;
    }
    releaseOldProse();
  }

  function upsert(key: string, init: () => Omit<TranscriptNode, "key">): number {
    if (replayed !== null && !replayed.seen.has(key)) {
      replayed.seen.add(key);
      replayed.keys.push(key);
    }
    const existing = indexOfKey.get(key);
    if (existing !== undefined) return existing;
    const node: TranscriptNode = { key, ...init() };
    const index = state.nodes.length;
    setState("nodes", index, node);
    indexOfKey.set(key, index);
    syncProse(key, index);
    return index;
  }

  function patch(index: number, updater: (n: TranscriptNode) => void): void {
    const key = state.nodes[index]?.key;
    setState("nodes", index, produce(updater));
    if (key !== undefined) syncProse(key, index);
  }

  function patchKind<K extends TranscriptNode["kind"]>(
    index: number,
    kind: K,
    updater: (node: Extract<TranscriptNode, { kind: K }>) => void,
  ): void {
    patch(index, (node) => {
      if (node.kind === kind) updater(node as Extract<TranscriptNode, { kind: K }>);
    });
  }

  function remove(key: string): void {
    const index = indexOfKey.get(key);
    if (index === undefined) return;
    forgetProse(key);
    setState(
      "nodes",
      produce((arr) => {
        arr.splice(index, 1);
      }),
    );
    indexOfKey.delete(key);
    foldDefaults.delete(key);
    forgetHydrated(key);
    for (let i = index; i < state.nodes.length; i += 1) indexOfKey.set(state.nodes[i]!.key, i);
  }

  const VALUE_CONTAINER_OVERHEAD_BYTES = 48;
  const VALUE_SLOT_OVERHEAD_BYTES = 16;

  /**
   * Estimate retained JS heap without serializing/copying an argument object.
   *
   * @remarks `Object.getOwnPropertyDescriptors` is deliberately avoided: it
   *   allocates one descriptor object per property before a budget can stop the
   *   walk. `Object.keys` creates only a compact key array and descriptors are
   *   inspected one at a time so accessors are never invoked.
   */
  function retainedValueBytes(root: unknown, stopAfter = hydratedToolBytesLimit): number {
    const pending = [root];
    const seen = new WeakSet<object>();
    let total = 0;
    let nodes = 0;
    while (pending.length > 0 && total <= stopAfter) {
      const value = pending.pop();
      nodes += 1;
      if (nodes > 100_000) return stopAfter + 1;
      if (typeof value === "string") {
        total += value.length * 2 + VALUE_SLOT_OVERHEAD_BYTES;
        continue;
      }
      if (value === null || typeof value !== "object") {
        total += VALUE_SLOT_OVERHEAD_BYTES;
        continue;
      }
      if (seen.has(value)) continue;
      seen.add(value);
      total += VALUE_CONTAINER_OVERHEAD_BYTES;
      const keys = Object.keys(value);
      for (const key of keys) {
        total += key.length * 2 + VALUE_SLOT_OVERHEAD_BYTES;
        if (total > stopAfter) break;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined && "value" in descriptor) pending.push(descriptor.value);
      }
    }
    return total;
  }

  function toolBodyBytes(node: TranscriptToolNode, stopAfter = hydratedToolBytesLimit): number {
    return (
      retainedValueBytes(node.args, stopAfter) +
      (node.result?.length ?? 0) * 2 +
      (node.diff?.length ?? 0) * 2 +
      (node.error?.length ?? 0) * 2
    );
  }

  function forgetHydrated(key: string): void {
    const bytes = hydratedToolBytesByKey.get(key);
    if (bytes !== undefined) {
      hydratedToolBytes = Math.max(0, hydratedToolBytes - bytes);
      hydratedToolBytesByKey.delete(key);
    }
    const existing = hydratedTools.indexOf(key);
    if (existing !== -1) hydratedTools.splice(existing, 1);
  }

  /**
   * Record a tool block as holding a body, dropping the bodies of any that fall
   * out of the retention window.
   *
   * @remarks A FIFO of keys rather than a scan: the alternative — counting
   *   hydrated nodes on every tool close — is the O(n)-per-close pattern this
   *   file is otherwise trying to shed.
   *
   *   A key already in the window is **moved** to the newest position rather
   *   than appended twice. The same `tool_call` event reaches this reducer more
   *   than once by design — every completed run is replayed from its stored
   *   trace to reconcile ordering, and an expanded block is refilled — and a
   *   second entry would both halve the effective window and, worse, evict the
   *   older duplicate while the key is still well inside it, blanking a block
   *   the user can see.
   */
  function noteHydrated(key: string): boolean {
    forgetHydrated(key);
    const index = indexOfKey.get(key);
    const node = index === undefined ? undefined : state.nodes[index];
    if (node?.kind !== "tool_call" || node.status === "running") return false;
    const bytes = toolBodyBytes(node);
    if (bytes > hydratedToolSingleBytesLimit) {
      dehydrate(key, TOOL_BODY_TOO_LARGE_NOTICE);
      return false;
    }
    hydratedTools.push(key);
    hydratedToolBytesByKey.set(key, bytes);
    hydratedToolBytes += bytes;
    while (hydratedTools.length > hydratedToolLimit || hydratedToolBytes > hydratedToolBytesLimit) {
      const evicted = hydratedTools.shift();
      if (evicted === undefined) break;
      const evictedBytes = hydratedToolBytesByKey.get(evicted) ?? 0;
      hydratedToolBytesByKey.delete(evicted);
      hydratedToolBytes = Math.max(0, hydratedToolBytes - evictedBytes);
      dehydrate(evicted);
    }
    return hydratedToolBytesByKey.has(key);
  }

  function dehydrate(key: string, hydrationNotice?: string): void {
    const index = indexOfKey.get(key);
    if (index === undefined) return;
    patchKind(index, "tool_call", (n) => {
      if (n.status === "running") return;
      n.args = undefined;
      n.result = undefined;
      n.diff = undefined;
      n.error = undefined;
      n.dehydrated = true;
      n.hydrationNotice = hydrationNotice;
    });
  }

  /**
   * Locate a run event's tool node key, mirroring the span id
   * `deriveEventSpan` assigns a `tool_call`.
   */
  function toolKeyOf(execId: string, event: RunEvent): string | null {
    if (event.type !== "tool_call") return null;
    return `${execId}::${event.call_id ?? `${event.agent}:tool`}`;
  }

  /**
   * Record a transcript node that could not be re-fetched.
   *
   * @param error - why the fetch failed.
   * @remarks The node stays collapsed and dehydrated, which looks to the user
   *   exactly like a node that has simply not been expanded yet.
   */
  function reportRehydrateFailure(error: unknown): void {
    diagnosticEvent("transcript.rehydrate.failed", { error }, "warn");
  }

  function pumpRehydrates(): void {
    while (activeRehydrates < maxConcurrentRehydrates && rehydrateQueue.length > 0) {
      const job = rehydrateQueue.shift();
      if (job === undefined) break;
      activeRehydrates += 1;
      void job
        .run()
        .catch(reportRehydrateFailure)
        .finally(() => {
          activeRehydrates = Math.max(0, activeRehydrates - 1);
          pumpRehydrates();
        });
    }
  }

  async function rehydrate(key: string): Promise<void> {
    const index = indexOfKey.get(key);
    if (index === undefined) return;
    const node = state.nodes[index];
    if (node?.kind !== "tool_call" || node.dehydrated !== true) return;
    const fetchRun = deps.fetchRun;
    const separator = key.indexOf("::");
    const execId = separator === -1 ? "" : key.slice(0, separator);
    if (fetchRun === undefined || execId.length === 0) {
      patchKind(index, "tool_call", (n) => {
        n.hydrationNotice = TOOL_BODY_REHYDRATE_FAILED_NOTICE;
      });
      return;
    }

    const inFlight = rehydrating.get(key);
    if (inFlight !== undefined) return inFlight;

    if (
      activeRehydrates >= maxConcurrentRehydrates &&
      rehydrateQueue.length >= maxQueuedRehydrates
    ) {
      patchKind(index, "tool_call", (n) => {
        n.hydrationNotice = TOOL_BODY_REHYDRATE_BUSY_NOTICE;
      });
      return;
    }

    const requestedEpoch = hydrationEpoch;
    let resolveRun!: () => void;
    const run = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const job = async (): Promise<void> => {
      try {
        let detail: RunDetail | null;
        try {
          detail = await fetchRun(execId);
        } catch (error) {
          reportRehydrateFailure(error);
          const at = indexOfKey.get(key);
          if (at !== undefined)
            patchKind(at, "tool_call", (n) => {
              n.hydrationNotice = TOOL_BODY_REHYDRATE_FAILED_NOTICE;
            });
          return;
        }
        if (requestedEpoch !== hydrationEpoch) return;
        const event = detail?.events.find((e) => toolKeyOf(execId, e) === key);
        if (event === undefined || event.type !== "tool_call") {
          const at = indexOfKey.get(key);
          if (at !== undefined)
            patchKind(at, "tool_call", (n) => {
              n.hydrationNotice = TOOL_BODY_REHYDRATE_FAILED_NOTICE;
            });
          return;
        }
        const at = indexOfKey.get(key);
        if (at === undefined) return;
        const eventArgs = asArgs(event.arguments);
        const estimatedBytes =
          retainedValueBytes(eventArgs, hydratedToolSingleBytesLimit) +
          (event.result?.length ?? 0) * 2 +
          (event.diff?.length ?? 0) * 2 +
          (event.error?.length ?? 0) * 2;
        if (estimatedBytes > hydratedToolSingleBytesLimit) {
          patchKind(at, "tool_call", (n) => {
            n.hydrationNotice = TOOL_BODY_TOO_LARGE_NOTICE;
          });
          return;
        }
        patchKind(at, "tool_call", (n) => {
          n.args = eventArgs;
          n.result = event.result;
          n.diff = event.diff;
          n.error = event.error;
          n.guard = event.guard;
          n.dehydrated = undefined;
          n.hydrationNotice = undefined;
        });
        noteHydrated(key);
      } finally {
        rehydrating.delete(key);
        resolveRun();
      }
    };

    rehydrating.set(key, run);
    rehydrateQueue.push({ key, run: job, cancel: resolveRun });
    pumpRehydrates();
    return run;
  }

  let userSeq = 0;
  function appendUserMessage(
    content: MessageContent,
    displayText?: string,
    sourceExecutionId?: string,
  ): string {
    const sourceText = displayText ?? contentToText(content);
    const bounded = boundTranscriptText(sourceText);
    const key = `user:${userSeq++}`;
    upsert(key, () => ({
      kind: "user",
      status: "ok",
      text: bounded.text,
      sourceTextFingerprint: transcriptTextFingerprint(sourceText),
      ...(sourceExecutionId === undefined ? {} : { sourceExecutionId }),
      ...(bounded.truncated ? { textTruncated: true } : {}),
    }));
    publisher.publishImmediate(key, "user");
    return key;
  }

  let noticeSeq = 0;
  /**
   * Record why a run failed, when nothing else in the transcript already said so.
   *
   * @remarks Suppression is by the *rendered text*, not by "this run has some
   *   error node". A run that logged a recoverable error early, retried and then
   *   failed for an unrelated reason would otherwise show only the stale one,
   *   which is the "the transcript never says why" case this exists for. The key
   *   carries the code for the same reason: two genuinely different causes are
   *   two facts, and `upsert` keeps the first node it is given for a key.
   */
  function appendRunFailure(execId: string, error: { code: string; message: string }): void {
    const prefix = `${execId}::`;
    const bounded = boundTranscriptText(`${error.code}: ${error.message}`);
    if (
      state.nodes.some(
        (n) => n.kind === "error" && n.key.startsWith(prefix) && n.text === bounded.text,
      )
    ) {
      return;
    }
    upsert(`${prefix}run-failed:${error.code}`, () => ({
      kind: "error",
      status: "error",
      text: bounded.text,
    }));
  }

  function appendNotice(text: string, tone: "info" | "warn" | "accent" = "info"): void {
    const bounded = boundTranscriptText(text);
    const key = `notice:${noticeSeq++}`;
    upsert(key, () => ({
      kind: "annotation",
      status: "ok",
      tone,
      text: bounded.text,
    }));
    publisher.publishImmediate(key, "annotation");
  }

  const FOLDED_PREFIX_KEY = "transcript:folded-prefix";
  let foldedPrefixPublicationSequence = 0;

  function foldPrefixBefore(beforeKey: string, notice: string): boolean {
    const boundary = indexOfKey.get(beforeKey);
    if (boundary === undefined || boundary === 0) return false;

    const removed = new Set(state.nodes.slice(0, boundary).map((node) => node.key));
    const foldedNotice: TranscriptAnnotationNode = {
      key: FOLDED_PREFIX_KEY,
      kind: "annotation",
      status: "ok",
      tone: "info",
      text: notice,
    };

    const foldedPublication: TranscriptPublicationBatch = Object.freeze({
      id: `publication:folded-prefix:${foldedPrefixPublicationSequence++}`,
      kind: "annotation",
      nodes: Object.freeze([Object.freeze({ ...foldedNotice })]),
      defaultFolded: Object.freeze({ [FOLDED_PREFIX_KEY]: false }),
      toolGroups: Object.freeze({}),
      sectionHeaders: Object.freeze({}),
      sectionAnchors: Object.freeze({}),
      sectionFoldedKeys: Object.freeze([]),
      phase: "committed",
      ready: true,
    });

    const retainedPublications = publicationBatches().filter(
      (publication) =>
        !publication.id.startsWith("publication:folded-prefix:") &&
        !publication.nodes.every((node) => removed.has(node.key)),
    );
    const retainedPublicationKeys = new Set(
      retainedPublications.flatMap((publication) => publication.nodes.map((node) => node.key)),
    );

    batch(() => {
      setState("nodes", [foldedNotice, ...state.nodes.slice(boundary)]);
      setPublicationBatches(Object.freeze([foldedPublication, ...retainedPublications]));
    });

    publisher.forgetDiscarded([...removed].filter((key) => !retainedPublicationKeys.has(key)));

    for (const key of removed) foldDefaults.delete(key);
    const retainedHydrated = hydratedTools.filter((key) => !removed.has(key));
    hydratedTools.splice(0, hydratedTools.length, ...retainedHydrated);
    for (const key of removed) hydratedToolBytesByKey.delete(key);
    hydratedToolBytes = 0;
    for (const key of hydratedTools) hydratedToolBytes += hydratedToolBytesByKey.get(key) ?? 0;

    // A queued reload for a node that no longer exists should not keep its key
    // and promise alive until every newer reload ahead of it has completed.
    const retainedQueue: typeof rehydrateQueue = [];
    for (const job of rehydrateQueue) {
      if (removed.has(job.key)) {
        rehydrating.delete(job.key);
        job.cancel();
      } else {
        retainedQueue.push(job);
      }
    }
    rehydrateQueue.splice(0, rehydrateQueue.length, ...retainedQueue);

    reindex();
    rebuildProseAccounting();
    return true;
  }

  let localSeq = 0;
  function beginLocalBash(command: string): (result: LocalBashDisplay) => void {
    const key = `local:${localSeq++}`;
    upsert(key, () => ({
      kind: "tool_call",
      status: "running",
      text: "",
      mcpName: "local",
      toolName: "shell",
      args: { command },
      startedAt: Date.now(),
    }));
    return (r) => {
      const index = indexOfKey.get(key);
      if (index === undefined) return;
      const failed = r.exitCode !== 0 || r.timedOut || r.cancelled;
      patchKind(index, "tool_call", (n) => {
        n.result = JSON.stringify({
          ...(r.exitCode !== null ? { exit_code: r.exitCode } : {}),
          stdout: r.stdout + (r.stdoutTruncated ? "\n[stdout truncated]" : ""),
          stderr: r.stderr + (r.stderrTruncated ? "\n[stderr truncated]" : ""),
          ...(r.signal !== null ? { signal: r.signal } : {}),
          ...(r.timedOut ? { timed_out: true } : {}),
        });
        n.status = "ok";
        if (n.startedAt) n.elapsedMs = Date.now() - n.startedAt;
        n.warn = failed;
        foldDefaults.set(n.key, !failed);
      });
      noteHydrated(key);
      publisher.publishImmediate(key, "local");
    };
  }

  /**
   * Close out every node a finished run left `running`.
   *
   * @remarks The whole body is one `batch` because it is the transcript's widest
   *   burst of writes: a stale-`thinking` sweep that can replace the node array
   *   outright, then one `patch` per still-running node. Each of those writes
   *   `status`, which `computeGroupedNodes` reads, so unbatched they re-run the
   *   `grouped → toolGroups → focusables` chain and the transcript's `<For>`
   *   diff once per node instead of once per run.
   */
  function settleRun(execId: string, ok = false): void {
    batch(() => {
      const isStaleThinking = (n: TranscriptNode): boolean =>
        n.kind === "thinking" && n.key.startsWith(`${execId}::`);
      if (state.nodes.some(isStaleThinking)) {
        setState(
          "nodes",
          state.nodes.filter((n) => !isStaleThinking(n)),
        );
        reindex();
        rebuildProseAccounting();
      }
      const erroredSubagents = new Set<number>();
      for (const n of state.nodes)
        if (n.key.startsWith(`${execId}::`) && n.kind === "error" && n.subagentOrder !== undefined)
          erroredSubagents.add(n.subagentOrder);
      state.nodes.forEach((n, i) => {
        if (!n.key.startsWith(`${execId}::`)) return;
        if (n.kind === "reasoning" && n.status === "running") {
          patch(i, (m) => {
            m.status = "ok";
            foldDefaults.set(m.key, true);
          });
        } else if (n.kind === "subagent" && n.status === "running") {
          patch(i, (m) => {
            const failed =
              !ok || (m.subagentOrder !== undefined && erroredSubagents.has(m.subagentOrder));
            m.status = failed ? "error" : "ok";
            if (!failed) foldDefaults.set(m.key, true);
          });
        } else if (n.kind === "tool_call" && n.status === "running") {
          patchKind(i, "tool_call", (m) => {
            m.status = ok ? "ok" : "error";
            m.liveOutput = undefined;
            foldDefaults.set(m.key, true);
          });
        } else if (n.kind === "assistant" && n.status === "running") {
          patch(i, (m) => {
            m.status = "ok";
          });
        }
      });
    });
  }

  function openRun(execId: string): TranscriptRunSink {
    const ns = (k: string): string => `${execId}::${k}`;
    const subagents = createSubagentRegistry();
    let plan: PlanActivity | null = null;
    let leadModel: string | undefined;
    const attrOf = (
      wid: string | undefined,
    ): { agentLabel?: string; subagentOrder?: number; subagentId?: string; model?: string } => {
      if (wid === undefined) return leadModel ? { model: leadModel } : {};
      const w = subagents.resolve(wid);
      return {
        agentLabel: w.title,
        subagentOrder: w.order,
        subagentId: wid,
        ...(w.model ? { model: w.model } : {}),
      };
    };
    /**
     * Drop tool nodes that never became more than a composing placeholder.
     *
     * @param inScope - which agent's placeholders to consider, by
     *   `subagentOrder` (`undefined` being the lead).
     *
     * @remarks `tool_input_delta` is emitted from the *provider stream*, so it
     *   fires for every visible tool call the model composes. The lifecycle that
     *   closes a tool node, though, is emitted by whichever *dispatcher* runs
     *   the call, and a missing terminal event must not leave a placeholder
     *   spinning forever. An in-flight model call is over by the time the next
     *   iteration starts, so a placeholder still carrying `inputChars` then is
     *   not a running tool call and saying so is a lie the elapsed timer keeps
     *   telling. Sub-agent/workflow orchestration is excluded before this
     *   fallback because its lifecycle belongs to the Sidebar/footer instead.
     *
     *   Scoped by agent because a sub-agent runs concurrently with the lead —
     *   an unscoped sweep on the lead's next iteration would delete a
     *   placeholder that is genuinely still being composed.
     */
    const dropComposing = (inScope: (order: number | undefined) => boolean): void => {
      const doomed: string[] = [];
      for (const n of state.nodes)
        if (
          n.key.startsWith(`${execId}::`) &&
          n.kind === "tool_call" &&
          n.inputChars !== undefined &&
          inScope(n.subagentOrder)
        )
          doomed.push(n.key);
      for (const key of doomed) remove(key);
    };
    const rememberModel = (wid: string | undefined, model: string | undefined): void => {
      if (!model) return;
      if (wid === undefined) {
        if (!leadModel) leadModel = model;
        return;
      }
      const w = subagents.resolve(wid);
      if (!w.model) w.model = model;
    };
    const closedIterations = new Set<string>();
    let annSeq = 0;
    let leadSteerSeq = 0;
    let attributedSteerSeq = 0;
    const pendingSteerKeys: { key: string; message: string }[] = [];
    const undeliveredSteerKeys = new Set<string>();
    const pendingElicitations: { key: string; question: string }[] = [];
    let runStartedAt: number | undefined;
    let leadInput = 0;
    let leadOutput = 0;
    let completed = false;
    const missingSubagentAttribution = (event: RunEvent): boolean =>
      "agent" in event && event.agent === "subagent" && event.subagent_id === undefined;
    const markSteerUndelivered = (key: string, message: string): void => {
      const steerIndex = indexOfKey.get(key);
      if (steerIndex === undefined) return;
      undeliveredSteerKeys.add(key);
      patchKind(steerIndex, "annotation", (node) => {
        node.status = "error";
        node.tone = "warn";
        node.text = steerUndeliveredNoticeText(message);
      });
    };

    const sink: TranscriptRunSink = {
      queueSteer(message) {
        if (completed) return { discard() {}, fail() {} };
        const key = ns(`steer:lead:${leadSteerSeq++}`);
        pendingSteerKeys.push({ key, message });
        upsert(key, () => ({
          kind: "annotation",
          status: "pending",
          tone: "accent",
          text: steerQueuedNoticeText(message),
        }));
        return {
          discard() {
            const pendingIndex = pendingSteerKeys.findIndex((entry) => entry.key === key);
            if (pendingIndex === -1) return;
            pendingSteerKeys.splice(pendingIndex, 1);
            remove(key);
          },
          fail() {
            const pendingIndex = pendingSteerKeys.findIndex((entry) => entry.key === key);
            if (pendingIndex !== -1) pendingSteerKeys.splice(pendingIndex, 1);
            markSteerUndelivered(key, message);
          },
        };
      },

      open(span, event, source) {
        if (completed || missingSubagentAttribution(event)) return;
        if (span.kind === "run" && event.type === "run_started") {
          runStartedAt = event.at;
          rememberModel(undefined, event.lead_model);
        } else if (span.kind === "tool" && event.type === "tool_call_started") {
          if (
            event.agent === "lead" &&
            isTranscriptExternalOrchestrationTool(event.server, event.tool)
          ) {
            remove(ns(span.span_id));
          } else {
            const index = upsert(ns(span.span_id), () => ({
              kind: "tool_call",
              status: "running",
              text: "",
              mcpName: event.server,
              toolName: event.tool,
              args: asArgs(event.arguments),
              startedAt: event.at,
              ...attrOf(event.subagent_id),
            }));
            // The node may already exist, created by `tool_input_delta` while the
            // model was still composing this call. `upsert` only runs its factory
            // when absent, so the authoritative fields have to be written here or
            // the placeholder's empty args would survive the real call.
            patchKind(index, "tool_call", (n) => {
              n.mcpName = event.server;
              n.toolName = event.tool;
              n.args = asArgs(event.arguments);
              n.status = "running";
              n.inputChars = undefined;
              n.inputStreamChars = undefined;
              n.inputComplete = undefined;
            });
          }
        } else if (span.kind === "subagent" && event.type === "delegation_created") {
          const subagent = subagents.resolve(event.delegation_id);
          subagent.title = event.title;
          const marker = boundTranscriptText(
            `Spawned sub-agent A${subagent.order + 1} · ${subagent.title}`,
          );
          upsert(ns(delegationLeadMarkerKey(event.delegation_id, "spawned")), () => ({
            kind: "annotation",
            status: "ok",
            tone: "accent",
            text: marker.text,
          }));
          upsert(ns(`subagent:${event.delegation_id}`), () => ({
            kind: "subagent",
            status: "running",
            text: event.task,
            title: event.title,
            ...attrOf(event.delegation_id),
          }));
        } else if (span.kind === "iteration" && event.type === "iteration_started") {
          const wid = event.agent === "subagent" ? event.subagent_id : undefined;
          rememberModel(wid, event.model);
          const order = attrOf(wid).subagentOrder;
          dropComposing((o) => o === order);
          upsert(ns(`${span.span_id}#thinking`), () => ({
            kind: "thinking",
            status: "running",
            text: "",
            ...attrOf(wid),
          }));
        }
        publisher.observe(execId, span, event, source);
      },

      point(span, event, source) {
        if (completed || missingSubagentAttribution(event)) return;
        if (span.kind === "iteration" && event.type === "text_delta" && event.channel === "text") {
          remove(ns(`${span.span_id}#retry`));
          metrics.count("store_text_delta");
          remove(ns(`${span.span_id}#thinking`));
          const index = upsert(ns(`${span.span_id}#msg`), () => ({
            kind: "assistant",
            status: "running",
            text: "",
            textEpoch: 0,
            ...attrOf(event.subagent_id),
          }));
          patch(index, (n) => {
            if (n.kind !== "assistant") return;
            const bounded = event.reset
              ? boundTranscriptText(event.text)
              : appendTranscriptText(n.text, event.text, n.textTruncated === true);
            if (event.reset) n.textEpoch = (n.textEpoch ?? 0) + 1;
            n.text = bounded.text;
            n.textTruncated = bounded.truncated ? true : undefined;
            n.proseReleased = undefined;
          });
        } else if (span.kind === "iteration" && event.type === "reasoning") {
          remove(ns(`${span.span_id}#retry`));
          remove(ns(`${span.span_id}#thinking`));
          const index = upsert(ns(`${span.span_id}#reasoning`), () => ({
            kind: "reasoning",
            status: "running",
            text: "",
            ...attrOf(event.subagent_id),
          }));
          patch(index, (n) => {
            const bounded = boundTranscriptText(event.text);
            n.text = bounded.text;
            if (n.kind === "reasoning") n.textTruncated = bounded.truncated ? true : undefined;
            if (closedIterations.has(span.span_id)) {
              n.status = "ok";
              foldDefaults.set(n.key, true);
            }
          });
        } else if (span.kind === "tool" && event.type === "tool_output_delta") {
          const index = indexOfKey.get(ns(span.span_id));
          if (index === undefined) return;
          metrics.count("store_tool_output_delta");
          patchKind(index, "tool_call", (n) => {
            if (n.status !== "running") return;
            n.liveOutput = appendLiveOutput(n.liveOutput, event.chunk);
          });
        } else if (span.kind === "tool" && event.type === "tool_input_delta") {
          // Unlike its output sibling this one `upsert`s rather than bailing on
          // a missing node: the call it describes has not started, so nothing
          // has created the node yet, and creating it here is the entire point.
          // Without it the model spends tens of seconds composing arguments
          // with no mark on screen at all.
          metrics.count("store_tool_input_delta");
          if (
            event.agent === "lead" &&
            isTranscriptExternalOrchestrationTool(event.tool, undefined)
          ) {
            remove(ns(span.span_id));
          } else {
            const index = upsert(ns(span.span_id), () => ({
              kind: "tool_call",
              status: "running",
              text: "",
              toolName: event.tool,
              startedAt: event.at,
              ...attrOf(event.subagent_id),
            }));
            patchKind(index, "tool_call", (n) => {
              if (n.status !== "running") return;
              n.inputChars = event.chars;
              n.inputStreamChars = event.stream_chars;
              if (event.complete === true) {
                n.inputComplete = true;
                n.status = "pending";
              }
            });
          }
        } else if (span.kind === "iteration" && event.type === "model_error") {
          const index = upsert(ns(`${span.span_id}#error`), () => ({
            kind: "error",
            status: "error",
            text: "",
          }));
          patch(index, (n) => {
            n.text = `${event.kind}: ${event.message}`;
            Object.assign(n, attrOf(event.subagent_id));
          });
        } else if (span.kind === "iteration" && event.type === "model_retry") {
          const order = attrOf(event.subagent_id).subagentOrder;
          dropComposing((candidate) => candidate === order);
          const index = upsert(ns(`${span.span_id}#retry`), () => ({
            kind: "annotation",
            status: "running",
            tone: "info",
            text: modelRetryText(event),
            ...attrOf(event.subagent_id),
          }));
          patchKind(index, "annotation", (node) => {
            node.status = "running";
            node.tone = "info";
            node.text = modelRetryText(event);
            Object.assign(node, attrOf(event.subagent_id));
          });
        } else if (
          event.type === "plan_created" ||
          event.type === "plan_updated" ||
          event.type === "plan_removed" ||
          event.type === "plan_review_requested" ||
          event.type === "plan_review_resolved"
        ) {
          plan = reducePlanProjection(plan, event);
          if (!plan) return;
          const index = upsert(ns("plan"), () => ({ kind: "plan", status: "running", text: "" }));
          patchKind(index, "plan", (n) => {
            n.revision = plan!.revision;
            n.planTitle = plan!.title;
            n.planStatus = plan!.status;
            n.planReview = plan!.reviewOutcome;
            n.planRemoved = plan!.removed;
            n.planDiscarded = isExpectedPlanDiscard(plan!);
            n.text = plan!.path ?? plan!.id;
            n.tasks = plan!.tasks;
            n.status = plan!.removed
              ? plan!.status === "completed"
                ? "ok"
                : "error"
              : plan!.status === "completed"
                ? "ok"
                : plan!.status === "failed" || plan!.status === "cancelled"
                  ? "error"
                  : "running";
          });
        } else if (event.type === "compaction_started") {
          const index = upsert(ns(`${span.span_id}#compaction-live`), () => ({
            kind: "annotation",
            status: "running",
            tone: "info",
            text: "compacting context…",
            ...attrOf(event.subagent_id),
          }));
          patchKind(index, "annotation", (node) => {
            node.status = "running";
            node.text = "compacting context…";
            Object.assign(node, attrOf(event.subagent_id));
          });
        } else if (event.type === "compaction") {
          remove(ns(`${span.span_id}#compaction-live`));
          upsert(ns(`${span.span_id}#compaction:${annSeq++}`), () => ({
            kind: "annotation",
            status: "ok",
            tone: "info",
            text: compactionNoticeText(event.operation, event.freed_chars, {
              requested: event.requested,
              userContributionCount: event.user_contribution_count,
              fallbackReason: event.fallback_reason,
            }),
            ...attrOf(event.subagent_id),
          }));
        } else if (event.type === "compaction_skipped") {
          remove(ns(`${span.span_id}#compaction-live`));
          upsert(ns(`${span.span_id}#compaction-skipped:${annSeq++}`), () => ({
            kind: "annotation",
            status: "error",
            tone: "warn",
            text: compactionSkippedNoticeText(event.reason),
            ...attrOf(event.subagent_id),
          }));
        } else if (event.type === "vision_analysis") {
          upsert(ns(`vision:${annSeq++}`), () => ({
            kind: "annotation",
            status: event.status === "completed" ? "ok" : "error",
            tone: event.status === "completed" ? "info" : "warn",
            text: visionNoticeText(event.model, event.image_count, event.status),
          }));
        } else if (event.type === "soft_limit_check") {
          upsert(ns(`soft:${annSeq++}`), () => ({
            kind: "annotation",
            status: "ok",
            tone: "warn",
            text: softLimitNoticeText(event.dimension, event.used, event.limit, event.outcome),
          }));
        } else if (event.type === "elicitation_requested") {
          const key = ns(`ask:${annSeq++}`);
          pendingElicitations.push({ key, question: event.question });
          upsert(key, () => ({
            kind: "annotation",
            status: "pending",
            tone: "info",
            text: `asked: ${event.question}`,
            ...attrOf(event.subagent_id),
          }));
        } else if (event.type === "elicitation_resolved") {
          const pendingIndex = pendingElicitations.findIndex(
            (candidate) => candidate.question === event.question,
          );
          const key =
            pendingIndex === -1
              ? ns(`ask:${annSeq++}`)
              : pendingElicitations.splice(pendingIndex, 1)[0]!.key;
          const index = upsert(key, () => ({
            kind: "annotation",
            status: "ok",
            tone: "info",
            text: elicitationOutcomeText(event),
            ...attrOf(event.subagent_id),
          }));
          patchKind(index, "annotation", (node) => {
            node.status = "ok";
            node.tone = "info";
            node.text = elicitationOutcomeText(event);
            Object.assign(node, attrOf(event.subagent_id));
          });
        } else if (event.type === "steering_applied") {
          const key =
            event.agent === "lead"
              ? (pendingSteerKeys.shift()?.key ?? ns(`steer:lead:${leadSteerSeq++}`))
              : ns(`steer:attributed:${attributedSteerSeq++}`);
          undeliveredSteerKeys.delete(key);
          const index = upsert(key, () => ({
            kind: "annotation",
            status: "ok",
            tone: "accent",
            text: steerNoticeText(event.message),
            ...attrOf(event.subagent_id),
          }));
          patchKind(index, "annotation", (node) => {
            node.status = "ok";
            node.tone = "accent";
            node.text = steerNoticeText(event.message);
            Object.assign(node, attrOf(event.subagent_id));
          });
        } else if (
          event.type === "capability_event" &&
          event.capability !== "delegation" &&
          event.capability !== "workflows"
        ) {
          const bounded = boundTranscriptText(
            `${event.capability}.${event.kind}: ${event.projection}${event.truncated ? " [detail shortened]" : ""}`,
          );
          upsert(ns(`capability:${annSeq++}`), () => ({
            kind: "annotation",
            status: "ok",
            tone: "info",
            text: bounded.text,
          }));
        } else if (event.type === "events_dropped") {
          upsert(ns(`events-dropped:${annSeq++}`), () => ({
            kind: "annotation",
            status: "error",
            tone: "warn",
            text: `${event.dropped} incremental live event${event.dropped === 1 ? " was" : "s were"} dropped; terminal tool results and assistant responses remain authoritative.`,
          }));
        }
        publisher.observe(execId, span, event, source);
      },

      close(span, event, source) {
        if (completed || missingSubagentAttribution(event)) return;
        if (
          span.kind === "subagent" &&
          (event.type === "delegation_completed" || event.type === "delegation_failed")
        ) {
          const subagent = subagents.resolve(event.delegation_id);
          const index = upsert(ns(`subagent:${event.delegation_id}`), () => ({
            kind: "subagent",
            status: "running",
            text: "",
            title: subagents.peek(event.delegation_id)?.title ?? "subagent",
            ...attrOf(event.delegation_id),
          }));
          patchKind(index, "subagent", (n) => {
            n.status = subagentCompletedOk(event.status) ? "ok" : "error";
            foldDefaults.set(n.key, n.status === "ok");
          });
          const succeeded = subagentCompletedOk(event.status);
          const marker = boundTranscriptText(
            `Sub-agent A${subagent.order + 1} ${succeeded ? "completed" : "failed"} · ${subagent.title}`,
          );
          upsert(ns(delegationLeadMarkerKey(event.delegation_id, "settled")), () => ({
            kind: "annotation",
            status: succeeded ? "ok" : "error",
            tone: succeeded ? "info" : "warn",
            text: marker.text,
          }));
        } else if (span.kind === "iteration") {
          if (event.type === "iteration_completed") {
            closedIterations.add(span.span_id);
            remove(ns(`${span.span_id}#retry`));
            remove(ns(`${span.span_id}#thinking`));
            const rIndex = indexOfKey.get(ns(`${span.span_id}#reasoning`));
            if (rIndex !== undefined)
              patch(rIndex, (n) => {
                n.status = "ok";
                foldDefaults.set(n.key, true);
              });
            const wid = event.agent === "subagent" ? event.subagent_id : undefined;
            rememberModel(wid, event.model);
            if (event.agent === "lead") {
              const tokens = iterationTokens(event);
              leadInput += tokens.input;
              leadOutput += tokens.output;
            }
            if (/\S/.test(event.response)) {
              const bounded = boundTranscriptText(event.response);
              const mIndex = upsert(ns(`${span.span_id}#msg`), () => ({
                kind: "assistant",
                status: "ok",
                text: bounded.text,
                ...(event.response_phase !== undefined
                  ? { assistantPhase: event.response_phase }
                  : {}),
                ...(bounded.truncated ? { textTruncated: true } : {}),
                textEpoch: 0,
                ...attrOf(wid),
              }));
              patch(mIndex, (n) => {
                if (n.kind !== "assistant") return;
                if (n.text !== bounded.text) n.textEpoch = (n.textEpoch ?? 0) + 1;
                n.text = bounded.text;
                n.assistantPhase = event.response_phase;
                n.textTruncated = bounded.truncated ? true : undefined;
                n.proseReleased = undefined;
                n.status = "ok";
                Object.assign(n, attrOf(wid));
              });
            } else {
              const mIndex = indexOfKey.get(ns(`${span.span_id}#msg`));
              if (mIndex !== undefined) patch(mIndex, (n) => (n.status = "ok"));
            }
          }
        } else if (
          span.kind === "tool" &&
          event.type === "tool_call" &&
          event.agent === "lead" &&
          isTranscriptExternalOrchestrationTool(event.server, event.tool)
        ) {
          remove(ns(span.span_id));
        } else if (span.kind === "tool" && event.type === "tool_call") {
          const index = upsert(ns(span.span_id), () => ({
            kind: "tool_call",
            status: "running",
            text: "",
            mcpName: event.server,
            toolName: event.tool,
            args: asArgs(event.arguments),
          }));
          const identity = toolIdentity(event.server, event.tool);
          const bashFailed =
            identity === "shell" &&
            !event.error &&
            (() => {
              const b = parseBash(event.result ?? "", null);
              return b.parsed && b.exitCode !== null && b.exitCode !== 0;
            })();
          patchKind(index, "tool_call", (n) => {
            n.mcpName = event.server;
            n.toolName = event.tool;
            n.args = asArgs(event.arguments);
            n.result = event.result;
            n.diff = event.diff;
            n.error = event.error;
            n.guard = event.guard;
            n.status = event.error ? "error" : "ok";
            n.liveOutput = undefined;
            n.inputChars = undefined;
            n.inputStreamChars = undefined;
            n.inputComplete = undefined;
            if (n.startedAt && typeof event.at === "number" && event.at >= n.startedAt)
              n.elapsedMs = event.at - n.startedAt;
            n.warn = bashFailed;
            n.dehydrated = undefined;
            n.hydrationNotice = undefined;
            const described = deps.describeToolCall?.({
              mcpName: event.server,
              toolName: event.tool,
              args: asArgs(event.arguments),
              ...(event.diff !== undefined ? { diff: event.diff } : {}),
            });
            if (described !== undefined) {
              n.signature = described.signature;
              n.mutation = described.mutation;
            }
            Object.assign(n, attrOf(event.subagent_id));
            foldDefaults.set(n.key, event.error ? true : !bashFailed);
          });
          noteHydrated(ns(span.span_id));
        } else if (span.kind === "run" && event.type === "run_ended") {
          dropComposing(() => true);
          // A queued steer is promoted only by a later `steering_applied`. The
          // run ending is the last moment one can arrive, so anything still
          // pending was accepted by the kernel and never delivered; left alone
          // it reads "Steer queued" for the rest of the session.
          for (const pendingSteer of pendingSteerKeys.splice(0)) {
            markSteerUndelivered(pendingSteer.key, pendingSteer.message);
          }
          const transientAnnotations = state.nodes
            .filter(
              (node) =>
                node.key.startsWith(`${execId}::`) &&
                node.kind === "annotation" &&
                (node.status === "running" || node.status === "pending"),
            )
            .map((node) => node.key);
          for (const key of transientAnnotations) remove(key);
          pendingElicitations.length = 0;
          const ok = event.status === "completed";
          // A rehydrated session is rebuilt from the persisted trace alone, and
          // `appendRunFailure` — the live path's error node — is a runtime
          // append that never reaches it. The trace does carry the failure's
          // code, so a restored run says why it ended rather than only that it
          // did.
          if (!ok && event.code !== undefined)
            appendRunFailure(execId, { code: event.code, message: event.reason ?? "run failed" });
          settleRun(execId, ok);
          const index = upsert(ns("run"), () => ({
            kind: "run",
            status: ok ? "ok" : "error",
            text: "",
          }));
          const elapsed =
            runStartedAt !== undefined && typeof event.at === "number"
              ? event.at - runStartedAt
              : undefined;
          let leadToolCalls = 0;
          for (const n of state.nodes)
            if (
              n.key.startsWith(`${execId}::`) &&
              n.kind === "tool_call" &&
              n.subagentOrder === undefined
            )
              leadToolCalls += 1;
          patchKind(index, "run", (n) => {
            n.reason = ok ? "done" : event.reason;
            n.status = ok ? "ok" : "error";
            n.disposition = ok ? event.disposition : undefined;
            if (elapsed !== undefined && elapsed >= 0) n.elapsedMs = elapsed;
            if (leadToolCalls > 0) n.toolCalls = leadToolCalls;
            if (leadInput > 0) n.inputTokens = leadInput;
            if (leadOutput > 0) n.outputTokens = leadOutput;
          });
        }
        publisher.observe(execId, span, event, source);
      },

      beginReconcile() {
        if (completed) return;
        publisher.beginReconcile(execId);
        replayed = { keys: [], seen: new Set() };
        leadInput = 0;
        leadOutput = 0;
        annSeq = 0;
        leadSteerSeq = 0;
        attributedSteerSeq = 0;
        pendingSteerKeys.length = 0;
        pendingElicitations.length = 0;
        closedIterations.clear();
        runStartedAt = undefined;
      },

      endReconcile() {
        if (completed) return;
        const pass = replayed;
        replayed = null;
        if (pass === null) {
          publisher.endReconcile(execId);
          return;
        }
        const prefix = `${execId}::`;
        const planKey = ns("plan");
        const liveOnlyKeys = new Set<string>([
          ...(plan !== null && indexOfKey.has(planKey) ? [planKey] : []),
          ...[...undeliveredSteerKeys].filter((key) => indexOfKey.has(key)),
        ]);
        if (liveOnlyKeys.size > 0) {
          // Plan capability events and a client-owned failed steering receipt
          // are intentionally live-only, so the stored trace cannot recreate
          // them. Merge each one back at its prior transcript position while
          // still pruning every other transient node absent from replay.
          const currentRunKeys = state.nodes
            .filter((node) => node.key.startsWith(prefix))
            .map((node) => node.key);
          for (let oldIndex = 0; oldIndex < currentRunKeys.length; oldIndex += 1) {
            const key = currentRunKeys[oldIndex]!;
            if (!liveOnlyKeys.has(key) || pass.seen.has(key)) continue;
            let insertionIndex = pass.keys.length;
            for (let i = oldIndex + 1; i < currentRunKeys.length; i += 1) {
              const nextIndex = pass.keys.indexOf(currentRunKeys[i]!);
              if (nextIndex !== -1) {
                insertionIndex = nextIndex;
                break;
              }
            }
            pass.keys.splice(insertionIndex, 0, key);
            pass.seen.add(key);
          }
        }
        const rank = new Map(pass.keys.map((k, i) => [k, i]));
        const survivors = state.nodes
          .filter((n) => n.key.startsWith(prefix) && rank.has(n.key))
          .sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
        let cursor = 0;
        const next: TranscriptNode[] = [];
        for (const n of state.nodes) {
          if (!n.key.startsWith(prefix)) next.push(n);
          else if (cursor < survivors.length) next.push(survivors[cursor++]!);
        }
        if (next.length === state.nodes.length && next.every((n, i) => n === state.nodes[i])) {
          rebuildProseAccounting();
          publisher.endReconcile(execId);
          return;
        }
        setState("nodes", next);
        const survivingKeys = new Set(next.map((node) => node.key));
        for (const key of foldDefaults.keys())
          if (!survivingKeys.has(key)) foldDefaults.delete(key);
        for (const key of [...hydratedTools]) if (!survivingKeys.has(key)) forgetHydrated(key);
        reindex();
        rebuildProseAccounting();
        publisher.endReconcile(execId);
      },

      complete(completion) {
        if (completed) return;
        completed = true;
        publisher.completeRun(execId, completion);
      },
    };
    return sink;
  }

  function committedPublicationKeys(): Set<string> {
    return new Set(
      publicationBatches().flatMap((publication) =>
        publication.phase === "committed" ? publication.nodes.map((node) => node.key) : [],
      ),
    );
  }

  function markPublicationReady(batchId: string): void {
    void batchId;
  }

  function clear(): void {
    setState("nodes", []);
    setPublicationBatches(Object.freeze([]));
    publisher.clear();
    foldedPrefixPublicationSequence = 0;
    indexOfKey.clear();
    foldDefaults.clear();
    hydratedTools.length = 0;
    hydratedToolBytesByKey.clear();
    hydratedToolBytes = 0;
    hydrationEpoch += 1;
    for (const queued of rehydrateQueue.splice(0)) {
      rehydrating.delete(queued.key);
      queued.cancel();
    }
    rehydrating.clear();
    proseBytesByKey.clear();
    proseOrder.length = 0;
    proseBytes = 0;
  }

  return {
    get nodes() {
      return state.nodes;
    },
    get publicationBatches() {
      return publicationBatches();
    },
    frontierNodes: () => {
      const committed = committedPublicationKeys();
      return state.nodes.filter((node) => !committed.has(node.key));
    },
    committedNodes: () =>
      publicationBatches().flatMap((publication) =>
        publication.phase === "committed" ? publication.nodes : [],
      ),
    markPublicationReady,
    memory: () => ({
      transcript_nodes: state.nodes.length,
      transcript_prose_bytes: proseBytes,
      publication_batches: publicationBatches().length,
      publication_known_keys: publisher.knownKeyCount(),
      hydrated_tool_nodes: hydratedTools.length,
      hydrated_tool_bytes: hydratedToolBytes,
      active_rehydrates: activeRehydrates,
      queued_rehydrates: rehydrateQueue.length,
    }),
    defaultFolded: (key) => foldDefaults.get(key) ?? false,
    appendUserMessage,
    foldPrefixBefore,
    appendNotice,
    appendRunFailure,
    beginLocalBash,
    settleRun,
    openRun,
    clear,
    rehydrate,
  };
}
