import { describe, it, expect } from "bun:test";
import { createAgentBuffer } from "../../src/buffer.ts";

const big = { maxLines: 1000, maxBytes: 1_000_000 };

describe("agents ring buffer — offsets", () => {
  it("offsets are absolute over the whole stream and tail advances by line bytes", () => {
    const buf = createAgentBuffer(big);
    buf.append("abc");
    expect(buf.head()).toBe(0);
    expect(buf.tail()).toBe(4);
    buf.append("de");
    expect(buf.tail()).toBe(7);
  });

  it("a head drop raises head and never rewinds tail; offsets stay monotonic", () => {
    const buf = createAgentBuffer({ maxLines: 3, maxBytes: 1_000_000 });
    for (let i = 0; i < 10; i += 1) buf.append(`line-${String(i)}`);
    const tail = buf.tail();
    expect(buf.head()).toBeGreaterThan(0);
    expect(tail).toBeGreaterThan(buf.head());

    const first = buf.read(0, 4096);
    expect(first.nextOffset).toBeLessThanOrEqual(tail);
    buf.append("line-10");
    const second = buf.read(first.nextOffset, 4096);
    expect(second.nextOffset).toBeGreaterThanOrEqual(first.nextOffset);
    expect(buf.tail()).toBeGreaterThan(tail);
  });

  it("truncated_head counts BYTES that were dropped, not lines", () => {
    const buf = createAgentBuffer({ maxLines: 2, maxBytes: 1_000_000 });
    buf.append("日本語");
    buf.append("b");
    buf.append("c");
    const read = buf.read(0, 4096);
    expect(read.truncatedHead).toBe(Buffer.byteLength("日本語", "utf8") + 1);
    expect(read.truncatedHead).not.toBe(1);
  });

  it("reports no truncated head once the caller has caught up past the drop", () => {
    const buf = createAgentBuffer({ maxLines: 2, maxBytes: 1_000_000 });
    buf.append("a");
    buf.append("b");
    buf.append("c");
    expect(buf.read(buf.head(), 4096).truncatedHead).toBe(0);
  });

  it("an offset past the tail returns nothing and parks at the tail", () => {
    const buf = createAgentBuffer(big);
    buf.append("a");
    const read = buf.read(999, 4096);
    expect(read.text).toBe("");
    expect(read.nextOffset).toBe(buf.tail());
    expect(read.more).toBe(false);
  });

  it("a mid-line offset clamps up to the next boundary rather than re-emitting a partial line", () => {
    const buf = createAgentBuffer(big);
    buf.append("hello");
    buf.append("world");
    const read = buf.read(2, 4096);
    expect(read.text).toBe("world");
  });
});

describe("agents ring buffer — paging", () => {
  it("pages forward with next_offset and reports `more` until drained", () => {
    const buf = createAgentBuffer(big);
    for (let i = 0; i < 5; i += 1) buf.append(`line-${String(i)}`);

    const seen: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = buf.read(offset, 8);
      if (page.text.length > 0) seen.push(...page.text.split("\n"));
      offset = page.nextOffset;
      if (!page.more) break;
    }
    expect(seen).toEqual(["line-0", "line-1", "line-2", "line-3", "line-4"]);
  });

  it("always emits at least one line, truncating an oversized one at a code-point boundary", () => {
    const buf = createAgentBuffer(big);
    buf.append("🐛".repeat(20));
    const read = buf.read(0, 10);
    expect(read.text.length).toBeGreaterThan(0);
    expect(read.text).not.toContain("�");
    expect(Buffer.from(read.text, "utf8").toString("utf8")).toBe(read.text);
    expect(read.nextOffset).toBe(buf.tail());
  });

  it("a page boundary falls between lines: a multibyte line is never half-emitted", () => {
    const buf = createAgentBuffer(big);
    buf.append("héllo wörld");
    buf.append("second");
    const read = buf.read(0, 20);
    expect(read.text).toBe("héllo wörld");
    expect(read.more).toBe(true);
    expect(buf.read(read.nextOffset, 20).text).toBe("second");
  });

  it("bounds non-finite programmatic cursors and page budgets", () => {
    const buf = createAgentBuffer(big);
    buf.append("first");
    buf.append("second");
    expect(buf.read(Number.NaN, Number.POSITIVE_INFINITY).text).toBe("f");
  });
});

