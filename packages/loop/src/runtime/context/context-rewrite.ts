import type { LiveMessage } from "@clarvis/capability";
import { contentToText } from "@clarvis/capability";
import { liveMessageChars } from "./compaction-policy.ts";

/** Entry fields required by the pairing-preserving transcript rewriter. */
export interface RewriteEntry {
  message: LiveMessage;
  chars: number;
  evictable: boolean;
  canonical: boolean;
  summary: boolean;
  taskId?: string;
  noteKind?: string;
  blockKind?: string;
  superseded?: boolean;
}

export interface RewriteInsert {
  content: string;
  evictable: boolean;
  summary: boolean;
}

/**
 * Drops selected tool entries while preserving assistant/tool pairing and
 * optionally inserts one user-role replacement at the oldest dropped position.
 */
export function rebuildDroppingTools(args: {
  entries: readonly RewriteEntry[];
  drop: ReadonlySet<number>;
  insert?: RewriteInsert;
  replace: (next: RewriteEntry[]) => void;
}): number {
  const owningAssistant = (toolIndex: number, toolCallId: string): number => {
    for (let index = toolIndex - 1; index >= 0; index -= 1) {
      const message = args.entries[index]!.message;
      if (
        message.role === "assistant" &&
        "tool_calls" in message &&
        message.tool_calls.some((call) => call.id === toolCallId)
      ) {
        return index;
      }
    }
    return -1;
  };

  const refRemoval = new Map<number, Set<string>>();
  let freed = 0;
  for (const toolIndex of args.drop) {
    const entry = args.entries[toolIndex]!;
    freed += entry.chars;
    if (entry.message.role !== "tool") continue;
    const owner = owningAssistant(toolIndex, entry.message.tool_call_id);
    if (owner === -1) continue;
    const ids = refRemoval.get(owner) ?? new Set<string>();
    ids.add(entry.message.tool_call_id);
    refRemoval.set(owner, ids);
  }
  const oldest = args.drop.size > 0 ? Math.min(...args.drop) : -1;
  const next: RewriteEntry[] = [];
  let inserted = false;
  let insertedIndex = -1;

  for (let index = 0; index < args.entries.length; index += 1) {
    if (args.drop.has(index)) {
      if (args.insert !== undefined && index === oldest && !inserted) {
        insertedIndex = next.length;
        const message: LiveMessage = { role: "user", content: args.insert.content };
        next.push({
          message,
          chars: liveMessageChars(message),
          evictable: args.insert.evictable,
          canonical: false,
          summary: args.insert.summary,
        });
        inserted = true;
      }
      continue;
    }
    const entry = args.entries[index]!;
    const removeIds = refRemoval.get(index);
    if (removeIds && entry.message.role === "assistant") {
      const text = contentToText(entry.message.content);
      const reasoning =
        "reasoning" in entry.message && (entry.message.reasoning?.length ?? 0) > 0
          ? entry.message.reasoning
          : undefined;
      const remaining =
        "tool_calls" in entry.message
          ? entry.message.tool_calls.filter((call) => !removeIds.has(call.id))
          : [];
      if (remaining.length === 0 && text.trim() === "") continue;
      const message: LiveMessage =
        remaining.length > 0
          ? {
              role: "assistant",
              content: text,
              tool_calls: remaining,
              ...(reasoning !== undefined ? { reasoning } : {}),
            }
          : {
              role: "assistant",
              content: text,
              ...(reasoning !== undefined ? { reasoning } : {}),
            };
      next.push({ ...entry, message, chars: liveMessageChars(message) });
      continue;
    }
    next.push(entry);
  }

  if (insertedIndex !== -1) {
    while (insertedIndex + 1 < next.length && next[insertedIndex + 1]!.message.role === "tool") {
      const after = insertedIndex + 1;
      const insertedEntry = next[insertedIndex]!;
      next[insertedIndex] = next[after]!;
      next[after] = insertedEntry;
      insertedIndex = after;
    }
  }
  args.replace(next);
  return freed;
}
