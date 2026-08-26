import type {
  AssistantReasoningPart,
  AssistantTextPart,
  LiveMessage,
  MessageContent,
  ToolCallRef,
  ToolResultImage,
} from "@clarvis/capability";
import { contentToText, NOOP_LOGGER } from "@clarvis/capability";
import type {
  AppendToolResultOutcome,
  CompactionConfig,
  CompactionEvent,
  CompactionScope,
  LiveContext,
  LiveSeedEntry,
  SummarizableSpan,
} from "./compaction-contracts.ts";
import {
  liveMessageChars,
  MAX_LIVE_TOOL_IMAGE_CHARS,
  MAX_TOOL_IMAGE_CHARS,
  MAX_TOOL_IMAGES_PER_RESULT,
  SUMMARY_ANCHOR_PREFIX,
  willTruncateToolResult,
} from "./compaction-policy.ts";
import { createCompactionSelector } from "./compaction-selection.ts";
import { rebuildDroppingTools } from "./context-rewrite.ts";
import { createLiveEntryStore } from "./live-entry-store.ts";

/**
 * Build a {@link LiveContext} over a seed transcript under a given compaction
 * config and scope.
 *
 * @param seed - initial entries; raw messages seed as non-evictable, while
 *   {@link ContextSnapshotEntry} items restore their persisted
 *   evictable/canonical/summary flags and task attribution.
 * @param config - the {@link CompactionConfig} governing truncation/eviction;
 *   pass {@link DISABLED_COMPACTION} to keep everything.
 * @param scope - stamped onto every emitted {@link CompactionEvent}.
 * @returns the live context.
 */
