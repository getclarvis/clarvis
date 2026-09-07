import { describe, expect, test } from "bun:test";
import {
  extractCalendarDates,
  extractDocumentLinks,
  extractLineQualifiedReferences,
  extractRepositoryFileReferences,
  extractSourceSizeReferences,
  findDangerousCharacters,
  headingSlugs,
  resolveLink,
  resolveRepositoryFileReference,
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

describe("stable repository references", () => {
  test("finds line-qualified files, ranges, lists, ambient shorthand, and prose", () => {
    const references = extractLineQualifiedReferences(
      "intro\n`packages/example/src/file.ts: 1-3, 5,8`, `packages/example/src/other.ts#L9-L12`, `.githooks/pre-commit:7`, `packages/server/Dockerfile:39-60`, `.gitattributes:8`, `: 13-21`, (:405), at line 48, lines 50-52, imports at 54-57, and (referenced `58-60`)\n",
    );

    expect(references).toEqual([
      {
        raw: "packages/example/src/file.ts: 1-3, 5,8",
        path: "packages/example/src/file.ts",
        line: 2,
      },
      {
        raw: "packages/example/src/other.ts#L9-L12",
        path: "packages/example/src/other.ts",
        line: 2,
      },
      { raw: ".githooks/pre-commit:7", path: ".githooks/pre-commit", line: 2 },
      {
        raw: "packages/server/Dockerfile:39-60",
        path: "packages/server/Dockerfile",
        line: 2,
      },
      { raw: ".gitattributes:8", path: ".gitattributes", line: 2 },
      { raw: "`: 13-21`", path: undefined, line: 2 },
      { raw: "(:405)", path: undefined, line: 2 },
      { raw: "line 48", path: undefined, line: 2 },
      { raw: "lines 50-52", path: undefined, line: 2 },
      { raw: "imports at 54-57", path: undefined, line: 2 },
      { raw: "(referenced `58-60`)", path: undefined, line: 2 },
    ]);
  });

  test("ignores URLs, ports, percentages, nonnumeric labels, and numeric suffixes that are not lines", () => {
    expect(
      extractLineQualifiedReferences(
        "https://example.test/packages/example/src/file.ts:99 http://127.0.0.1:11434/v1 packages/example/src/file.ts:LINE packages/example/src/file.ts:4ms lines 98.98%",
      ),
    ).toEqual([]);
  });

  test("extracts owned repository roots but not URLs, basenames, or placeholder examples", () => {
    expect(
      extractRepositoryFileReferences(
        "`packages/code/src/runtime.tsx` `tooling/checks/spec-hygiene.ts` `.githooks/pre-commit` `packages/server/Dockerfile` `.gitattributes` runtime.tsx packages/<name>/src/file.ts https://example.test/specs/a.md",
      ),
    ).toEqual([
      { path: "packages/code/src/runtime.tsx", line: 1 },
      { path: "tooling/checks/spec-hygiene.ts", line: 1 },
      { path: ".githooks/pre-commit", line: 1 },
      { path: "packages/server/Dockerfile", line: 1 },
    ]);
  });

  test("reports a missing explicit file and accepts one that exists", () => {
    const tree = { exists: (path: string) => path === "packages/code/src/runtime.tsx" };
    const references = extractRepositoryFileReferences(
      "`packages/code/src/runtime.tsx` and `packages/example/src/missing.ts`",
    );

    expect(resolveRepositoryFileReference(references[0], "specs/x.md", tree)).toBeUndefined();
    expect(resolveRepositoryFileReference(references[1], "specs/x.md", tree)).toBe(
      "specs/x.md:1 → packages/example/src/missing.ts (no such file)",
    );
  });
});

describe("timeless specifications", () => {
  test("finds common literal calendar dates but not a date-shaped schema placeholder", () => {
    expect(
      extractCalendarDates(
        "2026-09-06\n2026/9/7\n8/9/2026\nSep. 9, 2026\n10 September 2026\nSeptember 2026\nformat YYYY-MM-DD\n",
      ),
    ).toEqual([
      { raw: "2026-09-06", line: 1 },
      { raw: "2026/9/7", line: 2 },
      { raw: "8/9/2026", line: 3 },
      { raw: "Sep. 9, 2026", line: 4 },
      { raw: "10 September 2026", line: 5 },
      { raw: "September 2026", line: 6 },
    ]);
  });

  test("rejects source-size inventories but keeps behavior and coverage line counts", () => {
    expect(
      extractSourceSizeReferences(
        "12,000 lines of code\nsource has 900 lines\n42 source lines\n1,000 output lines\ncoverage is 98% lines\n",
      ),
    ).toEqual([
      { raw: "12,000 lines of code", line: 1 },
      { raw: "source has 900 lines", line: 2 },
      { raw: "42 source lines", line: 3 },
    ]);
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
