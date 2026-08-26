import type { ContextSnapshotEntry, LiveMessage, Logger } from "@clarvis/capability";
import { levelEnabled, NOOP_LOGGER } from "@clarvis/capability";
import type { LiveSeedEntry } from "./compaction-contracts.ts";
import { liveMessageChars } from "./compaction-policy.ts";
import type { RewriteEntry } from "./context-rewrite.ts";

/** Internal entry metadata kept beside each provider-facing message. */
export interface LiveEntry extends RewriteEntry {
  taskId?: string;
  noteKind?: string;
  blockKind?: string;
  superseded?: boolean;
}

/**
 * Why a mutation landed inside the durable prefix — the part of the transcript
 * a provider's implicit prompt cache covers.
 *
 * @remarks `compaction` and `summary_anchor` are the deliberate, priced members:
 *   eviction and summarization knowingly rebuild the transcript mid-array, which
 *   is why {@link LiveEntryStore.reportPrefixBreak} demotes both to `debug`.
 *   `summary_anchor` is the anchor rewrite inside
 *   `LiveContext.replaceSpanWithSummary`, whose only caller is
 *   `attemptCompaction` — it *is* compaction, and reporting it as a defect made
 *   every rolling summarization after the first warn, drowning the members that
 *   mean something. It keeps its own name rather than folding into `compaction`
 *   because the anchor rewrite and the span rebuild break the prefix at
 *   different indices, and telling them apart is the whole value of the line.
 *   Every other member is the defect `specs/cross-cutting/prompt-cache.md` priced at 2,929,430
 *   tokens — 35.7% of one session's uncached input — happening live.
 *
 *   `rewrite` has no producer today and is deliberately kept: it is the name the
 *   next in-place message mutator must report under, so a future edit of the
 *   kind commit `7b19005` fixed does not have to invent one. A string-literal
 *   member costs nothing at runtime.
 */
export type PrefixBreakCause =
  "remove" | "rewrite" | "replace" | "image_budget" | "summary_anchor" | "compaction";

/**
 * The causes a compaction pass produces, which {@link createLiveEntryStore}
 * reports at `debug` rather than `warn`.
 *
 * @remarks A rewrite these name is priced, scheduled and already carried on the
 *   trace as a `compaction` event. Levelling them as defects is what dilutes the
 *   causes that are defects.
 */
const PRICED_CAUSES: ReadonlySet<PrefixBreakCause> = new Set<PrefixBreakCause>([
  "compaction",
  "summary_anchor",
]);

/** The single authority for entry order, projected messages, and character total. */
export interface LiveEntryStore {
  readonly entries: LiveEntry[];
  readonly messages: LiveMessage[];
  totalChars(): number;
  appendDurable(entry: LiveEntry): void;
  appendVolatile(entry: LiveEntry): void;
  removeAt(index: number): void;
  push(
    message: LiveMessage,
    evictable: boolean,
    taskId?: string,
    canonical?: boolean,
    summary?: boolean,
  ): void;
  replace(entries: RewriteEntry[], cause?: PrefixBreakCause): void;
  sync(): void;
  snapshot(): ContextSnapshotEntry[];
  /**
   * The index one past the last durable entry — the boundary between the cached
   * prefix and the trailing volatile run.
   *
   * @returns `entries.length` when nothing volatile trails the transcript.
   * @remarks Exposed so a caller that mutates an entry *through* `entries` can
   *   decide whether it just broke the prefix, without duplicating the volatile
   *   rule that only this module owns.
   */
  durablePrefixEnd(): number;
  /**
   * Report that the entry at `index` was mutated, removed or repositioned.
   *
   * @param index - the lowest index the mutation touched.
   * @param cause - which mutation did it; see {@link PrefixBreakCause}.
   * @remarks Call this only from inside a branch that has already established
   *   `index < durablePrefixEnd()`. The character prefix-sum it reports is
   *   computed here and nowhere else, so the common path never pays for it.
   */
  reportPrefixBreak(index: number, cause: PrefixBreakCause): void;
}

/**
 * Hydrates and owns the mutable entry list backing one live context.
 *
 * @param seed - the transcript to hydrate from.
 * @param logger - receives `context.prefix_break` when a mutation lands inside
 *   the cached prefix.
 */
