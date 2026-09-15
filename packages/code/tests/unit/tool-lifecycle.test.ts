import { expect, test } from "bun:test";
import { reduceToolLifecycle } from "../../src/core/transcript/tool-lifecycle.ts";

test("input is cumulative and pending survives duplicate announcement or delayed fragments", () => {
  const composing = reduceToolLifecycle({}, { type: "announce" });
  expect(composing.toolPhase).toBe("composing");
  const pending = reduceToolLifecycle(composing, {
    type: "input",
    chars: 100,
    streamChars: 150,
    complete: true,
  });
  expect(reduceToolLifecycle(pending, { type: "announce" })).toBe(pending);
  expect(reduceToolLifecycle(pending, { type: "input", chars: 20, streamChars: 40 })).toEqual(
    pending,
  );
  const running = reduceToolLifecycle(pending, { type: "start" });
  expect(running).toEqual({
    toolPhase: "running",
    inputChars: undefined,
    inputStreamChars: undefined,
    inputComplete: undefined,
  });
  expect(reduceToolLifecycle(running, { type: "input", chars: 500 })).toBe(running);
});

test("every terminal is absorbing, including interruption before execution", () => {
  for (const phase of ["completed", "failed", "cancelled", "interrupted"] as const) {
    const terminal = reduceToolLifecycle({}, { type: "terminal", phase });
    expect(terminal.toolPhase).toBe(phase);
    for (const event of [
      { type: "announce" },
      { type: "start" },
      { type: "input", chars: 10 },
    ] as const)
      expect(reduceToolLifecycle(terminal, event)).toBe(terminal);
  }
});
