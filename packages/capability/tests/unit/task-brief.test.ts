import { describe, expect, it } from "bun:test";
import { TASK_BRIEF_MAX_CHARS, parseTaskBrief } from "../../src/task-brief.ts";

describe("parseTaskBrief", () => {
  it("preserves a non-empty brief exactly", () => {
    const task = "Inspect the parser.\n\nReturn evidence, not guesses.";
    expect(parseTaskBrief(task)).toEqual({ ok: true, task });
  });

  it("rejects absent, empty, and non-string briefs", () => {
    for (const value of [undefined, null, "", 7, {}]) {
      expect(parseTaskBrief(value).ok).toBe(false);
    }
  });

  it("uses the JSON Schema Unicode-character measure at the exact ceiling", () => {
    expect(parseTaskBrief("😀".repeat(TASK_BRIEF_MAX_CHARS)).ok).toBe(true);
    const over = parseTaskBrief("😀".repeat(TASK_BRIEF_MAX_CHARS + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.message).toContain(String(TASK_BRIEF_MAX_CHARS));
  });
});
