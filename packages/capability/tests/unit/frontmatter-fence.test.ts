import { describe, expect, test } from "../helpers/bun-test.ts";
import { splitFrontmatterFence } from "../../src/frontmatter-fence.ts";

const BOM = String.fromCodePoint(0xfeff);

describe("splitFrontmatterFence", () => {
  test("splits a plain LF fence into frontmatter text and body", () => {
    const result = splitFrontmatterFence("---\nname: writer\ntools: a, b\n---\n# Title\n\ntext\n");
    expect(result).toEqual({
      kind: "fenced",
      frontmatter: "name: writer\ntools: a, b",
      body: "# Title\n\ntext\n",
    });
  });

  test("does not parse, trim or validate the frontmatter text", () => {
    const result = splitFrontmatterFence("---\n  name:   writer  \n\n---\nbody");
    expect(result).toEqual({
      kind: "fenced",
      frontmatter: "  name:   writer  \n",
      body: "body",
    });
  });

  test("reports no fence when the text does not open one, keeping the input untouched", () => {
    const raw = "# Title\n\nno frontmatter here\n";
    expect(splitFrontmatterFence(raw)).toEqual({ kind: "absent", body: raw });
  });

  test("reports no fence for the empty string", () => {
    expect(splitFrontmatterFence("")).toEqual({ kind: "absent", body: "" });
  });

  test("reports an unterminated fence when the closing --- never arrives", () => {
    const raw = "---\nname: writer\nbody without a closing fence\n";
    expect(splitFrontmatterFence(raw)).toEqual({ kind: "unterminated", body: raw });
  });

  test("reports an unterminated fence for a lone opening fence", () => {
    expect(splitFrontmatterFence("---\n")).toEqual({ kind: "unterminated", body: "---\n" });
    expect(splitFrontmatterFence("---")).toEqual({ kind: "unterminated", body: "---" });
  });

  test("reports two adjacent fence lines as unterminated, not as an empty block", () => {
    const raw = "---\n---\nbody\n";
    expect(splitFrontmatterFence(raw)).toEqual({ kind: "unterminated", body: raw });
  });

  test("returns an empty frontmatter string for an empty block", () => {
    expect(splitFrontmatterFence("---\n\n---\nbody\n")).toEqual({
      kind: "fenced",
      frontmatter: "",
      body: "body\n",
    });
  });

  test("returns an empty body when nothing follows the closing fence", () => {
    expect(splitFrontmatterFence("---\nname: writer\n---")).toEqual({
      kind: "fenced",
      frontmatter: "name: writer",
      body: "",
    });
  });

  test("strips a leading BOM before looking for the fence", () => {
    expect(splitFrontmatterFence(`${BOM}---\nname: writer\n---\nbody\n`)).toEqual({
      kind: "fenced",
      frontmatter: "name: writer",
      body: "body\n",
    });
  });

  test("leaves the BOM on the body when there is no fence to strip it from", () => {
    const raw = `${BOM}# Title\n`;
    expect(splitFrontmatterFence(raw)).toEqual({ kind: "absent", body: raw });
  });

  test("strips leading whitespace before looking for the fence", () => {
    expect(splitFrontmatterFence("\n  \n\t---\nname: writer\n---\nbody\n")).toEqual({
      kind: "fenced",
      frontmatter: "name: writer",
      body: "body\n",
    });
  });

  test("leaves the leading whitespace on the body when there is no fence", () => {
    const raw = "\n  # Title\n";
    expect(splitFrontmatterFence(raw)).toEqual({ kind: "absent", body: raw });
  });

  test("recognizes a CRLF fence and leaves CRLF inside the two halves alone", () => {
    expect(
      splitFrontmatterFence("---\r\nname: writer\r\ntools: a\r\n---\r\nbody\r\nmore\r\n"),
    ).toEqual({
      kind: "fenced",
      frontmatter: "name: writer\r\ntools: a",
      body: "body\r\nmore\r\n",
    });
  });

  test("reports an unterminated CRLF fence", () => {
    const raw = "---\r\nname: writer\r\n";
    expect(splitFrontmatterFence(raw)).toEqual({ kind: "unterminated", body: raw });
  });

  test("closes on the first fence, so a later --- is body text", () => {
    expect(splitFrontmatterFence("---\nname: writer\n---\n\nintro\n\n---\n\nmore\n")).toEqual({
      kind: "fenced",
      frontmatter: "name: writer",
      body: "\nintro\n\n---\n\nmore\n",
    });
  });

  test("treats a --- inside the frontmatter block's own value as the closing fence", () => {
    expect(splitFrontmatterFence("---\na: 1\n---\nb: 2\n---\nbody\n")).toEqual({
      kind: "fenced",
      frontmatter: "a: 1",
      body: "b: 2\n---\nbody\n",
    });
  });

  test("carries no regex state between calls", () => {
    const raw = "---\nname: writer\n---\nbody\n";
    expect(splitFrontmatterFence(raw)).toEqual(splitFrontmatterFence(raw));
  });
});
