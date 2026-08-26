import { expect, test } from "bun:test";
import { createPromptHistory } from "../../src/core/prompt-history.ts";

test("resetCursor abandons a history walk and starts the next walk from a fresh live draft", () => {
  const history = createPromptHistory(10);
  history.push("first");
  history.push("second");

  expect(history.prev("old draft")).toBe("second");
  history.resetCursor();
  expect(history.next()).toBeUndefined();
  expect(history.prev("fresh draft")).toBe("second");
  expect(history.next()).toBe("fresh draft");
});