describe("agents ring buffer — match", () => {
  it("filters displayed lines but leaves next_offset on the unfiltered cursor", () => {
    const buf = createAgentBuffer(big);
    buf.append("keep-1");
    buf.append("drop");
    buf.append("keep-2");
    const plain = buf.read(0, 4096);
    const filtered = buf.read(0, 4096, /keep/);
    expect(filtered.text).toBe("keep-1\nkeep-2");
    expect(filtered.nextOffset).toBe(plain.nextOffset);
    expect(filtered.more).toBe(plain.more);
  });

  it("paging with a filter loses no line relative to paging without one", () => {
    const buf = createAgentBuffer(big);
    for (let i = 0; i < 6; i += 1) buf.append(`keep-${String(i)}`);

    const page = (match?: RegExp): string[] => {
      const out: string[] = [];
      let offset = 0;
      for (let guard = 0; guard < 30; guard += 1) {
        const read = buf.read(offset, 9, match);
        if (read.text.length > 0) out.push(...read.text.split("\n"));
        offset = read.nextOffset;
        if (!read.more) break;
      }
      return out;
    };
    expect(page(/keep/)).toEqual(page());
  });

  it("a g-flagged pattern is applied statelessly rather than skipping every other line", () => {
    const buf = createAgentBuffer(big);
    buf.append("keep-1");
    buf.append("keep-2");
    buf.append("keep-3");
    expect(buf.read(0, 4096, /keep/g).text).toBe("keep-1\nkeep-2\nkeep-3");
  });
});

describe("agents ring buffer — bounds", () => {
  it("the byte bound evicts oldest-first and keeps at least the newest line", () => {
    const buf = createAgentBuffer({ maxLines: 1000, maxBytes: 12 });
    buf.append("aaaa");
    buf.append("bbbb");
    buf.append("cccc");
    buf.append("dddd");
    const read = buf.read(buf.head(), 4096);
    expect(read.text).not.toContain("aaaa");
    expect(read.text).toContain("dddd");
  });

  it("retains only the UTF-8-safe tail of one oversized line and charges dropped bytes", () => {
    const buf = createAgentBuffer({ maxLines: 1000, maxBytes: 9 });
    buf.append("old");
    buf.append("🐛".repeat(8));

    const read = buf.read(0, 4096);
    expect(read.text).toBe("🐛🐛");
    expect(read.text).not.toContain("�");
    expect(buf.tail() - buf.head()).toBe(9);
    expect(read.truncatedHead).toBe(buf.head());
    expect(read.nextOffset).toBe(buf.tail());
  });

  it("does not hide an oversized line's dropped prefix behind an older retained line", () => {
    const buf = createAgentBuffer({ maxLines: 1000, maxBytes: 10 });
    buf.append("");
    buf.append("🐛".repeat(8));

    const read = buf.read(0, 4096);
    expect(read.text).toBe("🐛🐛");
    expect(read.truncatedHead).toBe(25);
    expect(buf.head()).toBe(25);
    expect(buf.tail()).toBe(34);
  });

  it("drops a code point that cannot fit instead of splitting it or exceeding maxBytes", () => {
    const buf = createAgentBuffer({ maxLines: 1000, maxBytes: 3 });
    buf.append("🐛");

    const read = buf.read(0, 4096);
    expect(read.text).toBe("");
    expect(read.truncatedHead).toBe(4);
    expect(read.nextOffset).toBe(5);
    expect(buf.tail() - buf.head()).toBe(1);
  });

  it("compacts dropped slots without losing the newest lines", () => {
    const buf = createAgentBuffer({ maxLines: 3, maxBytes: 1_000_000 });
    for (let i = 0; i < 5000; i += 1) buf.append(`line-${String(i)}`);
    expect(buf.read(buf.head(), 4096).text).toBe("line-4997\nline-4998\nline-4999");
  });

  it("fails closed on non-finite programmatic byte limits", () => {
    for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const buf = createAgentBuffer({ maxLines: Number.POSITIVE_INFINITY, maxBytes });
      buf.append("must not be retained");
      const read = buf.read(0, 4096);
      expect(read.text).toBe("");
      expect(read.truncatedHead).toBe(buf.tail());
    }
  });

  it("clamps an enormous programmatic line limit to the schema ceiling", () => {
    const buf = createAgentBuffer({ maxLines: Number.MAX_SAFE_INTEGER, maxBytes: 1_000_000 });
    for (let i = 0; i < 10_001; i += 1) buf.append("x");
    expect(buf.read(0, 100_000).truncatedHead).toBe(2);
  });

  it("freeze keeps existing content readable but stops accepting appends (D9)", () => {
    const buf = createAgentBuffer(big);
    buf.append("before");
    buf.freeze();
    buf.append("after");
    const read = buf.read(0, 4096);
    expect(read.text).toBe("before");
    expect(buf.tail()).toBe(7);
  });
});