export function createLiveEntryStore(
  seed: readonly LiveSeedEntry[],
  logger: Logger = NOOP_LOGGER,
): LiveEntryStore {
  const entries: LiveEntry[] = seed.map((item) =>
    "message" in item
      ? {
          message: item.message,
          chars: liveMessageChars(item.message),
          evictable: item.evictable,
          canonical: item.canonical,
          summary: item.summary,
          ...(item.task_id !== undefined ? { taskId: item.task_id } : {}),
          ...(item.note_kind !== undefined ? { noteKind: item.note_kind } : {}),
          ...(item.block_kind !== undefined ? { blockKind: item.block_kind } : {}),
        }
      : {
          message: item,
          chars: liveMessageChars(item),
          evictable: false,
          canonical: false,
          summary: false,
        },
  );
  let total = entries.reduce((sum, entry) => sum + entry.chars, 0);
  const messages = entries.map((entry) => entry.message);
  const sync = (): void => {
    messages.length = 0;
    for (const entry of entries) messages.push(entry.message);
  };
  const isVolatile = (entry: LiveEntry): boolean => entry.canonical || entry.noteKind !== undefined;
  const durableInsertIndex = (): number => {
    let index = entries.length;
    while (index > 0 && isVolatile(entries[index - 1]!)) index -= 1;
    return index;
  };
  /**
   * Emit `context.prefix_break`, pricing the damage the way a provider does.
   *
   * @remarks `chars_recharged` is the whole point: an implicit prefix cache
   *   serves the longest byte-identical prefix, so everything from the first
   *   differing byte is billed fresh however small the edit.
   */
  const reportPrefixBreak = (index: number, cause: PrefixBreakCause): void => {
    const level = PRICED_CAUSES.has(cause) ? "debug" : "warn";
    if (!levelEnabled(logger, level)) return;
    let charOffset = 0;
    for (let i = 0; i < index; i += 1) charOffset += entries[i]!.chars;
    logger[level](
      {
        event: "context.prefix_break",
        index,
        entries: entries.length,
        char_offset: charOffset,
        chars_recharged: total - charOffset,
        cause,
      },
      "a durable transcript entry moved or changed; the provider re-charges every token behind it",
    );
  };
  /**
   * Insert ahead of the trailing volatile run.
   *
   * @remarks This site reports nothing, and that is the design rather than an
   *   omission: {@link durableInsertIndex} lands the entry immediately after the
   *   last durable one, so the only entries it can shift are volatile — the
   *   canonical block and the runtime notes, which are spliced out and
   *   re-appended every iteration anyway and are precisely the region
   *   `cacheBreakpoints()` already refuses to place a breakpoint behind. Every
   *   tool result flows through here, so a log line would be both wrong and hot.
   */
  const appendDurable = (entry: LiveEntry): void => {
    entries.splice(durableInsertIndex(), 0, entry);
    total += entry.chars;
  };

  return {
    entries,
    messages,
    totalChars: () => total,
    appendDurable,
    durablePrefixEnd: durableInsertIndex,
    reportPrefixBreak,
    appendVolatile(entry: LiveEntry): void {
      entries.push(entry);
      total += entry.chars;
    },
    removeAt(index: number): void {
      if (index < durableInsertIndex()) reportPrefixBreak(index, "remove");
      total -= entries[index]!.chars;
      entries.splice(index, 1);
    },
    push(message, evictable, taskId, canonical = false, summary = false): void {
      const entry: LiveEntry = {
        message,
        chars: liveMessageChars(message),
        evictable,
        canonical,
        summary,
      };
      if (taskId !== undefined) entry.taskId = taskId;
      appendDurable(entry);
      sync();
    },
    replace(next: RewriteEntry[], cause: PrefixBreakCause = "replace"): void {
      const boundary = durableInsertIndex();
      let firstChange = -1;
      const limit = Math.min(boundary, next.length);
      for (let i = 0; i < limit; i += 1) {
        if (next[i] !== entries[i]) {
          firstChange = i;
          break;
        }
      }
      if (firstChange === -1 && next.length < boundary) firstChange = next.length;
      if (firstChange !== -1) reportPrefixBreak(firstChange, cause);
      entries.length = 0;
      entries.push(...next);
      total = entries.reduce((sum, entry) => sum + entry.chars, 0);
      sync();
    },
    sync,
    snapshot(): ContextSnapshotEntry[] {
      const out: ContextSnapshotEntry[] = [];
      for (const entry of entries) {
        if (entry.message.role === "system") continue;
        out.push({
          message: entry.message,
          evictable: entry.evictable,
          summary: entry.summary,
          canonical: entry.canonical,
          ...(entry.taskId !== undefined ? { task_id: entry.taskId } : {}),
          ...(entry.noteKind !== undefined ? { note_kind: entry.noteKind } : {}),
          ...(entry.blockKind !== undefined ? { block_kind: entry.blockKind } : {}),
        });
      }
      return out;
    },
  };
}
