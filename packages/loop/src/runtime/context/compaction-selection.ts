import type { LiveMessage } from "@clarvis/capability";
import type { CompactionConfig, CompactionMode } from "./compaction-contracts.ts";
import { estimateTokensForChars } from "./compaction-policy.ts";

/** Read-only entry shape consumed by compaction selection policy. */
export interface SelectableEntry {
  readonly message: LiveMessage;
  readonly chars: number;
  readonly evictable: boolean;
  readonly summary: boolean;
  readonly canonical: boolean;
  readonly noteKind?: string;
  readonly superseded?: boolean;
}

/** Selection and occupancy operations over a live entry list. */
export interface CompactionSelector {
  cacheBreakpoints(): { stable: number; prior: number };
  selectOldestEvictable(excludeSummaries: boolean, mode?: CompactionMode): number[];
  evictableCandidates(excludeSummaries: boolean, ignoreProtection?: boolean): number[];
  lowWaterTokens(): number;
  estimateTokens(): number;
  observeUsage(inputTokens: number): void;
}

/** Builds the read-only policy used to decide what compaction may remove. */
export function createCompactionSelector(args: {
  entries: () => readonly SelectableEntry[];
  totalChars: () => number;
  config: CompactionConfig;
}): CompactionSelector {
  const entries = args.entries;
  const config = args.config;
  const isVolatile = (entry: SelectableEntry): boolean =>
    entry.canonical || entry.noteKind !== undefined;
  const isStable = (entry: SelectableEntry): boolean =>
    !isVolatile(entry) && entry.message.role !== "system";
  const lastStableIndex = (from: number): number => {
    const list = entries();
    const end = Math.min(from, list.length - 1);
    let last = -1;
    for (let index = 0; index <= end; index += 1) {
      const entry = list[index]!;
      if (isVolatile(entry)) break;
      if (isStable(entry)) last = index;
    }
    return last;
  };

  const highWaterTokens = (): number => Math.floor(config.windowTokens * config.fraction);
  const lowWaterTokens = (): number => Math.floor(config.windowTokens * config.targetFraction);
  let anchorTokens: number | undefined;
  let anchorChars: number | undefined;
  const estimateFromChars = (chars: number): number =>
    anchorTokens !== undefined && anchorChars !== undefined
      ? Math.max(0, anchorTokens + Math.ceil((chars - anchorChars) / 4))
      : estimateTokensForChars(chars);
  const effectivePreserveTokens = (): number =>
    Math.max(0, Math.min(config.preserveRecentTokens, Math.floor(lowWaterTokens() * 0.5)));

  const protectedTail = (indices: readonly number[]): ReadonlySet<number> => {
    const list = entries();
    const kept = new Set<number>();
    const budget = effectivePreserveTokens();
    if (budget <= 0) return kept;
    let spanChars = 0;
    for (let cursor = indices.length - 1; cursor >= 0; cursor -= 1) {
      const index = indices[cursor]!;
      const entry = list[index]!;
      if (entry.superseded) continue;
      const next = spanChars + entry.chars;
      if (kept.size > 0 && estimateTokensForChars(next) > budget) break;
      spanChars = next;
      kept.add(index);
    }
    return kept;
  };

  const evictableCandidates = (excludeSummaries: boolean, ignoreProtection = false): number[] => {
    const list = entries();
    const indices: number[] = [];
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index]!;
      if (entry.evictable && !(excludeSummaries && entry.summary)) indices.push(index);
    }
    if (ignoreProtection) return indices;
    const kept = protectedTail(indices);
    return indices.filter((index) => !kept.has(index));
  };

  const selectOldestEvictable = (
    excludeSummaries: boolean,
    mode: CompactionMode = "scheduled",
  ): number[] => {
    if (!config.enabled) return [];
    const candidates = evictableCandidates(excludeSummaries);
    if (mode === "forced") return candidates;
    const list = entries();
    let remainingChars = args.totalChars();
    if (estimateFromChars(remainingChars) <= highWaterTokens()) return [];
    const picked: number[] = [];
    for (const index of candidates) {
      if (estimateFromChars(remainingChars) <= lowWaterTokens()) break;
      picked.push(index);
      remainingChars -= list[index]!.chars;
    }
    return picked;
  };

  return {
    cacheBreakpoints(): { stable: number; prior: number } {
      const stable = lastStableIndex(entries().length - 1);
      if (stable < 0) return { stable, prior: -1 };
      let index = stable;
      while (index >= 0 && entries()[index]!.message.role !== "assistant") index -= 1;
      return { stable, prior: index <= 0 ? -1 : lastStableIndex(index - 1) };
    },
    selectOldestEvictable,
    evictableCandidates,
    lowWaterTokens,
    estimateTokens: () => estimateFromChars(args.totalChars()),
    observeUsage(inputTokens: number): void {
      if (!Number.isFinite(inputTokens) || inputTokens <= 0) return;
      anchorTokens = inputTokens;
      anchorChars = args.totalChars();
    },
  };
}
