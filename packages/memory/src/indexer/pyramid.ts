/**
 * The pyramid-closure rule, and the finalize gate that enforces it on a run.
 *
 * @remarks Closure used to be validated over a JSON array of operations the
 * model emitted in one shot. The indexer now edits the tree through the ordinary
 * memory tools, so what is checked is a *ledger* of the mutations that actually
 * landed, recorded from each call's own `path` argument. Two consequences worth
 * naming: `edit_memory` closes an ancestor just as `write_memory` does — which is
 * the whole point of the redesign, since re-emitting a 3 KB `TOPIC.md` to record
 * one fact is what produced truncated output — and the rule is a *liveness*
 * condition rather than an atomicity one. Writes land as they are made; the gate
 * refuses to let the agent stop while the pyramid is still open.
 */
import type { FinalizeGate, GateOutcome } from "@clarvis/capability";

/** The three tools whose success changes the tree. */
export type MutatingTool = "write_memory" | "edit_memory" | "delete_memory";

/** One mutation that landed, as the handler observed it. */
export interface Mutation {
  tool: MutatingTool;
  path: string;
}

/** Whether a wire name is one of the mutating memory tools. */
export function isMutatingTool(name: string): name is MutatingTool {
  return name === "write_memory" || name === "edit_memory" || name === "delete_memory";
}

/** Records what a pass changed, so the gate can rule on it. */
export interface TouchedLedger {
  record(mutation: Mutation): void;
  all(): readonly Mutation[];
  isEmpty(): boolean;
}

/** A fresh, empty {@link TouchedLedger}. */
export function createTouchedLedger(): TouchedLedger {
  const entries: Mutation[] = [];
  return {
    record: (mutation) => entries.push(mutation),
    all: () => entries,
    isEmpty: () => entries.length === 0,
  };
}

/**
 * The `TOPIC.md` files on the path from a leaf up to (but excluding) the root.
 *
 * @param leafPath - a `<topic>/<sub>/MEMORY.md`-style leaf path.
 * @returns each ancestor directory's `TOPIC.md`, shallowest first.
 */
function ancestorTopics(leafPath: string): string[] {
  const segments = leafPath.split("/").slice(0, -1);
  const topics: string[] = [];
  for (let depth = 1; depth < segments.length; depth++) {
    topics.push(`${segments.slice(0, depth).join("/")}/TOPIC.md`);
  }
  return topics;
}

/**
 * Whether the mutations a pass made are closed over the semantic pyramid.
 *
 * @param touched - every mutation that landed, in the order it landed.
 * @returns `null` when the set is closed — including when it is empty, since
 *   recording nothing is a legitimate outcome — otherwise the first gap, phrased
 *   for the model.
 * @remarks A delete counts as touching its leaf but not as compiling anything,
 *   so removing a leaf still obliges the ancestors that described it to be
 *   brought up to date.
 */
export function pyramidIssue(touched: readonly Mutation[]): string | null {
  if (touched.length === 0) return null;
  const leaves = touched.filter((m) => m.path.endsWith("/MEMORY.md")).map((m) => m.path);
  if (leaves.length === 0) {
    return (
      "you changed only compiled layers — a pass must also record or remove at least one " +
      "<topic>/<subtopic>/MEMORY.md leaf, or change nothing at all"
    );
  }
  const compiled = new Set(touched.filter((m) => m.tool !== "delete_memory").map((m) => m.path));
  if (!compiled.has("PROFILE.md")) {
    return "a detailed change must also update the compiled PROFILE.md";
  }
  for (const leaf of leaves) {
    for (const topic of ancestorTopics(leaf)) {
      if (!compiled.has(topic)) {
        return `the change to ${leaf} must also update its compiled ancestor ${topic}`;
      }
    }
  }
  return null;
}

/**
 * The finalize gate that keeps an indexer pass from stopping mid-pyramid.
 *
 * @param ledger - the pass's mutation ledger.
 * @returns a {@link FinalizeGate} that passes on a closed set and nudges with the
 *   first gap otherwise.
 * @remarks `fastAcceptOk` reports true for an empty ledger, so the overwhelmingly
 *   common "nothing worth learning" pass never pays for a gate sweep. It is not
 *   optional decoration: without it the gate is skipped entirely on the lone
 *   `submit_result` path and would never run at all.
 */
export function buildPyramidGate(ledger: TouchedLedger): FinalizeGate {
  return {
    fastAcceptOk: () => ledger.isEmpty(),
    check(): Promise<GateOutcome> {
      const issue = pyramidIssue(ledger.all());
      if (issue === null) return Promise.resolve({ kind: "pass" });
      return Promise.resolve({
        kind: "nudge",
        note:
          `The memory pyramid is not closed: ${issue}. Close it with edit_memory ` +
          "(preferred — a surgical edit, not a rewrite) or write_memory, then finish. " +
          "You cannot un-write what already landed, so close what you started.",
      });
    },
  };
}
