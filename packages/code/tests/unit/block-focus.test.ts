import { expect, test } from "bun:test";
import { nextFocus } from "../../src/views/block-focus.ts";
test("row focus starts at the newest target, clamps at both ends, and handles an empty projection", () => {
  expect(nextFocus([], null, 1)).toBeNull();
  expect(nextFocus(["a", "b"], null, -1)).toBe("b");
  expect(nextFocus(["a", "b"], "a", -1)).toBe("a");
  expect(nextFocus(["a", "b"], "b", 1)).toBe("b");
  expect(nextFocus(["a", "b"], "b", -1)).toBe("a");
});
