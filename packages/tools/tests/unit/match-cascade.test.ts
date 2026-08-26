import { describe, it, expect } from "bun:test";
import { findCascadeMatch, scanLineBlocks } from "../../src/lib/match-cascade.ts";

describe("scanLineBlocks", () => {
  const eq = (a: string, b: string): boolean => a === b;

  it("finds every window that matches", () => {
    const hay = ["a", "x", "a", "b", "a", "b"];
    expect(scanLineBlocks(hay, ["a", "b"], eq)).toEqual([2, 4]);
  });

  it("stops at the cap once enough blocks are collected", () => {
    const hay = ["m", "m", "m"];
    expect(scanLineBlocks(hay, ["m"], eq, 2)).toEqual([0, 1]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(scanLineBlocks(["a", "b", "c"], ["z"], eq)).toEqual([]);
  });

  it("returns no hits when the needle is empty", () => {
    expect(scanLineBlocks(["a", "b"], [], eq)).toEqual([]);
  });

  it("returns no hits when the needle is longer than the haystack", () => {
    expect(scanLineBlocks(["a"], ["a", "b"], eq)).toEqual([]);
  });

  it("treats a hole in the haystack window as an empty line", () => {
    const hay: string[] = ["a"];
    hay.length = 2;
    expect(scanLineBlocks(hay, ["x"], eq)).toEqual([]);
  });

  it("treats a hole in the needle as an empty line", () => {
    const need: string[] = ["a"];
    need.length = 2;
    expect(scanLineBlocks(["a", "b"], need, eq)).toEqual([]);
  });
});

describe("findCascadeMatch", () => {
  it("returns null for an empty old string", () => {
    expect(findCascadeMatch("anything here\n", "")).toBeNull();
    expect(findCascadeMatch("anything here\n", "\n")).toBeNull();
  });

  it("matches a non-final line", () => {
    const text = "foo\nbar";
    const r = findCascadeMatch(text, "foo");
    expect(r).not.toBeNull();
    const span = r!.spans[0]!;
    expect(text.slice(span.start, span.end)).toBe("foo");
    expect(span).toEqual({ start: 0, end: 3 });
  });

  it("matches the final line with no trailing newline", () => {
    const text = "foo\nbar";
    const r = findCascadeMatch(text, "bar");
    expect(r).not.toBeNull();
    const span = r!.spans[0]!;
    expect(span).toEqual({ start: 4, end: 7 });
    expect(text.slice(span.start, span.end)).toBe("bar");
  });

  it("extends the span to include the trailing newline", () => {
    const text = "a\nb\nc\n";
    const r = findCascadeMatch(text, "a\nb\n");
    expect(r).not.toBeNull();
    const span = r!.spans[0]!;
    expect(span).toEqual({ start: 0, end: 4 });
    expect(text.slice(span.start, span.end)).toBe("a\nb\n");
  });

  it("does not over-extend when old ends in newline but the block is the final line", () => {
    const text = "a\nb";
    const r = findCascadeMatch(text, "a\nb\n");
    expect(r).not.toBeNull();
    const span = r!.spans[0]!;
    expect(span).toEqual({ start: 0, end: 3 });
    expect(text.slice(span.start, span.end)).toBe("a\nb");
  });

  it("returns null when old has more lines than the text", () => {
    const r = findCascadeMatch("a\n", "a\nb\nc\nd\ne\nf");
    expect(r).toBeNull();
  });

  it("uses indentation-flexible matching for an indented block", () => {
    const text = "if (x) {\n    doThing();\n}\n";
    const r = findCascadeMatch(text, "doThing();");
    expect(r).not.toBeNull();
    const span = r!.spans[0]!;
    expect(text.slice(span.start, span.end)).toBe("    doThing();");
  });

  it("falls through to whitespace-normalized matching", () => {
    const text = "alpha    beta gamma\n";
    const r = findCascadeMatch(text, "alpha beta gamma");
    expect(r).not.toBeNull();
    const span = r!.spans[0]!;
    expect(text.slice(span.start, span.end)).toBe("alpha    beta gamma");
  });

  it("filters a line-count-disproportionate block, then falls back to a boundary fragment", () => {
    const text = "foo\nbar\n";
    const r = findCascadeMatch(text, "foo\n");
    expect(r).not.toBeNull();
    const span = r!.spans[0]!;
    expect(span).toEqual({ start: 0, end: 3 });
    expect(text.slice(span.start, span.end)).toBe("foo");
  });

  it("filters a length-disproportionate block", () => {
    const text = "a" + " ".repeat(600) + "b\n";
    const r = findCascadeMatch(text, "a b");
    expect(r).toBeNull();
  });

  it("uses the trimmed-boundary tier for a mid-line fragment", () => {
    const text = "start middle end\n";
    const r = findCascadeMatch(text, " middle ");
    expect(r).not.toBeNull();
    const span = r!.spans[0]!;
    expect(text.slice(span.start, span.end)).toBe("middle");
  });

  it("returns multiple spans for a repeated whole-line block", () => {
    const text = "row\nother\nrow\n";
    const r = findCascadeMatch(text, "row");
    expect(r).not.toBeNull();
    expect(r!.spans.length).toBe(2);
    for (const s of r!.spans) expect(text.slice(s.start, s.end)).toBe("row");
  });
});
