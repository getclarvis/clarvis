/** Maximum Unicode characters retained in one delegated task brief. */
export const DELEGATE_TASK_MAX_CHARS = 32_768;

/** The result of validating a model-authored delegated task brief. */
export type DelegateTaskTextParseResult =
  { ok: true; task: string } | { ok: false; message: string };

/**
 * Validate a delegated task without normalizing its Markdown or whitespace.
 *
 * @remarks JSON Schema's `maxLength` counts Unicode characters rather than
 * UTF-16 code units. The programmatic boundary must use the same measure or an
 * emoji-heavy payload could pass one path and fail the other. The loop stops
 * counting as soon as it crosses the ceiling, so a direct embedder cannot make
 * validation allocate a second copy of an oversized task.
 */
export function parseDelegateTaskText(value: unknown): DelegateTaskTextParseResult {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, message: "task must be a non-empty string" };
  }

  let chars = 0;
  for (const _character of value) {
    chars += 1;
    if (chars > DELEGATE_TASK_MAX_CHARS) {
      return {
        ok: false,
        message: `task must be at most ${String(DELEGATE_TASK_MAX_CHARS)} characters`,
      };
    }
  }

  return { ok: true, task: value };
}
