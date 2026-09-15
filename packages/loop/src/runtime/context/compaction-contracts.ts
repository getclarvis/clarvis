import type {
  AssistantReasoningPart,
  AssistantTextPart,
  AgentRole,
  CompactionDetail,
  ContextSnapshotEntry,
  LiveMessage,
  Logger,
  MessageContent,
  ToolCallRef,
  ToolResultImage,
} from "@clarvis/capability";
/**
 * The tuning that governs when and how a {@link LiveContext} sheds tokens.
 *
 * @remarks Compaction fires once the estimated context crosses the high-water
 *   mark (`windowTokens * fraction`) and evicts/summarizes down toward the
 *   low-water mark (`windowTokens * targetFraction`). `maxResultChars` caps a
 *   single tool result before it even enters the transcript;
 *   `preserveRecentTokens` is the token budget of the newest evictable entries
 *   held back from ordinary eviction; `llmTimeoutMs` bounds an LLM summarization
 *   pass (see {@link CompactionConfig} consumers in `./llm-compaction`).
 */
export interface CompactionConfig {
  enabled: boolean;
  windowTokens: number;
  fraction: number;
  targetFraction: number;
  maxResultChars: number;
  preserveRecentTokens: number;
  llmTimeoutMs?: number;
}

/** Whether compaction follows automatic watermarks or an explicit user request. */
export type CompactionMode = "scheduled" | "forced";

/**
 * Identifies which agent loop a compaction event belongs to, so every
 * {@link CompactionEvent} the context emits can be attributed to a lead or a
 * specific subagent instance.
 */
export interface CompactionScope {
  agent: AgentRole;
  subagent_instance_id?: string;
  /**
   * The agent-bound logger the context reports `context.prefix_break` on.
   *
   * @remarks Optional because a {@link CompactionScope} is a plain literal in
   *   well over a hundred tests and the two production call sites are the only
   *   ones that can supply one; `createLiveContext` normalizes it to
   *   `NOOP_LOGGER` exactly once, so no site downstream optional-chains. It
   *   rides the scope rather than a fourth parameter because the scope already
   *   carries `agent`/`subagent_instance_id` — the same correlation the log line
   *   needs — so binding it here costs nothing.
   */
  logger?: Logger;
}

/** A compaction trace detail ({@link CompactionDetail}) stamped with its scope. */
export type CompactionEvent = CompactionDetail;

/**
 * The result of {@link LiveContext.appendToolMessage}: whether the result was
 * truncated to fit `maxResultChars`, the untruncated `fullText` (so the caller
 * may still trace or persist the original), and the truncation `event` when one
 * occurred.
 */
export interface AppendToolResultOutcome {
  truncated: boolean;
  fullText: string;
  event?: CompactionEvent;
}

/**
 * A contiguous-by-selection run of evictable messages chosen for LLM
 * summarization: their `indices` into the live entry list and the `messages`
 * themselves, paired so {@link LiveContext.replaceSpanWithSummary} can swap them
 * out by index after the summary is produced.
 */
export interface SummarizableSpan {
  indices: number[];
  messages: LiveMessage[];
}

/**
 * The mutable message window one agent loop appends to and the compaction logic
 * prunes: the ordered transcript plus every operation that grows, protects, or
 * shrinks it.
 *
 * @remarks Entries are classified internally as evictable (tool results),
 *   non-evictable (assistant/user turns, runtime notes), canonical (the pinned
 *   canonical-state block), or summary (a compaction placeholder). `messages` is a
 *   live view kept in sync with the backing entries; callers read it but must
 *   mutate only through the methods here.
 */