export function createLiveContext(
  seed: readonly LiveSeedEntry[],
  config: CompactionConfig,
  scope: CompactionScope,
): LiveContext {
  const store = createLiveEntryStore(seed, scope.logger ?? NOOP_LOGGER);
  const entries = store.entries;
  const stamp = (
    extra: Omit<CompactionEvent, "agent" | "subagent_instance_id">,
  ): CompactionEvent => {
    const ev: CompactionEvent = { agent: scope.agent, ...extra };
    if (scope.subagent_instance_id !== undefined)
      ev.subagent_instance_id = scope.subagent_instance_id;
    return ev;
  };

  const isSummaryAnchor = (entry: (typeof entries)[number]): boolean =>
    entry.summary && !entry.evictable;
  const rewriteDroppingTools = (
    drop: Set<number>,
    insert?: { content: string; evictable: boolean; summary: boolean },
  ): number =>
    rebuildDroppingTools({
      entries,
      drop,
      ...(insert !== undefined ? { insert } : {}),
      replace: (next) => store.replace(next, "compaction"),
    });

  const selector = createCompactionSelector({
    entries: () => entries,
    totalChars: () => store.totalChars(),
    config,
  });

  /**
   * Keep only the newest bounded set of inline tool images.
   *
   * @remarks The payload strings are not copied. Older/oversized images are
   * released immediately and replaced by an explicit transcript marker, which
   * also keeps `snapshot()` bounded when a run ends before ordinary compaction.
   *
   * The prefix-break report deliberately excludes the **last** durable entry.
   * This runs immediately after each `appendToolMessage`, so trimming the result
   * that was just pushed rewrites bytes no provider has seen yet and costs
   * nothing; only a rewrite reaching further back releases an image the previous
   * request already carried, and that is the one worth a warning.
   */
  const enforceToolImageBudget = (): void => {
    let remaining = MAX_LIVE_TOOL_IMAGE_CHARS;
    let changed = false;
    let lowestRewritten = -1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      const message = entry.message;
      if (message.role !== "tool" || message.images === undefined) continue;

      const kept: ToolResultImage[] = [];
      let dropped = 0;
      let droppedChars = 0;
      for (const image of message.images) {
        const chars = image.data.length + image.mediaType.length;
        const admissible =
          kept.length < MAX_TOOL_IMAGES_PER_RESULT &&
          chars <= MAX_TOOL_IMAGE_CHARS &&
          chars <= remaining;
        if (admissible) {
          kept.push(image);
          remaining -= chars;
        } else {
          dropped += 1;
          droppedChars += chars;
        }
      }
      if (dropped === 0) continue;

      const noun = dropped === 1 ? "image was" : "images were";
      const marker =
        `[runtime: ${String(dropped)} inline tool ${noun} released to keep the live context ` +
        `within its image budget; dropped ~${String(droppedChars)} payload chars]`;
      const { images: _discarded, ...withoutImages } = message;
      entry.message = {
        ...withoutImages,
        content: `${message.content}\n${marker}`,
        ...(kept.length > 0 ? { images: kept } : {}),
      };
      entry.chars = liveMessageChars(entry.message);
      changed = true;
      lowestRewritten = index;
    }
    if (!changed) return;
    if (lowestRewritten < store.durablePrefixEnd() - 1)
      store.reportPrefixBreak(lowestRewritten, "image_budget");
    store.replace([...entries], "image_budget");
  };

  // A continuation may hydrate a snapshot written by an older, unbounded
  // runtime. Bound it before exposing `messages` or accepting another image.
  enforceToolImageBudget();

  return {
    get messages(): LiveMessage[] {
      return store.messages;
    },

    appendAssistant(
      content: string,
      reasoning?: AssistantReasoningPart[],
      textParts?: AssistantTextPart[],
    ): void {
      store.push(
        {
          role: "assistant",
          content,
          ...(reasoning !== undefined && reasoning.length > 0 ? { reasoning } : {}),
          ...(textParts !== undefined && textParts.length > 0 ? { text_parts: textParts } : {}),
        },
        false,
      );
    },

    appendAssistantToolCalls(
      content: string,
      toolCalls: ToolCallRef[],
      reasoning?: AssistantReasoningPart[],
      textParts?: AssistantTextPart[],
    ): void {
      if (toolCalls.length === 0) {
        store.push(
          {
            role: "assistant",
            content,
            ...(reasoning !== undefined && reasoning.length > 0 ? { reasoning } : {}),
            ...(textParts !== undefined && textParts.length > 0 ? { text_parts: textParts } : {}),
          },
          false,
        );
        return;
      }
      store.push(
        {
          role: "assistant",
          content,
          tool_calls: toolCalls,
          ...(reasoning !== undefined && reasoning.length > 0 ? { reasoning } : {}),
          ...(textParts !== undefined && textParts.length > 0 ? { text_parts: textParts } : {}),
        },
        false,
      );
    },

    appendUser(content: MessageContent): void {
      store.push({ role: "user", content }, false);
    },

    appendNote(content: string): void {
      store.push({ role: "user", content }, false);
    },

    appendRuntimeNote(kind: string, content: string): void {
      const idx = entries.findIndex((e) => e.noteKind === kind);
      if (idx !== -1) store.removeAt(idx);
      const message: LiveMessage = { role: "user", content };
      store.appendVolatile({
        message,
        chars: liveMessageChars(message),
        evictable: false,
        canonical: false,
        summary: false,
        noteKind: kind,
      });
      store.sync();
    },

    appendToolMessage(
      toolCallId: string,
      content: string,
      opts?: { taskId?: string; images?: ToolResultImage[]; spillPath?: string },
    ): AppendToolResultOutcome {
      const taskId = opts?.taskId;
      const images = opts?.images;
      const imagePatch = images && images.length > 0 ? { images } : {};
      if (willTruncateToolResult(content, config)) {
        const headChars = Math.ceil(config.maxResultChars / 2);
        const tailChars = config.maxResultChars - headChars;
        const head = content.slice(0, headChars);
        const tail = content.slice(content.length - tailChars);
        const dropped = content.length - head.length - tail.length;
        const where = opts?.spillPath !== undefined ? `; full output at ${opts.spillPath}` : "";
        const marker = `[runtime: tool result truncated — kept the first ${head.length} and last ${tail.length} chars, dropped ~${dropped} from the middle; original ~${content.length} chars${where}]`;
        const message = `${head}\n${marker}\n${tail}`;
        store.push(
          { role: "tool", tool_call_id: toolCallId, content: message, ...imagePatch },
          true,
          taskId,
        );
        enforceToolImageBudget();
        return {
          truncated: true,
          fullText: content,
          event: stamp({
            operation: "truncation",
            original_chars: content.length,
            kept_chars: head.length + tail.length,
          }),
        };
      }
      store.push({ role: "tool", tool_call_id: toolCallId, content, ...imagePatch }, true, taskId);
      enforceToolImageBudget();
      return { truncated: false, fullText: content };
    },

    setCanonicalState(content: string): void {
      const idx = entries.findIndex((e) => e.canonical);
      if (idx !== -1) store.removeAt(idx);
      const message: LiveMessage = { role: "user", content };
      store.appendVolatile({
        message,
        chars: liveMessageChars(message),
        evictable: false,
        canonical: true,
        summary: false,
      });
      store.sync();
    },

    setStableBlock(kind: string, content: string): void {
      const idx = entries.findIndex((e) => e.blockKind === kind);
      if (idx !== -1) {
        const superseded = entries[idx]!;
        if (contentToText(superseded.message.content) === content) return;
        delete superseded.blockKind;
        superseded.evictable = true;
        superseded.superseded = true;
      }
      const message: LiveMessage = { role: "user", content };
      store.appendDurable({
        message,
        chars: liveMessageChars(message),
        evictable: false,
        canonical: false,
        summary: false,
        blockKind: kind,
      });
      store.sync();
    },

    cacheBreakpoints(): { stable: number; prior: number } {
      return selector.cacheBreakpoints();
    },

    selectSummarizableSpan(opts): SummarizableSpan | undefined {
      const indices = selector.selectOldestEvictable(true, opts?.mode);
      if (indices.length === 0) return undefined;
      return { indices, messages: indices.map((i) => entries[i]!.message) };
    },

    summaryAnchor(): string | undefined {
      const entry = entries.find(isSummaryAnchor);
      if (entry === undefined) return undefined;
      return contentToText(entry.message.content).slice(SUMMARY_ANCHOR_PREFIX.length);
    },

    replaceSpanWithSummary(indices: number[], summary: string): CompactionEvent {
      const drop = new Set(indices);
      const content = `${SUMMARY_ANCHOR_PREFIX}${summary}`;
      const existing = entries.findIndex(isSummaryAnchor);

      if (existing === -1) {
        const insert = { content, evictable: false, summary: true };
        const original = rewriteDroppingTools(drop, insert);
        return stamp({
          operation: "summarization",
          original_chars: original,
          kept_chars: content.length,
          anchor_chars: content.length,
          anchor_updated: false,
        });
      }

      const entry = entries[existing]!;
      if (existing < store.durablePrefixEnd()) store.reportPrefixBreak(existing, "summary_anchor");
      const message: LiveMessage = { role: "user", content };
      entry.message = message;
      entry.chars = liveMessageChars(message);
      const original = rewriteDroppingTools(drop);
      return stamp({
        operation: "summarization",
        original_chars: original,
        kept_chars: entry.chars,
        anchor_chars: entry.chars,
        anchor_updated: true,
      });
    },

    compact(opts): CompactionEvent | undefined {
      const drop = selector.selectOldestEvictable(false, opts?.mode);
      if (drop.length === 0) return undefined;
      const evicted = drop.length;
      const marker = `[runtime: ${evicted} earlier tool result${evicted === 1 ? "" : "s"} evicted to fit context]`;
      const freed = rewriteDroppingTools(new Set(drop), {
        content: marker,
        evictable: true,
        summary: false,
      });
      return stamp({ operation: "eviction", evicted_count: evicted, freed_chars: freed });
    },

    needsCompaction(): boolean {
      return selector.selectOldestEvictable(false).length > 0;
    },

    forceEvictOldest(): CompactionEvent | undefined {
      if (!config.enabled) return undefined;
      const eligible = selector.evictableCandidates(false, true).filter((i) => {
        const e = entries[i]!;
        return !(e.message.role === "user" && !e.summary);
      });
      if (eligible.length === 0) return undefined;
      const targetChars =
        config.windowTokens > 0 ? selector.lowWaterTokens() * 2 : Number.POSITIVE_INFINITY;
      let remaining = store.totalChars();
      const drop = new Set<number>();
      for (const i of eligible) {
        drop.add(i);
        remaining -= entries[i]!.chars;
        if (remaining <= targetChars) break;
      }
      const count = drop.size;
      const marker = `[runtime: ${count} earlier tool result${count === 1 ? "" : "s"} evicted to fit context]`;
      const freed = rewriteDroppingTools(drop, {
        content: marker,
        evictable: true,
        summary: false,
      });
      return stamp({ operation: "eviction", evicted_count: count, freed_chars: freed });
    },

    estimateTokens(): number {
      return selector.estimateTokens();
    },

    observeUsage(inputTokens: number): void {
      selector.observeUsage(inputTokens);
    },

    snapshot() {
      return store.snapshot();
    },
  };
}
