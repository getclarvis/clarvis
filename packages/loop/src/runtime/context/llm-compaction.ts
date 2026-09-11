import type { CompactionContribution, LiveMessage, Logger } from "@clarvis/capability";
import { sanitizeErrorMessage } from "@clarvis/capability";
import type { LLMProvider, LLMUsage, ResolvedProviderConfig } from "@clarvis/capability";
import type { CompactionEvent, LiveContext } from "./compaction-contracts.ts";
import type { CompactionMode } from "./compaction-contracts.ts";
import { liveMessageChars, SUMMARY_ANCHOR_PREFIX } from "./compaction-policy.ts";
import { COMPACTION_UPDATE_INSTRUCTION } from "./compaction-prompt.ts";
import type { TokenLedger } from "../budget/budget.ts";
import type { TokenAccumulator } from "@clarvis/capability";
import { contentToText } from "@clarvis/capability";
import { addUsage } from "../usage.ts";
import { errorText } from "../../error-text.ts";

/**
 * A stable reference block prepended to the summarizer's system prompt so the
 * summary stays grounded (e.g. the agent's task): a `label` and its `body`.
 */
export interface CompactionAnchor {
  label: string;
  body: string;
}

/** Inputs for {@link summarizeContext}: the model/provider to call, an optional
 * abort `signal` and `timeoutMs`, the summarization `prompt`, an optional
 * {@link CompactionAnchor}, the existing rolling summary to merge into, the
 * output cap, and the `span` of messages to compress. */
export interface SummarizeContextArgs {
  llm: LLMProvider;
  model: string;
  provider: string;
  providerConfig?: ResolvedProviderConfig;
  signal?: AbortSignal;
  timeoutMs?: number;
  prompt: string;
  /**
   * Requests from other parties, folded into the prompt for this pass only.
   *
   * @remarks Separate from `prompt` by design: the base is the agent profile's
   *   and a contribution is only ever added to it. See
   *   {@link buildCompactionMessages}.
   */
  contributions?: readonly CompactionContribution[];
  anchor?: CompactionAnchor;
  /** The current rolling summary, when one exists, for the summarizer to update. */
  priorSummary?: string;
  /**
   * Hard cap on the summary's length.
   *
   * @remarks The anchor is non-evictable, so it is a permanent floor under the
   *   context; without a cap here an unbounded summary becomes an unbounded
   *   floor. The adapter honours this verbatim because summarization requests no
   *   reasoning effort, so no thinking floor is applied on top.
   */
  maxOutputTokens?: number;
  span: LiveMessage[];
}

/** The summarizer's output: the summary `text` and the `usage` the call cost. */
export interface SummarizeContextResult {
  text: string;
  usage: LLMUsage;
}

/**
 * Render one message to the plain-text form fed to the summarizer, labeling it
 * by role and, for an assistant turn, appending its tool calls as
 * `name(args)`.
 */
function renderMessage(m: LiveMessage): string {
  if (m.role === "tool") return `Tool result:\n${m.content}`;
  if (m.role === "assistant") {
    const text = contentToText(m.content);
    const calls =
      "tool_calls" in m && m.tool_calls.length > 0
        ? `\n[called: ${m.tool_calls.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join(", ")}]`
        : "";
    return `Assistant:${text ? ` ${text}` : ""}${calls}`;
  }
  const role = m.role === "system" ? "System" : "User";
  return `${role}: ${contentToText(m.content)}`;
}

/** Render a span of messages to the blank-line-separated transcript the
 * summarizer receives as its user turn. */
export function renderSpan(span: LiveMessage[]): string {
  return span.map(renderMessage).join("\n\n");
}

/**
 * Longest single contribution folded into a compaction prompt.
 *
 * @remarks Matches the bound the hooks runner already applies to any text a hook
 *   authors, so a hook contribution arrives pre-clamped and this only binds for a
 *   contribution from another source.
 */
export const CONTRIBUTION_MAX_CHARS = 4_000;

/**
 * Longest the whole contributions block may grow to.
 *
 * @remarks The summarizer's output cap is derived from the model window, so an
 *   unbounded instruction block eats the input budget the transcript being
 *   compacted needs. Higher-precedence contributions are selected first, then
 *   restored to prompt order; the count actually applied is reported on the
 *   {@link CompactionEvent}, so a dropped one is visible rather than assumed.
 */
