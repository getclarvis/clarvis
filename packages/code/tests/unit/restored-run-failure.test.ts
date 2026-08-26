import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { RunEvent } from "@clarvis/protocol";
import { createTranscriptStore } from "../../src/adapters/store.ts";
import { applyRunEvent, runEvent } from "../helpers/run-events.ts";

const ev = runEvent;

function replay(stream: RunEvent[]): string[] {
  return createRoot((dispose) => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_1");
    for (const e of stream) applyRunEvent(sink, e, "replay");
    const texts = store.nodes.filter((n) => n.kind === "error").map((n) => n.text ?? "");
    dispose();
    return texts;
  });
}

test("a restored run that failed says why, not only that it did", () => {
  // A rehydrated session is rebuilt from the persisted trace alone; the live
  // path's error node is a runtime append that never reaches it. The trace does
  // carry the failure's code.
  const errors = replay([
    ev({ type: "run_started", at: 0 }),
    ev({ type: "run_ended", at: 5, status: "failed", reason: "error", code: "provider_auth" }),
  ]);
  expect(errors.join("\n")).toContain("provider_auth");
});

test("a restored run that completed adds no failure node", () => {
  const errors = replay([
    ev({ type: "run_started", at: 0 }),
    ev({ type: "run_ended", at: 5, status: "completed", reason: "completed" }),
  ]);
  expect(errors).toEqual([]);
});

test("a failure with no recorded code adds no invented node", () => {
  const errors = replay([
    ev({ type: "run_started", at: 0 }),
    ev({ type: "run_ended", at: 5, status: "failed", reason: "error" }),
  ]);
  expect(errors).toEqual([]);
});
