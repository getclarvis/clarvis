import { describe, expect, test } from "bun:test";
import {
  FINAL_MARKDOWN_CAP,
  IncrementalMarkdownSegmenter,
  MAX_MARKDOWN_SEGMENTS,
  segmentMarkdown,
  SEGMENT_MIN,
  TAIL_PLAIN_CAP,
} from "../../src/core/transcript/segment.ts";

const para = (n: number): string => `Paragraph ${n}. ${"word ".repeat(40).trim()}\n\n`;

function longProse(paragraphs: number): string {
  let out = "";
  for (let i = 0; i < paragraphs; i += 1) out += para(i);
  return out;
}

describe("segmentMarkdown", () => {
  test("leaves a short message whole", () => {
    const text = "# Title\n\nA short reply.\n";
    expect(segmentMarkdown(text)).toEqual({ sealed: [], tail: text });
  });

  test("reassembles exactly, for every min and every shape", () => {
    const inputs = [
      "",
      "\n",
      "no trailing newline",
      longProse(30),
      "```ts\n" + "const x = 1;\n".repeat(500) + "```\n\nafter\n",
      "text\n\n```\n\n\n\n```\n\nmore\n\n" + longProse(20),
      "a".repeat(50_000),
    ];
    for (const text of inputs) {
      for (const min of [1, 16, 200, SEGMENT_MIN]) {
        const { sealed, tail } = segmentMarkdown(text, min);
        expect(sealed.join("") + tail).toBe(text);
      }
    }
  });

  test("cuts long prose into several segments", () => {
    const { sealed, tail } = segmentMarkdown(longProse(40), 200);
    expect(sealed.length).toBeGreaterThan(5);
    expect(sealed.join("") + tail).toBe(longProse(40));
  });

  test("never cuts inside a fenced block", () => {
    const fenced = "```ts\n" + "// line\n\n".repeat(400) + "```\n";
    const text = "Intro paragraph.\n\n" + fenced + "\nOutro.\n";
    const { sealed } = segmentMarkdown(text, 200);
    for (const part of sealed) {
      const fences = (part.match(/^\s*(```|~~~)/gm) ?? []).length;
      expect(fences % 2).toBe(0);
    }
  });

  test("an unclosed fence leaves everything after the last legal cut in the tail", () => {
    const intro = longProse(1);
    expect(intro.length).toBeGreaterThan(200);
    const text = intro + "```ts\n" + "const x = 1;\n\n".repeat(2000);
    const { sealed, tail } = segmentMarkdown(text, 200);
    expect(sealed).toEqual([intro]);
    expect(tail.startsWith("```ts\n")).toBe(true);
    expect(tail.length).toBeGreaterThan(TAIL_PLAIN_CAP);
  });

  test("a short prefix before an unclosed fence yields no cut at all", () => {
    const text = "before\n\n```ts\n" + "const x = 1;\n\n".repeat(2000);
    const { sealed, tail } = segmentMarkdown(text, 200);
    expect(sealed).toEqual([]);
    expect(tail).toBe(text);
  });

  test("~~~ fences are tracked too", () => {
    const text = "intro\n\n~~~\n" + "body\n\n".repeat(400) + "~~~\n\ntail\n";
    const { sealed } = segmentMarkdown(text, 200);
    for (const part of sealed) expect(part.includes("body\n\nbody")).toBe(part.includes("~~~"));
  });

  test("is prefix-stable: appending never moves a cut already taken", () => {
    const full = longProse(30);
    const final = segmentMarkdown(full, 200).sealed;
    for (let end = 1; end <= full.length; end += 97) {
      const partial = segmentMarkdown(full.slice(0, end), 200).sealed;
      expect(partial.length).toBeLessThanOrEqual(final.length);
      for (const [i, part] of partial.entries()) expect(part).toBe(final[i]!);
    }
  });

  test("is prefix-stable at every single prefix, including whitespace tails", () => {
    /**
     * Every prefix, not a sampled stride: the case that broke this took a cut on
     * an *unterminated* whitespace-only last line and withdrew it one character
     * later, which a stride of 97 walks straight past.
     */
    const docs = [
      "a".repeat(150) + "\n   \nmore text that continues on\n",
      "para one is quite long ".repeat(8) + "\n\n  \n  indented continuation\n",
      "x".repeat(120) + "\n\t\nnext\n",
      longProse(6),
    ];
    for (const doc of docs) {
      const final = segmentMarkdown(doc, 100).sealed;
      for (let end = 1; end <= doc.length; end += 1) {
        const partial = segmentMarkdown(doc.slice(0, end), 100).sealed;
        expect(partial.length).toBeLessThanOrEqual(final.length);
        for (const [i, part] of partial.entries()) {
          expect(part, `prefix ${end}, segment ${i}`).toBe(final[i]!);
        }
      }
    }
  });

  test("never cuts on an unterminated final line", () => {
    const text = "a".repeat(150) + "\n" + "   ";
    const { sealed, tail } = segmentMarkdown(text, 100);
    expect(sealed).toEqual([]);
    expect(tail).toBe(text);
  });

  test("never cuts inside an indented code block", () => {
    const intro = "Some introductory prose that is long enough to allow a cut.\n\n";
    const code = "    const a = 1;\n\n    const b = 2;\n\n    const c = 3;\n";
    const text = intro + code + "\nClosing prose.\n";
    const { sealed, tail } = segmentMarkdown(text, 20);
    expect(sealed.join("") + tail).toBe(text);
    for (const part of [...sealed, tail]) {
      const indented = part.split("\n").filter((l) => l.startsWith("    ")).length;
      expect(indented === 0 || indented === 3).toBe(true);
    }
  });

  test("still cuts between an indented block and ordinary prose that follows", () => {
    const text =
      "Intro prose long enough to permit a cut here.\n\n" +
      "    code line\n\n" +
      "A normal paragraph after the block, not indented at all.\n\n" +
      "And another paragraph to close things out.\n";
    const { sealed, tail } = segmentMarkdown(text, 20);
    expect(sealed.length).toBeGreaterThan(0);
    expect(sealed.join("") + tail).toBe(text);
  });

  test("trailing blank lines do not falsely continue an indented code block", () => {
    const code = "    " + "x".repeat(40) + "\n";
    for (const suffix of ["\n\n", "\n   "]) {
      const text = code + suffix;
      const { sealed, tail } = segmentMarkdown(text, 20);
      expect(sealed.join("") + tail).toBe(text);
      expect(sealed).toEqual([code + "\n"]);
    }
  });

  test("a cut always ends on a blank line outside a fence", () => {
    const { sealed } = segmentMarkdown(longProse(30), 200);
    for (const part of sealed) {
      const lines = part.split("\n");
      lines.pop();
      expect(lines[lines.length - 1]!.trim()).toBe("");
    }
  });

  test("each sealed segment reaches the minimum", () => {
    const min = 200;
    for (const part of segmentMarkdown(longProse(40), min).sealed) {
      expect(part.length).toBeGreaterThanOrEqual(min);
    }
  });
});

describe("IncrementalMarkdownSegmenter", () => {
  const source = (snapshot: ReturnType<IncrementalMarkdownSegmenter["update"]>): string =>
    snapshot.sealed.map((part) => part.text).join("") + snapshot.tail;

  test("keeps sealed object identity while scanning only later appends", () => {
    const segmenter = new IncrementalMarkdownSegmenter(200);
    const initialText = longProse(8);
    const initial = segmenter.update(initialText, 0, true);
    expect(initial.sealed.length).toBeGreaterThan(1);
    const first = initial.sealed[0];

    const nextText = initialText + longProse(2);
    const next = segmenter.update(nextText, 0, true);
    expect(next.sealed[0]).toBe(first);
    expect(source(next)).toBe(nextText);
    expect(next.tailKind).toBe("markdown");
  });

  test("does not copy the sealed segment index for tail-only stream updates", () => {
    const segmenter = new IncrementalMarkdownSegmenter(200);
    const text = longProse(4);
    const initial = segmenter.update(text, 0, true);
    expect(initial.sealed.length).toBeGreaterThan(0);

    const tailOnly = segmenter.update(text + "x", 0, true);
    expect(tailOnly.sealed).toBe(initial.sealed);

    const withSeal = segmenter.update(text + "x" + longProse(2), 0, true);
    expect(withSeal.sealed).not.toBe(initial.sealed);
    expect(source(withSeal)).toBe(text + "x" + longProse(2));
  });

  test("an epoch replaces the cumulative stream without retaining old prefixes", () => {
    const segmenter = new IncrementalMarkdownSegmenter(50);
    const first = segmenter.update(longProse(4), 0, true);
    const firstObject = first.sealed[0];
    const replacement = "Replacement response.\n\nDone.\n";
    const reset = segmenter.update(replacement, 1, true);
    expect(source(reset)).toBe(replacement);
    expect(reset.sealed[0]).not.toBe(firstObject);
  });

  test("settling preserves stable Markdown prefixes and large replies stay plain", () => {
    const segmenter = new IncrementalMarkdownSegmenter(100);
    const markdown = "### Report\n\n" + longProse(3);
    const streamed = segmenter.update(markdown, 0, true);
    expect(streamed.sealed.length).toBeGreaterThan(0);
    const first = streamed.sealed[0];
    const settled = segmenter.update(markdown, 0, false);
    expect(settled.tailKind).toBe("markdown");
    expect(settled.simplified).toBe(false);
    expect(settled.sealed).toBe(streamed.sealed);
    expect(settled.sealed[0]).toBe(first);
    expect(source(settled)).toBe(markdown);

    const giant = "```ts\n" + "const x = 1;\n".repeat(Math.ceil(FINAL_MARKDOWN_CAP / 10));
    const simplified = segmenter.update(giant, 1, false);
    expect(simplified.simplified).toBe(true);
    expect(simplified.sealed.every((part) => part.kind === "plain")).toBe(true);
    expect(source(simplified)).toBe(giant);
  });

  test("too many legal prefixes switch to bounded plain chunks", () => {
    const segmenter = new IncrementalMarkdownSegmenter(10);
    const text = longProse(MAX_MARKDOWN_SEGMENTS + 30);
    const snapshot = segmenter.update(text, 0, true);
    expect(snapshot.simplified).toBe(true);
    expect(snapshot.sealed.filter((part) => part.kind === "markdown").length).toBe(
      MAX_MARKDOWN_SEGMENTS,
    );
    expect(source(snapshot)).toBe(text);
  });

  test("an unclosed streamed fence falls back to plain after the tail cap", () => {
    const segmenter = new IncrementalMarkdownSegmenter(200);
    const text = "```ts\n" + "const value = 1;\n".repeat(2_000);
    const snapshot = segmenter.update(text, 0, true);
    expect(snapshot.simplified).toBe(true);
    expect(snapshot.tailKind).toBe("plain");
    expect(snapshot.sealed.every((part) => part.kind === "plain")).toBe(true);
    expect(source(snapshot)).toBe(text);
  });
});
