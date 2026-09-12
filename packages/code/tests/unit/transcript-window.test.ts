import { expect, test } from "bun:test";
import { TranscriptWindow } from "../../src/core/transcript/window.ts";

for (const count of [0, 1, 40, 79, 80, 81, 120, 1001]) {
  test(`native residence stays bounded at ${count} rows`, () => {
    const window = new TranscriptWindow();
    window.sync(Array.from({ length: count }, (_, i) => `row:${i}`));
    expect(window.resident()).toHaveLength(count <= 80 ? count : 40);
    expect(window.end).toBe(count);
    expect(window.reader).toEqual({ mode: "tail" });
  });
}
test("reveal, paging, prepend and concurrent append preserve a surviving semantic anchor", () => {
  const window = new TranscriptWindow();
  window.sync(Array.from({ length: 120 }, (_, i) => `row:${i}`));
  expect(window.reveal("row:63")).toBe(true);
  window.reader = { mode: "anchor", rowId: "row:63", screenY: -2 };
  window.sync(["older", ...window.ids, "newer"]);
  expect(window.resident()).toContain("row:63");
  expect(window.reader).toEqual({ mode: "anchor", rowId: "row:63", screenY: -2 });
  window.page(-1);
  expect(window.resident()).toContain("row:63");
  expect(window.resident().length).toBeLessThanOrEqual(80);
  window.tail();
  expect(window.resident().at(-1)).toBe("newer");
  expect(window.reader.mode as string).toBe("tail");
});
test("unavailable rows do not invent a backfill and retained windows have deterministic bounds", () => {
  const window = new TranscriptWindow();
  window.sync(["a", "b"]);
  expect(window.reveal("missing")).toBe(false);
  expect(window.page(-1)).toBe(false);
  expect(window.page(1)).toBe(false);
  window.reveal("a");
  window.sync(["b"]);
  expect(window.resident()).toEqual(["b"]);
  window.sync([]);
  expect(window.resident()).toEqual([]);
});
