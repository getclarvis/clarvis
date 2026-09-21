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

function replayAnnotations(stream: RunEvent[]): string[] {
  return createRoot((dispose) => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_1");
    for (const e of stream) applyRunEvent(sink, e, "replay");
    const texts = store.nodes.filter((n) => n.kind === "annotation").map((n) => n.text ?? "");
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

test("a restored Goal block remains domain state instead of a generic guard-trip error", () => {
  const errors = replay([
    ev({ type: "run_started", at: 0 }),
    ev({
      type: "run_ended",
      at: 5,
      status: "failed",
      reason: "guard_trip",
      code: "goal_blocked",
    }),
  ]);
  expect(errors).toEqual([]);
});

test("a restored failure explains itself with the persisted message, not the run category", () => {
  // `reason` is the category: every capability-declared guard code collapses into
  // `guard_trip`, and the live path's message comes from the run envelope, which
  // is never persisted. Replaying with the category as the message made the
  // restored run explain itself with a word that says nothing about this failure.
  const annotations = replayAnnotations([
    ev({ type: "run_started", at: 0 }),
    ev({
      type: "run_ended",
      at: 5,
      status: "failed",
      reason: "guard_trip",
      code: "goal_steward_failed",
      message: "the Steward review's token consumption could not be determined",
    }),
  ]);
  expect(annotations).toHaveLength(1);
  expect(annotations[0]).toContain("token consumption could not be determined");
  expect(annotations.join("\n")).not.toContain("guard_trip");
});

test("a restored failure whose trace predates the message says why with its code", () => {
  const annotations = replayAnnotations([
    ev({ type: "run_started", at: 0 }),
    ev({
      type: "run_ended",
      at: 5,
      status: "failed",
      reason: "guard_trip",
      code: "goal_steward_inconclusive",
    }),
  ]);
  expect(annotations[0]).toContain("goal_steward_inconclusive");
  expect(annotations.join("\n")).not.toContain("guard_trip");
});

test("a failure code repeated as its own message is not rendered twice", () => {
  const errors = replay([
    ev({ type: "run_started", at: 0 }),
    ev({
      type: "run_ended",
      at: 5,
      status: "failed",
      reason: "error",
      code: "provider_auth",
      message: "provider_auth",
    }),
  ]);
  expect(errors).toEqual(["provider_auth"]);
});