export const CONTRIBUTIONS_BLOCK_MAX_CHARS = 12_000;

/** Header introducing the contributions block, stating its additive nature to the summarizer. */
const CONTRIBUTIONS_HEADER =
  "Additional instructions for this compaction. They ADD to the instructions above and do not " +
  "replace any of them; where one is silent, the instructions above still govern.";

/**
 * Select the contributions that fit the block budget, clamping each.
 *
 * @param contributions - the offered contributions, in precedence order.
 * @returns the texts to render, in the order given, and never more than
 *   {@link CONTRIBUTIONS_BLOCK_MAX_CHARS} in total.
 * @remarks Order is preserved rather than sorted: the caller supplies it, and it
 *   is meaningful — hooks arrive in settings-merge order (operator before
 *   plugin) and a user's own request sorts last, closest to the transcript.
 *   When the block is oversubscribed, selection reserves room from that
 *   highest-precedence end before restoring this render order.
 *
 *   A non-string `text` is skipped rather than trusted. `LifecycleHook` is a
 *   public port, so a host capability can hand back anything; throwing here
 *   would abort a compaction the context needs, for a contribution it could
 *   simply have gone without.
 */
export function applicableContributions(
  contributions: readonly CompactionContribution[],
): string[] {
  return applicableContributionEntries(contributions).map((contribution) => contribution.text);
}

/**
 * Select normalized contributions by precedence, then restore prompt order.
 *
 * @remarks Contributions arrive least-specific first. Selecting from the end
 * reserves the bounded block for the user's last, highest-precedence request
 * before lower-precedence hook text, while restoring the original order keeps
 * the highest-precedence instruction closest to the transcript.
 */
function applicableContributionEntries(
  contributions: readonly CompactionContribution[],
): CompactionContribution[] {
  const normalized: CompactionContribution[] = [];
  for (const contribution of contributions) {
    if (typeof contribution?.text !== "string") continue;
    const text = contribution.text.trim().slice(0, CONTRIBUTION_MAX_CHARS);
    if (text !== "") normalized.push({ source: contribution.source, text });
  }

  const selected: CompactionContribution[] = [];
  let used = 0;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const contribution = normalized[index]!;
    if (used + contribution.text.length > CONTRIBUTIONS_BLOCK_MAX_CHARS) continue;
    used += contribution.text.length;
    selected.push(contribution);
  }
  return selected.reverse();
}

/**
 * Assemble the two-message conversation for a summarization call: a system turn
 * carrying the `prompt`, any {@link CompactionContribution}s, an optional
 * {@link CompactionAnchor} and an optional update instruction with the rolling
 * summary so far, and a user turn carrying the rendered `span` to compact.
 *
 * @remarks
 * `prompt` is the base the agent's profile resolved and is always emitted first,
 * whole. **A contribution is appended to it and can never replace it** — they
 * arrive as separate arguments, so there is no path by which one could.
 *
 * The contributions block sits with the *instructions* rather than with the
 * *material*: the anchor is grounding and the prior summary is a thing to be
 * merged, whereas a contribution is an instruction, so it belongs beside the
 * prompt it extends. Placing it after the prior summary would separate an
 * instruction from the instructions by a multi-kilobyte blob.
 *
 * The anchor block precedes the prior summary on purpose — the anchor is the
 * grounding (a capability's anchor, or the sub-agent's task) and the prior
 * summary is material to be merged, so the model reads what the run is *for*
 * before what it already knows.
 */
export function buildCompactionMessages(args: {
  prompt: string;
  contributions?: readonly CompactionContribution[];
  anchor?: CompactionAnchor;
  priorSummary?: string;
  span: LiveMessage[];
}): LiveMessage[] {
  const texts = applicableContributions(args.contributions ?? []);
  const contributionsBlock =
    texts.length > 0 ? `\n\n${CONTRIBUTIONS_HEADER}\n\n${texts.join("\n\n")}` : "";
  const anchorBlock = args.anchor ? `\n\n${args.anchor.label}:\n${args.anchor.body}` : "";
  const updateBlock =
    args.priorSummary !== undefined
      ? `\n\n${COMPACTION_UPDATE_INSTRUCTION}\n\nSummary so far:\n${args.priorSummary}`
      : "";
  return [
    {
      role: "system",
      content: `${args.prompt}${contributionsBlock}${anchorBlock}${updateBlock}`,
    },
    { role: "user", content: `Transcript to compact:\n\n${renderSpan(args.span)}` },
  ];
}

