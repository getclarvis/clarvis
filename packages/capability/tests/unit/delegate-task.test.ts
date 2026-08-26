import { describe, expect, it } from "bun:test";
import { DELEGATE_TASK_MAX_CHARS, parseDelegateTaskText } from "../../src/delegate-task.ts";

describe("parseDelegateTaskText", () => {
  it("preserves a non-empty brief exactly", () => {
    const task = "Inspect the parser.\n\nReturn evidence, not guesses.";
    expect(parseDelegateTaskText(task)).toEqual({ ok: true, task });
  });

  it("rejects absent, empty, and non-string briefs", () => {
    for (const value of [undefined, null, "", 7, {}]) {
      expect(parseDelegateTaskText(value).ok).toBe(false);
    }
  });

  it("uses the JSON Schema Unicode-character measure at the exact ceiling", () => {
    expect(parseDelegateTaskText("😀".repeat(DELEGATE_TASK_MAX_CHARS)).ok).toBe(true);
    const over = parseDelegateTaskText("😀".repeat(DELEGATE_TASK_MAX_CHARS + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.message).toContain(String(DELEGATE_TASK_MAX_CHARS));
  });
});
