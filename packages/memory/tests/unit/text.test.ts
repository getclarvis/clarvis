import { describe, expect, test } from "bun:test";

import { truncate } from "../../src/text.ts";

describe("truncate", () => {
  test("adds an ellipsis only when over the cap", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });

  test("never exceeds the cap, including at zero", () => {
    expect(truncate("abcdef", 1)).toBe("…");
    expect(truncate("abcdef", 0)).toBe("…");
  });
});
