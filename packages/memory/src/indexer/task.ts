/**
 * The task text one indexer pass is given: what the finished run did.
 *
 * @remarks This is the whole of the pass's input. The old prompt also pushed a
 * rendered view of the existing tree — every compilation in full, unbudgeted,
 * plus the top few BM25 leaves — which is exactly the cost the redesign removes:
 * the model now *pulls* what it needs with `query_memories` and `read_memory`,
 * so a large tree no longer inflates every pass whether or not it is relevant.
 */
import { buildDigest, renderDigest } from "../digest.ts";
import { truncate } from "../text.ts";
import type { MemoryBudgets, RunSnapshot } from "../types.ts";

/** How much of a run's final answer the pass is shown. */
const FINAL_ANSWER_MAX_CHARS = 800;

/** How much of the run's task statement the pass is shown, whitespace collapsed. */
const TASK_MAX_CHARS = 500;

/**
 * Render one finished run as the indexer's task.
 *
 * @param run - the sanitized run snapshot.
 * @param budgets - the memory budgets; `digest_tokens` bounds the digest.
 * @returns the markdown the pass receives as its single user message.
 */
export function buildIndexerTask(run: RunSnapshot, budgets: MemoryBudgets): string {
  const digestText = renderDigest(buildDigest(run), budgets.digest_tokens * 4);
  const answer =
    run.final_answer !== undefined
      ? `\n\n## Final answer (excerpt)\n${truncate(run.final_answer, FINAL_ANSWER_MAX_CHARS)}`
      : "";
  return (
    `# This run\ntask: ${truncate(run.task.replace(/\s+/g, " "), TASK_MAX_CHARS)}\n\n` +
    `## Execution digest\n${digestText}${answer}`
  );
}
