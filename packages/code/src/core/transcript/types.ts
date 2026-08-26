import type { CommandGuardReview } from "@clarvis/protocol";

/** Minimal plan-task activity embedded on semantic plan nodes. */
export interface TranscriptPlanTask {
  id: string;
  title: string;
  status: string;
  description?: string;
  exit_condition?: string;
  assignee?: string;
  result?: string;
  error?: string;
  reason?: string;
}

/** Runtime status shared by semantic transcript variants. */
export type NodeStatus = "running" | "ok" | "error" | "pending";

/** Attribution and identity shared by every semantic node. */
interface TranscriptNodeBase {
  key: string;
  status: NodeStatus;
  agentLabel?: string;
  subagentOrder?: number;
  subagentId?: string;
  model?: string;
  startedAt?: number;
  elapsedMs?: number;
}

/** User, assistant, and reasoning prose. */
export interface TranscriptMessageNode extends TranscriptNodeBase {
  kind: "user" | "assistant" | "reasoning" | "thinking";
  text: string;
  /** Provider-declared lifecycle phase for assistant prose. */
  assistantPhase?: "commentary" | "final_answer";
  /** Persisted run that can restore this prose after the live TUI releases it. */
  sourceExecutionId?: string;
  /** Digest of displayed user prose, used to reject a mismatched persisted prompt during export. */
  sourceTextFingerprint?: string;
  /** The retained text was shortened at an ingest/display boundary. */
  textTruncated?: true;
  /**
   * Resident prose was released and may be restored from persistence.
   *
   * @remarks This is distinct from truncation. Some store projections also
   * carry `textTruncated` for legacy accounting; presenters must prefer this
   * state and its explicit recovery route.
   */
  proseReleased?: true;
  /** Changes when a cumulative stream is replaced rather than appended. */
  textEpoch?: number;
}

/** Tool invocation and its current semantic result. */
export interface TranscriptToolNode extends TranscriptNodeBase {
  kind: "tool_call";
  text: string;
  mcpName?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  diff?: string;
  error?: string | null;
  warn?: boolean;
  /** Final command-guard verdict, retained across live display and replay. */
  guard?: CommandGuardReview;
  liveOutput?: string;
  /**
   * Size, in characters, of the argument payload the model has streamed so far
   * for a call it is still composing.
   *
   * @remarks Present only between the first `tool_input_delta` and
   * `tool_call_started`, which is the window in which this node exists but its
   * `args` do not. Cleared when the real arguments arrive, so the two are never
   * shown at once. Its whole purpose is that this window is long — tens of
   * seconds on a large edit — and used to have nothing on screen at all.
   */
  inputChars?: number;
  /**
   * Set once this node's `args`/`result`/`diff` have been dropped to bound the
   * transcript's memory, and refilled on demand when the block is expanded.
   *
   * @remarks Read only by the block that renders this node — never by the
   *   grouping/focus memos. Those derive from `key`/`kind`/`status` alone, and
   *   that is what keeps dehydrating an old block from re-running an O(n) pass
   *   over the whole transcript.
   */
  dehydrated?: true;
  /** Why an explicitly requested persisted body could not be made resident. */
  hydrationNotice?: string;
  /**
   * The call's rendered signature, kept resident so a dehydrated block still
   * identifies itself.
   *
   * @remarks A tool block's *collapsed* header is derived from `args` — the file
   *   path or command that says which call this is — and so is the Markdown
   *   export. Dropping `args` without this left a scrolled-back transcript
   *   showing a column of bare tool names, repaired only by expanding each one.
   *   This is tens of bytes against the tens of kilobytes the window exists to
   *   reclaim, so retaining it costs nothing that matters.
   */
  signature?: string;
  /** The mutation chip's counts, kept resident for the same reason as {@link signature}. */
  mutation?: { added: number; removed: number; lines: number } | null;
}

/** Run separator and aggregate usage. */
export interface TranscriptRunNode extends TranscriptNodeBase {
  kind: "run";
  text: string;
  reason?: string;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Delegated sub-agent activity card. */
export interface TranscriptSubagentNode extends TranscriptNodeBase {
  kind: "subagent";
  text: string;
  title?: string;
  reason?: string;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** File-backed execution plan activity. */
export interface TranscriptPlanNode extends TranscriptNodeBase {
  kind: "plan";
  text: string;
  planTitle?: string;
  planStatus?: string;
  planReview?: string;
  /** The provider record disappeared; the projected tasks are historical only. */
  planRemoved?: boolean;
  /** The record was intentionally deleted after success by its retention policy. */
  planDiscarded?: boolean;
  tasks?: TranscriptPlanTask[];
  revision?: number;
}

/** Semantic annotation projected from a run event. */
export interface TranscriptAnnotationNode extends TranscriptNodeBase {
  kind: "annotation";
  text: string;
  tone?: "info" | "warn" | "accent";
}

/** Explicit model/tool/run error block. */
export interface TranscriptErrorNode extends TranscriptNodeBase {
  kind: "error";
  text: string;
  error?: string | null;
}

/** Discriminated semantic transcript projection. */
export type TranscriptNode =
  | TranscriptMessageNode
  | TranscriptToolNode
  | TranscriptRunNode
  | TranscriptSubagentNode
  | TranscriptPlanNode
  | TranscriptAnnotationNode
  | TranscriptErrorNode;
