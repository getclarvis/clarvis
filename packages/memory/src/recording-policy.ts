/**
 * The operator's editorial policy: what is worth recording in *this* wiki.
 *
 * Distinct from `policy.ts`, which decides what automation may *do* to a
 * document that already exists (pins, authority, intents). This decides what
 * ought to be written down in the first place, and it is the owner's opinion
 * rather than a rule the store enforces.
 *
 * Two authored files feed it — a personal one under the global root and a shared
 * one in the workspace — and they are **concatenated**, global first. That is a
 * deliberate departure from `guard-judge.md`, which takes the nearest scope
 * whole: a judging prompt is one complete instruction, so two of them would be
 * two rulings for one verdict, whereas "always keep the exact commands"
 * (personal, every project) and "record the migration traps" (this repo) are
 * both true at once. Shadowing would silently drop the personal half the moment
 * a project added one of its own.
 *
 * **It governs _what_, never _where_.** The three levels are mechanism: the
 * finalize gate enforces closure over them, so a policy able to redefine the
 * structure would produce a pass the gate pushes back until its budget runs out.
 * Topic *names* are the opposite — they are content, and stay emergent. Fixing a
 * top-level taxonomy would invert how the tree grows, forcing knowledge into
 * slots decided before anyone knew what the workspace was about and leaving
 * empty topics nobody prunes. Depth is mechanism; breadth is emergent.
 */
import { sanitizeText } from "@clarvis/capability";
import { readUtf8PrefixSync } from "./bounded-io.ts";
import { MEMORY_STORAGE_LIMITS } from "./storage-limits.ts";
import { truncate } from "./text.ts";

/**
 * Character cap on each scope's contribution.
 *
 * @remarks Per scope rather than on the total, so a long workspace file cannot
 * crowd out the operator's personal one — under a shared cap whichever half was
 * read second would simply vanish.
 */
export const MEMORY_POLICY_MAX_CHARS = 4000;

/** The authored policy text of each scope, as read from disk. */
export interface MemoryPolicyScopes {
  /** The operator's personal policy, from the global root. */
  global?: string | undefined;
  /** The workspace's shared policy, committed with the repository. */
  workspace?: string | undefined;
}

/** A scope's text, bounded and redacted, or undefined when it says nothing. */
function usable(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const clean = sanitizeText(truncate(text, MEMORY_POLICY_MAX_CHARS)).trim();
  return clean.length > 0 ? clean : undefined;
}

/**
 * Compose the recording policy an indexing pass is given.
 *
 * @param scopes - each scope's authored text; see {@link MemoryPolicyScopes}.
 * @returns the section to append to the pass's instruction, or `undefined` when
 *   neither scope says anything.
 * @remarks A file that exists but is blank counts as absent, matching how
 *   `guard-judge.md` treats one. The preamble restates the two limits inside the
 *   model's own context rather than trusting the operator to have observed them,
 *   because what follows is arbitrary prose that may well try to dictate a
 *   folder layout.
 */
export function composeMemoryPolicy(scopes: MemoryPolicyScopes): string | undefined {
  const parts = [usable(scopes.global), usable(scopes.workspace)].filter(
    (p): p is string => p !== undefined,
  );
  if (parts.length === 0) return undefined;
  return (
    "OPERATOR RECORDING POLICY — this workspace's owner has stated what they want kept.\n" +
    "It refines the judgement above about what is worth recording, and wins on conflict.\n" +
    "It does NOT change the structure: the pyramid, the closure rule and the frontmatter\n" +
    "still hold, and topic names remain whatever the knowledge itself calls for.\n\n" +
    parts.join("\n\n")
  );
}

/** Where the two authored policy files live. */
export interface MemoryPolicyFiles {
  /** Absolute path to the operator's personal policy. */
  global: string;
  /** Absolute path to the workspace's shared policy. */
  workspace: string;
}

/**
 * Read both authored policy files and compose them.
 *
 * @param files - absolute paths to each scope; see {@link MemoryPolicyFiles}.
 * @returns the composed policy, or `undefined` when neither file says anything.
 * @remarks Absent, unreadable and blank are all the same outcome. Emptying a
 *   file is how an operator turns the override off, and that should not behave
 *   differently from deleting it — the rule `guard-judge.md` already follows.
 *
 *   Reading lives here rather than in the host because it is the same contract
 *   as composing: a caller that read the files itself would have to reproduce
 *   the blank-is-absent rule to get the same answer, and a host is exactly where
 *   that duplicate would go untested.
 */
export function loadMemoryPolicy(files: MemoryPolicyFiles): string | undefined {
  return composeMemoryPolicy({
    global: readIfPresent(files.global),
    workspace: readIfPresent(files.workspace),
  });
}

/** One file's text, or undefined when it is missing, unreadable or blank. */
function readIfPresent(file: string): string | undefined {
  const text = readUtf8PrefixSync(file, MEMORY_STORAGE_LIMITS.prefixBytes);
  return text !== undefined && text.trim().length > 0 ? text : undefined;
}
