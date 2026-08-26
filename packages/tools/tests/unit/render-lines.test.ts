import { describe, expect, it } from "bun:test";
import { renderNumberedSlice } from "../../src/lib/render-lines.ts";

describe("renderNumberedSlice", () => {
  it("numbers lines from their 1-indexed source position with cat -n prefixes", () => {
    const { body, shownLines, byteCapped } = renderNumberedSlice(
      ["alpha", "beta", "gamma"],
      0,
      3,
      10_000,
    );
    expect(body).toBe("     1\talpha\n     2\tbeta\n     3\tgamma");
    expect(shownLines).toBe(3);
    expect(byteCapped).toBe(false);
  });

  it("renders a mid-file slice keeping the original line numbers", () => {
    const { body, shownLines } = renderNumberedSlice(["a", "b", "c", "d"], 1, 3, 10_000);
    expect(body).toBe("     2\tb\n     3\tc");
    expect(shownLines).toBe(2);
  });

  it("always emits the first row then stops at the byte budget, flagging byteCapped", () => {
    const { body, shownLines, byteCapped } = renderNumberedSlice(
      ["11111", "22222", "33333"],
      0,
      3,
      20,
    );
    expect(body).toBe("     1\t11111");
    expect(shownLines).toBe(1);
    expect(byteCapped).toBe(true);
  });

  it("truncates a very long single line without dropping it", () => {
    const long = "x".repeat(5000);
    const { body, shownLines } = renderNumberedSlice([long], 0, 1, 10_000);
    expect(shownLines).toBe(1);
    expect(body).toContain("[... line truncated ...]");
    expect(body.length).toBeLessThan(long.length);
  });

  it("does not split a surrogate pair at the line-truncation boundary", () => {
    const line = "a".repeat(1999) + "😀" + "b".repeat(10);
    const { body, shownLines } = renderNumberedSlice([line], 0, 1, 1_000_000);
    expect(shownLines).toBe(1);
    expect(body).toContain("[... line truncated ...]");
    expect(body).not.toContain("\uD83D");
  });

  it("backs off to a UTF-8 char boundary when capping bytes", () => {
    const { body, shownLines } = renderNumberedSlice(["é".repeat(100)], 0, 1, 58);
    expect(shownLines).toBe(1);
    expect(body).toContain("[... line truncated ...]");
    expect(body).not.toContain("�");
  });

  it("returns an empty body for an empty slice", () => {
    const { body, shownLines, byteCapped } = renderNumberedSlice(["a"], 0, 0, 10_000);
    expect(body).toBe("");
    expect(shownLines).toBe(0);
    expect(byteCapped).toBe(false);
  });
});
