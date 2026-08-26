import { describe, expect, test } from "bun:test";
import {
  countLines,
  extractDocumentLinks,
  extractLineCitations,
  findDangerousCharacters,
  headingSlugs,
  resolveLink,
  resolveLineCitation,
} from "../../lib/spec-hygiene.ts";

describe("findDangerousCharacters", () => {
  test("reports a literal NUL by name, because git reads such a file as binary", () => {
    const findings = findDangerousCharacters("rejects `\0` in an id");

    expect(findings).toHaveLength(1);
    expect(findings[0].label).toContain("U+0000 NUL");
    expect(findings[0].label).toContain("binary");
    expect(findings[0]).toMatchObject({ line: 1, column: 10 });
  });

  test("reports C0, DEL and C1 controls, and counts lines from the first", () => {
    const findings = findDangerousCharacters("ok\nesc \u001B\ndel \u007F\nc1 \u009B");

    expect(findings.map((finding) => [finding.line, finding.code])).toEqual([
      [2, 0x1b],
      [3, 0x7f],
      [4, 0x9b],
    ]);
  });

  test("tab and newline are the two controls a document may contain", () => {
    expect(findDangerousCharacters("a\tb\nc\n")).toEqual([]);
  });

  test("the byte-order mark, zero-width characters and irregular spaces fail a document", () => {
    const findings = findDangerousCharacters("a\uFEFFb\u200Bc\u00A0d");

    expect(findings.map((finding) => finding.label)).toEqual([
      "U+FEFF byte-order mark",
      "U+200B zero-width character",
      "U+00A0 irregular whitespace",
    ]);
  });

  test("allowInvisible keeps those legal for source, which needs a literal BOM constant", () => {
    expect(findDangerousCharacters('const BOM = "\uFEFF";', { allowInvisible: true })).toEqual([]);
    expect(findDangerousCharacters("\u001B", { allowInvisible: true })).toHaveLength(1);
  });
});

describe("extractDocumentLinks", () => {
  test("reads a Markdown link, its anchor, and its line", () => {
    const links = extractDocumentLinks(
      "intro\nsee [x](../hosts/protocol.md#4-behavior).\n",
      "a.md",
    );

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      path: "../hosts/protocol.md",
      anchor: "4-behavior",
      line: 2,
      relative: true,
    });
  });

  test("reads a bare repository-root spec path out of source, where TSDoc cites one", () => {
    const links = extractDocumentLinks(" * See `specs/cross-cutting/observability.md`.", "x.ts");

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      path: "specs/cross-cutting/observability.md",
      relative: false,
    });
  });

  test("a Markdown link containing a spec path is one link, not two", () => {
    expect(
      extractDocumentLinks("[a](../../specs/hosts/protocol.md)", "packages/x/README.md"),
    ).toHaveLength(1);
  });

  test("the same target twice on one line is reported once", () => {
    const links = extractDocumentLinks("`specs/a.md` and `specs/a.md`", "x.ts");

    expect(links).toHaveLength(1);
  });

  test("an absolute URL and a non-Markdown target are both ignored", () => {
    expect(extractDocumentLinks("[a](https://example.com/x.md) [b](./y.ts)", "a.md")).toEqual([]);
  });

  test("a Markdown link is not read out of a source file, only the bare path is", () => {
    expect(extractDocumentLinks("[a](./sibling.md)", "x.ts")).toEqual([]);
  });
});

