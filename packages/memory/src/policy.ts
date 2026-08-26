/**
 * What automation may and may not do to a document.
 *
 * Three rules, all about the same thing: the owner's word outranks the model's.
 * A `pinned` document is not automatically replaced or deleted, automation may
 * never *grant* itself authority — raising a document to `confirmed`, or
 * pinning one, is an explicit human act — and it may not *revoke* the pin
 * either.
 *
 * Those rules bind every non-owner intent, the model-facing tools exactly as
 * much as the autonomous indexer. A run is steered by content it merely read,
 * so a turn that stamps a document `pinned: true` and `authority: confirmed` is
 * not a more trusted act than the indexer doing it: it blocks the indexer from
 * ever correcting the document and boosts it in query ranking, which is a
 * durable, self-granted privilege.
 *
 * The pin and the authority level are deliberately asymmetric. The pin is a
 * write barrier, so automation may neither raise nor remove it. Authority is a
 * ranking signal, so automation may *lower* it — `confirmed` to `observed` or
 * `contested`, the documented way to mark knowledge disputed or believed stale
 * — but never raise it.
 *
 * This lives above the store rather than inside it. `MemoryStore` is an
 * injectable port with a deliberately dumb contract (`write(path, content)`);
 * teaching it the policy would force every adapter to reimplement frontmatter
 * parsing and the rule table, guarantee they diverge, and break the
 * deterministic reindex's own legitimate writes to pinned index files.
 */
import type { DocFrontmatter } from "./types.ts";

/** Who is asking to change a document. */
export type MemoryWriteIntent =
  /** The owner, acting through the control plane. */
  | "owner"
  /** A model-facing tool, inside a run. */
  | "agent_tool"
  /** The autonomous per-run indexer. */
  | "indexer"
  /** The deterministic navigation restitch. */
  | "reindex";

/** What is being done to the document. */
export type MemoryWriteOperation = "create" | "replace" | "edit" | "delete";

/** Whether a change may proceed, and why not when it may not. */
export interface PolicyDecision {
  allowed: boolean;
  /** Stable reason code, set when `allowed` is false. */
  code?: "pinned_replace" | "pinned_delete" | "authority_escalation" | "authority_revocation";
  /** One line, safe to show an agent or an owner. */
  reason?: string;
}

const ALLOW: PolicyDecision = { allowed: true };

/**
 * Decide whether a change may proceed.
 *
 * @param args.intent - who is asking.
 * @param args.operation - what they want to do.
 * @param args.existing - the document's current frontmatter, null when it does
 *   not yet exist.
 * @param args.next - the frontmatter the change would install, when known.
 * @returns the decision.
 * @remarks The pin and authority rules apply to every intent that reaches them,
 * which is every intent that is not `owner` or `reindex` — those two return on
 * the first line, so anything past it is automation by definition and is
 * treated alike.
 *
 * A surgical `edit` on a pinned document is **allowed**. Pinning marks content
 * as the owner's, not as frozen: blocking substring edits would make a pinned
 * document unmaintainable, and a targeted correction is not the wholesale
 * replacement the flag exists to prevent. An edit that would take the pin *out*
 * of the frontmatter is refused all the same — including one that merely breaks
 * the closing `---`, since the document then parses with no pin at all —
 * because unpinning and then replacing is otherwise a two-call way around
 * `pinned_replace`.
 *
 * The reindex intent is always allowed regardless of pin/authority, because it
 * only ever rewrites the managed `## Contents` section, which is by definition
 * generated rather than owner prose.
 *
 * `next` is only consulted when the caller supplies it: a caller that cannot
 * say what frontmatter the change would install gets the pin rules alone.
 */
export function checkWrite(args: {
  intent: MemoryWriteIntent;
  operation: MemoryWriteOperation;
  existing: DocFrontmatter | null;
  next?: DocFrontmatter;
}): PolicyDecision {
  const { intent, operation, existing, next } = args;

  if (intent === "reindex" || intent === "owner") return ALLOW;

  if (existing?.pinned === true) {
    if (operation === "delete") {
      return {
        allowed: false,
        code: "pinned_delete",
        reason: "this document is pinned by its owner and will not be deleted automatically",
      };
    }
    if (operation === "replace") {
      return {
        allowed: false,
        code: "pinned_replace",
        reason:
          "this document is pinned by its owner and will not be replaced automatically — " +
          "make a targeted edit instead, or ask the owner to unpin it",
      };
    }
  }

  if (next !== undefined) {
    if (existing?.pinned === true && next.pinned !== true) {
      return {
        allowed: false,
        code: "authority_revocation",
        reason:
          "this document is pinned by its owner; automation may not remove the pin — " +
          "ask the owner to unpin it",
      };
    }
    if (next.pinned === true && existing?.pinned !== true) {
      return {
        allowed: false,
        code: "authority_escalation",
        reason: "automation may not pin a document; pinning is an owner action",
      };
    }
    if (next.authority === "confirmed" && existing?.authority !== "confirmed") {
      return {
        allowed: false,
        code: "authority_escalation",
        reason: "automation may not mark knowledge confirmed; only the owner may",
      };
    }
  }

  return ALLOW;
}
