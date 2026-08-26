import { expect, test } from "bun:test";
import { withRunMarkersLast } from "../../src/views/transcript-state.ts";
import type { TranscriptNode } from "../../src/adapters/store.ts";

const node = (key: string): TranscriptNode =>
  ({ key, kind: "annotation", status: "ok", text: key }) as unknown as TranscriptNode;

test("a run's outcome reads last, even when its own events arrive after it", () => {
  // The reported shape: the run settles, and a tool call that had already
  // finished arrives afterwards and rendered *below* the Canceled marker.
  const ordered = withRunMarkersLast([
    node("exec_1::tool:a"),
    node("exec_1::run"),
    node("exec_1::tool:b"),
  ]).map((n) => n.key);
  expect(ordered).toEqual(["exec_1::tool:a", "exec_1::tool:b", "exec_1::run"]);
});

test("a marker already last is left exactly as it was", () => {
  const input = [node("exec_1::tool:a"), node("exec_1::run")];
  expect(withRunMarkersLast(input)).toBe(input);
});

test("two runs each keep their own outcome last, in run order", () => {
  const ordered = withRunMarkersLast([
    node("exec_1::tool:a"),
    node("exec_1::run"),
    node("exec_1::tool:b"),
    node("exec_2::tool:a"),
    node("exec_2::run"),
  ]).map((n) => n.key);
  expect(ordered).toEqual([
    "exec_1::tool:a",
    "exec_1::tool:b",
    "exec_1::run",
    "exec_2::tool:a",
    "exec_2::run",
  ]);
});

test("nodes with no run prefix are untouched", () => {
  const input = [node("notice:1"), node("exec_1::run"), node("notice:2")];
  expect(withRunMarkersLast(input).map((n) => n.key)).toEqual([
    "notice:1",
    "exec_1::run",
    "notice:2",
  ]);
});

test("every node survives the reordering exactly once", () => {
  const input = [
    node("exec_1::a"),
    node("exec_1::run"),
    node("exec_1::b"),
    node("exec_2::c"),
    node("exec_2::run"),
    node("exec_2::d"),
  ];
  const out = withRunMarkersLast(input);
  expect(out).toHaveLength(input.length);
  expect(new Set(out.map((n) => n.key)).size).toBe(input.length);
});
