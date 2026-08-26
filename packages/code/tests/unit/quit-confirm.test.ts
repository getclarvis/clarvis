import { expect, test } from "bun:test";
import { createQuitConfirm, type QuitConfirm } from "../../src/views/quit-confirm.ts";

function harness(state: { dirty?: boolean; run?: boolean; draft?: boolean } = {}): {
  qc: QuitConfirm;
  toasts: string[];
  quits: () => number;
} {
  const toasts: string[] = [];
  let quits = 0;
  const qc = createQuitConfirm({
    isDirtyView: () => state.dirty ?? false,
    isRunActive: () => state.run ?? false,
    isDraftNonEmpty: () => state.draft ?? false,
    notify: (m) => toasts.push(m),
    quit: () => quits++,
  });
  return { qc, toasts, quits: () => quits };
}

test("confirm:true arms first, quits on the second tap", () => {
  const h = harness();
  h.qc.quit({ confirm: true });
  expect(h.quits()).toBe(0);
  expect(h.toasts).toEqual(["press again to quit"]);
  h.qc.quit({ confirm: true });
  expect(h.quits()).toBe(1);
});

test("confirm:false with nothing at stake quits immediately", () => {
  const h = harness();
  h.qc.quit({ confirm: false });
  expect(h.quits()).toBe(1);
  expect(h.toasts).toEqual([]);
});

test("a dirty view upgrades even confirm:false to the armed confirm", () => {
  const h = harness({ dirty: true });
  h.qc.quit({ confirm: false });
  expect(h.quits()).toBe(0);
  expect(h.toasts).toEqual(["press again to quit (unsaved changes)"]);
  h.qc.quit({ confirm: false });
  expect(h.quits()).toBe(1);
});

test("the why-text names what is at stake: run active, else unsaved draft", () => {
  const run = harness({ run: true });
  run.qc.quit({ confirm: true });
  expect(run.toasts).toEqual(["press again to quit (run active)"]);
  const draft = harness({ draft: true });
  draft.qc.quit({ confirm: true });
  expect(draft.toasts).toEqual(["press again to quit (draft unsaved)"]);
});

test("disarm resets the window: the next quit arms again instead of quitting", () => {
  const h = harness();
  h.qc.quit({ confirm: true });
  h.qc.disarm();
  h.qc.quit({ confirm: true });
  expect(h.quits()).toBe(0);
  expect(h.toasts).toEqual(["press again to quit", "press again to quit"]);
});

test("/quit mid-run asks before discarding the run", () => {
  const h = harness({ run: true });
  // `/quit` passes confirm:false, so before the gate widened this quit
  // immediately and a run in flight went with it, unannounced.
  h.qc.quit({ confirm: false });
  expect(h.quits()).toBe(0);
  expect(h.toasts.at(-1)).toContain("run active");
  h.qc.quit({ confirm: false });
  expect(h.quits()).toBe(1);
});

test("a draft alone does not arm the gate: /quit's own text sits in the composer", () => {
  const h = harness({ draft: true });
  h.qc.quit({ confirm: false });
  expect(h.quits()).toBe(1);
});

test("/quit at true idle still exits immediately: typing the command is the confirmation", () => {
  const h = harness();
  h.qc.quit({ confirm: false });
  expect(h.quits()).toBe(1);
});
