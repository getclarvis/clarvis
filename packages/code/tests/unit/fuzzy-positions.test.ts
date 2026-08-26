import { expect, test } from "bun:test";
import { fuzzyFieldMatch, fuzzyPositions, labelRuns, matchRuns } from "../../src/core/fuzzy.ts";

test("fuzzyPositions returns the greedy match indices", () => {
  expect(fuzzyPositions("/clear", "cle")).toEqual([1, 2, 3]);
  expect(fuzzyPositions("session-store.ts", "sst")).toEqual([0, 2, 9]);
  expect(fuzzyPositions("/diff", "z")).toBeNull();
  expect(fuzzyPositions("/diff", "")).toEqual([]);
  expect(fuzzyPositions("/Diff", "dif")).toEqual([1, 2, 3]);
});

test("labelRuns splits into plain/hit runs and falls back to one plain run", () => {
  expect(labelRuns("/clear", "cle")).toEqual([
    { text: "/", hit: false },
    { text: "cle", hit: true },
    { text: "ar", hit: false },
  ]);
  expect(labelRuns("/diff", "zzz")).toEqual([{ text: "/diff", hit: false }]);
  expect(labelRuns("/diff", "")).toEqual([{ text: "/diff", hit: false }]);
});

test("matchRuns renders explicit positions and treats null as unmatched", () => {
  expect(matchRuns("headless", [0, 1, 2, 3])).toEqual([
    { text: "head", hit: true },
    { text: "less", hit: false },
  ]);
  expect(matchRuns("headless", null)).toEqual([{ text: "headless", hit: false }]);
  expect(matchRuns("headless", [])).toEqual([{ text: "headless", hit: false }]);
});

test("fuzzyFieldMatch names the single field the term matched, with its positions", () => {
  expect(fuzzyFieldMatch(["/agent", "Switch agent"], "switch")).toEqual({
    field: 1,
    positions: [0, 1, 2, 3, 4, 5],
  });
  expect(fuzzyFieldMatch(["/agent", "Switch agent"], "age")).toEqual({
    field: 0,
    positions: [1, 2, 3],
  });
});

test("fuzzyFieldMatch: ties go to the earlier field; cross-field-only matches are null", () => {
  expect(fuzzyFieldMatch(["/agent", "/agent"], "agent")).toEqual({
    field: 0,
    positions: [1, 2, 3, 4, 5],
  });
  expect(fuzzyFieldMatch(["/clear", "new session"], "clearnew")).toBeNull();
  expect(fuzzyFieldMatch(["/clear", "new session"], "")).toBeNull();
});
