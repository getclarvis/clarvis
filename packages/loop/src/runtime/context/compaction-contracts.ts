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
  /** Append a non-evictable runtime note, replacing any earlier note of the same kind. */
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
   * Install (or replace) the single canonical, non-evictable state block — the
   * pinned canonical-state context the model reads each iteration.
   */
  setCanonicalState(content: string): void;
  /**
   * Install (or update) a non-evictable block, one live block per `kind`.
   *
   * @param kind - the block's identity; one live block per kind.
   * @remarks The counterpart to {@link setCanonicalState} for content that is
   *   large but rarely changes. Re-supplying identical content is a no-op down to
   *   object identity — that guard is what produces the 94–99% cache-hit
   *   iterations of a run whose canonical state is not changing, and it must stay.
   *   Changed content is **appended, never edited and never moved**: the new
   *   block goes on top of the durable stack and the superseded entry stays
   *   exactly where it is, byte for byte. It only hands over its `blockKind` (so
   *   the next lookup finds the newest) and becomes evictable (so compaction can
   *   reclaim it under pressure). Neither field is rendered, so the whole prefix
   *   ahead of the new block survives untouched. Counts as stable for
   *   {@link cacheBreakpoints}.
   *
   *   Appending rather than rewriting in place is the whole point, and the
   *   reasoning here used to be exactly inverted. An in-place rewrite keeps every
   *   *index* intact but changes the *bytes* at the block's position, so an
   *   implicit prefix cache — OpenAI, DeepSeek, every OpenRouter upstream —
   *   re-charges everything behind it on **every** change. Measured: a 7.4 KB
   *   block pinned at 32% of a 140k-token transcript cost ~97,000 uncached tokens
   *   per revision, 2,929,430 tokens across one session, 35.7% of all its
   *   uncached input. Removing the old entry instead of leaving it would be
   *   better than that but still not free — a removal shifts every entry behind
   *   it, which costs the prefix from the old position. An append costs nothing.
   *
   *   The price is that superseded blocks accumulate in the transcript, so a
   *   block's content must say that the newest one wins. They are cached, hence
   *   ~1/120th the price of fresh tokens on a provider like DeepSeek, and marking
   *   them evictable keeps the growth self-limiting.
   *
   *   This is not provider-specific and must not be gated on provider kind. An
   *   Anthropic `cache_control` breakpoint marks where a prefix is *written*; a
   *   *read* still requires the prefix up to it to be byte-identical. And since
   *   {@link isVolatile} is false for a block entry, `lastStableIndex` scans past
   *   it and {@link cacheBreakpoints} only ever returns positions **after** the
   *   block — never one before it that an in-place rewrite could protect.
   *
   *   A first install lands ahead of the trailing volatile run, not at the
   *   absolute end. Appending it after a runtime note would leave the largest
   *   block in the transcript sitting behind an entry that is spliced out next
   *   iteration — written once at full price and read back zero times.
   */
  setStableBlock(kind: string, content: string): void;
  /**
   * The two positions worth a provider prompt-cache breakpoint.
   *
   * @returns `stable`, the index in `messages` of the last entry that survives
   *   unchanged into the next request, and `prior`, the index that carried the
   *   breakpoint in the previous request; either is `-1` when absent.
   * @remarks A provider caches a prefix only where a breakpoint was set, and
   *   reads it back only while that prefix is still a prefix of the new request.
   *   {@link setCanonicalState} and {@link appendRuntimeNote} rewrite the tail
   *   every iteration, so a breakpoint on the last message would be written and
   *   never read; `stable` stops before those volatile entries, and before
   *   system-role entries too, since a provider adapter may lift them out of the
   *   message array.
   *
   *   What makes this sound is that the scan stops at the *first* volatile entry
   *   rather than merely skipping volatile candidates: it is the whole prefix
   *   that has to survive, so one repositioned entry anywhere before the
   *   breakpoint invalidates it. Durable entries are inserted ahead of the
   *   trailing volatile run precisely so that first volatile entry is always at
   *   the end, and the usable prefix is therefore the whole conversation.
   *   `prior` walks back over the newest tool run and its owning assistant turn
   *   to land on the position `stable` held one iteration ago — exact at any
   *   tool-batch width, where a fixed content-block offset would fall outside
   *   the provider's backwards search window.
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
