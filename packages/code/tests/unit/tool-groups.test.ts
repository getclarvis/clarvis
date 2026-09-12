import { expect, test } from "bun:test";
import { isExplorationTool, TranscriptRows } from "../../src/core/transcript/rows.ts";

test("only allowlisted reads group; shell, mutations and unknown MCP remain individual", () => {
  for (const name of ["read_file", "read_image", "glob", "grep"])
    expect(isExplorationTool(name)).toBe(true);
  for (const name of ["shell", "write_file", "edit_file", "apply_patch", "memory_write", "unknown"])
    expect(isExplorationTool(name)).toBe(false);
  expect(isExplorationTool("read_file", "remote")).toBe(false);
});
for (const boundary of ["part", "notice", "boundary"] as const) {
  test(`${boundary} closes membership without moving pending members`, () => {
    const rows = new TranscriptRows();
    const call = (id: string, scope = "turn", projection = "lead") =>
      rows.admit({ id, scope, projection, kind: "exploration" });
    call("a");
    expect(rows.select("lead")).toEqual(["exploration:a"]);
    call("b");
    rows.admit({ id: "break", scope: "turn", projection: "lead", kind: boundary });
    call("c");
    call("a");
    expect(rows.row("exploration:a")).toMatchObject({ members: ["a", "b"] });
    expect(rows.row("exploration:c")).toMatchObject({ members: ["c"] });
    call("next", "turn2");
    call("child", "turn", "child");
    expect(rows.destination("next")).toBe("exploration:next");
    expect(rows.select("child")).toEqual(["exploration:child"]);
  });
}
test("discarding the first member does not rename its surviving group", () => {
  const rows = new TranscriptRows();
  for (const id of ["a", "b"])
    rows.admit({ id, kind: "exploration", projection: "lead", scope: "turn" });
  rows.retain(new Set(["b"]));
  expect(rows.select("lead")).toEqual(["exploration:a"]);
  expect(rows.row("exploration:a")).toMatchObject({ members: ["b"] });
  expect(rows.destination("a")).toBeUndefined();
});
