/** Maximum number of Unicode characters in a human-facing task title. */
export const TASK_TITLE_MAX = 60;

/** The result of parsing a model- or user-authored task title. */
export type TaskTitleParseResult = { ok: true; title: string } | { ok: false; message: string };

const LINE_BREAK = /[\r\n\u2028\u2029]/u;
const HORIZONTAL_SPACE = /[\t ]+/gu;

/**
 * Parse a short, single-line task title without silently deriving or clipping it.
 *
 * @remarks Surrounding whitespace is removed and repeated horizontal whitespace
 * is collapsed. Line breaks and titles longer than {@link TASK_TITLE_MAX}
 * Unicode characters are rejected so callers can ask the author to correct the
 * title rather than turning a task description into an accidental label.
 */
export function parseTaskTitle(value: unknown): TaskTitleParseResult {
  if (typeof value !== "string") {
    return {
      ok: false,
      message:
        "title must be a non-empty string — use a few words for the label and put the full instruction in the task or prompt.",
    };
  }
  if (LINE_BREAK.test(value)) {
    return {
      ok: false,
      message:
        "title must fit on one line — use a few words for the label and put the full instruction in the task or prompt.",
    };
  }
  const title = value.trim().replace(HORIZONTAL_SPACE, " ");
  if (title.length === 0) {
    return {
      ok: false,
      message:
        "title must be a non-empty string — use a few words for the label and put the full instruction in the task or prompt.",
    };
  }
  if ([...title].length > TASK_TITLE_MAX) {
    return {
      ok: false,
      message: `title must be at most ${String(TASK_TITLE_MAX)} characters — shorten the label and keep the full instruction in the task or prompt.`,
    };
  }
  return { ok: true, title };
}
