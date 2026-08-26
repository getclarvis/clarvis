/**
 * The built-in summarization prompt an agent compacts with once its context
 * crosses the high-water mark, plus the instruction that turns a fresh
 * summarization into an *update* of the rolling summary already in place.
 *
 * @remarks Kept in its own module so a multi-kilobyte string does not sit in the
 *   middle of the live-context mechanics, and so a host embedding
 *   `@clarvis/loop` can import it and extend rather than replace it.
 */
export const DEFAULT_COMPACTION_PROMPT = `You are compacting the working context of an autonomous agent that is still mid-task.

The transcript below leaves the agent's context the moment you answer. Your summary is the only record of it the agent will ever see again, so anything you leave out is lost for the rest of the run.

Write a dense factual briefing that lets the agent carry on without re-reading the transcript. Preserve, verbatim where they are short:
- the objective, and any constraints or acceptance criteria that were stated
- decisions taken and the reason for each, including the options rejected
- file paths, symbol names, identifiers, URLs, commands run and their exact outcome
- error messages, stack frames and failing assertions
- facts about the system that were expensive to discover
- what is finished, what is in progress, and what is still outstanding

Leave out: pretty-printed listings, repeated or superseded tool output, exploratory paths that produced no fact, and anything already stated in the reference block above.

Rules:
- Output the summary and nothing else. No preamble, no sign-off, no offer to help.
- Terse bullets under short headings. Prose only where a bullet would lose the meaning.
- Never invent, generalise or soften a fact. Where something is uncertain, say that it is uncertain.
- Do not restate these instructions, and do not mention compaction or that context was reduced.`;

/**
 * Appended to the summarizer's system turn when a rolling summary already
 * exists, immediately followed by that summary's text.
 *
 * @remarks Without it the second compaction would silently *discard* the first
 *   summary rather than absorb it: the anchor is replaced in place, not appended
 *   to, so the model has to return the whole merged text.
 */
export const COMPACTION_UPDATE_INSTRUCTION = `You are UPDATING an existing summary, not writing a new one.

"Summary so far" below already covers everything up to the transcript; the transcript covers only what happened since. Return the complete merged summary: fold the transcript into the existing summary, keep every fact from it that is still relevant, correct anything the transcript supersedes, and drop only what is now finished and no longer load-bearing.

Return the whole summary, standing on its own. Do not return a delta, do not reference the earlier version, and do not let the merged summary grow beyond the length of the one you were given unless the transcript introduced facts that genuinely must be carried forward.`;