describe("source line citations", () => {
  const tree = {
    exists: (path: string) => path === "packages/x/src/y.ts" || path === "empty.ts",
    lineCountOf: (path: string) =>
      path === "packages/x/src/y.ts" ? 8 : path === "empty.ts" ? 0 : undefined,
  };

  test("counts addressable lines without inventing one after the final newline", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("one")).toBe(1);
    expect(countLines("one\n")).toBe(1);
    expect(countLines("one\n\n")).toBe(2);
  });

  test("extracts a single line, ranges, and comma-separated references", () => {
    const citations = extractLineCitations(
      "intro\n`packages/x/src/y.ts:1-3, 5,8` and `empty.ts:0`\n",
    );

    expect(citations).toHaveLength(2);
    expect(citations[0]).toEqual({
      path: "packages/x/src/y.ts",
      line: 2,
      ranges: [
        { raw: "1-3", start: 1n, end: 3n },
        { raw: "5", start: 5n, end: 5n },
        { raw: "8", start: 8n, end: 8n },
      ],
    });
  });

  test("joins backtick-separated en-dash and ASCII endpoints into comma-listed ranges", () => {
    const [citation] = extractLineCitations(
      "`packages/x/src/y.ts:356`\u2013`355`, `:11`\u2013`:47`, `:368`-`357`; comment at `:25`\u2013`24`, assertions at `:29`\u2013`26`",
    );
    const longTree = {
      exists: (path: string) => path === "packages/x/src/y.ts",
      lineCountOf: () => 400,
    };

    expect(citation.ranges).toEqual([
      { raw: "356-355", start: 356n, end: 355n },
      { raw: "11-47", start: 11n, end: 47n },
      { raw: "368-357", start: 368n, end: 357n },
      { raw: "25-24", start: 25n, end: 24n },
      { raw: "29-26", start: 29n, end: 26n },
    ]);
    expect(resolveLineCitation(citation, "specs/x.md", longTree)).toEqual([
      "specs/x.md:1 → packages/x/src/y.ts:356-355 (inverted line range)",
      "specs/x.md:1 → packages/x/src/y.ts:368-357 (inverted line range)",
      "specs/x.md:1 → packages/x/src/y.ts:25-24 (inverted line range)",
      "specs/x.md:1 → packages/x/src/y.ts:29-26 (inverted line range)",
    ]);
  });

  test("accepts optional-backtick endpoint forms and rejects their out-of-bounds end", () => {
    const [validSeparated] = extractLineCitations("`packages/x/src/y.ts:1`\u2013`:8`");
    const [validPlain] = extractLineCitations("packages/x/src/y.ts:2\u20134, :5-6");
    const [outside] = extractLineCitations("`packages/x/src/y.ts:7`\u2013`:9`");

    expect(resolveLineCitation(validSeparated, "specs/x.md", tree)).toEqual([]);
    expect(resolveLineCitation(validPlain, "specs/x.md", tree)).toEqual([]);
    expect(resolveLineCitation(outside, "specs/x.md", tree)).toEqual([
      "specs/x.md:1 → packages/x/src/y.ts:7-9 (outside target's 1-8 line bounds)",
    ]);
  });

  test("does not inherit a shorthand range from another Markdown table cell", () => {
    const [citation] = extractLineCitations("| source `packages/x/src/y.ts:2` | line `:8`-`:9` |");

    expect(citation.ranges).toEqual([{ raw: "2", start: 2n, end: 2n }]);
    expect(resolveLineCitation(citation, "specs/x.md", tree)).toEqual([]);
  });

  test("ignores URLs, absolute paths, nonnumeric labels, and citation-like suffixes", () => {
    expect(
      extractLineCitations(
        "https://example.test/(packages/x/src/y.ts:99)?next=packages/x/src/y.ts:100 http://127.0.0.1:11434/v1 /packages/x/src/y.ts:4 packages/x/src/y.ts:LINE packages/x/src/y.ts:4ms",
      ),
    ).toEqual([]);
  });

  test("ignores an illustrative citation when its repository target does not exist", () => {
    const [citation] = extractLineCitations("`packages/x/src/y.ts:123`");
    const missingTree = {
      exists: () => false,
      lineCountOf: () => {
        throw new Error("a nonexistent citation target must not be read");
      },
    };

    expect(resolveLineCitation(citation, "specs/README.md", missingTree)).toEqual([]);
  });

  test("accepts repository-root ./ spelling and the first and last real target lines", () => {
    const [citation] = extractLineCitations("`./packages/x/src/y.ts:1,8`");

    expect(resolveLineCitation(citation, "specs/x.md", tree)).toEqual([]);
  });

  test("reports zero, oversized bounds, and an inverted range independently", () => {
    const [citation] = extractLineCitations(
      "intro\n`packages/x/src/y.ts:0,9,999999999999999999999999,7-4`",
    );

    expect(resolveLineCitation(citation, "specs/x.md", tree)).toEqual([
      "specs/x.md:2 → packages/x/src/y.ts:0 (outside target's 1-8 line bounds)",
      "specs/x.md:2 → packages/x/src/y.ts:9 (outside target's 1-8 line bounds)",
      "specs/x.md:2 → packages/x/src/y.ts:999999999999999999999999 (outside target's 1-8 line bounds)",
      "specs/x.md:2 → packages/x/src/y.ts:7-4 (inverted line range)",
    ]);
  });

  test("reports any citation into an existing empty file", () => {
    const [citation] = extractLineCitations("`empty.ts:1`");

    expect(resolveLineCitation(citation, "specs/x.md", tree)).toEqual([
      "specs/x.md:1 → empty.ts:1 (target file is empty)",
    ]);
  });

  test("does not resolve a path that traverses above the repository", () => {
    const [citation] = extractLineCitations("`../packages/x/src/y.ts:1`");

    expect(resolveLineCitation(citation, "specs/x.md", tree)).toEqual([]);
  });
});

describe("headingSlugs", () => {
  test("slugs a heading the way GitHub does, dropping backticks and punctuation", () => {
    const slugs = headingSlugs("## `@clarvis/capability` — the contract\n");

    expect([...slugs]).toEqual(["clarviscapability--the-contract"]);
  });

  test("a repeated heading takes GitHub's numeric suffix", () => {
    expect([...headingSlugs("# Same\n## Same\n### Same\n")]).toEqual(["same", "same-1", "same-2"]);
  });

  test("a hash inside a fenced block is not a heading", () => {
    expect([...headingSlugs("```sh\n# not a heading\n```\n# real\n")]).toEqual(["real"]);
  });

  test("a link in a heading keeps its text and drops its target", () => {
    expect([...headingSlugs("## [paths](foundations/paths.md)\n")]).toEqual(["paths"]);
  });
});

describe("resolveLink", () => {
  const tree = {
    exists: (path: string) => path === "specs/hosts/protocol.md",
    join: (from: string, relative: string) =>
      `${from.split("/").slice(0, -1).join("/")}/${relative}`.replace(/\/\.\//g, "/"),
    anchorsOf: () => new Set(["4-behavior"]),
  };

  test("a target that does not exist names the citing file and line", () => {
    const [link] = extractDocumentLinks("see `specs/decisions.md`", "AGENTS.md");

    expect(resolveLink(link, "AGENTS.md", tree)).toBe(
      "AGENTS.md:1 → specs/decisions.md (no such file)",
    );
  });

  test("a target that exists with an unknown anchor fails on the anchor", () => {
    const [link] = extractDocumentLinks("[x](specs/hosts/protocol.md#9-nope)", "AGENTS.md");

    expect(resolveLink(link, "AGENTS.md", tree)).toBe(
      "AGENTS.md:1 → specs/hosts/protocol.md#9-nope (no such heading in specs/hosts/protocol.md)",
    );
  });

  test("a resolving path and a resolving anchor both pass", () => {
    const [link] = extractDocumentLinks("[x](specs/hosts/protocol.md#4-behavior)", "AGENTS.md");

    expect(resolveLink(link, "AGENTS.md", tree)).toBeUndefined();
  });
});