/**
 * Call the model to summarize a span of transcript.
 *
 * @param args - see {@link SummarizeContextArgs}.
 * @returns the trimmed summary and its usage; see {@link SummarizeContextResult}.
 * @throws Error when the model returns empty text, or a summary the provider cut
 *   off at `maxOutputTokens`.
 * @remarks Reasoning is explicitly **off**, not merely unrequested. Leaving it
 *   unset lets a reasoning model apply its own default effort, and on the OpenAI
 *   family those thinking tokens are charged against the same output cap this
 *   call now sends — so the whole budget could be spent thinking, the text come
 *   back empty, and every compaction be billed and then discarded. Summarizing
 *   is a mechanical text transformation; it wants none of that budget. The two
 *   subscription kinds are the exception: their entitled catalogs may publish
 *   reasoning-only levels without `none`, so sending Clarvis's `off` value would
 *   make a valid subscription reject the internal summarizer call. Omitting the
 *   override there delegates to the provider's supported default instead.
 *
 *   A `finishReason` of `"length"` is refused rather than adopted. The caller
 *   replaces the rolling anchor *in place* and there is no other copy, so a
 *   severed merge would permanently lose the tail of the previous summary and
 *   become the corrupted base for every pass after it. Worse, the growth test
 *   downstream gets *easier* to pass the more severely the text was cut, so
 *   nothing else in the path would catch it. Throwing here lands on
 *   {@link runCompaction}'s existing fallback: the span is evicted and the old
 *   anchor survives intact.
 */
export async function summarizeContext(
  args: SummarizeContextArgs,
): Promise<SummarizeContextResult> {
  const result = await args.llm.call({
    callPurpose: "compaction",
    model: args.model,
    provider: args.provider,
    ...(args.providerConfig ? { providerConfig: args.providerConfig } : {}),
    messages: buildCompactionMessages({
      prompt: args.prompt,
      ...(args.contributions !== undefined ? { contributions: args.contributions } : {}),
      anchor: args.anchor,
      ...(args.priorSummary !== undefined ? { priorSummary: args.priorSummary } : {}),
      span: args.span,
    }),
    tools: [],
    ...(args.providerConfig?.kind === "openai-codex" || args.providerConfig?.kind === "xai-grok"
      ? {}
      : { reasoningEffort: "off" as const }),
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
  });
  const text = (result.text ?? "").trim();
  if (text.length === 0) {
    throw new Error("compaction summary was empty");
  }
  if (result.finishReason === "length") {
    throw new Error("compaction summary was truncated at maxOutputTokens");
  }
  return { text, usage: result.usage };
}

/**
 * The output cap for a summarization call: ~2% of the agent's context window,
 * never below 1024 tokens and never above 4096.
 *
 * @param windowTokens - the agent's context window; `0` or non-finite yields the floor.
 * @returns the `maxOutputTokens` to send with the summarization call.
 * @remarks Explicit rather than inherited from the agent's own output budget,
 *   which on a reasoning model can be tens of thousands of tokens. The rolling
 *   anchor is non-evictable, so this number is the ceiling on how far the
 *   permanent floor under the context can grow — it has to be bounded here
 *   rather than discovered later.
 */
export function compactionOutputTokens(windowTokens: number): number {
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) return 1_024;
  return Math.min(4_096, Math.max(1_024, Math.round(windowTokens * 0.02)));
}