export interface LiveContext {
  /** Live, kept-in-sync view of the current transcript in order. */
  readonly messages: LiveMessage[];
  /** Append a non-evictable assistant turn carrying only text. */
  appendAssistant(
    content: string,
    reasoning?: AssistantReasoningPart[],
    textParts?: AssistantTextPart[],
  ): void;
  /**
   * Append a non-evictable assistant turn; includes `toolCalls` when non-empty,
   * otherwise degrades to a plain text turn.
   */
  appendAssistantToolCalls(
    content: string,
    toolCalls: ToolCallRef[],
    reasoning?: AssistantReasoningPart[],
    textParts?: AssistantTextPart[],
  ): void;
  /** Append a non-evictable user turn. */
  appendUser(content: MessageContent): void;
  /** Append a non-evictable user-role note. */
  appendNote(content: string): void;
  /**
   * Append a new observation of this runtime-note kind. Prior observations retain their
   * message content and position and become superseded, evictable history.
   */
  appendRuntimeNote(kind: string, content: string): void;
  /**
   * Append an evictable tool result, truncating its middle to `maxResultChars`
   * (head + tail kept, with a marker) when it exceeds the cap.
   *
   * @param toolCallId - the call this result answers.
   * @param opts.taskId - optional delegated-task attribution carried on the entry.
   * @param opts.images - optional image parts attached to the result.
   * @param opts.spillPath - where the caller persisted the untruncated text, named
   *   in the truncation marker so the model can read back what was cut. Resolved
   *   by the caller, never by this module: a {@link LiveContext} performs no I/O.
   * @returns the {@link AppendToolResultOutcome} describing any truncation.
   */
  appendToolMessage(
    toolCallId: string,
    content: string,
    opts?: { taskId?: string; images?: ToolResultImage[]; spillPath?: string },
  ): AppendToolResultOutcome;
  /**
   * Evict the oldest eligible results, collapsing them into a single marker.
   *
   * @param opts.mode - `scheduled` follows the high/low watermarks; `forced`
   *   selects every eligible result while retaining the protected recent tail.
   * @returns the eviction {@link CompactionEvent}, or `undefined` when selection
   *   found nothing eligible.
   */
  compact(opts?: { mode?: CompactionMode }): CompactionEvent | undefined;
  /** Whether scheduled {@link compact} would drop anything right now. */
  needsCompaction(): boolean;
  /**
   * Last-resort eviction ignoring the `preserveRecent` protection: drop
   * evictable entries (never a non-summary user turn) toward twice the
   * low-water mark to make room when normal compaction cannot.
   *
   * @returns the eviction {@link CompactionEvent}, or `undefined` when nothing
   *   is eligible.
   */
  forceEvictOldest(): CompactionEvent | undefined;
  /**
   * Append a current-state reminder, including an unchanged recurring reminder.
   * The latest publication remains pinned; previous publications stay historical.
   */
  setCanonicalState(content: string): void;
  /**
   * Keep unchanged content at its original position. Append changed content after
   * all retained history and make the prior publication evictable and superseded.
   */
  setStableBlock(kind: string, content: string): void;
  /**
   * Return the last retained non-system entry and the position preceding the newest
   * assistant/tool batch. Historical reminders are stable entries. Provider adapters
   * apply their existing explicit-breakpoint policy where supported.
   */
  cacheBreakpoints(): { stable: number; prior: number };
  /**
   * Choose the oldest evictable span (excluding existing summaries) to hand to
   * an LLM summarizer. Scheduled mode observes the watermarks; forced mode
   * selects every eligible entry outside the protected recent tail.
   */
  selectSummarizableSpan(opts?: { mode?: CompactionMode }): SummarizableSpan | undefined;
  /**
   * The body of the durable rolling-summary anchor — its text without
   * {@link SUMMARY_ANCHOR_PREFIX} — or `undefined` when nothing has been
   * summarized yet.
   *
   * @remarks Read by the summarizer, so the next pass *merges* into this text
   *   rather than discarding it, and by the growth test that decides whether the
   *   merged anchor is worth adopting.
   */
  summaryAnchor(): string | undefined;
  /**
   * Drop the entries at `indices` and fold `summary` into the run's single
   * rolling-summary anchor, creating it in the oldest dropped entry's place or
   * rewriting it where it already stands.
   *
   * @param indices - the span to drop, from {@link selectSummarizableSpan}.
   * @param summary - the complete merged summary text.
   * @returns the summarization {@link CompactionEvent}.
   * @remarks One anchor per agent, updated in place, rather than one evictable
   *   placeholder per summarized span: a per-span summary was itself evictable,
   *   so the run could pay for an LLM call and then discard the result before the
   *   material that motivated it. The anchor is non-evictable, which is also why
   *   its growth is bounded by the caller before adoption.
   *
   *   It stays where it was first installed because that is where the turns it
   *   replaces stood — chronological order, not cache economics. Moving it
   *   forward would not help a provider's prompt cache either: the entries it
   *   left behind changed anyway, so the invalidation boundary is the same.
   *
   *   The update branch rewrites the anchor's message and `chars` in place and
   *   does *not* adjust the running total by hand, unlike
   *   {@link LiveContext.setStableBlock}: it is followed by a rebuild that
   *   recomputes the total from every entry. Making that rebuild incremental
   *   would silently corrupt the total unless this site pays the debt itself.
   */
  replaceSpanWithSummary(indices: number[], summary: string): CompactionEvent;
  /**
   * Estimate the context's token count, anchored to the last observed real
   * usage when available (see {@link observeUsage}).
   */
  estimateTokens(): number;
  /**
   * Record a provider-reported input-token count, anchoring future
   * {@link estimateTokens} estimates to the current char count so drift from the
   * naive chars/4 heuristic is corrected. Non-finite/non-positive values are
   * ignored.
   */
  observeUsage(inputTokens: number): void;
  /**
   * Serialize the transcript (excluding system messages) to
   * {@link ContextSnapshotEntry}s for persistence/rehydration, preserving the
   * evictable/summary/canonical flags and task attribution.
   */
  snapshot(): ContextSnapshotEntry[];
}

/** A seed item for {@link createLiveContext}: either a raw message or a
 * previously persisted {@link ContextSnapshotEntry} carrying its flags. */
export type LiveSeedEntry = LiveMessage | ContextSnapshotEntry;
