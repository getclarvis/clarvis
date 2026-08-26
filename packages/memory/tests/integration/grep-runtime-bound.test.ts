import { expect, test } from "bun:test";

import { createGrepScanner, GREP_LINE_MAX, GREP_SCAN_MAX_MS } from "../../src/text/grep.ts";

test("the admitted regex worst case stays inside the real runtime budget", () => {
  // `[a-z]*[a-z]*[a-z]*9` carries exactly GREP_AMBIGUITY_MAX markers and no
  // group quantifier, so it is admitted — and it is the pattern the window
  // width is calibrated against: 100ms at 200 characters, 1.5s at 400, 23s at
  // 800. Windowing is what keeps a 2000-character line paying the 200 rate per
  // window instead of the 2000 rate once; untruncated this takes minutes. This
  // assertion deliberately measures the host regex engine, so it belongs in
  // the integration tier rather than beside the injected-clock policy cases.
  const scanner = createGrepScanner("[a-z]*[a-z]*[a-z]*9", { regex: true });
  const started = Date.now();
  scanner.match(`${"a".repeat(GREP_LINE_MAX * 10)}9`);
  const elapsed = Date.now() - started;
  // One window may overrun the deadline, since a `test` cannot be interrupted.
  expect(elapsed).toBeLessThan(GREP_SCAN_MAX_MS * 2);
});