/**
 * The largest a rolling anchor may become before adoption is refused.
 *
 * @param windowTokens - the agent's context window; `0` disables the ceiling.
 * @returns the anchor's character ceiling.
 * @remarks {@link compactionOutputTokens}' 1024-token floor exceeds some windows
 *   outright, and the anchor is reachable by neither {@link LiveContext.compact}
 *   nor {@link LiveContext.forceEvictOldest} — both filter on `evictable`. An
 *   oversized anchor would therefore pin the context permanently above its own
 *   high-water mark with nothing left to shed. Refusing it up front is the only
 *   point at which that is still recoverable; a quarter of the window is where
 *   the anchor stops being a saving and mechanical eviction is simply better.
 *
 *   Comparing the two in one unit: the ceiling is `windowTokens` **chars**,
 *   while the cap {@link compactionOutputTokens} allows is roughly
 *   `4 * clamp(round(0.02 * windowTokens), 1024, 4096)` chars. Those cross only
 *   below a window of about 4096 tokens, where the cap's 1024-token floor is
 *   already wider than a quarter of the window. Above that the ceiling never
 *   binds — it exists for the toy and test windows where it does.
 */
function anchorCeilingChars(windowTokens: number): number {
  return windowTokens > 0 ? windowTokens : Number.POSITIVE_INFINITY;
}

/** Inputs shared by scheduled and explicitly forced compaction attempts. */
export interface RunCompactionArgs {
  ctx: LiveContext;
  compactionPrompt?: string;
  contributions?: readonly CompactionContribution[];
  anchor?: CompactionAnchor;
  windowTokens?: number;
  llm: LLMProvider;
  model: string;
  provider: string;
  providerConfig?: ResolvedProviderConfig;
  signal?: AbortSignal;
  timeoutMs?: number;
  ledger: TokenLedger;
  usage: TokenAccumulator;
  /**
   * The agent-bound logger a discarded summarizer result is reported on.
   *
   * @remarks Required rather than optional: a summarizer failure on the
   *   scheduled path is *billed* and then thrown away, and the mechanical
   *   fallback that replaces it emits an ordinary `eviction` event no consumer
   *   can tell from a normal one. Leaving the logger optional is how that stayed
   *   invisible; a caller with nothing to log passes `NOOP_LOGGER`.
   */
  logger: Logger;
}

/** Result of one policy-aware compaction attempt. */
export type CompactionAttempt =
  | {
      kind: "applied";
      event: CompactionEvent;
      appliedContributions: readonly CompactionContribution[];
    }
  | {
      kind: "skipped";
      reason: "nothing_to_compact" | "summarization_failed" | "summary_not_effective";
    };

/**
 * Report a summarizer pass whose output never reached the transcript.
 *
 * @param args - the attempt's arguments, for `mode`, `fallbackOnFailure` and the
 *   logger.
 * @param reason - `summarization_failed` when the call threw,
 *   `summary_not_effective` when it returned a summary too large to adopt.
 * @param cause - the throw, when there was one. Rendered through
 *   {@link errorText}, never `JSON.stringify`: this runs inside a `catch`, and
 *   a circular structure or a BigInt would make the reporter itself throw —
 *   out of `attemptCompaction`'s catch, past the mechanical fallback, and into
 *   the run.
 * @remarks The scheduled path (`runCompaction`, `fallbackOnFailure: true`)
 *   swallowed both outcomes entirely: the run is billed for the summary, the
 *   summary is discarded, and the `CompactionEvent` the fallback emits reads
 *   `operation: "eviction"` — indistinguishable from an ordinary eviction. Only
 *   the user-requested `/compact` path ever recorded `compaction_skipped`, so a
 *   provider quietly failing every scheduled summarization looked exactly like a
 *   run that simply had nothing worth summarizing.
 *
 *   A log rather than a trace entry: the actor is the host's summarizer, not the
 *   agent, and omitting it does not make the persisted record a false account of
 *   the conversation.
 */
function reportSummarizerFailure(
  args: RunCompactionArgs & { mode: CompactionMode; fallbackOnFailure: boolean },
  reason: "summarization_failed" | "summary_not_effective",
  cause?: unknown,
): void {
  args.logger.warn(
    {
      event: "compaction.summarizer_failed",
      mode: args.mode,
      reason,
      fell_back: args.fallbackOnFailure,
      ...(cause === undefined ? {} : { cause: sanitizeErrorMessage(errorText(cause)) }),
    },
    args.fallbackOnFailure
      ? "the summarizer call was billed and its result discarded; the span is evicted instead"
      : "the summarizer call was billed and its result discarded; the compaction is skipped",
  );
}

