/**
 * Entry-context memory block. Injects the root `PROFILE.md` — the index of the
 * whole wiki — as one delimited block the host adds as its own context entry
 * (never into the system prompt, to preserve provider prompt caching). The
 * PROFILE is the router: from it the agent decides what to drill into with the
 * read/list/grep tools. There is no vector selection.
 */
import { parseFrontmatter } from "./frontmatter.ts";
import { sanitizeText } from "@clarvis/capability";
import { truncate } from "./text.ts";
import { MEMORY_STORAGE_LIMITS } from "./storage-limits.ts";
import type { MemoryTx } from "./types.ts";

/**
 * Opening delimiter of the injected memory block; paired with the private
 * `</memory>` close tag so the host and the model can locate the block.
 */
export const SEED_OPEN_TAG = "<memory>";
/** Closing tag of the entry memory block; paired with {@link SEED_OPEN_TAG}. */
const SEED_CLOSE_TAG = "</memory>";
/** Default character cap on the whole wrapped seed block; overridable via
 * {@link BuildSeedArgs.maxChars}. */
export const SEED_MAX_CHARS = 6000;

/**
 * The standing note above the injected `PROFILE.md`.
 *
 * @remarks Read-only by design. It used to end by telling the agent to
 * `write_memory / edit_memory ... as you go`, which together with the
 * capability's system section authorised mid-task edits twice over. Maintaining
 * the wiki belongs to the indexing pass, so this block now points only at the
 * navigation tools and says nothing that reads as permission to write. The write
 * policy itself lives in one place — the capability's `systemSection` — because
 * two copies of a rule are two things to drift.
 */
const PREAMBLE =
  "Notes from past runs on this workspace, indexed below. They may be stale: treat\n" +
  "procedures as hypotheses and verify cheaply before relying on them. Use the memory\n" +
  "tools (list_memories / read_memory / grep_memories) to drill into a topic.";

/** Inputs to {@link buildSeed}. */
export interface BuildSeedArgs {
  /** The store to read `PROFILE.md` from; only `read` is needed. */
  store: Pick<MemoryTx, "read" | "readBounded">;
  /** Retained source-compatible sizing hint; wrapping is owned by the capability. */
  maxChars?: number;
  /** The current task, accepted for future task-aware seeding; presently unused
   * (the seed is always the whole PROFILE index). */
  task?: string;
}

/**
 * Build the entry-context memory block from the workspace's root `PROFILE.md`.
 *
 * @param args - The store and sizing options; see {@link BuildSeedArgs}.
 * @returns Raw seed content (a preamble plus the PROFILE body), or `null` when
 * there is no usable profile. The capability owns sanitizing, clipping and tags.
 */
export async function buildSeed(args: BuildSeedArgs): Promise<string | null> {
  const bounded =
    args.store.readBounded === undefined
      ? null
      : await args.store.readBounded("PROFILE.md", MEMORY_STORAGE_LIMITS.prefixBytes);
  const raw = bounded === null ? await args.store.read("PROFILE.md") : bounded.text;
  if (raw === null) return null;
  const parsed = parseFrontmatter(raw);
  if (bounded?.truncated === true && parsed.unparsable) return null;
  const { body } = parsed;
  const profile = body.trim();
  if (profile.length === 0) return null;

  return `${PREAMBLE}\n\n${profile}`;
}

/** Escape a provider's attempt to introduce another Memory delimiter. */
function escapeSeedTags(content: string): string {
  return content.replace(/<\/?memory>/gi, (tag) => tag.replace("<", "&lt;").replace(">", "&gt;"));
}

/**
 * Turn raw provider content into the one safe, bounded Memory context block.
 * This is the only place that escapes delimiters, sanitizes, clips and wraps a seed.
 */
export function wrapMemorySeed(raw: string, maxChars = SEED_MAX_CHARS): string | null {
  const content = raw.trim();
  if (content.length === 0) return null;
  const budget = maxChars - SEED_OPEN_TAG.length - SEED_CLOSE_TAG.length - 2;
  if (budget <= 0) return null;
  const safe = sanitizeText(escapeSeedTags(content));
  const inner = safe.length > budget ? truncate(safe, budget) : safe;
  return `${SEED_OPEN_TAG}\n${inner}\n${SEED_CLOSE_TAG}`;
}
