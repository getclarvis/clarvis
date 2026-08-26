/** Up/Down-arrow prompt history, optionally persisted through a host adapter. */
export interface PromptHistory {
  /** Appends a submitted prompt; a no-op for blank text or an immediate repeat. */
  push(text: string): void;
  /** Merges previously-submitted prompts into history without re-persisting them. */
  seed(texts: string[]): void;
  /** Steps the cursor back one entry, stashing `liveDraft` first if at the end. */
  prev(liveDraft: string): string | undefined;
  /** Steps the cursor forward one entry, returning the stashed live draft past the end. */
  next(): string | undefined;
  /** Returns the cursor to the end (past the newest entry) and clears the stash. */
  resetCursor(): void;
  /** Number of entries currently held. */
  size(): number;
  /** Waits for already-queued persistence work; it never rejects. */
  flush(): Promise<void>;
  /** Whether an append or compaction has failed during this process. */
  persistenceDegraded(): boolean;
}

export interface PromptHistoryPersistenceFailure {
  operation: "append" | "compact";
  path: string;
  cause: unknown;
}

/** Initial state returned by a {@link PromptHistoryPersistence} adapter. */
export interface PromptHistorySnapshot {
  entries: string[];
  /** Whether the persisted representation should be rewritten to the active limit. */
  compact: boolean;
}

/** Persistence port implemented outside core by the active host. */
export interface PromptHistoryPersistence {
  /** Human-readable location included in degradation diagnostics. */
  path: string;
  /** Loads and bounds the initial history without throwing for an absent store. */
  load(limit: number): PromptHistorySnapshot;
  /** Appends one prompt to the durable representation. */
  append(text: string): Promise<void>;
  /** Replaces the durable representation with the bounded in-memory entries. */
  compact(entries: readonly string[]): Promise<void>;
}

export interface PromptHistoryOptions {
  /** Called for the first persistence failure in this history instance. */
  onPersistenceError?: (failure: PromptHistoryPersistenceFailure) => void;
}

/** Hard bounds for the optional Up-arrow history, which must never dominate the TUI. */
const MAX_PROMPT_HISTORY_ENTRIES = 1_000;
export const MAX_PROMPT_HISTORY_ENTRY_CHARS = 1_000_000;
const MAX_PROMPT_HISTORY_CHARS = 8_000_000;

/**
 * Creates prompt history over an optional persistence port. Seeding (session
 * resume) stays memory-only — those prompts were already appended when typed —
 * and skips prompts already loaded, so switching sessions repeatedly never
 * duplicates the Up-arrow walk.
 */
export function createPromptHistory(
  limit = 200,
  persistence: PromptHistoryPersistence | null = null,
  options: PromptHistoryOptions = {},
): PromptHistory {
  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : 200;
  const boundedLimit = Math.min(MAX_PROMPT_HISTORY_ENTRIES, Math.max(1, requestedLimit));
  const loaded = persistence?.load(boundedLimit) ?? { entries: [], compact: false };
  let entries = loaded.entries
    .slice(-MAX_PROMPT_HISTORY_ENTRIES)
    .filter((entry) => entry.length > 0 && entry.length <= MAX_PROMPT_HISTORY_ENTRY_CHARS);
  let loadedWasTrimmed = entries.length !== loaded.entries.length;
  let cursor = entries.length;
  let stash = "";
  let degraded = false;
  let reported = false;
  let pending: Promise<void> | null = null;
  let queuedAppends: string[] = [];
  let queuedAppendChars = 0;
  let compactRequested = loaded.compact || loadedWasTrimmed;

  function report(operation: "append" | "compact", cause: unknown): void {
    degraded = true;
    if (reported || !persistence) return;
    reported = true;
    try {
      options.onPersistenceError?.({ operation, path: persistence.path, cause });
    } catch {
      // Diagnostics must not turn optional history persistence into a fatal path.
    }
  }

  async function drainPersistence(): Promise<void> {
    if (!persistence) return;
    while (compactRequested || queuedAppends.length > 0) {
      if (compactRequested) {
        compactRequested = false;
        queuedAppends = [];
        queuedAppendChars = 0;
        const snapshot = [...entries];
        try {
          await persistence.compact(snapshot);
        } catch (cause) {
          report("compact", cause);
        }
        continue;
      }
      const text = queuedAppends.shift()!;
      queuedAppendChars -= text.length;
      try {
        await persistence.append(text);
      } catch (cause) {
        report("append", cause);
      }
    }
  }

  function kickPersistence(): void {
    if (!persistence || pending !== null) return;
    pending = drainPersistence().finally(() => {
      pending = null;
      if (compactRequested || queuedAppends.length > 0) kickPersistence();
    });
  }

  function clamp(): boolean {
    let changed = false;
    if (entries.length > boundedLimit) {
      entries = entries.slice(entries.length - boundedLimit);
      changed = true;
    }
    let chars = entries.reduce((total, entry) => total + entry.length, 0);
    while (entries.length > 0 && chars > MAX_PROMPT_HISTORY_CHARS) {
      chars -= entries.shift()!.length;
      changed = true;
    }
    return changed;
  }

  function persist(text: string, compact: boolean): void {
    if (!persistence) return;
    if (compact || queuedAppendChars + text.length > MAX_PROMPT_HISTORY_CHARS) {
      compactRequested = true;
      queuedAppends = [];
      queuedAppendChars = 0;
    } else {
      queuedAppends.push(text);
      queuedAppendChars += text.length;
    }
    kickPersistence();
  }

  loadedWasTrimmed ||= clamp();
  cursor = entries.length;
  if (loadedWasTrimmed) compactRequested = true;
  if (compactRequested) kickPersistence();

  function push(text: string): void {
    const t = text.trimEnd();
    if (t.length === 0 || t.length > MAX_PROMPT_HISTORY_ENTRY_CHARS) return;
    if (entries[entries.length - 1] !== t) {
      entries.push(t);
      persist(t, clamp());
    }
    cursor = entries.length;
    stash = "";
  }

  function seed(texts: string[]): void {
    const known = new Set(entries);
    for (const t of texts) {
      const s = t.trimEnd();
      if (s.length === 0 || s.length > MAX_PROMPT_HISTORY_ENTRY_CHARS || known.has(s)) continue;
      entries.push(s);
      known.add(s);
    }
    clamp();
    cursor = entries.length;
  }

  function prev(liveDraft: string): string | undefined {
    if (entries.length === 0) return undefined;
    if (cursor === entries.length) stash = liveDraft;
    if (cursor > 0) cursor--;
    return entries[cursor];
  }

  function next(): string | undefined {
    if (cursor >= entries.length) return undefined;
    cursor++;
    return cursor === entries.length ? stash : entries[cursor];
  }

  function resetCursor(): void {
    cursor = entries.length;
    stash = "";
  }

  return {
    push,
    seed,
    prev,
    next,
    resetCursor,
    size: () => entries.length,
    flush: async () => {
      while (pending !== null || compactRequested || queuedAppends.length > 0) {
        kickPersistence();
        await pending;
      }
    },
    persistenceDegraded: () => degraded,
  };
}
