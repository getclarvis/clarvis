import { describe, expect, test } from "bun:test";

import { WORKFLOW_LIMITS } from "../../src/limits.ts";
import { scheduleWorkItems, type ScheduleResult, type WorkItem } from "../../src/schedule.ts";

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Do ${id}`,
    goal: `do ${id}`,
    files: [],
    dependencies: [],
    mutation: false,
    ...over,
  };
}

/** The ids of each wave, in order — the shape every assertion below is about. */
function waveIds(result: ScheduleResult): string[][] {
  if (!result.ok) throw new Error(`expected a schedule, got ${result.code}`);
  return result.waves.map((w) => w.items.map((i) => i.id));
}

describe("scheduleWorkItems — structural faults", () => {
  test.each([
    [
      "too many items",
      Array.from({ length: WORKFLOW_LIMITS.workItems + 1 }, (_, index) => item(`i${index}`)),
    ],
    [
      "too many files on one item",
      [item("a", { files: Array(WORKFLOW_LIMITS.filesPerWorkItem + 1).fill("src/a.ts") })],
    ],
    [
      "too many dependencies on one item",
      [
        item("a", {
          dependencies: Array(WORKFLOW_LIMITS.dependenciesPerWorkItem + 1).fill("b"),
        }),
      ],
    ],
  ])("refuses %s before deriving the graph", (_label, items) => {
    const result = scheduleWorkItems(items);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("limits_exceeded");
  });

  test("a repeated id is refused, naming only the repeated ids", () => {
    const result = scheduleWorkItems([item("a"), item("b"), item("a"), item("b")]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("duplicate_id");
    expect(result.ids).toEqual(["a", "b"]);
    expect(result.message).toContain("a, b");
  });

  test("a dependency on an id outside the batch is refused, naming the dependents", () => {
    const result = scheduleWorkItems([item("a"), item("b", { dependencies: ["ghost"] })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unknown_dependency");
    expect(result.ids).toEqual(["b"]);
  });

  test("a cycle is refused, and names only its members — not the items that were fine", () => {
    const result = scheduleWorkItems([
      item("free"),
      item("a", { dependencies: ["b"] }),
      item("b", { dependencies: ["a"] }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("dependency_cycle");
    expect(result.ids).toEqual(["a", "b"]);
    expect(result.ids).not.toContain("free");
  });

  test("an empty batch schedules to no waves rather than failing", () => {
    expect(waveIds(scheduleWorkItems([]))).toEqual([]);
  });
});

describe("scheduleWorkItems — dependency order", () => {
  test("a linear chain becomes one item per wave, in order", () => {
    const result = scheduleWorkItems([
      item("c", { dependencies: ["b"] }),
      item("b", { dependencies: ["a"] }),
      item("a"),
    ]);
    expect(waveIds(result)).toEqual([["a"], ["b"], ["c"]]);
  });

  test("a diamond runs its two independent middles together", () => {
    const result = scheduleWorkItems([
      item("root"),
      item("left", { dependencies: ["root"] }),
      item("right", { dependencies: ["root"] }),
      item("join", { dependencies: ["left", "right"] }),
    ]);
    expect(waveIds(result)).toEqual([["root"], ["left", "right"], ["join"]]);
  });

  test("items with no dependencies and no conflict all share the first wave", () => {
    const result = scheduleWorkItems([item("a"), item("b"), item("c")]);
    expect(waveIds(result)).toEqual([["a", "b", "c"]]);
  });
});

describe("scheduleWorkItems — write conflicts", () => {
  test("mutating items on disjoint files run together", () => {
    const result = scheduleWorkItems([
      item("a", { files: ["src/a.ts"], mutation: true }),
      item("b", { files: ["src/b.ts"], mutation: true }),
    ]);
    expect(waveIds(result)).toEqual([["a", "b"]]);
  });

  test("mutating items on the same file are serialized", () => {
    const result = scheduleWorkItems([
      item("a", { files: ["src/a.ts"], mutation: true }),
      item("b", { files: ["src/a.ts"], mutation: true }),
    ]);
    expect(waveIds(result)).toEqual([["a"], ["b"]]);
  });

  test("a directory covers the files under it, per segment", () => {
    const result = scheduleWorkItems([
      item("dir", { files: ["packages/loop"], mutation: true }),
      item("file", { files: ["packages/loop/src/x.ts"], mutation: true }),
      item("sibling", { files: ["packages/loopy/src/x.ts"], mutation: true }),
    ]);
    expect(waveIds(result)).toEqual([["dir", "sibling"], ["file"]]);
  });

  test("a reader overlapping a writer is serialized — a torn read is a real defect", () => {
    const result = scheduleWorkItems([
      item("writer", { files: ["src/a.ts"], mutation: true }),
      item("reader", { files: ["src/a.ts"], mutation: false }),
    ]);
    expect(waveIds(result)).toEqual([["writer"], ["reader"]]);
  });

  test("two readers on the same file share a wave", () => {
    const result = scheduleWorkItems([
      item("r1", { files: ["src/a.ts"] }),
      item("r2", { files: ["src/a.ts"] }),
    ]);
    expect(waveIds(result)).toEqual([["r1", "r2"]]);
  });

  test("a mutating item that declared no files conflicts with every other mutator", () => {
    const result = scheduleWorkItems([
      item("unscoped", { files: [], mutation: true }),
      item("scoped", { files: ["src/far-away.ts"], mutation: true }),
    ]);
    expect(waveIds(result)).toEqual([["unscoped"], ["scoped"]]);
  });

  test("a mutating item that declared no files is kept apart from readers too", () => {
    const result = scheduleWorkItems([
      item("unscoped", { files: [], mutation: true }),
      item("reader", { files: ["src/a.ts"], mutation: false }),
    ]);
    expect(waveIds(result)).toEqual([["unscoped"], ["reader"]]);
  });

  test("an unscoped mutator conflicts whichever side of the comparison it lands on", () => {
    const result = scheduleWorkItems([
      item("reader", { files: ["src/a.ts"], mutation: false }),
      item("unscoped", { files: [], mutation: true }),
    ]);
    expect(waveIds(result)).toEqual([["reader"], ["unscoped"]]);
  });

  test("an unscoped mutator runs alone, and the readers it displaced still share a wave", () => {
    const result = scheduleWorkItems([
      item("unscoped", { files: [], mutation: true }),
      item("r1", { files: ["src/a.ts"] }),
      item("r2", { files: ["src/b.ts"] }),
    ]);
    expect(waveIds(result)).toEqual([["unscoped"], ["r1", "r2"]]);
  });

  test("a conflicting item falls into the first wave that has room, not always a new one", () => {
    const result = scheduleWorkItems([
      item("a", { files: ["src/shared.ts"], mutation: true }),
      item("b", { files: ["src/shared.ts"], mutation: true }),
      item("c", { files: ["src/other.ts"], mutation: true }),
    ]);
    expect(waveIds(result)).toEqual([["a", "c"], ["b"]]);
  });

  test("conflict is confined to its layer — a dependent never joins its dependency's wave", () => {
    const result = scheduleWorkItems([
      item("a", { files: ["src/a.ts"], mutation: true }),
      item("b", { files: ["src/b.ts"], mutation: true, dependencies: ["a"] }),
    ]);
    expect(waveIds(result)).toEqual([["a"], ["b"]]);
  });
});

describe("scheduleWorkItems — path normalization", () => {
  test.each([
    ["a leading ./", "./src/a.ts", "src/a.ts"],
    ["repeated ./", "././src/a.ts", "src/a.ts"],
    ["doubled separators", "src//a.ts", "src/a.ts"],
    ["backslashes", "src\\a.ts", "src/a.ts"],
    ["a trailing slash", "src/", "src/a.ts"],
    ["surrounding whitespace", "  src/a.ts  ", "src/a.ts"],
    ["differing case", "SRC/A.TS", "src/a.ts"],
  ])("%s still collides with the plain form", (_label, written, plain) => {
    const result = scheduleWorkItems([
      item("a", { files: [written], mutation: true }),
      item("b", { files: [plain], mutation: true }),
    ]);
    expect(waveIds(result)).toEqual([["a"], ["b"]]);
  });

  test("a file entry that normalizes away is dropped, leaving a mutator unscoped", () => {
    const result = scheduleWorkItems([
      item("blank", { files: ["   "], mutation: true }),
      item("scoped", { files: ["src/a.ts"], mutation: true }),
    ]);
    expect(waveIds(result)).toEqual([["blank"], ["scoped"]]);
  });
});

describe("scheduleWorkItems — determinism", () => {
  const batch = [
    item("d", { files: ["src/shared.ts"], mutation: true, dependencies: ["a"] }),
    item("a", { files: ["src/a.ts"], mutation: true }),
    item("c", { files: ["src/shared.ts"], mutation: true, dependencies: ["a"] }),
    item("b", { files: ["src/b.ts"] }),
  ];

  test("the same batch always yields the same waves", () => {
    expect(waveIds(scheduleWorkItems(batch))).toEqual(waveIds(scheduleWorkItems(batch)));
  });

  test("waves follow the order the discovery round emitted, not a sort", () => {
    expect(waveIds(scheduleWorkItems(batch))).toEqual([["a", "b"], ["d"], ["c"]]);
  });
});
