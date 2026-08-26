import { describe, expect, it } from "../helpers/bun-test.ts";
import { TASK_TITLE_MAX, parseTaskTitle } from "../../src/task-title.ts";

describe("parseTaskTitle", () => {
  it("normalizes surrounding and repeated horizontal whitespace", () => {
    expect(parseTaskTitle("  Review\t the   auth flow  ")).toEqual({
      ok: true,
      title: "Review the auth flow",
    });
  });

  it("rejects missing, empty, and multiline titles", () => {
    for (const value of [undefined, 7, "", "   ", "first\nsecond", "first\u2028second"]) {
      const result = parseTaskTitle(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("title");
    }
  });

  it("counts Unicode characters rather than UTF-16 code units", () => {
    expect(parseTaskTitle("😀".repeat(TASK_TITLE_MAX)).ok).toBe(true);
    const result = parseTaskTitle("😀".repeat(TASK_TITLE_MAX + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(String(TASK_TITLE_MAX));
  });
});
