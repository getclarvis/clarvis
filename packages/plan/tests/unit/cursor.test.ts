/**
 * The paging-cursor envelope: what a tag buys, and what it must never leak.
 * The cross-adapter behaviour it produces is pinned in tests/contract/.
 */
import { describe, expect, test } from "bun:test";

import {
  PLAN_CURSOR_TAGS,
  PlanCursorError,
  decodePlanCursor,
  encodePlanCursor,
} from "../../src/index.ts";

describe("plan cursor tagging", () => {
  test("round-trips a payload through its own tag", () => {
    const cursor = encodePlanCursor(PLAN_CURSOR_TAGS.file, "2026-07-27T10-02-00-third.md");
    expect(cursor).toBe("pf1:2026-07-27T10-02-00-third.md");
    expect(decodePlanCursor(PLAN_CURSOR_TAGS.file, cursor)).toBe("2026-07-27T10-02-00-third.md");
  });

  test("round-trips a payload that itself contains the separator", () => {
    const cursor = encodePlanCursor(PLAN_CURSOR_TAGS.provider, "pm1:not-really-a-tag");
    expect(decodePlanCursor(PLAN_CURSOR_TAGS.provider, cursor)).toBe("pm1:not-really-a-tag");
  });

  test("the three tags are distinct, so no backend can decode another's cursor", () => {
    const tags = Object.values(PLAN_CURSOR_TAGS);
    expect(new Set(tags).size).toBe(tags.length);
  });

  test("rejects a cursor minted by another backend, naming both dialects", () => {
    const foreign = encodePlanCursor(
      PLAN_CURSOR_TAGS.memory,
      "0193b0f0-0000-4000-8000-00000000cafe",
    );
    let thrown: unknown;
    try {
      decodePlanCursor(PLAN_CURSOR_TAGS.file, foreign);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PlanCursorError);
    expect(thrown).toBeInstanceOf(RangeError);
    const error = thrown as PlanCursorError;
    expect(error.name).toBe("PlanCursorError");
    expect(error.code).toBe("plan_cursor_invalid");
    expect(error.message).toContain("pm1");
    expect(error.message).toContain("pf1");
  });

  test("rejects an untagged cursor without echoing it", () => {
    const secret = "2026-07-27T10-02-00-acquisition-of-northwind.md";
    expect(() => decodePlanCursor(PLAN_CURSOR_TAGS.file, secret)).toThrow(PlanCursorError);
    try {
      decodePlanCursor(PLAN_CURSOR_TAGS.file, secret);
    } catch (error) {
      expect((error as Error).message).not.toContain("northwind");
      expect((error as Error).message).not.toContain(secret);
    }
  });

  test("does not echo a foreign payload either", () => {
    const secret = encodePlanCursor(PLAN_CURSOR_TAGS.memory, "acquisition-of-northwind");
    try {
      decodePlanCursor(PLAN_CURSOR_TAGS.provider, secret);
      throw new Error("expected a PlanCursorError");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanCursorError);
      expect((error as Error).message).not.toContain("northwind");
    }
  });

  test("rejects a tagged cursor carrying no position", () => {
    expect(() => decodePlanCursor(PLAN_CURSOR_TAGS.memory, "pm1:")).toThrow(PlanCursorError);
  });

  test("rejects the empty string rather than reading it as the start of history", () => {
    expect(() => decodePlanCursor(PLAN_CURSOR_TAGS.memory, "")).toThrow(PlanCursorError);
  });
});