/**
 * Attempt one scheduled or forced pass, with caller-selected mechanical fallback.
 *
 * @remarks Explicit user instructions pass `fallbackOnFailure: false`, so a
 * failed or ineffective summary cannot silently turn into blind eviction.
 */
export async function attemptCompaction(
  args: RunCompactionArgs & {
    mode: CompactionMode;
    fallbackOnFailure: boolean;
  },
): Promise<CompactionAttempt> {
  const { ctx, compactionPrompt } = args;
  const compactMechanically = (
    fallbackReason?: "summarization_failed" | "summary_not_effective",
  ): CompactionAttempt => {
    const event = ctx.compact({ mode: args.mode });
    return event
      ? {
          kind: "applied",
          event:
            fallbackReason === undefined ? event : { ...event, fallback_reason: fallbackReason },
          appliedContributions: [],
        }
      : { kind: "skipped", reason: "nothing_to_compact" };
  };
  if (!compactionPrompt) return compactMechanically();

  const span = ctx.selectSummarizableSpan({ mode: args.mode });
  if (!span) {
    return args.fallbackOnFailure
      ? compactMechanically()
      : { kind: "skipped", reason: "nothing_to_compact" };
  }

  const windowTokens = args.windowTokens ?? 0;
  const appliedContributions = applicableContributionEntries(args.contributions ?? []);
  const spanChars = span.messages.reduce((n, m) => n + liveMessageChars(m), 0);
  const priorSummary = ctx.summaryAnchor();
  const priorAnchorChars =
    priorSummary === undefined ? 0 : SUMMARY_ANCHOR_PREFIX.length + priorSummary.length;
  try {
    const { text, usage } = await summarizeContext({
      llm: args.llm,
      model: args.model,
      provider: args.provider,
      ...(args.providerConfig ? { providerConfig: args.providerConfig } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      prompt: compactionPrompt,
      ...(args.contributions !== undefined ? { contributions: args.contributions } : {}),
      ...(args.anchor ? { anchor: args.anchor } : {}),
      ...(priorSummary !== undefined ? { priorSummary } : {}),
      maxOutputTokens: compactionOutputTokens(windowTokens),
      span: span.messages,
    });
    args.ledger.consume(usage);
    addUsage(args.usage, usage);
    const nextAnchorChars = SUMMARY_ANCHOR_PREFIX.length + text.length;
    if (
      nextAnchorChars - priorAnchorChars < spanChars &&
      nextAnchorChars <= anchorCeilingChars(windowTokens)
    ) {
      const event = ctx.replaceSpanWithSummary(span.indices, text);
      return {
        kind: "applied",
        event:
          appliedContributions.length > 0
            ? { ...event, contribution_count: appliedContributions.length }
            : event,
        appliedContributions,
      };
    }
    reportSummarizerFailure(args, "summary_not_effective");
    return args.fallbackOnFailure
      ? compactMechanically("summary_not_effective")
      : { kind: "skipped", reason: "summary_not_effective" };
  } catch (err) {
    if (args.signal?.aborted) throw err;
    reportSummarizerFailure(args, "summarization_failed", err);
    return args.fallbackOnFailure
      ? compactMechanically("summarization_failed")
      : { kind: "skipped", reason: "summarization_failed" };
  }
}

/**
 * Perform one scheduled compaction step, preferring LLM summarization and
 * preserving the established mechanical fallback behavior.
 *
 * @remarks With no `compactionPrompt`, or when no summarizable span exists,
 * this delegates to {@link LiveContext.compact}. Otherwise it summarizes the
 * selected span into the rolling anchor, charging the ledger and usage. A
 * summarizer failure falls back to eviction unless the run was aborted.
 *
 * The adoption test compares the anchor's **growth** with the span it absorbs,
 * not the anchor's absolute size, so an existing rolling summary does not make
 * a genuinely shrinking merge look ineffective.
 */
export async function runCompaction(args: RunCompactionArgs): Promise<CompactionEvent | undefined> {
  const outcome = await attemptCompaction({
    ...args,
    mode: "scheduled",
    fallbackOnFailure: true,
  });
  return outcome.kind === "applied" ? outcome.event : undefined;
}
