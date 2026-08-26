import { expect, test } from "bun:test";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import { completionBeforeFinalAnswer } from "../../src/views/transcript-completion.ts";

test("completion chrome is presented immediately before the final lead answer", () => {
  const nodes: TranscriptNode[] = [
    { key: "r1::reasoning", kind: "reasoning", status: "ok", text: "thinking" },
    { key: "r1::answer", kind: "assistant", status: "ok", text: "final body" },
    { key: "r1::run", kind: "run", status: "ok", text: "", reason: "completed" },
  ];
  expect(completionBeforeFinalAnswer(nodes).map((node) => node.key)).toEqual([
    "r1::reasoning",
    "r1::run",
    "r1::answer",
  ]);
  expect(nodes.map((node) => node.key)).toEqual(["r1::reasoning", "r1::answer", "r1::run"]);
});

test("runs without a lead answer retain their protocol order", () => {
  const nodes: TranscriptNode[] = [
    { key: "r1::error", kind: "error", status: "error", text: "failed" },
    { key: "r1::run", kind: "run", status: "error", text: "", reason: "failed" },
  ];
  expect(completionBeforeFinalAnswer(nodes).map((node) => node.key)).toEqual([
    "r1::error",
    "r1::run",
  ]);
});
